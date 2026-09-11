'use strict';

// Where did the tokens go? Scans the local Claude Code transcripts for a time window and
// produces a compact summary: by model, by effort, thinking share, cache hit ratio, the
// largest tool results, subagent share, long sessions, plus pxpipe savings and the
// always-on cost of installed plugins.
//
// The transcript format is internal to Claude Code and can change between versions; this
// reads only a few fields and ignores anything it does not recognise.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');
const { CLAUDE_DIR, STATE_DIR, readJson, writeJson, get } = require('./config');

function listTranscripts(sinceMs) {
  const root = path.join(CLAUDE_DIR, 'projects');
  const out = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        try { if (fs.statSync(full).mtimeMs >= sinceMs) out.push(full); } catch (_) { /* skip */ }
      }
    }
  };
  walk(root);
  return out;
}

function contentSize(content) {
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) return content.reduce((n, part) => n + (typeof part === 'string' ? part.length : part && typeof part.text === 'string' ? part.text.length : part && part.type === 'image' ? 4000 : 0), 0);
  return 0;
}

function bump(map, key, add) {
  const cur = map[key] || { input: 0, cacheCreate: 0, cacheRead: 0, output: 0, thinking: 0, messages: 0 };
  cur.input += add.input; cur.cacheCreate += add.cacheCreate; cur.cacheRead += add.cacheRead; cur.output += add.output; cur.thinking += add.thinking; cur.messages += 1;
  map[key] = cur;
}

async function scanFile(file, sinceMs, untilMs, acc) {
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const toolNames = new Map();
  for await (const line of rl) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch (_) { continue; }
    const ts = o.timestamp ? Date.parse(o.timestamp) : NaN;
    const msg = o.message || {};
    if (o.type === 'assistant') {
      if (Array.isArray(msg.content)) for (const b of msg.content) if (b && b.type === 'tool_use' && b.id) toolNames.set(b.id, b.name || 'tool');
      if (!(ts >= sinceMs && ts <= untilMs) || !msg.usage) continue;
      const u = msg.usage;
      const add = {
        input: u.input_tokens || 0,
        cacheCreate: u.cache_creation_input_tokens || 0,
        cacheRead: u.cache_read_input_tokens || 0,
        output: u.output_tokens || 0,
        thinking: (u.output_tokens_details && u.output_tokens_details.thinking_tokens) || 0,
      };
      const model = msg.model || 'unknown';
      bump(acc.byModel, model, add);
      bump(acc.byEffort, o.effort || 'unset', add);
      bump(acc.total, 'all', add);
      if (o.isSidechain) bump(acc.total, 'sidechain', add);
      const sid = o.sessionId || path.basename(file, '.jsonl');
      const s = acc.sessions[sid] || { cwd: o.cwd || null, turns: 0, maxContext: 0, output: 0, first: ts, last: ts, models: {} };
      s.turns += 1; s.output += add.output; s.maxContext = Math.max(s.maxContext, add.cacheRead + add.cacheCreate + add.input); s.last = Math.max(s.last, ts); s.first = Math.min(s.first, ts);
      s.models[model] = (s.models[model] || 0) + add.output;
      acc.sessions[sid] = s;
    } else if (o.type === 'user' && Array.isArray(msg.content)) {
      if (!(ts >= sinceMs && ts <= untilMs)) continue;
      for (const b of msg.content) {
        if (!b || b.type !== 'tool_result') continue;
        const size = contentSize(b.content);
        if (size < 2000) continue;
        acc.toolResults.push({ size, tool: toolNames.get(b.tool_use_id) || 'tool', cwd: o.cwd || null, ts, session: o.sessionId || null });
        if (acc.toolResults.length > 400) { acc.toolResults.sort((a, c) => c.size - a.size); acc.toolResults.length = 100; }
      }
    }
  }
}

// pxpipe stats --json is large; keep the handful of numbers that matter for the analysis.
function pxpipeStats() {
  const res = spawnSync('pxpipe', ['stats', '--json'], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] });
  if (res.status !== 0) return null;
  let raw;
  try { raw = JSON.parse(res.stdout); } catch (_) { return null; }
  const baseline = raw.baselineTokensTotal || 0;
  const saved = raw.savedTokensTotal || 0;
  return {
    requests: raw.total || 0,
    compressed: raw.compressed || 0,
    passthrough: raw.passthrough || 0,
    baselineTokens: baseline,
    actualTokens: raw.measuredActualTokensTotal || 0,
    savedTokens: saved,
    savedPct: baseline > 0 ? Math.round((saved / baseline) * 1000) / 10 : 0,
    skipReasons: Array.isArray(raw.skipReasons) ? raw.skipReasons.slice(0, 3) : [],
  };
}

