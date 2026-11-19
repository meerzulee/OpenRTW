import { romeOriginalProfile } from './profile.js';

const launchProfiles = new Set([
  romeOriginalProfile.profileId,
  'rome-original/local-asset-preview',
  'rome-original/development-preview',
]);

// Weak claims prevent a cached factory result or heap from acquiring a second
// session owner. Claims do not retain modules, buffers or game state themselves.
const claimedModules = new WeakSet();
const claimedHeaps = new WeakMap();

function coreAccess(core, assertActive, rememberHeap) {
  const access = Object.create(null), methods = new Map();
  for (const key of Reflect.ownKeys(core)) {
    Object.defineProperty(access, key, {
      enumerable: Object.getOwnPropertyDescriptor(core, key).enumerable,
      get() {
        assertActive();
        const value = Reflect.get(core, key, core);
        if (typeof value !== 'function') return value === core ? access : value;
        if (!methods.has(key)) methods.set(key, (...args) => {
          assertActive();
          const method = Reflect.get(core, key, core);
          let result;
          try { result = Reflect.apply(method, core, args); }
          catch (error) {
            // An export can grow memory before throwing. Keep that buffer's
            // ownership without replacing the original failure silently.
            try { rememberHeap(); }
            catch (heapError) {
              throw new AggregateError([error, heapError], 'Rome core export failed and heap tracking failed', { cause: error });
            }
            throw error;
          }
          assertActive();
          return result === core ? access : result;
        });
        return methods.get(key);
      },
    });
  }
  return Object.freeze(access);
}

function readContract(core, identity) {
  if (typeof core._openrtw_api_version !== 'function' || core._openrtw_api_version() !== 1 ||
      typeof core._openrtw_core_contract_json !== 'function')
    throw new Error('Rome core API version is incompatible; rebuild the core');
  const pointer = core._openrtw_core_contract_json();
  const heap = core.HEAPU8;
  if (!(heap instanceof Uint8Array) || !Number.isInteger(pointer) || pointer <= 0 || pointer >= heap.length)
    throw new Error('Rome core contract pointer is invalid');
  const span = heap.subarray(pointer, Math.min(pointer + 1024, heap.length));
  const end = span.indexOf(0);
  if (end < 0) throw new Error('Rome core contract exceeds its bound');
  const contract = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(span.subarray(0, end)));
  if (contract?.schema !== 'openrtw-core-contract-v1' || contract.apiVersion !== 1 ||
      contract.publicationModel !== 'module-owned-slots-v1' ||
      ['gameId', 'hostApiVersion', 'rulesVersion'].some((field) => contract[field] !== identity[field]))
    throw new Error('Rome core contract does not match the selected implementation');
  return Object.freeze({ schema: contract.schema, apiVersion: contract.apiVersion,
    gameId: contract.gameId, hostApiVersion: contract.hostApiVersion,
    rulesVersion: contract.rulesVersion, publicationModel: contract.publicationModel });
}

// Title-owned adapter for the existing Emscripten module. The injected runtime
// owns this returned module, including a factory result arriving after Stop.
// Do not throw on cancellation after createCore resolves: returning the owner
// lets the runtime dispose the allocated core even when it cannot publish it.
export function createRomeCoreSessionFactory({ createCore } = {}) {
  if (typeof createCore !== 'function') throw new TypeError('Rome core factory is required');
  return async (identity, context) => {
    if (
      identity?.gameId !== romeOriginalProfile.gameId ||
      !launchProfiles.has(identity.profileId) ||
      identity.hostApiVersion !== romeOriginalProfile.hostApiVersion ||
      identity.rulesVersion !== romeOriginalProfile.rulesVersion
    )
      throw new TypeError('Rome core session requires a compatible Rome launch identity');
    if (typeof context?.token?.throwIfCancelled !== 'function')
      throw new TypeError('Rome core session requires a runtime cancellation token');
    const token = context.token;
    token.throwIfCancelled();
    const core = await createCore();
    if (claimedModules.has(core))
      throw new Error('Rome core module already belongs to a session; create a fresh module');
    const reset = core?._openrtw_reset;
    if (typeof reset !== 'function') throw new TypeError('Rome core is missing its reset export');
    let disposed = false, contract, access, sharedHeap = false;
    const heapOwner = {};
    function rememberHeap() {
      const heap = core.HEAPU8;
      if (!(heap instanceof Uint8Array)) throw new Error('Rome core heap is invalid');
      const claimed = claimedHeaps.get(heap.buffer);
      if (claimed && claimed !== heapOwner) {
        sharedHeap = true;
        throw new Error('Rome core heap already belongs to a session; create a fresh module');
      }
      claimedHeaps.set(heap.buffer, heapOwner);
    }
    function assertActive() {
      if (disposed) throw new Error('Rome core session has been disposed');
      token.throwIfCancelled();
      rememberHeap();
    }
    const owner = Object.freeze({
      get contract() { return contract; },
      get core() {
        assertActive();
        return access;
      },
      dispose() {
        if (disposed) return;
        // Invalidate access before reset, including reentrant calls and a
        // failing reset. The runtime reports the failure; it must not replay
        // the native reset hook through a second disposal path.
        disposed = true;
        reset.call(core);
      },
    });
    try {
      const heap = core.HEAPU8;
      if (heap instanceof Uint8Array && claimedHeaps.has(heap.buffer)) {
        sharedHeap = true;
        throw new Error('Rome core heap already belongs to a session; create a fresh module');
      }
      claimedModules.add(core);
      rememberHeap();
      contract = readContract(core, identity);
      access = coreAccess(core, assertActive, rememberHeap);
    } catch (error) {
      // Resetting an alias would destroy the state of its existing owner.
      if (sharedHeap) throw error;
      try { owner.dispose(); }
      catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Rome core contract refused and reset failed', { cause: error });
      }
      throw error;
    }
    return owner;
  };
}
