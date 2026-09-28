#!/usr/bin/env node
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { allocatePackages, buildPackageProfiles } from './resource-route-package-core.mjs';

const require = createRequire(import.meta.url);
globalThis.window = globalThis;
require('../dist/cards-data.js');
const cards = CARD_DATA.cards;
const weights = cards.map((card) => card.wm);
const universe = cards.map((card, index) => card.wm > 0 ? index : -1).filter((index) => index >= 0);
const samples = Number(process.argv[2] || 2000);
const actionLimit = Number(process.argv[3] || 64);
const metric = process.argv[4] || 'entropy';
const result = buildPackageProfiles({ cards, universe, weights, samples, maxHints: 3, maxChallenges: 6, actionLimit, metric });
result.allocations = [
  { puzzles: 9, hints: 11, challenges: 36 },
  { puzzles: 9, hints: 11, challenges: 27 },
  { puzzles: 9, hints: 20, challenges: 18 },
].map((configuration) => {
  const allocation = allocatePackages({ profiles: result.profiles, ...configuration });
  return { ...configuration, solved: allocation.solved, matches: allocation.matches, first: allocation.profile };
});
fs.writeFileSync('tools/resource-route-packages.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result.allocations, null, 2));
