import {ID, GRIEVOUS, PERMANENT, countWounds, countGrievous, resolveGrievous, resolvePermanent, muscleDie, movementPenalty, hpPenalty, escapeHTML as esc} from "./rules.mjs";
import {DROP_STATUSES,tableEntry,priceHTML,compactWounds,auditRecords,damageSnapshot,snapshotMatches,appendEvent} from "./management.mjs";

const queryLocks = new Set();
const actionLocks = new Set();
const restSessions = new Map();
const modifiedDamage = new WeakMap();
const permittedHitDieHealing = new Map();
const longRestHealing = new Set();
const activeDamageRuns = new Map();
const bleeding = actor => active(actor).some(r=>r.id === "laceration" && r.bleedingActive !== false);
const get = (obj,path) => foundry.utils.getProperty(obj,path);
const records = actor => Array.from(actor?.effects ?? []).filter(e=>e.getFlag(ID,"wound")).map(e=>({...e.getFlag(ID,"wound"), effectId:e.id, disabled:e.disabled}));
const active = actor => records(actor).filter(r=>!r.disabled);
const has = (actor,id) => active(actor).some(r=>r.id === id);
const leadGM = () => game.users.activeGM?.id === game.user.id;
const requireGM = () => {if(!game.user.isGM) throw new Error("Изменять ранения может мастер.");};
const report = error => {console.error(`${ID} |`,error); ui.notifications.error(`Ранения: ${error.message ?? error}`);};
const run = promise => void Promise.resolve(promise).catch(report);
const dlg = options => foundry.applications.api.DialogV2.wait({rejectClose:false, ...options});
const catUtils = () => game.modules.get("cat")?.active ? globalThis.cat?.utils : null;
async function createEffects(actor, data) {
  const utility = catUtils()?.effectUtils;
  return utility?.createEffects ? utility.createEffects(actor,data) : actor.createEmbeddedDocuments("ActiveEffect",data);
}
const selectedActor = () => canvas.tokens?.controlled?.[0]?.actor ?? game.user.character;
async function announce(actor, content) {
  return ChatMessage.create({speaker:ChatMessage.getSpeaker({actor}),content:`<div class="gw-card"><b>${esc(actor.name)}</b>${content}</div>`});
}
async function locked(actor, callback) {
  requireGM();
  if(actionLocks.has(actor.uuid)) return ui.notifications.warn("Дождитесь завершения предыдущего действия с ранениями.");
  actionLocks.add(actor.uuid);
  try { return await callback(); } finally { actionLocks.delete(actor.uuid); }
}
function conditionExists(id) {
  const statuses = CONFIG.statusEffects;
  return Array.isArray(statuses) ? statuses.some(s=>s.id === id) : !!statuses?.[id];
}
function conditionData(id) {
  const statuses = CONFIG.statusEffects;
  return Array.isArray(statuses) ? statuses.find(s=>s.id === id) : statuses?.[id];
}
function allActors() {
  const actors = new Map(game.actors.map(a=>[a.uuid,a]));
  for(const token of canvas.tokens?.placeables ?? []) if(token.actor) actors.set(token.actor.uuid, token.actor);
  return [...actors.values()];
}

Hooks.once("init", () => {
  for(const status of [{id:"gw-dazed",name:"Дезориентирован (Dazed)",img:"icons/svg/daze.svg"},{id:"gw-bleeding",name:"Кровотечение (Bleeding)",img:"icons/svg/blood.svg"}]) {
    if(Array.isArray(CONFIG.statusEffects)) {if(!conditionExists(status.id))CONFIG.statusEffects.push(status);}
    else CONFIG.statusEffects[status.id] ??= status;
  }
  game.settings.register(ID,"enabled",{name:"Выбор при 0 HP",hint:"Персонаж выбирает: упасть без новой раны или получить рану и остаться с 1 HP. Для диалога нужен активный мастер.",scope:"world",config:true,type:Boolean,default:true});
  game.settings.register(ID,"lastMoment",{name:"Midi-QOL: выбор до применения 0 HP",hint:"При нанесении урона мастером выбор ожидается перед записью HP. Принятие раны сохраняет концентрацию с отдельной проверкой от полного урона.",scope:"world",config:true,type:Boolean,default:true});
  game.settings.register(ID,"autoMuscle",{name:"Midi-QOL: штраф надрыва мышцы",hint:"Автоматически вычитает штраф один раз за атаку оружием/безоружный удар. При нескольких типах урона штраф сначала вычитается из первого компонента.",scope:"world",config:true,type:Boolean,default:true});
  for(const [key,name] of [["dazed","ID состояния Dazed"],["bleeding","ID состояния Bleeding"]]) {
    game.settings.register(ID,key,{name,hint:"Необязательно. ID уже существующего состояния из другого модуля. Пусто — только запись и напоминание без выдуманной механики.",scope:"world",config:true,type:String,default:""});
  }
});

Hooks.on("preUpdateActor",(actor,changes,options)=>{
  if(options[ID] || !bleeding(actor)) return;
  const value = get(changes,"system.attributes.hp.value");
  if(value === undefined || Number(value)<=Number(actor.system.attributes.hp.value)) return;
  const allowed = permittedHitDieHealing.get(actor.uuid);
  if(longRestHealing.has(actor.uuid)) return;
  if(allowed !== undefined && Number(value) === allowed) {permittedHitDieHealing.delete(actor.uuid);return;}
  if(Object.hasOwn(changes,"system.attributes.hp.value")) changes["system.attributes.hp.value"] = actor.system.attributes.hp.value;
  else foundry.utils.setProperty(changes,"system.attributes.hp.value",actor.system.attributes.hp.value);
  ui.notifications.warn("Кровотечение: восстановление HP возможно только костями хитов или долгим отдыхом.");
});
Hooks.on("dnd5e.rollHitDie",(_rolls,{subject,updates})=>{
  const value=get(updates.actor,"system.attributes.hp.value");
  if(value !== undefined)permittedHitDieHealing.set(subject.uuid,Number(value));
});
Hooks.on("dnd5e.preBeginConcentrating",actor=>{
  if(has(actor,"concussion")) {
    ui.notifications.warn("Dazed: поддерживать концентрацию нельзя.");
    return false;
  }
});

// This core hook is synchronous: only tag the already calculated damage. The
// awaited Actor.update wrapper below owns the dialog, never an async core hook.
const DAMAGE_CONTEXT = "grievousWoundsDamage";
const workflowDamageKeys=new WeakMap();
Hooks.on("midi-qol.preTargetDamageApplication",(token,{workflow,damageItem,item}={})=>{
  if(!damageItem)return;
  damageItem.calcDamageOptions??={};
  const options=damageItem.calcDamageOptions;
  const workflowId=workflow?.itemCardUuid??workflow?.id;
  let instanceKey;
  if(workflow&&typeof workflow==="object"){if(!workflowDamageKeys.has(workflow))workflowDamageKeys.set(workflow,workflow.itemCardUuid??foundry.utils.randomID());instanceKey=workflowDamageKeys.get(workflow);}
  const target=token?.document?.uuid??token?.uuid??damageItem.actorUuid;
  const slot=damageItem.damageSelector??"all";
  const id=instanceKey&&target ? ID+":"+instanceKey+":"+target+":"+slot : options[DAMAGE_CONTEXT]?.id??foundry.utils.randomID();
  options[DAMAGE_CONTEXT]={id,source:{name:item?.name??workflow?.item?.name??"Нанесение урона",actorUuid:workflow?.actor?.uuid??null,itemUuid:item?.uuid??workflow?.item?.uuid??null,workflowId:workflowId??null,targetUuid:target??null}};
});
Hooks.on("dnd5e.preApplyDamage",(_actor,amount,_updates,options)=>{
  const previous=options[DAMAGE_CONTEXT];
  delete options[DAMAGE_CONTEXT];
  if(!game.modules.get("midi-qol")?.active||!Number.isFinite(amount))return;
  if(amount<0&&previous?.id)options[DAMAGE_CONTEXT]={...previous,amount,restore:true};
  else if(amount>0)options[DAMAGE_CONTEXT]={id:previous?.id??foundry.utils.randomID(),amount,source:previous?.source??{actorUuid:options.midi?.sourceActorUuid??null,itemUuid:options.midi?.itemUuid??null,name:"Нанесение урона"}};
});

