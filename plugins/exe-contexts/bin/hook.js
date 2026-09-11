#!/usr/bin/env node
'use strict';

// Claude Code hooks for exe-contexts.
//
//   hook.js session-start --data DIR   resolve the context for the session's working directory,
//                                      put the exe shims on PATH for every Bash call, print a banner
//   hook.js cwd-changed  --data DIR    say so when the new directory belongs to another context
//
// Hook input arrives as JSON on stdin (session_id, cwd, ...). Output on stdout goes to Claude,
// so it stays to one or two lines. Nothing here ever prints a token.

const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../lib/profiles');

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch (_) { return ''; }
}

function stateDir(dataArg) {
  const base = dataArg && !dataArg.includes('${') ? dataArg : path.join(os.tmpdir(), 'exe-contexts');
  const dir = path.join(base, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function appendEnv(lines) {
  const file = process.env.CLAUDE_ENV_FILE;
  if (!file) return false;
  fs.appendFileSync(file, `${lines.join('\n')}\n`);
  return true;
}

function summary(resolved) {
  const c = resolved.context;
  const parts = [];
  if (c.jira) parts.push(`jira ${c.jira.url}`);
  if (c.gitlab) parts.push(`gitlab ${c.gitlab.host}`);
  if (c.git && c.git.email) parts.push(`git ${c.git.email}`);
  return parts.join(', ') || 'no services configured';
}

function main() {
  const [event, ...rest] = process.argv.slice(2);
  const dataIdx = rest.indexOf('--data');
  const dataArg = dataIdx >= 0 ? rest[dataIdx + 1] : null;
  let input = {};
  try { input = JSON.parse(readStdin() || '{}'); } catch (_) { input = {}; }
  const cwd = input.cwd || process.cwd();
  const sessionId = input.session_id || 'unknown';
  const pluginRoot = path.resolve(__dirname, '..');
  const shims = path.join(pluginRoot, 'bin', 'shims');

  if (event === 'session-start') {
    appendEnv([
      `export PATH="${shims}:$PATH"`,
      `export EXE_CONTEXTS_ROOT="${pluginRoot}"`,
    ]);
    let resolved;
    try {
      resolved = P.resolveContext(cwd);
    } catch (err) {
      process.stdout.write(`exe: ${err.message}. Profiles reference: ${path.join(pluginRoot, 'templates', 'profiles.example.json')}\n`);
      return;
    }
    fs.writeFileSync(path.join(stateDir(dataArg), `${sessionId}.json`), JSON.stringify({ context: resolved.name, cwd }));
    process.stdout.write(`exe context: ${resolved.name} (${resolved.source}); ${summary(resolved)}. jira and glab pick the token of the current directory; "exe doctor" checks everything.\n`);
    return;
  }

  if (event === 'cwd-changed') {
    let resolved;
    try { resolved = P.resolveContext(cwd); } catch (_) { return; }
    const file = path.join(stateDir(dataArg), `${sessionId}.json`);
    let previous = null;
    try { previous = JSON.parse(fs.readFileSync(file, 'utf8')).context; } catch (_) { previous = null; }
    if (previous === resolved.name) return;
    fs.writeFileSync(file, JSON.stringify({ context: resolved.name, cwd }));
    process.stdout.write(`exe context changed: ${resolved.name} (${resolved.source}); ${summary(resolved)}.\n`);
  }
}

main();
