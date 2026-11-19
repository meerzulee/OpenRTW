// Coalesced, lease-bound live refresh for completed-production settlement
// presentation. The caller supplies async asset admission plus a campaign-scene
// owner replacement API. This coordinator only decides WHEN a result may be
// published: newest request wins, every await is fenced by the current session
// identity and campaign lifecycle, and a battle/Stop/pagehide/load cannot be
// followed by campaign core work or scene publication.
//
// It deliberately has no timer and no eager queue: one request supersedes the
// previous one, the in-flight attempt re-checks its lease after every await,
// and a clean optional failure is retried only by the next accepted change.

const schema = 'openrtw-production-settlement-refresh-v1';

export function createProductionSettlementRefresh({
  load,
  getPrior,
  getScene,
  isCampaignActive,
  readIdentity,
  buildOwners,
  apply = () => {},
  inspect = () => {},
  onState = () => {},
  onFailure = () => {},
} = {}) {
  for (const [name, value] of Object.entries({
    load,
    getPrior,
    getScene,
    isCampaignActive,
    readIdentity,
    buildOwners,
    apply,
    inspect,
    onState,
    onFailure,
  }))
    if (typeof value !== 'function')
      throw new TypeError(`Production settlement refresh contract lacks ${name}`);
  let order = 0,
    pending = null,
    running = false,
    disposed = false,
    failure = null,
    changed = null,
    lastReason = 'idle',
    lastIdentity = null,
    waiters = [];
  const counts = { requested: 0, applied: 0, discarded: 0 };
  let state = 'idle';
  function active() {
    try {
      return isCampaignActive() === true;
    } catch {
      return false;
    }
  }
  function identityKey() {
    const value = readIdentity();
    lastIdentity = {
      generation: Number.isInteger(value?.generation) ? value.generation : null,
      revision: Number.isInteger(value?.revision) ? value.revision : null,
      orderRevision: Number.isInteger(value?.orderRevision) ? value.orderRevision : null,
    };
    return `${lastIdentity.generation}:${lastIdentity.revision}:${lastIdentity.orderRevision}`;
  }
  function snapshot() {
    return Object.freeze({
      schema,
      state,
      requested: counts.requested,
      applied: counts.applied,
      discarded: counts.discarded,
      reason: lastReason,
      generation: lastIdentity?.generation ?? null,
      revision: lastIdentity?.revision ?? null,
      orderRevision: lastIdentity?.orderRevision ?? null,
      changed,
      error: failure ? String(failure.message ?? failure) : null,
    });
  }
  function publish(next, detail = {}) {
    state = next;
    if ('changed' in detail) changed = detail.changed;
    if ('failure' in detail) failure = detail.failure;
    onState(snapshot());
  }
  function settleWaiters() {
    if (running || (pending && active())) return;
    for (const resolve of waiters.splice(0)) resolve(snapshot());
  }
  function request(reason = 'change') {
    if (disposed) return;
    counts.requested++;
    lastReason = typeof reason === 'string' && reason ? reason : 'change';
    pending = { order: ++order, identity: identityKey(), reason: lastReason };
    publish('pending');
    pump();
  }
  function pump() {
    if (disposed || running || !pending) {
      settleWaiters();
      return;
    }
    if (!active()) {
      publish('deferred');
      settleWaiters();
      return;
    }
    running = true;
    const loop = async () => {
      while (!disposed && pending && active()) {
        const run = pending;
        pending = null;
        await attempt(run);
      }
    };
    Promise.resolve()
      .then(loop)
      .catch((error) => {
        if (disposed) return;
        publish('failed', { failure: error });
        onFailure(error, { phase: 'coordinator' });
      })
      .finally(() => {
        running = false;
        if (!disposed && pending && active()) pump();
        else {
          if (pending && !active()) publish('deferred');
          settleWaiters();
        }
      });
  }
  function mayPublish(run) {
    return !disposed && run.order === order && active() && identityKey() === run.identity;
  }
  // An accepted session publication advances revision/orderRevision even when
  // completed placement bytes are unchanged. Rebinding the selected inspection
  // (core select) is mandatory before any presentation token is trusted; a
  // failure keeps the previous owners and never claims a rollback.
  async function reselectCurrent(run, assets, replaced) {
    if (!mayPublish(run)) return;
    try {
      await inspect({ assets, changed: replaced });
    } catch (error) {
      if (!mayPublish(run)) return;
      publish('failed', { failure: error });
      onFailure(error, { phase: 'inspect' });
    }
  }
  async function attempt(run) {
    if (!mayPublish(run)) {
      counts.discarded++;
      return;
    }
    publish('refreshing', { changed: null });
    let assets;
    try {
      assets = await load({ prior: getPrior(), isCurrent: () => mayPublish(run) });
    } catch (error) {
      if (!mayPublish(run) || error?.name === 'AbortError') {
        counts.discarded++;
        return;
      }
      await reselectCurrent(run, null, false);
      if (!mayPublish(run)) {
        counts.discarded++;
        return;
      }
      publish('failed', { failure: error });
      onFailure(error, { phase: 'load' });
      return;
    }
    if (!mayPublish(run)) {
      counts.discarded++;
      return;
    }
    const scene = getScene();
    if (
      !scene ||
      typeof scene.stageSettlementOwners !== 'function' ||
      typeof scene.commitSettlementOwners !== 'function' ||
      typeof scene.discardSettlementOwners !== 'function'
    ) {
      const error = new Error('Campaign scene cannot replace settlement owners');
      await reselectCurrent(run, assets, false);
      if (!mayPublish(run)) {
        counts.discarded++;
        return;
      }
      publish('failed', { failure: error });
      onFailure(error, { phase: 'stage' });
      return;
    }
    const replaced = assets?.changed !== false;
    if (replaced) {
      let staged;
      try {
        staged = scene.stageSettlementOwners(buildOwners(assets));
      } catch (error) {
        if (!mayPublish(run)) {
          counts.discarded++;
          return;
        }
        await reselectCurrent(run, assets, false);
        if (!mayPublish(run)) {
          counts.discarded++;
          return;
        }
        publish('failed', { failure: error });
        onFailure(error, { phase: 'stage' });
        return;
      }
      // No await between this lease check, commit and publication: a newer
      // request cannot observe a half-published owner pair.
      if (!mayPublish(run)) {
        counts.discarded++;
        try {
          scene.discardSettlementOwners(staged);
        } catch (error) {
          // Cleanup remains diagnosable, but this retired run cannot publish
          // status or call the application after Stop. While still open a
          // cleanup failure is deliberately fatal even for a retired lease.
          failure = error;
          if (!disposed) onFailure(error, { phase: 'discard', retired: true });
        }
        return;
      }
      try {
        scene.commitSettlementOwners(staged);
      } catch (error) {
        await reselectCurrent(run, assets, true);
        if (!mayPublish(run)) {
          counts.discarded++;
          return;
        }
        publish('failed', { failure: error });
        onFailure(error, { phase: 'commit' });
        return;
      }
    }
    let inspectError = null;
    try {
      // Reselect before any placement/UI publication: the app callback rebinds
      // the inspection tokens to the accepted session and validates them.
      await inspect({ assets, changed: replaced });
    } catch (error) {
      inspectError = error;
    }
    // Even a synchronous inspection callback crosses a microtask at this
    // await. A mutation, restore or Stop can retire the lease before resuming.
    if (!mayPublish(run)) {
      counts.discarded++;
      return;
    }
    apply(assets, { changed: replaced });
    if (inspectError) {
      publish('failed', { failure: inspectError });
      onFailure(inspectError, { phase: 'inspect' });
      return;
    }
    counts.applied++;
    publish('current', { changed: replaced });
  }
  const api = {
    schedule: request,
    resume() {
      if (!disposed) pump();
    },
    settled() {
      return new Promise((resolve) => {
        waiters.push(resolve);
        settleWaiters();
      });
    },
    status: snapshot,
    dispose() {
      if (disposed) return;
      disposed = true;
      pending = null;
      publish('disposed', { changed: null });
      settleWaiters();
    },
  };
  return Object.freeze(api);
}