function choiceOwner(actor) {
  const owners = game.users.filter(u=>u.active && !u.isGM && actor.testUserPermission(u,"OWNER"));
  return owners.find(u=>u.character?.uuid === actor.uuid) ?? owners[0];
}
async function askBeforeDamage(actor,{local=false}={}) {
  const options = {window:{title:`${actor.name}: урон до 0 HP`},
    content:'<div class="gw-panel"><p>Урон рассчитан, но ещё не применён.</p>'+priceHTML(records(actor),Number(actor.system.attributes.death?.failure??0))+'<p>Проверка концентрации от полного урона сохраняется. Сотрясение и смертельная рана прерывают концентрацию.</p><p>Закрытие окна игроком передаёт выбор мастеру. Закрытие окна мастером приостанавливает применение урона. Продолжить можно через окно ранений.</p></div>',
    buttons:[{action:"fall",label:"Упасть · 0 HP",default:true},{action:"wound",label:"Принять рану · 1 HP"}]};
  const owner = choiceOwner(actor);
  if(owner && !local) {
    const answer = await foundry.applications.api.DialogV2.query(owner,"wait",{rejectClose:false,...options});
    if(["fall","wound"].includes(answer)) return answer;
  }
  return dlg(options);
}
function writeUpdate(data,path,value) {
  if(Object.hasOwn(data,path)) data[path] = value;
  else foundry.utils.setProperty(data,path,value);
}
function concentrationPlan(actor,options,amount) {
  const midi = globalThis.MidiQOL;
  const settings = midi?.configSettings?.();
  if(!actor.concentration?.effects?.size || has(actor,"concussion") || options.noConcentrationCheck || options.dnd5e?.concentrationCheck === false || game.settings.get("dnd5e","disableConcentration") || settings?.doConcentrationCheck === "none") return null;
  const mode = settings?.doConcentrationCheck;
  if(typeof actor.getConcentrationDC !== "function" || (mode === "item" ? typeof midi?.doConcentrationCheck !== "function" : typeof actor.rollConcentration !== "function")) throw new Error("Недоступен API проверки концентрации. Урон не применён; отключите выбор до 0 HP или проверьте версии Midi-QOL/dnd5e.");
  return {mode,dc:actor.getConcentrationDC(amount)};
}
async function checkDamageConcentration(actor,plan) {
  if(!plan || !actor.concentration?.effects?.size || has(actor,"concussion") || actor.statuses.has("dead") || actor.system.attributes.hp.value <= 0) return;
  if(plan.mode === "item") return globalThis.MidiQOL.doConcentrationCheck(actor,plan.dc);
  const owner = choiceOwner(actor);
  const rolls = owner && globalThis.MidiQOL?.socket
    ? await globalThis.MidiQOL.socket().executeAsUser("rollConcentration",owner.id,{actorUuid:actor.uuid,target:plan.dc,create:true})
    : await actor.rollConcentration({target:plan.dc},{},{create:true});
  if(!rolls?.length) await announce(actor,`<p>Проверка концентрации от урона не завершена. Требуется спасбросок концентрации СЛ ${plan.dc}.</p>`);
}
export async function applyDamageUpdate(actor,wrapped,data,options={}) {
  if(options[ID]||actor.type!=="character"||!actor.system?.attributes?.hp||!game.user.isGM)return wrapped(data,options);
  const context=options[DAMAGE_CONTEXT];
  if(context?.restore)return applyMidiHealthUndo(actor,wrapped,data,options);
  if(context?.id&&hasReceipt(actor,context.id)) {
    const running=activeDamageRuns.get(actor.uuid);
    if(running)await running.done;
    else if(actor.getFlag(ID,"beforeDamage")?.phase==="committed")await resumeDamage(actor);
    ui.notifications.info("Это нанесение урона уже обработано; повтор пропущен.");return actor;
  }
  if(!game.modules.get("midi-qol")?.active||(!options.gwResume&&(!game.settings.get(ID,"enabled")||!game.settings.get(ID,"lastMoment"))))return wrapped(data,options);
  const saved=actor.getFlag(ID,"beforeDamage"), amount=context?.amount;
  const observedHP=Number(actor.system.attributes.hp.value),beforeHP=Number(saved?.beforeHP??observedHP);
  const requestedHP=get(data,"system.attributes.hp.value");
  const resumingFatal=saved?.result?.entry?.id==="fatal"&&records(actor).some(r=>r.eventId===saved.id);
  if(!Number.isFinite(amount)||amount<=0||beforeHP<=0||requestedHP===undefined||Number(requestedHP)>0||(actor.statuses.has("dead")&&!resumingFatal))return wrapped(data,options);
  if(actionLocks.has(actor.uuid))throw new Error("У персонажа уже выполняется действие с ранениями. Дождитесь его завершения.");
  if(saved?.replay&&saved.id!==context?.id)throw new Error("Есть другое незавершённое нанесение урона. Разрешите его через окно ранений.");
  actionLocks.add(actor.uuid);
  let finish;const running={done:new Promise(resolve=>{finish=resolve;})};activeDamageRuns.set(actor.uuid,running);
  try {
    const beforeTemp=Number(actor.system.attributes.hp.temp??0);
    const beforeDeath={success:Number(actor.system.attributes.death?.success??0),failure:Number(actor.system.attributes.death?.failure??0)};
    const signature=JSON.stringify([beforeHP,beforeTemp,Number(requestedHP),get(data,"system.attributes.hp.temp"),amount,beforeDeath]);
    let pending=saved;
    if(pending&&pending.signature!==signature)throw new Error("Состояние отличается от сохранённого нанесения урона. Откройте ранения для отмены или разбора.");
    if(pending)assertPendingState(actor,pending);
    if(!pending) {
      pending={id:context.id,signature,beforeHP,beforeConditions:Object.fromEntries(["unconscious","prone"].map(s=>[s,actor.statuses.has(s)])),before:damageSnapshot(actor,records(actor)),replay:{data:foundry.utils.deepClone(data),options:{[DAMAGE_CONTEXT]:foundry.utils.deepClone(context),noConcentrationCheck:!!options.noConcentrationCheck,dnd5e:{concentrationCheck:options.dnd5e?.concentrationCheck}}}};
    }
    if(!pending.before)pending.before=damageSnapshot(actor,records(actor));
    await savePending(actor,pending,{mode:"before",status:"pending",amount,source:context.source??{name:"Нанесение урона"},before:pending.before});
    let answer=pending.answer;
    if(!answer) {
      const manual=new Promise(resolve=>{running.choose=resolve;});
      try{answer=await Promise.race([askBeforeDamage(actor),manual]);}finally{delete running.choose;}
    }
    if(!["fall","wound"].includes(answer))throw new Error("Нанесение урона приостановлено. Продолжите выбор через окно ранений.");
    assertPendingState(actor,pending);
    pending={...pending,answer};await savePending(actor,pending,{answer});
    const update=foundry.utils.deepClone(data),updateOptions={...options,[ID]:true};
    if(answer==="wound") {
      const plan=concentrationPlan(actor,options,amount);
      pending={...pending,concentrationPlan:plan};
      updateOptions.noConcentrationCheck=true;updateOptions.dnd5e={...options.dnd5e,concentrationCheck:false};
      if(!pending.result)pending={...pending,result:await determineWound(actor)};
      await savePending(actor,pending,{result:pending.result});
      const result=pending.result;
      if(result.entry.id!=="close") {
        const existing=actor.effects.find(e=>e.getFlag(ID,"wound")?.eventId===pending.id);
        if(existing)await applyWoundConsequences(actor,existing);
        else await addWoundInternal(actor,result.kind,result.key,{eventId:pending.id,applyFatalHP:false});
      }
      const fatal=result.entry.id==="fatal";
      writeUpdate(update,"system.attributes.hp.value",fatal?0:Math.min(1,Number(actor.system.attributes.hp.effectiveMax)));
      if(fatal)writeUpdate(update,"system.attributes.death.failure",3);
    } else {
      const failures=active(actor).filter(r=>r.id==="deep").length;
      writeUpdate(update,"system.attributes.death.failure",Math.min(3,beforeDeath.failure+failures));
    }
    pending={...pending,partial:damageSnapshot(actor,records(actor))};
    await savePending(actor,pending,{partial:pending.partial});
    pending={...pending,phase:"committed"};
    writeUpdate(update,"flags."+ID+".beforeDamage",pending);
    commitEventUpdate(actor,update,pending.id,{answer,status:"applied",result:pending.result??null,finalized:false,committedHealth:{hp:Number(get(update,"system.attributes.hp.value")),temp:Number(get(update,"system.attributes.hp.temp")??actor.system.attributes.hp.temp??0),tempmax:Number(get(update,"system.attributes.hp.tempmax")??actor.system.attributes.hp.tempmax??0),failure:Number(get(update,"system.attributes.death.failure")??beforeDeath.failure),success:Number(get(update,"system.attributes.death.success")??beforeDeath.success)}});
    writeReceipt(actor,update,pending.id,"applied");
    const updated=await wrapped(update,updateOptions);
    if(!updated)return updated;
    await finalizeDamage(actor,pending);
    return updated;
  } finally {actionLocks.delete(actor.uuid);activeDamageRuns.delete(actor.uuid);finish();}
}

// Track intervening edits even if later healing happens to return HP to the same value.
Hooks.on("preUpdateActor",(actor,changes,options)=>{
  if(options[ID]||actor.type!=="character")return;
  const paths=["system.attributes.hp.value","system.attributes.hp.temp","system.attributes.hp.tempmax","system.attributes.death.success","system.attributes.death.failure","system.attributes.exhaustion"];
  if(paths.some(path=>get(changes,path)!==undefined&&Number(get(changes,path))!==Number(get(actor,path))))writeUpdate(changes,"flags."+ID+".revision",Number(actor.getFlag(ID,"revision")??0)+1);
});

// This hook runs synchronously on the initiating client. Pending state is saved
// atomically with the HP change; no custom socket or player-supplied command executes.
Hooks.on("preUpdateActor",(actor,changes,options) => {
  if(options[ID] || actor.type !== "character" || !game.settings.get(ID,"enabled")) return;
  const value = get(changes,"system.attributes.hp.value");
  if(value === undefined) return;
  if(Number(value) > 0 && actor.getFlag(ID,"pending")) {
    const cancelled=actor.getFlag(ID,"pending");
    foundry.utils.setProperty(changes,"flags."+ID+".pending",null);
    if(eventLog(actor).some(e=>e.id===cancelled.id)) {commitEventUpdate(actor,changes,cancelled.id,{status:"abandoned",reason:"healed"});writeReceipt(actor,changes,cancelled.id,"abandoned");}
    return;
  }
  if(Number(value) > 0 || Number(actor.system.attributes.hp.value) <= 0) return;
  const death = actor.system.attributes.death ?? {};
  const id=options[DAMAGE_CONTEXT]?.id??foundry.utils.randomID();
  const before=damageSnapshot(actor,records(actor));
  const event={id,mode:"after",status:"pending",before,drop:{hp:Number(value),temp:Number(get(changes,"system.attributes.hp.temp")??before.temp),tempmax:Number(get(changes,"system.attributes.hp.tempmax")??before.tempmax),revision:Number(get(changes,"flags."+ID+".revision")??before.revision)},amount:options[DAMAGE_CONTEXT]?.amount??Math.max(0,Number(actor.system.attributes.hp.value)-Number(value)),source:options[DAMAGE_CONTEXT]?.source??{name:"Изменение HP вне раннего перехвата"}};
  commitEventUpdate(actor,changes,id,event);
  foundry.utils.setProperty(changes,"flags."+ID+".pending",{
    id,created:Date.now(),before,
    beforeDeath:{success:Number(death.success ?? 0),failure:Number(death.failure ?? 0)},
    unconscious:Array.from(actor.effects).filter(e=>e.statuses.has("unconscious")).map(e=>e.id),
    beforeConditions:Object.fromEntries(["unconscious","prone"].map(status=>[status,{
      active:actor.statuses.has(status),
      effectIds:Array.from(actor.effects).filter(e=>e.statuses.has(status)).map(e=>e.id)
    }]))
  });
});
Hooks.on("updateActor",(actor,changes) => {
  if(leadGM() && get(changes,`flags.${ID}.pending`)?.id) run(requestChoice(actor));
});

