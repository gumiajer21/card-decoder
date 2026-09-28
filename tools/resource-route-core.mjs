/* Independent experimental resource-route planner.
 * No imports from solver-core.js: feedback semantics and accounting stay
 * independently testable.  It returns terminal distributions and a Pareto
 * set; it never assumes a universal H<->C exchange rate.
 */
export const FIELD_KEYS = ['b', 'a', 'r', 'nm', 'atk', 'def'];
export const OBSERVED_FIELD_KEYS = ['b', 'a', 'r', 'n', 'atk', 'def'];
const bit = (i) => 1 << i;
export const popcount = (m) => { let n = 0; for (m &= 63; m; m &= m - 1) n += 1; return n; };
export function weakMask(t, g) {
  let m = 0;
  if ((t.b & 128) ? Boolean(t.b & g.b & 127) : t.b === g.b) m |= 1;
  if (t.a === g.a) m |= 2; if (t.r === g.r) m |= 4;
  if (t.nm & g.nm) m |= 8; if (t.atk === g.atk) m |= 16; if (t.def === g.def) m |= 32;
  return m;
}
export function strictMask(t, g) { const weak = weakMask(t, g); return (weak & ~1) | (t.b === g.b ? 1 : 0); }
export function isExact(t, g) { return strictMask(t, g) === 63; }
export function selectCoverageActions({cards,weights=cards.map(()=>1),active,candidates,limit=64}) {
  const total=candidates.reduce((sum,index)=>sum+weights[index],0),metrics=[];
  for(const index of active){let solve=0,matches=0;const outcomes=new Map();for(const targetIndex of candidates){const target=cards[targetIndex],w=weights[targetIndex],weak=weakMask(target,cards[index]),key=`${weak}|${strictMask(target,cards[index])}|${isExact(target,cards[index])?1:0}|${weak&1?target.b:''}|${weak&8?target.n:''}`;if(isExact(target,cards[index]))solve+=w;matches+=popcount(strictMask(target,cards[index]))*w;outcomes.set(key,(outcomes.get(key)||0)+w);}let entropy=0;for(const mass of outcomes.values()){const p=mass/total;entropy-=p*Math.log2(p);}metrics.push({index,solve:solve/total,matches:matches/total,entropy});}
  const selected=new Set([...candidates].sort((a,b)=>weights[b]-weights[a]||a-b).slice(0,Math.min(32,limit)));
  const add=(list,count)=>{for(const item of list.slice(0,count)){if(selected.size>=limit)break;selected.add(item.index);}};
  add([...metrics].sort((a,b)=>b.solve-a.solve||b.matches-a.matches||b.entropy-a.entropy),Math.ceil(limit/2));
  add([...metrics].sort((a,b)=>b.entropy-a.entropy||b.solve-a.solve||b.matches-a.matches),limit);
  return {actions:[...selected].slice(0,limit),metrics};
}
const merge = (into, from, p) => { for (const [k, v] of from) into.set(k, (into.get(k) || 0) + p * v); return into; };
const terminal = (solved, matched, h, c) => new Map([[`${solved ? 1 : 0}|${matched}|${h}|${c}`, 1]]);
export function summarize(distribution, startHints, startChallenges) {
  const x = { solve:0, matches:0, hintUse:0, challengeUse:0, mass:0 };
  for (const [key, p] of distribution) { const [s,m,h,c] = key.split('|').map(Number); x.solve += s*p; x.matches += m*p; x.hintUse += (startHints-h)*p; x.challengeUse += (startChallenges-c)*p; x.mass += p; }
  return x;
}
function dominates(a, b) {
  const eps = 1e-10;
  const noWorse = a.solve >= b.solve-eps && a.matches >= b.matches-eps && a.hintUse <= b.hintUse+eps && a.challengeUse <= b.challengeUse+eps;
  const better = a.solve > b.solve+eps || a.matches > b.matches+eps || a.hintUse < b.hintUse-eps || a.challengeUse < b.challengeUse-eps;
  return noWorse && better;
}

