#!/usr/bin/env node
/*
 * Independent small-pool oracle for the experimental resource-route planner.
 * It intentionally does not import solver-core.js: agreement is evidence,
 * while shared code would only repeat the same mistake.
 */
import assert from 'node:assert/strict';
import { allocatePatterns, chooseFiniteHorizonChallenge, evaluateResourcePattern, OBSERVED_FIELD_KEYS, routeFrontier, strictMask as independentStrictMask, solveActivityExact } from './resource-route-core.mjs';

const FIELDS = ['b', 'a', 'r', 'nm', 'atk', 'def'];
const bit = (index) => 1 << index;
const popcount = (mask) => [...Array(6).keys()].filter((index) => mask & bit(index)).length;
assert.equal(OBSERVED_FIELD_KEYS[3], 'n', '提示揭示数值必须按实际等级／阶级／连接值分组');

function weakBorder(target, guess) {
  return target.b & 128 ? Boolean(target.b & guess.b & 127) : target.b === guess.b;
}
function weakMask(target, guess) {
  let mask = 0;
  if (weakBorder(target, guess)) mask |= 1;
  if (target.a === guess.a) mask |= 2;
  if (target.r === guess.r) mask |= 4;
  if (target.nm & guess.nm) mask |= 8;
  if (target.atk === guess.atk) mask |= 16;
  if (target.def === guess.def) mask |= 32;
  return mask;
}
function strictMask(target, guess) {
  const weak = weakMask(target, guess);
  return (weak & ~1) | (target.b === guess.b ? 1 : 0);
}
function exact(target, guess) { return strictMask(target, guess) === 63; }
function outcomeKey(target, guess) {
  const weak = weakMask(target, guess);
  return `${weak}|${strictMask(target, guess)}|${exact(target, guess) ? 1 : 0}|${weak & 1 ? target.b : ''}|${weak & 8 ? target.nm : ''}`;
}
function partition(items, keyOf) {
  const groups = new Map();
  for (const item of items) { const key = keyOf(item); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(item); }
  return groups;
}
function addDistribution(into, from, probability) {
  for (const [key, value] of from) into.set(key, (into.get(key) || 0) + value * probability);
}
function terminal({ solved, strict, hints, challenges }) {
  const key = `${solved ? 1 : 0}|${popcount(strict)}|${hints}|${challenges}`;
  return new Map([[key, 1]]);
}

// Evaluate a fixed adaptive policy. policy(state) returns {type:'hint'} or a
// challenge index. The result is the exact probability distribution of end
// states, not a scalar conversion between resources.
function evaluate({ cards, targets, hints, challenges, known = 0, strict = 0, policy }) {
  if (!targets.length || !challenges) return terminal({ solved:false, strict, hints, challenges });
  const action = policy({ targets, hints, challenges, known, strict });
  if (action?.type === 'hint' && hints > 0 && known !== 63) {
    const unknown = FIELDS.map((_, index) => index).filter((index) => !(known & bit(index)));
    const distribution = new Map();
    for (const field of unknown) {
      const groups = partition(targets, (target) => target[FIELDS[field]]);
      for (const subset of groups.values()) addDistribution(distribution,
        evaluate({ cards, targets:subset, hints:hints - 1, challenges, known:known | bit(field), strict, policy }),
        subset.length / targets.length / unknown.length);
    }
    return distribution;
  }
  if (action?.type !== 'challenge' || challenges <= 0) return terminal({ solved:false, strict, hints, challenges });
  const guess = cards[action.index];
  const groups = partition(targets, (target) => outcomeKey(target, guess));
  const distribution = new Map();
  for (const subset of groups.values()) {
    const target = subset[0], nextStrict = strict | strictMask(target, guess);
    const solved = exact(target, guess);
    const child = solved ? terminal({ solved:true, strict:nextStrict, hints, challenges:challenges - 1 })
      : evaluate({ cards, targets:subset, hints, challenges:challenges - 1, known:known | weakMask(target, guess), strict:nextStrict, policy });
    addDistribution(distribution, child, subset.length / targets.length);
  }
  return distribution;
}
function summary(distribution, startHints, startChallenges) {
  const result = { solve:0, matches:0, hints:0, challenges:0, mass:0 };
  for (const [key, probability] of distribution) {
    const [solved, matches, hints, challenges] = key.split('|').map(Number);
    result.mass += probability; result.solve += solved * probability; result.matches += matches * probability;
    result.hints += (startHints - hints) * probability; result.challenges += (startChallenges - challenges) * probability;
  }
  return result;
}