export async function requestChoice(actor=selectedActor(), {local=false}={}) {
  requireGM();
  if(!actor) return ui.notifications.warn("Выберите токен персонажа.");
  const pending = actor.getFlag(ID,"pending");
  if(!pending) return ui.notifications.info("Нет незавершённого выбора при 0 HP.");
  if(queryLocks.has(pending.id)) return ui.notifications.warn("Окно выбора уже открыто. При необходимости мастер может выбрать исход в окне ранений.");
  if(Number(actor.system.attributes.hp.value) > 0) return actor.unsetFlag(ID,"pending");
  if(actor.statuses.has("dead") || Number(actor.system.attributes.death?.failure ?? 0)>=3) {
    await announce(actor,"<p>Уже отмечена смерть. Выбор ранения автоматически не применяется; проверьте причину смерти вручную.</p>");
    return actor.unsetFlag(ID,"pending");
  }
  const owners = game.users.filter(u=>u.active && !u.isGM && actor.testUserPermission(u,"OWNER"));
  const owner = owners.find(u=>u.character?.uuid === actor.uuid) ?? owners[0];
  const options = {
    window:{title:`${actor.name}: 0 HP`},
    content:`<div class="gw-panel"><p>Выберите исход до продолжения боя:</p>${priceHTML(records(actor),pending.beforeDeath.failure)}<p>Возможна постоянная, в том числе смертельная, травма.</p><p class="gw-note">Закрытие окна откладывает выбор. До решения не совершайте новые броски или действия этим персонажем.</p></div>`,
    buttons:[{action:"fall",label:"Упасть · 0 HP",default:true},{action:"wound",label:"Принять рану · 1 HP"}],rejectClose:false
  };
  queryLocks.add(pending.id);
  try {
    const answer = owner && !local
      ? await foundry.applications.api.DialogV2.query(owner,"wait",options)
      : await dlg(options);
    if(answer === "fall" || answer === "wound") await resolveChoice(actor,pending.id,answer);
    else ui.notifications.info(`Выбор ${actor.name} отложен. Откройте окно ранений для повторного запроса.`);
  } finally {queryLocks.delete(pending.id);}
}

export async function resolveChoice(actor,pendingId,answer) {
 return locked(actor,async()=>{
  let pending=actor.getFlag(ID,"pending");
  if(!pending||pending.id!==pendingId)return;
  if(hasReceipt(actor,pendingId)) {
   if(pending.phase==="committed")await finalizeDamage(actor,pending);
   return;
  }
  if(!["fall","wound"].includes(answer))throw new Error("Неизвестный исход.");
  if(pending.answer&&pending.answer!==answer)throw new Error("Решение уже сохранено. Продолжите его или отмените исход через журнал.");
  const resumingFatal=pending.result?.entry.id==="fatal"&&records(actor).some(r=>r.eventId===pendingId);
  if(Number(actor.system.attributes.hp.value)>0||(actor.statuses.has("dead")&&!resumingFatal)) {
   await actor.unsetFlag(ID,"pending");return ui.notifications.warn("HP или состояние изменились; старый выбор отменён.");
  }
  const death=actor.system.attributes.death??{};
  if(Number(death.success??0)!==pending.beforeDeath.success||Number(death.failure??0)!==pending.beforeDeath.failure)return ui.notifications.warn("После падения изменились спасброски от смерти. Сначала мастер должен разрешить этот случай вручную.");
  if(!eventLog(actor).some(e=>e.id===pendingId))await saveEvent(actor,{id:pendingId,mode:"after",status:"pending",amount:null,source:{name:"Выбор из старой версии"},before:pending.before??null,undoable:!!pending.before});
  pending.afterDrop??=damageSnapshot(actor,records(actor));
  assertPendingState(actor,{...pending,before:pending.afterDrop});
  pending={...pending,answer};
  await saveFallbackPending(actor,pending,{answer});
  const update={};
  if(answer==="fall") {
   const failures=active(actor).filter(r=>r.id==="deep").length;
   writeUpdate(update,"system.attributes.death.failure",Math.min(3,pending.beforeDeath.failure+failures));
  } else {
   if(!pending.result)pending={...pending,result:await determineWound(actor)};
   await saveFallbackPending(actor,pending,{result:pending.result});
   if(pending.result.entry.id!=="close") {
    const existing=actor.effects.find(e=>e.getFlag(ID,"wound")?.eventId===pendingId);
    if(existing)await applyWoundConsequences(actor,existing);
    else await addWoundInternal(actor,pending.result.kind,pending.result.key,{eventId:pendingId,applyFatalHP:false});
   }
   if(pending.result.entry.id==="fatal") {
    writeUpdate(update,"system.attributes.hp.value",0);writeUpdate(update,"system.attributes.death.failure",3);
   } else {
    await clearDropConditions(actor,pending,{keepProne:pending.result.entry.id==="close"});
    writeUpdate(update,"system.attributes.hp.value",Math.min(1,Number(actor.system.attributes.hp.effectiveMax)));
    writeUpdate(update,"system.attributes.death.success",pending.beforeDeath.success);writeUpdate(update,"system.attributes.death.failure",pending.beforeDeath.failure);
   }
  }
  pending={...pending,partial:damageSnapshot(actor,records(actor))};await saveFallbackPending(actor,pending,{partial:pending.partial});
  pending={...pending,phase:"committed"};writeUpdate(update,"flags."+ID+".pending",pending);
  commitEventUpdate(actor,update,pendingId,{answer,status:"applied",result:pending.result??null,finalized:false,committedHealth:{hp:Number(get(update,"system.attributes.hp.value")??actor.system.attributes.hp.value),temp:Number(actor.system.attributes.hp.temp??0),tempmax:Number(actor.system.attributes.hp.tempmax??0),success:Number(get(update,"system.attributes.death.success")??death.success??0),failure:Number(get(update,"system.attributes.death.failure")??death.failure??0)}});
  writeReceipt(actor,update,pendingId,"applied");await actor.update(update,{[ID]:true,noConcentrationCheck:true,dnd5e:{concentrationCheck:false}});
  await finalizeDamage(actor,pending);
 });
}

async function clearDropConditions(actor,pending,{keepProne=false}={}) {
  const snapshots = pending.beforeConditions ?? {
    // Older pending choices never recorded prone: preserve it rather than guess.
    unconscious:{active:!!pending.unconscious?.length,effectIds:pending.unconscious ?? []}
  };
  const remove = [], updates = [];
  for(const effect of Array.from(actor.effects)) {
    const statuses = Array.from(effect.statuses);
    const remaining = statuses.filter(status=>{
      const before = snapshots[status];
      if(!["unconscious","prone"].includes(status) || !before || (status === "prone" && keepProne)) return true;
      return before.active || before.effectIds.includes(effect.id);
    });
    if(remaining.length === statuses.length) continue;
    // A shared effect can carry other statuses, mechanics, or a wound record.
    if(remaining.length || effect.system?.changes?.length || effect.changes?.length || effect.getFlag(ID,"wound")) updates.push({_id:effect.id,statuses:remaining});
    else remove.push(effect.id);
  }
  if(updates.length) await actor.updateEmbeddedDocuments("ActiveEffect",updates);
  if(remove.length) await actor.deleteEmbeddedDocuments("ActiveEffect",remove);
}

