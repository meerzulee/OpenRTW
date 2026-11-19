import { describeFailure } from '/runtime/failure.js';
import { createFixedStepClock } from '/runtime/fixed-step-clock.js';
import createRenderer from '/renderer/renderer.mjs';
import { createRendererBridge } from '/reference/renderer-bridge.js';
import { createBattleScene } from '/battle-scene.js';

const uint = (n) => Number.isInteger(n) && n >= 0 && n <= 0xffffffff,
  safe = (n) => Number.isSafeInteger(n) && n >= 0,
  text = (s) => typeof s === 'string' && s.length > 0 && s.length <= 255;
const outcomes = new Set(['ongoing', 'player_won', 'enemy_won', 'draw', 'retreated']);
function wire(core, getter, limit = 1024 * 1024) {
  const pointer = core[getter](),
    heap = core.HEAPU8;
  if (!uint(pointer) || !pointer || !(heap instanceof Uint8Array) || pointer >= heap.length)
    throw Error('Core publication unavailable: ' + getter);
  const bytes = heap.slice(pointer, Math.min(heap.length, pointer + limit + 1)),
    end = bytes.indexOf(0);
  if (end < 0 || end > limit) throw Error('Core publication exceeds bound: ' + getter);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end));
}
function saveCopy(core, args) {
  if (
    core._openrtw_export_campaign_journey_save(
      args.campaignGeneration,
      args.campaignRevision,
      args.campaignOrderRevision
    ) !== 1
  )
    throw Error(core.UTF8ToString(core._openrtw_error()) || 'Campaign snapshot export refused');
  const p = core._openrtw_campaign_save_bytes(),
    size = core._openrtw_campaign_save_size(),
    heap = core.HEAPU8;
  if (
    !uint(p) ||
    !p ||
    !Number.isInteger(size) ||
    size < 1 ||
    size > 1024 * 1024 ||
    p > heap.length - size
  )
    throw Error('Invalid campaign save snapshot');
  return heap.slice(p, p + size);
}
// A small ownership envelope is enough to release an accepted session even
// when its formation projection is refused. Never use malformed unit rows to
// resume play or guess a foreign generation during cleanup.
function validateOwnership(snapshot, args, generation = null) {
  if (
    snapshot?.schema !== 'openrtw-battle-session-v1' ||
    snapshot.ruleProfile !== 'openrtw-battle-prototype-v1' ||
    !uint(snapshot.generation) ||
    !snapshot.generation ||
    !uint(snapshot.revision) ||
    snapshot.campaignGeneration !== args.campaignGeneration ||
    snapshot.campaignRevision !== args.campaignRevision ||
    snapshot.campaignOrderRevision !== args.campaignOrderRevision ||
    snapshot.playerActorId !== args.playerId ||
    snapshot.enemyActorId !== args.enemyId ||
    (generation !== null && snapshot.generation !== generation)
  )
    throw Error('Battle generation ownership differs');
  return snapshot;
}
function validate(snapshot, args, prior = null) {
  validateOwnership(snapshot, args, prior?.generation ?? null);
  if (
    snapshot?.schema !== 'openrtw-battle-session-v1' ||
    snapshot.ruleProfile !== 'openrtw-battle-prototype-v1' ||
    !uint(snapshot.generation) ||
    !snapshot.generation ||
    !uint(snapshot.revision) ||
    !uint(snapshot.ticks) ||
    snapshot.ticks > 36000 ||
    snapshot.tickMilliseconds !== 100 ||
    !outcomes.has(snapshot.outcome) ||
    snapshot.width !== 64 ||
    snapshot.height !== 48 ||
    snapshot.cellMetres !== 5 ||
    snapshot.campaignGeneration !== args.campaignGeneration ||
    snapshot.campaignRevision !== args.campaignRevision ||
    snapshot.campaignOrderRevision !== args.campaignOrderRevision ||
    snapshot.playerActorId !== args.playerId ||
    snapshot.enemyActorId !== args.enemyId ||
    snapshot.countPolicy !== 'explicit-source-count-else-unscaled-definition-v1' ||
    snapshot.campaignResultsApplied !== false ||
    !Array.isArray(snapshot.teams) ||
    snapshot.teams.length !== 2 ||
    !Array.isArray(snapshot.units) ||
    snapshot.units.length < 2 ||
    snapshot.units.length > 40
  )
    throw Error('Invalid battle source/profile snapshot');
  if (
    prior &&
    (snapshot.generation !== prior.generation ||
      snapshot.revision < prior.revision ||
      snapshot.ticks < prior.ticks)
  )
    throw Error('Battle identity changed');
  for (const [i, t] of snapshot.teams.entries())
    if (
      t?.team !== i ||
      t.actorId !== (i === 0 ? args.playerId : args.enemyId) ||
      !text(t.name) ||
      !text(t.faction)
    )
      throw Error('Battle team source differs');
  const ids = new Set(),
    counts = [0, 0],
    origins = new Set();
  for (const u of snapshot.units) {
    if (
      !u ||
      !uint(u.id) ||
      u.id !== ids.size ||
      ![0, 1].includes(u.team) ||
      u.actorId !== snapshot.teams[u.team].actorId ||
      !uint(u.sourceFactionIndex) ||
      !uint(u.sourceCharacterIndex) ||
      u.armyIndex !== counts[u.team] ||
      !uint(u.sourceLine) ||
      !u.sourceLine ||
      !text(u.type) ||
      !text(u.model) ||
      !text(u.category) ||
      !text(u.unitClass) ||
      !uint(u.sourceSoldierCount) ||
      (u.sourceCount !== null && (!uint(u.sourceCount) || u.sourceCount > 0x7fffffff)) ||
      u.usesExplicitSourceCount !== (u.sourceCount !== null) ||
      !Number.isInteger(u.initialSoldiers) ||
      u.initialSoldiers < 1 ||
      u.initialSoldiers > 2000 ||
      u.initialSoldiers !== (u.sourceCount ?? u.sourceSoldierCount) ||
      !uint(u.soldiers) ||
      u.soldiers > u.initialSoldiers ||
      !safe(u.hitPoints) ||
      !safe(u.maxHitPoints) ||
      !u.maxHitPoints ||
      u.hitPoints > u.maxHitPoints ||
      !uint(u.manHitPoints) ||
      !u.manHitPoints ||
      u.maxHitPoints !== u.initialSoldiers * u.manHitPoints ||
      u.soldiers !== Math.ceil(u.hitPoints / u.manHitPoints) ||
      !Number.isInteger(u.x) ||
      u.x < 0 ||
      u.x >= 64 ||
      !Number.isInteger(u.y) ||
      u.y < 0 ||
      u.y >= 48 ||
      !['hold', 'move', 'attack'].includes(u.order) ||
      !uint(u.ammo) ||
      !uint(u.cooldownTicks) ||
      !uint(u.formationRanks) ||
      !Array.isArray(u.spacingMillimetres) ||
      u.spacingMillimetres.length !== 4 ||
      u.spacingMillimetres.some((v) => !uint(v)) ||
      !u.sourceProfile ||
      !uint(u.sourceProfile.line) ||
      !u.sourceProfile.line ||
      ['attack', 'rangeMetres', 'delayTenths'].some((k) => !uint(u.sourceProfile[k])) ||
      !safe(u.sourceProfile.defence)
    )
      throw Error('Invalid battle unit snapshot');
    if (
      u.destination !== null &&
      (!u.destination ||
        !Number.isInteger(u.destination.x) ||
        u.destination.x < 0 ||
        u.destination.x >= 64 ||
        !Number.isInteger(u.destination.y) ||
        u.destination.y < 0 ||
        u.destination.y >= 48)
    )
      throw Error('Invalid battle move destination');
    if (u.targetId !== null && !uint(u.targetId)) throw Error('Invalid battle target');
    const origin = u.team + ':' + u.armyIndex;
    if (origins.has(origin) || ++counts[u.team] > 20)
      throw Error('Duplicate/excessive source army rows');
    origins.add(origin);
    ids.add(u.id);
  }
  if (counts.some((n) => n === 0)) throw Error('Battle source army is empty');
  for (const u of snapshot.units)
    if (
      u.targetId !== null &&
      !snapshot.units.some((t) => t.id === u.targetId && t.team !== u.team)
    )
      throw Error('Battle target does not identify opposing source unit');
  if (prior) {
    if (
      snapshot.units.length !== prior.units.length ||
      JSON.stringify(snapshot.teams) !== JSON.stringify(prior.teams)
    )
      throw Error('Battle omitted/changed source units or teams');
    for (let i = 0; i < snapshot.units.length; i++) {
      const u = snapshot.units[i],
        p = prior.units[i];
      for (const key of [
        'id',
        'team',
        'actorId',
        'sourceFactionIndex',
        'sourceCharacterIndex',
        'armyIndex',
        'sourceLine',
        'type',
        'model',
        'category',
        'unitClass',
        'sourceSoldierCount',
        'sourceCount',
        'usesExplicitSourceCount',
        'initialSoldiers',
        'maxHitPoints',
        'manHitPoints',
        'formationRanks',
      ])
        if (u[key] !== p[key]) throw Error('Battle source unit identity changed');
      if (
        JSON.stringify(u.spacingMillimetres) !== JSON.stringify(p.spacingMillimetres) ||
        JSON.stringify(u.sourceProfile) !== JSON.stringify(p.sourceProfile)
      )
        throw Error('Battle source profile changed');
    }
  }
  return snapshot;
}

