'use strict';

// Run with: node --test "bootstrap/tests/*.test.js"

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const script = path.join(__dirname, '..', 'merge-settings.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exe-merge-'));
const file = path.join(tmp, 'settings.json');

function run(...args) {
  const res = spawnSync('node', [script, file, ...args], { encoding: 'utf8' });
  return { status: res.status, out: res.stdout.trim(), err: res.stderr.trim() };
}

test('merge adds keys, keeps the rest, and is idempotent', () => {
  fs.writeFileSync(file, JSON.stringify({ model: 'claude-opus-5', env: { FOO: '1' }, permissions: { allow: ['Bash(ls)'] } }, null, 4));
  assert.equal(run('{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:47821"}}').out, 'changed');
  assert.equal(run('{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:47821"}}').out, 'unchanged');
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(s.env, { FOO: '1', ANTHROPIC_BASE_URL: 'http://127.0.0.1:47821' });
  assert.deepEqual(s.permissions, { allow: ['Bash(ls)'] });
  assert.equal(fs.readdirSync(tmp).filter((f) => f.startsWith('settings.json.bak-')).length, 1);
});

test('--remove deletes a nested key and reports the change', () => {
  assert.equal(run('--remove', 'env.ANTHROPIC_BASE_URL').out, 'changed');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).env, { FOO: '1' });
  assert.equal(run('--remove', 'env.ANTHROPIC_BASE_URL').out, 'unchanged');
  assert.equal(run('--remove', 'nope.deeper.key').out, 'unchanged');
});

test('a corrupted settings file is left alone and reported', () => {
  fs.writeFileSync(file, '{ not json');
  const r = run('{"a":1}');
  assert.equal(r.status, 3);
  assert.match(r.err, /not valid JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ not json');
});

test('a malformed patch is rejected before touching the file', () => {
  fs.writeFileSync(file, '{"keep":true}');
  assert.equal(run('{oops').status, 2);
  assert.equal(run('[1,2]').status, 2);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"keep":true}');
});

test('a missing file is created with its directories', () => {
  const nested = path.join(tmp, 'a', 'b', 'settings.json');
  const res = spawnSync('node', [script, nested, '{"statusLine":{"type":"command","command":"node x.js"}}'], { encoding: 'utf8' });
  assert.equal(res.stdout.trim(), 'changed');
  assert.deepEqual(JSON.parse(fs.readFileSync(nested, 'utf8')), { statusLine: { type: 'command', command: 'node x.js' } });
});

test.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
