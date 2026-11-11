import {resolve} from 'node:path';
import {readFile} from 'node:fs/promises';
Math.clamp = (value,min,max)=>Math.min(max,Math.max(min,value));
const source = name => readFile(resolve(process.argv[2] ?? 'tmp/actor-preparation', name+'-6.0.6.mjs'), 'utf8');
const common = await source('common');
const fields = [...common.matchAll(/static #(BONUS_FIELD_PATHS|ABILITY_BONUS_FIELD_PATHS|SKILL_TOOL_BONUS_FIELD_PATHS) = \[[\s\S]*?\n  \];/g)].map(m=>m[0]).join('\n');
function method(text, name) {
 const start = text.indexOf(`  ${name}(`);
 return text.slice(start,text.indexOf('\n  /*',start)).trim();
}
const foundry = {utils:{getProperty:(o,p)=>p.split('.').reduce((a,k)=>a?.[k],o),logCompatibilityWarning:()=>{}}};
const Common = new Function('foundry',`return class CommonTemplate {${fields}\n${method(common,'shimBonusData')}}`)(foundry);
const deps = {
 HitDice:class {}, Proficiency:{calculateMod:()=>2}, CONFIG:{DND5E:{maxLevel:20,actorSizes:{med:{hitDie:8}}}},
 AttributesFields:{prepareBaseArmorClass(){},prepareBaseEncumbrance(){}},
 MovementField:{_shim(){}},SensesField:{_shim(){}}
};
for (const type of ['character','npc']) {
 const Data = new Function('Base','deps',`const {HitDice,Proficiency,CONFIG,AttributesFields,MovementField,SensesField}=deps; return class extends Base {${method(await source(type),'prepareBaseData')}}`)(Common,deps);
 const data = Object.assign(new Data(),{
  parent:{items:[{type:'class',system:{levels:3}}],getLevelExp:()=>1000,getCRExp:()=>0},
  details:{level:0,xp:{value:0},cr:1},traits:{size:'med'},
  attributes:{hp:{formula:'1d8'},hd:{},concentration:{bonuses:{},roll:{bonus:''}},death:{bonuses:{},roll:{bonus:''}}},
  resources:{lair:{value:0,inside:false},legact:{max:0},legres:{max:0}}
 });
 data.prepareBaseData();
 console.log(type,'first preparation:',data.details.level,'configurable save:',Object.getOwnPropertyDescriptor(data.attributes.concentration.bonuses,'save').configurable);
 try {data.prepareBaseData();throw Error('Unexpectedly accepted duplicate preparation');}
 catch(error) {console.log(type,'second preparation:',data.details.level,error.toString());if(!/Cannot redefine property: save/.test(error.message)||data.details.level!==6)throw error;}
}
