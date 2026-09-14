'use strict';

// Telegram Bot API: sendMessage in HTML mode and sendDocument for longer reports.

const https = require('https');
const fs = require('fs');
const path = require('path');
const { get } = require('./config');

const MAX_TEXT = 4000; // API limit is 4096 characters after entity parsing

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Cuts HTML for Telegram without leaving a half tag, a half entity or an unclosed tag behind.
function truncate(text, max = MAX_TEXT) {
  if (text.length <= max) return text;
  let cut = text.slice(0, max - 40).replace(/<[^>]*$/, '').replace(/&[^;\s]*$/, '');
  for (const tag of ['b', 'i', 'code', 'pre', 'a']) {
    const opens = (cut.match(new RegExp(`<${tag}[\\s>]`, 'g')) || []).length;
    const closes = (cut.match(new RegExp(`</${tag}>`, 'g')) || []).length;
    for (let n = closes; n < opens; n += 1) cut += `</${tag}>`;
  }
  return `${cut}\n… (truncated)`;
}

function configured() {
  return !!(get('telegram_bot_token') && get('telegram_chat_id'));
}

function post(pathname, body, headers) {
  return new Promise((resolve) => {
    const req = https.request({ hostname: 'api.telegram.org', path: `/bot${get('telegram_bot_token')}${pathname}`, method: 'POST', headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(data); } catch (_) { /* keep raw */ } resolve({ status: res.statusCode, ok: !!(json && json.ok), body: json || data }); });
    });
    req.on('error', (err) => resolve({ status: 0, ok: false, body: err.message }));
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
    req.end(body);
  });
}

// text is already HTML-escaped where needed; allowed tags: b, i, code, pre, a
async function sendMessage(html) {
  if (!configured()) return { ok: false, body: 'telegram not configured' };
  const payload = JSON.stringify({ chat_id: get('telegram_chat_id'), text: truncate(html), parse_mode: 'HTML', disable_web_page_preview: true });
  return post('/sendMessage', payload, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
}

async function sendDocument(filePath, caption = '') {
  if (!configured()) return { ok: false, body: 'telegram not configured' };
  const boundary = `----exe${Date.now()}`;
  const name = path.basename(filePath);
  const file = fs.readFileSync(filePath);
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${get('telegram_chat_id')}\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${truncate(caption, 1000)}\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="parse_mode"\r\n\r\nHTML\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([head, file, tail]);
  return post('/sendDocument', body, { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': body.length });
}

module.exports = { escapeHtml, truncate, configured, sendMessage, sendDocument, MAX_TEXT };
