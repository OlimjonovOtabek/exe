'use strict';

// The deep analysis: a single headless Claude Code call with a compact JSON summary,
// structured output, and a strict cost guard.
//
// The call never goes through pxpipe (ANTHROPIC_BASE_URL is dropped), never persists a
// session (so it does not pollute the next analysis), sets EXE_ANALYST=1 so exe hooks stay
// quiet, and uses --bare only in api_key mode because bare mode reads no OAuth login.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { get } = require('./config');

const PROMPT_FILE = path.join(__dirname, '..', 'prompts', 'analyst.md');
const SCHEMA_FILE = path.join(__dirname, '..', 'schemas', 'report.schema.json');
const MAX_PROMPT_CHARS = 26000; // about 6.5k tokens

function compactSummary(summary) {
  const s = JSON.parse(JSON.stringify(summary));
  if (s.largestToolResults && s.largestToolResults.length > 10) s.largestToolResults.length = 10;
  if (s.longSessions && s.longSessions.length > 5) s.longSessions.length = 5;
  if (s.plugins && s.plugins.length > 12) s.plugins.length = 12;
  if (s.byProject && Object.keys(s.byProject).length > 8) s.byProject = Object.fromEntries(Object.entries(s.byProject).slice(0, 8));
  const shrink = () => {
    if (s.largestToolResults && s.largestToolResults.length > 5) s.largestToolResults.length = 5;
    else if (s.byProject && Object.keys(s.byProject).length > 4) s.byProject = Object.fromEntries(Object.entries(s.byProject).slice(0, 4));
    else if (s.plugins && s.plugins.length > 8) s.plugins.length = 8;
    else if (s.longSessions && s.longSessions.length > 2) s.longSessions.length = 2;
    else return false;
    return true;
  };
  while (JSON.stringify(s).length > MAX_PROMPT_CHARS - 3000 && shrink()) { /* trim until it fits */ }
  return s;
}

function buildPrompt({ reason, limits, summary }) {
  const base = fs.readFileSync(PROMPT_FILE, 'utf8').trim();
  return `${base}\n\n## Why this analysis runs now\n${reason || 'requested by the user'}\n\n## Live limit state\n${JSON.stringify(limits || {}, null, 0)}\n\n## Summary of the current window\n${JSON.stringify(compactSummary(summary), null, 0)}\n`;
}

function runAnalysis({ reason, limits, summary, dryRun = false }) {
  const prompt = buildPrompt({ reason, limits, summary });
  if (dryRun) return { prompt, dryRun: true };
  const schema = fs.readFileSync(SCHEMA_FILE, 'utf8');
  const auth = get('analysis_auth');
  const args = ['-p', '--model', get('analysis_model'), '--effort', get('analysis_effort'), '--no-session-persistence', '--output-format', 'json', '--json-schema', schema, '--max-turns', '1'];
  const env = { ...process.env, EXE_ANALYST: '1' };
  delete env.ANTHROPIC_BASE_URL;
  if (auth === 'api_key') {
    const key = get('anthropic_api_key');
    if (!key) return { error: 'analysis_auth is api_key but no anthropic_api_key is configured' };
    env.ANTHROPIC_API_KEY = key;
    args.push('--bare');
  }
  const started = Date.now();
  const res = spawnSync('claude', args, { input: prompt, encoding: 'utf8', env, timeout: 10 * 60 * 1000, maxBuffer: 32 * 1024 * 1024 });
  if (res.error) return { error: `claude could not run: ${res.error.message}`, prompt };
  let out = null;
  try { out = JSON.parse(res.stdout); } catch (_) { out = null; }
  if (!out) return { error: `claude returned no JSON (exit ${res.status}): ${(res.stderr || res.stdout || '').trim().slice(0, 400)}`, prompt };
  if (out.is_error) return { error: `claude reported an error: ${String(out.result || '').slice(0, 400)}`, prompt, usage: out.usage };
  let report = out.structured_output || null;
  if (!report && typeof out.result === 'string') { try { report = JSON.parse(out.result); } catch (_) { report = null; } }
  if (!report) return { error: 'claude answered without the expected JSON report', raw: String(out.result || '').slice(0, 800), prompt, usage: out.usage };
  return {
    report,
    prompt,
    cost: { usd: out.total_cost_usd || null, seconds: Math.round((Date.now() - started) / 1000), usage: out.usage || null, model: get('analysis_model'), effort: get('analysis_effort'), auth },
  };
}

function reportToMarkdown(report, meta = {}) {
  const lines = [`# Why the limit is going fast`, '', `**${report.headline}**`, '', '## Causes', ''];
  for (const c of report.causes || []) lines.push(`${c.rank}. **${c.cause}** (~${c.share_percent}%)`, `   ${c.evidence}`);
  lines.push('', '## Do today', '');
  for (const a of report.actions || []) lines.push(`- **${a.action}**: ${a.how} Expected: ${a.expected_saving}`);
  if (meta.reason) lines.push('', `Trigger: ${meta.reason}`);
  if (meta.cost) lines.push(`Analysis run: ${meta.cost.model} at ${meta.cost.effort} effort, ${meta.cost.seconds}s${meta.cost.usd ? `, $${meta.cost.usd.toFixed(2)} list price` : ''}, ${meta.cost.auth} auth.`);
  return `${lines.join('\n')}\n`;
}

module.exports = { buildPrompt, runAnalysis, reportToMarkdown, compactSummary, MAX_PROMPT_CHARS };
