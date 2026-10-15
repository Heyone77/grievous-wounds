import {test} from 'node:test';
import assert from 'node:assert/strict';
const hooks = new Map();
globalThis.Hooks={on:(n,fn)=>{const a=hooks.get(n)??[];a.push(fn);hooks.set(n,a);},once:(n,fn)=>{const a=hooks.get(n)??[];a.push(fn);hooks.set(n,a);}};
const prop=(o,p)=>Object.hasOwn(o,p)?o[p]:p.split('.').reduce((a,k)=>a?.[k],o);
const set=(o,p,v)=>{const a=p.split('.');let q=o;for(const k of a.slice(0,-1))q=q[k]??={};q[a.at(-1)]=v;return o;};
let next=0;
globalThis.foundry={utils:{getProperty:prop,setProperty:set,deepClone:structuredClone,randomID:()=>`id${++next}`}};
globalThis.game={system:{id:'dnd5e',version:'6.0.0'},user:{id:'gm',isGM:true},users:{activeGM:{id:'gm'},filter:()=>[]},modules:new Map(),settings:{get:(_id,key)=>key==='permanentCount'||key==='enabled'}};
globalThis.ui={notifications:{warn:()=>{},error:()=>{},info:()=>{}}};
globalThis.canvas={tokens:{controlled:[],placeables:[]}};
globalThis.CONFIG={statusEffects:['dead','prone','poisoned','blinded','deafened','incapacitated','frightened'].map(id=>({id}))};
const messages=[];
globalThis.ChatMessage={getSpeaker:({actor})=>({actor:actor.id}),create:async d=>messages.push(d)};
const {ID}=await import('../scripts/rules.mjs');
const preUpdate=(...args)=>{for(const fn of hooks.get('preUpdateActor'))fn(...args);};
const {prepareWoundData,resolveChoice,addWound,rollWound,treat,checkHesitantSave,applyDamageUpdate,resumeDamage,eventLog,undoPreview,undoEvent,abandonDamage,auditWounds,repairWound,open,openJournal}=await import('../scripts/main.mjs');
function actor(wounds=[]) {
 const a={id:'actor',uuid:`Actor.${++next}`,type:'character',name:'Test',flags:{},statuses:new Set(),system:{details:{level:5},attributes:{hp:{value:0,max:40,effectiveMax:40,tempmax:0},death:{success:0,failure:0},movement:{units:'ft',walk:30,fly:0},exhaustion:0}},effects:[]};
 const directStatuses=a.statuses;
 Object.defineProperty(a,'statuses',{get:()=>new Set([...directStatuses,...a.effects.filter(e=>!e.disabled).flatMap(e=>[...e.statuses])])});
 a.getFlag=(id,key)=>a.flags[id]?.[key];
 a.setFlag=async(id,key,value)=>{set(a.flags,`${id}.${key}`,value);};
 a.unsetFlag=async(id,key)=>{delete a.flags[id]?.[key];};
 a.update=async changes=>{
  const apply=(data,prefix='')=>{for(const [key,value] of Object.entries(data)){const path=prefix?prefix+'.'+key:key;if(value && typeof value==='object' && !Array.isArray(value))apply(value,path);else set(a,path,value);}};
  apply(changes);return a;
 };
 a.toggleStatusEffect=async(id,{active})=>{
  if(active){if(!a.statuses.has(id))await a.createEmbeddedDocuments('ActiveEffect',[{statuses:[id],flags:{}}]);}
  else {directStatuses.delete(id);for(const e of [...a.effects])if(e.statuses.has(id)){if(e.statuses.size===1)await a.deleteEmbeddedDocuments('ActiveEffect',[e.id]);else e.statuses.delete(id);}}
 };
 a.deleteEmbeddedDocuments=async(_type,ids)=>{a.effects=a.effects.filter(e=>!ids.includes(e.id));};
 a.updateEmbeddedDocuments=async(_type,updates)=>{for(const data of updates){const effect=a.effects.find(e=>e.id===data._id);if(!effect)throw Error('missing effect');for(const [key,value]of Object.entries(data))if(key!=='_id'){if(key==='statuses')effect.statuses=new Set(value);else set(effect,key,value);}}};
 a.createEmbeddedDocuments=async(_type,entries)=>{const result=entries.map(data=>{const e={...structuredClone(data),id:'effect'+(++next),disabled:false,statuses:new Set(data.statuses)};e.getFlag=(id,key)=>e.flags?.[id]?.[key];return e;});a.effects.push(...result);return result;};
 for(const [id,kind='grievous',key=9] of wounds){const e={id:'effect'+(++next),disabled:false,statuses:new Set(),flags:{[ID]:{wound:{id,kind,key}}}};e.getFlag=(mod,k)=>e.flags?.[mod]?.[k];a.effects.push(e);}
 return a;
}
function pending(a,result) {
 a.flags[ID]={pending:{id:'drop',beforeDeath:{success:0,failure:0},unconscious:[],beforeConditions:{unconscious:{active:false,effectIds:[]},prone:{active:false,effectIds:[]}},result}};
}
test('preUpdate marks only positive-to-zero transitions',()=>{
 const fn=preUpdate, a=actor();a.system.attributes.hp.value=12;
 const d={'system.attributes.hp.value':0};fn(a,d,{});assert.ok(prop(d,`flags.${ID}.pending`).id);
 a.system.attributes.hp.value=0;const again={'system.attributes.hp.value':0};fn(a,again,{});assert.equal(prop(again,`flags.${ID}.pending`),undefined);
});
test('healing invalidates a pending choice',()=>{
 const a=actor();pending(a);const d={'system.attributes.hp.value':5};preUpdate(a,d,{});
 assert.equal(prop(d,`flags.${ID}.pending`),null);
});
test('fall creates no new wound and applies existing deep-wound failures',async()=>{
 const a=actor([['deep'],['deep']]);pending(a);await resolveChoice(a,'drop','fall');
 assert.equal(a.effects.length,2);assert.equal(a.system.attributes.death.failure,2);assert.equal(a.getFlag(ID,'pending'),null);
});
test('wound restores one HP without applying deep-wound penalties',async()=>{
 const a=actor([['deep']]);pending(a,{kind:'grievous',key:6,entry:{id:'pain',name:'Pain',text:'test'}});
 await resolveChoice(a,'drop','wound');assert.equal(a.system.attributes.hp.value,1);assert.equal(a.effects.length,2);assert.equal(a.system.attributes.death.failure,0);
 await resolveChoice(a,'drop','wound');assert.equal(a.effects.length,2);
});
test('fatal outcome overrides the house-rule one HP',async()=>{
 const a=actor();pending(a,{kind:'permanent',key:1,entry:{id:'fatal',name:'Fatal',text:'test'}});
 await resolveChoice(a,'drop','wound');assert.equal(a.system.attributes.hp.value,0);assert.equal(a.system.attributes.death.failure,3);assert.ok(a.statuses.has('dead'));
});
test('close call gives prone without a persistent injury',async()=>{
 const a=actor();pending(a,{kind:'grievous',key:18,entry:{id:'close',name:'Close',text:'test'}});
 await resolveChoice(a,'drop','wound');assert.equal(a.effects.filter(e=>e.getFlag(ID,'wound')).length,0);assert.equal(a.system.attributes.hp.value,1);assert.ok(a.statuses.has('prone'));
});
test('stale choice cannot overwrite healing or later death saves',async()=>{
 const a=actor();pending(a);a.system.attributes.hp.value=4;await resolveChoice(a,'drop','wound');assert.equal(a.system.attributes.hp.value,4);
 const b=actor();pending(b);b.system.attributes.death.success=1;await resolveChoice(b,'drop','wound');assert.equal(b.effects.length,0);assert.equal(b.system.attributes.death.success,1);
});
test('resuming an interrupted choice does not duplicate the injury',async()=>{
 const a=actor();pending(a,{kind:'grievous',key:6,entry:{id:'pain',name:'Pain',text:'test'}});
 await a.createEmbeddedDocuments('ActiveEffect',[{flags:{[ID]:{wound:{id:'pain',kind:'grievous',key:6,eventId:'drop'}}},statuses:[]}]);
 await resolveChoice(a,'drop','wound');assert.equal(a.effects.length,1);assert.equal(a.system.attributes.hp.value,1);
});
test('derived max HP reduction leaves source-like starting maximum intact across reprepare',()=>{
 const a=actor([['internal'],['lungs','permanent',6]]);a.system.attributes.hp.value=35;prepareWoundData(a);
 assert.equal(a.system.attributes.hp.max,20);assert.equal(a.system.attributes.hp.value,20);
 // Foundry resets derived data from source before each wrapped prepareData call.
 a.system.attributes.hp={value:35,max:40,effectiveMax:40,tempmax:0};prepareWoundData(a);assert.equal(a.system.attributes.hp.max,20);
});
test('two missing legs subtract thirty feet with a five-foot floor',()=>{
 const a=actor([['lostleg','permanent',3],['lostleg','permanent',3]]);a.system.attributes.movement.walk=60;prepareWoundData(a);assert.equal(a.system.attributes.movement.walk,30);assert.equal(a.system.attributes.movement.fly,0);
});
test('wound saves preserve advantage for normal cancellation',()=>{
 const a=actor([['pain']]);const config={subject:a,ability:'dex',advantage:true,rolls:[{options:{advantage:true}}]};hooks.get('dnd5e.preRollSavingThrow')[0](config);
 assert.equal(config.advantage,true);assert.equal(config.disadvantage,true);assert.equal(config.rolls[0].options.disadvantage,true);
});
test('grievous effects cannot be mutated by a non-GM through API',async()=>{
 const a=actor();game.user.isGM=false;
 try {await assert.rejects(()=>addWound(a,'grievous',6),/мастер/);}finally{game.user.isGM=true;}
});

