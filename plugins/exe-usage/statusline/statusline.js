#!/usr/bin/env node
'use strict';

// Claude Code status line for exe. Reads the status JSON on stdin, prints one line, and
// records a rate-limit sample for the predictor. No child processes: it has to be fast.
//
//   Fable 5.1·high │ 5h 62% ↻1h12m │ 7d 41% │ ctx 38% │ $0.53 │ px on
//
// A "!" after a window means the burn rate projects 100% before the reset.

const fs = require('fs');
const { appendSample, fromStatusLine, readSamples, predict, fmtMinutes } = require('../lib/samples');
const { get } = require('../lib/config');

function main() {
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch (_) { input = {}; }
  const now = Date.now();
  const sample = fromStatusLine(input, now);
  try { appendSample(sample); } catch (_) { /* state dir not writable: still render */ }

  let prediction = { windows: {} };
  try { prediction = predict(readSamples(now - 60 * 60 * 1000), now); } catch (_) { /* ignore */ }

  const parts = [];
  const model = (input.model && (input.model.display_name || input.model.id)) || '';
  const effort = input.effort && input.effort.level ? `·${input.effort.level}` : '';
  if (model) parts.push(`${model.replace(/^Claude /, '')}${effort}`);

  const win = (key, name) => {
    const w = sample[key];
    if (!w) return null;
    const p = prediction.windows[key] || {};
    const reset = p.minutesToReset !== null && p.minutesToReset !== undefined ? ` ↻${fmtMinutes(p.minutesToReset)}` : '';
    const flag = p.wallBeforeReset ? '!' : '';
    return `${name} ${Math.round(w.used)}%${flag}${reset}`;
  };
  const five = win('five_hour', '5h'); if (five) parts.push(five);
  const seven = win('seven_day', '7d'); if (seven) parts.push(seven);
  if (!five && !seven) parts.push('limits n/a');

  if (sample.context !== null) parts.push(`ctx ${Math.round(sample.context)}%`);
  if (sample.cost !== null) parts.push(`$${sample.cost.toFixed(2)}`);
  const base = process.env.ANTHROPIC_BASE_URL || '';
  if (base.includes(`127.0.0.1:${get('pxpipe_port')}`) || base.includes(`localhost:${get('pxpipe_port')}`)) parts.push('px on');

  process.stdout.write(`${parts.join(' │ ')}\n`);
}

main();
