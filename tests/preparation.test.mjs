import {test} from 'node:test';
import assert from 'node:assert/strict';

// Narrow lifecycle double: dnd5e 6.0.6 CharacterData/NPCData add class levels
// in prepareBaseData; CommonTemplate.shimBonusData creates non-configurable
// getters. Only reset/initialization rebuilds the underlying model from source.
// This is not a Foundry/DAE implementation. The actual 6.0.6 methods were also
// executed separately during diagnosis; see docs/actor-preparation.md.
const hooks = new Map();
const on = (name,fn)=>hooks.set(name,[...(hooks.get(name)??[]),fn]);
globalThis.Hooks = {on,once:on};
const fire = name=>{for(const fn of hooks.get(name)??[])fn();};
globalThis.foundry = {utils:{getProperty:(o,p)=>p.split('.').reduce((a,k)=>a?.[k],o)}};
globalThis.CONFIG = {statusEffects:[]};
globalThis.canvas = {tokens:{placeables:[]}};
const notices = [];
globalThis.ui = {notifications:{info:message=>notices.push(message),warn:()=>{},error:()=>{}}};
globalThis.game = {
 system:{id:'dnd5e',version:'6.0.6'},settings:{register(){}},actors:[],
 user:{id:'gm',isGM:true},users:Object.assign([{id:'player',isGM:false}],{activeGM:{id:'gm'}}),
 modules:new Map([['grievous-wounds',{}],['dae',{active:true}],['midi-qol',{active:true}]])
};
const registrations = new Map();
let actorNumber=0;
class LifecycleActor {
 constructor(type='character',wounds=[]) {
  this.type=type;this.uuid=`Actor.${type}${++actorNumber}`;this.name=this.uuid;this.flags={};
  this._source={classLevels:type==='character'?3:0,system:{details:{level:0},attributes:{
   hp:{value:35,max:40,effectiveMax:40,tempmax:0},movement:{walk:30,fly:0,units:'ft'},
   concentration:{bonuses:{},roll:{bonus:'1'}}
  }}};
  this.effects=wounds.map(wound=>({disabled:false,getFlag:()=>wound}));
 }
 getFlag(_id,key){return this.flags[key];}
 testUserPermission(){return true;}
 prepareData(marker) {
  this.system.details.level+=this._source.classLevels;
  const concentration=this.system.attributes.concentration;
  Object.defineProperty(concentration.bonuses,'save',{get:()=>concentration.roll.bonus});
  return marker;
 }
 reset() {this.system=structuredClone(this._source.system);return this.prepareData('prepared');}
 update(){}
 _rest(){}
 initiateRest(){}
}
CONFIG.Actor={documentClass:LifecycleActor};
// Model libWrapper's chained `this` / args / return contract, including another
// package's derived adjustment. Do not mistake this for running DAE itself.
const corePrepare=LifecycleActor.prototype.prepareData;
LifecycleActor.prototype.prepareData=function(...args) {
 const result=corePrepare.apply(this,args);
 this.system.attributes.hp.max+=2;this.system.attributes.hp.effectiveMax+=2;
 this.system.attributes.movement.walk+=5;
 return result;
};
globalThis.libWrapper={register:(id,path,fn,type)=>{
 assert.equal(id,'grievous-wounds');assert.equal(type,'WRAPPER');
 assert.ok(!registrations.has(path),'wrapper must be registered only once');
 registrations.set(path,fn);
 const key=path.split('.').at(-1),previous=LifecycleActor.prototype[key];
 LifecycleActor.prototype[key]=function(...args){return fn.call(this,previous.bind(this),...args);};
}};
await import('../scripts/main.mjs');

test('init preparation applies saved wounds before setup, including an unlinked token',()=>{
 fire('init');
 const wounded=new LifecycleActor('character',[{id:'internal'},{id:'lostleg',kind:'permanent'}]);
 const healthy=new LifecycleActor();const npc=new LifecycleActor('npc');
 const synthetic=new LifecycleActor('character',[{id:'lungs',kind:'permanent'}]);
 synthetic.uuid='Scene.test.Token.unlinked.Actor.synthetic';
 for(const actor of [wounded,healthy,npc,synthetic])actor.reset();
 game.actors=[wounded,healthy,npc];canvas.tokens.placeables=[{actor:wounded},{actor:synthetic}];
 wounded.flags.pending={id:'pending'};
 // With the other package's +2 HP/+5 speed, internal bleeding at level 3
 // is 42-9=33 HP and one lost leg is 35-15=20 feet on the FIRST preparation.
 assert.equal(wounded.system.attributes.hp.max,33);
 assert.equal(wounded.system.attributes.movement.walk,20);
 assert.equal(synthetic.system.attributes.hp.max,39);
 assert.equal(healthy.system.details.level,3);
 assert.equal(npc.system.details.level,0);
});

test('ready does not reprepare loaded characters or NPCs and still exposes API and reminders',()=>{
 fire('setup');
 assert.doesNotThrow(()=>fire('ready'));
 const [wounded,healthy,npc]=game.actors;const synthetic=canvas.tokens.placeables[1].actor;
 assert.equal(wounded.system.details.level,3);assert.equal(healthy.system.details.level,3);
 assert.equal(wounded.system.attributes.hp.max,33);assert.equal(synthetic.system.attributes.hp.max,39);
 assert.equal(typeof game.modules.get('grievous-wounds').api.open,'function');
 assert.equal(notices.length,1,'pending choice reminder still works');
 assert.deepEqual([...registrations.keys()].sort(),[
  'CONFIG.Actor.documentClass.prototype._rest','CONFIG.Actor.documentClass.prototype.initiateRest',
  'CONFIG.Actor.documentClass.prototype.prepareData','CONFIG.Actor.documentClass.prototype.update'
 ]);
});

test('source rebuilds recalculate wounds once after data and effect changes',()=>{
 const actor=new LifecycleActor('character',[{id:'internal'},{id:'lostleg',kind:'permanent'}]);
 actor.reset();
 for(let i=0;i<3;i++) {
  assert.equal(actor.reset(),'prepared');
  assert.equal(actor.system.details.level,3);assert.equal(actor.system.attributes.hp.max,33);
  assert.equal(actor.system.attributes.movement.walk,20);
 }
 actor._source.classLevels=4;actor._source.system.attributes.hp.max=50;
 actor._source.system.attributes.hp.effectiveMax=50;
 actor.reset();assert.equal(actor.system.details.level,4);assert.equal(actor.system.attributes.hp.max,40);
 actor.effects[0].disabled=true;actor.reset();assert.equal(actor.system.attributes.hp.max,52);
 actor.effects[0].disabled=false;actor.reset();assert.equal(actor.system.attributes.hp.max,40);
 actor.effects=[];actor.reset();assert.equal(actor.system.attributes.hp.max,52);
 assert.equal(actor.system.attributes.movement.walk,35);
 assert.equal(actor._source.system.attributes.hp.max,50);
 assert.equal(actor._source.system.attributes.hp.value,35);
 assert.equal(actor._source.system.attributes.movement.walk,30);
});
