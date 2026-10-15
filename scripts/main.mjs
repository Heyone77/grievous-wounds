import {ID, GRIEVOUS, PERMANENT, countWounds, countGrievous, resolveGrievous, resolvePermanent, muscleDie, movementPenalty, hpPenalty, escapeHTML as esc} from "./rules.mjs";

const queryLocks = new Set();
const actionLocks = new Set();
const restSessions = new Map();
const modifiedDamage = new WeakMap();
const permittedHitDieHealing = new Map();
const longRestHealing = new Set();
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
Hooks.on("dnd5e.preApplyDamage",(actor,amount,_updates,options)=>{
  delete options[DAMAGE_CONTEXT];
  if(game.modules.get("midi-qol")?.active && Number.isFinite(amount) && amount > 0) options[DAMAGE_CONTEXT] = {amount};
});

function choiceOwner(actor) {
  const owners = game.users.filter(u=>u.active && !u.isGM && actor.testUserPermission(u,"OWNER"));
  return owners.find(u=>u.character?.uuid === actor.uuid) ?? owners[0];
}
async function askBeforeDamage(actor) {
  const options = {window:{title:`${actor.name}: урон до 0 HP`},
    content:"<div class='gw-panel'><p>Урон рассчитан, но ещё не применён.</p><p><b>Упасть:</b> 0 HP и последствия падения.</p><p><b>Принять рану:</b> ранение и 1 HP без падения. Проверка концентрации от урона сохраняется; сотрясение или смертельная рана прервут концентрацию.</p><p>Закрытие окна игроком передаёт выбор мастеру. Закрытие окна мастером отменяет нанесение этого урона; для продолжения примените его повторно.</p></div>",
    buttons:[{action:"fall",label:"Упасть · 0 HP",default:true},{action:"wound",label:"Принять рану · 1 HP"}]};
  const owner = choiceOwner(actor);
  if(owner) {
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
  if(options[ID] || actor.type !== "character" || !actor.system?.attributes?.hp || !game.user.isGM || !game.modules.get("midi-qol")?.active || !game.settings.get(ID,"enabled") || !game.settings.get(ID,"lastMoment")) return wrapped(data,options);
  const amount = options[DAMAGE_CONTEXT]?.amount;
  const savedChoice = actor.getFlag(ID,"beforeDamage");
  const observedHP = Number(actor.system.attributes.hp.value);
  const beforeHP = Number(savedChoice?.beforeHP ?? observedHP);
  const resumingFatal = savedChoice?.result?.entry?.id === "fatal" && records(actor).some(r=>r.eventId === savedChoice.id);
  const requestedHP = get(data,"system.attributes.hp.value");
  if(options[ID] || !game.user.isGM || !game.modules.get("midi-qol")?.active || !game.settings.get(ID,"enabled") || !game.settings.get(ID,"lastMoment") || actor.type !== "character" || !Number.isFinite(amount) || amount <= 0 || beforeHP <= 0 || requestedHP === undefined || Number(requestedHP) > 0 || (actor.statuses.has("dead") && !resumingFatal)) return wrapped(data,options);
  if(actionLocks.has(actor.uuid)) throw new Error("У персонажа уже выполняется действие с ранениями. Повторите нанесение урона после его завершения.");
  actionLocks.add(actor.uuid);
  try {
    const beforeTemp = Number(actor.system.attributes.hp.temp ?? 0);
    const beforeDeath = {success:Number(actor.system.attributes.death?.success ?? 0),failure:Number(actor.system.attributes.death?.failure ?? 0)};
    const beforeConditions = savedChoice?.beforeConditions ?? Object.fromEntries(["unconscious","prone"].map(status=>[status,actor.statuses.has(status)]));
    const signature = JSON.stringify([beforeHP,beforeTemp,Number(requestedHP),get(data,"system.attributes.hp.temp"),amount,beforeDeath]);
    let pending = savedChoice;
    if(pending && pending.signature !== signature) throw new Error("Осталось незавершённое ранение перед уроном. Повторите исходное нанесение урона; иной урон требует ручного разбора мастером.");
    if(pending && observedHP !== beforeHP && !(records(actor).some(r=>r.eventId === pending.id) && observedHP === Math.min(beforeHP,Number(actor.system.attributes.hp.effectiveMax)))) throw new Error("HP изменились после незавершённого ранения. Требуется ручной разбор мастером.");
    const answer = pending?.answer ?? await askBeforeDamage(actor);
    if(!["fall","wound"].includes(answer)) throw new Error("Нанесение урона отменено до изменения HP. Примените урон повторно, чтобы продолжить.");
    if(Number(actor.system.attributes.hp.value) !== observedHP || Number(actor.system.attributes.hp.temp ?? 0) !== beforeTemp || (actor.statuses.has("dead") && !resumingFatal) || Number(actor.system.attributes.death?.success ?? 0) !== beforeDeath.success || Number(actor.system.attributes.death?.failure ?? 0) !== beforeDeath.failure) throw new Error("Состояние персонажа изменилось во время выбора. Урон не применён; рассчитайте его заново.");
    const update = foundry.utils.deepClone(data);
    const updateOptions = {...options,[ID]:true};
    if(answer === "fall") {
      const failures = active(actor).filter(r=>r.id === "deep").length;
      writeUpdate(update,"system.attributes.death.failure",Math.min(3,beforeDeath.failure+failures));
      const updated = await wrapped(update,updateOptions);
      if(!updated) return updated;
      if(actor.endConcentration) await actor.endConcentration();
      if(beforeDeath.failure+failures>=3) await actor.toggleStatusEffect("dead",{active:true});
      await announce(actor,`<p>Выбрано падение до применения урона: 0 HP, новой раны нет. Провалов от тяжёлых ран: +${failures}.</p>`);
      return updated;
    }
    // Suppress the HP-delta check and replace it once with the full calculated
    // damage DC. Neither the original amount nor temporary HP loss is reduced.
    const plan = concentrationPlan(actor,options,amount);
    updateOptions.noConcentrationCheck = true;
    updateOptions.dnd5e = {...options.dnd5e,concentrationCheck:false};
    if(!pending) {
      pending = {id:foundry.utils.randomID(),signature,answer,beforeHP,beforeConditions};
      await actor.setFlag(ID,"beforeDamage",pending);
    }
    if(!pending.result) {
      pending = {...pending,result:await determineWound(actor)};
      await actor.setFlag(ID,"beforeDamage",pending);
    }
    const result = pending.result;
    if(result.entry.id !== "close" && !records(actor).some(r=>r.eventId === pending.id)) await addWoundInternal(actor,result.kind,result.key,{eventId:pending.id,applyFatalHP:false});
    const fatal = result.entry.id === "fatal";
    const finalHP = fatal ? 0 : Math.min(1,Number(actor.system.attributes.hp.effectiveMax));
    writeUpdate(update,"system.attributes.hp.value",finalHP);
    if(fatal) writeUpdate(update,"system.attributes.death.failure",3);
    // Commit the final HP and clear the saved decision in the same update.
    writeUpdate(update,`flags.${ID}.beforeDamage`,null);
    const updated = await wrapped(update,updateOptions);
    if(!updated) return updated;
    if(fatal || finalHP <= 0) {
      if(actor.endConcentration) await actor.endConcentration();
      if(fatal) await actor.toggleStatusEffect("dead",{active:true});
    } else {
      for(const status of ["unconscious","prone"]) if(beforeConditions[status] && !actor.statuses.has(status)) await actor.toggleStatusEffect(status,{active:true});
      if(result.entry.id === "close") await actor.toggleStatusEffect("prone",{active:true});
    }
    await announce(actor,`<p>Выбрано ранение до применения урона: <b>${esc(result.entry.name)}</b>. HP: ${finalHP}.</p><p>${esc(result.entry.text)}</p>`);
    // A failed/cancelled save never causes the damage or injury to be applied again.
    try {await checkDamageConcentration(actor,plan);} catch(error) {
      report(error);
      await announce(actor,`<p>Урон и ранение применены. Завершите проверку концентрации вручную: СЛ ${plan?.dc}.</p>`);
    }
    return updated;
  } finally {actionLocks.delete(actor.uuid);}
}

// This hook runs synchronously on the initiating client. Pending state is saved
// atomically with the HP change; no custom socket or player-supplied command executes.
Hooks.on("preUpdateActor",(actor,changes,options) => {
  if(options[ID] || actor.type !== "character" || !game.settings.get(ID,"enabled")) return;
  const value = get(changes,"system.attributes.hp.value");
  if(value === undefined) return;
  if(Number(value) > 0 && actor.getFlag(ID,"pending")) {
    foundry.utils.setProperty(changes,`flags.${ID}.pending`,null);
    return;
  }
  if(Number(value) > 0 || Number(actor.system.attributes.hp.value) <= 0) return;
  const death = actor.system.attributes.death ?? {};
  foundry.utils.setProperty(changes,`flags.${ID}.pending`,{
    id:foundry.utils.randomID(), created:Date.now(),
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
    content:`<div class="gw-panel"><p>Выберите исход до продолжения боя:</p><p><b>Упасть:</b> остаться с 0 HP, без новой раны.</p><p><b>Принять рану:</b> бросить 2d10 минус накопленные тяжёлые раны и остаться с 1 HP. Возможна постоянная, в том числе смертельная, травма.</p><p class="gw-note">Закрытие окна откладывает выбор. До решения не совершайте новые броски или действия этим персонажем.</p></div>`,
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

export async function resolveChoice(actor, pendingId, answer) {
  return locked(actor,async()=>{
    const pending = actor.getFlag(ID,"pending");
    if(!pending || pending.id !== pendingId) return;
    if(!["fall","wound"].includes(answer)) throw new Error("Неизвестный исход.");
    if(Number(actor.system.attributes.hp.value)>0 || actor.statuses.has("dead")) {
      await actor.unsetFlag(ID,"pending");
      return ui.notifications.warn("HP или состояние изменились; старый выбор отменён.");
    }
    const currentDeath = actor.system.attributes.death ?? {};
    if(Number(currentDeath.success ?? 0)!==pending.beforeDeath.success || Number(currentDeath.failure ?? 0)!==pending.beforeDeath.failure) {
      return ui.notifications.warn("После падения изменились спасброски от смерти. Сначала мастер должен разрешить этот случай вручную; старый выбор не применяется.");
    }
    if(answer === "fall") {
      const failures = active(actor).filter(r=>r.id === "deep").length;
      await actor.update({[`flags.${ID}.pending`]:null,
        "system.attributes.death.failure":Math.min(3,pending.beforeDeath.failure+failures)}, {[ID]:true});
      if(pending.beforeDeath.failure+failures>=3) await actor.toggleStatusEffect("dead",{active:true});
      await announce(actor,`<p>Выбрано падение: 0 HP, новой раны нет.${failures ? ` Провалов от тяжёлых ран: +${failures}.` : ""}</p>`);
      return;
    }
    // Persist the roll first, so retrying an interrupted resolution never rerolls.
    let result = pending.result;
    if(!result) {
      result = await determineWound(actor);
      await actor.setFlag(ID,"pending",{...pending,result});
    }
    if(result.entry.id !== "close" && !records(actor).some(r=>r.eventId === pendingId)) {
      await addWoundInternal(actor,result.kind,result.key,{eventId:pendingId});
    }
    if(result.entry.id === "fatal") {
      await actor.update({"system.attributes.hp.value":0,"system.attributes.death.failure":3,[`flags.${ID}.pending`]:null},{[ID]:true});
      await actor.toggleStatusEffect("dead",{active:true});
    } else {
      await clearDropConditions(actor,pending,{keepProne:result.entry.id === "close"});
      await actor.update({"system.attributes.hp.value":1,
        "system.attributes.death.success":pending.beforeDeath.success,
        "system.attributes.death.failure":pending.beforeDeath.failure,
        [`flags.${ID}.pending`]:null},{[ID]:true});
      // HP updates can also change system statuses; preserve conditions from before the drop.
      for(const status of ["unconscious","prone"]) {
        if(pending.beforeConditions?.[status]?.active && !actor.statuses.has(status)) await actor.toggleStatusEffect(status,{active:true});
      }
      if(result.entry.id === "close") await actor.toggleStatusEffect("prone",{active:true});
      if(actor.system.attributes.hp.effectiveMax < 1) await announce(actor,"<p>Максимум HP снижен до 0. Остаться с 1 HP невозможно; требуется решение мастера.</p>");
    }
    await announce(actor,`<p>Выбрано ранение: <b>${esc(result.entry.name)}</b>.</p><p>${esc(result.entry.text)}</p>`);
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
    return {...result,...permanent};
  }
  return result;
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
  const record = {id:entry.id,kind,key,eventId,created:Date.now()};
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
    type:"base",statuses,system:{changes},flags:{[ID]:{wound:record}}
  }]);
  if(entry.id === "battered") await actor.update({"system.attributes.exhaustion":Number(actor.system.attributes.exhaustion ?? 0)+1},{[ID]:true});
  if(entry.id === "hesitant") await actor.setFlag(ID,"hesitantReady",true);
  if(entry.id === "concussion" && actor.endConcentration) await actor.endConcentration();
  if(entry.id === "fatal" && applyFatalHP) await actor.update({"system.attributes.hp.value":0,"system.attributes.death.failure":3},{[ID]:true});
  return effect;
}
export async function addWound(actor,kind,key) {return locked(actor,()=>addWoundInternal(actor,kind,Number(key)));}
export async function rollWound(actor=selectedActor()) {
  if(!actor) return ui.notifications.warn("Выберите токен.");
  return locked(actor,async()=>{
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

export async function open(actor=selectedActor()) {
  if(!actor) {
    const available = game.actors.filter(a=>a.type === "character" && (game.user.isGM || a.isOwner));
    const id = await dlg({window:{title:"Ранения — персонаж"},content:`<label>Персонаж<select name="actor">${available.map(a=>`<option value="${esc(a.id)}">${esc(a.name)}</option>`).join("")}</select></label>`,buttons:[{action:"open",label:"Открыть",callback:(_e,b)=>b.form.elements.actor.value}]});
    if(!id) return;actor = game.actors.get(id);
  }
  if(!actor || (!actor.isOwner && !game.user.isGM)) return;
  const list = records(actor), pending = actor.getFlag(ID,"pending");
  const buttons = [{action:"close",label:"Закрыть",default:true}];
  if(game.user.isGM) buttons.unshift({action:"roll",label:"Бросить рану"},{action:"add",label:"Добавить вручную"},{action:"remove",label:"Удалить рану"},{action:"treat",label:"Лечение"});
  if(game.user.isGM && pending) buttons.unshift({action:"query",label:"Спросить игрока"},{action:"resolve",label:"Мастер: выбрать исход"});
  if(has(actor,"muscle")) buttons.push({action:"muscle",label:`Штраф урона: 1d${muscleDie(active(actor))}`});
  if(game.user.isGM && actor.effects.some(e=>e.getFlag(ID,"temporary"))) buttons.push({action:"temporary",label:"Снять временный эффект"});
  const action = await dlg({classes:["gw-wounds-dialog"],window:{title:`Ранения: ${actor.name}`},position:{width:620},content:`<div class="gw-panel"><p>HP: ${actor.system.attributes.hp.value}/${actor.system.attributes.hp.effectiveMax}. Активных ран: <b>${countWounds(active(actor))}</b>; тяжёлых (штраф к 2d10): <b>${countGrievous(active(actor))}</b>.</p>${pending ? '<p class="gw-note">Ожидается выбор при 0 HP.</p>' : ""}<ul>${list.map(r=>{const e=(r.kind === "permanent" ? PERMANENT : GRIEVOUS)[r.key];return `<li><b>${esc(e?.name ?? r.id)}</b> · ${r.kind === "permanent" ? "постоянная" : "тяжёлая"}${r.disabled ? " · отключена" : ""}<br><small>${esc(e?.text)}</small></li>`;}).join("") || "<li>Ранений нет.</li>"}</ul><p class="gw-note">Ограничения рук/действий, зрительные проверки и Прилив адреналина требуют участия мастера. При активном Midi-QOL штраф надрыва мышцы применяется автоматически, если включена соответствующая настройка. Кнопка ручного броска предназначена для остальных случаев.</p></div>`,buttons});
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
    const value = await chooseEntry("Удалить / исцелить рану",list.map(r=>({value:r.effectId,name:`${r.kind === "permanent" ? "Постоянная" : "Тяжёлая"}: ${(r.kind === "permanent" ? PERMANENT : GRIEVOUS)[r.key]?.name}`})));
    if(value && await foundry.applications.api.DialogV2.confirm({window:{title:"Удаление раны"},content:"<p>Удалить выбранную рану? Постоянная рана по книге требует Regenerate; протез может компенсировать её эффекты.</p>"})) await locked(actor,()=>actor.deleteEmbeddedDocuments("ActiveEffect",[value]));
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
  game.modules.get(ID).api = {open,rollWound,addWound,treat,requestChoice,resolveChoice,records};
  if(game.system.id !== "dnd5e" || !game.system.version.startsWith("6.")) ui.notifications.warn("Тяжёлые ранения: модуль рассчитан на dnd5e 6.x.");
  if(leadGM() && allActors().some(a=>a.getFlag(ID,"pending"))) ui.notifications.info("Есть незавершённый выбор при 0 HP. Откройте ранения соответствующего персонажа.");
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