test('bleeding blocks ordinary healing but preserves damage and temporary HP',()=>{
 const a=actor([['laceration','grievous',8]]);a.system.attributes.hp.value=7;
 const healing={'system.attributes.hp.value':12,'system.attributes.hp.temp':5};preUpdate(a,healing,{});
 assert.equal(healing['system.attributes.hp.value'],7);assert.equal(healing['system.attributes.hp.temp'],5);
 const damage={'system.attributes.hp.value':3};preUpdate(a,damage,{});assert.equal(damage['system.attributes.hp.value'],3);
});
test('bleeding permits the exact healing update from a hit die',()=>{
 const a=actor([['laceration','grievous',8]]);a.system.attributes.hp.value=7;
 hooks.get('dnd5e.rollHitDie')[0]([],{subject:a,updates:{actor:{'system.attributes.hp.value':11}}});
 const healing={'system.attributes.hp.value':11};preUpdate(a,healing,{});assert.equal(healing['system.attributes.hp.value'],11);
 const again={'system.attributes.hp.value':11};preUpdate(a,again,{});assert.equal(again['system.attributes.hp.value'],7);
});
test('dazed prevents starting concentration',()=>{
 const a=actor([['concussion','grievous',7]]);
 assert.equal(hooks.get('dnd5e.preBeginConcentrating')[0](a),false);
 assert.equal(hooks.get('dnd5e.preBeginConcentrating')[0](actor()),undefined);
});
test('CAT effect creation is used when available with v14 system changes',async()=>{
 const a=actor();let received;
 game.modules.set('cat',{active:true});
 globalThis.cat={utils:{effectUtils:{createEffects:async(actor,data)=>{received=data;return actor.createEmbeddedDocuments('ActiveEffect',data);}}}};
 try {await addWound(a,'grievous',6);assert.equal(received[0].type,'base');assert.ok(Array.isArray(received[0].system.changes));assert.equal(a.effects.length,1);}
 finally {game.modules.delete('cat');delete globalThis.cat;}
});
test('Midi damage uses CAT once without rerolling the original critical damage',async()=>{
 const a=actor([['muscle','grievous',15]]);let calls=0;
 const setting=game.settings.get;game.settings.get=(_id,key)=>key==='autoMuscle'||setting(_id,key);
 globalThis.Roll=class{constructor(formula){this.formula=formula;this.total=3;}async evaluate(){return this;}async toMessage(){return {};}};
 game.modules.set('cat',{active:true});globalThis.cat={utils:{rollUtils:{addToRoll:async(original,formula)=>{calls++;assert.equal(formula,'-3');return {...original,total:original.total-3};}}}};
 const workflow={actor:a,item:{type:'weapon'},activity:{type:'attack'},damageRolls:[{total:14,options:{type:'slashing',isCritical:true}}],async setDamageRolls(rolls){this.damageRolls=rolls;}};
 try {
  const fn=hooks.get('midi-qol.DamageRollComplete')[0];await fn(workflow);assert.equal(workflow.damageRolls[0].total,11);assert.equal(workflow.damageRolls[0].options.isCritical,true);
  await fn(workflow);assert.equal(calls,1);
 }finally{game.settings.get=setting;game.modules.delete('cat');delete globalThis.cat;delete globalThis.Roll;}
});

test('random permanent duplicate is replaced by the next lower result',async()=>{
 const a=actor([['oldpain','permanent',10]]);const rolls=[2,10];
 globalThis.Roll=class{async evaluate(){this.total=rolls.shift();return this;}async toMessage(){}};
 try {const result=await rollWound(a);assert.equal(result.key,9);assert.equal(a.effects.length,2);assert.equal(a.effects[1].getFlag(ID,'wound').id,'hesitant');}
 finally {delete globalThis.Roll;}
});
test('manual addition cannot create a nonrepeatable permanent duplicate',async()=>{
 const a=actor([['oldpain','permanent',10]]);
 await assert.rejects(()=>addWound(a,'permanent',10),/уже есть/);assert.equal(a.effects.length,1);
});
test('adding a second lost leg preserves the correct speed ceiling',async()=>{
 const a=actor();a.system.attributes.movement.walk=60;
 await addWound(a,'permanent',3);prepareWoundData(a);assert.equal(a.system.attributes.movement.walk,45);
 await addWound(a,'permanent',3);a.system.attributes.movement.walk=60;prepareWoundData(a);assert.equal(a.system.attributes.movement.walk,30);
});
test('lost-leg reductions use meters and preserve a positive minimum',()=>{
 const a=actor([['lostleg','permanent',3],['lostleg','permanent',3]]);
 a.system.attributes.movement={units:'m',walk:18.288,fly:0};prepareWoundData(a);assert.ok(Math.abs(a.system.attributes.movement.walk-9.144)<1e-9);
 const b=actor([['lostleg','permanent',3],['lostleg','permanent',3]]);prepareWoundData(b);assert.equal(b.system.attributes.movement.walk,5);
});
test('hesitant ignores unrelated or dismissed saves and triggers once on a fear save',async()=>{
 const a=actor([['hesitant','permanent',9]]);await a.setFlag(ID,'hesitantReady',true);
 const old=foundry.applications;const answers=['no',null,'fear'];
 foundry.applications={api:{DialogV2:{wait:async()=>answers.shift()}}};
 try {
  await checkHesitantSave(a);assert.equal(a.getFlag(ID,'hesitantReady'),true);assert.equal(a.effects.length,1);
  await checkHesitantSave(a);assert.equal(a.getFlag(ID,'hesitantReady'),true);
  await checkHesitantSave(a);assert.equal(a.getFlag(ID,'hesitantReady'),false);assert.ok(a.effects.some(e=>e.statuses.has('frightened')));
  await checkHesitantSave(a);assert.equal(a.effects.length,2);
 }finally{foundry.applications=old;}
});
test('treatment DC counts only grievous wounds and leaves permanent wounds',async()=>{
 const a=actor([['pain','grievous',6],['oldpain','permanent',10]]);await a.setFlag(ID,'treatmentAvailable',true);
 let dc;const old=foundry.applications;const actors=game.actors;
 game.actors=[a];game.actors.get=id=>id===a.id?a:undefined;
 a.rollSkill=async()=>[{total:11}];
 foundry.applications={api:{DialogV2:{wait:async config=>{dc=config.content;return {healer:a.id,kit:false};}}}};
 try {await treat(a);assert.match(dc,/СЛ: 11/);assert.equal(a.effects.length,1);assert.equal(a.effects[0].getFlag(ID,'wound').kind,'permanent');assert.equal(a.getFlag(ID,'treatmentAvailable'),false);}
 finally{foundry.applications=old;game.actors=actors;}
});