async function determineWound(actor) {
  const list = active(actor);
  const roll = await new Roll("2d10").evaluate();
  await roll.toMessage({speaker:ChatMessage.getSpeaker({actor}),flavor:`Тяжёлое ранение: 2d10 − ${countGrievous(list)}`});
  const result = resolveGrievous(roll.total,list);
  if(result.kind === "permanent") {
    const permanentRoll = await new Roll("1d10").evaluate();
    await permanentRoll.toMessage({speaker:ChatMessage.getSpeaker({actor}),flavor:"Постоянная рана"});
    const permanent = resolvePermanent(permanentRoll.total,list);
    if(permanent.key !== permanentRoll.total) await announce(actor,`<p>Постоянная рана: результат ${permanentRoll.total} уже занят; переход вниз к ${permanent.key}: ${esc(permanent.entry.name)}.</p>`);
    return {...result,...permanent,raw:roll.total,penalty:countGrievous(list),permanentRaw:permanentRoll.total};
  }
  return {...result,raw:roll.total,penalty:countGrievous(list)};
}
function extraStatuses(entry,actor) {
  const statuses = [...(entry.statuses ?? [])];
  if(entry.id === "festering") statuses.push("poisoned");
  if(entry.id === "eye" && has(actor,"eye")) statuses.push("blinded");
  if(entry.id === "fatal") statuses.push("dead");
  if(entry.id === "concussion" || entry.id === "laceration") {
    const custom = game.settings.get(ID,entry.id === "concussion" ? "dazed" : "bleeding");
    statuses.push(custom && conditionExists(custom) ? custom : entry.id === "concussion" ? "gw-dazed" : "gw-bleeding");
  }
  return statuses.filter(conditionExists);
}
async function addWoundInternal(actor,kind,key,{eventId=null,applyFatalHP=true}={}) {
  const entry = (kind === "permanent" ? PERMANENT : GRIEVOUS)[key];
  if(!entry) throw new Error("Рана не найдена.");
  if(entry.id === "close") {await actor.toggleStatusEffect("prone",{active:true});return;}
  if(!entry.stack && active(actor).some(r=>r.kind === kind && r.id === entry.id)) throw new Error("Это неповторяемое ранение уже есть у персонажа.");
  const statuses = extraStatuses(entry,actor);
  const record = {id:entry.id,kind,key,eventId,created:Date.now(),schema:1};
  if(entry.id === "laceration") record.bleedingActive = true;
  // Remember the ceiling at injury time; subsequent haste/speed increases cannot exceed it.
  if(entry.id === "leg" || entry.id === "lostleg") {
    const movement = actor.system.attributes.movement;
    const factor = movement.units === "m" ? .3048 : 1;
    const before = movementPenalty(active(actor)).feet;
    const after = movementPenalty([...active(actor),record]).feet;
    const penalty = (after-before)*factor;
    record.ceiling = Object.fromEntries(["walk","fly","swim","climb","burrow"].map(k=>[k,Math.max(5*factor,Number(movement[k] ?? 0)-penalty)]));
  }
  const changes = [];
  if(game.modules.get("midi-qol")?.active) {
    const midi = (path,value="1")=>changes.push({key:`flags.midi-qol.${path}`,mode:5,value,priority:20});
    if(entry.id === "festering") {midi("disadvantage.ability.save.con");midi("disadvantage.ability.check.all");midi("disadvantage.attack.all");}
    if(entry.id === "pain") midi("disadvantage.ability.save.dex");
    if(entry.id === "swelling" || entry.id === "scar") {midi("disadvantage.skill.prf");midi("disadvantage.skill.per");}
    if(entry.id === "scar") midi("advantage.skill.itm");
  }
  const [effect] = await createEffects(actor,[{
    name:`${kind === "permanent" ? "Постоянная рана" : "Тяжёлое ранение"}: ${entry.name}`,
    img:"icons/svg/blood.svg",description:`<p>${esc(entry.text)}</p>`,
    type:"base",statuses,system:{changes},flags:{[ID]:{wound:record,application:{exhaustionBefore:Number(actor.system.attributes.exhaustion??0),exhaustionAfter:Number(actor.system.attributes.exhaustion??0)+(entry.id==="battered"?1:0),applied:false}}}
  }]);
  await applyWoundConsequences(actor,effect);
  if(entry.id === "fatal" && applyFatalHP) await actor.update({"system.attributes.hp.value":0,"system.attributes.death.failure":3},{[ID]:true});
  return effect;
}
async function applyWoundConsequences(actor,effect) {
  const record=effect.getFlag(ID,"wound"),application=effect.getFlag(ID,"application");
  if(!application||application.applied)return;
  if(record.id==="battered") {
    const exhaustion=Number(actor.system.attributes.exhaustion??0);
    if(![application.exhaustionBefore,application.exhaustionAfter].includes(exhaustion))throw new Error("Истощение изменилось во время применения раны. Требуется ручной разбор.");
    if(exhaustion!==application.exhaustionAfter)await actor.update({"system.attributes.exhaustion":application.exhaustionAfter},{[ID]:true});
  }
  if(record.id==="hesitant")await actor.setFlag(ID,"hesitantReady",true);
  if(record.id==="concussion"&&actor.endConcentration)await actor.endConcentration();
  await actor.updateEmbeddedDocuments("ActiveEffect",[{_id:effect.id,["flags."+ID+".application.applied"]:true}]);
}
function requireSettled(actor) {
 if(actor.getFlag(ID,"beforeDamage")||actor.getFlag(ID,"pending")||eventLog(actor).some(e=>e.status==="undoing"))throw new Error("Сначала завершите, отмените или снимите незавершённый исход через панель.");
}
export async function addWound(actor,kind,key) {return locked(actor,()=>{requireSettled(actor);return addWoundInternal(actor,kind,Number(key));});}
export async function rollWound(actor=selectedActor()) {
  if(!actor) return ui.notifications.warn("Выберите токен.");
  return locked(actor,async()=>{
    requireSettled(actor);
    const result = await determineWound(actor);
    await addWoundInternal(actor,result.kind,result.key);
    await announce(actor,`<p><b>${esc(result.entry.name)}</b></p><p>${esc(result.entry.text)}</p>`);
    return result;
  });
}

// Derived values are recalculated from source every preparation; they never
// permanently overwrite base maximum HP or base speed.
export function prepareWoundData(actor) {
  if(game.system?.id !== "dnd5e" || !actor.system?.attributes?.hp) return;
  const list = active(actor);
  const level = Number(actor.system.details?.level ?? 1);
  const hp = actor.system.attributes.hp;
  const penalty = hpPenalty(list,level);
  if(penalty) {
    hp.max = Math.max(0,Number(hp.max ?? 0)-penalty);
    hp.effectiveMax = Math.max(0,hp.max+Number(hp.tempmax ?? 0));
    hp.value = Math.min(hp.value,hp.effectiveMax);
    hp.damage = hp.effectiveMax-hp.value;
    hp.pct = hp.effectiveMax ? hp.value/hp.effectiveMax*100 : 0;
  }
  const movement = actor.system.attributes.movement;
  if(!movement) return;
  const rule = movementPenalty(list);
  if(!rule.feet) return;
  const factor = movement.units === "m" ? .3048 : 1;
  for(const key of ["walk","fly","swim","climb","burrow"]) {
    if(!Number(movement[key])) continue;
    const cap = Math.min(...list.map(r=>r.ceiling?.[key] ?? Infinity));
    movement[key] = Math.min(cap,Math.max(5*factor,Number(movement[key])-rule.feet*factor));
  }
}
function setMode(config,mode) {
  config[mode] = true;
  for(const roll of config.rolls ?? []) {roll.options ??= {};roll.options[mode] = true;}
}
Hooks.on("dnd5e.preRollSavingThrow",config=>{
  const actor = config.subject;
  if(!actor) return;
  if((config.ability === "con" && has(actor,"festering")) || (config.ability === "dex" && has(actor,"pain"))) setMode(config,"disadvantage");
});
Hooks.on("dnd5e.preRollAbilityCheck",config=>{
  const actor = config.subject;
  if(!actor) return;
  if(has(actor,"festering")) setMode(config,"disadvantage");
});
Hooks.on("dnd5e.preRollSkill",config=>{
  const actor = config.subject;
  if(!actor) return;
  if(config.ability === "cha" && ["prf","per"].includes(config.skill) && (has(actor,"swelling") || has(actor,"scar"))) setMode(config,"disadvantage");
  if(config.ability === "cha" && config.skill === "itm" && has(actor,"scar")) setMode(config,"advantage");
});
Hooks.on("dnd5e.preRollAttack",config=>{
  const actor = config.subject?.actor ?? config.subject?.item?.actor;
  if(actor && has(actor,"festering")) setMode(config,"disadvantage");
});
Hooks.on("dnd5e.preConfigureInitiative",(actor,config)=>{
  if(!has(actor,"shock")) return;
  config.options ??= {};
  config.options.disadvantage = true;
  config.options.advantageMode = config.options.advantage ? 0 : -1;
});

// Rest limit is checked synchronously before each hit die is rolled.

Hooks.on("dnd5e.preRollHitDie",config=>{
  const actor = config.subject, rest = restSessions.get(actor?.uuid);
  if(!actor || !rest || !has(actor,"recovery")) return;
  if(rest.spent >= Math.max(1,Number(actor.system.abilities.con.mod))) {
    ui.notifications.warn("Замедленное восстановление: лимит костей хитов за отдых исчерпан.");
    return false;
  }
});
Hooks.on("dnd5e.postRollHitDie",(_rolls,{subject})=>{
  permittedHitDieHealing.delete(subject.uuid);
  const rest = restSessions.get(subject.uuid);if(rest) rest.spent++;
});
Hooks.on("dnd5e.restCompleted",(actor,_result,config)=>{
  restSessions.delete(actor.uuid);
  if(!leadGM()) return;
  run((async()=>{
    if(has(actor,"hesitant")) await actor.setFlag(ID,"hesitantReady",true);
    if(["short","quick","long"].includes(config.type)) {
      const custom=game.settings.get(ID,"bleeding");
      const updates=Array.from(actor.effects).filter(e=>e.getFlag(ID,"wound")?.id === "laceration").map(e=>({
        _id:e.id,[`flags.${ID}.wound.bleedingActive`]:false,
        statuses:Array.from(e.statuses).filter(id=>id !== "gw-bleeding" && id !== custom)
      }));
      if(updates.length) await actor.updateEmbeddedDocuments("ActiveEffect",updates);
    }
    if(config.type === "long") {
      await actor.setFlag(ID,"treatmentAvailable",true);
      if(records(actor).some(r=>r.kind === "grievous")) await announce(actor,"<p>Долгий отдых завершён. В окне ранений доступно лечение: Медицина, СЛ 10 + число ран. Одно использование набора лекаря заменяет проверку успехом.</p>");
    }
  })());
});
async function temporaryCondition(actor,status,name,{oldPain=false}={}) {
  if(!conditionExists(status)) return;
  const combat = game.combat;
  const own = Array.from(actor.effects).find(e=>e.getFlag(ID,"temporary") === status);
  const turn = combat?.turns?.findIndex(c=>c.actor?.uuid === actor.uuid) ?? -1;
  const nextRound = Number(combat?.round ?? 0)+(Number(combat?.turn ?? 0)>=turn ? 1 : 0);
  const expire = oldPain && combat?.started && turn>=0 ? {combat:combat.id,round:nextRound,actorUuid:actor.uuid} : null;
  if(own) return own.setFlag(ID,"expire",expire);
  const data = conditionData(status);
  return createEffects(actor,[{
    name,type:"base",img:data?.img ?? "icons/svg/blood.svg",statuses:[status],system:{changes:[]},
    flags:{[ID]:{temporary:status,expire}}
  }]);
}
const hesitantQueries = new Map();
export async function checkHesitantSave(actor) {
  if(!has(actor,"hesitant") || !actor.getFlag(ID,"hesitantReady")) return;
  const answer = await dlg({window:{title:`Нерешительность: ${actor.name}`},
    content:"<p>Этот спасбросок был против состояния «Испуганный»? При подтверждении Нерешительность вызывает испуг независимо от результата броска.</p>",
    buttons:[{action:"no",label:"Нет",default:true},{action:"fear",label:"Да, против испуга"}]});
  if(answer !== "fear" || !has(actor,"hesitant") || !actor.getFlag(ID,"hesitantReady")) return;
  await temporaryCondition(actor,"frightened","Нерешительность: испуг");
  await actor.setFlag(ID,"hesitantReady",false);
  await announce(actor,"<p>Нерешительность: первый спасбросок против испуга после отдыха вызывает испуг независимо от результата. Источник и срок страха определяет мастер.</p>");
}
Hooks.on("createChatMessage",message=>{
  if(!leadGM() || !message.rolls?.length) return;
  const type = message.type;
  // dnd5e defines typed chat messages; exclude damage/healing/formula rolls.
  if(!["attack","save","check","skill","tool","death","concentration","initiative"].includes(type)) return;
  const actor = message.getAssociatedActor?.() ?? ChatMessage.getSpeakerActor(message.speaker);
  if(!actor) return;
  if(type === "save" && has(actor,"hesitant") && actor.getFlag(ID,"hesitantReady")) {
    const previous = hesitantQueries.get(actor.uuid) ?? Promise.resolve();
    const next = previous.catch(()=>{}).then(()=>checkHesitantSave(actor));
    hesitantQueries.set(actor.uuid,next);
    run(next.finally(()=>{if(hesitantQueries.get(actor.uuid) === next) hesitantQueries.delete(actor.uuid);}));
  }
  if(!has(actor,"oldpain")) return;
  const naturalOne = message.rolls.some(roll=>roll.dice.some(d=>d.faces === 20 && d.results.some(r=>r.active !== false && !r.discarded && r.result === 1)));
  if(naturalOne) run(temporaryCondition(actor,"incapacitated","Старая боль: недееспособность",{oldPain:true}));
});
Hooks.on("updateCombat",(combat,changes)=>{
  if(!leadGM() || (changes.turn === undefined && changes.round === undefined)) return;
  const previous = combat.previous;
  const previousCombatant = previous?.combatantId ? combat.combatants.get(previous.combatantId) : null;
  if(!previousCombatant?.actor) return;
  const actor = previousCombatant.actor;
  run((async()=>{
    for(const effect of Array.from(actor.effects)) {
      const expiry = effect.getFlag(ID,"expire");
      if(expiry?.combat === combat.id && Number(previous.round)>=Number(expiry.round)) await effect.delete();
    }
  })());
});

