'use strict';
/**
 * memory.cjs — a tiny, dependency-free memory layer for LLM agents.
 *
 * Two things live on disk, no vector DB / embedder / server required:
 *   STORAGE       core -> data/core-memory.json   (self-editing always-in-context blocks)
 *                 arch -> data/archival.jsonl      (append-only long-term log)
 *   INTELLIGENCE  recall() runs a keyword/recency prefilter that is useful on its own, and
 *                 — if you set MEMORY_RERANKER to an LLM adapter — hands the candidates to that
 *                 model to rerank and answer. No reranker? It degrades to keyword-only and
 *                 never throws.
 *
 * Shares the SAME files as python/memory.py (stdlib-only twin) — one source of truth.
 *
 * API:
 *   const M = require('./memory.cjs');
 *   M.coreSet('human', '...'); M.coreAppend('context', '...'); M.memoryPrompt();
 *   M.remember('Ada shipped the launch', { kind: 'event' });
 *   await M.recall('who shipped the launch', { k: 5 });   // -> { answer, hits, via }
 *
 * CLI: node lib/memory.cjs health | remember "..." | recall "query" [k]
 *      | core-get [name] | core-set <name> <val> | core-append <name> <val> | prompt
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIR = process.env.MEMORY_DATA_DIR
  ? path.resolve(process.env.MEMORY_DATA_DIR)
  : path.join(ROOT, 'data');
const CORE = path.join(DIR, 'core-memory.json');
const ARCH = path.join(DIR, 'archival.jsonl');
const STOP = new Set('the a an and or of to in on for with is are was were be been it this that as at by from we you i our your'.split(' '));

const safe = (fn, d) => { try { return fn(); } catch { return d; } };
const now = () => new Date().toISOString();
const ensure = () => { if (!fs.existsSync(DIR)) safe(() => fs.mkdirSync(DIR, { recursive: true })); };
const tok = s => String(s).toLowerCase().match(/[a-z0-9]+/g)?.filter(w => w.length > 2 && !STOP.has(w)) || [];

// ---------- CORE MEMORY (self-editing, always in context) ----------
// Neutral placeholders — overwrite them for your agent with coreSet().
const DEFAULT_BLOCKS = {
  persona: 'I am a helpful assistant. I keep my memory honest and up to date.',
  human: 'The person I work with. (Set this with coreSet("human", "...").)',
  context: '',
};
function loadCore() {
  const b = { ...DEFAULT_BLOCKS };
  Object.assign(b, safe(() => JSON.parse(fs.readFileSync(CORE, 'utf8')), {}));
  return b;
}
function saveCore(b) { ensure(); safe(() => { const t = CORE + '.tmp'; fs.writeFileSync(t, JSON.stringify(b, null, 2)); fs.renameSync(t, CORE); }); }
function coreGet(name) { const b = loadCore(); return name ? (b[name] || '') : b; }
function coreSet(name, value) { const b = loadCore(); b[name] = String(value); b._updated = now(); saveCore(b); return b[name]; }
function coreAppend(name, text, cap = 4000) { const b = loadCore(); const cur = b[name] || ''; b[name] = (cur + (cur ? '\n' : '') + String(text)).slice(-cap); b._updated = now(); saveCore(b); return b[name]; }
function memoryPrompt() { const b = loadCore(); return Object.entries(b).filter(([k, v]) => !k.startsWith('_') && v).map(([k, v]) => `<${k}>\n${v}\n</${k}>`).join('\n'); }

// ---------- ARCHIVAL (file-based, no vector DB) ----------
function remember(text, meta) { ensure(); const rec = { ts: now(), text: String(text) }; if (meta) rec.meta = meta; safe(() => fs.appendFileSync(ARCH, JSON.stringify(rec) + '\n')); return rec.ts; }
function allArchival() { return safe(() => fs.readFileSync(ARCH, 'utf8').split('\n').filter(Boolean).map(l => safe(() => JSON.parse(l), null)).filter(Boolean), []); }

function keywordHits(query, n) {
  const q = new Set(tok(query));
  const rows = allArchival();
  return rows.map((r, i) => {
    const t = new Set(tok(r.text));
    let overlap = 0; for (const w of q) if (t.has(w)) overlap++;
    return { r, score: overlap + 0.25 * (i / Math.max(1, rows.length)) };
  }).filter(x => x.score > 0 || q.size === 0).sort((a, b) => b.score - a.score).slice(0, n).map(x => x.r);
}

/**
 * Load the optional LLM reranker. Set env MEMORY_RERANKER to a module path that exports
 *   async rerank(query, candidates, k) -> { answer?: string, order?: number[] }
 * where `order` is 1-based candidate indices, most-relevant first. Returns null if unset
 * or unloadable, so recall silently falls back to keyword-only.
 */
function loadReranker() {
  const p = process.env.MEMORY_RERANKER;
  if (!p) return null;
  return safe(() => {
    const mod = require(path.isAbsolute(p) ? p : path.resolve(ROOT, p));
    const fn = typeof mod === 'function' ? mod : (mod && mod.rerank);
    return typeof fn === 'function' ? fn : null;
  }, null);
}

/**
 * recall — keyword/recency prefilter, then an optional LLM rerank+answer. Always resolves.
 * returns { answer, hits, via } where via = 'reranker' | 'keyword'.
 */
async function recall(query, { k = 5, rerank = true } = {}) {
  const candidates = keywordHits(query, Math.max(k, 12));
  if (!candidates.length) return { answer: '', hits: [], via: 'keyword' };
  const reranker = rerank ? loadReranker() : null;
  if (!reranker) return { answer: '', hits: candidates.slice(0, k), via: 'keyword' };
  try {
    const out = await reranker(query, candidates, k);
    let hits = candidates.slice(0, k);
    if (out && Array.isArray(out.order) && out.order.length) {
      const ordered = out.order
        .map(n => candidates[n - 1])
        .filter(Boolean)
        .slice(0, k);
      if (ordered.length) hits = ordered;
    }
    return { answer: out && out.answer ? String(out.answer).trim() : '', hits, via: 'reranker' };
  } catch (e) {
    return { answer: '', hits: candidates.slice(0, k), via: 'keyword', error: String(e.message || e) };
  }
}

function health() {
  return {
    ok: true,
    engine: process.env.MEMORY_RERANKER ? 'files+reranker' : 'files',
    reranker: process.env.MEMORY_RERANKER || null,
    data_dir: DIR,
    core_blocks: Object.keys(loadCore()).filter(k => !k.startsWith('_')),
    archival_count: allArchival().length,
  };
}

module.exports = { coreGet, coreSet, coreAppend, memoryPrompt, remember, recall, keywordHits, allArchival, health };

// CLI
if (require.main === module) {
  (async () => {
    const [cmd, a, b] = process.argv.slice(2);
    if (!cmd || cmd === 'health') return console.log(JSON.stringify(health(), null, 2));
    if (cmd === 'remember') return console.log(remember(a, { kind: 'cli' }));
    if (cmd === 'recall') return console.log(JSON.stringify(await recall(a, { k: b ? +b : 5 }), null, 2));
    if (cmd === 'core-get') return console.log(JSON.stringify(coreGet(a), null, 2));
    if (cmd === 'core-set') return console.log(coreSet(a, b));
    if (cmd === 'core-append') return console.log(coreAppend(a, b));
    if (cmd === 'prompt') return console.log(memoryPrompt());
    console.log('usage: health | remember <text> | recall <query> [k] | core-get [name] | core-set <name> <val> | core-append <name> <val> | prompt');
  })();
}