const painResult={kind:'grievous',key:6,entry:{id:'pain',name:'Pain',text:'test'}};
const closeResult={kind:'grievous',key:18,entry:{id:'close',name:'Close',text:'test'}};
const condition=(a,...statuses)=>a.createEmbeddedDocuments('ActiveEffect',[{statuses,flags:{}}]);
function captureDrop(a,result=painResult) {
 a.system.attributes.hp.value=10;
 const changes={'system.attributes.hp.value':0};preUpdate(a,changes,{});
 const saved=prop(changes,`flags.${ID}.pending`);saved.id='drop';saved.result=result;
 a.flags[ID]??={};a.flags[ID].pending=saved;a.system.attributes.hp.value=0;
 return saved;
}
test('drop snapshot records unconscious and prone before zero HP',async()=>{
 const a=actor();const [u]=await condition(a,'unconscious');const [p]=await condition(a,'prone');
 const saved=captureDrop(a);
 assert.deepEqual(saved.beforeConditions,{unconscious:{active:true,effectIds:[u.id]},prone:{active:true,effectIds:[p.id]}});
 assert.equal(a.system.attributes.hp.value,0);
});
test('fall preserves new unconsciousness and prone at zero HP',async()=>{
 const a=actor();captureDrop(a);await condition(a,'unconscious');await condition(a,'prone');
 const ids=a.effects.map(e=>e.id);await resolveChoice(a,'drop','fall');
 assert.equal(a.system.attributes.hp.value,0);assert.ok(a.statuses.has('unconscious'));assert.ok(a.statuses.has('prone'));
 assert.deepEqual(a.effects.map(e=>e.id),ids);
});
test('taking a wound clears only newly acquired drop conditions in all prior-state combinations',async()=>{
 for(const unconscious of [false,true])for(const prone of [false,true]) {
  const a=actor();if(unconscious)await condition(a,'unconscious');if(prone)await condition(a,'prone');
  const oldIds=a.effects.map(e=>e.id);captureDrop(a);
  if(!unconscious)await condition(a,'unconscious');if(!prone)await condition(a,'prone');
  await resolveChoice(a,'drop','wound');
  assert.equal(a.system.attributes.hp.value,1);assert.equal(a.statuses.has('unconscious'),unconscious);assert.equal(a.statuses.has('prone'),prone);
  for(const id of oldIds)assert.ok(a.effects.some(e=>e.id===id));
 }
});
test('shared effects keep unrelated statuses when drop conditions are removed',async()=>{
 const a=actor();captureDrop(a);const [shared]=await condition(a,'unconscious','prone','poisoned');
 await resolveChoice(a,'drop','wound');
 assert.deepEqual([...a.effects.find(e=>e.id===shared.id).statuses],['poisoned']);
});
test('effects with independent mechanical changes survive condition cleanup',async()=>{
 const a=actor();captureDrop(a);const [effect]=await a.createEmbeddedDocuments('ActiveEffect',[{statuses:['prone'],system:{changes:[{key:'test',value:1}]},flags:{}}]);
 await resolveChoice(a,'drop','wound');
 assert.ok(a.effects.some(e=>e.id===effect.id));assert.equal(effect.statuses.size,0);assert.equal(effect.system.changes.length,1);
});
test('close call removes new unconsciousness and always keeps prone without a wound record',async()=>{
 for(const alreadyProne of [false,true]) {
  const a=actor();if(alreadyProne)await condition(a,'prone');captureDrop(a,closeResult);
  await condition(a,'unconscious');if(!alreadyProne)await condition(a,'prone');
  await resolveChoice(a,'drop','wound');assert.equal(a.system.attributes.hp.value,1);
  assert.equal(a.statuses.has('unconscious'),false);assert.ok(a.statuses.has('prone'));
  assert.equal(a.effects.filter(e=>e.getFlag(ID,'wound')).length,0);
 }
});
test('close call preserves pre-existing unconsciousness',async()=>{
 const a=actor();await condition(a,'unconscious');captureDrop(a,closeResult);
 await resolveChoice(a,'drop','wound');assert.ok(a.statuses.has('unconscious'));assert.ok(a.statuses.has('prone'));assert.equal(a.system.attributes.hp.value,1);
});
test('fatal wound does not clear the consequences of falling',async()=>{
 const a=actor();captureDrop(a,{kind:'permanent',key:1,entry:{id:'fatal',name:'Fatal',text:'test'}});
 await condition(a,'unconscious');await condition(a,'prone');await resolveChoice(a,'drop','wound');
 assert.ok(a.statuses.has('unconscious'));assert.ok(a.statuses.has('prone'));assert.ok(a.statuses.has('dead'));assert.equal(a.system.attributes.hp.value,0);
});
test('legacy pending choice clears new unconsciousness but preserves unknown prior prone',async()=>{
 const a=actor();captureDrop(a);delete a.flags[ID].pending.beforeConditions;
 await condition(a,'unconscious');await condition(a,'prone');await resolveChoice(a,'drop','wound');
 assert.equal(a.statuses.has('unconscious'),false);assert.ok(a.statuses.has('prone'));
});

test('pre-existing conditions are restored if the system clears them on the one-HP update',async()=>{
 const a=actor();await condition(a,'unconscious');await condition(a,'prone');captureDrop(a);
 const update=a.update;a.update=async changes=>{await update(changes);if(changes['system.attributes.hp.value']===1)a.effects=a.effects.filter(e=>!e.statuses.has('unconscious')&&!e.statuses.has('prone'));return a;};
 await resolveChoice(a,'drop','wound');assert.ok(a.statuses.has('unconscious'));assert.ok(a.statuses.has('prone'));assert.equal(a.system.attributes.hp.value,1);
});
test('serialized pending snapshot still protects earlier conditions after reload',async()=>{
 const a=actor();const [prior]=await condition(a,'prone');captureDrop(a);
 a.flags[ID].pending=JSON.parse(JSON.stringify(a.flags[ID].pending));await condition(a,'unconscious');
 await resolveChoice(a,'drop','wound');assert.equal(a.statuses.has('unconscious'),false);assert.ok(a.effects.some(e=>e.id===prior.id));assert.ok(a.statuses.has('prone'));
});

