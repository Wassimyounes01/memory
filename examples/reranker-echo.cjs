'use strict';
/*
 * reranker-echo.cjs — a zero-dependency example MEMORY_RERANKER.
 *
 * The contract Memory expects:
 *   module.exports = async function rerank(query, candidates, k)
 *   candidates: [{ ts, text, meta? }, ...]  (the keyword/recency prefilter's picks)
 *   returns:    { answer?: string, order?: number[] }   // order = 1-based indices, best first
 *
 * This example uses no LLM — it re-scores candidates by keyword overlap so you can see the
 * seam work with `MEMORY_RERANKER=./examples/reranker-echo.cjs`. To make recall genuinely
 * smart, replace the body with a call to any model, e.g.:
 *
 *   const numbered = candidates.map((c, i) => `[${i + 1}] (${c.ts}) ${c.text}`).join('\n');
 *   const reply = await yourLLM(`Answer the QUERY from these MEMORY entries, then output a
 *     final line "ORDER: <comma-separated entry numbers, most relevant first>".
 *     QUERY: ${query}\n\nMEMORY:\n${numbered}`);
 *   const m = reply.match(/ORDER:\s*([\d,\s]+)/i);
 *   return { answer: reply.replace(/ORDER:.*$/is, '').trim(),
 *            order: m ? m[1].split(',').map(n => parseInt(n, 10)).filter(Boolean) : [] };
 */
const STOP = new Set('the a an and or of to in on for with is are was were be been it this that as at by from we you i our your when did do does'.split(' '));
const tok = s => String(s).toLowerCase().match(/[a-z0-9]+/g)?.filter(w => w.length > 2 && !STOP.has(w)) || [];

module.exports = async function rerank(query, candidates, k = 5) {
  const q = new Set(tok(query));
  const scored = candidates.map((c, i) => {
    const t = new Set(tok(c.text));
    let overlap = 0; for (const w of q) if (t.has(w)) overlap++;
    return { i: i + 1, overlap, text: c.text };
  }).sort((a, b) => b.overlap - a.overlap);

  const order = scored.map(s => s.i).slice(0, k);
  const best = scored[0] && scored[0].overlap > 0 ? scored[0].text : '';
  const answer = best
    ? `Most relevant memory for "${query}": ${best}`
    : `No strongly matching memory found for "${query}".`;
  return { answer, order };
};
