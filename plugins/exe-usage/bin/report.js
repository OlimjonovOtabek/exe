#!/usr/bin/env node
'use strict';

// Markdown usage report from the local transcripts. No model call.
//
//   report.js [--days N | --hours N] [--json] [--telegram]

const fs = require('fs');
const path = require('path');
const { STATE_DIR } = require('../lib/config');
const { aggregate } = require('../lib/aggregate');
const { readSamples, predict, fmtMinutes, label } = require('../lib/samples');
const telegram = require('../lib/telegram');

function flag(args, name, withValue = false) {
  const i = args.indexOf(name);
  if (i === -1) return withValue ? null : false;
  const v = withValue ? args[i + 1] : true;
  args.splice(i, withValue ? 2 : 1);
  return v;
}

const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

function markdown(s, prediction) {
  const L = [];
  L.push(`# Claude Code usage, ${s.window.since.slice(0, 16)} to ${s.window.until.slice(0, 16)}`, '');
  for (const [key, w] of Object.entries(prediction.windows)) L.push(`- ${label(key)} window: ${Math.round(w.used)}% used, resets in ${fmtMinutes(w.minutesToReset)}${w.wallBeforeReset ? `, projected full in ${fmtMinutes(w.etaMinutes)}` : ''}`);
  L.push(`- ${s.window.messages} assistant messages in ${s.sessionsCount} sessions across ${s.window.transcripts} transcripts`, '');
  const t = s.totals;
  L.push('## Totals', '', `| Input fresh | Cache write | Cache read | Output | Thinking share | Cache hit |`, `|---|---|---|---|---|---|`, `| ${k(t.input)} | ${k(t.cacheCreate)} | ${k(t.cacheRead)} | ${k(t.output)} | ${t.thinkingShareOfOutputPct}% | ${t.cacheHitPct}% |`, '');
  L.push('## By model', '', '| Model | Output | Share | Input (all) | Messages |', '|---|---|---|---|---|');
  for (const [m, v] of Object.entries(s.byModel).sort((a, b) => b[1].output - a[1].output)) L.push(`| ${m} | ${k(v.output)} | ${v.outputSharePct}% | ${k(v.input + v.cacheCreate + v.cacheRead)} | ${v.messages} |`);
  L.push('', '## By effort', '', '| Effort | Output | Share | Thinking share |', '|---|---|---|---|');
  for (const [e, v] of Object.entries(s.byEffort).sort((a, b) => b[1].output - a[1].output)) L.push(`| ${e} | ${k(v.output)} | ${v.outputSharePct}% | ${v.thinkingShareOfOutputPct}% |`);
  L.push('', `Subagents: ${s.subagents.outputSharePct}% of output in ${s.subagents.messages} messages.`, '');
  if (Object.keys(s.byProject).length) {
    L.push('## By project', '', '| Project | Output | Turns | Sessions |', '|---|---|---|---|');
    for (const [p, v] of Object.entries(s.byProject)) L.push(`| ${p} | ${k(v.output)} | ${v.turns} | ${v.sessions} |`);
    L.push('');
  }
  if (s.longSessions.length) {
    L.push('## Long sessions', '', '| Project | Turns | Max context | Minutes |', '|---|---|---|---|');
    for (const x of s.longSessions) L.push(`| ${x.project || '?'} | ${x.turns} | ${k(x.maxContextTokens)} | ${x.minutes} |`);
    L.push('');
  }
  if (s.largestToolResults.length) {
    L.push('## Largest tool results', '', '| Tool | ~Tokens | Project | When |', '|---|---|---|---|');
    for (const x of s.largestToolResults) L.push(`| ${x.tool} | ${k(x.approxTokens)} | ${x.project || '?'} | ${x.at.slice(5, 16)} |`);
    L.push('');
  }
  if (s.plugins && s.plugins.length) {
    L.push('## Plugin context cost, every session', '', '| Plugin | Always-on tokens |', '|---|---|');
    for (const p of [...s.plugins].sort((a, b) => (b.alwaysOnTokens || 0) - (a.alwaysOnTokens || 0))) L.push(`| ${p.plugin} | ${p.alwaysOnTokens === null ? '?' : p.alwaysOnTokens} |`);
    L.push('');
  }
  if (s.pxpipe) {
    const p = s.pxpipe;
    const skipped = (p.skipReasons || []).map((r) => (Array.isArray(r) ? `${r[0]} ${r[1]}` : String(r))).join(', ');
    L.push('## pxpipe', '', `${p.compressed} of ${p.requests} requests compressed, ${k(p.savedTokens)} input tokens saved (${p.savedPct}% of the measured baseline).${skipped ? ` Skipped: ${skipped}.` : ''}`, '');
  }
  return `${L.join('\n')}\n`;
}

async function main() {
  const args = process.argv.slice(2);
  const days = Number(flag(args, '--days', true) || 0);
  const hours = Number(flag(args, '--hours', true) || 0);
  const json = flag(args, '--json');
  const toTelegram = flag(args, '--telegram');
  const now = Date.now();
  const sinceMs = now - (hours ? hours * 3600 * 1000 : (days || 7) * 24 * 3600 * 1000);
  const s = await aggregate({ sinceMs, untilMs: now });
  const prediction = predict(readSamples(now - 2 * 3600 * 1000), now);
  if (json) { process.stdout.write(`${JSON.stringify(s, null, 2)}\n`); return; }
  const md = markdown(s, prediction);
  process.stdout.write(md);
  if (toTelegram) {
    const dir = path.join(STATE_DIR, 'reports'); fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `usage-${new Date(now).toISOString().slice(0, 10)}.md`);
    fs.writeFileSync(file, md);
    const res = await telegram.sendDocument(file, `Claude Code usage report, last ${hours ? `${hours}h` : `${days || 7}d`}`);
    if (!res.ok) process.stderr.write(`telegram: ${JSON.stringify(res.body).slice(0, 200)}\n`);
  }
}

main().catch((err) => { process.stderr.write(`exe-usage: ${err.stack || err}\n`); process.exit(1); });