// The final update seam models the same sync preUpdate + async update boundary
// used by Midi's GM damage application, including concentration loss at zero HP.
async function lastMomentCase(runCase,{answer='wound',raw=8,mode='chat',damage=60,hp=40,temp=0,failedSave=false}={}) {
 const savedSettings=game.settings.get, savedApps=foundry.applications, savedMidi=globalThis.MidiQOL, savedRoll=globalThis.Roll;
 const savedModule=game.modules.get('midi-qol');
 const a=actor();a.system.attributes.hp={value:hp,max:100,effectiveMax:100,tempmax:0,temp};
 a.concentration={effects:new Set(['spell'])};
 let ends=0, prompts=0;const checks=[],updates=[];
 a.endConcentration=async()=>{ends++;a.concentration.effects.clear();};
 a.getConcentrationDC=n=>Math.min(30,Math.max(10,Math.floor(n/2)));
 a.rollConcentration=async config=>{checks.push(config.target);if(failedSave)await a.endConcentration();return [{isFailure:failedSave}];};
 const midiSettings={doConcentrationCheck:mode,removeConcentration:true};
 globalThis.MidiQOL={configSettings:()=>midiSettings,doConcentrationCheck:async(actor,dc)=>{checks.push(dc);if(failedSave)await actor.endConcentration();}};
 game.settings.get=(id,key)=>id==='dnd5e'?false:key==='lastMoment'||savedSettings(id,key);
 game.modules.set('midi-qol',{active:true,version:'14.6.0'});
 foundry.applications={api:{DialogV2:{wait:async()=>{prompts++;return answer;}}}};
 globalThis.Roll=class{async evaluate(){this.total=raw;return this;}async toMessage(){}};
 const data={'system.attributes.hp.value':0,'system.attributes.hp.temp':0};
 const options={};hooks.get('dnd5e.preApplyDamage')[0](a,damage,data,options);
 const baseUpdate=a.update;
 const wrapped=async(d,o)=>{
  preUpdate(a,d,o);updates.push(structuredClone(d));
  await baseUpdate(d);
  if(prop(d,'system.attributes.hp.value')!==undefined && a.system.attributes.hp.value<=0){await a.endConcentration();await condition(a,'unconscious');await condition(a,'prone');}
  if(prop(d,'system.attributes.hp.value')!==undefined && !o.noConcentrationCheck && o.dnd5e?.concentrationCheck!==false && a.concentration.effects.size)await a.rollConcentration({target:a.getConcentrationDC(damage)});
  return a;
 };
 try {await runCase({a,data,options,wrapped,checks,updates,midiSettings,wireUpdate:()=>{a.update=(data,options={})=>applyDamageUpdate(a,wrapped,data,options);},get ends(){return ends},get prompts(){return prompts}});}
 finally {game.settings.get=savedSettings;foundry.applications=savedApps;globalThis.MidiQOL=savedMidi;globalThis.Roll=savedRoll;if(savedModule)game.modules.set('midi-qol',savedModule);else game.modules.delete('midi-qol');}
}
test('last moment accepts a wound without ever writing zero HP and checks full-damage concentration once',async()=>{
 await lastMomentCase(async c=>{
  await applyDamageUpdate(c.a,c.wrapped,c.data,c.options);
  assert.deepEqual(c.updates.map(d=>d['system.attributes.hp.value']),[1]);assert.equal(c.a.concentration.effects.size,1);assert.equal(c.ends,0);
  assert.deepEqual(c.checks,[30]);assert.equal(c.a.effects.filter(e=>e.getFlag(ID,'wound')).length,1);assert.equal(c.a.getFlag(ID,'pending'),undefined);
  assert.equal(c.data['system.attributes.hp.value'],0);assert.equal(c.options.noConcentrationCheck,undefined);
 });
});
test('last moment fall applies zero HP and conditions, breaks concentration, and adds existing death failures',async()=>{
 await lastMomentCase(async c=>{
  await addWound(c.a,'grievous',9);await addWound(c.a,'grievous',9);
  await applyDamageUpdate(c.a,c.wrapped,c.data,c.options);
  assert.equal(c.a.system.attributes.hp.value,0);assert.equal(c.a.system.attributes.death.failure,2);assert.equal(c.a.concentration.effects.size,0);
  assert.ok(c.a.statuses.has('unconscious'));assert.ok(c.a.statuses.has('prone'));assert.equal(c.a.getFlag(ID,'pending'),undefined);assert.equal(c.a.effects.filter(e=>e.getFlag(ID,'wound')).length,2);
 },{answer:'fall'});
});
test('last moment concussion ends concentration without a redundant concentration save',async()=>{
 await lastMomentCase(async c=>{
  await applyDamageUpdate(c.a,c.wrapped,c.data,c.options);assert.equal(c.a.system.attributes.hp.value,1);assert.equal(c.a.concentration.effects.size,0);assert.deepEqual(c.checks,[]);
 },{raw:7});
});
test('last moment fatal wound writes zero HP, death, and loss of concentration',async()=>{
 await lastMomentCase(async c=>{
  let rolls=[2,1];globalThis.Roll=class{async evaluate(){this.total=rolls.shift();return this;}async toMessage(){}};
  await applyDamageUpdate(c.a,c.wrapped,c.data,c.options);assert.equal(c.a.system.attributes.hp.value,0);assert.equal(c.a.system.attributes.death.failure,3);assert.ok(c.a.statuses.has('dead'));assert.equal(c.a.concentration.effects.size,0);assert.deepEqual(c.checks,[]);
 });
});
test('last moment close call leaves one HP and prone while retaining concentration after the save',async()=>{
 await lastMomentCase(async c=>{
  await applyDamageUpdate(c.a,c.wrapped,c.data,c.options);assert.equal(c.a.system.attributes.hp.value,1);assert.ok(c.a.statuses.has('prone'));assert.equal(c.a.statuses.has('unconscious'),false);assert.equal(c.a.effects.filter(e=>e.getFlag(ID,'wound')).length,0);assert.equal(c.a.concentration.effects.size,1);assert.deepEqual(c.checks,[30]);
 },{raw:18});
});
test('failed concentration save after accepted wound ends the spell while retaining one HP',async()=>{
 await lastMomentCase(async c=>{
  await applyDamageUpdate(c.a,c.wrapped,c.data,c.options);assert.equal(c.a.system.attributes.hp.value,1);assert.equal(c.a.concentration.effects.size,0);assert.deepEqual(c.checks,[30]);
 },{failedSave:true});
});
test('last moment item-mode concentration delegates once to Midi with the original damage DC',async()=>{
 await lastMomentCase(async c=>{await applyDamageUpdate(c.a,c.wrapped,c.data,c.options);assert.deepEqual(c.checks,[30]);assert.equal(c.a.system.attributes.hp.value,1);},{mode:'item'});
});
test('last moment preserves temp HP loss and uses full damage rather than the HP delta',async()=>{
 await lastMomentCase(async c=>{await applyDamageUpdate(c.a,c.wrapped,c.data,c.options);assert.equal(c.a.system.attributes.hp.temp,0);assert.equal(c.a.system.attributes.hp.value,1);assert.deepEqual(c.checks,[30]);},{hp:10,temp:20,damage:60});
});
test('last moment still checks concentration when the character already had one HP',async()=>{
 await lastMomentCase(async c=>{await applyDamageUpdate(c.a,c.wrapped,c.data,c.options);assert.equal(c.a.system.attributes.hp.value,1);assert.deepEqual(c.checks,[30]);},{hp:1});
});
test('closing the GM choice suspends before HP, concentration, or injuries change',async()=>{
 await lastMomentCase(async c=>{await assert.rejects(()=>applyDamageUpdate(c.a,c.wrapped,c.data,c.options),/приостановлено/);assert.equal(c.a.system.attributes.hp.value,40);assert.equal(c.a.concentration.effects.size,1);assert.equal(c.updates.length,0);assert.equal(c.a.effects.length,0);},{answer:null});
});
test('last moment refuses stale HP changes during the choice',async()=>{
 await lastMomentCase(async c=>{
  foundry.applications.api.DialogV2.wait=async()=>{c.a.system.attributes.hp.value=50;return 'wound';};
  await assert.rejects(()=>applyDamageUpdate(c.a,c.wrapped,c.data,c.options),/изменилось/);assert.equal(c.updates.length,0);assert.equal(c.a.effects.length,0);
 });
});
test('last moment resumes the saved wound after an interrupted final update without reroll or duplicate',async()=>{
 await lastMomentCase(async c=>{
  let rolls=0;globalThis.Roll=class{async evaluate(){rolls++;this.total=8;return this;}async toMessage(){}};
  await assert.rejects(()=>applyDamageUpdate(c.a,async()=>{throw Error('network interrupted')},c.data,c.options),/network interrupted/);
  assert.ok(c.a.getFlag(ID,'beforeDamage')?.result);assert.equal(c.a.effects.filter(e=>e.getFlag(ID,'wound')).length,1);
  await applyDamageUpdate(c.a,c.wrapped,c.data,c.options);assert.equal(rolls,1);assert.equal(c.a.effects.filter(e=>e.getFlag(ID,'wound')).length,1);assert.equal(c.a.getFlag(ID,'beforeDamage'),null);assert.equal(c.a.system.attributes.hp.value,1);
 });
});
test('last moment does not intercept manual HP edits without damage metadata',async()=>{
 await lastMomentCase(async c=>{await applyDamageUpdate(c.a,c.wrapped,c.data,{});assert.equal(c.prompts,0);assert.ok(c.a.getFlag(ID,'pending'));assert.equal(c.a.system.attributes.hp.value,0);});
});
test('last moment setting off retains the post-zero fallback',async()=>{
 await lastMomentCase(async c=>{const previous=game.settings.get;game.settings.get=(id,key)=>key==='lastMoment'?false:previous(id,key);await applyDamageUpdate(c.a,c.wrapped,c.data,c.options);assert.equal(c.prompts,0);assert.equal(c.a.system.attributes.hp.value,0);assert.ok(c.a.getFlag(ID,'pending'));});
});
test('nonlethal damage and damage to already-zero actors do not prompt early',async()=>{
 await lastMomentCase(async c=>{c.data['system.attributes.hp.value']=10;await applyDamageUpdate(c.a,c.wrapped,c.data,c.options);assert.equal(c.prompts,0);});
 await lastMomentCase(async c=>{c.a.system.attributes.hp.value=0;await applyDamageUpdate(c.a,c.wrapped,c.data,c.options);assert.equal(c.prompts,0);});
});
test('disabled concentration automation or explicit suppression is respected',async()=>{
 await lastMomentCase(async c=>{await applyDamageUpdate(c.a,c.wrapped,c.data,c.options);assert.deepEqual(c.checks,[]);},{mode:'none'});
 await lastMomentCase(async c=>{c.options.noConcentrationCheck=true;await applyDamageUpdate(c.a,c.wrapped,c.data,c.options);assert.deepEqual(c.checks,[]);});
});

