#!/usr/bin/env node
'use strict';

// Starts figma-developer-mcp with the Figma personal access token of the context that
// applies to the project directory. Claude Code runs this from the plugin's .mcp.json:
//
//   node mcp-wrap.js "${CLAUDE_PROJECT_DIR}"
//
// The token comes from `exe ctx env --only figma` (exe-contexts), so it lives in the
// keychain and is handed to the server process only. EXE_FIGMA_TOKEN or FIGMA_API_KEY in
// the environment override that, for one-off use without profiles.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

function projectDir(arg) {
  if (!arg || arg.includes('${') || !fs.existsSync(arg)) return process.cwd();
  return arg;
}

function findExe() {
  const candidates = [
    process.env.EXE_BIN,
    path.join(os.homedir(), '.local', 'bin', 'exe'),
    path.join(os.homedir(), '.claude', 'plugins', 'marketplaces', 'exe', 'bin', 'exe'),
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return 'exe';
}

function unquote(shellSingleQuoted) {
  return shellSingleQuoted.replace(/'\\''/g, "'");
}

function figmaToken(dir) {
  if (process.env.EXE_FIGMA_TOKEN) return process.env.EXE_FIGMA_TOKEN;
  const res = spawnSync(findExe(), ['ctx', 'env', '--cwd', dir, '--with-secrets', '--only', 'figma'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (res.error || res.status !== 0) return null;
  const m = /export FIGMA_TOKEN='((?:[^']|'\\'')*)'/.exec(res.stdout);
  return m ? unquote(m[1]) : null;
}

function serverCommand() {
  const which = spawnSync('which', ['figma-developer-mcp'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const bin = which.status === 0 ? which.stdout.trim().split('\n')[0] : '';
  if (bin) return { cmd: bin, args: ['--stdio'] };
  return { cmd: 'npx', args: ['-y', 'figma-developer-mcp', '--stdio'] };
}

function main() {
  const dir = projectDir(process.argv[2]);
  const token = figmaToken(dir) || process.env.FIGMA_API_KEY || null;
  if (!token) {
    process.stderr.write(`exe-figma: no Figma token for ${dir}. Add "figma": { "token": "secret:figma-<context>" } to the context in ~/.config/exe/profiles.json and store it with: exe secret set figma-<context>\n`);
    process.exit(1);
  }
  const { cmd, args } = serverCommand();
  const env = { ...process.env, FIGMA_API_KEY: token };
  delete env.EXE_FIGMA_TOKEN;
  const child = spawn(cmd, args, { stdio: 'inherit', env });
  child.on('error', (err) => { process.stderr.write(`exe-figma: cannot start ${cmd}: ${err.message}. Install it with: npm install -g figma-developer-mcp\n`); process.exit(1); });
  child.on('exit', (code) => process.exit(code === null ? 1 : code));
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => child.kill(sig));
}

main();
