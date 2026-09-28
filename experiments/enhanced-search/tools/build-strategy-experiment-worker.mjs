import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const solver = fs.readFileSync(path.join(root, 'solver-core.js'), 'utf8');
const worker = fs.readFileSync(path.join(root, 'strategy-experiment-worker.js'), 'utf8');
fs.writeFileSync(path.join(root, 'strategy-experiment-worker-source.js'), `window.STRATEGY_EXPERIMENT_WORKER_SOURCE=${JSON.stringify(`${solver}\n${worker}`)};\n`);
console.log('strategy-experiment-worker-source.js 已生成');
