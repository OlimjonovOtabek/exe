'use strict';

// Profile registry and context resolution for exe.
//
// Profiles live in ~/.config/exe/profiles.json (override with EXE_PROFILES).
// A context is chosen, in order, from:
//   1. EXE_CONTEXT environment variable
//   2. .exe.json in the git root or the working directory: { "context": "name" }
//   3. the host of the git remote "origin", matched against contexts[].match.remoteHosts
//   4. profiles.default
//
// Token values in a profile are references, resolved lazily by resolveSecret():
//   secret:NAME   the exe secret store (bin/secrets.sh)
//   env:VAR       an environment variable
//   op://...      a 1Password reference, read through `op read`
//   anything else is used literally

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const CONFIG_DIR = process.env.EXE_CONFIG_DIR || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'exe');
const PROFILES_PATH = process.env.EXE_PROFILES || path.join(CONFIG_DIR, 'profiles.json');
const SECRETS_SH = path.join(__dirname, '..', 'bin', 'secrets.sh');

class ProfilesError extends Error {}

function loadProfiles(file = PROFILES_PATH) {
  if (!fs.existsSync(file)) {
    throw new ProfilesError(`no profiles at ${file}. Run: exe ctx init`);
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ProfilesError(`cannot parse ${file}: ${err.message}`);
  }
  if (!data || typeof data.contexts !== 'object' || Object.keys(data.contexts).length === 0) {
    throw new ProfilesError(`${file} has no "contexts"`);
  }
  for (const [name, ctx] of Object.entries(data.contexts)) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new ProfilesError(`context name "${name}" must be lowercase letters, digits and dashes`);
    if (!ctx || typeof ctx !== 'object' || Array.isArray(ctx)) throw new ProfilesError(`context "${name}" must be an object`);
    if (ctx.jira && !ctx.jira.url) throw new ProfilesError(`context "${name}": jira.url missing`);
    if (ctx.jira && ctx.jira.kind && !['cloud', 'datacenter'].includes(ctx.jira.kind)) throw new ProfilesError(`context "${name}": jira.kind must be cloud or datacenter`);
    if (ctx.gitlab && !ctx.gitlab.host) throw new ProfilesError(`context "${name}": gitlab.host missing`);
  }
  if (data.default && !data.contexts[data.default]) throw new ProfilesError(`default context "${data.default}" is not defined`);
  data.path = file;
  return data;
}

// "git@host:group/repo.git", "ssh://git@host:2222/group/repo.git", "https://host/group/repo.git"
function remoteHost(url) {
  if (!url) return null;
  const trimmed = url.trim();
  let m = trimmed.match(/^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\//i);
  if (m) return m[1].toLowerCase();
  m = trimmed.match(/^(?:[^@]+@)?([^:/]+):/);
  if (m) return m[1].toLowerCase();
  return null;
}

function git(args, cwd) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return res.status === 0 ? res.stdout.trim() : null;
}

function gitRoot(cwd) {
  return git(['rev-parse', '--show-toplevel'], cwd);
}

function originHost(cwd) {
  return remoteHost(git(['remote', 'get-url', 'origin'], cwd));
}

function readOverride(cwd) {
  const candidates = [];
  const root = gitRoot(cwd);
  if (root) candidates.push(path.join(root, '.exe.json'));
  candidates.push(path.join(cwd, '.exe.json'));
  for (const file of candidates) {
    if (fs.existsSync(file)) {
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (data && typeof data.context === 'string') return { context: data.context, file };
      } catch (_) { /* ignore a broken override file; the remote match still works */ }
    }
  }
  return null;
}

// Returns { name, context, source, host, profiles }
function resolveContext(cwd = process.cwd(), profiles = loadProfiles(), env = process.env) {
  const pick = (name, source, extra = {}) => {
    if (!profiles.contexts[name]) throw new ProfilesError(`context "${name}" (${source}) is not defined in ${profiles.path}`);
    return { name, context: profiles.contexts[name], source, profiles, ...extra };
  };
  if (env.EXE_CONTEXT) return pick(env.EXE_CONTEXT, 'EXE_CONTEXT');
  const override = readOverride(cwd);
  if (override) return pick(override.context, override.file);
  const host = originHost(cwd);
  if (host) {
    for (const [name, ctx] of Object.entries(profiles.contexts)) {
      const hosts = (ctx.match && ctx.match.remoteHosts) || [];
      if (hosts.map((h) => h.toLowerCase()).includes(host)) return pick(name, `remote ${host}`, { host });
    }
  }
  if (profiles.default) return pick(profiles.default, 'default', { host });
  throw new ProfilesError(`no context matches ${host ? `remote host ${host}` : 'this directory'} and no default is set`);
}

function resolveSecret(ref) {
  if (ref === undefined || ref === null || ref === '') return null;
  if (ref.startsWith('secret:')) {
    const res = spawnSync('bash', [SECRETS_SH, 'get', ref.slice(7)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (res.status !== 0) return null;
    return res.stdout.trim() || null;
  }
  if (ref.startsWith('env:')) return process.env[ref.slice(4)] || null;
  if (ref.startsWith('op://')) {
    try { return execFileSync('op', ['read', ref], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch (_) { return null; }
  }
  return ref;
}

function secretName(ref) {
  return ref && ref.startsWith('secret:') ? ref.slice(7) : null;
}

module.exports = {
  CONFIG_DIR,
  PROFILES_PATH,
  SECRETS_SH,
  ProfilesError,
  loadProfiles,
  remoteHost,
  originHost,
  gitRoot,
  readOverride,
  resolveContext,
  resolveSecret,
  secretName,
};
