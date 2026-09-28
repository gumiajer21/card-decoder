#!/usr/bin/env node
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { allocatePackages, chooseGreedyChallenge, selectDynamicActions } from './resource-route-package-core.mjs';
import { chooseFiniteHorizonChallenge, evaluateResourcePattern, isExact, OBSERVED_FIELD_KEYS, popcount, selectCoverageActions, strictMask, weakMask } from './resource-route-core.mjs';

const require = createRequire(import.meta.url);
globalThis.window = globalThis;
require('../dist/cards-data.js');
require('../dist/first-action-reference.js');
const cards = CARD_DATA.cards;
const weights = cards.map((card) => card.wm);
const universe = cards.map((card, index) => card.wm > 0 ? index : -1).filter((index) => index >= 0);
const profileData = JSON.parse(fs.readFileSync(process.argv[2] || 'tools/resource-route-packages.json', 'utf8'));
const rounds = Number(process.argv[3] || 100);
const initialHints = Number(process.argv[4] || 11);
const initialChallenges = Number(process.argv[5] || 27);
const puzzles = Number(process.argv[6] || 9);
const searchBudget = Number(process.argv[7] || 15000);
const forcedPattern = process.argv[8] || '';
const challengeMetric = process.argv[9] || profileData.metric || 'entropy';
const { actions } = selectCoverageActions({ cards, weights, active:universe, candidates:universe, limit:profileData.actionLimit || 64 });
const fieldNames=['border','attribute','race','number','attack','defense'];
const allocationCache = new Map();
const packageFor = (remainingPuzzles, hints, challenges) => {
  if(forcedPattern){const needHints=[...forcedPattern].filter((x)=>x==='0').length,needChallenges=[...forcedPattern].filter((x)=>x==='1').length;return needHints<=hints&&needChallenges<=challenges?{pattern:forcedPattern}:null;}
  const key = `${remainingPuzzles}|${hints}|${challenges}`;
  if (!allocationCache.has(key)) allocationCache.set(key, allocatePackages({ profiles:profileData.profiles, puzzles:remainingPuzzles, hints, challenges }).profile);
  return allocationCache.get(key);
};
let rng = 0x41425445;
const random = () => { rng = (1664525 * rng + 1013904223) >>> 0; return rng / 2 ** 32; };
const totalWeight = universe.reduce((sum, index) => sum + weights[index], 0);
const target = () => { let pick=random()*totalWeight; for(const index of universe){pick-=weights[index];if(pick<0)return index;}return universe.at(-1); };

function newPuzzle(targetIndex) {
  const field = Math.floor(random() * 6), card = cards[targetIndex], value = card[OBSERVED_FIELD_KEYS[field]];
  const reference=globalThis.FIRST_ACTION_REFERENCE?.states?.[`${fieldNames[field]}:${value}`];
  return { targetIndex, candidates:universe.filter((index) => cards[index][OBSERVED_FIELD_KEYS[field]] === value), knownMask:1<<field, matchedMask:0, guessed:new Set(), choiceCache:new Map(), referenceIndex:reference?.best?.type==='challenge'?reference.best.index:null, actions:[...new Set([...actions,...(reference?.topActions||[]).filter((item)=>item.type==='challenge').map((item)=>item.index)])] };
}