// Exact for a selected preference vector on a finite small pool.  Resource
// penalties are deliberately parameters to sweep, not a hidden conversion.
export function solvePreference({ cards, candidates, hints, challenges, knownMask=0, matchedMask=0, depth=6, preference, actions, weights=cards.map(()=>1) }) {
  const startHints = hints, startChallenges = challenges;
  const usable = actions || cards.map((_, i) => i);
  const memo = new Map();
  const utility = (s) => preference.solve*s.solve + preference.matches*s.matches - preference.hints*s.hintUse - preference.challenges*s.challengeUse;
  function visit(state, left) {
    if (!state.candidates.length || left <= 0 || (!state.h && !state.c)) {
      const distribution = terminal(false, popcount(state.m), state.h, state.c);
      return { action:{ type:'stop' }, distribution, summary:summarize(distribution,startHints,startChallenges) };
    }
    const key = `${left}|${state.h}|${state.c}|${state.k}|${state.m}|${state.candidates.join(',')}|${[...state.guessed].sort((a,b)=>a-b).join(',')}`;
    if (memo.has(key)) return memo.get(key);
    const options = [];
    if (state.h && state.k !== 63) {
      const unknown = FIELD_KEYS.map((_,i)=>i).filter(i=>!(state.k&bit(i))); const distribution = new Map();
      const totalWeight=state.candidates.reduce((sum,index)=>sum+weights[index],0);
      for (const field of unknown) {
        const groups = new Map(); for (const index of state.candidates) { const value=cards[index][OBSERVED_FIELD_KEYS[field]]; if(!groups.has(value))groups.set(value,[]); groups.get(value).push(index); }
        for (const subset of groups.values()) merge(distribution, visit({ ...state, h:state.h-1, k:state.k|bit(field), candidates:subset }, left-1).distribution, subset.reduce((sum,index)=>sum+weights[index],0)/totalWeight/unknown.length);
      }
      options.push({ action:{type:'hint'}, distribution, summary:summarize(distribution,startHints,startChallenges) });
    }
    if (state.c) for (const guessIndex of usable) {
      if (state.guessed.has(guessIndex)) continue;
      const groups = new Map();
      for (const targetIndex of state.candidates) { const t=cards[targetIndex], g=cards[guessIndex], weak=weakMask(t,g), strict=strictMask(t,g), solved=isExact(t,g); const key=`${weak}|${strict}|${solved?1:0}|${weak&1?t.b:''}|${weak&8?t.nm:''}`; if(!groups.has(key))groups.set(key,{ weak,strict,solved,targets:[] }); groups.get(key).targets.push(targetIndex); }
      const distribution = new Map();
      for (const group of groups.values()) {
        const child = group.solved ? { distribution:terminal(true,popcount(state.m|group.strict),state.h,state.c-1) }
          : visit({ ...state,c:state.c-1,k:state.k|group.weak,m:state.m|group.strict,candidates:group.targets,guessed:new Set([...state.guessed,guessIndex]) },left-1);
        merge(distribution,child.distribution,group.targets.reduce((sum,index)=>sum+weights[index],0)/state.candidates.reduce((sum,index)=>sum+weights[index],0));
      }
      options.push({ action:{type:'challenge',index:guessIndex}, distribution, summary:summarize(distribution,startHints,startChallenges) });
    }
    if (!options.length) {
      const distribution = terminal(false, popcount(state.m), state.h, state.c);
      const stopped = { action:{ type:'stop' }, distribution, summary:summarize(distribution,startHints,startChallenges) };
      memo.set(key, stopped); return stopped;
    }
    const chosen = options.sort((a,b)=>utility(b.summary)-utility(a.summary))[0]; memo.set(key,chosen); return chosen;
  }
  return visit({ candidates:[...candidates],h:hints,c:challenges,k:knownMask,m:matchedMask,guessed:new Set() },depth);
}

// Sweep a transparent grid of resource preferences and return only root
// profiles not dominated in solve/matches/resource use. The caller may choose
// among this frontier; there is intentionally no hidden default scalar score.
export function routeFrontier(options) {
  const preferences = options.preferences || [
    { name:'收益优先', solve:1000, matches:1, hints:0, challenges:0 },
    { name:'节省提示', solve:1000, matches:1, hints:1, challenges:0 },
    { name:'节省挑战', solve:1000, matches:1, hints:0, challenges:1 },
    { name:'均衡节省', solve:1000, matches:1, hints:1, challenges:1 },
  ];
  const profiles = preferences.map((preference) => ({ preference, ...solvePreference({ ...options, preference }) }));
  return profiles.filter((profile, i) => !profiles.some((other,j) => i!==j && dominates(other.summary,profile.summary)));
}

