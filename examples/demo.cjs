'use strict';
// demo.cjs — write a few memories, edit a core block, watch recall rank them.
// Run: node examples/demo.cjs      (add a reranker: MEMORY_RERANKER=./examples/reranker-echo.cjs node examples/demo.cjs)
const M = require('../lib/memory.cjs');

M.coreSet('human', 'Ada — founder, ships fast, no fluff');
M.coreAppend('context', 'Working on the v2 launch this week.');

for (const t of ['the v2 launch shipped on the 14th, all green', 'the retro is next Tuesday', 'billing migration is still in review']) {
  M.remember(t, { kind: 'demo' });
}

(async () => {
  console.log('--- memoryPrompt() ---\n' + M.memoryPrompt() + '\n');
  const r = await M.recall('when did the launch ship', { k: 3 });
  console.log(`recall via=${r.via}` + (r.answer ? `\nanswer: ${r.answer}` : ''));
  console.log('top hit:', r.hits[0] ? r.hits[0].text : '(none)');
})();
