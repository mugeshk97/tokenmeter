'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Parses JSONL files and caches the extracted records per file (keyed on mtime+size),
 * so polling every minute only re-reads files that changed.
 */
class JsonlCache {
  constructor({ needle, extract, maxEntries = 2000 }) {
    this.needle = needle; // cheap substring filter before JSON.parse
    this.extract = extract; // (obj) => record | null
    this.cache = new Map();
    this.maxEntries = maxEntries;
  }

  async read(file, stat) {
    const key = `${stat.mtimeMs}:${stat.size}`;
    const cached = this.cache.get(file);
    if (cached && cached.key === key) return cached.records;
    const text = await fs.promises.readFile(file, 'utf8');
    const records = [];
    let start = 0;
    let hit = text.indexOf(this.needle);
    while (hit !== -1) {
      start = text.lastIndexOf('\n', hit) + 1;
      let end = text.indexOf('\n', hit);
      if (end === -1) end = text.length;
      {
        const line = text.slice(start, end).trim();
        if (line) {
          try {
            const rec = this.extract(JSON.parse(line));
            if (rec) records.push(rec);
          } catch {
            /* partial line while the CLI is writing; skip */
          }
        }
      }
      hit = text.indexOf(this.needle, end + 1);
    }
    if (this.cache.size > this.maxEntries) this.cache.clear();
    this.cache.set(file, { key, records });
    return records;
  }
}

/** Recursively list *.jsonl files under root modified since `sinceMs`. */
async function listJsonl(root, sinceMs, maxDepth = 6) {
  const out = [];
  async function walk(dir, depth) {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < maxDepth) {
          // Directory mtime changes when files are added, not when they are appended to,
          // so we cannot prune on it; just recurse.
          await walk(p, depth + 1);
        }
      } else if (e.isFile() && e.name.endsWith('.jsonl')) {
        try {
          const st = await fs.promises.stat(p);
          if (st.mtimeMs >= sinceMs) out.push({ file: p, stat: st });
        } catch {
          /* vanished */
        }
      }
    }
  }
  await walk(root, 0);
  return out;
}

function exists(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

module.exports = { JsonlCache, listJsonl, exists };
