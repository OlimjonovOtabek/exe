#!/usr/bin/env node
'use strict';

// Run the deep usage analysis and deliver it.
//
//   analyze.js [--now] [--window five_hour|seven_day] [--hours N] [--reason TEXT]
//              [--dry] [--no-telegram] [--json]
//
//   --now          ignore the once-per-window cooldown
//   --window       which limit window to explain (default five_hour)
//   --hours        when no rate-limit data exists, look back this many hours (default 5)
//   --dry          print the prompt that would be sent and stop; no model call
//   --no-telegram  print only, do not send
//   --json         print the raw JSON report instead of markdown

const fs = require('fs');
const path = require('path');
const { STATE_DIR, ensureStateDir, readJson, writeJson, threshold } = require('../lib/config');
const { readSamples, predict, fmtMinutes, label } = require('../lib/samples');
const { aggregate } = require('../lib/aggregate');
const { runAnalysis, reportToMarkdown } = require('../lib/analyst');
const telegram = require('../lib/telegram');

function flag(args, name, withValue = false) {
  const i = args.indexOf(name);
  if (i === -1) return withValue ? null : false;
  const v = withValue ? args[i + 1] : true;
  args.splice(i, withValue ? 2 : 1);
  return v;
}

function limitsSnapshot(prediction) {
  const out = {};
  for (const [key, w] of Object.entries(prediction.windows)) {
    out[label(key)] = { used_percent: w.used, resets_in: fmtMinutes(w.minutesToReset), projected_full_in: w.etaMinutes !== null ? fmtMinutes(w.etaMinutes) : 'no trend yet', wall_before_reset: w.wallBeforeReset };
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const now = Date.now();
  const force = flag(args, '--now');
  const dry = flag(args, '--dry');
  const noTelegram = flag(args, '--no-telegram');
  const json = flag(args, '--json');
  const windowKey = flag(args, '--window', true) || 'five_hour';
  const hours = Number(flag(args, '--hours', true) || (windowKey === 'seven_day' ? 24 * 7 : 5));
  const reason = flag(args, '--reason', true) || 'requested by the user';

  ensureStateDir();
  const prediction = predict(readSamples(now - 2 * 3600 * 1000), now);
  const w = prediction.windows[windowKey];
  const span = windowKey === 'seven_day' ? 7 * 24 * 3600 * 1000 : 5 * 3600 * 1000;
  const sinceMs = w && w.resetsAt ? Math.min(now - 60 * 1000, w.resetsAt - span) : now - hours * 3600 * 1000;

  const stateFile = path.join(STATE_DIR, 'analysis-state.json');
  const state = readJson(stateFile, {});
  // guard.js marks the window "pending" when it launches this script; a completed entry has pending false.
  const cooldownKey = w && w.resetsAt ? String(w.resetsAt) : null;
  const prior = cooldownKey && state[windowKey] && state[windowKey].resetsAt === cooldownKey ? state[windowKey] : null;
  if (!force && prior && !prior.pending) {
    process.stdout.write(`analysis already ran for this ${label(windowKey)} window (resets ${fmtMinutes(w.minutesToReset)} from now); pass --now to run again\n`);
    return;
  }

  const summary = await aggregate({ sinceMs, untilMs: now });
  const limits = limitsSnapshot(prediction);
  const result = runAnalysis({ reason, limits, summary, dryRun: dry });
  if (dry) { process.stdout.write(result.prompt); return; }
  if (result.error) {
    if (cooldownKey) { state[windowKey] = { resetsAt: cooldownKey, at: now, pending: true, failedAt: now, error: result.error.slice(0, 200) }; writeJson(stateFile, state); }
    process.stderr.write(`exe-usage: ${result.error}\n`);
    if (!noTelegram && telegram.configured()) await telegram.sendMessage(`<b>exe usage analysis failed</b>\n${telegram.escapeHtml(result.error)}\nReason: ${telegram.escapeHtml(reason)}`);
    process.exit(1);
  }

  const markdown = reportToMarkdown(result.report, { reason, cost: result.cost });
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  const reportDir = path.join(STATE_DIR, 'reports');
  fs.mkdirSync(reportDir, { recursive: true });
  const mdFile = path.join(reportDir, `${stamp}.md`);
  fs.writeFileSync(mdFile, markdown);
  writeJson(path.join(reportDir, `${stamp}.json`), { reason, limits, summary, report: result.report, cost: result.cost });
  if (cooldownKey) { state[windowKey] = { resetsAt: cooldownKey, at: now, pending: false, report: mdFile }; writeJson(stateFile, state); }

  process.stdout.write(json ? `${JSON.stringify(result.report, null, 2)}\n` : markdown);

  if (!noTelegram && telegram.configured()) {
    const head = `<b>Claude usage: ${telegram.escapeHtml(result.report.headline)}</b>\n`;
    const sent = await telegram.sendMessage(`${head}${telegram.escapeHtml(result.report.telegram_text)}\n\nTrigger: ${telegram.escapeHtml(reason)}`);
    if (!sent.ok) process.stderr.write(`exe-usage: telegram sendMessage failed: ${JSON.stringify(sent.body).slice(0, 200)}\n`);
    await telegram.sendDocument(mdFile, 'Full report');
  }
}

main().catch((err) => { process.stderr.write(`exe-usage: ${err.stack || err}\n`); process.exit(1); });
