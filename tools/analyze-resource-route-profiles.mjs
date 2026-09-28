#!/usr/bin/env node
import fs from 'node:fs';
import { allocatePatterns } from './resource-route-core.mjs';

const input = process.argv[2] || 'tools/resource-route-profiles.json';
const data = JSON.parse(fs.readFileSync(input, 'utf8'));
const profiles = Object.entries(data.patterns)
  .filter(([, profile]) => profile.coverage >= 1 - 1e-12)
  .map(([pattern, profile]) => ({ pattern, distribution: profile.distribution }));

if (!profiles.length) throw new Error('没有覆盖全部抽样状态的路线，不能进行无偏资源分配。');

const mass = (distribution) => distribution.reduce((sum, [, probability]) => sum + probability, 0);
const configurations = [
  { puzzles: 9, hints: 11, challenges: 36 },
  { puzzles: 9, hints: 11, challenges: 27 },
  { puzzles: 9, hints: 20, challenges: 18 },
  { puzzles: 3, hints: 3, challenges: 9 },
  { puzzles: 1, hints: 3, challenges: 4 },
];

const allocations = configurations.map((configuration) => {
  const result = allocatePatterns({ profiles, ...configuration });
  const policy = [];
  for (let puzzles = configuration.puzzles; puzzles >= 1; puzzles -= 1) {
    const entries = [];
    for (let hints = 0; hints <= configuration.hints; hints += 1) {
      for (let challenges = 1; challenges <= configuration.challenges; challenges += 1) {
        const state = result.table.get(`${puzzles}|${hints}|${challenges}`);
        if (state?.pattern) entries.push({ hints, challenges, pattern: state.pattern });
      }
    }
    const counts = Object.entries(entries.reduce((out, entry) => {
      out[entry.pattern] = (out[entry.pattern] || 0) + 1;
      return out;
    }, {})).sort((a, b) => b[1] - a[1]);
    policy.push({ puzzles, counts });
  }
  return { ...configuration, firstPattern: result.pattern, value: result.value, policy };
});

const report = {
  sourceDraws: data.draws,
  profiles: Object.entries(data.patterns).map(([pattern, profile]) => ({
    pattern,
    coverage: profile.coverage,
    mass: mass(profile.distribution),
  })),
  allocations,
};

fs.writeFileSync('tools/resource-route-profile-analysis.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