export async function treat(actor=selectedActor()) {
  requireGM();
  if(actor)requireSettled(actor);
  if(!actor?.getFlag(ID,"treatmentAvailable")) return ui.notifications.warn("Лечение доступно после завершённого долгого отдыха. Для исправления используйте удаление раны.");
  const candidates = game.actors.filter(a=>a.type === "character");
  const result = await dlg({window:{title:"Лечение тяжёлых ран"},content:`<div class="gw-panel"><p>СЛ: ${10+countGrievous(active(actor))}. При успехе снимаются все тяжёлые ранения; постоянные сохраняются.</p><label>Кто лечит?<select name="healer">${candidates.map(a=>`<option value="${esc(a.id)}" ${a.id === actor.id ? "selected" : ""}>${esc(a.name)}</option>`).join("")}</select></label><label><input type="checkbox" name="kit"> Потратить одно использование набора лекаря (мастер списывает вручную)</label></div>`,buttons:[{action:"treat",label:"Лечить",callback:(_event,button)=>({healer:button.form.elements.healer.value,kit:button.form.elements.kit.checked})},{action:"cancel",label:"Отмена"}]});
  if(!result || result === "cancel") return;
  return locked(actor,async()=>{
    if(!actor.getFlag(ID,"treatmentAvailable")) return;
    const snapshot = records(actor).map(r=>r.effectId).sort().join(",");
    const dc = 10+countGrievous(active(actor));
    let success = result.kit;
    if(!success) {
      const healer = game.actors.get(result.healer);
      if(!healer) throw new Error("Лекарь не найден.");
      const rolls = await healer.rollSkill({skill:"med",ability:"wis"});
      if(!rolls?.length) return;
      success = rolls[0].total >= dc;
    }
    if(snapshot !== records(actor).map(r=>r.effectId).sort().join(",")) throw new Error("Список ран изменился во время лечения. Повторите проверку состояния.");
    // One attempt per completed long rest, including a failed check.
    await actor.setFlag(ID,"treatmentAvailable",false);
    if(success) {
      const ids = records(actor).filter(r=>r.kind === "grievous").map(r=>r.effectId);
      if(ids.length) await actor.deleteEmbeddedDocuments("ActiveEffect",ids);
    }
    await announce(actor,`<p>Лечение: ${success ? "успех, тяжёлые ранения сняты" : "проверка провалена"}.${result.kit ? " Спишите одно использование набора лекаря вручную." : ` СЛ ${dc}.`}</p>`);
  });
}


