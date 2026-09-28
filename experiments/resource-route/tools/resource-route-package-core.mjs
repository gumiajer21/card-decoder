import { OBSERVED_FIELD_KEYS, isExact, popcount, selectCoverageActions, strictMask, weakMask } from './resource-route-core.mjs';

const bit = (index) => 1 << index;
const mass = (indices, weights) => indices.reduce((sum, index) => sum + weights[index], 0);
const binaryEntropy=(probability)=>probability<=0||probability>=1?0:-probability*Math.log2(probability)-(1-probability)*Math.log2(1-probability);

export function selectDynamicActions({cards,active,candidates,weights,matchedMask=0,guessed=new Set(),limit=40}){
  const total=mass(candidates,weights),old=popcount(matchedMask),quick=[];
  for(const index of active){if(guessed.has(index))continue;let solve=0,newMatches=0;const bits=[0,0,0,0,0,0],guess=cards[index];for(const targetIndex of candidates){const target=cards[targetIndex],weight=weights[targetIndex],weak=weakMask(target,guess),strict=strictMask(target,guess);if(isExact(target,guess))solve+=weight;newMatches+=(popcount(matchedMask|strict)-old)*weight;for(let field=0;field<6;field+=1)if(weak&(1<<field))bits[field]+=weight;}quick.push({index,solve:solve/total,newMatches:newMatches/total,infoApprox:bits.reduce((sum,value)=>sum+binaryEntropy(value/total),0)});}
  const selected=new Set(),add=(items,count)=>{for(const item of items.slice(0,count)){if(selected.size>=limit)break;selected.add(item.index);}};
  add([...quick].sort((a,b)=>b.solve-a.solve||b.newMatches-a.newMatches),Math.min(20,limit));
  add([...quick].sort((a,b)=>b.infoApprox-a.infoApprox||b.solve-a.solve),Math.min(12,limit));
  [...candidates].sort((a,b)=>weights[b]-weights[a]||a-b).slice(0,12).forEach((index)=>{if(selected.size<limit)selected.add(index);});
  return [...selected];
}

export function enumeratePatterns(hints, challenges) {
  const out = [];
  function build(prefix, h, c) {
    if (!h && !c) {
      if (prefix.endsWith('1')) out.push(prefix);
      return;
    }
    if (h) build(`${prefix}0`, h - 1, c);
    if (c) build(`${prefix}1`, h, c - 1);
  }
  build('', hints, challenges);
  return out;
}

export function chooseGreedyChallenge({ cards, candidates, actions, guessed = new Set(), weights, cache, finalChallenge = false, metric='entropy' }) {
  const cacheKey = cache ? `${metric}|${finalChallenge ? 1 : 0}|${candidates.join(',')}|${[...guessed].sort((a, b) => a - b).join(',')}` : null;
  if (cacheKey && cache.has(cacheKey)) return cache.get(cacheKey);
  const total = mass(candidates, weights);
  if (finalChallenge) {
    const groups = new Map();
    for (const index of candidates) {
      const card = cards[index];
      const signature = `${card.b}|${card.a}|${card.r}|${card.nm}|${card.atk}|${card.def}`;
      if (!groups.has(signature)) groups.set(signature, { index, solve:0 });
      groups.get(signature).solve += weights[index];
    }
    const direct = [...groups.values()].filter((entry) => !guessed.has(entry.index)).sort((a, b) => b.solve - a.solve || a.index - b.index)[0];
    if (direct) {
      const result = { index:direct.index, score:[direct.solve / total, 0, 0] };
      if (cacheKey) cache.set(cacheKey, result);
      return result;
    }
  }
  let best = null;
  const usable = new Set(actions);
  [...candidates].sort((a, b) => weights[b] - weights[a] || a - b).slice(0, 24).forEach((index) => usable.add(index));
  for (const index of usable) {
    if (guessed.has(index)) continue;
    let solve = 0;
    let matches = 0;
    const outcomes = new Map();
    for (const targetIndex of candidates) {
      const target = cards[targetIndex];
      const probabilityMass = weights[targetIndex];
      const weak = weakMask(target, cards[index]);
      const strict = strictMask(target, cards[index]);
      if (isExact(target, cards[index])) solve += probabilityMass;
      matches += popcount(strict) * probabilityMass;
      const key = `${weak}|${strict}|${weak & 1 ? target.b : ''}|${weak & 8 ? target.nm : ''}`;
      outcomes.set(key, (outcomes.get(key) || 0) + probabilityMass);
    }
    let entropy = 0, collision = 0, worst = 0;
    for (const outcomeMass of outcomes.values()) {
      const probability = outcomeMass / total;
      entropy -= probability * Math.log2(probability);
      collision += probability * probability;
      worst = Math.max(worst, probability);
    }
    // A route with later challenges can exploit feedback, so partition quality
    // comes first. On the route's final challenge there is no later feedback
    // decision, hence direct solve probability correctly becomes primary.
    const hybrid = metric.startsWith('hybrid') ? Number(metric.slice(6) || 0) / 100 : 0;
    const partitionScore = metric==='collision' ? -collision : metric==='worst' ? -worst : entropy + hybrid * (matches / total / 6);
    const score = finalChallenge
      ? [solve / total, matches / total, entropy]
      : [partitionScore, solve / total, matches / total];
    const better = !best || score.findIndex((value, position) => Math.abs(value - best.score[position]) > 1e-12) >= 0
      && score[score.findIndex((value, position) => Math.abs(value - best.score[position]) > 1e-12)] > best.score[score.findIndex((value, position) => Math.abs(value - best.score[position]) > 1e-12)];
    if (better) best = { index, score };
  }
  if (cacheKey) cache.set(cacheKey, best);
  return best;
}

