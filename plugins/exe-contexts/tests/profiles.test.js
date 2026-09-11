'use strict';

// Run with: node --test "plugins/exe-contexts/tests/*.test.js"
// Uses temporary directories only; never touches the real ~/.config or ~/.gitconfig.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exe-test-'));
const configDir = path.join(tmp, 'config');
process.env.EXE_CONFIG_DIR = configDir;
process.env.EXE_PROFILES = path.join(configDir, 'profiles.json');
process.env.XDG_CONFIG_HOME = path.join(tmp, 'xdg');
delete process.env.EXE_CONTEXT;

fs.mkdirSync(configDir, { recursive: true });
fs.copyFileSync(path.join(__dirname, '..', 'templates', 'profiles.example.json'), process.env.EXE_PROFILES);

const P = require('../lib/profiles');
const S = require('../lib/setup');

function repo(name, remote) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: dir });
  if (remote) spawnSync('git', ['remote', 'add', 'origin', remote], { cwd: dir });
  return dir;
}

test('remoteHost parses ssh, scp-like and https remotes', () => {
  assert.equal(P.remoteHost('git@gitlab.uzinfocom.uz:team/app.git'), 'gitlab.uzinfocom.uz');
  assert.equal(P.remoteHost('ssh://git@git.devhub.uz:2222/group/app.git'), 'git.devhub.uz');
  assert.equal(P.remoteHost('https://oauth2:token@gitlab.com/me/app.git'), 'gitlab.com');
  assert.equal(P.remoteHost('https://GitLab.com/me/app'), 'gitlab.com');
  assert.equal(P.remoteHost(''), null);
});

test('resolveContext matches the origin host', () => {
  const r = P.resolveContext(repo('uz', 'git@gitlab.uzinfocom.uz:team/app.git'));
  assert.equal(r.name, 'uzinfocom');
  assert.equal(r.source, 'remote gitlab.uzinfocom.uz');
  assert.equal(P.resolveContext(repo('dh', 'https://git.devhub.uz/g/app.git')).name, 'devhub');
});

test('resolveContext falls back to the default and honours overrides', () => {
  const dir = repo('unknown', 'https://example.org/x/y.git');
  assert.equal(P.resolveContext(dir).name, 'personal');
  assert.equal(P.resolveContext(dir).source, 'default');
  fs.writeFileSync(path.join(dir, '.exe.json'), '{"context":"devhub"}');
  assert.equal(P.resolveContext(dir).name, 'devhub');
  assert.equal(P.resolveContext(dir, undefined, { EXE_CONTEXT: 'uzinfocom' }).name, 'uzinfocom');
  assert.throws(() => P.resolveContext(dir, undefined, { EXE_CONTEXT: 'nope' }), /not defined/);
});

test('resolveContext works without a git repo', () => {
  const dir = path.join(tmp, 'plain'); fs.mkdirSync(dir);
  assert.equal(P.resolveContext(dir).name, 'personal');
});

test('resolveSecret understands env and literal references', () => {
  process.env.EXE_TEST_TOKEN = 'abc';
  assert.equal(P.resolveSecret('env:EXE_TEST_TOKEN'), 'abc');
  assert.equal(P.resolveSecret('env:EXE_MISSING_TOKEN'), null);
  assert.equal(P.resolveSecret('literal-value'), 'literal-value');
  assert.equal(P.resolveSecret(''), null);
});

test('resolveSecret reads the file-backed secret store', () => {
  const env = { ...process.env, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, PATH: '/usr/bin:/bin' }; // no secret-tool: file backend
  const res = spawnSync('bash', [P.SECRETS_SH, 'set', 'jira-uzinfocom', 'tok-1'], { env, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  const saved = process.env.PATH; process.env.PATH = env.PATH;
  try { assert.equal(P.resolveSecret('secret:jira-uzinfocom'), 'tok-1'); assert.equal(P.resolveSecret('secret:missing'), null); }
  finally { process.env.PATH = saved; }
});

test('setupJira writes one config per context with the right auth type', () => {
  const profiles = P.loadProfiles();
  const actions = S.setupJira(profiles);
  assert.deepEqual(actions.map((a) => [a.context, a.action]), [['uzinfocom', 'write'], ['devhub', 'write']]);
  const uz = fs.readFileSync(S.jiraConfigPath('uzinfocom'), 'utf8');
  assert.match(uz, /installation: Local/); assert.match(uz, /auth_type: bearer/); assert.match(uz, /server: https:\/\/jira.uzinfocom.uz/); assert.match(uz, /key: PROJ/);
  const dh = fs.readFileSync(S.jiraConfigPath('devhub'), 'utf8');
  assert.match(dh, /installation: Cloud/); assert.match(dh, /auth_type: basic/);
  assert.equal(S.setupJira(profiles).every((a) => a.action === 'unchanged'), true);
});

test('setupGit writes identities and includeIf entries once', () => {
  const home = path.join(tmp, 'home'); fs.mkdirSync(home);
  const env = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig') };
  const profiles = P.loadProfiles();
  const first = S.setupGit(profiles, { env });
  assert.equal(first.filter((a) => a.action === 'add').length, 3 * 4, 'three patterns per host, four hosts');
  const cfg = fs.readFileSync(path.join(home, '.gitconfig'), 'utf8');
  assert.match(cfg, /includeIf "hasconfig:remote\.\*\.url:git@gitlab\.uzinfocom\.uz:\*\/\*\*"/);
  assert.match(fs.readFileSync(S.gitIdentityPath('devhub'), 'utf8'), /email = you@devhub.uz/);
  const second = S.setupGit(profiles, { env });
  assert.equal(second.every((a) => a.action === 'unchanged'), true);
  const dir = repo('idcheck', 'git@gitlab.uzinfocom.uz:team/app.git');
  const email = spawnSync('git', ['config', 'user.email'], { cwd: dir, env, encoding: 'utf8' }).stdout.trim();
  assert.equal(email, 'you@uzinfocom.uz');
});

test('ctx env prints only the requested section and no token without --with-secrets', () => {
  const dir = repo('envtest', 'git@gitlab.uzinfocom.uz:team/app.git');
  const out = spawnSync('node', [path.join(__dirname, '..', 'bin', 'ctx.js'), 'ctx', 'env', '--cwd', dir, '--only', 'jira'], { encoding: 'utf8', env: process.env });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /JIRA_CONFIG_FILE=/); assert.match(out.stdout, /JIRA_AUTH_TYPE='bearer'/);
  assert.doesNotMatch(out.stdout, /GITLAB_HOST/); assert.doesNotMatch(out.stdout, /JIRA_API_TOKEN/);
});

test.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
