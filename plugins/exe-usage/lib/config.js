'use strict';

// Configuration and state paths for exe-usage.
//
// Values come, in order, from:
//   1. EXE_USAGE_<KEY> environment variables (tests, one-off overrides)
//   2. CLAUDE_PLUGIN_OPTION_<KEY>, the plugin's userConfig as exported by Claude Code
//   3. ~/.config/exe/usage.json with the same snake_case keys
//   4. defaults below
//
// State (samples, analysis cooldowns, reports) lives in ~/.local/state/exe/usage.

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULTS = {
  telegram_bot_token: '',
  telegram_chat_id: '',
  analysis_model: 'claude-fable-5-1',
  analysis_effort: 'high',
  analysis_auth: 'subscription',
  anthropic_api_key: '',
  threshold_percent: '60',
  pager: 'off',
  pxpipe_port: '47821',
};

const CONFIG_DIR = process.env.EXE_CONFIG_DIR || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'exe');
const CONFIG_FILE = path.join(CONFIG_DIR, 'usage.json');
const STATE_DIR = process.env.EXE_STATE_DIR || path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'exe', 'usage');
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

function fileConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (_) { return {}; }
}

function get(key) {
  const upper = key.toUpperCase();
  if (process.env[`EXE_USAGE_${upper}`] !== undefined) return process.env[`EXE_USAGE_${upper}`];
  if (process.env[`CLAUDE_PLUGIN_OPTION_${upper}`] !== undefined) return process.env[`CLAUDE_PLUGIN_OPTION_${upper}`];
  const fromFile = fileConfig()[key];
  if (fromFile !== undefined && fromFile !== null && fromFile !== '') return String(fromFile);
  return DEFAULTS[key] === undefined ? '' : DEFAULTS[key];
}

function threshold() {
  const n = Number(get('threshold_percent'));
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : 60;
}

function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  return STATE_DIR;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

// Serialize read-decide-write sequences on shared state files across concurrent sessions.
// mkdir is atomic; a lock older than staleMs is treated as abandoned. Returns
// { skipped: true } when another process holds the lock, else { skipped: false, value }.
function withLock(name, fn, { staleMs = 120000 } = {}) {
  ensureStateDir();
  const dir = path.join(STATE_DIR, `${name}.lock`);
  const acquire = () => { try { fs.mkdirSync(dir); return true; } catch (err) { if (err.code !== 'EEXIST') throw err; return false; } };
  if (!acquire()) {
    try { if (Date.now() - fs.statSync(dir).mtimeMs > staleMs) fs.rmdirSync(dir); } catch (_) { /* lock vanished */ }
    if (!acquire()) return { skipped: true };
  }
  try { return { skipped: false, value: fn() }; } finally { try { fs.rmdirSync(dir); } catch (_) { /* already released */ } }
}

module.exports = { DEFAULTS, CONFIG_DIR, CONFIG_FILE, STATE_DIR, CLAUDE_DIR, get, threshold, ensureStateDir, readJson, writeJson, withLock };
