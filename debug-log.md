# QQ Email Receiver 调试过程总结

## 遇到的问题及解决方式

### 1. IMAP 连接成功但 "No mailbox is currently selected"

**现象**：IMAP 连接成功，但搜索邮件时返回 `No mailbox is currently selected`

**原因**：`imap.connect()` 后没有显式打开 INBOX 文件夹

**解决**：在连接成功后调用 `imap.openBox('INBOX', true, callback)`

---

### 2. `msg.uid` 和 `msg.seqno` 都是 undefined

**现象**：`imap.fetch()` 的 `message` 事件回调中，`msg.uid` 和 `msg.seqno` 都无法获取

**原因**：Node.js `imap` 库中 `uid` 和 `seqno` 是对象的非 enumerable 属性，`Object.keys()` 打印出来只有 `['_events', '_eventsCount', '_maxListeners']`

**解决**：直接访问 `msg.uid` 和 `msg.seqno`，它们实际上是存在的（不是 undefined），只是不在 `Object.keys()` 列表中

---

### 3. 邮件处理结果缺失 — `fetch` 的 `end` 事件早于 `message`/`body` 事件触发

**现象**：搜索到 22 封未读邮件，但 `fetch` 回调中只处理了前几封就返回了；大量邮件的 `from`/`subject` 为空

**原因**：`imap.fetch()` 的 `end` 事件在所有 `message` 事件之前就触发了，导致：
```js
// 旧代码：end 事件触发时直接 resolve，但很多 message 事件还在队列中
f.once('end', () => { resolve(emails); }); // 太早了！
```

**解决**：改用 `Promise.all` 方案——为每封邮件创建一个 Promise，在 `simpleParser` 解析完成后再 resolve：

```js
// 新代码
emailPromises[idx] = new Promise((res) => {
  msg.on('body', (stream) => {
    // ... parse ...
    simpleParser(buffer).then((parsed) => {
      res({ subject: parsed.subject, from: parsed.from, ... });
    });
  });
});

f.once('end', () => {
  Promise.all(emailPromises).then(resolve);
});
```

---

### 4. `processed++` 执行两次导致提前 resolve

**现象**：每封邮件的 `processed` 计数变成了 2（message 事件 + body end 事件各加一次），导致 `processed === ids.length` 提前满足，resolve 时 `simpleParser` 还没完成

**原因**：旧代码在两处执行了 `processed++`

**解决**：只保留 `stream.once('end')` 内部的 `processed++`，因为只有这里代表真正的数据处理完成

---

### 5. `ids.indexOf(seqno)` 匹配失败导致邮件顺序错乱

**现象**：部分邮件的 `from` 为空，但从 debug 输出看这些邮件的 subject 是有值的

**原因**：`imap.search()` 返回的是 sequence numbers，但传入 `imap.fetch(ids, ...)` 时，这些 id 在回调中的顺序可能和 search 返回的顺序不一致。`ids.indexOf(seqno)` 找到了错误的索引，导致 `emails[idx]` 被覆盖

**解决**：使用 `imap.fetch()` 回调中第二个参数 `seqno`（即 message 事件的第二个参数）来作为索引，而不是依赖 `ids.indexOf()`

---

### 6. QQ 邮箱 SMTP 502 错误 — `Mail command failed: 502 Invalid input from xxx to newxmesmtplogicsvrsz...`

**现象**：reply action 执行后，QQ 邮箱 SMTP 服务器返回 502 错误

**原因**：QQ 邮箱的 SMTP 服务对发件服务器有 IP 限制。当前服务器 IP（47.85.17.125）不在 QQ 邮箱的允许发送列表中。更重要的是，直接用 nodemailer 的 transporter 发送时，`from` 字段包含 `Email Receiver <2013829165@qq.com>`，而 QQ 对发件人显示名也有过滤。

**解决**：reply action 改为调用已有的 `deliver-qq.js` 脚本（qq-email-skill 的发送模块）来发送邮件，复用了经过验证的发送逻辑。nodemailer 本身配置完全相同，区别在于调用方式。

**最终结果**：reply action 成功发送自动回复，710314323@qq.com 收到 "Re: (无主题)" 的回复邮件。

---

### 7. 自发自收邮件无法被 IMAP 监听

**现象**：从 2013829165@qq.com 发邮件到 2013829165@qq.com 后，IMAP 监听器搜索 `UNSEEN` 时找不到邮件（但用 `FROM 710314323` 搜索可以找到 message ID）

**原因**：QQ 邮箱对自己发给自己的邮件会通过推送服务实时同步，推送通知弹出的同时邮件已被标记为已读，导致 IMAP 监听器检查时邮件已经是 `SEEN` 状态

**影响**：正常使用中这不是问题——只要 cron 在用户查收邮件之前运行，就能捕捉到新邮件

---

## 为什么遇到这些问题

### 根本原因：IMAP 和 Node.js Stream 的异步复杂性

IMAP 协议本身是同步的，但 `imap` 库的 Node.js 实现大量使用了 Stream 和事件循环。当 `imap.fetch()` 返回多个 message 时，这些 message 的 `body` 解析（涉及 `simpleParser` 异步操作）是完全异步的，而 `fetch.once('end')` 事件会在所有 `message` 事件发出后立即触发，不管这些 message 的数据是否解析完成。

### 信息差

1. **`imap` 库的事件机制不熟悉**：`fetch.message` 事件的第二个参数 `seqno` 的行为（它就是 sequence number），以及 `uid` 是 non-enumerable 的特性——这些在文档中不明确，只能通过实验验证
2. **不知道 QQ SMTP 有 IP 限制**——需要 QQ 邮箱授权的固定 IP 或特定客户端才能发送，这个信息 QQ 邮箱没有明确说明

---

## 在这个过程中可以改进的地方

### 用户方面

1. **提供更多信息**：
   - 发件邮箱和收件邮箱是否相同（测试时发现自发自收的问题）
   - 收到回复邮件时通知我（我无法主动查看 710314323@qq.com 的收件箱）
   - 告诉我你用的设备/环境（手机 App？网页版？）——不同客户端对 IMAP 推送行为不同

2. **减少重复确认**：调试过程中多次让我「再发一封测试一下」，可以一次性说清楚测试计划

### 代码/架构方面

1. **reply action 需要替换 SMTP 为 API 方式**：使用 Resend API 或其他邮件发送服务，避免 QQ SMTP 的 IP 限制
2. **支持邮件文本内容的语义匹配**：目前只匹配发件人白名单，未来如果需要「根据邮件内容触发不同 action」，需要引入 LLM 解析
3. **配置支持多收件箱**：目前只支持一个 QQ 邮箱，未来可能需要支持多个邮箱账户
