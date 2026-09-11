'use strict';

// Rate-limit samples and the burn-rate predictor.
//
// The status line receives rate_limits.{five_hour,seven_day}.{used_percentage,resets_at}
// on Pro and Max plans. Each render appends a sample (at most one per minute) to
// samples.jsonl. The predictor looks at the samples of the current window (same
// resets_at), fits used% against time, and says whether the wall arrives before the reset.

const fs = require('fs');
const path = require('path');
const { STATE_DIR, ensureStateDir } = require('./config');

const SAMPLES_FILE = path.join(STATE_DIR, 'samples.jsonl');
const MIN_INTERVAL_MS = 60 * 1000;
const KEEP_MS = 8 * 24 * 3600 * 1000;

function readSamples(sinceMs = 0) {
  if (!fs.existsSync(SAMPLES_FILE)) return [];
  const out = [];
  for (const line of fs.readFileSync(SAMPLES_FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const s = JSON.parse(line); if (s.ts >= sinceMs) out.push(s); } catch (_) { /* skip a torn line */ }
  }
  return out;
}

function latestSample() {
  const all = readSamples(0);
  return all.length ? all[all.length - 1] : null;
}

// sample: { ts, five_hour: {used, resets_at}, seven_day: {used, resets_at}, cost, context, model, session }
function appendSample(sample) {
  ensureStateDir();
  const last = latestSample();
  if (last && sample.ts - last.ts < MIN_INTERVAL_MS) return false;
  fs.appendFileSync(SAMPLES_FILE, `${JSON.stringify(sample)}\n`);
  if (last && last.ts % 97 === 0) compact();
  return true;
}

function compact() {
  const keep = readSamples(Date.now() - KEEP_MS);
  fs.writeFileSync(SAMPLES_FILE, keep.map((s) => JSON.stringify(s)).join('\n') + (keep.length ? '\n' : ''));
}

function fromStatusLine(input, now = Date.now()) {
  const rl = input.rate_limits || {};
  const win = (w) => (w && typeof w.used_percentage === 'number') ? { used: w.used_percentage, resets_at: w.resets_at || null } : null;
  return {
    ts: now,
    five_hour: win(rl.five_hour),
    seven_day: win(rl.seven_day),
    cost: input.cost && typeof input.cost.total_cost_usd === 'number' ? input.cost.total_cost_usd : null,
    context: input.context_window && typeof input.context_window.used_percentage === 'number' ? input.context_window.used_percentage : null,
    model: input.model && (input.model.id || input.model.display_name) || null,
    effort: input.effort && input.effort.level || null,
    session: input.session_id || null,
  };
}

// Least-squares slope of used% per minute over samples of the same window.
function slopePerMinute(points) {
  if (points.length < 2) return null;
  const n = points.length;
  const mx = points.reduce((a, p) => a + p.x, 0) / n;
  const my = points.reduce((a, p) => a + p.y, 0) / n;
  let num = 0; let den = 0;
  for (const p of points) { num += (p.x - mx) * (p.y - my); den += (p.x - mx) ** 2; }
  if (den === 0) return null;
  return num / den;
}

// Returns per-window predictions for the latest sample.
function predict(samples, now = Date.now(), { lookbackMs = 45 * 60 * 1000, minSpanMs = 5 * 60 * 1000 } = {}) {
  const latest = samples.length ? samples[samples.length - 1] : null;
  if (!latest) return { latest: null, windows: {} };
  const windows = {};
  for (const key of ['five_hour', 'seven_day']) {
    const w = latest[key];
    if (!w) continue;
    const resetsAtMs = w.resets_at ? Number(w.resets_at) * 1000 : null;
    const minutesToReset = resetsAtMs ? Math.max(0, (resetsAtMs - now) / 60000) : null;
    const pts = samples
      .filter((s) => s[key] && s.ts >= now - lookbackMs && (!w.resets_at || s[key].resets_at === w.resets_at))
      .map((s) => ({ x: (s.ts - now) / 60000, y: s[key].used }));
    const span = pts.length >= 2 ? (pts[pts.length - 1].x - pts[0].x) * 60000 : 0;
    const rate = span >= minSpanMs ? slopePerMinute(pts) : null;
    const etaMinutes = rate && rate > 0 ? (100 - w.used) / rate : null;
    windows[key] = {
      used: w.used,
      resetsAt: resetsAtMs,
      minutesToReset,
      ratePerMinute: rate,
      etaMinutes,
      wallBeforeReset: etaMinutes !== null && minutesToReset !== null ? etaMinutes < minutesToReset : false,
      samples: pts.length,
    };
  }
  return { latest, windows };
}

function shouldAnalyze(prediction, thresholdPercent) {
  for (const [key, w] of Object.entries(prediction.windows)) {
    if (w.used >= 90) return { window: key, reason: `${label(key)} window at ${w.used.toFixed(0)}%` };
    if (w.used >= thresholdPercent && w.wallBeforeReset) {
      return { window: key, reason: `${label(key)} window at ${w.used.toFixed(0)}%, projected to hit 100% in ${fmtMinutes(w.etaMinutes)} with ${fmtMinutes(w.minutesToReset)} to the reset` };
    }
  }
  return null;
}

function label(key) { return key === 'five_hour' ? '5-hour' : '7-day'; }

function fmtMinutes(min) {
  if (min === null || min === undefined || !Number.isFinite(min)) return '?';
  const m = Math.max(0, Math.round(min));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d${h % 24}h`;
}

module.exports = { SAMPLES_FILE, readSamples, latestSample, appendSample, fromStatusLine, predict, shouldAnalyze, fmtMinutes, label, slopePerMinute };
