'use strict';

// Materialize a profile into the tools' own configuration:
//   git   one identity file per context, included from ~/.gitconfig by remote host
//   jira  one jira-cli config file per context (token is injected per command by the shim)
//   glab  optional: store each host token in glab's own keyring for use outside exe

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { CONFIG_DIR, resolveSecret } = require('./profiles');

function hostPatterns(host) {
  return [`https://${host}/**`, `git@${host}:*/**`, `ssh://git@${host}/**`];
}

function gitConfigGetAll(key, env) {
  const res = spawnSync('git', ['config', '--global', '--get-all', key], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'] });
  return res.status === 0 ? res.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : [];
}

function jiraConfigPath(name) {
  return path.join(CONFIG_DIR, 'jira', `${name}.yml`);
}

function gitIdentityPath(name) {
  return path.join(CONFIG_DIR, 'git', `${name}.gitconfig`);
}

// Returns a list of { context, action, detail } describing what was done.
function setupGit(profiles, { dryRun = false, env = process.env } = {}) {
  const out = [];
  for (const [name, ctx] of Object.entries(profiles.contexts)) {
    if (!ctx.git || !ctx.git.email) continue;
    const file = gitIdentityPath(name);
    const body = `[user]\n\temail = ${ctx.git.email}\n${ctx.git.name ? `\tname = ${ctx.git.name}\n` : ''}`;
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (current !== body) {
      if (!dryRun) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); }
      out.push({ context: name, action: 'write', detail: file });
    } else {
      out.push({ context: name, action: 'unchanged', detail: file });
    }
    const hosts = (ctx.match && ctx.match.remoteHosts) || [];
    for (const host of hosts) {
      for (const pattern of hostPatterns(host)) {
        const key = `includeIf.hasconfig:remote.*.url:${pattern}.path`;
        if (gitConfigGetAll(key, env).includes(file)) { out.push({ context: name, action: 'unchanged', detail: `includeIf ${pattern}` }); continue; }
        if (!dryRun) {
          const res = spawnSync('git', ['config', '--global', '--add', key, file], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
          if (res.status !== 0) { out.push({ context: name, action: 'fail', detail: `includeIf ${pattern}: ${res.stderr.trim()}` }); continue; }
        }
        out.push({ context: name, action: 'add', detail: `includeIf ${pattern}` });
      }
    }
  }
  return out;
}

function jiraConfigBody(ctx) {
  const cloud = ctx.jira.kind !== 'datacenter';
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const lines = [
    `installation: ${cloud ? 'Cloud' : 'Local'}`,
    `server: ${ctx.jira.url.replace(/\/+$/, '')}`,
    `login: ${ctx.jira.login || ''}`,
    `auth_type: ${cloud ? 'basic' : 'bearer'}`,
    `timezone: ${tz}`,
  ];
  if (ctx.jira.project) lines.push('project:', `  key: ${ctx.jira.project}`);
  return `${lines.join('\n')}\n`;
}

function setupJira(profiles, { dryRun = false } = {}) {
  const out = [];
  for (const [name, ctx] of Object.entries(profiles.contexts)) {
    if (!ctx.jira) continue;
    const file = jiraConfigPath(name);
    const body = jiraConfigBody(ctx);
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (current === body) { out.push({ context: name, action: 'unchanged', detail: file }); continue; }
    if (!dryRun) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body, { mode: 0o600 }); }
    out.push({ context: name, action: 'write', detail: file });
  }
  return out;
}

function setupGlab(profiles, { dryRun = false } = {}) {
  const out = [];
  const hasGlab = spawnSync('glab', ['--version'], { stdio: 'ignore' }).status === 0;
  if (!hasGlab) return [{ context: '-', action: 'fail', detail: 'glab not on PATH' }];
  for (const [name, ctx] of Object.entries(profiles.contexts)) {
    if (!ctx.gitlab || !ctx.gitlab.token) continue;
    const token = resolveSecret(ctx.gitlab.token);
    if (!token) { out.push({ context: name, action: 'fail', detail: `token ${ctx.gitlab.token} not found` }); continue; }
    if (dryRun) { out.push({ context: name, action: 'would', detail: `glab auth login --hostname ${ctx.gitlab.host} --stdin` }); continue; }
    const res = spawnSync('glab', ['auth', 'login', '--hostname', ctx.gitlab.host, '--stdin'], { input: token, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    out.push(res.status === 0
      ? { context: name, action: 'add', detail: `glab token stored for ${ctx.gitlab.host}` }
      : { context: name, action: 'fail', detail: `glab auth login ${ctx.gitlab.host}: ${(res.stderr || res.stdout).trim().split('\n').pop()}` });
  }
  return out;
}

module.exports = { setupGit, setupJira, setupGlab, jiraConfigPath, gitIdentityPath, jiraConfigBody, hostPatterns };
