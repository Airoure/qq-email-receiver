#!/usr/bin/env node

// ============================================================================
// QQ Email Receiver - IMAP Listener with Whitelist Actions
// ============================================================================
// Listens to QQ邮箱 IMAP and executes actions based on sender whitelist.
//
// Usage:
//   node receive-qq.js                    # daemon mode (continuous polling)
//   node receive-qq.js --once              # check once and exit
//   node receive-qq.js --config /path.json # custom config path
//
// Required config in ~/.follow-builders/receivers.json:
//   imap.user, imap.pass, imap.checkIntervalMs, whitelist[{email, actions}]
//
// Three action types:
//   script  - runs a shell command
//   api     - calls an HTTP endpoint
//   reply   - sends an email reply to the sender
// ============================================================================

import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { spawn } from 'child_process';
import { config as loadEnv } from 'dotenv';
import nodemailer from 'nodemailer';
import Imap from 'imap';
import { simpleParser } from 'mailparser';

// -- Constants ---------------------------------------------------------------

const ENV_PATH = join(homedir(), '.follow-builders', '.env');
const DEFAULT_CONFIG_PATH = join(homedir(), '.follow-builders', 'receivers.json');

// -- Config Loading ----------------------------------------------------------

function getConfigPath() {
  const args = process.argv.slice(2);
  const idx = args.indexOf('--config');
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return null;
}

function isOnceMode() {
  return process.argv.includes('--once');
}

