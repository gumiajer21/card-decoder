const assert = require('node:assert/strict');

require('../dist/solver-core.js');
const { matchMask, strictMatchMask, solveExact } = globalThis.DecoderSolver;

const effect = { b: 2, a: 1, r: 1, n: 4, nm: 1 << 4, atk: 1000, def: 1000 };
const effectPendulum = { ...effect, b: 2 | 128 };

assert.equal(matchMask(effect, effectPendulum), 63, '复合边框有交集时，游戏应点亮边框字段');
assert.equal(strictMatchMask(effect, effectPendulum), 62, '完整边框不同，不应计为严格边框相符');
assert.equal(strictMatchMask(effectPendulum, effectPendulum), 63, '完整边框一致时应六项严格相符');

const result = solveExact({
  cards: [effect, effectPendulum],
  weights: [1, 1],
  universe: [0, 1],
  actions: [1],
  config: { puzzles: 1, premiumPuzzles: 0, milestones: [], regularMatchPoints: 1 },
  puzzle: 1,
  hints: 0,
  challenges: 1,
  candidates: [0, 1],
  knownMask: 0,
  matchedMask: 0,
  guessed: [],
});

assert.equal(result.value[0], 0.5, '猜效果/灵摆不能把效果非灵摆错误判为全中');
console.log('solver-core tests passed');
