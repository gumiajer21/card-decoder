#!/usr/bin/env node
import { createRequire } from 'node:module';

const require=createRequire(import.meta.url);globalThis.window=globalThis;globalThis.self=globalThis;
require('../dist/cards-data.js');require('../dist/resource-route-data.js');require('../dist/simulation-worker-source.js');
let seed=0x41425445;Math.random=()=>{seed=(1664525*seed+1013904223)>>>0;return seed/2**32;};
const rounds=Number(process.argv[2]||20),challenges=Number(process.argv[3]||27),hints=Number(process.argv[4]||11),algorithm=process.argv[5]==='resource'?'resource':'stable',routeRollouts=Number(process.argv[6]||4);
const result=new Promise((resolve,reject)=>{globalThis.postMessage=(message)=>{if(message.type==='complete')resolve(message);if(message.type==='error')reject(new Error(message.message));};eval(globalThis.SIMULATION_WORKER_SOURCE);globalThis.onmessage({data:{type:'start',cards:CARD_DATA.cards,pool:'md',rounds,algorithm,routeRollouts,routeProfiles:RESOURCE_ROUTE_DATA.profiles,routeBaseActions:RESOURCE_ROUTE_DATA.baseActions,config:{puzzles:9,totalHints:hints,totalChallenges:challenges,premiumPuzzles:3,milestones:[{matches:1,points:10},{matches:3,points:10},{matches:5,points:10}],solvePoints:70,regularMatchPoints:1,regularSolvePoints:0}}});});
const output=await result;console.log(JSON.stringify(output.summary,null,2));
