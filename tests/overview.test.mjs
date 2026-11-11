import {test} from 'node:test';
import assert from 'node:assert/strict';
import {overviewRows,unfinished,grievousSnapshot,showOverview} from '../scripts/overview.mjs';
const wound=(kind='grievous',disabled=false)=>({id:Math.random().toString(),disabled,getFlag:()=>({kind,id:'pain',key:6})});
const actor=(uuid,effects=[],flags={},owner=true,type='character')=>({uuid,name:uuid,type,effects,getFlag:(_id,k)=>flags[k],testUserPermission:()=>owner});
test('overview includes offline owners, disabled wounds and pending-only actors; excludes NPCs and unowned',()=>{
 const a=actor('a',[wound('grievous',true)]),b=actor('b',[],{pending:{}});
 assert.deepEqual(overviewRows([a,b,actor('npc',[wound()],{},true,'npc'),actor('gm',[wound()],{},false)],[],[{isGM:false,active:false}]).map(r=>r.actor.uuid),['b','a']);
});
test('linked actors deduplicate; synthetic actors retain scene identity',()=>{
 const a=actor('a',[wound()]),b=actor('Scene.s.Token.t.Actor.a',[wound()]);
 const rows=overviewRows([a],[{name:'Scene',tokens:[{name:'linked',actor:a},{name:'copy',actor:b}]}],[{isGM:false}]);
 assert.equal(rows.length,2);assert.equal(rows.find(r=>r.actor===b).location,'Scene / copy');
});
test('unfinished detects flags, interrupted undo and committed events without flags',()=>{
 for(const flags of [{beforeDamage:{}},{pending:{}},{events:[{status:'undoing'}]},{events:[{status:'applied',finalized:false}]}])assert.ok(unfinished(actor('a',[],flags)).length);
 assert.equal(unfinished(actor('a',[],{events:[{status:'applied',finalized:true}]})).length,0);
});
test('healing snapshot includes disabled grievous wounds only and detects edits',()=>{
 const a=actor('a',[wound(),wound('grievous',true),wound('permanent')]);
 const snap=grievousSnapshot(a);assert.equal(snap.ids.length,2);
 a.effects[0].disabled=true;assert.notEqual(grievousSnapshot(a).signature,snap.signature);
});
test('overview renders pending-only actor safely, reuses its window, and removes subscriptions on close',async()=>{
 const listeners=new Map();let id=0;
 globalThis.Hooks={on:(name,fn)=>{listeners.set(++id,{name,fn});return id;},off:(_name,id)=>listeners.delete(id)};
 globalThis.foundry={applications:{api:{ApplicationV2:class {
  async render(){this.rendered=true;this.html=await this._renderHTML();}bringToFront(){this.front=true;}
 }}}};
 const a=actor('<b>A</b>',[],{pending:{id:'p'}});a.system={attributes:{hp:{value:0,effectiveMax:40}},details:{level:3}};
 globalThis.game={user:{isGM:true},actors:[a],scenes:[],users:[{isGM:false}]};
 const app=showOverview({});await app.render();app._onFirstRender();
 assert.match(app.html,/&lt;b&gt;A&lt;\/b&gt;/);assert.match(app.html,/data-gw-action="resolve"/);
 assert.equal(showOverview({}),app);assert.equal(app.front,true);assert.ok(listeners.size>0);
 app._onClose();assert.equal(listeners.size,0);
 game.user.isGM=false;assert.throws(()=>showOverview({}));
});
