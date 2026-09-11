'use strict';

// Health checks for exe: tools on PATH, the proxy, and one live API call per token.

const http = require('http');
const https = require('https');
const { spawnSync } = require('child_process');
const { resolveSecret, PROFILES_PATH } = require('./profiles');
const { jiraConfigPath, gitIdentityPath, hostPatterns } = require('./setup');
const fs = require('fs');

function request(url, { headers = {}, insecure = false, timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request(u, { method: 'GET', headers: { 'user-agent': 'exe-doctor', accept: 'application/json', ...headers }, rejectUnauthorized: !insecure }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { if (body.length < 65536) body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', (err) => resolve({ error: err.code || err.message }));
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
    req.end();
  });
}

function parse(body) { try { return JSON.parse(body); } catch (_) { return null; } }

function verdict(res, describe) {
  if (res.error) return { level: 'fail', text: `unreachable (${res.error})` };
  if (res.status === 200) return { level: 'ok', text: describe(parse(res.body) || {}) };
  if (res.status === 401 || res.status === 403) return { level: 'fail', text: `token rejected (HTTP ${res.status})` };
  return { level: 'warn', text: `HTTP ${res.status}` };
}

async function checkJira(name, ctx) {
  const token = resolveSecret(ctx.jira.token);
  if (!token) return { context: name, check: 'jira', level: 'fail', text: `token ${ctx.jira.token || '(none)'} not found` };
  const base = ctx.jira.url.replace(/\/+$/, '');
  const cloud = ctx.jira.kind !== 'datacenter';
  const headers = cloud
    ? { authorization: `Basic ${Buffer.from(`${ctx.jira.login || ''}:${token}`).toString('base64')}` }
    : { authorization: `Bearer ${token}` };
  const res = await request(`${base}/rest/api/${cloud ? 3 : 2}/myself`, { headers, insecure: !!ctx.jira.insecure });
  const v = verdict(res, (me) => `${ctx.jira.url} as ${me.displayName || me.name || me.emailAddress || 'unknown user'}`);
  return { context: name, check: 'jira', ...v };
}

async function checkGitlab(name, ctx) {
  const token = resolveSecret(ctx.gitlab.token);
  if (!token) return { context: name, check: 'gitlab', level: 'fail', text: `token ${ctx.gitlab.token || '(none)'} not found` };
  const res = await request(`https://${ctx.gitlab.host}/api/v4/user`, { headers: { 'private-token': token }, insecure: !!ctx.gitlab.insecure });
  const v = verdict(res, (me) => `${ctx.gitlab.host} as ${me.username || 'unknown user'}`);
  return { context: name, check: 'gitlab', ...v };
}

async function checkFigma(name, ctx) {
  const token = resolveSecret(ctx.figma.token);
  if (!token) return { context: name, check: 'figma', level: 'fail', text: `token ${ctx.figma.token || '(none)'} not found` };
  const res = await request('https://api.figma.com/v1/me', { headers: { 'x-figma-token': token } });
  const v = verdict(res, (me) => `figma as ${me.email || me.handle || 'unknown user'}`);
  return { context: name, check: 'figma', ...v };
}

function checkGitIdentity(name, ctx) {
  if (!ctx.git || !ctx.git.email) return null;
  const file = gitIdentityPath(name);
  if (!fs.existsSync(file)) return { context: name, check: 'git', level: 'warn', text: `identity file missing, run: exe setup git` };
  const hosts = (ctx.match && ctx.match.remoteHosts) || [];
  for (const host of hosts) {
    for (const pattern of hostPatterns(host)) {
      const res = spawnSync('git', ['config', '--global', '--get-all', `includeIf.hasconfig:remote.*.url:${pattern}.path`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      if (res.status !== 0 || !res.stdout.split('\n').map((s) => s.trim()).includes(file)) {
        return { context: name, check: 'git', level: 'warn', text: `includeIf for ${host} missing, run: exe setup git` };
      }
    }
  }
  return { context: name, check: 'git', level: 'ok', text: `${ctx.git.email} for ${hosts.join(', ') || 'no hosts'}` };
}

function checkJiraConfig(name, ctx) {
  if (!ctx.jira) return null;
  const file = jiraConfigPath(name);
  return fs.existsSync(file)
    ? { context: name, check: 'jira-cli', level: 'ok', text: file }
    : { context: name, check: 'jira-cli', level: 'warn', text: `config missing, run: exe setup jira` };
}

function checkTools() {
  // jira-cli has no --version flag; the exe shims exit 127 when the real tool is missing.
  const tools = [['claude', '--version'], ['node', '--version'], ['git', '--version'], ['jira', 'version'], ['glab', '--version'], ['ast-index', '--version'], ['ccusage', '--version'], ['pxpipe', '--version']];
  return tools.map(([tool, arg]) => {
    const res = spawnSync(tool, [arg], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const missing = res.error || res.status === null || res.status === 127;
    if (missing) return { context: '-', check: tool, level: tool === 'claude' || tool === 'git' ? 'fail' : 'warn', text: 'not on PATH' };
    const line = ((res.stdout || res.stderr || '').split('\n').find((l) => l.trim()) || '').trim();
    return { context: '-', check: tool, level: 'ok', text: (res.status === 0 ? line : 'installed').slice(0, 60) };
  });
}

async function checkPxpipe() {
  const port = process.env.EXE_PXPIPE_PORT || '47821';
  const res = await request(`http://127.0.0.1:${port}/proxy-stats`, { timeoutMs: 2000 });
  if (res.error) return { context: '-', check: 'pxpipe-proxy', level: 'warn', text: `not listening on ${port}` };
  const stats = parse(res.body) || {};
  return { context: '-', check: 'pxpipe-proxy', level: 'ok', text: `listening on ${port}, ${stats.requests || 0} requests, ${stats.saved_pct || 0}% saved` };
}

async function runDoctor(profiles, { only = null } = {}) {
  const results = [];
  results.push({ context: '-', check: 'profiles', level: 'ok', text: profiles.path || PROFILES_PATH });
  results.push(...checkTools());
  results.push(await checkPxpipe());
  for (const [name, ctx] of Object.entries(profiles.contexts)) {
    if (only && name !== only) continue;
    const jiraCfg = checkJiraConfig(name, ctx); if (jiraCfg) results.push(jiraCfg);
    if (ctx.jira) results.push(await checkJira(name, ctx));
    if (ctx.gitlab && ctx.gitlab.token) results.push(await checkGitlab(name, ctx));
    if (ctx.figma && ctx.figma.token) results.push(await checkFigma(name, ctx));
    const gitId = checkGitIdentity(name, ctx); if (gitId) results.push(gitId);
  }
  return results;
}

function formatResults(results) {
  const width = Math.max(...results.map((r) => `${r.context}/${r.check}`.length));
  return results.map((r) => `${r.level.padEnd(4)}  ${`${r.context}/${r.check}`.padEnd(width)}  ${r.text}`).join('\n');
}

module.exports = { runDoctor, formatResults, request };