function execute(state, pattern, resources) {
  const targetCard = cards[state.targetIndex];
  for(let position=0;position<pattern.length;position+=1){
    const symbol=pattern[position];
    if(symbol==='0'){
      if(resources.hints<=0)continue;
      const unknown=[0,1,2,3,4,5].filter((field)=>!(state.knownMask&(1<<field)));
      if(!unknown.length)continue;
      const field=unknown[Math.floor(random()*unknown.length)],value=targetCard[OBSERVED_FIELD_KEYS[field]];
      resources.hints-=1;resources.hintsUsed+=1;state.knownMask|=1<<field;state.candidates=state.candidates.filter((index)=>cards[index][OBSERVED_FIELD_KEYS[field]]===value);continue;
    }
    if(resources.challenges<=0)return false;
    const finalChallenge=!pattern.slice(position+1).includes('1');
    let choice=null;
    if(!finalChallenge&&searchBudget>0&&challengeMetric==='horizon'){
      const suffix=pattern.slice(position),suffixHints=[...suffix].filter((x)=>x==='0').length,suffixChallenges=[...suffix].filter((x)=>x==='1').length;
      try{const planned=chooseFiniteHorizonChallenge({cards,candidates:state.candidates,hints:suffixHints,challenges:suffixChallenges,knownMask:state.knownMask,matchedMask:state.matchedMask,guessed:[...state.guessed],actions:[...new Set([...state.actions,...state.candidates.slice(0,16)])],weights,depth:3,maxStates:searchBudget});choice={index:planned.action.index};}catch{}
    }else if(!finalChallenge&&searchBudget>0){
      let lookahead=pattern.slice(position,position+3),last=lookahead.lastIndexOf('1');lookahead=lookahead.slice(0,last+1);
      try{const planned=evaluateResourcePattern({cards,candidates:state.candidates,pattern:lookahead,knownMask:state.knownMask,matchedMask:state.matchedMask,guessed:[...state.guessed],actions:[...new Set([...actions,...state.candidates.slice(0,16)])],weights,maxStates:searchBudget});if(planned.action.type==='challenge')choice={index:planned.action.index};}catch{}
    }
    if(!choice&&challengeMetric==='reference'&&state.guessed.size===0&&popcount(state.knownMask)===1&&state.referenceIndex!=null)choice={index:state.referenceIndex};
    const dynamic=challengeMetric.startsWith('dynamic')?selectDynamicActions({cards,active:universe,candidates:state.candidates,weights,matchedMask:state.matchedMask,guessed:state.guessed,limit:40}):state.actions;
    const metric=challengeMetric==='reference'||challengeMetric==='dynamic'?'entropy':challengeMetric.startsWith('dynamicHybrid')?`hybrid${challengeMetric.slice(13)}`:challengeMetric;
    choice ||= chooseGreedyChallenge({cards,candidates:state.candidates,actions:dynamic,guessed:state.guessed,weights,cache:state.choiceCache,finalChallenge,metric});
    if(!choice)return false;
    resources.challenges-=1;resources.challengesUsed+=1;state.guessed.add(choice.index);
    const guess=cards[choice.index];
    if(isExact(targetCard,guess))return true;
    const observedWeak=weakMask(targetCard,guess),observedStrict=strictMask(targetCard,guess);
    state.knownMask|=observedWeak;state.matchedMask|=observedStrict;
    state.candidates=state.candidates.filter((index)=>{const candidate=cards[index],weak=weakMask(candidate,guess),strict=strictMask(candidate,guess);return weak===observedWeak&&strict===observedStrict&&!isExact(candidate,guess)&&(!(weak&1)||candidate.b===targetCard.b)&&(!(weak&8)||candidate.nm===targetCard.nm);});
  }
  return false;
}

const results=[];
for(let round=1;round<=rounds;round+=1){
  const resources={hints:initialHints,challenges:initialChallenges,hintsUsed:0,challengesUsed:0};let solved=0,matches=0;
  for(let puzzle=0;puzzle<puzzles&&resources.challenges>0;puzzle+=1){
    const state=newPuzzle(target());let done=false;
    while(resources.challenges>0&&!done){
      const profile=packageFor(puzzles-puzzle,resources.hints,resources.challenges);
      if(!profile)break;
      const before=resources.hints+resources.challenges;
      done=execute(state,profile.pattern,resources);
      if(resources.hints+resources.challenges===before)break;
    }
    if(!done){matches+=popcount(state.matchedMask);break;}
    solved+=1;matches+=6;
  }
  results.push({solved,matches,hintsUsed:resources.hintsUsed,challengesUsed:resources.challengesUsed});
  fs.writeFileSync('tools/resource-route-activity.partial.json',JSON.stringify({completed:round,total:rounds,results}));
  if(round%10===0)console.log(`${round}/${rounds}`);
}
const mean=(key)=>results.reduce((sum,result)=>sum+result[key],0)/results.length;
const summary={rounds,puzzles,initialHints,initialChallenges,searchBudget,forcedPattern,challengeMetric,meanSolved:mean('solved'),completion:results.filter((result)=>result.solved===puzzles).length/rounds,meanMatches:mean('matches'),meanHintsUsed:mean('hintsUsed'),meanChallengesUsed:mean('challengesUsed'),distribution:Array.from({length:puzzles+1},(_,solved)=>({solved,count:results.filter((result)=>result.solved===solved).length})).filter((entry)=>entry.count)};
console.log(JSON.stringify(summary,null,2));
fs.writeFileSync(`tools/resource-route-activity-${initialHints}-${initialChallenges}.json`,JSON.stringify({summary,results},null,2));