// Exact activity-level oracle for small pools. Unlike the legacy solver's
// continuation proxy, it opens the next puzzle by averaging over every target
// and every initial revealed field. Vector order is explicit and has no H/C
// conversion: completed puzzles, then final matched fields. Resource usage is
// returned for Pareto reporting but is not assigned a universal order.
export function solveActivityExact({ cards, universe, puzzles, hints, challenges, candidates=universe, knownMask=0, matchedMask=0, actions, weights=cards.map(()=>1), maxStates=Infinity }) {
  const usable = actions || cards.map((_, i) => i);
  const add = (a,b) => a.map((x,i)=>x+b[i]);
  const scale = (a,p) => a.map((x)=>x*p);
  const compare = (a,b) => { for(let i=0;i<2;i+=1) if(Math.abs(a[i]-b[i])>1e-10) return a[i]>b[i]?1:-1; return 0; };
  const mass = (xs) => xs.reduce((sum,index)=>sum+weights[index],0);
  const memo = new Map(), startMemo = new Map(), rootActionValues = [];
  let expandedStates=0;
  function openNext(t,h,c) {
    if (t <= 0 || c <= 0) return [0,0,0,0];
    const key=`${t}|${h}|${c}`; if(startMemo.has(key))return startMemo.get(key);
    let total=[0,0,0,0];
    for(let field=0;field<6;field+=1) {
      const groups=new Map(); for(const index of universe){const value=cards[index][OBSERVED_FIELD_KEYS[field]];if(!groups.has(value))groups.set(value,[]);groups.get(value).push(index);}
      for(const subset of groups.values()) total=add(total,scale(visit({ t,h,c,k:bit(field),m:0,candidates:subset,guessed:new Set() }),mass(subset)/mass(universe)/6));
    }
    startMemo.set(key,total); return total;
  }
  function visit(state, isRoot=false) {
    if (!state.candidates.length || state.c <= 0) return [0,popcount(state.m),0,0];
    const key=`${state.t}|${state.h}|${state.c}|${state.k}|${state.m}|${state.candidates.join(',')}|${[...state.guessed].sort((a,b)=>a-b).join(',')}`;
    if(memo.has(key))return memo.get(key);
    if(++expandedStates>maxStates)throw new Error(`RESOURCE_ROUTE_STATE_LIMIT:${maxStates}`);
    let best=[0,popcount(state.m),0,0];
    if(state.h>0 && state.k!==63){
      let value=[0,0,0,-1]; const unknown=FIELD_KEYS.map((_,i)=>i).filter(i=>!(state.k&bit(i)));
      for(const field of unknown){const groups=new Map();for(const index of state.candidates){const v=cards[index][OBSERVED_FIELD_KEYS[field]];if(!groups.has(v))groups.set(v,[]);groups.get(v).push(index);}for(const subset of groups.values())value=add(value,scale(visit({...state,h:state.h-1,k:state.k|bit(field),candidates:subset}),mass(subset)/mass(state.candidates)/unknown.length));}
      if(isRoot)rootActionValues.push({action:{type:'hint'},value});
      if(compare(value,best)>0)best=value;
    }
    for(const guessIndex of usable){
      if(state.guessed.has(guessIndex))continue;
      const groups=new Map(); for(const targetIndex of state.candidates){const t=cards[targetIndex],g=cards[guessIndex],weak=weakMask(t,g),strict=strictMask(t,g),solved=isExact(t,g),k=`${weak}|${strict}|${solved?1:0}|${weak&1?t.b:''}|${weak&8?t.nm:''}`;if(!groups.has(k))groups.set(k,{weak,strict,solved,targets:[]});groups.get(k).targets.push(targetIndex);}
      let value=[0,0,-1,0];
      for(const group of groups.values()){
        const child=group.solved ? add([1,6,0,0],openNext(state.t-1,state.h,state.c-1)) : visit({...state,c:state.c-1,k:state.k|group.weak,m:state.m|group.strict,candidates:group.targets,guessed:new Set([...state.guessed,guessIndex])});
        value=add(value,scale(child,mass(group.targets)/mass(state.candidates)));
      }
      if(isRoot)rootActionValues.push({action:{type:'challenge',index:guessIndex},value});
      if(compare(value,best)>0)best=value;
    }
    memo.set(key,best);return best;
  }
  const value=visit({t:puzzles,h:hints,c:challenges,k:knownMask,m:matchedMask,candidates:[...candidates],guessed:new Set()},true);
  rootActionValues.sort((a,b)=>compare(b.value,a.value));
  return { value, action:rootActionValues[0]?.action || {type:'stop'}, rootActionValues, states:memo.size, expandedStates, objective:['预期完成题数','预期最终相符项'], reporting:['负挑战消耗','负提示消耗'] };
}

