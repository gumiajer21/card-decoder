#!/usr/bin/env node
/*
 * Build a resumable first-action reference library for Card Decoder.
 *
 * The reference is intentionally a canonical, depth-3 study rather than a
 * cache for every activity configuration.  It evaluates all legal hint
 * actions and a documented coverage set of challenge actions.  Physical cards
 * were already merged into behaviour groups by cards-data.js.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const scriptPath = fileURLToPath(import.meta.url);
const require = createRequire(import.meta.url);
const archiveRoot = path.resolve(path.dirname(scriptPath), '..');
const root = path.resolve(archiveRoot, '..', '..');
const dist = path.join(root, 'dist');
const outputPath = path.join(archiveRoot, 'runtime', 'first-action-reference.js');
const checkpointPath = path.join(archiveRoot, 'runtime', 'first-action-reference.partial.json');
// The interactive solver may use a smaller, user-selected state budget for
// responsiveness.  This offline library is deliberately more patient: the
// largest observed depth-3 initial states need over 460k expanded states.
const MODEL_VERSION = 'first-action-depth3-coverage-v6';
const COMPATIBLE_COMPLETE_MODELS = new Set(['first-action-depth3-coverage-v4', 'first-action-depth3-coverage-v5']);
const CANONICAL = { puzzles: 9, hints: 11, challenges: 36, depth: 3, budget: 1000000, pool: 'md' };

function loadRuntime() {
  globalThis.window = globalThis;
  require(path.join(dist, 'cards-data.js'));
  require(path.join(dist, 'solver-core.js'));
  return { cards: globalThis.CARD_DATA.cards, solver: globalThis.DecoderSolver };
}

function entropy(probability) {
  return probability > 0 && probability < 1 ? -probability * Math.log2(probability) - (1 - probability) * Math.log2(1 - probability) : 0;
}

function fieldDefinitions() {
  return [
    { key: 'border', bit: 1, value: (card) => card.b },
    { key: 'attribute', bit: 2, value: (card) => card.a },
    { key: 'race', bit: 4, value: (card) => card.r },
    // Initial reveals show the actual level/rank/link value (`n`). `nm` is a
    // challenge-matching bit mask and must never be used as a reveal key.
    { key: 'number', bit: 8, value: (card) => card.n },
    { key: 'attack', bit: 16, value: (card) => card.atk },
    { key: 'defense', bit: 32, value: (card) => card.def },
  ];
}

function objectiveCompare(solver, left, right) {
  return solver.compare(left, right);
}

function quickMetrics(cards, solver, active, candidates) {
  const total = candidates.reduce((sum, index) => sum + cards[index].wm, 0);
  const metrics = [];
  for (const index of active) {
    const guess = cards[index];
    let solve = 0;
    let matches = 0;
    const bitMass = [0, 0, 0, 0, 0, 0];
    for (const targetIndex of candidates) {
      const target = cards[targetIndex];
      const weight = target.wm;
      const mask = solver.matchMask(target, guess);
      if (solver.isExactAnswer(target, guess)) solve += weight;
      matches += popcount(mask) * weight;
      for (let bit = 0; bit < 6; bit += 1) if (mask & (1 << bit)) bitMass[bit] += weight;
    }
    metrics.push({
      index,
      solve: solve / total,
      newMatches: matches / total,
      infoApprox: bitMass.reduce((sum, mass) => sum + entropy(mass / total), 0),
      points: 0,
    });
  }
  return metrics;
}

function popcount(mask) {
  let count = 0;
  for (let value = mask & 63; value; value &= value - 1) count += 1;
  return count;
}

function coverageActions(cards, solver, candidates, metrics) {
  // Exact direct-action preservation is affordable for small posterior sets.
  // For larger sets the action space must be a transparent coverage sample;
  // 64 is deliberately close to the stable interactive search, while still
  // reserving slots for value-diverse probes.  A 160-action large-state set
  // made common EFFECT starts take many minutes even at a 500k state budget.
  const directLimit = candidates.length <= 128 ? candidates.length : 32;
  const maxActions = candidates.length <= 128 ? directLimit + 24 : 64;
  const selected = new Set([...candidates].sort((a, b) => cards[b].wm - cards[a].wm || a - b).slice(0, directLimit));
  const compareMetrics = (left, right) => {
    const result = objectiveCompare(solver, [left.solve, left.newMatches, left.infoApprox], [right.solve, right.newMatches, right.infoApprox]);
    return result || left.index - right.index;
  };
  const add = (index) => { if (selected.size < maxActions) selected.add(index); };
  const addTop = (sorter, count) => [...metrics].sort(sorter).slice(0, count).forEach((item) => add(item.index));
  const ranked = [...metrics].sort(compareMetrics);
  // Reserve the first probe slots for globally strong actions; remaining slots
  // are then distributed across target field values.
  addTop(compareMetrics, 10);
  addTop((a, b) => b.infoApprox - a.infoApprox || b.solve - a.solve || a.index - b.index, 8);
  const fieldCoverage = [];
  for (const field of fieldDefinitions()) {
    const masses = new Map();
    for (const index of candidates) masses.set(field.value(cards[index]), (masses.get(field.value(cards[index])) || 0) + cards[index].wm);
    fieldCoverage.push({ field, values:[...masses.entries()].sort((a,b)=>b[1]-a[1]).map(([value]) => value), cursor:0, total:masses.size, covered:new Set() });
  }
  // Round-robin prevents attack/defense (many values) from consuming every
  // probe slot before border, attribute, race and level get coverage.
  let progress = true;
  while (selected.size < maxActions && progress) {
    progress = false;
    for (const group of fieldCoverage) {
      if (selected.size >= maxActions || group.cursor >= group.values.length) continue;
      const value = group.values[group.cursor++];
      const representative = ranked.find((item) => group.field.value(cards[item.index]) === value);
      if (representative != null) { add(representative.index); group.covered.add(value); progress = true; }
    }
  }
  return {
    actions: [...selected],
    coverage: {
      directTotal: candidates.length,
      directIncluded: Math.min(candidates.length, directLimit),
      directComplete: candidates.length <= directLimit,
      fieldValueRepresentatives: fieldCoverage.reduce((sum, group) => sum + group.covered.size, 0),
      fieldValueTotal: fieldCoverage.reduce((sum, group) => sum + group.total, 0),
      totalActions: selected.size,
    },
  };
}

function runState(state) {
  const { cards, solver } = loadRuntime();
  const field = fieldDefinitions().find((item) => item.key === state.fieldKey);
  if (!field) throw new Error(`未知字段：${state.fieldKey}`);
  const active = cards.map((card, index) => card.wm > 0 ? index : -1).filter((index) => index >= 0);
  const candidates = active.filter((index) => field.value(cards[index]) === state.value);
  const started = performance.now();
  const metrics = quickMetrics(cards, solver, active, candidates);
  const { actions, coverage } = coverageActions(cards, solver, candidates, metrics);
  let result;
  try {
    result = solver.solveRestrictedHorizon({
      cards,
      weights: cards.map((card) => card.wm),
      actions,
      hints: CANONICAL.hints,
      challenges: CANONICAL.challenges,
      candidates,
      knownMask: field.bit,
      matchedMask: 0,
      guessed: [],
      depth: CANONICAL.depth,
      maxStates: CANONICAL.budget,
      remainingPuzzles: CANONICAL.puzzles,
      resourceModel: { hintChallengeRatio: 0.61, equivalentCostPerSolve: 3.9 },
    });
  } catch (error) {
    return { key: state.key, field: field.key, value: state.value, candidateGroups: candidates.length, status: 'error', error: String(error.message), elapsedMs: Math.round(performance.now() - started), coverage };
  }
  const ranked = (result.rootActionValues || []).sort((left, right) => solver.compare(right.value, left.value)).slice(0, 6).map((entry) => ({
    type: entry.action.type,
    index: entry.action.index ?? null,
    name: entry.action.type === 'challenge' ? cards[entry.action.index].name : '使用随机提示',
    value: entry.value.map((item) => Number(item.toFixed(8))),
  }));
  return {
    key: state.key,
    field: field.key,
    value: state.value,
    candidateGroups: candidates.length,
    candidateCards: candidates.reduce((sum, index) => sum + cards[index].wm, 0),
    status: result.expandedStates >= CANONICAL.budget ? 'budget-limit' : 'complete',
    expandedStates: result.expandedStates,
    memoStates: result.memoStates,
    elapsedMs: Math.round(performance.now() - started),
    best: ranked[0] || null,
    topActions: ranked,
    coverage,
  };
}

if (!isMainThread) {
  try { parentPort.postMessage({ type: 'result', result: runState(workerData.state) }); }
  catch (error) { parentPort.postMessage({ type: 'result', result: { key: workerData.state.key, status: 'error', error: String(error.stack || error) } }); }
} else {
  const args = process.argv.slice(2);
  const valueOf = (flag, fallback) => {
    const position = args.indexOf(flag);
    return position >= 0 ? Math.max(1, Number(args[position + 1]) || fallback) : fallback;
  };
  const workers = Math.min(valueOf('--workers', 4), 8);
  const onlyState = args.includes('--state') ? args[args.indexOf('--state') + 1] : null;
  const { cards } = loadRuntime();
  const active = cards.map((card, index) => card.wm > 0 ? index : -1).filter((index) => index >= 0);
  let checkpoint = { modelVersion: MODEL_VERSION, canonical: CANONICAL, generatedAt: null, states: {} };
  if (fs.existsSync(checkpointPath)) {
    const saved = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
    if (saved.modelVersion === MODEL_VERSION) checkpoint = saved;
    // A state that completed below the former cap is still exact for the same
    // depth, action coverage and resource model.  Keep it when only the cap
    // is raised; bounded/error states are deliberately recalculated.
    else if (COMPATIBLE_COMPLETE_MODELS.has(saved.modelVersion)) {
      checkpoint.states = Object.fromEntries(Object.entries(saved.states || {}).filter(([, result]) => result.status === 'complete' && result.field !== 'number'));
    }
  }
  const states = [];
  for (const field of fieldDefinitions()) {
    const values = [...new Set(active.map((index) => field.value(cards[index])))].sort((a, b) => a - b);
    for (const value of values) {
      const candidateGroups = active.reduce((count, index) => count + (field.value(cards[index]) === value ? 1 : 0), 0);
      states.push({ key: `${field.key}:${value}`, fieldKey: field.key, value, candidateGroups });
    }
  }
  // Finish small states first so the resumable reference immediately becomes
  // useful and a few giant states cannot hide all progress for hours.
  states.sort((left, right) => left.candidateGroups - right.candidateGroups || left.key.localeCompare(right.key));
  const requested = onlyState ? states.filter((state) => state.key === onlyState) : states;
  if (onlyState && !requested.length) throw new Error(`未知初始状态：${onlyState}`);
  const pending = requested.filter((state) => !checkpoint.states[state.key]);
  console.log(`第一猜参考库：共 ${states.length} 个初始状态，待计算 ${pending.length} 个；${workers} 路并行。`);
  const save = () => fs.writeFileSync(checkpointPath, JSON.stringify(checkpoint), 'utf8');
  let cursor = 0, completed = states.length - pending.length, activeWorkers = 0;
  const started = Date.now();
  const launch = () => {
    if (cursor >= pending.length) {
      if (!activeWorkers) {
        checkpoint.generatedAt = new Date().toISOString();
        const payload = { ...checkpoint, totalStates: states.length, completedStates: Object.keys(checkpoint.states).length };
        fs.writeFileSync(outputPath, `window.FIRST_ACTION_REFERENCE=${JSON.stringify(payload)};\n`, 'utf8');
        console.log(`完成：${payload.completedStates}/${states.length}，耗时 ${((Date.now() - started) / 1000).toFixed(1)} 秒。`);
      }
      return;
    }
    const state = pending[cursor++]; activeWorkers += 1;
    const worker = new Worker(scriptPath, { workerData: { state } });
    worker.once('message', ({ result }) => {
      checkpoint.states[result.key] = result; completed += 1; save(); activeWorkers -= 1;
      console.log(`[${completed}/${states.length}] ${result.key} · ${result.candidateGroups ?? '?'} 组 · ${result.status} · ${((result.elapsedMs || 0) / 1000).toFixed(2)} 秒`);
      launch();
    });
    worker.once('error', (error) => { checkpoint.states[state.key] = { key: state.key, status: 'error', error: String(error) }; completed += 1; save(); activeWorkers -= 1; launch(); });
  };
  for (let index = 0; index < Math.min(workers, pending.length); index += 1) launch();
}
