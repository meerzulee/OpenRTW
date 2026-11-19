// Synthetic DOM/device and mock C ABI; no browser/GPU/original game.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { fixture, args, frame, event, drain, raf, setResizeDisconnectError } from './fixtures/battle-view-host.mjs';
let families = 0;
async function test(fn) {
  raf.clear();
  await fn();
  assert.equal(raf.size, 0);
  families++;
}
await test(async () => {
  const f = fixture(),
    opened = f.view.open(args);
  assert.equal(f.view.active, true);
  assert.deepEqual(f.calls, [['export', 4, 3, 2]]);
  await opened;
  assert.equal(f.view.state, 'paused');
  assert.equal(f.find('battleRun').textContent, 'Run');
  assert.equal(f.calls.filter((c) => c[0] === 'step').length, 0);
  assert.equal(f.state.snapshot.units.length, 2);
  event(f.find('battleReturn'), 'click');
  await drain();
  assert.equal(f.view.active, false);
  assert.equal(f.view.state, 'closed');
  assert.deepEqual(
    f.calls.filter((c) => c[0] === 'leave'),
    [['leave', 9, 0]]
  );
  assert.equal(f.sceneDisposed, 1);
  assert.equal(f.rendererDisposed, 1);
  await f.view.dispose();
});
await test(async () => {
  const f = fixture({ beginRefusal: true });
  await f.view.open(args);
  assert.equal(f.view.active, false);
  assert.equal(f.state.active, false);
  assert.equal(f.calls.filter((c) => c[0] === 'leave').length, 0);
  assert.equal(f.rendererDisposed, 0);
  assert.match(f.status.textContent, /refusal/);
  await f.view.dispose();
});
await test(async () => {
  const f = fixture();
  const opened = f.view.open(args),
    disposed = f.view.dispose();
  await opened;
  await disposed;
  assert.equal(f.calls.filter((c) => c[0] === 'begin').length, 0);
  assert.equal(f.calls.filter((c) => c[0] === 'leave').length, 0);
  assert.equal(f.view.active, false);
  assert.equal(f.view.state, 'disposed');
  assert.equal(f.view.dispose(), disposed);
});
await test(async () => {
  const f = fixture({ lateFactory: true }),
    opened = f.view.open(args);
  await drain();
  assert.equal(f.state.active, true);
  let complete = false;
  const disposed = f.view.dispose().then(() => {
    complete = true;
  });
  await drain();
  assert.equal(complete, false);
  assert.equal(f.calls.filter((c) => c[0] === 'leave').length, 0);
  f.resolve();
  await opened;
  await disposed;
  assert.equal(f.rendererDisposed, 1);
  assert.equal(f.sceneDisposed, 0);
  assert.deepEqual(
    f.calls.filter((c) => c[0] === 'leave'),
    [['leave', 9, 0]]
  );
  assert.equal(f.view.active, false);
});
await test(async () => {
  const f = fixture();
  await f.view.open(args);
  const c = f.canvas();
  event(c, 'pointerdown', { button: 0, clientX: 20, clientY: 20, pointerId: 1, altKey: false });
  event(c, 'pointerup', { button: 0, clientX: 20, clientY: 20, pointerId: 1 });
  assert.equal(f.dialog.dataset.selectedUnit, '0');
  f.picked(null);
  event(c, 'contextmenu', { clientX: 40, clientY: 40 });
  assert.deepEqual(
    f.calls.find((c) => c[0] === 'move'),
    ['move', 0, 10, 23, 9, 0]
  );
  f.picked(1);
  event(c, 'contextmenu', { clientX: 40, clientY: 40 });
  assert.deepEqual(
    f.calls.find((c) => c[0] === 'attack'),
    ['attack', 0, 1, 9, 1]
  );
  event(f.find('battleHold'), 'click');
  assert.deepEqual(
    f.calls.find((c) => c[0] === 'hold'),
    ['hold', 0, 9, 2]
  );
  await f.view.dispose();
  assert.deepEqual(
    f.calls.filter((c) => c[0] === 'leave'),
    [['leave', 9, 3]]
  );
});
await test(async () => {
  const f = fixture();
  await f.view.open(args);
  event(f.find('battleStep'), 'click');
  assert.deepEqual(
    f.calls.find((c) => c[0] === 'step'),
    ['step', 1, 9, 0]
  );
  event(f.find('battleRun'), 'click');
  frame(0);
  frame(100);
  assert.equal(f.state.snapshot.ticks, 2);
  const speed = f.find('battleSpeed');
  speed.value = '4';
  event(speed, 'change');
  frame(350);
  assert.equal(f.state.snapshot.ticks, 12);
  assert.ok(f.calls.filter((c) => c[0] === 'step').every((c) => c[1] >= 1 && c[1] <= 20));
  event(f.find('battleRun'), 'click');
  const ticks = f.state.snapshot.ticks;
  frame(10000);
  assert.equal(f.state.snapshot.ticks, ticks);
  await f.view.dispose();
});
await test(async () => {
  const f = fixture();
  await f.view.open(args);
  event(f.find('battleRun'), 'click');
  frame(0);
  frame(1000);
  assert.equal(f.state.snapshot.ticks, 10, 'Slow frames retain elapsed time');
  frame(10000);
  assert.equal(f.state.snapshot.ticks, 30, 'Catch-up is bounded to20 per frame');
  frame(10000);
  assert.equal(f.state.snapshot.ticks, 50, 'Zero elapsed frame can drain retained debt');
  event(f.find('battleRun'), 'click');
  event(f.find('battleRun'), 'click');
  frame(20000);
  assert.equal(f.state.snapshot.ticks, 50, 'Pause resets debt and resume establishes baseline');
  frame(20100);
  assert.equal(f.state.snapshot.ticks, 51);
  await f.view.dispose();
  frame(30000);
  assert.equal(f.state.snapshot.ticks, 51, 'Disposed callbacks cannot advance');
});
await test(async () => {
  const f = fixture();
  await f.view.open(args);
  event(f.find('battleRun'), 'click');
  frame(0);
  f.state.refuse = true;
  frame(10000);
  assert.equal(f.view.state, 'paused');
  assert.equal(f.state.snapshot.ticks, 0);
  f.state.refuse = false;
  event(f.find('battleRun'), 'click');
  frame(20000);
  frame(20100);
  assert.equal(f.state.snapshot.ticks, 1, 'Refused backlog cannot leak into a restarted pump');
  await f.view.dispose();
});
await test(async () => {
  let f, cycle = false;
  f = fixture({ onState() {
    if (!cycle) return;
    cycle = false;
    event(f.find('battleRun'), 'click');
    event(f.find('battleRun'), 'click');
  } });
  await f.view.open(args);
  event(f.find('battleRun'), 'click');
  f.find('battleSpeed').value = '4';
  event(f.find('battleSpeed'), 'change');
  frame(0);
  cycle = true;
  frame(1000);
  assert.equal(raf.size, 1, 'Reentrant pause/resume must not start a second pump');
  frame(5000);
  const calls = f.calls.filter(c => c[0] === 'step').length;
  frame(6000);
  assert.equal(f.calls.filter(c => c[0] === 'step').length - calls, 1);
  await f.view.dispose();
});
await test(async () => {
  const f = fixture();
  await f.view.open(args);
  event(f.find('battleRun'), 'click');
  const stale = [...raf.values()].at(-1);
  event(f.find('battleRun'), 'click');
  event(f.find('battleRun'), 'click');
  stale(1000); // A previously queued callback must not join the resumed run.
  assert.equal(raf.size, 1, 'Stale pump must not clobber the resumed frame owner');
  frame(2000);
  assert.equal(f.state.snapshot.ticks, 0);
  frame(2100);
  assert.equal(f.state.snapshot.ticks, 1);
  await f.view.dispose();
});
await test(async () => {
  const f = fixture();
  await f.view.open(args);
  const before = f.dialog.dataset.battle;
  f.state.refuse = true;
  event(f.find('battleStep'), 'click');
  assert.equal(f.dialog.dataset.battle, before);
  assert.equal(f.view.state, 'paused');
  assert.match(f.status.textContent, /mock refusal/);
  assert.equal(f.errors.length, 0);
  await f.view.dispose();
});
await test(async () => {
  const f = fixture({ mutateRefusal: true });
  await f.view.open(args);
  f.state.refuse = true;
  event(f.find('battleStep'), 'click');
  assert.equal(f.view.state, 'error');
  assert.match(f.errors[0], /Refused battle command changed/);
  await assert.rejects(f.view.dispose(), /retained failures/);
  assert.equal(f.calls.filter((c) => c[0] === 'leave').length, 1);
  assert.equal(f.rendererDisposed, 1);
});
await test(async () => {
  const f = fixture({ changedReturnSave: true });
  await f.view.open(args);
  event(f.find('battleReturn'), 'click');
  await drain();
  assert.equal(f.view.state, 'error');
  assert.equal(f.view.active, true);
  assert.match(f.errors[0], /return\/cleanup failed/);
  await assert.rejects(f.view.dispose(), AggregateError);
  assert.equal(f.calls.filter((c) => c[0] === 'leave').length, 1);
  assert.equal(f.rendererDisposed, 1);
});
await test(async () => {
  const f = fixture({ sceneError: true });
  await f.view.open(args);
  assert.equal(f.state.active, false);
  assert.equal(f.rendererDisposed, 1);
  assert.equal(f.calls.filter((c) => c[0] === 'leave').length, 1);
  assert.equal(f.view.state, 'error');
  assert.match(f.errors[0], /scene init failure/);
  await assert.rejects(f.view.dispose(), AggregateError);
});
await test(async () => {
  const f = fixture({
    mutateBegin: (s) => {
      s.units[0].model = '';
    },
  });
  await f.view.open(args);
  assert.equal(f.view.state, 'error');
  assert.equal(f.calls.filter((c) => c[0] === 'leave').length, 1);
  assert.equal(f.state.active, false);
  assert.equal(f.view.active, false);
  await assert.rejects(f.view.dispose(), AggregateError);
  assert.equal(f.calls.filter((c) => c[0] === 'leave').length, 1);
});
await test(async () => {
  const f = fixture();
  await f.view.open(args);
  event(f.find('battleRetreat'), 'click');
  assert.equal(f.state.snapshot.outcome, 'retreated');
  assert.equal(f.find('battleRun').disabled, true);
  event(f.find('battleReturn'), 'click');
  await drain();
  assert.equal(f.view.active, false);
  assert.deepEqual(
    f.calls.filter((c) => c[0] === 'leave'),
    [['leave', 9, 1]]
  );
  assert.equal(f.calls.filter((c) => c[0] === 'retreat').length, 1);
  await f.view.open(args);
  assert.equal(f.view.state, 'paused');
  assert.equal(f.find('battleSpeed').value, '1');
  await f.view.dispose();
});
await test(async () => {
  const f = fixture({ modalError: true });
  assert.throws(() => f.view.open(args), /dialog failure/);
  assert.equal(f.view.active, false);
  assert.equal(f.calls.filter((c) => c[0] === 'begin').length, 0);
  await f.view.dispose();
});
await test(async () => {
  const f = fixture({ cleanupError: true });
  await f.view.open(args);
  await assert.rejects(f.view.dispose(), AggregateError);
  assert.equal(f.sceneDisposed, 1);
  assert.equal(f.rendererDisposed, 1);
  assert.equal(f.calls.filter((c) => c[0] === 'leave').length, 1);
  assert.equal(f.state.active, false);
});
await test(async () => {
  const f = fixture({
    mutateCommand: (s) => {
      s.units[0].model = '';
    },
  });
  await f.view.open(args);
  event(f.find('battleRun'), 'click');
  frame(0);
  frame(100);
  assert.equal(f.view.state, 'error');
  assert.match(f.status.textContent, /could not continue/);
  assert.equal(f.find('battleRun').disabled, true);
  await assert.rejects(f.view.dispose(), AggregateError);
  assert.equal(f.state.active, false);
  assert.equal(f.rendererDisposed, 1);
  assert.deepEqual(
    f.calls.filter((c) => c[0] === 'leave'),
    [['leave', 9, 1]]
  );
});
await test(async () => {
  const f = fixture();
  await f.view.open(args);
  const c = f.canvas();
  event(c, 'pointerdown', { button: 0, clientX: 20, clientY: 20, pointerId: 1, altKey: false });
  event(c, 'pointermove', { clientX: 21, clientY: 20, pointerId: 1 });
  assert.equal(f.calls.filter((c) => c[0] === 'pan').length, 0);
  event(c, 'pointermove', { clientX: 40, clientY: 20, pointerId: 2 });
  event(c, 'pointerup', { button: 0, clientX: 40, clientY: 20, pointerId: 2 });
  assert.equal(f.dialog.dataset.selectedUnit, '');
  assert.equal(f.calls.filter((c) => c[0] === 'pan').length, 0);
  event(c, 'pointerup', { button: 0, clientX: 21, clientY: 20, pointerId: 1 });
  assert.equal(f.dialog.dataset.selectedUnit, '0');
  await f.view.dispose();
});
await test(async () => {
  const f = fixture({ lateFactory: true }),
    opened = f.view.open(args);
  await drain();
  event(f.find('battleReturn'), 'click');
  await drain();
  assert.equal(f.view.state, 'returning');
  assert.equal(f.view.active, true);
  f.resolve();
  await opened;
  await drain();
  assert.equal(f.view.active, false);
  assert.equal(f.rendererDisposed, 1);
  assert.equal(f.state.active, false);
  assert.equal(f.mount.children.length, 0);
  await f.view.dispose();
});
await test(async () => {
  const f = fixture();
  await f.view.open(args);
  const first = f.view.open(args);
  await first;
  assert.equal(f.calls.filter((c) => c[0] === 'begin').length, 1);
  const cancel = event(f.dialog, 'cancel');
  assert.equal(cancel.defaultPrevented, true);
  await drain();
  assert.equal(f.view.active, false);
  await f.view.open(args);
  f.dialog.close();
  await drain();
  assert.equal(f.view.active, false);
  assert.equal(f.calls.filter((c) => c[0] === 'leave').length, 2);
  await f.view.dispose();
});
await test(async () => {
  const f = fixture({
    mutateCommand: (s) => {
      s.generation++;
    },
  });
  await f.view.open(args);
  event(f.find('battleStep'), 'click');
  assert.equal(f.view.state, 'error');
  assert.match(f.errors[0], /generation ownership differs/);
  await assert.rejects(f.view.dispose(), AggregateError);
  assert.equal(f.calls.filter((c) => c[0] === 'leave').length, 0);
  assert.equal(f.rendererDisposed, 1);
  assert.equal(f.state.active, true);
});
await test(async () => {
  const f = fixture({
    mutateBegin: (s) => {
      s.campaignGeneration++;
    },
  });
  await f.view.open(args);
  assert.equal(f.view.state, 'error');
  assert.equal(f.calls.filter((c) => c[0] === 'leave').length, 0);
  assert.equal(f.state.active, true);
  assert.equal(f.rendererDisposed, 0);
  await assert.rejects(f.view.dispose(), AggregateError);
});
// App boundary regression: execute the shipped listener verbatim so this
// catches a global-owner dereference or status write after Stop/pagehide.
await test(async () => {
  const app = await readFile(new URL('../platform/web/app.js', import.meta.url), 'utf8');
  // The listener is the two-space-indented block from its addEventListener
  // line to its signal-scoped closing registration at the same indentation.
  const listener = app.match(
    /^ {2}battleButton\.addEventListener\('click', async \(\) => \{[\s\S]*?\n {2}\}, pageInputOptions\);/m
  );
  assert.ok(listener, 'Battle launch listener must remain reviewable');
  for (const mode of ['running', 'stop', 'pagehide', 'replaced', 'stop-reject']) {
    let click,
      resolveOpen,
      rejectOpen,
      opens = 0,
      activeReads = 0,
      status = 'before',
      writes = 0,
      updates = 0;
    const pending = new Promise((resolve, reject) => {
      resolveOpen = resolve;
      rejectOpen = reject;
    });
    const owner = {
      open(tokens) {
        opens++;
        assert.deepEqual(JSON.parse(JSON.stringify(tokens)), args);
        return pending;
      },
      get active() {
        activeReads++;
        return true;
      },
    };
    const context = {
      battleButton: {
        disabled: false,
        addEventListener(name, fn) {
          assert.equal(name, 'click');
          click = fn;
        },
      },
      battleOpponent: { value: '1' },
      battleView: owner,
      battleStatus: {
        get textContent() {
          return status;
        },
        set textContent(value) {
          status = value;
          writes++;
        },
      },
      canInteract: () => true,
      selected: () => ({ id: 0 }),
      session: { generation: 4, revision: 3, orderRevision: 2 },
      closing: false,
      phase: 'running',
      pageInputOptions: {},
      updateControls: () => {
        updates++;
      },
      document: { querySelector: () => ({ textContent: 'Returned to campaign.' }) },
    };
    runInNewContext(listener[0], context);
    const launch = click();
    assert.equal(opens, 1);
    assert.equal(status, 'Opening battle…');
    writes = 0;
    if (mode === 'stop' || mode === 'stop-reject') {
      context.phase = 'stopping';
      context.battleView = undefined;
    }
    if (mode === 'pagehide') {
      context.closing = true;
      context.phase = 'closed';
      context.battleView = undefined;
    }
    if (mode === 'replaced') context.battleView = { active: false };
    if (mode === 'stop-reject') rejectOpen(Error('late opening failure'));
    else resolveOpen();
    await assert.doesNotReject(launch);
    assert.equal(updates, mode === 'running' ? 1 : 0);
    if (mode === 'running') {
      assert.equal(status, 'Battle open. Return to continue this campaign.');
      assert.equal(writes, 1);
      assert.equal(activeReads, 1);
    } else {
      assert.equal(status, 'Opening battle…', mode);
      assert.equal(writes, 0, mode);
      assert.equal(activeReads, 0, mode);
    }
  }
});
await test(async () => {
  const f = fixture();
  assert.equal(f.find('battleCenter').disabled, true);
  await f.view.open(args);
  assert.equal(f.find('battleCenter').disabled, true);
  const select = f.find('battleUnit');
  select.value = '0';
  event(select, 'change');
  assert.equal(f.find('battleCenter').disabled, false);
  const before = f.dialog.dataset.battle,
    campaign = f.state.campaign,
    save = f.state.save.slice(),
    calls = f.calls.length,
    draws = f.draws;
  event(f.find('battleCenter'), 'click');
  assert.deepEqual(f.calls.slice(calls), [['center', 0]]);
  assert.equal(f.draws, draws + 1);
  assert.equal(f.dialog.dataset.battle, before);
  assert.equal(f.state.campaign, campaign);
  assert.deepEqual(f.state.save, save);
  assert.equal(f.state.snapshot.revision, 0);
  assert.equal(f.state.snapshot.ticks, 0);
  f.picked(null);
  event(f.canvas(), 'contextmenu', { clientX: 40, clientY: 40 });
  assert.deepEqual(f.calls.at(-1), ['move', 0, 10, 23, 9, 0]);
  await f.view.dispose();
  assert.equal(f.find('battleCenter').disabled, true);
});
await test(async () => {
  const f = fixture({
    mutateCommand: (s) => {
      s.units[0].hitPoints = 0;
      s.units[0].soldiers = 0;
    },
  });
  await f.view.open(args);
  const select = f.find('battleUnit');
  select.value = '0';
  event(select, 'change');
  assert.equal(f.find('battleCenter').disabled, false);
  event(f.find('battleStep'), 'click');
  assert.equal(f.find('battleCenter').disabled, true);
  const calls = f.calls.length;
  event(f.find('battleCenter'), 'click');
  assert.equal(f.calls.length, calls);
  select.value = '999';
  event(select, 'change');
  assert.equal(f.find('battleCenter').disabled, true);
  event(f.find('battleReturn'), 'click');
  await drain();
  assert.equal(f.find('battleCenter').disabled, true);
  assert.equal(f.view.active, false);
  await f.view.dispose();
});
await test(async () => {
  const f = fixture({ lateFactory: true }),
    opened = f.view.open(args);
  await drain();
  assert.equal(f.find('battleCenter').disabled, true);
  event(f.find('battleCenter'), 'click');
  assert.equal(f.calls.filter((c) => c[0] === 'center').length, 0);
  event(f.find('battleReturn'), 'click');
  assert.equal(f.find('battleCenter').disabled, true);
  f.resolve();
  await opened;
  await drain();
  assert.equal(f.rendererDisposed, 1);
  assert.equal(f.view.active, false);
  assert.equal(f.find('battleCenter').disabled, true);
  await f.view.dispose();
});
await test(async () => {
  for (const options of [{ centerRefusal: true }, { centerError: true }]) {
    const f = fixture(options);
    await f.view.open(args);
    const select = f.find('battleUnit');
    select.value = '1';
    event(select, 'change');
    assert.equal(f.find('battleCenter').disabled, false);
    const before = f.dialog.dataset.battle,
      draws = f.draws;
    event(f.find('battleCenter'), 'click');
    assert.equal(f.dialog.dataset.battle, before);
    assert.equal(f.draws, draws);
    assert.equal(f.state.snapshot.revision, 0);
    assert.equal(f.state.snapshot.ticks, 0);
    if (options.centerError) {
      assert.equal(f.view.state, 'error');
      assert.equal(f.find('battleCenter').disabled, true);
      await assert.rejects(f.view.dispose(), AggregateError);
    } else {
      assert.equal(f.view.state, 'paused');
      assert.equal(f.errors.length, 0);
      await f.view.dispose();
    }
    assert.equal(f.rendererDisposed, 1);
    assert.equal(f.sceneDisposed, 1);
    assert.equal(f.calls.filter((c) => c[0] === 'leave').length, 1);
  }
});
await test(async () => {
  const f = fixture(); await f.view.open(args);
  f.core._openrtw_step_battle = () => { throw Object.create(null); };
  event(f.find('battleRun'), 'click'); frame(0); frame(100);
  assert.equal(f.view.state, 'error'); assert.equal(raf.size, 0);
  assert.match(f.status.textContent, /Unprintable failure cause/);
  await assert.rejects(f.view.dispose(), AggregateError);
  assert.equal(f.rendererDisposed, 1); assert.equal(f.sceneDisposed, 1);
  assert.equal(f.calls.filter(c => c[0] === 'leave').length, 1);
});
await test(async () => {
  const f = fixture({ onState() { throw Object.create(null); } });
  await f.view.open(args);
  assert.match(f.dialog.dataset.error, /Unprintable failure cause/);
  await assert.rejects(f.view.dispose(), AggregateError);
  assert.equal(f.rendererDisposed, 1); assert.equal(f.sceneDisposed, 1);
  assert.equal(f.calls.filter(c => c[0] === 'leave').length, 1);
});
await test(async () => {
  const f = fixture({ onFailure() { throw Object.create(null); } });
  await f.view.open(args);
  f.core._openrtw_step_battle = () => { throw Error('step failure'); };
  event(f.find('battleRun'), 'click');
  assert.doesNotThrow(() => { frame(0); frame(100); });
  assert.equal(f.view.state, 'error'); assert.equal(raf.size, 0);
  assert.match(f.dialog.dataset.error, /step failure[\s\S]*Unprintable failure cause/);
  await assert.rejects(f.view.dispose(), AggregateError);
  assert.equal(f.rendererDisposed, 1); assert.equal(f.sceneDisposed, 1);
  assert.equal(f.calls.filter(c => c[0] === 'leave').length, 1);
});
await test(async () => {
  let baseline, baselineDisposed = 0;
  baseline = fixture({ onState() { if (baseline?.view.state === 'disposed') baselineDisposed++; } });
  await baseline.view.open(args); await baseline.view.dispose();
  let armed = false, nested, disposing = 0, disposed = 0;
  const f = fixture({ onState() {
    if (!armed) return;
    if (f.view.state === 'disposing') {
      disposing++;
      if (!nested) { armed = false; nested = f.view.dispose(); armed = true; }
    }
    if (f.view.state === 'disposed') disposed++;
  } });
  await f.view.open(args); armed = true;
  try {
    const outer = f.view.dispose();
    assert.equal(nested, outer, 'Reentrant disposal must share the installed barrier');
    await outer;
    assert.equal(disposing, 1); assert.equal(disposed, baselineDisposed,
      'Reentrancy must preserve ordinary disposal notifications');
    assert.equal(f.rendererDisposed, 1); assert.equal(f.sceneDisposed, 1);
    assert.equal(f.calls.filter(c => c[0] === 'leave').length, 1);
  } finally { armed = false; await f.view.dispose().catch(() => {}); await drain(); }
});
await test(async () => {
  let armed = false, nested = false, returning = 0;
  const f = fixture({ onState() {
    if (armed && f.view.state === 'returning') {
      returning++;
      if (!nested) { nested = true; event(f.find('battleReturn'), 'click'); }
    }
  } });
  await f.view.open(args); armed = true;
  try {
    event(f.find('battleReturn'), 'click'); await drain();
    assert.equal(returning, 1, 'A reentrant Return must not start a second transition');
    assert.equal(f.view.state, 'closed'); assert.equal(f.view.active, false);
    assert.equal(f.rendererDisposed, 1); assert.equal(f.sceneDisposed, 1);
    assert.equal(f.calls.filter(c => c[0] === 'leave').length, 1);
  } finally { armed = false; await f.view.dispose().catch(() => {}); }
});
await test(async () => {
  const order = []; let nested;
  const f = fixture({
    onSceneDispose() { order.push('scene'); nested = f.view.dispose(); },
    onRendererDispose() { order.push('renderer'); },
  });
  await f.view.open(args);
  const leave = f.core._openrtw_leave_battle;
  f.core._openrtw_leave_battle = (...args) => { order.push('leave'); return leave(...args); };
  try {
    event(f.find('battleReturn'), 'click'); await drain(); await nested;
    assert.deepEqual(order, ['scene', 'renderer', 'leave'], 'Reentrant teardown must retire graphics before native leave');
    assert.equal(f.rendererDisposed, 1); assert.equal(f.sceneDisposed, 1);
    assert.equal(f.calls.filter(c => c[0] === 'leave').length, 1);
  } finally { await f.view.dispose().catch(() => {}); }
});
await test(async () => {
  const f = fixture(); await f.view.open(args);
  setResizeDisconnectError(Error('resize observer disconnect failed'));
  try {
    await assert.rejects(f.view.dispose(), AggregateError);
    assert.equal(f.rendererDisposed, 1, 'Observer cleanup failure must not skip renderer retirement');
    assert.equal(f.sceneDisposed, 1);
    assert.equal(f.mount.children.length, 0); assert.equal(f.view.active, false);
    assert.equal(f.calls.filter(c => c[0] === 'leave').length, 1);
  } finally { setResizeDisconnectError(null); await f.view.dispose().catch(() => {}); raf.clear(); }
});
delete globalThis.__battleViewDeps;
console.log(`${families} battle view test families passed`);