test('last moment runs through the registered Actor.update wrapper with the synchronous damage tag',async()=>{
 await lastMomentCase(async c=>{
  const previous=globalThis.libWrapper;const registered=new Map();globalThis.libWrapper={register:(_id,path,fn)=>registered.set(path,fn)};
  try {
   for(const setup of hooks.get('setup'))setup();
   const update=registered.get('CONFIG.Actor.documentClass.prototype.update');assert.equal(typeof update,'function');
   await update.call(c.a,c.wrapped,c.data,c.options);assert.equal(c.a.system.attributes.hp.value,1);assert.equal(c.a.concentration.effects.size,1);assert.deepEqual(c.checks,[30]);
  }finally{globalThis.libWrapper=previous;}
 });
});
test('last moment preserves pre-existing prone and unconsciousness',async()=>{
 await lastMomentCase(async c=>{
  await condition(c.a,'unconscious');await condition(c.a,'prone');
  await applyDamageUpdate(c.a,c.wrapped,c.data,c.options);assert.ok(c.a.statuses.has('unconscious'));assert.ok(c.a.statuses.has('prone'));assert.equal(c.a.system.attributes.hp.value,1);
 });
});
test('last moment failure when concentration API is missing occurs before rolling or applying damage',async()=>{
 await lastMomentCase(async c=>{
  delete c.a.rollConcentration;await assert.rejects(()=>applyDamageUpdate(c.a,c.wrapped,c.data,c.options),/API/);assert.equal(c.updates.length,0);assert.equal(c.a.effects.length,0);assert.equal(c.a.system.attributes.hp.value,40);
 });
});
test('player window close transfers last-moment choice to GM while update waits',async()=>{
 await lastMomentCase(async c=>{
  const previous=game.users.filter;const owner={id:'player',active:true,isGM:false,character:c.a};
  game.users.filter=()=>[owner];c.a.testUserPermission=()=>true;
  let queried=false;foundry.applications.api.DialogV2.query=async who=>{assert.equal(who,owner);queried=true;assert.equal(c.a.system.attributes.hp.value,40);return null;};
  try{await applyDamageUpdate(c.a,c.wrapped,c.data,c.options);assert.ok(queried);assert.equal(c.prompts,1);assert.equal(c.a.system.attributes.hp.value,1);}
  finally{game.users.filter=previous;}
 });
});

test('last moment can resume a fatal outcome after failure before final damage commit',async()=>{
 await lastMomentCase(async c=>{
  let rolls=[2,1];globalThis.Roll=class{async evaluate(){this.total=rolls.shift();return this;}async toMessage(){}};
  await assert.rejects(()=>applyDamageUpdate(c.a,async()=>{throw Error('before commit')},c.data,c.options),/before commit/);
  assert.ok(c.a.statuses.has('dead'));await applyDamageUpdate(c.a,c.wrapped,c.data,c.options);
  assert.equal(c.a.system.attributes.hp.value,0);assert.equal(c.a.getFlag(ID,'beforeDamage'),null);assert.equal(c.a.effects.filter(e=>e.getFlag(ID,'wound')).length,1);
 });
});
test('last moment can resume after the new injury lowers the prepared HP maximum',async()=>{
 await lastMomentCase(async c=>{
  const create=c.a.createEmbeddedDocuments;c.a.createEmbeddedDocuments=async(...args)=>{const effects=await create(...args);prepareWoundData(c.a);return effects;};
  await assert.rejects(()=>applyDamageUpdate(c.a,async()=>{throw Error('before commit')},c.data,c.options),/before commit/);
  assert.equal(c.a.system.attributes.hp.value,85);
  await applyDamageUpdate(c.a,c.wrapped,c.data,c.options);assert.equal(c.a.system.attributes.hp.value,1);assert.equal(c.a.getFlag(ID,'beforeDamage'),null);assert.equal(c.a.effects.filter(e=>e.getFlag(ID,'wound')).length,1);
 },{raw:5,hp:95,damage:120});
});

test('Actor.update wrapper passes group actors without HP through untouched',async()=>{
 const group={type:'group',system:{}};let called=false;
 await applyDamageUpdate(group,async(data,options)=>{called=true;assert.deepEqual(data,{name:'Party'});return group;},{name:'Party'});
 assert.ok(called);
});

