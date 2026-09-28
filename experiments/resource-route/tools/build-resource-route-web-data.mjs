#!/usr/bin/env node
import fs from 'node:fs';
const data=JSON.parse(fs.readFileSync('tools/resource-route-packages.json','utf8'));
fs.writeFileSync('dist/resource-route-data.js',`window.RESOURCE_ROUTE_DATA=${JSON.stringify(data)};\n`);
const worker=fs.readFileSync('dist/resource-route-worker.js','utf8');
fs.writeFileSync('dist/resource-route-worker-source.js',`window.RESOURCE_ROUTE_WORKER_SOURCE=${JSON.stringify(worker)};\n`);
console.log(`resource-route-data.js: ${data.profiles.length} profiles, ${data.validationSamples||data.samples} validation samples`);
