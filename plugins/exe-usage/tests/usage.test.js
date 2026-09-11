'use strict';

// Run with: node --test "plugins/exe-usage/tests/*.test.js"
// Uses temporary directories only. No network, no model calls.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exe-usage-'));
process.env.EXE_STATE_DIR = path.join(tmp, 'state');
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
process.env.EXE_CONFIG_DIR = path.join(tmp, 'config');
process.env.EXE_USAGE_THRESHOLD_PERCENT = '50';

const config = require('../lib/config');
const S = require('../lib/samples');
const T = require('../lib/telegram');
const A = require('../lib/aggregate');
const { buildPrompt, compactSummary } = require('../lib/analyst');

test('config precedence: env override beats defaults', () => {
  assert.equal(config.threshold(), 50);
  assert.equal(config.get('analysis_model'), 'claude-fable-5-1');
  fs.mkdirSync(config.CONFIG_DIR, { recursive: true });
  fs.writeFileSync(config.CONFIG_FILE, JSON.stringify({ telegram_chat_id: '123' }));
  assert.equal(config.get('telegram_chat_id'), '123');
});

test('fromStatusLine extracts windows and context', () => {
  const s = S.fromStatusLine({ rate_limits: { five_hour: { used_percentage: 62, resets_at: 1800000000 }, seven_day: { used_percentage: 41, resets_at: 1800500000 } }, context_window: { used_percentage: 38 }, cost: { total_cost_usd: 0.53 }, model: { id: 'claude-fable-5-1' }, effort: { level: 'high' } }, 1000);
  assert.deepEqual(s.five_hour, { used: 62, resets_at: 1800000000 });
  assert.equal(s.context, 38); assert.equal(s.cost, 0.53); assert.equal(s.effort, 'high');
  assert.equal(S.fromStatusLine({}, 1).five_hour, null);
});

test('predict sees a wall before the reset and shouldAnalyze fires above the threshold', () => {
  const now = 10 * 60 * 60 * 1000;
  const resetsAt = Math.floor((now + 60 * 60 * 1000) / 1000); // reset in 60 minutes
  const samples = [];
  for (let m = 30; m >= 0; m -= 5) samples.push({ ts: now - m * 60000, five_hour: { used: 70 - m, resets_at: resetsAt }, seven_day: { used: 20, resets_at: resetsAt + 86400 } });
  const p = S.predict(samples, now);
  const w = p.windows.five_hour;
  assert.equal(w.used, 70);
  assert.ok(Math.abs(w.ratePerMinute - 1) < 1e-6, 'one percent per minute');
  assert.ok(Math.abs(w.etaMinutes - 30) < 1e-6);
  assert.equal(w.wallBeforeReset, true);
  assert.equal(p.windows.seven_day.wallBeforeReset, false);
  const d = S.shouldAnalyze(p, 60);
  assert.equal(d.window, 'five_hour');
  assert.match(d.reason, /projected to hit 100% in 30m/);
  assert.equal(S.shouldAnalyze(p, 80), null, 'below threshold, no trigger');
});

test('predict ignores samples from a previous window', () => {
  const now = 1e9;
  const samples = [
    { ts: now - 20 * 60000, five_hour: { used: 95, resets_at: 100 } },
    { ts: now - 10 * 60000, five_hour: { used: 5, resets_at: 200 } },
    { ts: now, five_hour: { used: 6, resets_at: 200 } },
  ];
  const w = S.predict(samples, now).windows.five_hour;
  assert.equal(w.samples, 2);
  assert.ok(w.ratePerMinute > 0 && w.ratePerMinute < 0.2);
});

test('appendSample throttles to one per minute and the status line renders', () => {
  const now = Date.now();
  assert.equal(S.appendSample({ ts: now, five_hour: { used: 10, resets_at: 1 } }), true);
  assert.equal(S.appendSample({ ts: now + 1000, five_hour: { used: 11, resets_at: 1 } }), false);
  const input = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 62, resets_at: Math.floor(now / 1000) + 4320 }, seven_day: { used_percentage: 41 } }, context_window: { used_percentage: 38 }, cost: { total_cost_usd: 0.5 }, model: { display_name: 'Claude Fable 5.1' }, effort: { level: 'high' } });
  const out = spawnSync('node', [path.join(__dirname, '..', 'statusline', 'statusline.js')], { input, encoding: 'utf8', env: { ...process.env, ANTHROPIC_BASE_URL: 'http://127.0.0.1:47821' } });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /Fable 5\.1·high/); assert.match(out.stdout, /5h 62%/); assert.match(out.stdout, /7d 41%/); assert.match(out.stdout, /ctx 38%/); assert.match(out.stdout, /px on/);
});

test('telegram helpers escape and truncate', () => {
  assert.equal(T.escapeHtml('<b>&'), '&lt;b&gt;&amp;');
  assert.ok(T.truncate('x'.repeat(5000)).length <= T.MAX_TEXT);
  assert.equal(T.configured(), false);
});

test('aggregate reads a transcript fixture', async () => {
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', '-home-me-app');
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const iso = (m) => new Date(now - m * 60000).toISOString();
  const lines = [
    { type: 'assistant', timestamp: iso(30), cwd: '/home/me/app', effort: 'high', sessionId: 's1', isSidechain: false, message: { model: 'claude-fable-5-1', usage: { input_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: 9000, output_tokens: 800, output_tokens_details: { thinking_tokens: 600 } }, content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: {} }] } },
    { type: 'user', timestamp: iso(29), cwd: '/home/me/app', sessionId: 's1', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'x'.repeat(12000) }] } },
    { type: 'assistant', timestamp: iso(20), cwd: '/home/me/app', effort: 'low', sessionId: 's1', isSidechain: true, message: { model: 'claude-sonnet-5', usage: { input_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 4000, output_tokens: 200, output_tokens_details: { thinking_tokens: 0 } } } },
    { type: 'assistant', timestamp: iso(600), cwd: '/home/me/app', sessionId: 's0', message: { model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 999 } } },
    'not json',
  ];
  fs.writeFileSync(path.join(dir, 's1.jsonl'), lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n'));
  const s = await A.aggregate({ sinceMs: now - 60 * 60000, untilMs: now, withPlugins: false, withPxpipe: false });
  assert.equal(s.window.messages, 2, 'the old message is outside the window');
  assert.equal(s.totals.output, 1000);
  assert.equal(s.totals.thinkingShareOfOutputPct, 60);
  assert.equal(s.totals.cacheHitPct, 92.8);
  assert.equal(s.byModel['claude-fable-5-1'].outputSharePct, 80);
  assert.equal(s.byEffort.low.output, 200);
  assert.equal(s.subagents.outputSharePct, 20);
  assert.equal(s.largestToolResults[0].tool, 'Bash');
  assert.equal(s.largestToolResults[0].approxTokens, 3000);
  assert.equal(s.byProject.app.turns, 2);
  const prompt = buildPrompt({ reason: 'test', limits: {}, summary: s });
  assert.match(prompt, /Summary of the current window/);
  assert.ok(prompt.length < 26000);
  const big = { ...s, largestToolResults: Array.from({ length: 50 }, () => ({ tool: 'Read', chars: 999999, approxTokens: 250000, project: 'p'.repeat(200), at: 'now' })) };
  assert.ok(compactSummary(big).largestToolResults.length <= 10);
});

test.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