const externalUpdate=async(a,data)=>{preUpdate(a,data,{});await a.update(data);};
const until=async predicate=>{for(let i=0;i<40;i++){if(predicate())return;await new Promise(resolve=>setImmediate(resolve));}throw Error('condition was not reached');};
test('damage source keys are stable per workflow row and independent for a new attack using the same activity',()=>{
 const hook=hooks.get('midi-qol.preTargetDamageApplication')[0],token={document:{uuid:'Scene.s.Token.t'}};
 const workflow={id:'Actor.a.Item.i.Activity.x',actor:{uuid:'Actor.attacker'}},item={name:'Меч',uuid:'Actor.a.Item.i'};
 const one={calcDamageOptions:{}};hook(token,{workflow,item,damageItem:one});const first=one.calcDamageOptions.grievousWoundsDamage;
 hook(token,{workflow,item,damageItem:one});assert.equal(one.calcDamageOptions.grievousWoundsDamage.id,first.id);assert.equal(first.source.name,'Меч');
 const two={calcDamageOptions:{}};hook(token,{workflow:{...workflow},item,damageItem:two});assert.notEqual(two.calcDamageOptions.grievousWoundsDamage.id,first.id);
});
test('journal records a damage event, decision, source, result, and finalized state',async()=>{
 await lastMomentCase(async c=>{
  c.options.grievousWoundsDamage.source={name:'Тестовый меч',itemUuid:'Actor.foe.Item.sword'};
  await applyDamageUpdate(c.a,c.wrapped,c.data,c.options);const [event]=eventLog(c.a);
  assert.equal(event.id,c.options.grievousWoundsDamage.id);assert.equal(event.amount,60);assert.equal(event.source.name,'Тестовый меч');assert.equal(event.answer,'wound');assert.equal(event.result.entry.id,'laceration');assert.equal(event.finalized,true);assert.equal(event.before.hp,40);assert.equal(event.after.hp,1);
 });
});
test('repeat damage click on an applied event cannot apply HP or another wound again',async()=>{
 await lastMomentCase(async c=>{await applyDamageUpdate(c.a,c.wrapped,c.data,c.options);const count=c.updates.length;await applyDamageUpdate(c.a,c.wrapped,c.data,c.options);assert.equal(c.updates.length,count);assert.equal(c.a.system.attributes.hp.value,1);assert.equal(c.a.effects.filter(e=>e.getFlag(ID,'wound')).length,1);assert.equal(eventLog(c.a).length,1);});
});
test('repeat fall click at already zero HP cannot apply damage or death failures again',async()=>{
 await lastMomentCase(async c=>{await addWound(c.a,'grievous',9);await applyDamageUpdate(c.a,c.wrapped,c.data,c.options);const count=c.updates.length;await applyDamageUpdate(c.a,c.wrapped,c.data,c.options);assert.equal(c.updates.length,count);assert.equal(c.a.system.attributes.death.failure,1);},{answer:'fall'});
});
test('a new independent attack with identical damage remains a separate event',async()=>{
 await lastMomentCase(async c=>{
  await applyDamageUpdate(c.a,c.wrapped,c.data,c.options);
  const options={};hooks.get('dnd5e.preApplyDamage')[0](c.a,60,c.data,options);
  assert.notEqual(options.grievousWoundsDamage.id,c.options.grievousWoundsDamage.id);
  await applyDamageUpdate(c.a,c.wrapped,c.data,options);assert.equal(eventLog(c.a).length,2);assert.equal(c.a.effects.filter(e=>e.getFlag(ID,'wound')).length,2);
 });
});
test('another event cannot take over a suspended choice with the same damage amount',async()=>{
 await lastMomentCase(async c=>{
  await assert.rejects(()=>applyDamageUpdate(c.a,c.wrapped,c.data,c.options),/приостановлено/);
  const other={};hooks.get('dnd5e.preApplyDamage')[0](c.a,60,c.data,other);
  await assert.rejects(()=>applyDamageUpdate(c.a,c.wrapped,c.data,other),/другое/);assert.equal(c.a.system.attributes.hp.value,40);
 },{answer:null});
});
test('panel can resume a suspended choice after serialized reload without damage-card replay',async()=>{
 await lastMomentCase(async c=>{
  await assert.rejects(()=>applyDamageUpdate(c.a,c.wrapped,c.data,c.options),/приостановлено/);
  c.a.flags=JSON.parse(JSON.stringify(c.a.flags));foundry.applications.api.DialogV2.wait=async()=> 'wound';c.wireUpdate();
  await resumeDamage(c.a);assert.equal(c.a.system.attributes.hp.value,1);assert.equal(eventLog(c.a)[0].status,'applied');assert.equal(c.a.getFlag(ID,'beforeDamage'),null);
 },{answer:null});
});
test('panel can answer a live choice without a second operation and late replies do nothing',async()=>{
 await lastMomentCase(async c=>{
  let late;let calls=0;foundry.applications.api.DialogV2.wait=async()=>{calls++;return calls===1?new Promise(resolve=>{late=resolve;}):'wound';};
  const applying=applyDamageUpdate(c.a,c.wrapped,c.data,c.options);await until(()=>!!late);await resumeDamage(c.a);await applying;
  const snapshot=JSON.stringify(c.a.flags);late('fall');await new Promise(resolve=>setImmediate(resolve));assert.equal(JSON.stringify(c.a.flags),snapshot);assert.equal(eventLog(c.a).length,1);assert.equal(c.a.system.attributes.hp.value,1);
 });
});
test('resume completes post-commit conditions without applying HP twice',async()=>{
 await lastMomentCase(async c=>{
  const toggle=c.a.toggleStatusEffect;let fail=true;c.a.toggleStatusEffect=async(...args)=>{if(fail){fail=false;throw Error('condition interrupted');}return toggle(...args);};
  await assert.rejects(()=>applyDamageUpdate(c.a,c.wrapped,c.data,c.options),/condition interrupted/);
  assert.equal(c.a.getFlag(ID,'beforeDamage').phase,'committed');const count=c.updates.filter(d=>prop(d,'system.attributes.hp.value')!==undefined).length;
  await resumeDamage(c.a);assert.equal(c.updates.filter(d=>prop(d,'system.attributes.hp.value')!==undefined).length,count);assert.ok(c.a.statuses.has('prone'));assert.equal(eventLog(c.a)[0].finalized,true);
 },{raw:18});
});
test('undo restores HP and temp HP, deletes the event wound, and never resurrects concentration',async()=>{
 await lastMomentCase(async c=>{
  await applyDamageUpdate(c.a,c.wrapped,c.data,c.options);const id=eventLog(c.a)[0].id;await c.a.endConcentration();
  const plan=undoPreview(c.a,id);assert.match(plan.description,/40/);await undoEvent(c.a,id);
  assert.equal(c.a.system.attributes.hp.value,40);assert.equal(c.a.system.attributes.hp.temp,5);assert.equal(c.a.effects.filter(e=>e.getFlag(ID,'wound')).length,0);assert.equal(c.a.concentration.effects.size,0);assert.equal(eventLog(c.a)[0].status,'undone');
  await assert.rejects(()=>undoEvent(c.a,id),/отменён|недоступен/);
  await applyDamageUpdate(c.a,c.wrapped,c.data,c.options);assert.equal(c.a.system.attributes.hp.value,40);
 },{temp:5});
});
test('undo fall removes only newly acquired drop states and restores death failures',async()=>{
 await lastMomentCase(async c=>{
  await condition(c.a,'prone');const prior=c.a.effects[0].id;await addWound(c.a,'grievous',9);
  await applyDamageUpdate(c.a,c.wrapped,c.data,c.options);await undoEvent(c.a,eventLog(c.a)[0].id);
  assert.equal(c.a.system.attributes.hp.value,40);assert.equal(c.a.system.attributes.death.failure,0);assert.equal(c.a.statuses.has('unconscious'),false);assert.ok(c.a.effects.some(e=>e.id===prior));assert.ok(c.a.statuses.has('prone'));assert.equal(c.a.effects.filter(e=>e.getFlag(ID,'wound')).length,1);
 },{answer:'fall'});
});
test('undo preserves unrelated statuses in a shared drop-condition effect',async()=>{
 await lastMomentCase(async c=>{
  const wrapped=async(...args)=>{const result=await c.wrapped(...args);c.a.effects.find(e=>e.statuses.has('unconscious')).statuses.add('poisoned');return result;};
  await applyDamageUpdate(c.a,wrapped,c.data,c.options);const shared=c.a.effects.find(e=>e.statuses.has('poisoned'));await undoEvent(c.a,eventLog(c.a)[0].id);
  assert.ok(c.a.effects.some(e=>e.id===shared.id));assert.deepEqual([...shared.statuses],['poisoned']);assert.equal(c.a.statuses.has('prone'),false);
 },{answer:'fall'});
});
test('undo leaves unrelated new effects intact and blocks new sources of drop conditions',async()=>{
 await lastMomentCase(async c=>{
  await applyDamageUpdate(c.a,c.wrapped,c.data,c.options);const [foreign]=await condition(c.a,'poisoned');await undoEvent(c.a,eventLog(c.a)[0].id);assert.ok(c.a.effects.some(e=>e.id===foreign.id));
 });
 await lastMomentCase(async c=>{await applyDamageUpdate(c.a,c.wrapped,c.data,c.options);await condition(c.a,'prone');assert.throws(()=>undoPreview(c.a,eventLog(c.a)[0].id),/изменились/);});
});
test('undo restores the battered exhaustion level but blocks exhaustion from a later source',async()=>{
 await lastMomentCase(async c=>{await applyDamageUpdate(c.a,c.wrapped,c.data,c.options);assert.equal(c.a.system.attributes.exhaustion,1);await undoEvent(c.a,eventLog(c.a)[0].id);assert.equal(c.a.system.attributes.exhaustion,0);},{raw:10});
 await lastMomentCase(async c=>{await applyDamageUpdate(c.a,c.wrapped,c.data,c.options);await externalUpdate(c.a,{'system.attributes.exhaustion':2});assert.throws(()=>undoPreview(c.a,eventLog(c.a)[0].id),/изменились/);assert.equal(c.a.system.attributes.exhaustion,2);},{raw:10});
});
test('later damage followed by healing to the same HP still prevents stale undo',async()=>{
 await lastMomentCase(async c=>{await applyDamageUpdate(c.a,c.wrapped,c.data,c.options);await externalUpdate(c.a,{'system.attributes.hp.value':0});await externalUpdate(c.a,{'system.attributes.hp.value':1});assert.equal(c.a.system.attributes.hp.value,1);assert.throws(()=>undoPreview(c.a,eventLog(c.a)[0].id),/изменились|поздний/);},{raw:6});
});
test('Midi health undo is recognized without doubling HP restoration or losing the wound undo',async()=>{
 await lastMomentCase(async c=>{
  await applyDamageUpdate(c.a,c.wrapped,c.data,c.options);const id=eventLog(c.a)[0].id;
  const data={'system.attributes.hp.value':40,'system.attributes.hp.temp':0},options=structuredClone(c.options);
  hooks.get('dnd5e.preApplyDamage')[0](c.a,-60,data,options);await applyDamageUpdate(c.a,c.wrapped,data,options);
  assert.equal(c.a.system.attributes.hp.value,40);assert.equal(undoPreview(c.a,id).alreadyRestored,true);
  await undoEvent(c.a,id);assert.equal(c.a.system.attributes.hp.value,40);assert.equal(c.a.effects.filter(e=>e.getFlag(ID,'wound')).length,0);
 });
});
test('interrupted undo can resume after wound deletion without decrementing exhaustion twice',async()=>{
 await lastMomentCase(async c=>{
  await applyDamageUpdate(c.a,c.wrapped,c.data,c.options);const id=eventLog(c.a)[0].id,update=c.a.update;let fail=true;
  c.a.update=async(data,options)=>{if(fail&&prop(data,'system.attributes.hp.value')!==undefined){fail=false;throw Error('undo interrupted');}return update(data,options);};
  await assert.rejects(()=>undoEvent(c.a,id),/undo interrupted/);assert.equal(eventLog(c.a)[0].status,'undoing');await undoEvent(c.a,id);assert.equal(c.a.system.attributes.hp.value,40);assert.equal(c.a.system.attributes.exhaustion,0);
 },{raw:10});
});
test('undo resume stops if there was an external edit after interruption',async()=>{
 await lastMomentCase(async c=>{
  await applyDamageUpdate(c.a,c.wrapped,c.data,c.options);const id=eventLog(c.a)[0].id,update=c.a.update;let fail=true;
  c.a.update=async(data,options)=>{if(fail&&prop(data,'system.attributes.hp.value')!==undefined){fail=false;throw Error('undo interrupted');}return update(data,options);};
  await assert.rejects(()=>undoEvent(c.a,id),/undo interrupted/);await externalUpdate(c.a,{'system.attributes.hp.value':17});await assert.rejects(()=>undoEvent(c.a,id),/состояние изменилось/);assert.equal(c.a.system.attributes.hp.value,17);
 });
});
test('suspended damage can be undone or abandoned from the UI operations without flag editing',async()=>{
 await lastMomentCase(async c=>{await assert.rejects(()=>applyDamageUpdate(c.a,c.wrapped,c.data,c.options),/приостановлено/);await undoEvent(c.a,eventLog(c.a)[0].id);assert.equal(c.a.getFlag(ID,'beforeDamage'),null);assert.equal(c.a.system.attributes.hp.value,40);},{answer:null});
 await lastMomentCase(async c=>{await assert.rejects(()=>applyDamageUpdate(c.a,c.wrapped,c.data,c.options),/приостановлено/);await externalUpdate(c.a,{'system.attributes.hp.value':17});await abandonDamage(c.a);assert.equal(c.a.getFlag(ID,'beforeDamage'),null);assert.equal(c.a.system.attributes.hp.value,17);assert.equal(eventLog(c.a)[0].status,'abandoned');},{answer:null});
});
test('fallback resolution journals the pre-drop state and supports full undo',async()=>{
 const a=actor();a.system.attributes.hp.value=12;const d={'system.attributes.hp.value':0};preUpdate(a,d,{});await a.update(d);await condition(a,'unconscious');await condition(a,'prone');
 const id=a.getFlag(ID,'pending').id;a.flags[ID].pending.result=painResult;
 await resolveChoice(a,id,'wound');assert.equal(eventLog(a)[0].mode,'after');assert.equal(eventLog(a)[0].before.hp,12);await undoEvent(a,id);assert.equal(a.system.attributes.hp.value,12);assert.equal(a.statuses.has('unconscious'),false);assert.equal(a.effects.filter(e=>e.getFlag(ID,'wound')).length,0);
});
test('unanswered fallback drop can be undone safely from the journal',async()=>{
 const a=actor();a.system.attributes.hp.value=12;const d={'system.attributes.hp.value':0};preUpdate(a,d,{});await a.update(d);await condition(a,'unconscious');await condition(a,'prone');const id=a.getFlag(ID,'pending').id;
 await undoEvent(a,id);assert.equal(a.system.attributes.hp.value,12);assert.equal(a.statuses.has('unconscious'),false);assert.equal(a.statuses.has('prone'),false);assert.equal(a.getFlag(ID,'pending'),null);
});
test('audit refresh changes only text/schema and never re-applies battered exhaustion',async()=>{
 const a=actor([['battered','grievous',10]]);a.system.attributes.exhaustion=2;const e=a.effects[0];e.description='old';
 assert.equal(auditWounds(a)[0].type,'refresh');await repairWound(a,e.id);assert.equal(a.system.attributes.exhaustion,2);assert.equal(e.getFlag(ID,'wound').schema,1);assert.equal(auditWounds(a).length,0);
});
test('old pain duplicate repair uses the lower table entry and is idempotent',async()=>{
 const a=actor([['oldpain','permanent',10],['oldpain','permanent',10]]);const duplicate=a.effects[1].id;
 const plan=auditWounds(a).find(i=>i.effectId===duplicate);assert.equal(plan.type,'replace');assert.equal(plan.key,9);
 await repairWound(a,duplicate);assert.equal(a.effects.filter(e=>e.getFlag(ID,'wound')?.id==='oldpain').length,1);assert.equal(a.effects.filter(e=>e.getFlag(ID,'wound')?.id==='hesitant').length,1);
 await assert.rejects(()=>repairWound(a,duplicate),/больше не требуется/);assert.equal(a.effects.length,2);
});
test('duplicate repair resumes its saved replacement after failure deleting the old effect',async()=>{
 const a=actor([['oldpain','permanent',10],['oldpain','permanent',10]]);const id=a.effects[1].id,del=a.deleteEmbeddedDocuments;let fail=true;
 a.deleteEmbeddedDocuments=async(...args)=>{if(fail){fail=false;throw Error('delete interrupted');}return del(...args);};
 await assert.rejects(()=>repairWound(a,id),/delete interrupted/);await repairWound(a,id);assert.equal(a.effects.filter(e=>e.getFlag(ID,'wound')?.id==='hesitant').length,1);assert.equal(a.effects.filter(e=>e.getFlag(ID,'wound')?.id==='oldpain').length,1);
});
test('old Close Call repair removes only wound tracking while preserving the condition',async()=>{
 const a=actor([['close','grievous',18]]);a.effects[0].statuses.add('prone');await repairWound(a,a.effects[0].id);assert.ok(a.statuses.has('prone'));assert.equal(a.effects.filter(e=>e.getFlag(ID,'wound')).length,0);
});
test('compact panel exposes journal, resume, audit, and individual removal with no silent migrations',async()=>{
 const a=actor([['oldpain','permanent',10],['oldpain','permanent',10]]);a.isOwner=true;
 const previous=foundry.applications;let panel;foundry.applications={api:{DialogV2:{wait:async config=>{panel=config;return 'close';}}}};
 const state=JSON.stringify(a.flags),effects=a.effects.length;
 try{await open(a);assert.match(panel.content,/<details/);assert.match(panel.content,/×2/);assert.ok(panel.buttons.some(b=>b.action==='journal'));assert.ok(panel.buttons.some(b=>b.action==='audit'));assert.ok(panel.buttons.some(b=>b.action==='remove'));assert.equal(JSON.stringify(a.flags),state);assert.equal(a.effects.length,effects);}
 finally{foundry.applications=previous;}
});