export function eventLog(actor) {const events=actor.getFlag(ID,"events");return Array.isArray(events)?events:[];}
function mergedEvent(actor,patch) {
 const previous=eventLog(actor).find(e=>e.id===patch.id);
 return {...(previous??{created:Date.now(),sequence:Math.max(0,...eventLog(actor).map(e=>e.sequence??0))+1}),...patch};
}
async function saveEvent(actor,patch) {
 const event=mergedEvent(actor,patch);
 await actor.setFlag(ID,"events",appendEvent(eventLog(actor),event));return event;
}
function commitEventUpdate(actor,update,id,patch) {writeUpdate(update,"flags."+ID+".events",appendEvent(eventLog(actor),mergedEvent(actor,{id,...patch})));}
function hasReceipt(actor,id) {
 const receipts=actor.getFlag(ID,"receipts");return Array.isArray(receipts)?receipts.some(r=>r.id===id):!!receipts?.[id];
}
function writeReceipt(actor,update,id,status) {
 const stored=actor.getFlag(ID,"receipts")??[];
 const receipts=Array.isArray(stored)?stored:Object.entries(stored).map(([id,status])=>({id,status}));
 writeUpdate(update,"flags."+ID+".receipts",receipts.filter(r=>r.id!==id).concat({id,status}));
}
async function savePending(actor,pending,patch={}) {
 const update={};writeUpdate(update,"flags."+ID+".beforeDamage",pending);
 commitEventUpdate(actor,update,pending.id,patch);await actor.update(update,{[ID]:true});
}
async function saveFallbackPending(actor,pending,patch={}) {
 const update={};writeUpdate(update,"flags."+ID+".pending",pending);commitEventUpdate(actor,update,pending.id,patch);await actor.update(update,{[ID]:true});
}
function assertPendingState(actor,pending) {
 const current=damageSnapshot(actor,records(actor));
 if(!pending.before)return;
 if(pending.partial) {
  if(!snapshotMatches(current,pending.partial))throw new Error("После сохранённого выбора изменились HP, состояния, истощение или ранения. Продолжение остановлено.");
  return;
 }
 const own=records(actor).filter(r=>r.eventId===pending.id),base=pending.before;
 const ownIds=new Set(own.filter(r=>!base.wounds.includes(r.effectId)).map(r=>r.effectId));
 const wounds=current.woundStates.filter(r=>!ownIds.has(r.effectId));
 const allowedHP=current.hp===base.hp||(own.length&&current.hp===Math.min(base.hp,Number(actor.system.attributes.hp.effectiveMax)));
 const exhaustion=current.exhaustion===base.exhaustion||(own.some(r=>r.id==="battered")&&current.exhaustion===base.exhaustion+1);
 const originalConditions=base.conditionEffects.every(before=>current.conditionEffects.some(e=>e.id===before.id&&JSON.stringify(e)===JSON.stringify(before)));
 const foreignConditions=current.conditionEffects.filter(e=>!ownIds.has(e.id)&&!base.conditionEffects.some(b=>b.id===e.id));
 if(!allowedHP||!exhaustion||current.revision!==base.revision||current.temp!==base.temp||current.tempmax!==base.tempmax||current.success!==base.success||current.failure!==base.failure||JSON.stringify(wounds)!==JSON.stringify(base.woundStates)||!originalConditions||foreignConditions.length)throw new Error("Состояние персонажа изменилось во время выбора. Продолжение остановлено; проверьте журнал.");
}
async function finalizeDamage(actor,pending) {
 const event=eventLog(actor).find(e=>e.id===pending.id);
 if(!event||event.finalized)return;
 const current=damageSnapshot(actor,records(actor)),committed=event.committedHealth;
 if(!committed||!Object.entries(committed).every(([key,value])=>current[key]===value)||current.revision!==pending.partial?.revision||current.exhaustion!==pending.partial?.exhaustion||JSON.stringify(current.woundStates)!==JSON.stringify(pending.partial?.woundStates))throw new Error("После записи урона состояние изменилось. Завершение остановлено; требуется разбор мастера.");
 if(pending.answer==="fall"||pending.result?.entry.id==="fatal"||current.hp<=0) {
  if(actor.endConcentration)await actor.endConcentration();
  if(pending.result?.entry.id==="fatal"||current.failure>=3)await actor.toggleStatusEffect("dead",{active:true});
 } else {
  for(const status of ["unconscious","prone"]) {
   const previous=pending.beforeConditions?.[status],wasActive=typeof previous==="object"?previous.active:previous;
   if(wasActive&&!actor.statuses.has(status))await actor.toggleStatusEffect(status,{active:true});
  }
  if(pending.result?.entry.id==="close"&&!actor.statuses.has("prone"))await actor.toggleStatusEffect("prone",{active:true});
 }
 if(pending.answer==="wound"&&pending.concentrationPlan&&!event.concentrationRequested) {
  await saveEvent(actor,{id:pending.id,concentrationRequested:true});
  try{await checkDamageConcentration(actor,pending.concentrationPlan);}catch(error){report(error);await announce(actor,"<p>Урон и рана применены. Проверьте концентрацию вручную, СЛ "+pending.concentrationPlan.dc+".</p>");}
 }
 const update={};writeUpdate(update,"flags."+ID+(event.mode==="after"?".pending":".beforeDamage"),null);
 commitEventUpdate(actor,update,pending.id,{status:"applied",finalized:true,after:damageSnapshot(actor,records(actor)),completed:Date.now()});
 await actor.update(update,{[ID]:true});
 await announce(actor,"<p>Исход: "+(pending.answer==="fall"?"Упасть":esc(pending.result?.entry?.name??"Ранение"))+". HP: "+actor.system.attributes.hp.value+". ID: "+esc(pending.id)+".</p>");
}
export async function resumeDamage(actor) {
 requireGM();const running=activeDamageRuns.get(actor.uuid);
 if(running) {
  if(running.choose&&!running.selecting) {
   running.selecting=true;
   try{const answer=await askBeforeDamage(actor,{local:true});if(["fall","wound"].includes(answer))running.choose?.(answer);}finally{running.selecting=false;}
  }
  return running.done;
 }
 const pending=actor.getFlag(ID,"beforeDamage");
 if(pending?.phase==="committed")return locked(actor,()=>finalizeDamage(actor,pending));
 if(!pending?.replay)throw new Error("Старый выбор не содержит данных урона. Отмените сохранённый выбор с предпросмотром или повторите исходное нанесение.");
 return applyDamageUpdate(actor,(data,options)=>actor.update(data,options),foundry.utils.deepClone(pending.replay.data),{...foundry.utils.deepClone(pending.replay.options),gwResume:true});
}
async function applyMidiHealthUndo(actor,wrapped,data,options) {
 const id=options[DAMAGE_CONTEXT].id,event=eventLog(actor).find(e=>e.id===id);
 if(!event||event.status!=="applied"||!event.finalized)return wrapped(data,options);
 const current=damageSnapshot(actor,records(actor)),after=event.healthRestored??event.after;
 if(!snapshotMatches(current,after))throw new Error("После исхода были другие изменения. Отмена HP через Midi остановлена; проверьте журнал ранений.");
 for(const key of ["hp","temp","tempmax"]) {
  const path="system.attributes.hp."+({hp:"value",temp:"temp",tempmax:"tempmax"}[key]);
  if(Number(get(data,path)??current[key])!==event.before[key])throw new Error("Карточка Midi восстанавливает другие HP. Используйте отмену исхода из журнала ранений.");
 }
 const updated=await wrapped(data,{...options,[ID]:true,noConcentrationCheck:true,dnd5e:{...options.dnd5e,concentrationCheck:false}});
 if(updated)await saveEvent(actor,{id,healthRestored:damageSnapshot(actor,records(actor))});return updated;
}
function undoStateValid(current,plan,id) {
 const start=plan.start,before=plan.before;
 if(current.revision!==start.revision)return false;
 if(![start,before].some(s=>snapshotMatches(current,s,{healthOnly:true})))return false;
 if(![start.hesitantReady,before.hesitantReady].includes(current.hesitantReady)||![start.success,before.success].includes(current.success)||![start.failure,before.failure].includes(current.failure)||![start.exhaustion,before.exhaustion].includes(current.exhaustion))return false;
 const removable=new Set(plan.woundIds);
 if(current.woundStates.some(r=>!start.woundStates.some(s=>JSON.stringify(r)===JSON.stringify(s)))||start.woundStates.some(r=>!removable.has(r.effectId)&&!current.woundStates.some(s=>JSON.stringify(r)===JSON.stringify(s))))return false;
 for(const effect of current.conditionEffects) {
  if(effect.undoEvent===id&&effect.statuses.every(s=>DROP_STATUSES.includes(s)&&before.conditions[s]))continue;
  const prior=start.conditionEffects.find(e=>e.id===effect.id),edit=plan.statusEdits.find(e=>e.id===effect.id);
  if(!prior||!([prior.statuses,edit?.remaining].filter(Boolean).some(s=>JSON.stringify(s)===JSON.stringify(effect.statuses)))||effect.disabled!==prior.disabled||effect.mechanics!==prior.mechanics)return false;
 }
 for(const effect of start.conditionEffects) {
  const edit=plan.statusEdits.find(e=>e.id===effect.id);
  if(!removable.has(effect.id)&&!edit?.removeEffect&&!(edit&& !edit.remaining.some(s=>DROP_STATUSES.includes(s)))&&!current.conditionEffects.some(e=>e.id===effect.id))return false;
 }
 return DROP_STATUSES.every(s=>[start.conditions[s],before.conditions[s]].includes(current.conditions[s]));
}
export function undoPreview(actor,id) {
 const event=eventLog(actor).find(e=>e.id===id);
 if(!event||!["pending","applied","undoing"].includes(event.status))throw new Error("Этот исход уже отменён или недоступен.");
 if(event.status==="applied"&&!event.finalized)throw new Error("Сначала завершите сохранённое применение урона через панель.");
 if(eventLog(actor).some(e=>(e.sequence??e.created)>(event.sequence??event.created)&&["pending","applied","undoing"].includes(e.status)))throw new Error("Сначала разрешите более поздний исход этого персонажа.");
 if(!event.before||event.undoable===false)throw new Error("У этой записи нет надёжного состояния до урона. Автоматическая отмена недоступна.");
 const current=damageSnapshot(actor,records(actor));
 if(event.status==="undoing") {
  if(!event.undoPlan||!undoStateValid(current,event.undoPlan,id))throw new Error("Во время отмены состояние изменилось. Нужен ручной разбор.");
  return {...event.undoPlan,event};
 }
 let expected=event.healthRestored??event.after??event.partial;
 if(!expected&&event.status==="pending") {
  const pending=actor.getFlag(ID,event.mode==="after"?"pending":"beforeDamage");
  if(event.mode==="before"&&pending?.id===id){assertPendingState(actor,pending);expected=current;}
  else if(event.mode==="after"&&event.drop) {
   const before=event.before,drop=event.drop;
   const matches=Object.entries(drop).every(([key,value])=>current[key]===value)&&current.success===before.success&&current.failure===before.failure&&current.exhaustion===before.exhaustion&&JSON.stringify(current.woundStates)===JSON.stringify(before.woundStates)&&current.conditions.dead===before.conditions.dead&&before.conditionEffects.every(e=>current.conditionEffects.some(c=>JSON.stringify(c)===JSON.stringify(e)));
   if(matches)expected=current;
  }
 }
 expected??=event.before;
 if(!snapshotMatches(current,expected))throw new Error("После исхода изменились HP, истощение, состояния или ранения. Автоматическая отмена остановлена.");
 const before=event.before,original=event.after??event.partial??expected;
 const woundIds=records(actor).filter(r=>r.eventId===id&&!before.wounds.includes(r.effectId)).map(r=>r.effectId);
 const statusEdits=[];
 for(const item of original.conditionEffects) {
  if(woundIds.includes(item.id))continue;
  const prior=before.conditionEffects.find(e=>e.id===item.id),effect=actor.effects.find(e=>e.id===item.id);
  if(!effect)continue;
  const added=item.statuses.filter(s=>DROP_STATUSES.includes(s)&&!prior?.statuses.includes(s));
  if(!added.length)continue;
  const remaining=[...effect.statuses].filter(s=>!added.includes(s)).sort();
  statusEdits.push({id:item.id,added,remaining,removeEffect:!remaining.length&&!effect.system?.changes?.length&&!effect.changes?.length&&!effect.getFlag(ID,"wound")});
 }
 const changed=DROP_STATUSES.filter(s=>current.conditions[s]!==before.conditions[s]);
 const description="HP: "+current.hp+" → "+before.hp+"; временные HP: "+current.temp+" → "+before.temp+"; максимум (tempmax): "+current.tempmax+" → "+before.tempmax+"; спасброски смерти: "+current.success+"/"+current.failure+" → "+before.success+"/"+before.failure+"; истощение: "+current.exhaustion+" → "+before.exhaustion+". Удалить раны: "+(woundIds.map(effectId=>{const record=records(actor).find(r=>r.effectId===effectId);return (tableEntry(record)?.name??record.id)+" ["+effectId+"]";}).join(", ")||"нет")+". Снять состояния из эффектов: "+(statusEdits.map(e=>e.id+" ("+e.added.join(", ")+")").join("; ")||"нет")+". Изменяемые состояния: "+(changed.join(", ")||"нет")+". Общие эффекты сохраняют остальные состояния. Концентрация и эффекты заклинаний автоматически не восстанавливаются.";
 return {event,before,start:current,woundIds,statusEdits,description,alreadyRestored:!!event.healthRestored};
}
export async function undoEvent(actor,id) {
 requireGM();if(activeDamageRuns.has(actor.uuid))throw new Error("Выбор ещё открыт. Закройте окно мастера перед отменой.");
 return locked(actor,async()=>{
  let plan=undoPreview(actor,id);
  if(plan.event.status!=="undoing") {const {event,...stored}=plan;await saveEvent(actor,{id,status:"undoing",undoPlan:stored});plan={...stored,event};}
  for(const effectId of plan.woundIds) {
   const effect=actor.effects.find(e=>e.id===effectId);
   if(effect&&effect.getFlag(ID,"wound")?.eventId!==id)throw new Error("Изменился владелец эффекта раны; отмена остановлена.");
   if(effect)await actor.deleteEmbeddedDocuments("ActiveEffect",[effectId]);
  }
  for(const edit of plan.statusEdits) {
   const effect=actor.effects.find(e=>e.id===edit.id);if(!effect)continue;
   if(edit.removeEffect)await actor.deleteEmbeddedDocuments("ActiveEffect",[edit.id]);
   else await actor.updateEmbeddedDocuments("ActiveEffect",[{_id:edit.id,statuses:[...effect.statuses].filter(s=>!edit.added.includes(s))}]);
  }
  if(!undoStateValid(damageSnapshot(actor,records(actor)),plan,id))throw new Error("Состояние изменилось во время отмены. Продолжение остановлено.");
  const before=plan.before;
  await actor.update({"system.attributes.hp.value":before.hp,"system.attributes.hp.temp":before.temp,"system.attributes.hp.tempmax":before.tempmax,"system.attributes.death.success":before.success,"system.attributes.death.failure":before.failure,"system.attributes.exhaustion":before.exhaustion,["flags."+ID+".hesitantReady"]:before.hesitantReady},{[ID]:true,noConcentrationCheck:true,dnd5e:{concentrationCheck:false}});
  if(!undoStateValid(damageSnapshot(actor,records(actor)),plan,id))throw new Error("Состояние изменилось после восстановления HP. Проверьте незавершённую отмену.");
  for(const status of DROP_STATUSES)if(before.conditions[status]&&!actor.statuses.has(status)) {
   const definition=conditionData(status)??{id:status};
   await createEffects(actor,[{name:definition.name??status,img:definition.img??"icons/svg/aura.svg",type:"base",statuses:[status],system:{changes:[]},flags:{[ID]:{undoEvent:id}}}]);
  }
  if(!undoStateValid(damageSnapshot(actor,records(actor)),plan,id))throw new Error("Состояние изменилось во время восстановления состояний. Проверьте отмену.");
  const update={};
  if(actor.getFlag(ID,"beforeDamage")?.id===id)writeUpdate(update,"flags."+ID+".beforeDamage",null);
  if(actor.getFlag(ID,"pending")?.id===id)writeUpdate(update,"flags."+ID+".pending",null);
  commitEventUpdate(actor,update,id,{status:"undone",undone:Date.now()});writeReceipt(actor,update,id,"undone");await actor.update(update,{[ID]:true});
  await announce(actor,"<p>Исход отменён. "+esc(plan.description)+"</p>");
 });
}
export async function abandonDamage(actor,id) {
 requireGM();if(activeDamageRuns.has(actor.uuid))throw new Error("Сначала закройте окно выбора мастера.");
 return locked(actor,async()=>{
  const pending=actor.getFlag(ID,"beforeDamage")??actor.getFlag(ID,"pending");id??=pending?.id;if(!id)return;
  const event=eventLog(actor).find(e=>e.id===id);if(event&&!((event.status==="pending"||event.status==="undoing")||(event.status==="applied"&&!event.finalized)))throw new Error("Этот исход уже завершён.");
  const update={};
  if(actor.getFlag(ID,"beforeDamage")?.id===id)writeUpdate(update,"flags."+ID+".beforeDamage",null);
  if(actor.getFlag(ID,"pending")?.id===id)writeUpdate(update,"flags."+ID+".pending",null);
  commitEventUpdate(actor,update,id,{status:"abandoned",abandoned:Date.now()});writeReceipt(actor,update,id,"abandoned");await actor.update(update,{[ID]:true});
  await announce(actor,"<p>Незавершённый выбор снят. HP, состояния и уже добавленные раны оставлены без изменений.</p>");
 });
}
export function auditWounds(actor) {return auditRecords(records(actor),Array.from(actor.effects));}
export function repairPreview(actor,effectId) {
 const issue=auditWounds(actor).find(i=>i.effectId===effectId);
 if(!issue||issue.type==="manual")throw new Error(issue?.label??"Исправление больше не требуется.");
 const target=issue.type==="replace"?(issue.kind==="permanent"?PERMANENT:GRIEVOUS)[issue.key]:null;
 return {...issue,description:issue.label+". "+(target?target.text+" Исходная запись будет удалена; последствия новой раны применятся один раз.":issue.type==="refresh"?"Изменятся только описание и версия записи; HP, истощение и механика не пересчитываются.":"Из счётчика ран исчезнет эта запись. Её состояния и механические изменения сохранятся.")};
}
export async function repairWound(actor,effectId,{expected}={}) {
 return locked(actor,async()=>{
  requireSettled(actor);
  const issue=repairPreview(actor,effectId);
  if(expected&&JSON.stringify([expected.type,expected.kind,expected.key,expected.label])!==JSON.stringify([issue.type,issue.kind,issue.key,issue.label]))throw new Error("Предложенное исправление изменилось. Откройте предпросмотр заново.");
  const record=records(actor).find(r=>r.effectId===effectId),effect=actor.effects.find(e=>e.id===effectId);
  if(issue.type==="refresh") {
   const entry=tableEntry(record);
   await actor.updateEmbeddedDocuments("ActiveEffect",[{_id:effectId,description:"<p>"+esc(entry.text)+"</p>",["flags."+ID+".wound.schema"]:1}]);
  } else if(issue.type==="replace") {
   let repair=effect.getFlag(ID,"repair");
   if(!repair){repair={id:foundry.utils.randomID(),kind:issue.kind,key:issue.key,source:foundry.utils.deepClone(effect.getFlag(ID,"wound"))};await actor.updateEmbeddedDocuments("ActiveEffect",[{_id:effectId,["flags."+ID+".repair"]:repair}]);}
   if(repair.source&&JSON.stringify(repair.source)!==JSON.stringify(effect.getFlag(ID,"wound")))throw new Error("Исходная запись изменилась во время исправления.");
   const replacement=actor.effects.find(e=>e.getFlag(ID,"wound")?.eventId===repair.id);
   if(replacement)await applyWoundConsequences(actor,replacement);
   else await addWoundInternal(actor,repair.kind,repair.key,{eventId:repair.id});
   await actor.deleteEmbeddedDocuments("ActiveEffect",[effectId]);
  } else {
   await actor.updateEmbeddedDocuments("ActiveEffect",[{_id:effectId,["flags."+ID+".wound"]:null}]);
  }
  await announce(actor,"<p>Проверка старых ран: "+esc(issue.label)+".</p>");
 });
}
async function inspectOldWounds(actor) {
 const issues=auditWounds(actor);if(!issues.length)return ui.notifications.info("Ошибок и устаревших записей не найдено.");
 const selected=await chooseEntry("Проверка старых ран",issues.map(i=>({value:i.effectId,name:i.label+" ["+i.effectId+"]"})));
 if(!selected)return;
 const issue=issues.find(i=>i.effectId===selected);if(issue.type==="manual")return ui.notifications.warn(issue.label);
 const preview=repairPreview(actor,selected);
 if(await foundry.applications.api.DialogV2.confirm({window:{title:"Исправление старой раны"},content:"<p>"+esc(preview.description)+"</p>"}))await repairWound(actor,selected,{expected:preview});
}
const eventStatus=status=>({pending:"Ожидает решения",applied:"Применён",undoing:"Отмена не завершена",undone:"Отменён",abandoned:"Выбор снят"}[status]??status);
export async function openJournal(actor) {
 const events=[...eventLog(actor)].reverse();
 const selected=await dlg({classes:["gw-wounds-dialog"],window:{title:"Журнал ранений: "+actor.name},position:{width:620},content:'<div class="gw-panel">'+(events.map(e=>'<details class="gw-wound-group"><summary><b>'+esc(e.source?.name??"Неизвестный источник")+' · '+esc(e.amount??"?")+' урона</b><span>'+esc(eventStatus(e.status))+(e.status==="applied"&&!e.finalized?' · завершение ожидается':'')+'</span></summary><p>'+esc(new Date(e.created).toLocaleString())+'</p><p>Решение: '+esc(e.answer==="wound"?"Принять рану":e.answer==="fall"?"Упасть":"Ожидается")+'. '+esc(e.result?.entry?.name??"")+'</p>'+rollHTML(e.result)+'<p>Источник: '+esc(e.source?.itemUuid??e.source?.actorUuid??"не указан")+'</p><small>ID: '+esc(e.id)+'</small></details>').join('')||'<p>Событий пока нет.</p>')+'</div>',buttons:[{action:"close",label:"Закрыть",default:true},...(game.user.isGM&&events.some(e=>["pending","applied","undoing"].includes(e.status))?[{action:"undo",label:"Отменить исход"}]:[]),...(game.user.isGM&&events.some(e=>e.status==="pending"||e.status==="undoing"||(e.status==="applied"&&!e.finalized))?[{action:"abandon",label:"Снять незавершённый исход"}]:[])]});
 if(selected==="undo") {
  const id=await chooseEntry("Исход для отмены",events.filter(e=>["pending","applied","undoing"].includes(e.status)).map(e=>({value:e.id,name:(e.source?.name??"Урон")+" · "+(e.amount??"?")+" · "+(e.result?.entry?.name??e.answer??"без решения")+" ["+e.id+"]"})));
  if(!id)return;
  const plan=undoPreview(actor,id);
  if(await foundry.applications.api.DialogV2.confirm({window:{title:"Отмена конкретного исхода"},content:"<p>"+esc(plan.description)+"</p>"}))await undoEvent(actor,id);
 }
 if(selected==="abandon") {
  const id=await chooseEntry("Незавершённый исход",events.filter(e=>e.status==="pending"||e.status==="undoing"||(e.status==="applied"&&!e.finalized)).map(e=>({value:e.id,name:(e.source?.name??"Урон")+" ["+e.id+"]"})));
  if(id&&await foundry.applications.api.DialogV2.confirm({window:{title:"Снять исход без отката"},content:"<p>Будет снято только ожидание этого события. Текущие HP, состояния, раны и истощение останутся как есть. Применить?</p>"}))await abandonDamage(actor,id);
 }
}
function rollHTML(result) {
 if(result?.raw===undefined)return "";
 return '<p>Сохранённый бросок: '+esc(result.raw)+' - '+esc(result.penalty??0)+' = '+esc(result.adjusted)+ (result.permanentRaw!==undefined?'; постоянная рана 1d10: '+esc(result.permanentRaw)+' → '+esc(result.key):'')+'</p>';
}
function pendingHTML(actor,pending) {
 if(!pending)return "";
 const event=eventLog(actor).find(e=>e.id===pending.id);
 return '<section class="gw-note gw-pending" role="status"><b>Незавершённое нанесение урона</b><p>'+esc(event?.source?.name??"Неизвестный источник")+' · '+esc(event?.amount??"?")+' урона</p><p>Решение: '+esc(pending.answer==="wound"?"Принять рану":pending.answer==="fall"?"Упасть":"ожидается")+'. Сохранённый результат: '+esc(pending.result?.entry?.name??"бросок ещё не сделан")+'. '+(pending.phase==="committed"?'HP уже записаны; требуется завершить последствия.':'')+'</p>'+rollHTML(pending.result)+'<small>ID: '+esc(pending.id)+'</small><p>Кнопка «Продолжить выбор» использует сохранённый бросок. Внешние макросы исходного workflow после перезагрузки повторно не запускаются.</p></section>';
}

