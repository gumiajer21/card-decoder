#!/usr/bin/env node
import assert from 'node:assert/strict';
import { allocatePackages, enumeratePatterns, simulatePatternOnce } from './resource-route-package-core.mjs';

assert.deepEqual(enumeratePatterns(0, 3), ['111']);
assert.deepEqual(enumeratePatterns(1, 2).sort(), ['011', '101']);
assert(enumeratePatterns(2, 2).every((pattern) => pattern.endsWith('1')));

const cards = [
  { b:1,a:1,r:1,n:4,nm:4,atk:100,def:100 },
  { b:1,a:2,r:1,n:4,nm:4,atk:100,def:100 },
];
const result = simulatePatternOnce({ cards, targetIndex:0, initialField:1, pattern:'1', universe:[0,1], actions:[0,1], weights:[1,1], random:()=>0 });
assert.equal(result.solved, true);
assert.equal(result.challengesUsed, 1);

const profiles = [
  { hints:0,challenges:1,solve:.2,matches:2,pattern:'1' },
  { hints:1,challenges:1,solve:.8,matches:4,pattern:'01' },
];
assert.equal(allocatePackages({ profiles, puzzles:2, hints:0, challenges:2 }).profile.pattern, '1');
assert.equal(allocatePackages({ profiles, puzzles:2, hints:2, challenges:2 }).profile.pattern, '01');
console.log('resource-route package verifier: PASS');
