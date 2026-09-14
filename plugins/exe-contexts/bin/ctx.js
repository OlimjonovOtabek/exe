#!/usr/bin/env node
'use strict';

// exe command line.
//
//   exe ctx [show] [--cwd DIR] [--json]     which context applies to a directory and why
//   exe ctx list                            all contexts with their hosts
//   exe ctx use NAME [--cwd DIR]            pin a project to a context (.exe.json at the git root)
//   exe ctx env [--cwd DIR] [--with-secrets] [--only jira|gitlab|figma]
//                                           shell exports for the context; eval "$(exe ctx env --with-secrets)"
//   exe ctx init                            create ~/.config/exe/profiles.json from the template
//   exe setup [git|jira|glab|all] [--dry-run]
//                                           write git identities, jira-cli configs, glab tokens
//   exe doctor [--context NAME] [--json]    check tools, proxy and every token
//   exe secret get|set|delete|list [NAME]   the secret store

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const P = require('../lib/profiles');
const S = require('../lib/setup');

function flag(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return null;
  const value = args[i + 1];
  args.splice(i, value !== undefined && !value.startsWith('--') ? 2 : 1);
  return value !== undefined && !value.startsWith('--') ? value : true;
}

function shellQuote(value) { return `'${String(value).replace(/'/g, `'\\''`)}'`; }

function die(message, code = 1) { process.stderr.write(`exe: ${message}\n`); process.exit(code); }

function usage() {
  const lines = fs.readFileSync(__filename, 'utf8').split('\n').slice(3, 15).map((l) => l.replace(/^\/\/ ?/, ''));
  process.stdout.write(`${lines.join('\n')}\n`);
}

function envExports(resolved, { withSecrets = false, only = null } = {}) {
  const { name, context } = resolved;
  const lines = [`export EXE_CONTEXT_ACTIVE=${shellQuote(name)}`];
  const want = (section) => !only || only === section;
  if (context.jira && want('jira')) {
    lines.push(`export JIRA_CONFIG_FILE=${shellQuote(S.jiraConfigPath(name))}`);
    lines.push(`export JIRA_AUTH_TYPE=${shellQuote(context.jira.kind === 'datacenter' ? 'bearer' : 'basic')}`);
    if (withSecrets) { const t = P.resolveSecret(context.jira.token); if (t) lines.push(`export JIRA_API_TOKEN=${shellQuote(t)}`); }
  }
  if (context.gitlab && want('gitlab')) {
    lines.push(`export GITLAB_HOST=${shellQuote(context.gitlab.host)}`);
    if (withSecrets) { const t = P.resolveSecret(context.gitlab.token); if (t) lines.push(`export GITLAB_TOKEN=${shellQuote(t)}`); }
  }
  if (context.figma && want('figma') && withSecrets) {
    const t = P.resolveSecret(context.figma.token); if (t) lines.push(`export FIGMA_TOKEN=${shellQuote(t)}`);
  }
  return `${lines.join('\n')}\n`;
}

function describe(resolved) {
  const c = resolved.context;
  const parts = [];
  if (c.jira) parts.push(`jira ${c.jira.url}`);
  if (c.gitlab) parts.push(`gitlab ${c.gitlab.host}`);
  if (c.figma) parts.push('figma configured');
  if (c.git && c.git.email) parts.push(`git ${c.git.email}`);
  return parts.join(' | ') || 'no services configured';
}

function cmdCtx(args) {
  const sub = args[0] && !args[0].startsWith('--') ? args.shift() : 'show';
  const cwd = flag(args, '--cwd') || process.cwd();
  if (sub === 'init') {
    if (fs.existsSync(P.PROFILES_PATH)) { process.stdout.write(`profiles already at ${P.PROFILES_PATH}\n`); return; }
    fs.mkdirSync(path.dirname(P.PROFILES_PATH), { recursive: true });
    fs.copyFileSync(path.join(__dirname, '..', 'templates', 'profiles.example.json'), P.PROFILES_PATH);
    process.stdout.write(`created ${P.PROFILES_PATH}\nEdit it, store tokens with "exe secret set NAME", then run "exe setup all" and "exe doctor".\n`);
    return;
  }
  const profiles = P.loadProfiles();
  if (sub === 'list') {
    for (const [name, ctx] of Object.entries(profiles.contexts)) {
      const hosts = (ctx.match && ctx.match.remoteHosts) || [];
      process.stdout.write(`${name === profiles.default ? '*' : ' '} ${name.padEnd(14)} ${hosts.join(', ').padEnd(40)} ${describe({ context: ctx })}\n`);
    }
    return;
  }
  if (sub === 'use') {
    const name = args.shift();
    if (!name || !profiles.contexts[name]) die(`unknown context "${name || ''}". Known: ${Object.keys(profiles.contexts).join(', ')}`);
    const root = P.gitRoot(cwd) || cwd;
    const file = path.join(root, '.exe.json');
    fs.writeFileSync(file, `${JSON.stringify({ context: name }, null, 2)}\n`);
    process.stdout.write(`pinned ${root} to ${name} (${file})\n`);
    return;
  }
  const resolved = P.resolveContext(cwd, profiles);
  if (sub === 'env') {
    const only = flag(args, '--only');
    const withSecrets = !!flag(args, '--with-secrets');
    process.stdout.write(envExports(resolved, { withSecrets, only }));
    return;
  }
  if (sub === 'show') {
    if (flag(args, '--json')) {
      const { profiles: _p, ...rest } = resolved;
      process.stdout.write(`${JSON.stringify(rest, null, 2)}\n`);
    } else {
      process.stdout.write(`${resolved.name}  (${resolved.source})\n${describe(resolved)}\n`);
    }
    return;
  }
  die(`unknown ctx subcommand "${sub}"`, 2);
}

function printActions(actions) {
  for (const a of actions) process.stdout.write(`${a.action.padEnd(9)} ${a.context.padEnd(12)} ${a.detail}\n`);
}

function cmdSetup(args) {
  const dryRun = !!flag(args, '--dry-run');
  const what = args[0] || 'all';
  if (!['git', 'jira', 'glab', 'all'].includes(what)) die(`unknown setup target "${what}"`, 2);
  const profiles = P.loadProfiles();
  const actions = [];
  if (what === 'git' || what === 'all') actions.push(...S.setupGit(profiles, { dryRun }));
  if (what === 'jira' || what === 'all') actions.push(...S.setupJira(profiles, { dryRun }));
  if (what === 'glab') actions.push(...S.setupGlab(profiles, { dryRun }));
  printActions(actions);
  if (what === 'all') process.stdout.write('glab tokens are injected per command by the exe shim; run "exe setup glab" to also store them in glab for your own terminal.\n');
  if (actions.some((a) => a.action === 'fail')) process.exit(1);
}

async function cmdDoctor(args) {
  const { runDoctor, formatResults } = require('../lib/doctor');
  const only = flag(args, '--context');
  const json = !!flag(args, '--json');
  let profiles;
  try { profiles = P.loadProfiles(); } catch (err) { if (json) { process.stdout.write(JSON.stringify([{ context: '-', check: 'profiles', level: 'fail', text: err.message }])); } else { process.stdout.write(`fail  profiles  ${err.message}\n`); } process.exit(1); }
  const results = await runDoctor(profiles, { only });
  process.stdout.write(json ? `${JSON.stringify(results, null, 2)}\n` : `${formatResults(results)}\n`);
  process.exit(results.some((r) => r.level === 'fail') ? 1 : 0);
}

function cmdSecret(args) {
  const res = spawnSync('bash', [P.SECRETS_SH, ...args], { stdio: 'inherit' });
  process.exit(res.status === null ? 1 : res.status);
}

async function main(argv) {
  const args = [...argv];
  const cmd = args.shift();
  try {
    switch (cmd) {
      case 'ctx': return cmdCtx(args);
      case 'setup': return cmdSetup(args);
      case 'doctor': return cmdDoctor(args);
      case 'secret': return cmdSecret(args);
      case undefined: case '-h': case '--help': case 'help': return usage();
      default: die(`unknown command "${cmd}"`, 2);
    }
  } catch (err) {
    if (err instanceof P.ProfilesError) die(err.message);
    throw err;
  }
}

main(process.argv.slice(2));