// Evaluate one adaptive resource route. 0 = random hint, 1 = challenge; the
// final symbol must be 1. Challenge cards are optimized independently at each
// feedback state. The result retains the terminal resource distribution.
export function evaluateResourcePattern({ cards, candidates, pattern, knownMask=0, matchedMask=0, guessed=[], actions, weights=cards.map(()=>1), maxStates=200000 }) {
  if (!/^[01]*1$/.test(pattern)) throw new Error('RESOURCE_PATTERN_INVALID');
  const usable=actions||cards.map((_,i)=>i), startHints=[...pattern].filter(x=>x==='0').length, startChallenges=[...pattern].filter(x=>x==='1').length;
  const memo=new Map();let expandedStates=0;
  const mass=(xs)=>xs.reduce((sum,index)=>sum+weights[index],0);
  const compareSummary=(a,b)=>Math.abs(a.solve-b.solve)>1e-10?(a.solve>b.solve?1:-1):Math.abs(a.matches-b.matches)>1e-10?(a.matches>b.matches?1:-1):0;
  function visit(state,pos,hUsed,cUsed){
    if(pos>=pattern.length||!state.candidates.length){const distribution=terminal(false,popcount(state.m),startHints-hUsed,startChallenges-cUsed);return{action:{type:'stop'},distribution,summary:summarize(distribution,startHints,startChallenges)};}
    const key=`${pos}|${state.k}|${state.m}|${state.candidates.join(',')}|${[...state.guessed].sort((a,b)=>a-b).join(',')}`;if(memo.has(key))return memo.get(key);
    if(++expandedStates>maxStates)throw new Error(`RESOURCE_PATTERN_STATE_LIMIT:${maxStates}`);
    if(pattern[pos]==='0'){
      const unknown=FIELD_KEYS.map((_,i)=>i).filter(i=>!(state.k&bit(i)));
      if(!unknown.length)return visit(state,pos+1,hUsed,cUsed);
      const distribution=new Map(),total=mass(state.candidates);
      for(const field of unknown){const groups=new Map();for(const index of state.candidates){const value=cards[index][OBSERVED_FIELD_KEYS[field]];if(!groups.has(value))groups.set(value,[]);groups.get(value).push(index);}for(const subset of groups.values())merge(distribution,visit({...state,k:state.k|bit(field),candidates:subset},pos+1,hUsed+1,cUsed).distribution,mass(subset)/total/unknown.length);}
      const result={action:{type:'hint'},distribution,summary:summarize(distribution,startHints,startChallenges)};memo.set(key,result);return result;
    }
    let best=null,total=mass(state.candidates);
    for(const guessIndex of usable){if(state.guessed.has(guessIndex))continue;const groups=new Map();for(const targetIndex of state.candidates){const t=cards[targetIndex],g=cards[guessIndex],weak=weakMask(t,g),strict=strictMask(t,g),solved=isExact(t,g),keyPart=`${weak}|${strict}|${solved?1:0}|${weak&1?t.b:''}|${weak&8?t.nm:''}`;if(!groups.has(keyPart))groups.set(keyPart,{weak,strict,solved,targets:[]});groups.get(keyPart).targets.push(targetIndex);}const distribution=new Map();for(const group of groups.values()){const child=group.solved?terminal(true,6,startHints-hUsed,startChallenges-(cUsed+1)):visit({...state,k:state.k|group.weak,m:state.m|group.strict,candidates:group.targets,guessed:new Set([...state.guessed,guessIndex])},pos+1,hUsed,cUsed+1).distribution;merge(distribution,child,mass(group.targets)/total);}const candidate={action:{type:'challenge',index:guessIndex},distribution,summary:summarize(distribution,startHints,startChallenges)};if(!best||compareSummary(candidate.summary,best.summary)>0)best=candidate;}
    if(!best){const distribution=terminal(false,popcount(state.m),startHints-hUsed,startChallenges-cUsed);best={action:{type:'stop'},distribution,summary:summarize(distribution,startHints,startChallenges)};}
    memo.set(key,best);return best;
  }
  const result=visit({candidates:[...candidates],k:knownMask,m:matchedMask,guessed:new Set(guessed)},0,0,0);return{...result,pattern,expandedStates};
}