// Distinct only in the pendulum bit of the border. The game may light the
// effect component, but it must not mark a strict border match or solve.
const cards = [
  { name:'普通效果', b:2, a:1, r:1, n:0, nm:1, atk:1000, def:1000 },
  { name:'效果灵摆', b:130, a:1, r:1, n:0, nm:1, atk:1000, def:1000 },
  { name:'不同属性', b:2, a:2, r:1, n:0, nm:1, atk:1000, def:1000 },
];
assert.equal(weakMask(cards[1], cards[0]) & 1, 1, '灵摆目标应点亮共有边框组成');
assert.equal(strictMask(cards[1], cards[0]) & 1, 0, '灵摆目标与非灵摆挑战不得严格匹配边框');
assert.equal(weakMask(cards[0], cards[1]) & 1, 0, '官方特殊规则仅在目标为灵摆卡时适用，反向不应自动点亮');
assert.equal(strictMask(cards[0], cards[1]) & 1, 0, '非灵摆目标与灵摆挑战不得严格匹配边框');
assert.equal(exact(cards[1], cards[0]), false, '六项点亮但完整边框不同不得通关');
assert.notEqual(outcomeKey(cards[0], cards[0]), outcomeKey(cards[1], cards[0]), '边框点亮时完整目标边框必须保留为不同反馈分支');
assert.equal(exact(cards[0], cards[0]), true, '完全相同卡必须通关');

const alwaysFirst = () => ({ type:'challenge', index:0 });
const first = summary(evaluate({ cards, targets:cards, hints:0, challenges:1, policy:alwaysFirst }), 0, 1);
assert.equal(first.mass, 1, '概率质量必须守恒');
assert.equal(first.solve, 1 / 3, '严格通关率必须只包含真正同边框目标');
assert.equal(first.challenges, 1, '挑战消耗必须精确为一次');

const hintThenChallenge = (state) => state.hints ? { type:'hint' } : { type:'challenge', index:0 };
const hinted = summary(evaluate({ cards, targets:cards, hints:1, challenges:1, policy:hintThenChallenge }), 1, 1);
assert.equal(hinted.mass, 1, '随机提示后的分支概率必须守恒');
assert.equal(hinted.hints, 1, '提示消耗必须精确为一次');
assert.equal(hinted.challenges, 1, '提示后挑战消耗必须精确为一次');

