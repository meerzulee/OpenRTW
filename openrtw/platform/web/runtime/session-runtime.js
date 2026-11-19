// Generic single-session lifecycle owner (ARC-03/04/11, FND-13 foundation slice).
//
// The runtime owns at most one game session at a time: identity validation,
// monotonic generation/cancellation tokens, per-session resource ownership,
// async creation, safe stop/replacement, stale-completion suppression and
// exactly-once cleanup with explicit, unswallowed disposal failures.
//
// It deliberately knows nothing about Rome: no game imports, no WASM handles,
// no DOM, fetch, storage or clock access. The host injects an async
// createSession(identity, context) factory that builds the game module; the
// game module alone owns simulation RNG, clocks, tick rates and rules.
import { failureMessage } from './failure.js';

export class SessionRuntimeError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'SessionRuntimeError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const IDENTITY_STRING_FIELDS = ['gameId', 'profileId'];
const IDENTITY_VERSION_FIELDS = ['hostApiVersion', 'rulesVersion'];
const DISPOSE_NAMES = ['dispose', 'close', 'destroy'];

function validateIdentity(identity) {
  if (identity === null || typeof identity !== 'object' || Array.isArray(identity))
    throw new SessionRuntimeError(
      'invalid-identity',
      'session identity must be an object with gameId, profileId, hostApiVersion and rulesVersion',
      { field: null },
    );
  const normalized = {};
  for (const field of IDENTITY_STRING_FIELDS) {
    const value = identity[field];
    if (typeof value !== 'string' || value.length === 0)
      throw new SessionRuntimeError('invalid-identity', `session identity ${field} must be a non-empty string`, {
        field,
      });
    normalized[field] = value;
  }
  for (const field of IDENTITY_VERSION_FIELDS) {
    const value = identity[field];
    const valid =
      (typeof value === 'string' && value.length > 0) ||
      (typeof value === 'number' && Number.isFinite(value));
    if (!valid)
      throw new SessionRuntimeError(
        'invalid-identity',
        `session identity ${field} must be a non-empty string or a finite number`,
        { field },
      );
    normalized[field] = value;
  }
  return Object.freeze(normalized);
}

function normalizeResource(resource) {
  if (typeof resource === 'function') return { owner: resource, dispose: resource };
  if (resource !== null && typeof resource === 'object') {
    for (const name of DISPOSE_NAMES) {
      const dispose = resource[name];
      if (typeof dispose === 'function') return { owner: resource, dispose: () => dispose.call(resource) };
    }
  }
  throw new SessionRuntimeError(
    'invalid-resource',
    'owned session resource must be a disposal function or expose dispose(), close() or destroy()',
  );
}

