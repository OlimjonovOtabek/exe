#!/usr/bin/env node
// Deep-merge a JSON patch into a settings file without touching anything else in it.
//
//   merge-settings.js <file> '<json>'            merge an inline patch
//   merge-settings.js <file> --file patch.json   merge a patch from a file
//   merge-settings.js <file> --remove env.FOO    delete a dotted key path (repeatable)
//
// Objects merge recursively; arrays and scalars are replaced. Prints "changed" or
// "unchanged". When the file changes, the previous version is kept next to it as
// <file>.bak-<timestamp>. Safe to run repeatedly.

'use strict';

const fs = require('fs');
const path = require('path');

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function merge(base, patch) {
  const out = isObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(patch)) {
    out[key] = isObject(value) && isObject(out[key]) ? merge(out[key], value) : value;
  }
  return out;
}

function removePath(target, dotted) {
  const parts = dotted.split('.');
  let cursor = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (!isObject(cursor[parts[i]])) return;
    cursor = cursor[parts[i]];
  }
  delete cursor[parts[parts.length - 1]];
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    return keysA.length === keysB.length && keysA.every((key) => deepEqual(a[key], b[key]));
  }
  return false;
}

function usage() {
  console.error('usage: merge-settings.js <file> [<json-patch>] [--file patch.json] [--remove a.b.c]...');
  process.exit(2);
}

function main(argv) {
  const [file, ...rest] = argv;
  if (!file) usage();

  const parsePatch = (text, what) => {
    try { const v = JSON.parse(text); if (!isObject(v)) throw new Error('not an object'); return v; } catch (err) { console.error(`merge-settings: ${what} is not a JSON object: ${err.message}`); process.exit(2); }
  };
  let patch = {};
  const removals = [];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--file') {
      patch = merge(patch, parsePatch(fs.readFileSync(rest[++i], 'utf8'), rest[i]));
    } else if (arg === '--remove') {
      removals.push(rest[++i]);
    } else if (arg.startsWith('--')) {
      usage();
    } else {
      patch = merge(patch, parsePatch(arg, 'the inline patch'));
    }
  }

  let current = {};
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, 'utf8');
    if (raw.trim()) {
      try { current = JSON.parse(raw); } catch (err) { console.error(`merge-settings: ${file} is not valid JSON (${err.message}); fix it by hand, nothing was changed`); process.exit(3); }
    }
  }

  // Work on a deep copy so removals never touch the object we compare against.
  const next = merge(JSON.parse(JSON.stringify(current)), patch);
  for (const dotted of removals) removePath(next, dotted);

  if (deepEqual(current, next)) {
    console.log('unchanged');
    return;
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak-${Date.now()}`);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  fs.renameSync(tmp, file);
  console.log('changed');
}

main(process.argv.slice(2));
