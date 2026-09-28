#!/usr/bin/env node
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {selectCoverageActions} from './resource-route-core.mjs';
const data=JSON.parse(fs.readFileSync('tools/resource-route-packages.json','utf8'));
if (!data.baseActions?.length) {
  const require=createRequire(import.meta.url); globalThis.window=globalThis; require('../dist/cards-data.js');
  const cards=globalThis.CARD_DATA.cards,weights=cards.map(card=>card.wm),active=cards.map((card,index)=>card.wm>0?index:-1).filter(index=>index>=0);
  data.baseActions=selectCoverageActions({cards,weights,active,candidates:active,limit:64}).actions;
  fs.writeFileSync('tools/resource-route-packages.json',`${JSON.stringify(data,null,2)}\n`);
}
fs.writeFileSync('dist/resource-route-data.js',`window.RESOURCE_ROUTE_DATA=${JSON.stringify(data)};\n`);
const worker=fs.readFileSync('dist/resource-route-worker.js','utf8');
fs.writeFileSync('dist/resource-route-worker-source.js',`window.RESOURCE_ROUTE_WORKER_SOURCE=${JSON.stringify(worker)};\n`);
console.log(`resource-route-data.js: ${data.profiles.length} profiles, ${data.validationSamples||data.samples} validation samples`);