export function createSessionRuntime({ createSession, onError } = {}) {
  if (typeof createSession !== 'function')
    throw new SessionRuntimeError('invalid-runtime-config', 'createSession factory injection is required');
  const reportError = typeof onError === 'function' ? onError : () => {};

  let generation = 0;
  let state = 'idle'; // idle | creating | active | stopping | disposed
  let current = null;
  let stopInFlight = null;
  let permanent = false;
  const records = new Set();

  function trackPending(record, promise) {
    record.pending.add(promise);
    promise.then(
      () => record.pending.delete(promise),
      () => record.pending.delete(promise),
    );
  }

  function recordError(record, error) {
    record.teardownReport.errors.push(error);
    let notification;
    try {
      notification = reportError(error);
    } catch (sinkError) {
      record.teardownReport.errors.push(sinkError);
      return;
    }
    if (notification !== null && (typeof notification === 'object' || typeof notification === 'function')) {
      const observed = Promise.resolve(notification).catch((sinkError) => {
        record.teardownReport.errors.push(sinkError);
      });
      trackPending(record, observed);
    }
  }

  function invalidate(record, reason) {
    if (!record.terminalReason) record.terminalReason = reason;
    record.token.cancel();
  }

  function makeToken(record) {
    const listeners = [];
    const token = {
      generation: record.generation,
      onCancel(listener) {
        if (typeof listener !== 'function')
          throw new SessionRuntimeError('invalid-cancel-listener', 'onCancel expects a function');
        if (record.cancelRequested) {
          try {
            listener();
          } catch (error) {
            recordError(record, error);
          }
          return;
        }
        listeners.push(listener);
      },
      throwIfCancelled() {
        if (record.cancelRequested)
          throw new SessionRuntimeError('cancelled', `session generation ${record.generation} was cancelled`);
      },
      cancel() {
        if (record.cancelRequested) return;
        record.cancelRequested = true;
        // A retained cancelled token must not retain callback closures. The
        // snapshot still gives reverse order and safe reentrant registration.
        for (const listener of listeners.splice(0).reverse()) {
          try {
            listener();
          } catch (error) {
            recordError(record, error);
          }
        }
      },
    };
    Object.defineProperty(token, 'cancelRequested', {
      enumerable: true,
      get: () => record.cancelRequested,
      set: () => {},
    });
    return Object.freeze(token);
  }

  function staleContextError(record) {
    return new SessionRuntimeError(
      'stale-context',
      `session generation ${record.generation} no longer accepts resource ownership`,
      { generation: record.generation },
    );
  }

  function makeContext(record) {
    return Object.freeze({
      generation: record.generation,
      identity: record.identity,
      token: record.token,
      own(resource) {
        const duplicate = record.owners.has(resource);
        if (record.cancelRequested || record.teardownStarted) {
          if (!duplicate) {
            const entry = normalizeResource(resource);
            record.owners.add(entry.owner);
            const cleanup = Promise.resolve()
              .then(() => entry.dispose())
              .catch((error) => recordError(record, error));
            trackPending(record, cleanup);
          }
          throw staleContextError(record);
        }
        if (duplicate) return resource;
        const entry = normalizeResource(resource);
        record.owners.add(entry.owner);
        record.resources.push({ owner: entry.owner, dispose: entry.dispose, disposed: false });
        return entry.owner;
      },
    });
  }

  function makeHandle(record) {
    return Object.freeze({
      generation: record.generation,
      identity: record.identity,
      module: record.module,
      isActive: () => current === record && state === 'active' && !record.cancelRequested,
    });
  }

  async function drainPending(record) {
    while (record.pending.size > 0) await Promise.all([...record.pending]);
  }

  function teardownRecord(record) {
    if (!record.teardownPromise) {
      record.teardownStarted = true;
      record.teardownPromise = (async () => {
        const report = record.teardownReport;
        const module = record.module;
        record.module = null;
        const moduleKnownOwner = record.owners.has(module);
        // Include a returned module in deduplication before touching its hook:
        // a getter or disposer can offer the same owner through late own().
        if (module !== null && (typeof module === 'object' || typeof module === 'function'))
          record.owners.add(module);
        // A cancel listener may already have offered this module for tracked
        // late cleanup, without adding an admitted resource-array entry.
        if (!moduleKnownOwner && module !== null && (typeof module === 'object' || typeof module === 'function')) {
          let disposeModule = null;
          for (const name of DISPOSE_NAMES) {
            let dispose;
            try {
              dispose = module[name];
            } catch (error) {
              recordError(record, error);
              continue;
            }
            if (typeof dispose === 'function') {
              disposeModule = () => dispose.call(module);
              break;
            }
          }
          if (disposeModule) {
            try {
              await disposeModule();
            } catch (error) {
              recordError(record, error);
            }
          }
        }
        // Remove each entry before invoking its hook: stopped contexts can
        // retain deduplication without holding the released owners strongly.
        while (record.resources.length > 0) {
          const entry = record.resources.pop();
          if (entry.disposed) continue;
          entry.disposed = true;
          try {
            await entry.dispose();
            report.disposedResources += 1;
          } catch (error) {
            recordError(record, error);
          }
        }
        await drainPending(record);
        return report;
      })();
    }
    return record.teardownPromise;
  }

  function attachTeardownReport(error, report) {
    try {
      error.cleanupErrors = report.errors;
      error.teardownReport = report;
      if (error instanceof SessionRuntimeError) {
        error.details = {
          ...(error.details && typeof error.details === 'object' ? error.details : {}),
          cleanupErrors: report.errors,
          teardownReport: report,
        };
      }
      return error;
    } catch {
      // Factory-supplied runtime errors may be frozen or have protected
      // metadata. Cleanup has finished; expose its report on an owned error
      // instead of losing it to an attachment/metadata-access TypeError.
      let code = 'creation-failed';
      try { if (typeof error.code === 'string') code = error.code; } catch {}
      const owned = new SessionRuntimeError(code, failureMessage(error), {
        cleanupErrors: report.errors,
        teardownReport: report,
      });
      owned.cause = error;
      owned.cleanupErrors = report.errors;
      owned.teardownReport = report;
      return owned;
    }
  }

  function isRuntimeError(value) {
    try { return value instanceof SessionRuntimeError; }
    catch { return false; }
  }

  function isExpectedCancellation(value) {
    try {
      return (isRuntimeError(value) && value.code === 'cancelled') || value?.name === 'AbortError';
    } catch { return false; }
  }

  async function create(identity) {
    const validated = validateIdentity(identity);
    if (permanent) throw new SessionRuntimeError('runtime-disposed', 'session runtime has been disposed');
    if (state === 'active')
      throw new SessionRuntimeError(
        'session-active',
        'a session is already active; use replace() or stop() before create()',
      );
    if (state === 'stopping')
      throw new SessionRuntimeError('stop-in-progress', 'a stop is in progress; await it or use replace()');

    const record = {
      generation: ++generation,
      identity: validated,
      token: null,
      resources: [],
      owners: new WeakSet(),
      module: null,
      settled: null,
      factoryFailed: false,
      factoryError: null,
      cancelRequested: false,
      terminalReason: null,
      teardownStarted: false,
      teardownPromise: null,
      teardownReport: { errors: [], disposedResources: 0 },
      pending: new Set(),
    };
    record.token = makeToken(record);
    const previous = current;
    current = record;
    state = 'creating';
    records.add(record);
    if (previous) invalidate(previous, 'superseded');

    const creation = Promise.resolve().then(() => createSession(validated, makeContext(record)));
    record.settled = creation.then(
      (module) => {
        record.module = module === undefined ? null : module;
      },
      (error) => {
        record.factoryFailed = true;
        record.factoryError = error;
      },
    );
    await record.settled;

    let failure = null;
    const stale = record.cancelRequested || current !== record || state !== 'creating' || permanent;
    if (stale) {
      if (record.terminalReason === 'superseded' || (current !== record && record.terminalReason !== 'cancelled')) {
        failure = new SessionRuntimeError(
          'superseded',
          `session generation ${record.generation} was superseded while creation was in flight`,
        );
      } else {
        failure = new SessionRuntimeError('cancelled', `session generation ${record.generation} was cancelled`);
      }
      if (record.factoryFailed) {
        failure.cause = record.factoryError;
        // Expected cancellation remains a normal stop. Other stale failures
        // can contain cleanup evidence (e.g. contract refusal + reset failure)
        // and must survive in the stop report as well as the create rejection.
        const expectedCancellation = isExpectedCancellation(record.factoryError);
        if (!expectedCancellation) recordError(record, record.factoryError);
      }
    } else if (record.factoryFailed) {
      invalidate(record, 'failed');
      if (isRuntimeError(record.factoryError)) {
        failure = record.factoryError;
      } else {
        failure = new SessionRuntimeError(
          'creation-failed',
          `session creation failed: ${failureMessage(record.factoryError)}`,
        );
        failure.cause = record.factoryError;
      }
    } else {
      state = 'active';
      return makeHandle(record);
    }

    const teardown = await teardownRecord(record);
    records.delete(record);
    if (current === record) {
      current = null;
      if (state === 'creating') state = permanent ? 'disposed' : 'idle';
    }
    throw attachTeardownReport(failure, teardown);
  }

  async function finishStop() {
    const owned = [...records];
    const currentRecord = current;
    const report = {
      state: permanent ? 'disposed' : 'idle',
      generation: currentRecord ? currentRecord.generation : owned.length === 1 ? owned[0].generation : null,
      generations: owned.map((record) => record.generation),
      stopped: owned.length > 0,
      disposedResources: 0,
      errors: [],
      teardownReports: [],
    };
    if (owned.length === 0) {
      report.idle = true;
      state = permanent ? 'disposed' : 'idle';
      return report;
    }

    for (const record of owned) invalidate(record, record.terminalReason || 'cancelled');
    const drained = await Promise.all(
      owned.map(async (record) => {
        if (record.settled) await record.settled;
        const teardown = await teardownRecord(record);
        records.delete(record);
        return { generation: record.generation, teardown };
      }),
    );
    for (const { generation: drainedGeneration, teardown } of drained) {
      report.errors.push(...teardown.errors);
      report.disposedResources += teardown.disposedResources;
      report.teardownReports.push({
        generation: drainedGeneration,
        errors: teardown.errors,
        disposedResources: teardown.disposedResources,
      });
    }
    if (current && owned.includes(current)) current = null;
    state = permanent ? 'disposed' : 'idle';
    report.state = state;
    return report;
  }

  function stop() {
    if (stopInFlight) return stopInFlight;
    state = 'stopping';
    const operation = Promise.resolve().then(finishStop);
    stopInFlight = operation.then(
      (report) => {
        stopInFlight = null;
        return report;
      },
      (error) => {
        stopInFlight = null;
        throw error;
      },
    );
    // Close tokens synchronously after installing the reentrant shared barrier.
    // A settling factory continuation must not republish active state before
    // the deferred drain starts.
    for (const record of [...records]) invalidate(record, record.terminalReason || 'cancelled');
    return stopInFlight;
  }

  async function replace(identity) {
    const validated = validateIdentity(identity);
    const stopped = await stop();
    if (stopped.errors.length > 0) {
      const error = new SessionRuntimeError(
        'cleanup-failed',
        'session replacement refused because the previous session cleanup failed',
      );
      error.cause = stopped.errors[0];
      throw attachTeardownReport(error, stopped);
    }
    return create(validated);
  }

  return Object.freeze({
    create,
    stop,
    replace,
    current: () =>
      current && state === 'active' && !current.cancelRequested
        ? Object.freeze({ generation: current.generation, identity: current.identity, state })
        : null,
    dispose: async () => {
      permanent = true;
      state = 'disposed';
      const report = await stop();
      report.runtimeDisposed = true;
      return report;
    },
  });
}
