import {ID,GRIEVOUS,PERMANENT,countGrievous,resolveGrievous,resolvePermanent,muscleDie,escapeHTML as esc} from './rules.mjs';
export const tableEntry=r=>(r.kind==='permanent'?PERMANENT:GRIEVOUS)[r.key];
export function choicePrice(records,failures=0) {
 failures=Math.max(0,Number(failures)||0);
 const active=records.filter(r=>!r.disabled);
 const added=active.filter(r=>r.id==='deep').length;
 return {penalty:countGrievous(active),added,failures:Math.min(3,failures+added),fatal:failures+added>=3};
}
export function priceHTML(records,failures=0) {
 const p=choicePrice(records,failures);
 return '<p><b>Упасть:</b> 0 HP; +'+p.added+' провалов спасброска от смерти, станет '+p.failures+'/3'+(p.fatal?' - смерть.':'.')+'</p><p><b>Принять рану:</b> 2d10 - '+p.penalty+'; 1 HP при несмертельном исходе, если максимум HP не ниже 1.</p>';
}
export function compactWounds(records,level=1) {
 const groups=new Map();
 for(const record of records) {
  const key=record.kind+':'+record.id+':'+!!record.disabled;
  if(!groups.has(key))groups.set(key,[]);groups.get(key).push(record);
 }
 return [...groups.values()].map(group=>{
  const r=group[0], entry=tableEntry(r), n=group.length;
  let brief={internal:'-'+(3*level*n)+' максимальных HP',lungs:'-'+(level*n)+' максимальных HP',deep:'При падении: +'+n+' провалов',muscle:'Штраф урона: 1d'+muscleDie(group),battered:'При получении: +'+n+' истощения',leg:'Скорость -10 футов (штраф не суммируется)',lostleg:'Скорость -'+15*n+' футов, минимум 5',eye:n>=2?'Ослеплённый':'Помеха на зрительные проверки',concussion:'Концентрация недоступна',laceration:group.some(x=>x.bleedingActive!==false)?'Кровотечение активно':'Кровотечение остановлено',recovery:'Ограничение костей хитов',oldpain:'Натуральная 1: недееспособность',hesitant:'Первый спасбросок против испуга после отдыха'}[r.id]??(r.kind==='permanent'?'Постоянная рана':'Тяжёлое ранение');
  return '<details class="gw-wound-group"><summary><b>'+esc(entry?.name??r.id)+(n>1?' ×'+n:'')+'</b><span>'+esc(r.disabled?'Отключено - не применяется':brief)+'</span></summary><p>'+esc(entry?.text??'Неизвестная запись: требуется проверка мастером.')+'</p><ul>'+group.map((item,i)=>'<li>Экземпляр '+(i+1)+' · '+esc(item.effectId)+'</li>').join('')+'</ul></details>';
 }).join('')||'<p>Ранений нет.</p>';
}
export function auditRecords(records,effects=[]) {
 const issues=[], simulated=[], seen=new Set();
 for(const r of records) {
  const entry=tableEntry(r), key=r.kind+':'+r.id;
  if(!entry || entry.id!==r.id || !['grievous','permanent'].includes(r.kind)) {issues.push({effectId:r.effectId,type:'manual',label:'Неизвестная или повреждённая запись'});simulated.push(r);continue;}
  if(r.id==='close') {issues.push({effectId:r.effectId,type:'remove',label:'Убрать запись «На волосок» из ран, сохранив состояния'});continue;}
  const savedRepair=effects.find(e=>e.id===r.effectId)?.getFlag?.(ID,'repair');
  if(savedRepair) {const target=(savedRepair.kind==='permanent'?PERMANENT:GRIEVOUS)[savedRepair.key];issues.push({effectId:r.effectId,type:target?'replace':'manual',kind:savedRepair.kind,key:savedRepair.key,label:'Завершить замену: '+entry.name+' → '+(target?.name??'неизвестная рана')});simulated.push(r);continue;}
  if(!r.disabled && !entry.stack && seen.has(key)) {
   const effect=effects.find(e=>e.id===r.effectId);
   if(effect&&((effect.statuses?.size??effect.statuses?.length??0)>0||effect.system?.changes?.length||effect.changes?.length)) {issues.push({effectId:r.effectId,type:'manual',label:entry.name+': дубль содержит состояния или механические изменения, требуется ручной разбор'});simulated.push(r);continue;}
   const occupied=[...simulated,...records.filter(x=>x.effectId!==r.effectId&&!x.disabled&&!simulated.some(s=>s.effectId===x.effectId))];
   const result=r.kind==='permanent'?resolvePermanent(Number(r.key),occupied):resolveGrievous(Number(r.key)+countGrievous(occupied),occupied);
   if(result.entry && !(result.key===r.key&&result.kind===r.kind)) {issues.push({effectId:r.effectId,type:'replace',kind:result.kind,key:result.key,label:entry.name+' → '+result.entry.name});simulated.push({...r,id:result.entry.id,kind:result.kind,key:result.key});seen.add(result.kind+':'+result.entry.id);}
   else {issues.push({effectId:r.effectId,type:'manual',label:entry.name+': требуется ручное разрешение результата'});simulated.push(r);}
   continue;
  }
  if(!r.disabled)seen.add(key);simulated.push(r);
  const effect=effects.find(e=>e.id===r.effectId);
  const expected='<p>'+esc(entry.text)+'</p>';
  if(effect && (r.schema!==1 || effect.description!==expected))issues.push({effectId:r.effectId,type:'refresh',label:entry.name+': обновить описание и формат записи'});
 }
 return issues;
}
export const DROP_STATUSES=['unconscious','prone','dead'];
export function damageSnapshot(actor,records=[]) {
 const hp=actor.system.attributes.hp, death=actor.system.attributes.death??{};
 const effects=Array.from(actor.effects);
 const mechanics=effect=>JSON.stringify({changes:effect?.system?.changes??effect?.changes??[],flags:effect?.flags??{}});
 return {hp:Number(hp.value),temp:Number(hp.temp??0),tempmax:Number(hp.tempmax??0),success:Number(death.success??0),failure:Number(death.failure??0),exhaustion:Number(actor.system.attributes.exhaustion??0),revision:Number(actor.getFlag(ID,'revision')??0),hesitantReady:actor.getFlag(ID,'hesitantReady')??null,
  conditions:Object.fromEntries(DROP_STATUSES.map(s=>[s,actor.statuses.has(s)])),
  conditionEffects:effects.filter(e=>DROP_STATUSES.some(s=>e.statuses.has(s))).map(e=>({id:e.id,statuses:[...e.statuses].sort(),disabled:!!e.disabled,undoEvent:e.getFlag(ID,'undoEvent')??null,mechanics:mechanics(e)})).sort((a,b)=>a.id.localeCompare(b.id)),
  effectIds:effects.map(e=>e.id),wounds:records.map(r=>r.effectId).sort(),
  woundStates:records.map(({effectId,disabled,...record})=>({effectId,disabled:!!disabled,...record,statuses:[...(effects.find(e=>e.id===effectId)?.statuses??[])].sort(),mechanics:mechanics(effects.find(e=>e.id===effectId))})).sort((a,b)=>a.effectId.localeCompare(b.effectId))};
}
export function snapshotMatches(a,b,{healthOnly=false,ignoreHealth=false,ignoreRevision=false}={}) {
 const keys=healthOnly?['hp','temp','tempmax']:['hp','temp','tempmax','success','failure','exhaustion','conditions','conditionEffects','woundStates','revision','hesitantReady'];
 return keys.filter(key=>!(ignoreHealth&&['hp','temp','tempmax'].includes(key))&&!(ignoreRevision&&key==='revision')).every(key=>JSON.stringify(a?.[key])===JSON.stringify(b?.[key]));
}
export function appendEvent(events,event,limit=100) {
 const list=events.filter(e=>e.id!==event.id).concat(event);
 const isTerminal=e=>['undone','abandoned'].includes(e.status)||(e.status==='applied'&&e.finalized);
 const active=list.filter(e=>!isTerminal(e));
 const remaining=Math.max(0,limit-active.length);
 const terminal=remaining?list.filter(isTerminal).slice(-remaining):[];
 return [...active,...terminal].sort((a,b)=>(a.sequence??a.created)-(b.sequence??b.created));
}
