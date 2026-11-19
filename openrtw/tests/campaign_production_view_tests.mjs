import assert from 'node:assert/strict';
import { createProductionView } from '../platform/web/games/rome-original/production-view.js';
class Element extends EventTarget {
  constructor(tag, doc) { super(); this.tag = tag; this.ownerDocument = doc; this.children = []; this.dataset = {}; this.disabled = false; this.hidden = false; this._text = ''; this._value = ''; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = [...children]; this._text = ''; }
  set textContent(v) { this.children = []; this._text = String(v); }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  setAttribute() {}
  get options() { return this.children.filter(c => c.tag === 'option'); }
  set value(v) { this._value = v; }
  get value() { return this._value || this.options[0]?.value || ''; }
  querySelectorAll(selector) { return this.children.flatMap(c => [...(c.tag === selector ? [c] : []), ...c.querySelectorAll(selector)]); }
}
const doc = { createElement: tag => new Element(tag, doc) }, mount = doc.createElement('section');
let ready = true, reads = 0; const commands = [];
const session = { generation: 3, revision: 7, orderRevision: 11, characters: [{ id: 4, sourceFactionIndex: 0, name: 'Commander', type: 'named character', armyRecords: 1 }] };
const model = { schema: 'openrtw-production-v1', cityId: 0, generation: 3, factionIndex: 0, population: 800, treasury: 500,
  region: 'Test', level: 'village', construction: [], recruitment: [], garrison: [],
  buildings: [{ id: 0, chain: 'barracks', level: 'militia', cost: 100, turns: 2, settlementMin: 'village', upgrades: ['army'], requires: [], effects: [], reason: '', built: false }],
  units: [{ id: 0, name: 'Infantry', soldiers: 40, cost: 100, turns: 2, reason: '' }] };
const core = {
  _openrtw_production_json(city, generation) { assert.equal(city, 0); assert.equal(generation, 3); reads++; return 1; },
  UTF8ToString: () => JSON.stringify(model), _openrtw_error: () => 2,
  _openrtw_production_command(...args) { commands.push(args); session.orderRevision++; return 1; },
};
const view = createProductionView({ mount, core, getSession: () => session, canInteract: () => ready, execute: fn => fn() === 1, playerFactionIndex: 0 });
const buttons = () => mount.querySelectorAll('button');
view.refresh(0); assert(mount.textContent.includes('Building trees')); assert(mount.textContent.includes('Recruit units')); assert(mount.textContent.includes('treasury 500'));
const oldBuild = buttons().find(b => b.textContent === 'Construct'); oldBuild.dispatchEvent(new Event('click'));
assert.deepEqual(commands[0], [0, 0, 0, 0, 0, 3, 7, 11]);
oldBuild.dispatchEvent(new Event('click')); assert.equal(commands.length, 1, 'retired row listeners are inert');
const recruit = buttons().find(b => b.textContent === 'Recruit'); recruit.dispatchEvent(new Event('click'));
assert.equal(commands[1][0], 1); assert.equal(commands[1].at(-1), 12);
const before = reads; view.refresh(0); assert.equal(reads, before, 'unchanged snapshot is cached');
ready = false; view.refresh(0); assert(buttons().every(b => b.disabled));
buttons()[0].dispatchEvent(new Event('click')); assert.equal(commands.length, 2, 'blocked controls cannot command');
ready = true; view.refresh(0); assert(buttons().some(b => !b.disabled));
model.factionIndex = 1; session.orderRevision++; view.refresh(0); assert.equal(buttons().length, 0); assert(mount.textContent.includes('your settlements'));
model.factionIndex = 0; model.units[0].reason = 'Missing barracks'; session.orderRevision++; view.refresh(0);
assert(buttons().find(b => b.textContent === 'Recruit').disabled); assert(mount.textContent.includes('Missing barracks'));
view.refresh(null); assert(mount.hidden); view.refresh(0); const retained = buttons()[0]; view.dispose();
retained.dispatchEvent(new Event('click')); assert.equal(commands.length, 2); view.dispose(); assert.equal(mount.children.length, 0);
console.log('campaign_production_view_tests: construction/recruit dispatch, tokens, source trees, permission fences, cache and listener retirement passed');
