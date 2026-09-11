#!/usr/bin/env node
'use strict';

// Hook entry points for exe-usage. Each one reads the hook JSON on stdin, does the least
// work that gets the job done, and exits. Long work (the analysis) is spawned detached.
//
//   guard.js session-start          export EXE_USAGE_ROOT for the skills
//   guard.js stop                   burn-rate check; maybe start the analysis in the background
//   guard.js limit-hit              StopFailure(rate_limit): deterministic Telegram alert
//   guard.js notification <type>    quota_auto_resume_* and pager notifications

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { STATE_DIR, ensureStateDir, readJson, writeJson, threshold, get } = require('../lib/config');
const { readSamples, predict, shouldAnalyze, fmtMinutes, label } = require('../lib/samples');
const telegram = require('../lib/telegram');

function readInput() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch (_) { return {}; }
}

function stateFile(name) { return path.join(STATE_DIR, name); }

function launchAnalysis(reason, windowKey) {
  ensureStateDir();
  const log = fs.openSync(stateFile('analysis.log'), 'a');
  const child = spawn(process.execPath, [path.join(__dirname, 'analyze.js'), '--reason', reason, '--window', windowKey], { detached: true, stdio: ['ignore', log, log], env: process.env });
  child.unref();
}

function windowsText(prediction) {
  const parts = [];
  for (const [key, w] of Object.entries(prediction.windows)) {
    parts.push(`${label(key)}: ${Math.round(w.used)}% used, resets in ${fmtMinutes(w.minutesToReset)}${w.wallBeforeReset ? `, projected full in ${fmtMinutes(w.etaMinutes)}` : ''}`);
  }
  return parts.join('\n') || 'no rate-limit data (status line not active or not a Pro/Max plan)';
}

async function topConsumers(prediction) {
  const { aggregate } = require('../lib/aggregate');
  const now = Date.now();
  const w = prediction.windows.five_hour;
  const sinceMs = w && w.resetsAt ? w.resetsAt - 5 * 3600 * 1000 : now - 5 * 3600 * 1000;
  const s = await aggregate({ sinceMs, untilMs: now, withPlugins: false, withPxpipe: false });
  const models = Object.entries(s.byModel).sort((a, b) => b[1].output - a[1].output).slice(0, 3).map(([m, v]) => `${m.replace(/^claude-/, '')} ${v.outputSharePct}% of output`);
  const projects = Object.entries(s.byProject).slice(0, 2).map(([p, v]) => `${p} ${Math.round(v.output / 1000)}k out`);
  const big = s.largestToolResults[0];
  const lines = [];
  if (models.length) lines.push(`Models: ${models.join(', ')}`);
  if (projects.length) lines.push(`Projects: ${projects.join(', ')}`);
  lines.push(`Thinking ${s.totals.thinkingShareOfOutputPct}% of output, cache hits ${s.totals.cacheHitPct}% of input, subagents ${s.subagents.outputSharePct}% of output`);
  if (big) lines.push(`Largest tool result: ${big.tool}, ~${big.approxTokens} tokens in ${big.project || 'unknown project'}`);
  return lines.join('\n');
}

async function main() {
  const [event, arg] = process.argv.slice(2);
  if (process.env.EXE_ANALYST) return; // never react inside the analysis session itself
  const input = readInput();
  const now = Date.now();

  if (event === 'session-start') {
    if (process.env.CLAUDE_ENV_FILE) fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export EXE_USAGE_ROOT="${path.resolve(__dirname, '..')}"\n`);
    return;
  }

  if (event === 'stop') {
    const prediction = predict(readSamples(now - 60 * 60 * 1000), now);
    const decision = shouldAnalyze(prediction, threshold());
    if (!decision) return;
    ensureStateDir();
    const state = readJson(stateFile('analysis-state.json'), {});
    const w = prediction.windows[decision.window];
    const key = w && w.resetsAt ? String(w.resetsAt) : null;
    const prior = key && state[decision.window] && state[decision.window].resetsAt === key ? state[decision.window] : null;
    if (prior && !prior.pending) return; // once per window
    if (state.lastLaunch && now - state.lastLaunch < 30 * 60 * 1000) return; // a pending or failed run gets one retry per half hour
    state.lastLaunch = now;
    if (key) state[decision.window] = { resetsAt: key, at: now, pending: true };
    writeJson(stateFile('analysis-state.json'), state);
    launchAnalysis(decision.reason, decision.window);
    process.stdout.write(`exe-usage: ${decision.reason}. Analysis started in the background; the result goes to Telegram${telegram.configured() ? '' : ' once a bot is configured'} and to ${STATE_DIR}/reports.\n`);
    return;
  }

  if (event === 'limit-hit') {
    ensureStateDir();
    const state = readJson(stateFile('alerts.json'), {});
    if (state.lastLimitHit && now - state.lastLimitHit < 10 * 60 * 1000) return;
    state.lastLimitHit = now; writeJson(stateFile('alerts.json'), state);
    const prediction = predict(readSamples(now - 2 * 3600 * 1000), now);
    let consumers = '';
    try { consumers = await topConsumers(prediction); } catch (err) { consumers = `(could not read transcripts: ${err.message})`; }
    const when = new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const text = `<b>Claude usage limit hit at ${when}</b>\n${telegram.escapeHtml(windowsText(prediction))}\n\n${telegram.escapeHtml(consumers)}\n\nClaude Code ${get('pager') === 'on' ? 'will page you' : 'continues on its own'} at the reset when autoContinueAtUsageLimit is on. Run /why-limits after the reset for the full analysis.`;
    if (telegram.configured()) await telegram.sendMessage(text);
    else fs.appendFileSync(stateFile('alerts.log'), `${new Date(now).toISOString()} limit-hit (telegram not configured)\n${text}\n\n`);
    return;
  }

  if (event === 'notification') {
    const type = arg || input.notification_type || 'unknown';
    const message = input.message ? telegram.escapeHtml(String(input.message).slice(0, 500)) : '';
    let text = null;
    if (type === 'quota_auto_resume_fired') text = '<b>Claude resumed</b>: the usage limit reset and the task continues.';
    else if (type === 'quota_auto_resume_stale') text = '<b>Claude is waiting for you</b>: the limit reset while the machine slept. Press Enter in Claude Code to continue.';
    else if (type === 'quota_auto_resume_disabled') text = '<b>Claude stopped waiting</b> for the usage limit reset (autoContinueAtUsageLimit is off).';
    else if (type === 'pager') {
      if (get('pager') !== 'on') return;
      const state = readJson(stateFile('alerts.json'), {});
      if (state.lastPage && now - state.lastPage < 60 * 1000) return;
      state.lastPage = now; writeJson(stateFile('alerts.json'), state);
      text = `<b>Claude needs you</b>${message ? `: ${message}` : ''}`;
    }
    if (text && telegram.configured()) await telegram.sendMessage(text);
  }
}

main().catch((err) => { try { fs.appendFileSync(stateFile('guard.log'), `${new Date().toISOString()} ${err.stack || err}\n`); } catch (_) { /* nothing */ } });
