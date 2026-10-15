import {test} from 'node:test';
import assert from 'node:assert/strict';
import {GRIEVOUS,PERMANENT} from '../scripts/rules.mjs';
import {choicePrice,priceHTML,compactWounds,auditRecords,appendEvent} from '../scripts/management.mjs';
const r=(id,key,kind='grievous',extra={})=>({id,key,kind,effectId:'effect-'+Math.random(),...extra});
test('choice price shows current death failures, added failures, and death at three',()=>{
 const wounds=[r('deep',9),r('deep',9),r('oldpain',10,'permanent'),r('deep',9,'grievous',{disabled:true})];
 assert.deepEqual(choicePrice(wounds,1),{penalty:2,added:2,failures:3,fatal:true});assert.match(priceHTML(wounds,1),/смерть/);assert.match(priceHTML(wounds,1),/2d10 - 2/);
});
test('compact groups report internal bleeding total at level five and retain instance IDs',()=>{
 const html=compactWounds([r('internal',5,'grievous',{effectId:'one'}),r('internal',5,'grievous',{effectId:'two'})],5);
 assert.match(html,/×2/);assert.match(html,/-30 максимальных HP/);assert.match(html,/one/);assert.match(html,/two/);assert.equal((html.match(/<details/g)||[]).length,1);
});
test('disabled groups are separate and untrusted HTML is escaped',()=>{
 const html=compactWounds([r('internal',5),r('internal',5,'grievous',{disabled:true}),r('<img>',99)]);
 assert.equal((html.match(/<details/g)||[]).length,3);assert.match(html,/Отключено/);assert.ok(!html.includes('<img>'));
});
test('audit duplicate old pain plans next lower unoccupied permanent entry',()=>{
 const items=[r('oldpain',10,'permanent'),r('oldpain',10,'permanent')];
 const issues=auditRecords(items);assert.equal(issues.length,1);assert.equal(issues[0].type,'replace');assert.equal(issues[0].key,9);
 assert.equal(auditRecords([...items,r('hesitant',9,'permanent')])[0].key,8);
});
test('audit accounts for multiple proposed replacements without making duplicates',()=>{
 const issues=auditRecords([r('oldpain',10,'permanent'),r('oldpain',10,'permanent'),r('oldpain',10,'permanent')]);
 assert.deepEqual(issues.map(i=>i.key),[9,8]);
});
test('repeatable internal injuries and disabled duplicates are not replaced',()=>{
 assert.deepEqual(auditRecords([r('internal',5),r('internal',5)]),[]);
 assert.deepEqual(auditRecords([r('oldpain',10,'permanent'),r('oldpain',10,'permanent',{disabled:true})]),[]);
});
test('ambiguous duplicates with other mechanics are left for the GM',()=>{
 const items=[r('oldpain',10,'permanent'),r('oldpain',10,'permanent')];
 const issues=auditRecords(items,[{id:items[1].effectId,statuses:new Set(['poisoned'])}]);assert.equal(issues[0].type,'manual');
});
test('audit unknown records is manual and Close Call only loses wound tracking',()=>{
 assert.equal(auditRecords([r('unknown',99)])[0].type,'manual');assert.equal(auditRecords([r('close',18)])[0].type,'remove');
});
test('current descriptions and schema need no refresh while legacy descriptions do',()=>{
 const item=r('pain',6,'grievous',{schema:1});
 assert.deepEqual(auditRecords([item],[{id:item.effectId,description:'<p>'+GRIEVOUS[6].text+'</p>'}]),[]);
 assert.equal(auditRecords([item],[{id:item.effectId,description:'old'}])[0].type,'refresh');
});
test('journal limit retains all active events and no terminals at zero capacity',()=>{
 const events=[{id:'a',created:1,status:'applied',finalized:true},{id:'b',created:2,status:'pending'}];
 const result=appendEvent(events,{id:'c',created:3,status:'pending'},1);assert.deepEqual(result.map(e=>e.id),['b','c']);
 assert.deepEqual(appendEvent([],{id:'x',created:1,status:'applied',finalized:true},0),[]);
});
test('unfinalized committed entries are never pruned and patching preserves sequence order',()=>{
 const events=[{id:'a',sequence:1,created:1,status:'pending'},{id:'b',sequence:2,created:1,status:'applied',finalized:false}];
 assert.deepEqual(appendEvent(events,{...events[0],answer:'fall'},0).map(e=>e.id),['a','b']);
});