export function simulatePatternOnce({ cards, targetIndex, initialField, pattern, universe, actions, weights, random, choiceCache, metric='entropy' }) {
  const target = cards[targetIndex];
  let candidates = universe.filter((index) => cards[index][OBSERVED_FIELD_KEYS[initialField]] === target[OBSERVED_FIELD_KEYS[initialField]]);
  let knownMask = bit(initialField), matchedMask = 0;
  const guessed = new Set();
  let hintsUsed = 0, challengesUsed = 0;
  for (let position = 0; position < pattern.length; position += 1) {
    const symbol = pattern[position];
    if (symbol === '0') {
      const unknown = [0,1,2,3,4,5].filter((field) => !(knownMask & bit(field)));
      if (!unknown.length) continue;
      const field = unknown[Math.floor(random() * unknown.length)];
      knownMask |= bit(field);
      const value = target[OBSERVED_FIELD_KEYS[field]];
      candidates = candidates.filter((index) => cards[index][OBSERVED_FIELD_KEYS[field]] === value);
      hintsUsed += 1;
      continue;
    }
    const finalChallenge = !pattern.slice(position + 1).includes('1');
    const choice = chooseGreedyChallenge({ cards, candidates, actions, guessed, weights, cache:choiceCache, finalChallenge, metric });
    if (!choice) break;
    guessed.add(choice.index);
    challengesUsed += 1;
    const guess = cards[choice.index];
    if (isExact(target, guess)) return { solved: true, matches: 6, hintsUsed, challengesUsed };
    const observedWeak = weakMask(target, guess), observedStrict = strictMask(target, guess);
    knownMask |= observedWeak;
    matchedMask |= observedStrict;
    candidates = candidates.filter((index) => {
      const candidate = cards[index];
      const weak = weakMask(candidate, guess), strict = strictMask(candidate, guess);
      return weak === observedWeak && strict === observedStrict && !isExact(candidate, guess)
        && (!(weak & 1) || candidate.b === target.b)
        && (!(weak & 8) || candidate.nm === target.nm);
    });
  }
  return { solved: false, matches: popcount(matchedMask), hintsUsed, challengesUsed };
}