async function loadConfig() {
  const configPath = getConfigPath() || DEFAULT_CONFIG_PATH;
  let config;
  try {
    const raw = await readFile(configPath, 'utf-8');
    config = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to load config from ${configPath}: ${err.message}`);
  }

  // Allow .env to override imap credentials
  loadEnv({ path: ENV_PATH });
  if (process.env.QQ_IMAP_USER) config.imap.user = process.env.QQ_IMAP_USER;
  if (process.env.QQ_IMAP_PASS) config.imap.pass = process.env.QQ_IMAP_PASS;

  if (!config.imap?.user || !config.imap?.pass) {
    throw new Error('IMAP user/pass not configured in receivers.json or .env');
  }
  if (!Array.isArray(config.whitelist) || config.whitelist.length === 0) {
    throw new Error('No whitelist entries in receivers.json');
  }

  return config;
}

// -- IMAP Connection ----------------------------------------------------------

function createImapConnection(config) {
  return new Imap({
    user: config.imap.user,
    password: config.imap.pass,
    host: 'imap.qq.com',
    port: 993,
    tls: true,
    tlsOptions: { rejectUnauthorized: false }
  });
}

function buildSearchQuery() {
  return ['UNSEEN'];
}

async function waitForIdle(imap) {
  return new Promise((resolve) => {
    imap.once('update', resolve);
    imap.once('ready', resolve);
  });
}

// -- Email Fetching ----------------------------------------------------------

async function fetchUnseenEmails(imap) {
  return new Promise((resolve, reject) => {
    const doFetch = () => {
      const query = buildSearchQuery();
      imap.search(query, async (err, results) => {
        if (err) {
          reject(err);
          return;
        }
        if (!results || results.length === 0) {
          resolve([]);
          return;
        }

        const fetch = imap.fetch(results, {
          bodies: '',
          struct: true
        });

        const emails = [];
        fetch.on('message', (msg) => {
          const email = { id: msg.uid || msg.seqno, headers: {}, subject: '', from: '', text: '' };
          msg.on('body', (stream) => {
            let buffer = '';
            stream.on('data', (chunk) => { buffer += chunk.toString('utf-8'); });
            stream.once('end', async () => {
              try {
                const parsed = await simpleParser(buffer);
                email.subject = parsed.subject || '(无主题)';
                email.from = parsed.from?.text || '';
                email.text = parsed.text || '';
                // Normalize from: "User <email>" -> just email
                const match = email.from.match(/<(.+?)>/);
                if (match) email.from = match[1];
              } catch (e) {
                // use raw buffer
              }
              emails.push(email);
            });
          });
        });

        fetch.once('end', () => {
          // Wait a bit for all 'end' events to fire
          setTimeout(() => resolve(emails), 500);
        });

        fetch.once('error', reject);
      });
    };

    if (imap.state === 'authenticated') {
      doFetch();
    } else {
      imap.once('ready', doFetch);
    }
  });
}

// -- Action Handlers ---------------------------------------------------------

async function handleAction(action, email, smtpTransport) {
  switch (action.type) {
    case 'script':
      return executeScript(action);
    case 'api':
      return callApi(action);
    case 'reply':
      return sendReply(action, email, smtpTransport);
    default:
      console.log(JSON.stringify({ status: 'error', action: 'unknown_type', message: `Unknown action type: ${action.type}` }));
  }
}

function executeScript(action) {
  return new Promise((resolve) => {
    const cmd = action.command;
    const args = action.args || [];
    const child = spawn('/bin/bash', ['-c', cmd, ...args], {
      stdio: 'pipe'
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      console.log(JSON.stringify({
        status: code === 0 ? 'ok' : 'error',
        action: 'script',
        command: cmd,
        code,
        stdout: stdout.trim(),
        stderr: stderr.trim()
      }));
      resolve({ ok: code === 0, stdout, stderr, code });
    });
    child.on('error', (err) => {
      console.log(JSON.stringify({ status: 'error', action: 'script', command: cmd, message: err.message }));
      resolve({ ok: false, error: err.message });
    });
  });
}

async function callApi(action) {
  try {
    const url = action.url;
    const method = action.method || 'GET';
    const headers = action.headers || { 'Content-Type': 'application/json' };
    const body = action.body ? JSON.stringify(action.body) : undefined;

    const response = await fetch(url, { method, headers, body });
    const text = await response.text();
    console.log(JSON.stringify({
      status: response.ok ? 'ok' : 'error',
      action: 'api',
      url,
      method,
      statusCode: response.status,
      response: text.substring(0, 200)
    }));
    return { ok: response.ok, statusCode: response.status, response: text };
  } catch (err) {
    console.log(JSON.stringify({ status: 'error', action: 'api', url: action.url, message: err.message }));
    return { ok: false, error: err.message };
  }
}

function sendReply(action, email, transporter) {
  return new Promise(async (resolve) => {
    try {
      // Extract the original sender email for reply
      const replyTo = email.from;
      if (!replyTo) {
        console.log(JSON.stringify({ status: 'error', action: 'reply', message: 'Cannot determine reply-to address' }));
        resolve({ ok: false });
        return;
      }

      const subject = action.subject || `Re: ${email.subject}`;
      const message = action.message || '收到指令，已处理。';

      await transporter.sendMail({
        from: `"${action.fromName || 'Email Receiver'}" <${transporter.user}>`,
        to: replyTo,
        subject,
        text: message
      });

      console.log(JSON.stringify({
        status: 'ok',
        action: 'reply',
        to: replyTo,
        subject
      }));
      resolve({ ok: true });
    } catch (err) {
      console.log(JSON.stringify({ status: 'error', action: 'reply', message: err.message }));
      resolve({ ok: false, error: err.message });
    }
  });
}

// -- Whitelist Matching ------------------------------------------------------

function matchWhitelist(email, whitelist) {
  const normalized = email.toLowerCase().trim();
  return whitelist.find(entry => {
    const entryEmail = (entry.email || '').toLowerCase().trim();
    return entryEmail === normalized;
  }) || null;
}

// -- Mark as Seen -----------------------------------------------------------

function markAsSeen(imap, email) {
  return new Promise((resolve) => {
    imap.addFlags(email.id, '\\Seen', (err) => {
      if (err) {
        console.log(JSON.stringify({ status: 'error', action: 'mark_seen', message: err.message }));
      }
      resolve();
    });
  });
}

// -- Main Loop ---------------------------------------------------------------

async function processEmails(imap, config, transporter) {
  const emails = await fetchUnseenEmails(imap);
  if (emails.length === 0) {
    console.log(JSON.stringify({ status: 'ok', action: 'poll', message: 'No new emails' }));
    return;
  }

  console.log(JSON.stringify({ status: 'ok', action: 'poll', count: emails.length }));

  for (const email of emails) {
    const entry = matchWhitelist(email.from, config.whitelist);
    if (!entry) {
      console.log(JSON.stringify({ status: 'skipped', from: email.from, reason: 'Not in whitelist' }));
      continue;
    }

    console.log(JSON.stringify({ status: 'ok', action: 'matched', from: email.from, subject: email.subject }));

    for (const action of (entry.actions || [])) {
      await handleAction(action, email, transporter);
    }

    await markAsSeen(imap, email);
  }
}

async function main() {
  let config;
  try {
    config = await loadConfig();
  } catch (err) {
    console.log(JSON.stringify({ status: 'error', phase: 'config', message: err.message }));
    process.exit(1);
  }

  const imap = createImapConnection(config);
  const transporter = nodemailer.createTransport({
    host: 'smtp.qq.com',
    port: 465,
    secure: true,
    auth: {
      user: config.imap.user,
      pass: config.imap.pass
    }
  });

  const once = isOnceMode();

  imap.on('error', (err) => {
    console.log(JSON.stringify({ status: 'error', phase: 'imap', message: err.message }));
    if (!once) {
      // Reconnect after delay
      setTimeout(() => {
        imap.connect();
      }, 10000);
    }
  });

  await new Promise((resolve, reject) => {
    imap.once('ready', () => {
      console.log(JSON.stringify({ status: 'ok', phase: 'imap_connected', message: 'Connected to QQ IMAP' }));
      resolve();
    });
    imap.once('error', reject);
    imap.connect();
  });

  const poll = async () => {
    try {
      await processEmails(imap, config, transporter);
    } catch (err) {
      console.log(JSON.stringify({ status: 'error', phase: 'poll', message: err.message }));
    }

    if (once) {
      imap.end();
      console.log(JSON.stringify({ status: 'ok', phase: 'done', message: 'Single poll complete' }));
      process.exit(0);
    } else {
      setTimeout(poll, config.imap.checkIntervalMs || 30000);
    }
  };

  await poll();
}

main().catch(err => {
  console.log(JSON.stringify({ status: 'error', phase: 'main', message: err.message }));
  process.exit(1);
});
