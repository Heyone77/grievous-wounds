import {test} from 'node:test';
import assert from 'node:assert/strict';
import {GRIEVOUS,PERMANENT,resolveGrievous,resolvePermanent,countGrievous,countWounds,muscleDie,movementPenalty,hpPenalty,escapeHTML} from '../scripts/rules.mjs';
const wound=(id,kind='grievous')=>({id,kind});
test('all 2d10 results map to the provided table',()=>{
 for(let raw=2;raw<=20;raw++) {
  const r=resolveGrievous(raw,[]);
  assert.equal(r.kind,raw<=3?'permanent':'grievous');
  if(raw>3) assert.equal(r.key,Math.min(raw,18));
 }
});
test('subtract only grievous wounds before looking up the result',()=>{
 const records=[wound('deep'),wound('wrist'),wound('eye','permanent')];
 assert.equal(countWounds(records),3);
 assert.equal(resolveGrievous(15,records).entry.id,'shock');
});
test('duplicate nonrepeatable result goes down without a reroll',()=>{
 const r=resolveGrievous(8,[wound('pain')]);
 assert.equal(r.adjusted,7);assert.equal(r.entry.id,'concussion');
 const repeated=resolveGrievous(7,[wound('pain')]);
 assert.equal(repeated.entry.id,'internal');
});
test('skip a chain of occupied results into permanent wound',()=>{
 const records=['festering','pain','concussion','laceration'].map(id=>wound(id));
 assert.equal(resolveGrievous(8,records).kind,'permanent');
});
test('repeatable results remain repeatable',()=>{
 for(const [key,e] of Object.entries(GRIEVOUS)) if(e.stack && e.id!=='close') {
  const r=resolveGrievous(Number(key)+1,[wound(e.id)]);
  assert.equal(r.entry.id,e.id);
 }
});
test('muscle progression is d4 d6 d8 d10 d12; sixth injury becomes leg',()=>{
 for(let i=1;i<=5;i++) assert.equal(muscleDie(Array.from({length:i},()=>wound('muscle'))),2+i*2);
 const records=Array.from({length:5},()=>wound('muscle'));
 assert.equal(resolveGrievous(20,records).entry.id,'leg');
});
test('maximum HP penalty scales with level and lung injuries',()=>{
 assert.equal(hpPenalty([wound('internal'),wound('lungs','permanent')],5),20);
 assert.equal(hpPenalty([wound('lungs','permanent'),wound('lungs','permanent')],6),12);
});
test('lost legs subtract fifteen feet each; injured-leg penalty does not multiply',()=>{
 assert.deepEqual(movementPenalty([wound('leg'),wound('leg')]),{feet:10});
 assert.deepEqual(movementPenalty([wound('leg'),wound('lostleg')]),{feet:15});
 assert.deepEqual(movementPenalty([wound('lostleg'),wound('lostleg')]),{feet:30});
});
test('close call has no persistent wound count',()=>assert.equal(countWounds([wound('close')]),0));
test('permanent table has all ten outcomes',()=>assert.deepEqual(Object.keys(PERMANENT).map(Number),[1,2,3,4,5,6,7,8,9,10]));
test('escape names inserted in HTML',()=>assert.equal(escapeHTML('<img x="&">'), '&lt;img x=&quot;&amp;&quot;&gt;'));

test('permanent duplicates descend through occupied results without rerolling',()=>{
 const records=['oldpain','hesitant','adrenaline','scar','lungs','dizzy'].map(id=>wound(id,'permanent'));
 assert.equal(resolvePermanent(10,[wound('oldpain','permanent')]).key,9);
 assert.equal(resolvePermanent(10,records).key,4);
 assert.equal(resolvePermanent(10,[...records,wound('eye','permanent')]).key,4);
 for(const key of [2,3,4]) assert.equal(resolvePermanent(key,[wound(PERMANENT[key].id,'permanent')]).key,key);
 assert.equal(resolvePermanent(1,[]).entry.id,'fatal');
});
test('permanent wounds never alter grievous roll or treatment count',()=>{
 const records=[wound('deep'),wound('oldpain','permanent'),wound('eye','permanent')];
 assert.equal(countGrievous(records),1);
 assert.equal(resolveGrievous(11,records).key,10);
 assert.equal(resolveGrievous(8,[wound('concussion'),wound('oldpain','permanent')]).key,6);
});
test('repeated internal bleeding stacks maximum HP reduction',()=>{
 assert.equal(resolveGrievous(6,[wound('internal')]).key,5);
 assert.equal(hpPenalty([wound('internal'),wound('internal')],5),30);
});