// The planner's independently implemented semantics must agree with this
// oracle on the pendulum case, and every frontier profile must conserve mass.
assert.equal(independentStrictMask(cards[1], cards[0]) & 1, 0, '规划器严格边框语义必须与独立判定一致');
const frontier = routeFrontier({ cards, candidates:[0,1,2], hints:1, challenges:2, depth:3 });
assert.ok(frontier.length >= 1, '路线前沿不能为空');
for (const profile of frontier) assert.ok(Math.abs(profile.summary.mass - 1) < 1e-10, '前沿策略必须概率守恒');
for (const profile of frontier) {
  assert.ok(profile.summary.hintUse <= 1 + 1e-10, '提示消耗不得超过库存');
  assert.ok(profile.summary.challengeUse <= 2 + 1e-10, '挑战消耗不得超过库存');
}
const oneChallenge = solveActivityExact({ cards, universe:[0,1,2], puzzles:1, hints:0, challenges:1 });
const twoChallenges = solveActivityExact({ cards, universe:[0,1,2], puzzles:1, hints:0, challenges:2 });
const hintAndChallenge = solveActivityExact({ cards, universe:[0,1,2], puzzles:1, hints:1, challenges:1 });
const routeBudgetExact = solveActivityExact({ cards, universe:[0,1,2], puzzles:1, hints:1, challenges:2 });
const weighted = solveActivityExact({ cards, universe:[0,1,2], puzzles:1, hints:0, challenges:1, weights:[1,2,1] });
const noChallenge = solveActivityExact({ cards, universe:[0,1,2], puzzles:1, hints:9, challenges:0 });
const permutedCards = [cards[2],cards[0],cards[1]];
const permuted = solveActivityExact({ cards:permutedCards, universe:[0,1,2], puzzles:1, hints:0, challenges:1, weights:[1,1,2] });
assert.ok(twoChallenges.value[0] >= oneChallenge.value[0] - 1e-10, '增加挑战库存不得降低精确活动价值');
assert.ok(twoChallenges.value[1] >= oneChallenge.value[1] - 1e-10, '增加挑战库存不得降低最终相符收益');
assert.equal(oneChallenge.reporting[0], '负挑战消耗', '资源维度必须单独保留为报告项');
assert.ok(hintAndChallenge.rootActionValues.some((item) => item.action.type === 'hint'), '提示必须进入与挑战相同的根行动比较');
assert.ok(hintAndChallenge.rootActionValues.some((item) => item.action.type === 'challenge'), '挑战必须进入与提示相同的根行动比较');
assert.ok(Math.abs(weighted.value[0] - .5) < 1e-10, '行为组后验必须按实体卡权重计算，而不是按组数等概率');
assert.equal(weighted.action.type, 'challenge', '只有挑战可用时根行动必须为挑战');
assert.equal(noChallenge.value[0], 0, '挑战为零时提示不能单独完成题目');
assert.equal(noChallenge.action.type, 'stop', '挑战为零时应停止而非浪费提示');
assert.ok(Math.abs(permuted.value[0]-weighted.value[0])<1e-10, '重排卡片与对应权重不得改变最优价值');
assert.throws(() => solveActivityExact({ cards, universe:[0,1,2], puzzles:1, hints:1, challenges:2, maxStates:1 }), /RESOURCE_ROUTE_STATE_LIMIT/, '状态预算必须可控地中止');
const patterns=['11','011','101'].map(pattern=>evaluateResourcePattern({cards,candidates:[0,1,2],pattern,actions:[0,1,2]}));
for(const route of patterns){assert.ok(Math.abs(route.summary.mass-1)<1e-10,'资源路线终止分布必须概率守恒');assert.ok(route.summary.solve<=routeBudgetExact.value[0]+1e-10,'受限资源路线不得优于相同库存的无约束精确策略');}
assert.throws(()=>evaluateResourcePattern({cards,candidates:[0,1,2],pattern:'010'}),/RESOURCE_PATTERN_INVALID/,'路线最后一步必须为挑战');
const horizon=chooseFiniteHorizonChallenge({cards,candidates:[0,1,2],hints:1,challenges:2,actions:[0,1,2],depth:3});
assert.equal(horizon.action.type,'challenge','有限时域选卡器的根行动必须保持为挑战');
assert.ok(horizon.value[0]<=routeBudgetExact.value[0]+1e-10,'有限时域挑战值不得超过相同资源的精确基准');
const syntheticProfiles=[
  {pattern:'1',distribution:new Map([['1|6|0|0',.4],['0|2|0|0',.6]])},
  {pattern:'01',distribution:new Map([['1|6|0|0',.8],['0|3|0|0',.2]])},
];
assert.equal(allocatePatterns({profiles:syntheticProfiles,puzzles:2,hints:0,challenges:2}).pattern,'1','无提示库存时只能选择纯挑战路线');
assert.equal(allocatePatterns({profiles:syntheticProfiles,puzzles:2,hints:1,challenges:2}).pattern,'01','提示充足时应由动态规划选择高成功路线');
console.log(`路线前沿验证通过：${frontier.length} 条非支配策略`);
console.log('跨题精确基准通过', { oneChallenge:oneChallenge.value, twoChallenges:twoChallenges.value });

console.log('资源路线独立验证通过');
console.table([first, hinted]);
