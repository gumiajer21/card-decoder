(function (root) {
  'use strict';

  const FIELDS = [
    { key: 'border', bit: 1 }, { key: 'attribute', bit: 2 }, { key: 'race', bit: 4 },
    { key: 'number', bit: 8 }, { key: 'attack', bit: 16 }, { key: 'defense', bit: 32 },
  ];
  const ZERO = Object.freeze([0, 0, 0]);
  const EPSILON = 1e-11;

  function add(left, right) { return left.map((value, index) => value + right[index]); }
  function scale(value, probability) { return value.map((item) => item * probability); }
  function compare(left, right) {
    for (let index = 0; index < left.length; index += 1) {
      if (Math.abs(left[index] - right[index]) > EPSILON) return left[index] > right[index] ? 1 : -1;
    }
    return 0;
  }
  function maxVector(left, right) { return compare(left, right) >= 0 ? left : right; }

  function popcount(mask) {
    let count = 0;
    for (let value = mask & 63; value; value &= value - 1) count += 1;
    return count;
  }

  function fieldValue(card, fieldIndex) {
    return [card.b, card.a, card.r, card.n, card.atk, card.def][fieldIndex];
  }

  function matchMask(target, guess) {
    let mask = 0;
    if (target.b & guess.b) mask |= 1;
    if (target.a === guess.a) mask |= 2;
    if (target.r === guess.r) mask |= 4;
    if (target.nm & guess.nm) mask |= 8;
    if (target.atk === guess.atk) mask |= 16;
    if (target.def === guess.def) mask |= 32;
    return mask;
  }

  function thresholdGain(config, puzzle, beforeMask, afterMask) {
    const before = popcount(beforeMask);
    const after = popcount(afterMask);
    if (puzzle > config.premiumPuzzles) return Math.max(0, after - before) * config.regularMatchPoints;
    return config.milestones.reduce((sum, item) => sum + (before < item.matches && after >= item.matches ? item.points : 0), 0);
  }

  function rewardVector(config, puzzle, beforeMask, match, solved) {
    const gain = popcount(beforeMask | match) - popcount(beforeMask);
    return [solved ? 1 : 0, gain, -1];
  }

  function terminalPremium() { return 0; }

  function solveExact(options) {
    const cards = options.cards;
    const weights = options.weights || cards.map(() => 1);
    const universe = options.universe || cards.map((_, index) => index).filter((index) => weights[index] > 0);
    const actions = options.actions || universe;
    const config = options.config;
    const memo = new Map();
    const startMemo = new Map();
    let expandedStates = 0;
    const maxStates = options.maxStates || 250000;

    function mass(indices) { return indices.reduce((sum, index) => sum + weights[index], 0); }
    function stateKey(state) {
      return `${state.puzzle}|${state.hints}|${state.challenges}|${state.knownMask}|${state.matchedMask}|${state.candidates.join(',')}|${[...state.guessed].sort((a, b) => a - b).join(',')}`;
    }
    function initialValue(puzzle, hints, challenges) {
      if (puzzle > config.puzzles) return { value: [0, 0, 0], action: null, exact: true };
      if (challenges <= 0) return { value: [terminalPremium(config, puzzle), 0, 0], action: null, exact: true };
      const key = `${puzzle}|${hints}|${challenges}`;
      if (startMemo.has(key)) return startMemo.get(key);
      const total = mass(universe);
      let value = [...ZERO];
      for (let fieldIndex = 0; fieldIndex < FIELDS.length; fieldIndex += 1) {
        const partitions = new Map();
        for (const index of universe) {
          const observed = fieldValue(cards[index], fieldIndex);
          if (!partitions.has(observed)) partitions.set(observed, []);
          partitions.get(observed).push(index);
        }
        for (const subset of partitions.values()) {
          const probability = mass(subset) / total / FIELDS.length;
          const child = visit({ puzzle, hints, challenges, candidates: subset, knownMask: FIELDS[fieldIndex].bit, matchedMask: 0, guessed: new Set() });
          value = add(value, scale(child.value, probability));
        }
      }
      const result = { value, action: null, exact: true };
      startMemo.set(key, result);
      return result;
    }

    function visit(state) {
      if (state.puzzle > config.puzzles) return { value: [1, 0, 0], action: null, exact: true };
      if (state.challenges <= 0 || !state.candidates.length) return { value: [terminalPremium(config, state.puzzle), 0, 0], action: null, exact: true };
      const key = stateKey(state);
      if (memo.has(key)) return memo.get(key);
      expandedStates += 1;
      if (expandedStates > maxStates) throw new Error(`EXACT_STATE_LIMIT:${maxStates}`);
      const total = mass(state.candidates);
      let best = null;

      if (state.hints > 0 && state.knownMask !== 63) {
        const unknown = FIELDS.map((field, index) => ({ ...field, index })).filter((field) => !(state.knownMask & field.bit));
        let hintValue = [...ZERO];
        for (const field of unknown) {
          const partitions = new Map();
          for (const index of state.candidates) {
            const observed = fieldValue(cards[index], field.index);
            if (!partitions.has(observed)) partitions.set(observed, []);
            partitions.get(observed).push(index);
          }
          for (const subset of partitions.values()) {
            const probability = mass(subset) / total / unknown.length;
            const child = visit({ ...state, hints: state.hints - 1, candidates: subset, knownMask: state.knownMask | field.bit, guessed: new Set(state.guessed) });
            hintValue = add(hintValue, scale(child.value, probability));
          }
        }
        hintValue[2] -= 1;
        best = { value: hintValue, action: { type: 'hint' }, optimalActions: [{ type: 'hint' }], exact: true };
      }

      for (const guessIndex of actions) {
        if (state.guessed.has(guessIndex)) continue;
        const outcomes = new Map();
        for (const targetIndex of state.candidates) {
          const target = cards[targetIndex];
          const match = matchMask(target, cards[guessIndex]);
          const keyPart = `${match}|${match & 1 ? target.b : ''}|${match & 8 ? target.n : ''}`;
          if (!outcomes.has(keyPart)) outcomes.set(keyPart, { match, targets: [] });
          outcomes.get(keyPart).targets.push(targetIndex);
        }
        let actionValue = [...ZERO];
        for (const outcome of outcomes.values()) {
          const probability = mass(outcome.targets) / total;
          const solved = outcome.match === 63;
          let branch = rewardVector(config, state.puzzle, state.matchedMask, outcome.match, solved);
          if (solved) {
            branch = add(branch, initialValue(state.puzzle + 1, state.hints, state.challenges - 1).value);
          } else {
            const guessed = new Set(state.guessed);
            guessed.add(guessIndex);
            const child = visit({
              ...state,
              challenges: state.challenges - 1,
              candidates: outcome.targets,
              knownMask: state.knownMask | outcome.match,
              matchedMask: state.matchedMask | outcome.match,
              guessed,
            });
            branch = add(branch, child.value);
          }
          actionValue = add(actionValue, scale(branch, probability));
        }
        const action = { type: 'challenge', index: guessIndex };
        const candidate = { value: actionValue, action, optimalActions: [action], exact: true };
        if (!best || compare(candidate.value, best.value) > 0) best = candidate;
        else if (compare(candidate.value, best.value) === 0) best.optimalActions.push(action);
      }
      memo.set(key, best);
      return best;
    }

    const initialState = {
      puzzle: options.puzzle,
      hints: options.hints,
      challenges: options.challenges,
      candidates: [...options.candidates].sort((a, b) => a - b),
      knownMask: options.knownMask || 0,
      matchedMask: options.matchedMask || 0,
      guessed: new Set(options.guessed || []),
    };
    const result = visit(initialState);
    return { ...result, expandedStates, memoStates: memo.size, objective: ['预期解题数', '预期首次相符项数', '负预期行动数'] };
  }

  function stateUpperBound({ config, puzzle, challenges }) {
    const remaining = Math.max(0, config.puzzles - puzzle + 1);
    const solvable = Math.min(remaining, Math.max(0, challenges));
    let regular = 0;
    for (let q = puzzle; q < puzzle + solvable; q += 1) {
      if (q > config.premiumPuzzles) regular += 6 * config.regularMatchPoints + config.regularSolvePoints;
    }
    return [solvable, 6 * solvable, 0];
  }

  function solveRestrictedHorizon(options) {
    const cards = options.cards, weights = options.weights, actions = options.actions;
    const maxDepth = options.depth || 3, maxStates = options.maxStates || 40000;
    const remainingPuzzles = Math.max(1, options.remainingPuzzles || 1);
    const resourceModel = options.resourceModel || { hintChallengeRatio: 0.61, equivalentCostPerSolve: 3.9 };
    const memo = new Map(); let expandedStates = 0;
    const mass = (indices) => indices.reduce((sum, index) => sum + weights[index], 0);
    function continuationValue(hints, challenges) {
      const future = remainingPuzzles - 1;
      if (future <= 0 || challenges <= 0) return [...ZERO];
      const equivalent = challenges + resourceModel.hintChallengeRatio * Math.max(0, hints);
      const solved = Math.min(future, challenges, equivalent / resourceModel.equivalentCostPerSolve);
      return [solved, solved * 6, 0];
    }
    function visit(state, depth) {
      if (depth <= 0 || !state.candidates.length || (!state.hints && !state.challenges)) return { value: [...ZERO], action: { type: 'stop' } };
      const key = `${depth}|${state.hints}|${state.challenges}|${state.knownMask}|${state.matchedMask}|${state.candidates.join(',')}|${[...state.guessed].sort((a,b)=>a-b).join(',')}`;
      if (memo.has(key)) return memo.get(key);
      if (++expandedStates > maxStates) throw new Error(`HORIZON_STATE_LIMIT:${maxStates}`);
      const total = mass(state.candidates); let best = { value: [...ZERO], action: { type: 'stop' }, optimalActions: [{ type: 'stop' }] };
      function consider(value, action) {
        const order = compare(value, best.value);
        if (order > 0) best = { value, action, optimalActions: [action] };
        else if (order === 0) best.optimalActions.push(action);
      }
      if (state.hints > 0 && state.knownMask !== 63) {
        const unknown = FIELDS.map((field,index)=>({...field,index})).filter((field)=>!(state.knownMask&field.bit));
        let value = [...ZERO];
        for (const field of unknown) {
          const parts = new Map();
          for (const target of state.candidates) { const observed=fieldValue(cards[target],field.index); if(!parts.has(observed))parts.set(observed,[]); parts.get(observed).push(target); }
          for (const subset of parts.values()) value=add(value,scale(visit({...state,hints:state.hints-1,candidates:subset,knownMask:state.knownMask|field.bit,guessed:new Set(state.guessed)},depth-1).value,mass(subset)/total/unknown.length));
        }
        value[2]-=1;
        consider(value,{type:'hint'});
      }
      if (state.challenges > 0) for (const guessIndex of actions) {
        if(state.guessed.has(guessIndex))continue;
        const outcomes=new Map();
        for(const targetIndex of state.candidates){const match=matchMask(cards[targetIndex],cards[guessIndex]);const k=`${match}|${match&1?cards[targetIndex].b:''}|${match&8?cards[targetIndex].n:''}`;if(!outcomes.has(k))outcomes.set(k,{match,targets:[]});outcomes.get(k).targets.push(targetIndex);}
        let value=[...ZERO];
        for(const outcome of outcomes.values()){
          const p=mass(outcome.targets)/total,solved=outcome.match===63;
          let branch=rewardVector({},0,state.matchedMask,outcome.match,solved);
          if(solved) branch=add(branch,continuationValue(state.hints,state.challenges-1));
          else {const guessed=new Set(state.guessed);guessed.add(guessIndex);branch=add(branch,visit({...state,challenges:state.challenges-1,candidates:outcome.targets,knownMask:state.knownMask|outcome.match,matchedMask:state.matchedMask|outcome.match,guessed},depth-1).value);}
          value=add(value,scale(branch,p));
        }
        consider(value,{type:'challenge',index:guessIndex});
      }
      memo.set(key,best); return best;
    }
    const result=visit({hints:options.hints,challenges:options.challenges,candidates:[...options.candidates].sort((a,b)=>a-b),knownMask:options.knownMask||0,matchedMask:options.matchedMask||0,guessed:new Set(options.guessed||[])},maxDepth);
    return {...result,expandedStates,memoStates:memo.size,depth:maxDepth,method:'restricted-horizon'};
  }

  root.DecoderSolver = { FIELDS, add, scale, compare, maxVector, matchMask, solveExact, solveRestrictedHorizon, stateUpperBound };
})(typeof window !== 'undefined' ? window : globalThis);