// Finite-horizon challenge selector for the resource-route algorithm. The root
// is restricted to a challenge because the package planner has already chosen
// the resource type; later levels may choose either resource. No cross-resource
// price or future-puzzle proxy is used here.
export function chooseFiniteHorizonChallenge({cards,candidates,hints,challenges,knownMask=0,matchedMask=0,guessed=[],actions,weights=cards.map(()=>1),depth=3,maxStates=30000}){
  const memo=new Map(),mass=(xs)=>xs.reduce((sum,index)=>sum+weights[index],0);let expandedStates=0;
  const compare=(a,b)=>Math.abs(a[0]-b[0])>1e-10?(a[0]>b[0]?1:-1):Math.abs(a[1]-b[1])>1e-10?(a[1]>b[1]?1:-1):Math.abs(a[2]-b[2])>1e-10?(a[2]>b[2]?1:-1):0;
  const add=(a,b)=>a.map((x,i)=>x+b[i]),scale=(a,p)=>a.map((x)=>x*p);
  function visit(state,left,root=false){
    if(left<=0||!state.candidates.length||(!state.h&&!state.c))return{value:[0,popcount(state.m),0],action:{type:'stop'}};
    const key=`${left}|${state.h}|${state.c}|${state.k}|${state.m}|${state.candidates.join(',')}|${[...state.guessed].sort((a,b)=>a-b).join(',')}|${root?1:0}`;if(memo.has(key))return memo.get(key);if(++expandedStates>maxStates)throw new Error(`RESOURCE_HORIZON_STATE_LIMIT:${maxStates}`);
    let best=null,total=mass(state.candidates);const consider=(value,action)=>{if(!best||compare(value,best.value)>0)best={value,action};};
    if(!root&&state.h>0&&state.k!==63){let value=[0,0,-1];const unknown=FIELD_KEYS.map((_,i)=>i).filter(i=>!(state.k&bit(i)));for(const field of unknown){const groups=new Map();for(const index of state.candidates){const v=cards[index][OBSERVED_FIELD_KEYS[field]];if(!groups.has(v))groups.set(v,[]);groups.get(v).push(index);}for(const subset of groups.values())value=add(value,scale(visit({...state,h:state.h-1,k:state.k|bit(field),candidates:subset},left-1).value,mass(subset)/total/unknown.length));}consider(value,{type:'hint'});}
    if(state.c>0)for(const guessIndex of actions){if(state.guessed.has(guessIndex))continue;const groups=new Map();for(const targetIndex of state.candidates){const target=cards[targetIndex],guess=cards[guessIndex],weak=weakMask(target,guess),strict=strictMask(target,guess),solved=isExact(target,guess),groupKey=`${weak}|${strict}|${solved?1:0}|${weak&1?target.b:''}|${weak&8?target.nm:''}`;if(!groups.has(groupKey))groups.set(groupKey,{weak,strict,solved,targets:[]});groups.get(groupKey).targets.push(targetIndex);}let value=[0,0,-1];for(const group of groups.values()){let branch;if(group.solved)branch=[1,6,0];else branch=visit({...state,c:state.c-1,k:state.k|group.weak,m:state.m|group.strict,candidates:group.targets,guessed:new Set([...state.guessed,guessIndex])},left-1).value;value=add(value,scale(branch,mass(group.targets)/total));}consider(value,{type:'challenge',index:guessIndex});}
    best||={value:[0,popcount(state.m),0],action:{type:'stop'}};memo.set(key,best);return best;
  }
  const result=visit({h:hints,c:challenges,k:knownMask,m:matchedMask,candidates:[...candidates],guessed:new Set(guessed)},depth,true);return{...result,expandedStates,memoStates:memo.size};
}

// Allocate empirically evaluated single-puzzle route profiles across the
// remaining activity. Resource values arise from the DP table itself. A route
// profile distribution uses the same terminal keys as evaluateResourcePattern.
export function allocatePatterns({ profiles, puzzles, hints, challenges }) {
  const memo=new Map();
  const compare=(a,b)=>Math.abs(a[0]-b[0])>1e-10?(a[0]>b[0]?1:-1):Math.abs(a[1]-b[1])>1e-10?(a[1]>b[1]?1:-1):0;
  function visit(t,h,c){
    if(t<=0||c<=0)return{value:[0,0],pattern:null};
    const key=`${t}|${h}|${c}`;if(memo.has(key))return memo.get(key);
    let best={value:[0,0],pattern:null};
    for(const profile of profiles){const routeHints=[...profile.pattern].filter(x=>x==='0').length,routeChallenges=[...profile.pattern].filter(x=>x==='1').length;if(routeHints>h||routeChallenges>c)continue;let value=[0,0];for(const [outcome,p] of profile.distribution){const [solved,matches,remainingH,remainingC]=outcome.split('|').map(Number),usedH=routeHints-remainingH,usedC=routeChallenges-remainingC;if(solved){const future=visit(t-1,h-usedH,c-usedC).value;value[0]+=p*(1+future[0]);value[1]+=p*(6+future[1]);}else value[1]+=p*matches;}if(compare(value,best.value)>0)best={value,pattern:profile.pattern,profile};}
    memo.set(key,best);return best;
  }
  const result=visit(puzzles,hints,challenges);return{...result,table:memo};
}
