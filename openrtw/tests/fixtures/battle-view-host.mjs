// Synthetic DOM/device fixture for the real view. Default C ABI is mocked;
// callers may inject reconstructed WASM. No browser/GPU or combat goldens.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as checkpointCodec from '../../platform/web/games/rome-original/checkpoint-storage.js';
let source = await readFile(new URL('../../platform/web/battle-view.js', import.meta.url), 'utf8');
source = source.replace("'/runtime/failure.js'", JSON.stringify(new URL('../../platform/web/runtime/failure.js', import.meta.url).href));
source = source.replace("'/runtime/fixed-step-clock.js'", JSON.stringify(new URL('../../platform/web/runtime/fixed-step-clock.js', import.meta.url).href));
source = source
  .replace("import createRenderer from '/renderer/renderer.mjs';", 'const createRenderer=()=>{};')
  .replace(
    /import \{\s*createRendererBridge\s*\} from '\/reference\/renderer-bridge\.js';/,
    'const createRendererBridge=options=>globalThis.__battleViewDeps.bridge(options);'
  )
  .replace(
    /import \{\s*createBattleScene\s*\} from '\/battle-scene\.js';/,
    'const createBattleScene=options=>globalThis.__battleViewDeps.scene(options);'
  );
const { createBattleView } = await import(
  'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
);
class Element extends EventTarget {
  constructor(doc, tag) {
    super();
    this.ownerDocument = doc;
    this.tagName = tag;
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.value = '';
    this.disabled = false;
    this.open = false;
    this.width = 960;
    this.height = 600;
    this.attrs = {};
  }
  append(...nodes) {
    nodes.forEach((n) => {
      n.parent = this;
      this.children.push(n);
    });
  }
  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }
  insertBefore(n, b) {
    n.parent = this;
    this.children.splice(this.children.indexOf(b), 0, n);
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((n) => n !== this);
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 960, height: 600 };
  }
  setPointerCapture() {}
  showModal() {
    if (this.modalError) throw Error('dialog failure');
    this.open = true;
  }
  close() {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  }
}
const raf = new Map();
let rafId = 0;
globalThis.requestAnimationFrame = (fn) => {
  raf.set(++rafId, fn);
  return rafId;
};
globalThis.cancelAnimationFrame = (id) => raf.delete(id);
let resizeDisconnectError = null;
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() { if (resizeDisconnectError) throw resizeDisconnectError; }
};
globalThis.getComputedStyle = () => ({
  borderLeftWidth: '0',
  borderRightWidth: '0',
  borderTopWidth: '0',
  borderBottomWidth: '0',
});
function frame(time) {
  const queue = [...raf.values()];
  raf.clear();
  queue.forEach((fn) => fn(time));
}
const drain = async () => {
  for (let i = 0; i < 24; i++) await Promise.resolve();
};
function event(target, type, values = {}) {
  const e = new Event(type, { cancelable: true });
  Object.entries(values).forEach(([key, value]) => Object.defineProperty(e, key, { value }));
  target.dispatchEvent(e);
  return e;
}
function row(id, team) {
  return {
    id,
    team,
    actorId: team ? 1 : 0,
    sourceFactionIndex: team,
    sourceCharacterIndex: 0,
    armyIndex: 0,
    sourceLine: 12 + id,
    type: 'roman hastati',
    model: 'roman_hastati',
    category: 'infantry',
    unitClass: 'heavy',
    sourceSoldierCount: 40,
    sourceCount: null,
    usesExplicitSourceCount: false,
    initialSoldiers: 40,
    soldiers: 40,
    hitPoints: 40,
    maxHitPoints: 40,
    manHitPoints: 1,
    x: team ? 57 : 6,
    y: 23,
    order: 'hold',
    destination: null,
    targetId: null,
    ammo: 0,
    cooldownTicks: 0,
    formationRanks: 4,
    spacingMillimetres: [1000, 1000, 1000, 1000],
    sourceProfile: {
      line: 20,
      attack: 7,
      defence: 10,
      rangeMetres: 0,
      delayTenths: 10,
      weaponOpaqueTail: 'literal',
    },
  };
}
function battle() {
  return {
    schema: 'openrtw-battle-session-v1',
    ruleProfile: 'openrtw-battle-prototype-v1',
    generation: 9,
    revision: 0,
    campaignGeneration: 4,
    campaignRevision: 3,
    campaignOrderRevision: 2,
    ticks: 0,
    tickMilliseconds: 100,
    outcome: 'ongoing',
    width: 64,
    height: 48,
    cellMetres: 5,
    playerActorId: 0,
    enemyActorId: 1,
    countPolicy: 'explicit-source-count-else-unscaled-definition-v1',
    campaignResultsApplied: false,
    teams: [
      { team: 0, actorId: 0, name: 'Flavius', faction: 'romans_julii' },
      { team: 1, actorId: 1, name: 'Enemy', faction: 'romans_brutii' },
    ],
    units: [row(0, 0), row(1, 1)],
  };
}
const args = {
  playerId: 0,
  enemyId: 1,
  campaignGeneration: 4,
  campaignRevision: 3,
  campaignOrderRevision: 2,
};
function fixture(options = {}) {
  const doc = { createElement: (tag) => new Element(doc, tag) },
    dialog = new Element(doc, 'dialog'),
    mount = new Element(doc, 'div'),
    status = new Element(doc, 'p'),
    controls = new Element(doc, 'div');
  dialog.querySelector = (q) =>
    ({
      '[data-battle-mount]': mount,
      '[data-battle-status]': status,
      '[data-battle-controls]': controls,
    })[q];
  dialog.modalError = options.modalError;
  const calls = [],
    errors = [],
    state = {
      campaign: JSON.stringify({
        generation: 4,
        revision: 3,
        orderRevision: 2,
        characters: [
          { id: 0, x: 89, y: 82 },
          { id: 1, x: 91, y: 80 },
        ],
      }),
      snapshot: null,
      save: new Uint8Array([82, 84, 87, 2, 1, 2, 3]),
      active: false,
      refuse: false,
    },
    encoder = new TextEncoder();
  const core = {
    HEAPU8: new Uint8Array(1024 * 1024),
    UTF8ToString: () => state.error ?? 'mock refusal',
    _openrtw_error: () => 1,
  };
  const write = (p, value) => {
    const bytes = encoder.encode(value);
    core.HEAPU8.fill(0, p, p + bytes.length + 1);
    core.HEAPU8.set(bytes, p);
    return p;
  };
  core._openrtw_campaign_session_json = () => write(64, state.campaign);
  core._openrtw_export_campaign_journey_save = (...tokens) => {
    calls.push(['export', ...tokens]);
    assert.deepEqual(tokens, [4, 3, 2]);
    if (state.active) return 0;
    core.HEAPU8.set(state.save, 900000);
    return 1;
  };
  core._openrtw_campaign_save_bytes = () => 900000;
  core._openrtw_campaign_save_size = () => state.save.length;
  core._openrtw_battle_json = () =>
    state.active && state.snapshot ? write(4096, JSON.stringify(state.snapshot)) : 0;
  core._openrtw_begin_battle = (...tokens) => {
    calls.push(['begin', ...tokens]);
    if (options.beginRefusal) return 0;
    state.active = true;
    state.snapshot = battle();
    options.mutateBegin?.(state.snapshot);
    return 1;
  };
  core._openrtw_leave_battle = (gen, rev) => {
    calls.push(['leave', gen, rev]);
    if (gen !== state.snapshot.generation || rev !== state.snapshot.revision) return 0;
    state.active = false;
    if (options.changedReturnSave) state.save[0] ^= 1;
    return 1;
  };
  for (const name of ['move', 'attack', 'hold', 'step', 'retreat'])
    core[
      '_openrtw_' +
        (name === 'step' ? 'step_battle' : name === 'retreat' ? 'retreat_battle' : 'battle_' + name)
    ] = (...values) => {
      calls.push([name, ...values]);
      const gen = values.at(-2),
        rev = values.at(-1);
      assert.equal(gen, state.snapshot.generation);
      assert.equal(rev, state.snapshot.revision);
      if (state.refuse) {
        if (options.mutateRefusal) state.snapshot.revision++;
        return 0;
      }
      const s = state.snapshot;
      if (name === 'step') {
        s.ticks += values[0];
        s.revision += values[0];
      } else {
        s.revision++;
        if (name === 'move') {
          s.units[values[0]].order = 'move';
          s.units[values[0]].destination = { x: values[1], y: values[2] };
        }
        if (name === 'attack') {
          s.units[values[0]].order = 'attack';
          s.units[values[0]].targetId = values[1];
        }
        if (name === 'hold') {
          s.units[values[0]].order = 'hold';
          s.units[values[0]].destination = null;
          s.units[values[0]].targetId = null;
        }
        if (name === 'retreat') s.outcome = 'retreated';
      }
      options.mutateCommand?.(s);
      return 1;
    };
  let resolveFactory,
    rendererDisposed = 0,
    sceneDisposed = 0,
    draws = 0,
    pickedUnit = 0;
  const r = {
      resize() {},
      dispose() {
        rendererDisposed++;
        options.onRendererDispose?.();
        if (options.cleanupError) throw Error('renderer cleanup failure');
      },
    },
    scene = {
      draw() {
        draws++;
      },
      dispose() {
        sceneDisposed++;
        options.onSceneDispose?.();
      },
      pickUnit: () => pickedUnit,
      pickCell: () => ({ x: 10, y: 23 }),
      pan() {
        calls.push(['pan']);
      },
      orbit() {
        calls.push(['orbit']);
      },
      zoom() {},
      centerFormation(id) {
        calls.push(['center', id]);
        if (options.centerError) throw Error('center camera failure');
        return !options.centerRefusal;
      },
    };
  globalThis.__battleViewDeps = {
    bridge: () =>
      options.lateFactory
        ? new Promise((resolve) => {
            resolveFactory = resolve;
          })
        : Promise.resolve(r),
    scene: () => {
      if (options.sceneError) throw Error('scene init failure');
      return scene;
    },
  };
  const view = createBattleView({
    dialog,
    core: options.core ?? core,
    checkpointCodec: options.checkpointCodec === null ? null : checkpointCodec,
    unitGeometry: {},
    canOpen: () => true,
    onSaveCheckpoint: options.onSaveCheckpoint,
    onLoadCheckpoint: options.onLoadCheckpoint,
    canSaveCheckpoint: options.canSaveCheckpoint ?? (() => true),
    canLoadCheckpoint: options.canLoadCheckpoint ?? (() => true),
    onFailure: options.onFailure ?? ((e) => errors.push(String(e))),
    onState: options.onState,
  });
  const find = (key) => controls.children.find((n) => key in n.dataset),
    canvas = () => mount.children.find((n) => n.tagName === 'canvas');
  return {
    view,
    dialog,
    mount,
    status,
    controls,
    core: options.core ?? core,
    scene,
    state,
    calls,
    errors,
    find,
    canvas,
    resolve: () => resolveFactory(r),
    picked: (id) => {
      pickedUnit = id;
    },
    get rendererDisposed() {
      return rendererDisposed;
    },
    get sceneDisposed() {
      return sceneDisposed;
    },
    get draws() {
      return draws;
    },
  };
}

export { fixture, args, frame, event, drain, raf };
export const setResizeDisconnectError = (error) => { resizeDisconnectError = error; };
