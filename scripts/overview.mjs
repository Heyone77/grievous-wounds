import {ID,escapeHTML as esc} from './rules.mjs';
import {compactWounds} from './management.mjs';
const records=a=>Array.from(a.effects??[]).filter(e=>e.getFlag(ID,'wound')).map(e=>({...e.getFlag(ID,'wound'),effectId:e.id,disabled:e.disabled}));
export function unfinished(a) {
 const out=[];
 for(const key of ['beforeDamage','pending'])if(a.getFlag(ID,key)) {
  const pending=a.getFlag(ID,key),event=(a.getFlag(ID,'events')??[]).find(e=>e.id===pending.id);
  out.push({kind:key,data:{...event,...pending}});
 }
 for(const event of a.getFlag(ID,'events')??[])if(event.status==='undoing'||event.status==='pending'||(event.status==='applied'&&!event.finalized)) {
  if(!out.some(x=>x.data.id===event.id))out.push({kind:'journal',data:event});
 }
 return out;
}
export function overviewRows(actors,scenes,users) {
 const all=new Map(Array.from(actors??[]).map(actor=>[actor.uuid,{actor,location:''}]));
 for(const scene of scenes??[])for(const token of scene.tokens??[]) {
  try {const actor=token.actor;if(actor&&!all.has(actor.uuid))all.set(actor.uuid,{actor,location:scene.name+' / '+token.name});}catch(error){console.warn(ID+' | Token unavailable',token.uuid,error);}
 }
 return [...all.values()].filter(({actor:a})=>a.type==='character'&&Array.from(users??[]).some(u=>!u.isGM&&a.testUserPermission?.(u,'OWNER'))).map(row=>({...row,wounds:records(row.actor),pending:unfinished(row.actor)})).filter(r=>r.wounds.length||r.pending.length).sort((a,b)=>Number(!!b.pending.length)-Number(!!a.pending.length)||a.actor.name.localeCompare(b.actor.name));
}
export function grievousSnapshot(actor) {
 const effects=Array.from(actor.effects??[]).filter(e=>e.getFlag(ID,'wound')?.kind==='grievous');
 return {ids:effects.map(e=>e.id),signature:JSON.stringify(effects.map(e=>[e.id,e.disabled,e.getFlag(ID,'wound'),e.system?.changes??e.changes,[...(e.statuses??[])]]).sort((a,b)=>a[0].localeCompare(b[0])))};
}
export function currentRows(){return overviewRows(game.actors,game.scenes,game.users);}
let windowInstance;
export function showOverview(api) {
 if(!game.user.isGM)throw new Error('Обзор доступен только мастеру.');
 if(windowInstance){windowInstance.render({force:true});windowInstance.bringToFront();return windowInstance;}
 class WoundOverview extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS={id:'gw-overview',window:{title:'Все ранения',resizable:true},position:{width:760,height:650},classes:['gw-overview']};
  constructor(){super();this.query='';this.listeners=[];this.timer=null;}
  async _renderHTML(){
   this.rows=currentRows();
   const visible=this.rows.filter(r=>(r.actor.name+' '+r.location).toLocaleLowerCase().includes(this.query.toLocaleLowerCase()));
   const operation=r=>r.pending.map(p=>'<p><b>'+esc(p.kind==='beforeDamage'?'Урон ожидает завершения':p.kind==='pending'?'Выбор при 0 HP':p.data.status==='undoing'?'Отмена не завершена':'Исход не завершён')+'</b> · '+esc(p.data.source?.name??'Источник не указан')+'</p>').join('');
   const button=(r,action,label)=>'<button type="button" data-gw-action="'+action+'" data-uuid="'+esc(r.actor.uuid)+'">'+label+'</button>';
   return '<div class="gw-panel"><label>Поиск <input class="gw-search" type="search" value="'+esc(this.query)+'"></label><div class="gw-overview-list">'+
    (visible.some(r=>r.pending.length)?'<section><h3>Незавершённые операции</h3>'+visible.filter(r=>r.pending.length).map(r=>'<article><h4>'+esc(r.actor.name)+'</h4><small>'+esc(r.location)+'</small>'+operation(r)+button(r,'resolve','Разобрать')+'</article>').join('')+'</section>':'')+
    '<h3>Персонажи</h3>'+visible.map(r=>'<article><h4>'+esc(r.actor.name)+'</h4><small>'+esc(r.location)+'</small><p>HP: '+esc(r.actor.system.attributes?.hp?.value??'?')+'/'+esc(r.actor.system.attributes?.hp?.effectiveMax??'?')+' · тяжёлых: '+r.wounds.filter(w=>w.kind==='grievous').length+' · постоянных: '+r.wounds.filter(w=>w.kind==='permanent').length+'</p>'+compactWounds(r.wounds,Number(r.actor.system.details?.level??1))+button(r,'open','Открыть ранения')+(r.wounds.some(w=>w.kind==='grievous')?button(r,'heal','Вылечить все тяжёлые раны'):'')+'</article>').join('')+(visible.length?'':'<p>Ранений и незавершённых операций нет.</p>')+'</div><footer><button type="button" data-gw-action="refresh">Обновить</button></footer></div>';
  }
  _replaceHTML(html,element){element.innerHTML=html;}
  _onFirstRender(){
   for(const name of ['updateActor','createActor','deleteActor','createActiveEffect','updateActiveEffect','deleteActiveEffect','createToken','updateToken','deleteToken','updateScene','deleteScene','updateUser','createUser','deleteUser']) {
    const id=Hooks.on(name,()=>{clearTimeout(this.timer);this.timer=setTimeout(()=>{if(this.rendered)this.render({force:true});},100);});this.listeners.push([name,id]);
   }
  }
  _onRender(){
   const input=this.element.querySelector('.gw-search');
   input.addEventListener('input',()=>{this.query=input.value;clearTimeout(this.timer);this.timer=setTimeout(()=>this.render({force:true}),250);});
   this.element.querySelectorAll('[data-gw-action]').forEach(button=>button.addEventListener('click',async()=>{
    try {
     if(!game.user.isGM)throw new Error('Доступно только мастеру.');
     const action=button.dataset.gwAction;
     if(action==='refresh'){await this.render({force:true});return;}
     const row=currentRows().find(r=>r.actor.uuid===button.dataset.uuid);if(!row)throw new Error('Персонаж больше не доступен в обзоре.');
     if(action==='heal')await api.confirmHeal(row.actor);
     else if(action==='resolve'&&!row.actor.getFlag(ID,'beforeDamage')&&!row.actor.getFlag(ID,'pending'))await api.openJournal(row.actor);
     else await api.open(row.actor);
     if(this.rendered)await this.render({force:true});
    }catch(error){ui.notifications.error(error.message);}
   }));
  }
  async _preRender(){this.scroll=this.element?.querySelector('.gw-overview-list')?.scrollTop??0;this.focused=this.element?.querySelector('.gw-search')===globalThis.document?.activeElement;}
  async _postRender(){const list=this.element.querySelector('.gw-overview-list');if(list)list.scrollTop=this.scroll??0;if(this.focused)this.element.querySelector('.gw-search')?.focus();}
  _onClose(){clearTimeout(this.timer);for(const [name,id]of this.listeners)Hooks.off(name,id);this.listeners=[];windowInstance=null;}
 }
 windowInstance=new WoundOverview();windowInstance.render({force:true});return windowInstance;
}
