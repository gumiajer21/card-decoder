const assert = require('node:assert/strict');

require('../dist/solver-core.js');
const { matchMask, strictMatchMask, isExactAnswer, solveExact, solveRestrictedHorizon } = globalThis.DecoderSolver;

const effect = { b: 2, a: 1, r: 1, n: 4, nm: 1 << 4, atk: 1000, def: 1000 };
const effectPendulum = { ...effect, b: 2 | 128 };

assert.equal(matchMask(effectPendulum, effect), 63, '目标为灵摆卡时，命中组成边框应点亮边框字段');
assert.equal(matchMask(effect, effectPendulum), 62, '目标为非灵摆卡时，组合边框不应反向匹配');
assert.equal(strictMatchMask(effectPendulum, effect), 63, '六项点亮应保留六项相符收益');
assert.equal(isExactAnswer(effectPendulum, effect), false, '完整边框不同不能判定通关');
assert.equal(isExactAnswer(effectPendulum, effectPendulum), true, '完整边框一致时应判定通关');

const result = solveExact({
  cards: [effect, effectPendulum],
  weights: [1, 1],
  universe: [0, 1],
  actions: [1],
  config: { puzzles: 1, premiumPuzzles: 0, milestones: [], regularMatchPoints: 1 },
  puzzle: 1,
  hints: 0,
  challenges: 1,
  candidates: [1],
  knownMask: 0,
  matchedMask: 0,
  guessed: [],
});

assert.equal(result.action.index, 1, '已知灵摆目标时应选择能真正通关的完整边框行动');

const forced = solveExact({
  cards: [effect, effectPendulum],
  weights: [1, 1],
  universe: [0, 1],
  actions: [0, 1],
  forcedAction: { type: 'challenge', index: 0 },
  config: { puzzles: 1, premiumPuzzles: 0, milestones: [], regularMatchPoints: 1 },
  puzzle: 1,
  hints: 0,
  challenges: 1,
  candidates: [1],
  knownMask: 0,
  matchedMask: 0,
  guessed: [],
});

assert.equal(forced.action.index, 0, '固定首步后应只评估指定挑战卡');
assert.equal(forced.value[0], 0, '固定错误边框卡不应被计为通关');

const forcedRestricted = solveRestrictedHorizon({
  cards: [effect, effectPendulum], weights: [1, 1], actions: [0, 1],
  forcedAction: { type: 'challenge', index: 0 }, hints: 0, challenges: 1,
  candidates: [1], knownMask: 0, matchedMask: 0, guessed: [], depth: 2,
  remainingPuzzles: 1,
});
assert.equal(forcedRestricted.action.index, 0, '受限策略树也必须执行固定首步，不能改为停止或其他卡');
console.log('solver-core tests passed');
