# API references consulted

User-supplied PDF: Campaign Guide (Transformed).pdf, printed pages 288-290 (PDF pages 292-294).
The shared duplicate-result rule on page 288 is applied to the starred entries in both wound tables; the permanent section does not repeat that rule separately.

- Foundry v14 DialogV2: https://foundryvtt.com/api/classes/foundry.applications.api.DialogV2.html
- Foundry v14 Roll: https://foundryvtt.com/api/classes/foundry.dice.Roll.html
- dnd5e 6.0.x source: https://github.com/foundryvtt/dnd5e/tree/6.0.x
- System hooks: https://github.com/foundryvtt/dnd5e/wiki/Hooks
- Midi-QOL source: https://gitlab.com/tposney/midi-qol/-/tree/v13
- Coven's Automation Toolkit source: https://github.com/chrisk123999/covens-automation-toolkit

Only APIs were used; no third-party source files or artwork are bundled.

0.2.0 final-update integration references (published v14 branch; installed 14.6.0 not inspected):
- https://gitlab.com/tposney/midi-qol/-/raw/v14/src/module/GMAction.ts - final damage update and dnd5e.preApplyDamage.
- https://gitlab.com/tposney/midi-qol/-/raw/v14/src/module/Hooks.ts - concentration suppression options and zero-HP concentration loss.
- https://gitlab.com/tposney/midi-qol/-/raw/v14/src/module/utils.ts - doConcentrationCheck and rollConcentration routing.
- https://raw.githubusercontent.com/foundryvtt/dnd5e/6.0.x/module/documents/actor/actor.mjs - getConcentrationDC and rollConcentration.

0.3.0 event identity reference:
- https://gitlab.com/tposney/midi-qol/-/raw/v14/src/module/Workflow.ts - preTargetDamageApplication and per-use item card identity. A temporary activity UUID is not treated as a unique attack ID.