export async function open(actor=selectedActor()) {
  if(!actor) {
    const available = game.actors.filter(a=>a.type === "character" && (game.user.isGM || a.isOwner));
    const id = await dlg({window:{title:"Ранения — персонаж"},content:`<label>Персонаж<select name="actor">${available.map(a=>`<option value="${esc(a.id)}">${esc(a.name)}</option>`).join("")}</select></label>`,buttons:[{action:"open",label:"Открыть",callback:(_e,b)=>b.form.elements.actor.value}]});
    if(!id) return;actor = game.actors.get(id);
  }
  if(!actor || (!actor.isOwner && !game.user.isGM)) return;
  const list = records(actor), pending = actor.getFlag(ID,"pending"), beforeDamage=actor.getFlag(ID,"beforeDamage");
  const outstanding=beforeDamage??pending;
  const buttons = [{action:"close",label:"Закрыть",default:true}];
  if(game.user.isGM) buttons.unshift({action:"roll",label:"Бросить рану"},{action:"add",label:"Добавить вручную"},{action:"remove",label:"Удалить рану"},{action:"treat",label:"Лечение"});
  buttons.push({action:"journal",label:"Журнал исходов"});
  if(game.user.isGM)buttons.push({action:"audit",label:"Проверить старые раны"});
  if(game.user.isGM&&outstanding)buttons.unshift({action:"continue",label:"Продолжить выбор"},{action:"abandon",label:"Снять зависший выбор"});
  if(game.user.isGM && pending&&!pending.answer) buttons.unshift({action:"query",label:"Спросить игрока"},{action:"resolve",label:"Мастер: выбрать исход"});
  if(has(actor,"muscle")) buttons.push({action:"muscle",label:`Штраф урона: 1d${muscleDie(active(actor))}`});
  if(game.user.isGM && actor.effects.some(e=>e.getFlag(ID,"temporary"))) buttons.push({action:"temporary",label:"Снять временный эффект"});
  const action = await dlg({classes:["gw-wounds-dialog"],window:{title:`Ранения: ${actor.name}`},position:{width:620},content:`<div class="gw-panel"><p>HP: ${actor.system.attributes.hp.value}/${actor.system.attributes.hp.effectiveMax}. Активных ран: <b>${countWounds(active(actor))}</b>; тяжёлых (штраф к 2d10): <b>${countGrievous(active(actor))}</b>.</p>${pendingHTML(actor,outstanding)}${compactWounds(list,Number(actor.system.details?.level??1))}<p class="gw-note">Ограничения рук/действий, зрительные проверки и Прилив адреналина требуют участия мастера. При активном Midi-QOL штраф надрыва мышцы применяется автоматически, если включена соответствующая настройка. Кнопка ручного броска предназначена для остальных случаев.</p></div>`,buttons});
  if(action==="journal")await openJournal(actor);
  if(action==="audit")await inspectOldWounds(actor);
  if(action==="continue") {
   if(beforeDamage)await resumeDamage(actor);
   else if(pending) {
    const answer=pending.answer??await dlg({window:{title:"Продолжение выбора"},content:priceHTML(records(actor),pending.beforeDeath.failure),buttons:[{action:"fall",label:"Упасть"},{action:"wound",label:"Принять рану"}]});
    if(["fall","wound"].includes(answer))await resolveChoice(actor,pending.id,answer);
   }
  }
  if(action==="abandon"&&await foundry.applications.api.DialogV2.confirm({window:{title:"Снять незавершённый выбор"},content:"<p>Будет снят только незавершённый выбор. Текущие HP, состояния, истощение и уже добавленные раны останутся без изменений. Для возврата последствий используйте отмену исхода в журнале.</p>"}))await abandonDamage(actor);
  if(action === "roll") await rollWound(actor);
  if(action === "treat") await treat(actor);
  if(action === "query") await requestChoice(actor);
  if(action === "resolve") {
    const answer = await dlg({window:{title:"Исход — решение мастера"},content:"<p>Согласуйте исход с игроком.</p>",buttons:[{action:"fall",label:"Упасть"},{action:"wound",label:"Рана и 1 HP"}]});
    if(answer) await resolveChoice(actor,pending.id,answer);
  }
  if(action === "muscle") await (await new Roll(`1d${muscleDie(active(actor))}`).evaluate()).toMessage({speaker:ChatMessage.getSpeaker({actor}),flavor:"Надрыв мышцы: ручной штраф. Если Midi-QOL уже применил штраф автоматически, повторно не вычитайте"});
  if(action === "add") {
    const value = await chooseEntry("Добавить рану",[
      ...Object.entries(GRIEVOUS).map(([k,e])=>({value:`grievous:${k}`,name:`Тяжёлая: ${e.name}`})),
      ...Object.entries(PERMANENT).map(([k,e])=>({value:`permanent:${k}`,name:`Постоянная: ${e.name}`}))]);
    if(value) {const [kind,key]=value.split(":");await addWound(actor,kind,key);}
  }
  if(action === "remove") {
    const value = await chooseEntry("Удалить / исцелить рану",list.map(r=>({value:r.effectId,name:`${r.kind === "permanent" ? "Постоянная" : "Тяжёлая"}: ${(r.kind === "permanent" ? PERMANENT : GRIEVOUS)[r.key]?.name} [${r.effectId}]${r.disabled?" · отключена":""}`})));
    if(value && await foundry.applications.api.DialogV2.confirm({window:{title:"Удаление раны"},content:"<p>Удалить выбранную рану? Постоянная рана по книге требует Regenerate; протез может компенсировать её эффекты.</p>"})) await locked(actor,()=>{requireSettled(actor);return actor.deleteEmbeddedDocuments("ActiveEffect",[value]);});
  }
  if(action === "temporary") {
    const effects = actor.effects.filter(e=>e.getFlag(ID,"temporary"));
    const value = await chooseEntry("Снять временный эффект",effects.map(e=>({value:e.id,name:e.name})));
    if(value) await locked(actor,()=>actor.deleteEmbeddedDocuments("ActiveEffect",[value]));
  }
  if(action && action !== "close") return open(actor);
}
async function chooseEntry(title,entries) {
  if(!entries.length) return ui.notifications.info("Список пуст.");
  return dlg({window:{title},content:`<select name="entry">${entries.map(e=>`<option value="${esc(e.value)}">${esc(e.name)}</option>`).join("")}</select>`,buttons:[{action:"choose",label:"Выбрать",callback:(_e,b)=>b.form.elements.entry.value},{action:"cancel",label:"Отмена",callback:()=>false}]});
}
Hooks.on("getHeaderControlsActorSheetV2",(sheet,controls)=>{
  if(sheet.actor?.type === "character" && sheet.actor.isOwner) controls.push({icon:"fa-solid fa-droplet",label:"Ранения",onClick:()=>run(open(sheet.actor))});
});
Hooks.once("setup",()=>{
  if(typeof globalThis.libWrapper === "undefined") {
    ui.notifications.error("Тяжёлые ранения: требуется активный libWrapper.");
    return;
  }
  libWrapper.register(ID,"CONFIG.Actor.documentClass.prototype.update",function(wrapped,data,options={}) {
    return applyDamageUpdate(this,wrapped,data,options);
  },"WRAPPER");
  libWrapper.register(ID,"CONFIG.Actor.documentClass.prototype.prepareData",function(wrapped,...args) {
    const result = wrapped(...args);
    prepareWoundData(this);
    return result;
  },"WRAPPER");
  libWrapper.register(ID,"CONFIG.Actor.documentClass.prototype._rest",async function(wrapped,config,result) {
    const allow=config.type === "long";
    if(allow)longRestHealing.add(this.uuid);
    try{return await wrapped(config,result);} finally {if(allow)longRestHealing.delete(this.uuid);}
  },"WRAPPER");
  libWrapper.register(ID,"CONFIG.Actor.documentClass.prototype.initiateRest",async function(wrapped,config={}) {
    const limited = ["short","quick"].includes(config.type);
    if(limited) restSessions.set(this.uuid,{spent:0});
    try {return await wrapped(config);} finally {if(limited) restSessions.delete(this.uuid);}
  },"WRAPPER");
});
Hooks.once("ready",()=>{
  for(const actor of allActors()) actor.prepareData();
  game.modules.get(ID).api = {open,rollWound,addWound,treat,requestChoice,resolveChoice,records,eventLog,openJournal,resumeDamage,undoPreview,undoEvent,abandonDamage,auditWounds,repairPreview,repairWound};
  if(game.system.id !== "dnd5e" || !game.system.version.startsWith("6.")) ui.notifications.warn("Тяжёлые ранения: модуль рассчитан на dnd5e 6.x.");
  if(leadGM() && allActors().some(a=>a.getFlag(ID,"pending")||a.getFlag(ID,"beforeDamage"))) ui.notifications.info("Есть незавершённый выбор при 0 HP. Откройте ранения соответствующего персонажа.");
  console.info(`${ID} | Loaded. API: game.modules.get('${ID}').api.open()`);
});