function pluginCosts() {
  const cacheFile = path.join(STATE_DIR, 'plugin-costs.json');
  const cached = readJson(cacheFile, null);
  if (cached && Date.now() - cached.at < 24 * 3600 * 1000) return cached.plugins;
  const list = spawnSync('claude', ['plugin', 'list', '--json'], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] });
  let names = [];
  try { const parsed = JSON.parse(list.stdout); names = (Array.isArray(parsed) ? parsed : parsed.plugins || []).map((p) => p.id || p.name).filter(Boolean); } catch (_) { return cached ? cached.plugins : []; }
  const plugins = [];
  for (const name of names.slice(0, 25)) {
    const res = spawnSync('claude', ['plugin', 'details', name], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] });
    const m = /Always-on:\s*~?([\d,]+)\s*tok/.exec(res.stdout || '');
    plugins.push({ plugin: name, alwaysOnTokens: m ? Number(m[1].replace(/,/g, '')) : null });
  }
  try { writeJson(cacheFile, { at: Date.now(), plugins }); } catch (_) { /* ignore */ }
  return plugins;
}

function pct(part, whole) { return whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0; }

async function aggregate({ sinceMs, untilMs = Date.now(), withPlugins = true, withPxpipe = true } = {}) {
  const acc = { byModel: {}, byEffort: {}, total: {}, sessions: {}, toolResults: [] };
  const files = listTranscripts(sinceMs);
  for (const file of files) { try { await scanFile(file, sinceMs, untilMs, acc); } catch (_) { /* unreadable file */ } }
  const all = acc.total.all || { input: 0, cacheCreate: 0, cacheRead: 0, output: 0, thinking: 0, messages: 0 };
  const side = acc.total.sidechain || { output: 0, messages: 0 };
  const inputAll = all.input + all.cacheCreate + all.cacheRead;
  const sessions = Object.entries(acc.sessions).map(([id, s]) => ({ id, ...s, project: s.cwd ? path.basename(s.cwd) : null, minutes: Math.round((s.last - s.first) / 60000) }));
  const byProject = {};
  for (const s of sessions) { const k = s.project || 'unknown'; byProject[k] = byProject[k] || { output: 0, turns: 0, sessions: 0 }; byProject[k].output += s.output; byProject[k].turns += s.turns; byProject[k].sessions += 1; }
  acc.toolResults.sort((a, b) => b.size - a.size);
  const summary = {
    window: { since: new Date(sinceMs).toISOString(), until: new Date(untilMs).toISOString(), transcripts: files.length, messages: all.messages },
    totals: { ...all, inputAll, thinkingShareOfOutputPct: pct(all.thinking, all.output), cacheHitPct: pct(all.cacheRead, inputAll), freshInputPct: pct(all.input + all.cacheCreate, inputAll) },
    byModel: Object.fromEntries(Object.entries(acc.byModel).filter(([, v]) => v.output + v.input + v.cacheCreate + v.cacheRead > 0).map(([k, v]) => [k, { ...v, outputSharePct: pct(v.output, all.output), inputSharePct: pct(v.input + v.cacheCreate + v.cacheRead, inputAll) }])),
    byEffort: Object.fromEntries(Object.entries(acc.byEffort).map(([k, v]) => [k, { ...v, outputSharePct: pct(v.output, all.output), thinkingShareOfOutputPct: pct(v.thinking, v.output) }])),
    subagents: { outputSharePct: pct(side.output, all.output), messages: side.messages },
    byProject: Object.fromEntries(Object.entries(byProject).sort((a, b) => b[1].output - a[1].output).slice(0, 8)),
    longSessions: sessions.filter((s) => s.turns >= 80 || s.maxContext >= 150000).sort((a, b) => b.maxContext - a.maxContext).slice(0, 5).map((s) => ({ project: s.project, turns: s.turns, maxContextTokens: s.maxContext, minutes: s.minutes })),
    largestToolResults: acc.toolResults.slice(0, 10).map((t) => ({ tool: t.tool, chars: t.size, approxTokens: Math.round(t.size / 4), project: t.cwd ? path.basename(t.cwd) : null, at: new Date(t.ts).toISOString() })),
    sessionsCount: sessions.length,
  };
  if (withPxpipe) summary.pxpipe = pxpipeStats();
  if (withPlugins) summary.plugins = pluginCosts();
  return summary;
}

module.exports = { aggregate, listTranscripts, contentSize, pct };
