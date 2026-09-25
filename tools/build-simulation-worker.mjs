import fs from 'node:fs';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..','dist');
const solver=fs.readFileSync(path.join(root,'solver-core.js'),'utf8');
const worker=fs.readFileSync(path.join(root,'simulation-worker.js'),'utf8').replace(/^importScripts\('solver-core\.js'\);\s*/, '');
fs.writeFileSync(path.join(root,'simulation-worker-source.js'),`window.SIMULATION_WORKER_SOURCE=${JSON.stringify(`${solver}\n${worker}`)};\n`);
console.log('simulation-worker-source.js 已生成');