// Midi explicitly awaits this hook, unlike core roll hooks. Never use an async
// core preRoll hook to mutate damage after the system has continued processing.
Hooks.on("midi-qol.DamageRollComplete",async workflow=>{
  if(!game.settings.get(ID,"autoMuscle") || !has(workflow.actor,"muscle")) return;
  if(modifiedDamage.get(workflow) === workflow.damageRolls) return;
  const activity = workflow.activity;
  const weapon = workflow.item?.type === "weapon";
  const unarmed = workflow.item?.system?.type?.value === "unarmed" || activity?.attack?.type?.classification === "unarmed";
  if(!activity || activity.type !== "attack" || (!weapon && !unarmed)) return;
  if(typeof workflow.setDamageRolls !== "function" || !workflow.damageRolls?.length) return;
  const penalty = await new Roll(`1d${muscleDie(active(workflow.actor))}`).evaluate();
  await penalty.toMessage({speaker:ChatMessage.getSpeaker({actor:workflow.actor}),flavor:"Надрыв мышцы: этот штраф уже вычитается из урона Midi-QOL"});
  let remaining = penalty.total;
  const rolls = [];
  for(const original of workflow.damageRolls) {
    if(remaining<=0 || ["healing","temphp"].includes(original.options.type)) {rolls.push(original);continue;}
    const deduction = Math.min(Math.max(0,original.total),remaining);
    remaining-=deduction;
    // Preserve evaluated dice terms and options, but do not reroll or double the penalty on a critical.
    const utility = catUtils()?.rollUtils;
    let adjusted;
    if(utility?.addToRoll) {
      adjusted = await utility.addToRoll(original,`-${deduction}`);
    } else {
      const terms = [...original.terms,
        new foundry.dice.terms.OperatorTerm({operator:"-"}),
        new foundry.dice.terms.NumericTerm({number:deduction})];
      adjusted = CONFIG.Dice.DamageRoll.fromTerms(terms,{...original.options,configured:true});
      if(!adjusted._evaluated) await adjusted.evaluate();
    }
    rolls.push(adjusted);
  }
  await workflow.setDamageRolls(rolls);
  modifiedDamage.set(workflow,workflow.damageRolls);
});
