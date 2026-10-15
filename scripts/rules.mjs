export const ID = "grievous-wounds";
// Rules checked against Campaign Guide (Transformed), printed pages 288-290.
export const GRIEVOUS = {
  4: {id:"festering", name:"Загноившаяся рана", text:"Лихорадка: состояние «Отравлен» и помеха на спасброски Телосложения. Иммунитет к отравлению не устраняет отравление от этой раны."},
  5: {id:"internal", name:"Внутреннее кровотечение", stack:true, text:"Максимум HP уменьшается на утроенный уровень персонажа."},
  6: {id:"pain", name:"Мучительная боль", text:"Помеха на спасброски Ловкости."},
  7: {id:"concussion", name:"Сотрясение", text:"Состояние Dazed: нельзя поддерживать концентрацию. Текущая концентрация прекращается, начать новую до лечения раны нельзя."},
  8: {id:"laceration", name:"Глубокий порез", text:"Состояние Bleeding: HP нельзя восстанавливать, кроме траты костей хитов и долгого отдыха. Кровотечение снимается быстрым, коротким или долгим отдыхом; сама рана остаётся до лечения."},
  9: {id:"deep", name:"Тяжёлая рана", stack:true, text:"Каждый раз при снижении до 0 HP получите один провал спасброска от смерти за каждую такую рану."},
  10: {id:"battered", name:"Избит", stack:true, text:"Получите один уровень истощения. Долгий отдых снимает истощение по правилам системы; сама запись ранения остаётся до лечения."},
  11: {id:"wrist", name:"Повреждённое запястье", stack:true, text:"Одна рука не может удерживать предметы и выполнять требующие её действия. Выбор руки и проверка действий — вручную."},
  12: {id:"eardrum", name:"Повреждённая барабанная перепонка", statuses:["deafened"], text:"Состояние «Оглохший»."},
  13: {id:"shock", name:"Нервный шок", text:"Помеха на броски инициативы."},
  14: {id:"leg", name:"Повреждённая нога", stack:true, text:"Скорость уменьшается на 10 футов, минимум до 5 футов. Скорость нельзя увеличить; Рывок недоступен. Запрет Рывка проверяет мастер. Повторные результаты не складывают штраф скорости."},
  15: {id:"muscle", name:"Надрыв мышцы", stack:true, text:"При уроне атакой оружием или безоружным ударом вычтите 1d4. Повторы повышают кость до d6, d8, d10, d12. После пятого надрыва следующий результат заменяется повреждённой ногой. С Midi-QOL штраф вычитается автоматически. Без него кнопка в окне ранений бросает штраф, а мастер вычитает его из урона."},
  16: {id:"recovery", name:"Замедленное восстановление", text:"За короткий или быстрый отдых можно потратить не больше костей хитов, чем модификатор Телосложения, минимум одну. Ограничение автоматически проверяется для штатного короткого отдыха системы."},
  17: {id:"swelling", name:"Сильный отёк", text:"Помеха на проверки Харизмы (Выступление) и Харизмы (Убеждение)."},
  18: {id:"close", name:"На волосок", stack:true, text:"Вместо 0 HP остаётся 1 HP; состояние «Лежащий ничком». Само ранение не добавляется к накопленному счётчику."}
};
export const PERMANENT = {
  1:{id:"fatal",name:"Смертельная рана",text:"Персонаж мёртв. Возвращение к жизни возможно обычными способами."},
  2:{id:"arm",stack:true,name:"Потерянная рука",text:"Одна рука потеряна: нельзя использовать её для оружия, щита и соматических компонентов. Ограничения предметов и действий проверяет мастер."},
  3:{id:"lostleg",stack:true,name:"Потерянная нога",text:"Скорость уменьшается на 15 футов, минимум до 5 футов; её нельзя увеличить, Рывок недоступен. Каждый повтор уменьшает скорость ещё на 15 футов, минимум до 5 футов. Рывок проверяется вручную."},
  4:{id:"eye",stack:true,name:"Потерянный глаз",text:"Помеха на проверки Мудрости (Восприятие) и Интеллекта (Расследование), основанные на зрении. При повторе — «Ослеплённый». Зрительные проверки нужно пометить вручную перед броском."},
  5:{id:"dizzy",name:"Приступы головокружения",text:"В нечётные раунды использование действия блокирует бонусное действие до начала следующего хода и наоборот. Ограничение проверяет мастер; модуль напоминает об этом."},
  6:{id:"lungs",name:"Повреждённые лёгкие",text:"Максимум HP постоянно уменьшается на уровень персонажа. Каждый новый уровень увеличивает уменьшение ещё на 1."},
  7:{id:"scar",name:"Ужасный шрам",text:"Помеха на проверки Харизмы (Выступление) и Харизмы (Убеждение), преимущество на Харизму (Запугивание)."},
  8:{id:"adrenaline",name:"Прилив адреналина",text:"Пока персонаж Окровавлен (не больше половины максимума HP), критическое попадание по нему наносит обычный урон. Пока не Окровавлен, атаки по нему критуют на 19–20. Требует ручной проверки мастером до броска урона."},
  9:{id:"hesitant",name:"Нерешительность",text:"Первый спасбросок против состояния «Испуганный» после короткого или долгого отдыха: «Испуганный», даже при успехе. Источник страха и прекращение состояния определяет мастер."},
  10:{id:"oldpain",name:"Старая боль",text:"При натуральной 1 в любом D20 Test — «Недееспособный» до конца вашего следующего хода. В бою срок отслеживается модулем, вне боя эффект снимается вручную."}
};
export function countWounds(records) { return records.filter(r => r.id !== "close").length; }
export function countGrievous(records) { return countWounds(records.filter(r => r.kind === "grievous")); }
export function resolveGrievous(raw, records) {
  let value = Math.min(18, raw - countGrievous(records));
  while (value > 3) {
    const entry = GRIEVOUS[value];
    if (entry.stack || !records.some(r => r.kind === "grievous" && r.id === entry.id)) {
      if (entry.id === "muscle" && records.filter(r=>r.id === "muscle").length >= 5) {
        return {kind:"grievous", key:14, entry:GRIEVOUS[14], adjusted:raw-countGrievous(records)};
      }
      return {kind:"grievous", key:value, entry, adjusted:raw-countGrievous(records)};
    }
    value--;
  }
  return {kind:"permanent", adjusted:raw-countGrievous(records)};
}
export function resolvePermanent(raw, records) {
  let key = raw;
  if (!Number.isInteger(key) || key < 1 || key > 10) throw new Error("Результат постоянной раны должен быть от 1 до 10.");
  while (key > 1 && !PERMANENT[key].stack && records.some(r => r.kind === "permanent" && r.id === PERMANENT[key].id)) key--;
  return {kind:"permanent", key, entry:PERMANENT[key]};
}
export function muscleDie(records) { return Math.min(12, 2 + 2 * records.filter(r=>r.id === "muscle").length); }
export function movementPenalty(records) {
  const lost = records.filter(r=>r.id === "lostleg").length;
  return {feet: Math.max(lost * 15, records.some(r=>r.id === "leg") ? 10 : 0)};
}
export function hpPenalty(records, level) {
  return records.reduce((n,r)=>n+(r.id === "internal" ? 3*level : r.id === "lungs" ? level : 0),0);
}
export function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
