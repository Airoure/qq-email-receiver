# QQ Email Receiver

监听 QQ邮箱 IMAP，根据发件人白名单自动执行预设操作（运行脚本 / 调用 API / 回复邮件）。

## 功能特性

- IMAP 轮询未读邮件（支持 daemon 模式和单次检查模式）
- 白名单机制：只有白名单内的发件人才能触发操作
- 三种 Action 类型：
  - **script** — 在服务器上执行任意 shell 命令
  - **api** — 触发 HTTP 请求（POST/GET 等）
  - **reply** — 自动回复邮件给发件人

## 安装

```bash
git clone https://github.com/Airoure/qq-email-receiver.git ~/projects/qq-email-receiver
cd ~/projects/qq-email-receiver
npm install
```

## 配置

### 1. 创建配置文件

```bash
cp config.example.json ~/.follow-builders/receivers.json
```

### 2. 修改 `~/.follow-builders/receivers.json`

#### IMAP 配置

| 字段 | 说明 |
|------|------|
| `imap.user` | QQ 邮箱地址 |
| `imap.pass` | SMTP/IMAP 授权码（和 SMTP 用同一个码） |
| `imap.checkIntervalMs` | 轮询间隔（毫秒），默认 30000（30秒） |

> **凭证说明**：IMAP 授权码和 SMTP 授权码是同一个码。如果 `~/.follow-builders/.env` 里已配置 `QQ_SMTP_PASS`，脚本会自动使用它（无需在 receivers.json 里重复配置）。

#### 白名单配置

每个白名单项包含 `email` 和 `actions` 数组：

```json
{
  "email": "2013829165@qq.com",
  "actions": [
    { "type": "script", "command": "/bin/bash /path/to/script.sh" },
    { "type": "reply", "message": "收到指令，正在执行…" }
  ]
}
```

## Action 类型详解

### script — 执行脚本

```json
{
  "type": "script",
  "command": "/bin/bash /path/to/deploy.sh",
  "args": ["arg1", "arg2"]
}
```

- `command`: 要执行的完整命令
- `args`: 可选，传递给命令的参数数组

### api — 调用 HTTP 接口

```json
{
  "type": "api",
  "url": "https://example.com/webhook",
  "method": "POST",
  "headers": { "Authorization": "Bearer token" },
  "body": { "event": "email_received", "from": "qq-receiver" }
}
```

- `url`: 请求目标 URL
- `method`: HTTP 方法，默认 GET
- `headers`: 可选，请求头
- `body`: 可选，请求体（会自动 JSON.stringify）

### reply — 自动回复

```json
{
  "type": "reply",
  "message": "收到指令，正在处理…",
  "subject": "Re: {{original_subject}}",
  "fromName": "Auto Reply Bot"
}
```

- `message`: 回复内容
- `subject`: 可选，默认为 `Re: {原邮件主题}`
- `fromName`: 可选，发件人显示名

## 运行

### Daemon 模式（持续监听）

```bash
node receive-qq.js
```

### 单次检查（适合 cron）

```bash
node receive-qq.js --once
```

### 自定义配置路径

```bash
node receive-qq.js --config /path/to/config.json
```

## Crontab 示例

每分钟检查一次新邮件：

```cron
* * * * * cd ~/projects/qq-email-receiver && node receive-qq.js --once >> ~/logs/qq-receiver.log 2>&1
```

## 日志输出

每条输出都是 JSON 格式，方便解析：

```json
{"status":"ok","phase":"imap_connected","message":"Connected to QQ IMAP"}
{"status":"ok","action":"poll","count":1}
{"status":"ok","action":"matched","from":"2013829165@qq.com","subject":"测试"}
{"status":"ok","action":"script","command":"/bin/bash /path/to/script.sh","code":0,"stdout":"done","stderr":""}
{"status":"ok","action":"reply","to":"2013829165@qq.com","subject":"Re: 测试"}
{"status":"skipped","from":"unknown@example.com","reason":"Not in whitelist"}
```

## 凭证覆盖

`~/.follow-builders/.env` 中的 `QQ_IMAP_USER` 和 `QQ_IMAP_PASS` 可以覆盖 `receivers.json` 中的 imap 凭证。

## 安全提示

- 配置文件包含敏感信息，请妥善保管
- 白名单是唯一的安全屏障，确保只添加可信邮箱
- script 类型可执行任意命令，注意权限控制