test('undo a fatal outcome restores health and removes death without restoring spells',async()=>{
 await lastMomentCase(async c=>{
  let rolls=[2,1];globalThis.Roll=class{async evaluate(){this.total=rolls.shift();return this;}async toMessage(){}};
  await applyDamageUpdate(c.a,c.wrapped,c.data,c.options);await undoEvent(c.a,eventLog(c.a)[0].id);
  assert.equal(c.a.system.attributes.hp.value,40);assert.equal(c.a.system.attributes.death.failure,0);assert.equal(c.a.statuses.has('dead'),false);assert.equal(c.a.concentration.effects.size,0);
 });
});
test('undo restores the readiness flag changed by a newly acquired Hesitant wound',async()=>{
 await lastMomentCase(async c=>{
  let rolls=[2,9];globalThis.Roll=class{async evaluate(){this.total=rolls.shift();return this;}async toMessage(){}};
  await applyDamageUpdate(c.a,c.wrapped,c.data,c.options);assert.equal(c.a.getFlag(ID,'hesitantReady'),true);await undoEvent(c.a,eventLog(c.a)[0].id);assert.equal(c.a.getFlag(ID,'hesitantReady'),null);
 });
});
test('damage receipts still prevent replay after detailed journal entries were pruned',async()=>{
 await lastMomentCase(async c=>{await applyDamageUpdate(c.a,c.wrapped,c.data,c.options);await c.a.setFlag(ID,'events',[]);const count=c.updates.length;await applyDamageUpdate(c.a,c.wrapped,c.data,c.options);assert.equal(c.updates.length,count);assert.equal(c.a.system.attributes.hp.value,1);});
});
test('undoing an older event is blocked while a later independent attack is still applied',async()=>{
 await lastMomentCase(async c=>{await applyDamageUpdate(c.a,c.wrapped,c.data,c.options);const first=eventLog(c.a)[0].id;const options={};hooks.get('dnd5e.preApplyDamage')[0](c.a,60,c.data,options);await applyDamageUpdate(c.a,c.wrapped,c.data,options);assert.throws(()=>undoPreview(c.a,first),/поздний/);});
});
test('cancelling the journal undo confirmation leaves all state intact',async()=>{
 await lastMomentCase(async c=>{
  await applyDamageUpdate(c.a,c.wrapped,c.data,c.options);const event=eventLog(c.a)[0],before=JSON.stringify(c.a.flags);const count=c.a.effects.length;let calls=0;let preview;
  foundry.applications.api.DialogV2.wait=async()=>++calls===1?'undo':event.id;
  foundry.applications.api.DialogV2.confirm=async config=>{preview=config.content;return false;};
  await openJournal(c.a);assert.match(preview,/Глубокий порез/);assert.match(preview,/Концентрация/);assert.equal(JSON.stringify(c.a.flags),before);assert.equal(c.a.effects.length,count);assert.equal(c.a.system.attributes.hp.value,1);
 });
});
test('cancelling an old-wound repair confirmation makes no changes',async()=>{
 const a=actor([['oldpain','permanent',10],['oldpain','permanent',10]]);a.isOwner=true;const id=a.effects[1].id;
 const previous=foundry.applications;let calls=0,preview;foundry.applications={api:{DialogV2:{wait:async()=>['audit',id,'close'][calls++],confirm:async config=>{preview=config.content;return false;}}}};
 try{const flags=JSON.stringify(a.flags);await open(a);assert.match(preview,/Нерешительность/);assert.equal(a.effects.length,2);assert.equal(JSON.stringify(a.flags),flags);assert.equal(a.effects[1].getFlag(ID,'repair'),undefined);}
 finally{foundry.applications=previous;}
});
test('grouped wounds still allow removal of one specific instance',async()=>{
 const a=actor([['internal','grievous',5],['internal','grievous',5]]);a.isOwner=true;const id=a.effects[1].id,kept=a.effects[0].id;
 const previous=foundry.applications;let calls=0;let selector;foundry.applications={api:{DialogV2:{wait:async config=>{calls++;if(calls===1)return 'remove';if(calls===2){selector=config.content;return id;}return 'close';},confirm:async()=>true}}};
 try{await open(a);assert.match(selector,new RegExp(id));assert.match(selector,new RegExp(kept));assert.equal(a.effects.length,1);assert.equal(a.effects[0].id,kept);}
 finally{foundry.applications=previous;}
});
test('management mutation APIs reject player execution',async()=>{
 const a=actor();game.user.isGM=false;
 try{await assert.rejects(()=>undoEvent(a,'event'),/мастер/);await assert.rejects(()=>resumeDamage(a),/мастер/);await assert.rejects(()=>repairWound(a,'effect'),/мастер/);await assert.rejects(()=>abandonDamage(a),/мастер/);}
 finally{game.user.isGM=true;}
});
test('manual wound changes are blocked until the suspended choice is resolved',async()=>{
 await lastMomentCase(async c=>{await assert.rejects(()=>applyDamageUpdate(c.a,c.wrapped,c.data,c.options),/приостановлено/);await assert.rejects(()=>addWound(c.a,'grievous',10),/Сначала/);assert.equal(c.a.system.attributes.exhaustion,0);},{answer:null});
});
test('Battered side effects resume after effect creation without doubling exhaustion',async()=>{
 await lastMomentCase(async c=>{
  const update=c.a.update;let fail=true;c.a.update=async(data,options)=>{if(fail&&prop(data,'system.attributes.exhaustion')!==undefined){fail=false;throw Error('exhaustion interrupted');}return update(data,options);};
  await assert.rejects(()=>applyDamageUpdate(c.a,c.wrapped,c.data,c.options),/exhaustion interrupted/);assert.equal(c.a.effects.filter(e=>e.getFlag(ID,'wound')).length,1);assert.equal(c.a.system.attributes.exhaustion,0);
  await applyDamageUpdate(c.a,c.wrapped,c.data,c.options);assert.equal(c.a.system.attributes.exhaustion,1);assert.equal(c.a.effects.filter(e=>e.getFlag(ID,'wound')).length,1);
 },{raw:10});
});

test('undo refuses to remove an event wound whose effect gained unrelated mechanics later',async()=>{
 await lastMomentCase(async c=>{await applyDamageUpdate(c.a,c.wrapped,c.data,c.options);const effect=c.a.effects.find(e=>e.getFlag(ID,'wound'));effect.system.changes.push({key:'system.attributes.ac.bonus',value:1});assert.throws(()=>undoPreview(c.a,eventLog(c.a)[0].id),/изменились/);assert.ok(c.a.effects.includes(effect));});
});
test('undo refuses later mechanical changes to a drop-condition effect',async()=>{
 await lastMomentCase(async c=>{await applyDamageUpdate(c.a,c.wrapped,c.data,c.options);const effect=c.a.effects.find(e=>e.statuses.has('unconscious'));effect.system={changes:[{key:'unrelated',value:1}]};assert.throws(()=>undoPreview(c.a,eventLog(c.a)[0].id),/изменились/);assert.ok(c.a.effects.includes(effect));},{answer:'fall'});
});