export function buildPackageProfiles({ cards, universe, weights, samples, maxHints = 3, maxChallenges = 6, actionLimit = 64, seed = 0x5041434b, metric='entropy' }) {
  let state = seed >>> 0;
  const random = () => { state = (1664525 * state + 1013904223) >>> 0; return state / 2 ** 32; };
  const total = mass(universe, weights);
  const sampleTarget = () => { let pick = random() * total; for (const index of universe) { pick -= weights[index]; if (pick < 0) return index; } return universe.at(-1); };
  const draws = Array.from({ length: samples }, () => ({ targetIndex: sampleTarget(), initialField: Math.floor(random() * 6), seed: Math.floor(random() * 2 ** 32), choiceCache:new Map() }));
  const { actions } = selectCoverageActions({ cards, weights, active: universe, candidates: universe, limit: actionLimit });
  const profiles = [];
  const trainingSamples=Math.max(1,Math.floor(samples/2)),validationSamples=Math.max(1,samples-trainingSamples);
  for (let hints = 0; hints <= maxHints; hints += 1) for (let challenges = 1; challenges <= maxChallenges; challenges += 1) {
    let best = null;
    for (const pattern of enumeratePatterns(hints, challenges)) {
      let trainSolved=0,trainMatches=0,solved = 0, matches = 0, hintUse = 0, challengeUse = 0;
      const distribution = new Map();
      for (let drawIndex=0;drawIndex<draws.length;drawIndex+=1) {
        const draw=draws[drawIndex];
        let local = draw.seed;
        const localRandom = () => { local = (1664525 * local + 1013904223) >>> 0; return local / 2 ** 32; };
        const result = simulatePatternOnce({ cards, universe, weights, actions, pattern, random: localRandom, targetIndex: draw.targetIndex, initialField: draw.initialField, choiceCache:draw.choiceCache, metric });
        if(drawIndex<trainingSamples){trainSolved+=result.solved?1:0;trainMatches+=result.matches;continue;}
        solved += result.solved ? 1 : 0; matches += result.matches; hintUse += result.hintsUsed; challengeUse += result.challengesUsed;
        const key = `${result.solved ? 1 : 0}|${result.matches}|${result.hintsUsed}|${result.challengesUsed}`;
        distribution.set(key, (distribution.get(key) || 0) + 1 / validationSamples);
      }
      const profile = { hints, challenges, pattern, trainingSolve:trainSolved/trainingSamples,trainingMatches:trainMatches/trainingSamples,solve: solved / validationSamples, matches: matches / validationSamples, hintUse: hintUse / validationSamples, challengeUse: challengeUse / validationSamples, distribution:[...distribution] };
      if (!best || profile.trainingSolve > best.trainingSolve + 1e-12 || (Math.abs(profile.trainingSolve - best.trainingSolve) <= 1e-12 && profile.trainingMatches > best.trainingMatches)) best = profile;
    }
    profiles.push(best);
  }
  return { samples, trainingSamples, validationSamples, seed, actionLimit, metric, profiles };
}

// A feasible lower-bound policy: reserve one complete resource package for the
// current puzzle. If that package fails, the activity cannot advance, so no
// future-puzzle value is credited. This makes the table conservative rather
// than assuming that a failed short route magically opens the next puzzle.
export function allocatePackages({ profiles, puzzles, hints, challenges }) {
  const memo = new Map();
  function visit(t, h, c) {
    if (t <= 0 || c <= 0) return { solved: 0, matches: 0, profile: null };
    const key = `${t}|${h}|${c}`;
    if (memo.has(key)) return memo.get(key);
    let best = { solved: 0, matches: 0, profile: null };
    for (const profile of profiles) {
      if (profile.hints > h || profile.challenges > c) continue;
      let solved=0,matches=0;
      const outcomes=profile.distribution || [[`1|6|${profile.hints}|${profile.challenges}`,profile.solve],[`0|${profile.matches}|${profile.hints}|${profile.challenges}`,1-profile.solve]];
      for(const [key,probability] of outcomes){const [didSolve,matched,usedHints,usedChallenges]=key.split('|').map(Number);if(didSolve){const future=visit(t-1,h-usedHints,c-usedChallenges);solved+=probability*(1+future.solved);matches+=probability*(6+future.matches);}else matches+=probability*matched;}
      const value = { solved, matches, profile };
      if (value.solved > best.solved + 1e-12 || (Math.abs(value.solved - best.solved) <= 1e-12 && value.matches > best.matches)) best = value;
    }
    memo.set(key, best);
    return best;
  }
  return { ...visit(puzzles, hints, challenges), table: memo };
}