export function createBattleView({
  dialog,
  core,
  unitGeometry,
  unitTexture = null,
  terrainTexture = null,
  modelAssets = null,
  canOpen,
  checkpointCodec = null,
  onSaveCheckpoint = null,
  onLoadCheckpoint = null,
  canSaveCheckpoint = () => false,
  canLoadCheckpoint = () => false,
  onState = () => {},
  onFailure = () => {},
}) {
  const mount = dialog?.querySelector('[data-battle-mount]'),
    status = dialog?.querySelector('[data-battle-status]'),
    controls = dialog?.querySelector('[data-battle-controls]');
  if (!mount || !status || !controls || typeof canOpen !== 'function' || !core)
    throw TypeError('Battle dialog contract is incomplete');
  const doc = dialog.ownerDocument,
    events = new AbortController(),
    failures = [];
  let disposed = false,
    current = null,
    pending = null,
    returnTask = null,
    disposeTask = null,
    serial = 0,
    viewState = 'closed',
    closingDialog = false;
  controls.replaceChildren();
  const select = doc.createElement('select');
  select.dataset.battleUnit = '';
  select.setAttribute('aria-label', 'Battle formation');
  controls.append(select);
  function button(name, label) {
    const b = doc.createElement('button');
    b.type = 'button';
    b.dataset[name] = '';
    b.textContent = label;
    controls.append(b);
    return b;
  }
  const run = button('battleRun', 'Run'),
    step = button('battleStep', 'One tick'),
    center = button('battleCenter', 'Center selected formation'),
    hold = button('battleHold', 'Hold'),
    retreat = button('battleRetreat', 'Retreat'),
    checkpointSave = button('battleCheckpointSave', 'Save campaign + battle checkpoint'),
    checkpointLoad = button('battleCheckpointLoad', 'Load campaign + battle checkpoint'),
    back = button('battleReturn', 'Return without applying result'),
    speed = doc.createElement('select');
  speed.dataset.battleSpeed = '';
  speed.setAttribute('aria-label', 'Battle simulation speed');
  for (const n of [1, 4]) {
    const option = doc.createElement('option');
    option.value = String(n);
    option.textContent = n + '×';
    speed.append(option);
  }
  controls.insertBefore(speed, step);
  const optionalModels =
    modelAssets === null
      ? []
      : [
          ['roman_archer', 'archers'],
          ['roman_triarii', 'triarii'],
          ['roman_velite', 'velites'],
        ]
          .filter(([type]) =>
            Object.values(modelAssets).some(
              (entry) => entry?.status === 'available' && entry.modelType === type
            )
          )
          .map(([, name]) => name);
  const modelNote =
    modelAssets === null
      ? 'Only Hastati has a loaded original soldier model; other formations are labelled.'
      : `Original static soldier models: Hastati${optionalModels.length ? ', ' + optionalModels.join(', ') : ''}. Additional models use their exact source-faction bindings; unavailable formations are labelled.`;
  const note = doc.createElement('p');
  note.textContent = `OpenRTW battle prototype · imported armies with unscaled counts. ${modelNote} Center selected formation for a close view. Drag to pan, Alt-drag to orbit, scroll to zoom. Static poses and prototype combat; results are not applied to the campaign.`;
  note.dataset.battleNote = '';
  controls.append(note);
  const active = () => current !== null || pending !== null || returnTask !== null;
  const live = (ctx) => !disposed && current === ctx && !ctx.cancelled && !ctx.failed;
  function emit() {
    dialog.dataset.state = viewState;
    dialog.dataset.active = String(active());
    try {
      onState();
    } catch (error) {
      failures.push('Battle state callback: ' + describeFailure(error));
      dialog.dataset.error = failures.join('\n');
    }
  }
  function stopPump(ctx) {
    ctx.running = false;
    ctx.pumpToken = null;
    ctx.clock.reset();
    const frame = ctx.raf;
    ctx.raf = 0;
    if (frame) cancelAnimationFrame(frame);
  }
  function refresh() {
    const ctx = current,
      ready = ctx && live(ctx) && !ctx.operation && ctx.scene && ['paused', 'running'].includes(viewState),
      ongoing = ready && ctx.snapshot.outcome === 'ongoing',
      unit = ctx?.snapshot?.units.find((u) => u.id === ctx.selectedId);
    run.disabled = !ongoing;
    run.textContent = ctx?.running ? 'Pause' : 'Run';
    step.disabled = !ongoing || ctx?.running;
    speed.disabled = !ready;
    select.disabled = !ready;
    center.disabled = !ready || !unit?.soldiers;
    hold.disabled = !ongoing || unit?.team !== 0 || !unit.soldiers;
    retreat.disabled = !ongoing;
    checkpointSave.disabled = !ready || typeof onSaveCheckpoint !== 'function' || !canSaveCheckpoint();
    checkpointLoad.disabled = !ready || typeof onLoadCheckpoint !== 'function' || !canLoadCheckpoint();
    back.disabled = disposed || !ctx || viewState === 'returning' || viewState === 'disposing';
  }
  function fail(ctx, error) {
    failures.push(describeFailure(error));
    status.textContent = 'Battle could not continue: ' + describeFailure(error);
    dialog.dataset.error = failures.join('\n');
    if (ctx) {
      stopPump(ctx);
      ctx.failed = true;
    }
    viewState = 'error';
    refresh();
    emit();
    try {
      onFailure(error);
    } catch (callbackError) {
      failures.push(describeFailure(callbackError));
      dialog.dataset.error = failures.join('\n');
    }
  }
  function update(ctx) {
    if (!ctx.snapshot) return;
    const prior = select.value;
    select.replaceChildren();
    const empty = doc.createElement('option');
    empty.value = '';
    empty.textContent = 'Select a formation';
    select.append(empty);
    for (const u of ctx.snapshot.units) {
      const option = doc.createElement('option');
      option.value = String(u.id);
      option.textContent = `${ctx.snapshot.teams[u.team].name}: ${u.type} · ${u.soldiers}/${u.initialSoldiers} soldiers`;
      select.append(option);
    }
    select.value = ctx.selectedId === null ? '' : String(ctx.selectedId);
    if (!ctx.snapshot.units.some((u) => String(u.id) === select.value)) select.value = prior;
    status.textContent = `${ctx.snapshot.outcome === 'ongoing' ? (ctx.running ? 'Running' : 'Paused') : ctx.snapshot.outcome.replaceAll('_', ' ')} · ${ctx.snapshot.ticks} ticks (${(ctx.snapshot.ticks / 10).toFixed(1)} seconds). ${ctx.message ?? 'Select a player formation; right-click ground to move or an enemy to attack.'} Results are not applied to campaign.`;
    dialog.dataset.battle = ctx.wire;
    dialog.dataset.selectedUnit = ctx.selectedId === null ? '' : String(ctx.selectedId);
    dialog.dataset.speed = String(ctx.speed);
    speed.value = String(ctx.speed);
    refresh();
  }
  function draw(ctx) {
    if (live(ctx) && ctx.scene)
      ctx.scene.draw({ snapshot: ctx.snapshot, selectedId: ctx.selectedId });
  }
  function readOwned(ctx) {
    const value = wire(core, '_openrtw_battle_json'),
      snapshot = validateOwnership(JSON.parse(value), ctx.args, ctx.generation);
    if (wire(core, '_openrtw_campaign_session_json') !== ctx.campaignWire)
      throw Error('Battle changed campaign snapshot');
    ctx.generation = snapshot.generation;
    return { value, snapshot };
  }
  function readBattle(ctx) {
    const { value, snapshot } = readOwned(ctx);
    validate(snapshot, ctx.args, ctx.snapshot);
    ctx.snapshot = snapshot;
    ctx.wire = value;
    return snapshot;
  }
  function command(ctx, name, args = []) {
    if (!live(ctx) || ctx.operation || !ctx.snapshot || !ctx.scene || viewState === 'returning' || ctx.failed)
      return false;
    ctx.commanding = true;
    try {
      const before = ctx.wire,
        s = ctx.snapshot,
        result = core[name](...args, s.generation, s.revision);
      if (result !== 0 && result !== 1) throw Error('Invalid battle command result');
      if (result === 0) {
        const message =
          core.UTF8ToString(core._openrtw_error()) || 'The battle command was refused';
        if (
          wire(core, '_openrtw_battle_json') !== before ||
          wire(core, '_openrtw_campaign_session_json') !== ctx.campaignWire
        )
          throw Error('Refused battle command changed publication');
        ctx.message = message;
        update(ctx);
        return false;
      }
      readBattle(ctx);
      ctx.message = '';
      if (ctx.snapshot.outcome !== 'ongoing') {
        stopPump(ctx);
        viewState = 'paused';
      }
      update(ctx);
      draw(ctx);
      emit();
      return true;
    } catch (error) {
      fail(ctx, error);
      return false;
    } finally {
      ctx.commanding = false;
    }
  }
  function persistenceContext(operation = null) {
    const ctx = current;
    if (!ctx || !live(ctx) || !ctx.scene || (ctx.operation && ctx.operation !== operation) || ctx.commanding ||
        !['paused', 'running'].includes(viewState))
      throw Error('Battle persistence needs a ready, idle controller');
    if (wire(core, '_openrtw_battle_json') !== ctx.wire ||
        wire(core, '_openrtw_campaign_session_json') !== ctx.campaignWire)
      throw Error('Battle persistence source changed');
    return ctx;
  }
  function requireCheckpointCodec() {
    if (checkpointCodec?.campaignBattleSavePayloadSchema !== 'rome-original.campaign-battle-checkpoint/v1' ||
        typeof checkpointCodec.copyCampaignBattleCheckpoint !== 'function')
      throw Error('Compound checkpoint codec is unavailable');
    return checkpointCodec;
  }
  function captureSave(compound = false, operation = null) {
    const codec = compound ? requireCheckpointCodec() : null;
    const ctx = persistenceContext(operation), previousOperation = ctx.operation;
    ctx.operation = 'saving';
    refresh();
    let protocolFailure = true;
    try {
      const s = ctx.snapshot, result = compound
        ? core._openrtw_export_campaign_battle_save(ctx.args.campaignGeneration,
            ctx.args.campaignRevision, ctx.args.campaignOrderRevision, s.generation, s.revision)
        : core._openrtw_export_battle_save(s.generation, s.revision);
      if (result !== 0 && result !== 1) throw Error('Invalid battle save export result');
      if (!live(ctx)) throw Error('Battle closed during save export');
      if (wire(core, '_openrtw_battle_json') !== ctx.wire ||
          wire(core, '_openrtw_campaign_session_json') !== ctx.campaignWire)
        throw Error('Battle export changed publication');
      if (result === 0) {
        protocolFailure = false;
        throw Error(core.UTF8ToString(core._openrtw_error()) || 'Battle save export refused');
      }
      const p = core._openrtw_battle_save_bytes(), size = core._openrtw_battle_save_size(), heap = core.HEAPU8;
      if (!uint(p) || !p || !uint(size) || !size || size > 32 * 1024 * 1024 ||
          !(heap instanceof Uint8Array) || p > heap.length - size)
        throw Error('Invalid battle save span');
      protocolFailure = false;
      const battle = Object.freeze({
        schema: 'rome-original.battle-controller-save/v1',
        coreBytes: compound ? heap.subarray(p, p + size) : new Uint8Array(heap.subarray(p, p + size)),
        running: ctx.running, speed: ctx.speed, selectedId: ctx.selectedId,
        clock: ctx.clock.snapshot(),
      });
      if (!compound) return battle;
      protocolFailure = true;
      const c = core._openrtw_campaign_save_bytes(), n = core._openrtw_campaign_save_size();
      if (!uint(c) || !c || !uint(n) || !n || n > 1024 * 1024 || c > heap.length - n)
        throw Error('Invalid compound campaign save span');
      const checkpoint = codec.copyCampaignBattleCheckpoint({
        schema: codec.campaignBattleSavePayloadSchema,
        playerId: ctx.args.playerId, enemyId: ctx.args.enemyId,
        campaignBytes: heap.subarray(c, c + n), battle,
      });
      protocolFailure = false;
      return checkpoint;
    } catch (error) {
      if (protocolFailure && live(ctx)) fail(ctx, error);
      throw error;
    } finally {
      ctx.operation = previousOperation;
      refresh();
    }
  }
  function restoreSave(input) {
    const ctx = persistenceContext();
    // Capture data properties once. Accessors/unknown fields refuse before
    // allocation, core admission or a change to the current pump/clock.
    if (!input || typeof input !== 'object') throw TypeError('Invalid battle controller save');
    const fields = Object.getOwnPropertyDescriptors(input),
      keys = ['schema', 'coreBytes', 'running', 'speed', 'selectedId', 'clock'];
    if (Reflect.ownKeys(fields).length !== keys.length ||
        keys.some((key) => !fields[key] || !('value' in fields[key])))
      throw TypeError('Invalid battle controller save fields');
    const saved = Object.fromEntries(keys.map((key) => [key, fields[key].value]));
    if (saved.schema !== 'rome-original.battle-controller-save/v1' ||
        typeof saved.running !== 'boolean' || ![1, 4].includes(saved.speed) ||
        (saved.selectedId !== null && (!uint(saved.selectedId) ||
          !ctx.snapshot.units.some((u) => u.id === saved.selectedId))) ||
        !(saved.coreBytes instanceof Uint8Array) ||
        !(saved.coreBytes.buffer instanceof ArrayBuffer) ||
        !saved.coreBytes.length || saved.coreBytes.length > 32 * 1024 * 1024)
      throw TypeError('Invalid battle controller save values');
    const clock = createFixedStepClock({ tickMilliseconds: 100, maxTicksPerAdvance: 20 });
    clock.restore(saved.clock);
    if (clock.getState().rate !== saved.speed) throw Error('Battle save speed differs from clock');
    const bytes = new Uint8Array(saved.coreBytes);
    let admitted = false, protocolFailure = false;
    ctx.operation = 'loading';
    refresh();
    try {
      const p = core._malloc(bytes.length);
      if (!uint(p) || !p) throw Error('Battle save allocation refused');
      let value, snapshot;
      try {
        const heap = core.HEAPU8;
        if (!(heap instanceof Uint8Array) || p > heap.length - bytes.length)
          throw Error('Battle save allocation is outside core memory');
        heap.set(bytes, p);
        if (!live(ctx)) throw Error('Battle closed before save admission');
        const s = ctx.snapshot, result = core._openrtw_import_battle_save(p, bytes.length, s.generation, s.revision);
        if (result !== 0 && result !== 1) {
          protocolFailure = true;
          throw Error('Invalid battle save import result');
        }
        if (result === 0) {
          if (!live(ctx)) throw Error('Battle closed during save admission');
          if (wire(core, '_openrtw_battle_json') !== ctx.wire ||
              wire(core, '_openrtw_campaign_session_json') !== ctx.campaignWire) {
            protocolFailure = true;
            throw Error('Refused battle save changed publication');
          }
          throw Error(core.UTF8ToString(core._openrtw_error()) || 'Battle save import refused');
        }
        admitted = true;
        value = wire(core, '_openrtw_battle_json');
        snapshot = validateOwnership(JSON.parse(value), ctx.args);
        if (snapshot.generation <= ctx.generation) throw Error('Battle load did not advance generation');
        // Adopt the known ownership token even if the full projection fails,
        // so subsequent terminal cleanup can release this accepted session.
        ctx.generation = snapshot.generation;
        if (!live(ctx)) throw Error('Battle closed during save admission');
        validate(snapshot, ctx.args, {...ctx.snapshot, generation: snapshot.generation, revision: 0, ticks: 0});
        if (wire(core, '_openrtw_campaign_session_json') !== ctx.campaignWire)
          throw Error('Battle load changed campaign publication');
      } finally {
        core._free(p);
      }
      if (!live(ctx)) throw Error('Battle closed before controller restore');
      stopPump(ctx);
      ctx.clock = clock;
      ctx.snapshot = snapshot;
      ctx.wire = value;
      ctx.speed = saved.speed;
      ctx.selectedId = saved.selectedId;
      ctx.message = '';
      ctx.running = saved.running && snapshot.outcome === 'ongoing';
      viewState = ctx.running ? 'running' : 'paused';
      if (ctx.running) {
        const token = (ctx.pumpToken = {});
        ctx.raf = requestAnimationFrame((time) => pump(ctx, time, token));
      }
    } catch (error) {
      // The trusted core's success publication is authoritative. A malformed
      // success projection/device failure is terminal, not a claimed rollback.
      if ((admitted || protocolFailure) && live(ctx)) fail(ctx, error);
      throw error;
    } finally {
      ctx.operation = null;
      refresh();
    }
    try {
      update(ctx);
      draw(ctx);
      emit();
    } catch (error) {
      if (live(ctx)) fail(ctx, error);
      throw error;
    }
    return true;
  }
  function pump(ctx, time, token) {
    if (token !== ctx.pumpToken) return;
    ctx.raf = 0;
    if (!live(ctx) || !ctx.running || ctx.snapshot.outcome !== 'ongoing') return;
    try {
      if (ctx.operation) {
        // Synchronous host hooks may reenter a queued callback. Keep its
        // owner alive without observing time or consuming saved debt.
        ctx.raf = requestAnimationFrame((t) => pump(ctx, t, token));
        return;
      }
      const ticks = ctx.clock.advance(time);
      if (ticks) {
        ctx.clock.consume(ticks);
        const accepted = command(ctx, '_openrtw_step_battle', [ticks]);
        if (!accepted && !ctx.failed) {
          stopPump(ctx);
          viewState = 'paused';
          update(ctx);
          emit();
        }
      }
      // A publication callback may already have paused/resumed and scheduled
      // the next pump. Keep one owner for that pending animation frame.
      if (live(ctx) && ctx.running && token === ctx.pumpToken && !ctx.raf)
        ctx.raf = requestAnimationFrame((t) => pump(ctx, t, token));
    } catch (error) {
      fail(ctx, error);
    }
  }
  function cleanupGraphics(ctx) {
    const errors = [];
    const attempt = (run) => { try { run(); } catch (error) { errors.push(error); } };
    const { scene, renderer, resizeObserver, resizeRaf, canvas, labels } = ctx;
    // Retract owned handles before any observer/device hook can reenter. Each
    // failed hook still leaves the later graphics and native cleanup reachable.
    ctx.scene = ctx.renderer = ctx.resizeObserver = ctx.canvas = ctx.labels = null;
    ctx.resizeRaf = 0;
    attempt(() => stopPump(ctx));
    attempt(() => ctx.abort.abort());
    if (resizeObserver) attempt(() => resizeObserver.disconnect());
    if (resizeRaf) attempt(() => cancelAnimationFrame(resizeRaf));
    if (scene) attempt(() => scene.dispose());
    if (renderer) attempt(() => renderer.dispose());
    if (canvas) attempt(() => canvas.remove());
    if (labels) attempt(() => labels.remove());
    if (errors.length) throw new AggregateError(errors, 'Battle graphics cleanup failed');
  }
  function verifyReturn(ctx) {
    if (wire(core, '_openrtw_campaign_session_json') !== ctx.campaignWire)
      throw Error('Campaign snapshot differs after battle');
    const bytes = saveCopy(core, ctx.args);
    if (
      bytes.length !== ctx.campaignSave.length ||
      !bytes.every((v, i) => v === ctx.campaignSave[i])
    )
      throw Error('Campaign save bytes differ after battle');
    if (wire(core, '_openrtw_campaign_session_json') !== ctx.campaignWire)
      throw Error('Campaign export changed source snapshot');
  }
  function leaveCore(ctx) {
    if (!ctx.began) return;
    const { snapshot } = readOwned(ctx);
    if (core._openrtw_leave_battle(ctx.generation, snapshot.revision) !== 1)
      throw Error(core.UTF8ToString(core._openrtw_error()) || 'Battle leave refused');
    ctx.began = false;
    if (core._openrtw_battle_json() !== 0) throw Error('Battle publication remains after leave');
    verifyReturn(ctx);
  }
  function closeDialog() {
    closingDialog = true;
    try {
      if (dialog.open) dialog.close();
    } finally {
      closingDialog = false;
    }
  }
  async function finish(ctx) {
    if (ctx.finishTask) return ctx.finishTask;
    // Publish the barrier before cleanup hooks or notifications can reenter.
    ctx.finishTask = Promise.resolve().then(async () => {
      const errors = [];
      try {
        cleanupGraphics(ctx);
      } catch (error) {
        errors.push(error);
      }
      try {
        leaveCore(ctx);
      } catch (error) {
        errors.push(error);
      }
      if (errors.length) throw new AggregateError(errors, 'Battle return/cleanup failed');
      if (current === ctx) current = null;
      delete dialog.dataset.battle;
      delete dialog.dataset.selectedUnit;
      closeDialog();
      viewState = disposed ? 'disposed' : 'closed';
      refresh();
      emit();
    });
    return ctx.finishTask;
  }
  function requestReturn() {
    if (returnTask || !current) return returnTask ?? Promise.resolve();
    const ctx = current;
    returnTask = Promise.resolve().then(async () => {
      try {
        if (pending) await pending;
        await finish(ctx);
      } catch (error) {
        fail(ctx, error);
        throw error;
      } finally {
        returnTask = null;
        refresh();
        emit();
      }
    });
    ctx.cancelled = true;
    stopPump(ctx);
    viewState = 'returning';
    refresh();
    emit();
    return returnTask;
  }
  function detachReplaced({ campaignGeneration, battleGeneration } = {}, operation = null) {
    const ctx = current;
    if (!ctx || !live(ctx) || pending || returnTask || (ctx.operation && ctx.operation !== operation) || ctx.commanding ||
        !uint(campaignGeneration) || !uint(battleGeneration))
      throw Error('Battle replacement needs a ready owned controller');
    const campaign = JSON.parse(wire(core, '_openrtw_campaign_session_json')),
      battle = JSON.parse(wire(core, '_openrtw_battle_json'));
    if (campaign.generation !== campaignGeneration || battle.generation !== battleGeneration ||
        battle.campaignGeneration !== campaignGeneration ||
        campaignGeneration <= ctx.args.campaignGeneration || battleGeneration <= ctx.generation ||
        battle.schema !== 'openrtw-battle-session-v1')
      throw Error('No fresh compound replacement to detach');
    // Joint core publication already retired this native state. Cleanup owns
    // only its old graphics/listeners; it must not leave the replacement.
    ctx.operation = null;
    ctx.began = false;
    return requestReturn();
  }
  function holdPersistence() {
    const ctx = persistenceContext(), operation = {}, clock = ctx.clock.snapshot(), message = ctx.message;
    ctx.operation = operation;
    ctx.pumpToken = null;
    const frame = ctx.raf;
    ctx.raf = 0;
    if (frame) cancelAnimationFrame(frame);
    const isCurrent = () => live(ctx) && ctx.operation === operation && !returnTask;
    ctx.message = 'Checkpoint storage is in progress; simulation time is held.';
    update(ctx);
    emit();
    return Object.freeze({
      get isCurrent() { return isCurrent(); },
      captureCheckpoint() {
        if (!isCurrent()) throw Error('Battle checkpoint hold is no longer current');
        return captureSave(true, operation);
      },
      detachReplaced: (replacement) => detachReplaced(replacement, operation),
      release() {
        if (!isCurrent()) return false;
        if (wire(core, '_openrtw_battle_json') !== ctx.wire ||
            wire(core, '_openrtw_campaign_session_json') !== ctx.campaignWire) {
          const error = Error('Battle changed during checkpoint hold');
          fail(ctx, error);
          throw error;
        }
        ctx.operation = null;
        ctx.clock.restore(clock);
        ctx.message = message;
        if (ctx.running && ctx.snapshot.outcome === 'ongoing') {
          const token = (ctx.pumpToken = {});
          ctx.raf = requestAnimationFrame((time) => pump(ctx, time, token));
        }
        update(ctx);
        emit();
        return true;
      },
    });
  }
  function fit(ctx) {
    if (!live(ctx) || !ctx.renderer) return;
    const r = mount.getBoundingClientRect(),
      w = Math.max(1, Math.min(2048, Math.floor(r.width))),
      h = Math.max(1, Math.min(1200, Math.floor(r.height)));
    if (w !== ctx.canvas.width || h !== ctx.canvas.height) {
      ctx.canvas.width = w;
      ctx.canvas.height = h;
      ctx.labels.style.width = w + 'px';
      ctx.labels.style.height = h + 'px';
      ctx.renderer.resize(w, h);
    }
    draw(ctx);
  }
  async function initialize(ctx) {
    try {
      if (!live(ctx)) return;
      if (ctx.adopted) {
        if (wire(core, '_openrtw_battle_json') !== ctx.wire ||
            wire(core, '_openrtw_campaign_session_json') !== ctx.campaignWire)
          throw Error('Restored battle changed before controller attachment');
      } else {
        const result = core._openrtw_begin_battle(
          ctx.args.playerId,
          ctx.args.enemyId,
          ctx.args.campaignGeneration,
          ctx.args.campaignRevision,
          ctx.args.campaignOrderRevision
        );
        if (result !== 0 && result !== 1) throw Error('Invalid battle entry status');
        if (result === 0) {
          const message = core.UTF8ToString(core._openrtw_error()) || 'Battle entry refused';
          verifyReturn(ctx);
          ctx.message = message;
          ctx.cancelled = true;
          await finish(ctx);
          status.textContent = message;
          return;
        }
        ctx.began = true;
        readBattle(ctx);
      }
      const canvas = doc.createElement('canvas');
      canvas.id = 'battle-canvas-' + ctx.serial;
      canvas.width = 960;
      canvas.height = 600;
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      canvas.style.display = 'block';
      canvas.style.touchAction = 'none';
      canvas.setAttribute('aria-label', 'Imported campaign armies · battle prototype');
      const labels = doc.createElement('div');
      labels.dataset.battleLabels = '';
      labels.style.position = 'absolute';
      labels.style.left = '0';
      labels.style.top = '0';
      labels.style.pointerEvents = 'none';
      ctx.canvas = canvas;
      ctx.labels = labels;
      mount.replaceChildren(canvas, labels);
      const candidate = await createRendererBridge({
        moduleFactory: createRenderer,
        canvas,
        width: canvas.width,
        height: canvas.height,
      });
      if (!live(ctx)) {
        candidate.dispose();
        return;
      }
      ctx.renderer = candidate;
      ctx.scene = createBattleScene({
        renderer: candidate,
        canvas,
        labelLayer: labels,
        unitGeometry,
        unitTexture,
        terrainTexture,
        modelAssets,
      });
      const position = (e) => {
        const r = canvas.getBoundingClientRect(),
          s = getComputedStyle(canvas),
          l = parseFloat(s.borderLeftWidth) || 0,
          t = parseFloat(s.borderTopWidth) || 0,
          rr = parseFloat(s.borderRightWidth) || 0,
          b = parseFloat(s.borderBottomWidth) || 0,
          w = r.width - l - rr,
          h = r.height - t - b;
        if (!(w > 0 && h > 0)) throw Error('Battle canvas has no content extent');
        return [
          ((e.clientX - r.left - l) * canvas.width) / w,
          ((e.clientY - r.top - t) * canvas.height) / h,
        ];
      };
      let drag = null;
      const listen = (name, fn, options = {}) =>
        canvas.addEventListener(
          name,
          (e) => {
            if (!live(ctx)) return;
            try {
              fn(e);
            } catch (error) {
              fail(ctx, error);
            }
          },
          { ...options, signal: ctx.abort.signal }
        );
      listen('pointerdown', (e) => {
        if (e.button !== 0 || drag) return;
        const point = position(e);
        drag = { point, start: point, pointerId: e.pointerId, moved: false, orbit: e.altKey };
        canvas.setPointerCapture(e.pointerId);
      });
      listen('pointermove', (e) => {
        if (!drag || e.pointerId !== drag.pointerId) return;
        const p = position(e);
        if (!drag.moved && Math.hypot(p[0] - drag.start[0], p[1] - drag.start[1]) <= 2) return;
        drag.moved = true;
        const dx = p[0] - drag.point[0],
          dy = p[1] - drag.point[1];
        if (drag.orbit) ctx.scene.orbit(dx, dy);
        else ctx.scene.pan(dx, dy);
        drag.point = p;
        draw(ctx);
      });
      listen('pointerup', (e) => {
        if (e.button !== 0 || !drag || e.pointerId !== drag.pointerId) return;
        const gesture = drag;
        drag = null;
        if (canvas.hasPointerCapture?.(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
        if (gesture.moved) return;
        const p = position(e);
        ctx.selectedId = ctx.scene.pickUnit(...p);
        update(ctx);
        draw(ctx);
      });
      for (const name of ['pointercancel', 'lostpointercapture'])
        listen(name, (e) => {
          if (drag?.pointerId === e.pointerId) drag = null;
        });
      listen('contextmenu', (e) => {
        if (ctx.snapshot.outcome !== 'ongoing') return;
        e.preventDefault();
        const unit = ctx.snapshot.units.find((u) => u.id === ctx.selectedId);
        if (!unit || unit.team !== 0 || !unit.soldiers) {
          ctx.message = 'Select a living player formation first.';
          update(ctx);
          return;
        }
        const p = position(e),
          id = ctx.scene.pickUnit(...p),
          target = ctx.snapshot.units.find((u) => u.id === id);
        if (target && target.team !== unit.team) {
          command(ctx, '_openrtw_battle_attack', [unit.id, target.id]);
          return;
        }
        const cell = ctx.scene.pickCell(...p);
        if (cell) command(ctx, '_openrtw_battle_move', [unit.id, cell.x, cell.y]);
      });
      listen(
        'wheel',
        (e) => {
          e.preventDefault();
          ctx.scene.zoom(Math.exp(Math.max(-1000, Math.min(1000, e.deltaY)) * 0.001));
          draw(ctx);
        },
        { passive: false }
      );
      ctx.resizeObserver = new ResizeObserver(() => {
        if (!live(ctx) || ctx.resizeRaf) return;
        ctx.resizeRaf = requestAnimationFrame(() => {
          ctx.resizeRaf = 0;
          if (live(ctx))
            try {
              fit(ctx);
            } catch (error) {
              fail(ctx, error);
            }
        });
      });
      ctx.resizeObserver.observe(mount);
      ctx.running = ctx.resumeAfterInitialize && ctx.snapshot.outcome === 'ongoing';
      viewState = ctx.running ? 'running' : 'paused';
      if (ctx.running) {
        const token = (ctx.pumpToken = {});
        ctx.raf = requestAnimationFrame((time) => pump(ctx, time, token));
      }
      fit(ctx);
      update(ctx);
      emit();
    } catch (error) {
      try {
        await finish(ctx);
      } catch (cleanup) {
        error = new AggregateError([error, cleanup], 'Battle entry cleanup failed');
      }
      fail(ctx, error);
    }
  }
  function open(args, restored = null) {
    if (disposed || active() || !canOpen()) return Promise.resolve(false);
    for (const key of [
      'playerId',
      'enemyId',
      'campaignGeneration',
      'campaignRevision',
      'campaignOrderRevision',
    ])
      if (!uint(args?.[key])) throw TypeError('Invalid battle entry token');
    if (!args.campaignGeneration || args.playerId === args.enemyId)
      throw Error('Choose two distinct source armies');
    const campaignWire = wire(core, '_openrtw_campaign_session_json'),
      session = JSON.parse(campaignWire);
    if (
      session.generation !== args.campaignGeneration ||
      session.revision !== args.campaignRevision ||
      session.orderRevision !== args.campaignOrderRevision
    )
      throw Error('Campaign changed before battle');
    let adoptedSnapshot = null, adoptedWire = null;
    const clock = createFixedStepClock({ tickMilliseconds: 100, maxTicksPerAdvance: 20 });
    if (restored) {
      if (restored.playerId !== args.playerId || restored.enemyId !== args.enemyId)
        throw Error('Restored checkpoint identifies different armies');
      adoptedWire = wire(core, '_openrtw_battle_json');
      adoptedSnapshot = validate(JSON.parse(adoptedWire), args);
      if (restored.battle.selectedId !== null &&
          !adoptedSnapshot.units.some((unit) => unit.id === restored.battle.selectedId))
        throw Error('Restored selection is not an admitted formation');
      clock.restore(restored.battle.clock);
      if (core._openrtw_export_campaign_battle_save(args.campaignGeneration, args.campaignRevision,
          args.campaignOrderRevision, adoptedSnapshot.generation, adoptedSnapshot.revision) !== 1)
        throw Error('Restored checkpoint verification refused');
      const same = (kind, expected) => {
        const p = core['_openrtw_' + kind + '_save_bytes'](), n = core['_openrtw_' + kind + '_save_size'](), heap = core.HEAPU8;
        return uint(p) && p > 0 && n === expected.length && heap instanceof Uint8Array &&
          p <= heap.length - n && expected.every((value, i) => value === heap[p + i]);
      };
      if (!same('campaign', restored.campaignBytes) || !same('battle', restored.battle.coreBytes) ||
          wire(core, '_openrtw_battle_json') !== adoptedWire)
        throw Error('Restored checkpoint differs from current core');
    }
    const campaignSave = restored ? restored.campaignBytes : saveCopy(core, args);
    if (wire(core, '_openrtw_campaign_session_json') !== campaignWire)
      throw Error('Campaign export changed source snapshot');
    if (disposed || active() || !canOpen())
      throw Error('Battle controller closed before attachment');
    const ctx = {
      serial: ++serial,
      args: { ...args },
      campaignWire,
      campaignSave,
      snapshot: adoptedSnapshot,
      wire: adoptedWire,
      generation: adoptedSnapshot?.generation ?? null,
      began: restored !== null,
      adopted: restored !== null,
      resumeAfterInitialize: restored?.battle.running ?? false,
      cancelled: false,
      failed: false,
      operation: null,
      commanding: false,
      running: false,
      speed: restored?.battle.speed ?? 1,
      selectedId: restored?.battle.selectedId ?? null,
      clock,
      pumpToken: null,
      raf: 0,
      resizeRaf: 0,
      resizeObserver: null,
      renderer: null,
      scene: null,
      canvas: null,
      labels: null,
      finishTask: null,
      abort: new AbortController(),
    };
    current = ctx;
    viewState = 'loading';
    delete dialog.dataset.error;
    delete dialog.dataset.battle;
    delete dialog.dataset.selectedUnit;
    select.replaceChildren();
    status.textContent = 'Loading the selected source armies…';
    speed.value = '1';
    try {
      dialog.showModal();
    } catch (error) {
      ctx.abort.abort();
      if (ctx.adopted) {
        try { leaveCore(ctx); }
        catch (cleanup) { error = new AggregateError([error, cleanup], 'Restored dialog cleanup failed'); }
      }
      current = null;
      viewState = 'closed';
      refresh();
      emit();
      throw error;
    }
    pending = Promise.resolve().then(() => initialize(ctx));
    const work = pending;
    work
      .finally(() => {
        if (pending === work) pending = null;
        refresh();
        emit();
      })
      .catch((error) => fail(ctx, error));
    refresh();
    emit();
    return work;
  }
  const on = (element, name, fn) =>
    element.addEventListener(
      name,
      (e) => {
        try {
          fn(e);
        } catch (error) {
          fail(current, error);
        }
      },
      { signal: events.signal }
    );
  on(select, 'change', () => {
    const ctx = current;
    if (!ctx || !live(ctx) || ctx.operation || !ctx.scene) return;
    ctx.selectedId = select.value === '' ? null : Number(select.value);
    if (!ctx.snapshot.units.some((u) => u.id === ctx.selectedId)) ctx.selectedId = null;
    update(ctx);
    draw(ctx);
  });
  on(run, 'click', () => {
    const ctx = current;
    if (!ctx || run.disabled) return;
    if (ctx.running) {
      stopPump(ctx);
      viewState = 'paused';
    } else {
      ctx.running = true;
      ctx.clock.reset();
      viewState = 'running';
      const token = (ctx.pumpToken = {});
      ctx.raf = requestAnimationFrame((t) => pump(ctx, t, token));
    }
    update(ctx);
    emit();
  });
  on(speed, 'change', () => {
    const ctx = current,
      n = Number(speed.value);
    if (!ctx || !live(ctx) || ctx.operation || ![1, 4].includes(n)) return;
    ctx.speed = n;
    ctx.clock.setRate(n);
    update(ctx);
  });
  on(center, 'click', () => {
    const ctx = current;
    if (!ctx || center.disabled || !live(ctx) || !ctx.scene) return;
    if (ctx.scene.centerFormation(ctx.selectedId)) draw(ctx);
  });
  on(step, 'click', () => {
    if (current && !step.disabled) command(current, '_openrtw_step_battle', [1]);
  });
  on(hold, 'click', () => {
    if (current && !hold.disabled) command(current, '_openrtw_battle_hold', [current.selectedId]);
  });
  on(retreat, 'click', () => {
    if (current && !retreat.disabled) {
      stopPump(current);
      viewState = 'paused';
      command(current, '_openrtw_retreat_battle');
    }
  });
  on(checkpointSave, 'click', () => {
    if (!checkpointSave.disabled)
      Promise.resolve(onSaveCheckpoint()).catch((error) => fail(current, error));
  });
  on(checkpointLoad, 'click', () => {
    if (!checkpointLoad.disabled)
      Promise.resolve(onLoadCheckpoint()).catch((error) => fail(current, error));
  });
  on(back, 'click', () => {
    requestReturn().catch(() => {});
  });
  on(dialog, 'cancel', (e) => {
    e.preventDefault();
    requestReturn().catch(() => {});
  });
  on(dialog, 'close', () => {
    if (!closingDialog && current) requestReturn().catch(() => {});
  });
  refresh();
  emit();
  return Object.freeze({
    open: (args) => open(args),
    refreshControls: refresh,
    captureSave: () => captureSave(),
    captureCheckpoint: () => captureSave(true),
    adopt(args, checkpoint) {
      if (disposed || active() || !canOpen()) return Promise.resolve(false);
      const work = open(args, requireCheckpointCodec().copyCampaignBattleCheckpoint(checkpoint)), ctx = current;
      return Promise.resolve(work).then(() => Boolean(ctx && current === ctx && live(ctx) &&
        ctx.adopted && ctx.scene && ['paused', 'running'].includes(viewState)));
    },
    detachReplaced,
    holdPersistence,
    restoreSave,
    get active() {
      return active();
    },
    get state() {
      return viewState;
    },
    dispose() {
      if (disposeTask) return disposeTask;
      disposed = true;
      const ctx = current;
      disposeTask = Promise.resolve().then(async () => {
        const errors = [];
        if (pending)
          try {
            await pending;
          } catch (e) {
            errors.push(e);
          }
        if (returnTask)
          try {
            await returnTask;
          } catch (e) {
            errors.push(e);
          }
        if (ctx)
          try {
            await finish(ctx);
          } catch (e) {
            errors.push(e);
          }
        current = null;
        closeDialog();
        viewState = 'disposed';
        refresh();
        emit();
        if (errors.length || failures.length)
          throw new AggregateError(
            [...errors, ...failures.map((v) => new Error(v))],
            'Battle disposal retained failures'
          );
      });
      events.abort();
      if (ctx) {
        ctx.cancelled = true;
        stopPump(ctx);
      }
      viewState = 'disposing';
      refresh();
      emit();
      return disposeTask;
    },
  });
}
