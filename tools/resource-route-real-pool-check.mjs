#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { solveActivityExact } from './resource-route-core.mjs';
const require=createRequire(import.meta.url); globalThis.window=globalThis;
require('../dist/cards-data.js');
const cards=globalThis.CARD_DATA.cards;
const active=cards.map((card,index)=>card.wm>0?index:-1).filter(index=>index>=0);
let seed=0x5eed1234;
const random=()=>{seed=(1664525*seed+1013904223)>>>0;return seed/2**32;};
const rows=[];
for(let run=0;run<24;run+=1){
  const subset=[]; while(subset.length<6){const index=active[Math.floor(random()*active.length)];if(!subset.includes(index))subset.push(index);}
  const result=solveActivityExact({cards,universe:subset,candidates:subset,puzzles:1,hints:1,challenges:2,actions:subset,weights:cards.map(card=>card.wm),maxStates:200000});
  assert.ok(result.value[0]>=-1e-10&&result.value[0]<=1+1e-10,'单题通关期望必须在[0,1]');
  assert.ok(result.value[1]>=-1e-10&&result.value[1]<=6+1e-10,'单题最终相符期望必须在[0,6]');
  assert.ok(result.rootActionValues.some(entry=>entry.action.type==='hint'),'有提示库存时根行动必须包含提示');
  rows.push({run:run+1,action:result.action.type,solve:Number(result.value[0].toFixed(4)),matches:Number(result.value[1].toFixed(3)),states:result.states});
}
console.log(`真实卡库确定性抽样通过：${rows.length}/24；首选提示 ${rows.filter(row=>row.action==='hint').length} 次。`);
console.table(rows.slice(0,8));
