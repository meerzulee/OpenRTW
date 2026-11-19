import assert from 'node:assert/strict';
import {
  resolveCampaignInteraction as resolve,
  movementTerrainReason,
  routeTerrainReason,
} from '../platform/web/campaign-interactions.js';
const selected = { id: 0, type: 'named character', name: 'Flavius', x: 1, y: 1 };
const ground = { kind: 'ground', x: 3, y: 1 };
const route = {
  status: 'ok',
  plannedSteps: 2,
  partial: false,
  target: { x: 3, y: 1 },
  points: [
    { x: 1, y: 1 },
    { x: 2, y: 1 },
    { x: 3, y: 1 },
  ],
};
let passed = 0;
const test = (name, run) => {
  run();
  passed++;
  console.log('PASS ' + name);
};
const character = (id, owned, type = 'named character') => ({
  kind: 'character',
  owned,
  actor: { id, type, name: `Actor ${id}` },
});
test('inspection and selection never become commands without a controllable selected actor', () => {
  for (const chosen of [null, selected]) {
    const context = { selected: chosen, controllable: false };
    assert.equal(resolve({ ...context, target: character(1, true) }).action, 'select');
    assert.equal(resolve({ ...context, target: character(2, false) }).action, 'inspect');
    for (const kind of ['settlement', 'port'])
      for (const owned of [false, true])
        assert.equal(
          resolve({ ...context, target: { kind, id: 4, name: 'Town', owned } }).action,
          'inspect'
        );
    assert.equal(resolve({ ...context, target: ground, route }).action, 'none');
  }
});
test('supported own-character selection does not imply merging; enemies and civilian missions stay blocked', () => {
  for (const actor of [selected, { ...selected, type: 'diplomat' }, { ...selected, type: 'spy' }]) {
    for (const target of [character(0, true), character(1, true)]) {
      const r = resolve({ selected: actor, controllable: true, target, route });
      assert.equal(r.action, 'select');
      assert.equal(r.cursor, 'selectable');
      assert(!/merge/i.test(r.message));
    }
    for (const type of ['named character', 'spy', 'diplomat', 'admiral']) {
      const r = resolve({
        selected: actor,
        controllable: true,
        target: character(2, false, type),
        route,
      });
      assert.equal(r.action, 'blocked');
      assert.equal(r.cursor, 'attack-unavailable');
      assert.match(r.message, /not implemented/);
    }
  }
});
test('a valid ground route cannot silently become entering garrison or attacking a structure', () => {
  for (const kind of ['settlement', 'port'])
    for (const owned of [false, true]) {
      const r = resolve({
        selected,
        controllable: true,
        target: { kind, owned, id: 2, name: 'Town' },
        route,
      });
      assert.equal(r.action, 'blocked');
      assert.equal(r.cursor, 'blocked');
      assert.match(r.message, /Left-click to inspect/);
    }
});
test('ground movement requires a route and respects terrain refusals even when the core route is ok', () => {
  const args = { selected, controllable: true, target: ground };
  assert.equal(resolve(args).action, 'none');
  assert.equal(resolve({ ...args, route }).action, 'move');
  assert.match(resolve({ ...args, route }).message, /2 AP/);
  assert.match(resolve({ ...args, route: { ...route, partial: true } }).message, /End turn/);
  assert.equal(resolve({ ...args, route, terrainReason: 'Water is blocked.' }).action, 'blocked');
  assert.equal(
    resolve({ ...args, route: { status: 'no_ap' }, routeReason: 'No action points remain.' })
      .message,
    'No action points remain.'
  );
  assert.equal(resolve({ ...args, route: { status: 'no_op' } }).action, 'none');
  assert.throws(() => resolve({ ...args, route: { ...route, plannedSteps: NaN } }));
});
test('water uses native category IDs, including zero-height-independent beach and unknown-category refusal', () => {
  for (const type of ['named character', 'general', 'spy', 'diplomat', 'admiral'])
    for (let category = 0; category <= 13; category++) {
      const water = [10, 11, 12].includes(category);
      const admitted = type === 'admiral' ? water : !water;
      assert.equal(
        movementTerrainReason({ type }, category) === null,
        admitted,
        `${type} category${category}`
      );
    }
  for (const category of [14, -1, 15, NaN, Infinity, 10.5, '10', null, undefined])
    assert(movementTerrainReason(selected, category));
  assert(movementTerrainReason({ type: 'unsupported' }, 0));
  assert.equal(movementTerrainReason(selected, 4), null, 'no invented mountain rejection');
  assert.equal(movementTerrainReason(selected, 7), null, 'no invented forest rejection');
});
test('interior illegal terrain blocks otherwise legal endpoints for both land and fleets', () => {
  assert.match(
    routeTerrainReason(selected, route, (x) => (x === 2 ? 11 : 0)),
    /water/
  );
  assert.match(
    routeTerrainReason({ ...selected, type: 'admiral' }, route, (x) => (x === 2 ? 0 : 11)),
    /water/
  );
  const queried = [];
  assert.equal(
    routeTerrainReason(selected, route, (x, y) => {
      queried.push([x, y]);
      return x === 1 ? 11 : 0;
    }),
    null
  );
  assert(!queried.some(([x]) => x === 1), 'bound origin is excluded from terrain admission');
  assert(queried.some(([x]) => x === 2) && queried.some(([x]) => x === 3));
});
test('partial journeys still check the final destination and malformed or stale routes fail closed', () => {
  const partial = { ...route, partial: true, target: { x: 8, y: 1 } };
  assert.match(
    routeTerrainReason(selected, partial, (x) => (x === 8 ? 11 : 0)),
    /water/
  );
  for (const invalid of [
    null,
    { ...route, points: [] },
    { ...route, points: [route.points[0], , route.points[2]] },
    { ...route, target: { x: NaN, y: 1 } },
    { ...route, points: [{ x: 0, y: 1 }, route.points[1]] },
  ])
    assert(routeTerrainReason(selected, invalid, () => 0));
  assert(
    routeTerrainReason(selected, route, () => {
      throw Error('Out of bounds');
    })
  );
  assert(routeTerrainReason(selected, route, () => 14));
});
test('resolution is immutable and does not mutate source actors or routes', () => {
  const args = { selected, controllable: true, target: ground, route },
    before = structuredClone(args);
  assert(Object.isFrozen(resolve(args)));
  assert.deepEqual(args, before);
  assert.throws(() => resolve({ selected, controllable: 'true', target: ground, route }));
  assert.throws(() => resolve({ target: { kind: 'character', owned: 'yes', actor: { id: 4 } } }));
  assert.equal(resolve().action, 'none');
});
console.log(`${passed} campaign interaction families passed`);
