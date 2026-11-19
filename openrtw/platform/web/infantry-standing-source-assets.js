import {
  infantryStandingSkeletonDescriptors,
  parseInfantryStandingSkeleton,
} from './infantry-standing-skeleton.js';
import { awaitAssetRead } from './runtime/asset-read-scope.js';

// Optional exact-source catalog. No existing provider, route or default is
// imported or changed. Bank hashes are not checked by reading whole banks.
const freeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
};
const clipIndex = {
  index: 'data/animations/pack.idx',
  indexBytes: 76745,
  indexHash: '51b949e33f6e6abaf00fb07e5a06f2c733e9783468dad6aefee49a2798541546',
  bank: 'data/animations/pack.dat',
  bankBytes: 10636564,
};
const skeletonIndex = {
  index: 'data/animations/skeletons.idx',
  indexBytes: 1546,
  indexHash: 'cc0b2f29a378d5f25c160f1f566e3de2892f2544146e0129626445992b4bcfcd',
  bank: 'data/animations/skeletons.dat',
  bankBytes: 577425,
};
export const infantryStandingAssetDescriptors = freeze({
  lid21: {
    ...clipIndex,
    kind: 'clip',
    route: '/assets/infantry-standing-lid21.cas',
    memberName: 'data/animations/LID_01_Standing idle new actor.cas',
    sourceBytes: 7093,
    sourceSha256: '1fdb03f58c9d1581f95504fd054c295b37e4a03b17b88f34d2337accaf041ee7',
    start: 2195236,
    record: 14761,
    recordEnd: 14833,
    lengthWord: 60,
    ordinal: 224,
    frameCount: 21,
  },
  lis11: {
    ...clipIndex,
    kind: 'clip',
    route: '/assets/infantry-standing-lis11.cas',
    memberName: 'data/animations/LIS 01 Stand Idle.cas',
    sourceBytes: 3733,
    sourceSha256: '3d953b72209ef5e66788abfca686b8e5dad66f730df545d38af18f47943229a3',
    start: 3408165,
    record: 23824,
    recordEnd: 23883,
    lengthWord: 47,
    ordinal: 361,
    frameCount: 11,
  },
  archerSkeleton: {
    ...skeletonIndex,
    ...infantryStandingSkeletonDescriptors.roman_archer,
    kind: 'skeleton',
    route: '/assets/infantry-standing-archer.bin',
    start: 317683,
    record: 923,
    recordEnd: 955,
    lengthWord: 20,
    ordinal: 32,
  },
  spearmanSkeleton: {
    ...skeletonIndex,
    ...infantryStandingSkeletonDescriptors.roman_triarii,
    kind: 'skeleton',
    route: '/assets/infantry-standing-spearman.bin',
    start: 446280,
    record: 1147,
    recordEnd: 1176,
    lengthWord: 17,
    ordinal: 39,
  },
  javelinSkeleton: {
    ...skeletonIndex,
    ...infantryStandingSkeletonDescriptors.roman_velite,
    kind: 'skeleton',
    route: '/assets/infantry-standing-javelin.bin',
    start: 349772,
    record: 987,
    recordEnd: 1023,
    lengthWord: 24,
    ordinal: 34,
  },
});
export const infantryStandingModelDescriptors = freeze({
  roman_archer: {
    clip: 'lid21',
    skeleton: 'archerSkeleton',
    policy:
      'First literal declared set fs_semi_fast_archer; active native set/idle dispatch unproved.',
  },
  roman_triarii: {
    clip: 'lis11',
    skeleton: 'spearmanSkeleton',
    policy: 'Literal declared set fs_slow_spearman; native idle dispatch unproved.',
  },
  roman_velite: {
    clip: 'lis11',
    skeleton: 'javelinSkeleton',
    policy:
      'First literal declared set fs_semi_fast_javelinman; active native set/idle dispatch unproved.',
  },
});
const names = Object.keys(infantryStandingAssetDescriptors),
  maxFiles = 65536,
  maxPath = 4096;
const specFor = (name) => {
  if (typeof name !== 'string' || !Object.hasOwn(infantryStandingAssetDescriptors, name))
    throw new Error('Unknown infantry standing asset');
  return infantryStandingAssetDescriptors[name];
};
const aborted = (signal) => {
  if (signal?.aborted)
    throw signal.reason ?? new DOMException('Infantry asset read aborted', 'AbortError');
};
function checkSignal(signal) {
  if (
    signal !== undefined &&
    signal !== null &&
    (typeof signal.aborted !== 'boolean' ||
      typeof signal.addEventListener !== 'function' ||
      typeof signal.removeEventListener !== 'function')
  )
    throw new TypeError('Infantry asset signal must be an AbortSignal');
  aborted(signal);
}
async function verify(bytes, size, expected, label, signal) {
  aborted(signal);
  if (!(bytes instanceof Uint8Array) || bytes.length !== size)
    throw new Error(`Selected ${label} has an unexpected length`);
  const actual = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (v) =>
    v.toString(16).padStart(2, '0')
  ).join('');
  aborted(signal);
  if (actual !== expected) throw new Error(`Selected ${label} differs from the verified source`);
  return bytes;
}
async function boundedResponse(response, limit, signal, ownership) {
  const header = response.headers.get('Content-Length');
  let declared = null;
  if (header !== null) {
    if (!/^(0|[1-9][0-9]*)$/.test(header)) throw new Error('Invalid infantry Content-Length');
    declared = Number(header);
    if (!Number.isSafeInteger(declared) || declared > limit)
      throw new Error('Infantry Content-Length exceeds bound');
  }
  if (!response.body || typeof response.body.getReader !== 'function')
    throw new Error('Infantry response has no bounded readable stream');
  const reader = response.body.getReader(),
    chunks = [];
  ownership.readerOwned = true;
  let total = 0,
    reads = 0,
    cancelTask = null,
    failed = false,
    firstError;
  const cancel = (reason) =>
    (cancelTask ??= (async () => {
      try {
        await reader.cancel(reason);
      } catch {}
    })());
  const onAbort = () => {
    cancel(signal.reason);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    aborted(signal);
    for (;;) {
      const { done, value } = await reader.read();
      aborted(signal);
      if (done) break;
      if (++reads > 65536) throw new Error('Infantry stream exceeds chunk bound');
      if (!(value instanceof Uint8Array)) throw new Error('Infantry stream returned non-byte data');
      if (value.length > limit - total || (declared !== null && value.length > declared - total))
        throw new Error('Infantry stream exceeds byte bound');
      total += value.length;
      chunks.push(value.slice());
    }
    if (declared !== null && declared !== total)
      throw new Error('Infantry stream disagrees with Content-Length');
  } catch (error) {
    failed = true;
    firstError = error;
    await cancel(error);
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (cancelTask) await cancelTask;
    try {
      reader.releaseLock();
    } catch (error) {
      if (!failed) {
        failed = true;
        firstError = error;
      }
    }
  }
  if (failed) throw firstError;
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  aborted(signal);
  return bytes;
}

function source(mode, describe, readImpl, clear = () => {}) {
  let closed = false,
    closeReason;
  const active = new Set();
  const open = () => {
    if (closed) throw closeReason;
  };
  async function operation(signal, run) {
    open();
    checkSignal(signal);
    const controller = new AbortController(),
      relay = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', relay, { once: true });
    active.add(controller);
    try {
      aborted(signal);
      const value = await awaitAssetRead(controller.signal, () => run(controller.signal), 'Infantry asset read aborted');
      open();
      aborted(controller.signal);
      return value;
    } finally {
      signal?.removeEventListener('abort', relay);
      active.delete(controller);
    }
  }
  const read = (name, { signal } = {}) => {
    const spec = specFor(name);
    return operation(signal, (inner) => readImpl(name, spec, inner));
  };
  return Object.freeze({
    mode,
    describe: () => ({ ...describe(), closed }),
    read,
    load(modelType, { signal } = {}) {
      if (
        typeof modelType !== 'string' ||
        !Object.hasOwn(infantryStandingModelDescriptors, modelType)
      )
        throw new Error('Unknown infantry standing model');
      const binding = infantryStandingModelDescriptors[modelType];
      return operation(signal, async (inner) => {
        const clipBytes = await read(binding.clip, { signal: inner }),
          skeletonBytes = await read(binding.skeleton, { signal: inner }),
          skeletonBinding = await parseInfantryStandingSkeleton(modelType, skeletonBytes, {
            signal: inner,
          });
        aborted(inner);
        return Object.freeze({ clipBytes, skeletonBytes, skeletonBinding, sourceBinding: binding });
      });
    },
    close(reason) {
      if (closed) return;
      closed = true;
      closeReason =
        reason === undefined ? new DOMException('Infantry source closed', 'AbortError') : reason;
      clear();
      for (const controller of active) controller.abort(closeReason);
    },
  });
}
export function createDevelopmentInfantryStandingAssets({ fetchImpl = fetch } = {}) {
  if (typeof fetchImpl !== 'function')
    throw new TypeError('Development infantry assets require fetch');
  return source(
    'development',
    () => ({ mode: 'development', availableNames: [...names], missingPaths: [] }),
    async (name, spec, signal) => {
      let response;
      const ownership = { readerOwned: false };
      try {
        response = await fetchImpl(spec.route, { signal });
        aborted(signal);
        if (!response?.ok)
          throw new Error(`Cannot load infantry ${name}: HTTP ${response?.status ?? 'unknown'}`);
        return await verify(
          await boundedResponse(response, spec.sourceBytes, signal, ownership),
          spec.sourceBytes,
          spec.sourceSha256,
          name,
          signal
        );
      } catch (error) {
        if (!ownership.readerOwned && response?.body && !response.body.locked)
          try {
            await response.body.cancel(error);
          } catch {}
        throw error;
      }
    }
  );
}

const lower = (s) => s.replace(/[A-Z]/g, (c) => c.toLowerCase()),
  rawPath = (file) => file.webkitRelativePath || file.name;
function snapshot(file) {
  if (!file || typeof file.name !== 'string' || typeof file.slice !== 'function')
    throw new TypeError('Select browser File objects');
  const path = rawPath(file);
  if (
    typeof path !== 'string' ||
    !path.length ||
    path.length > maxPath ||
    /[\x00-\x1f\x7f]/.test(path)
  )
    throw new Error('Invalid selected relative path');
  const clean = path.replace(/\\/g, '/');
  if (clean.startsWith('/') || /^[a-zA-Z]:/.test(clean))
    throw new Error('Selected paths must be relative');
  const parts = clean.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..'))
    throw new Error('Invalid selected traversal path');
  const size = file.size,
    lastModified = file.lastModified;
  if (!Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(lastModified))
    throw new Error('Invalid selected metadata');
  return { file, path, parts: parts.map(lower), size, lastModified };
}
function stable(record) {
  if (
    record.file.size !== record.size ||
    record.file.lastModified !== record.lastModified ||
    rawPath(record.file) !== record.path
  )
    throw new Error('Selected file changed during infantry read');
}
async function slice(record, start, length, signal) {
  aborted(signal);
  stable(record);
  if (start > record.size || length > record.size - start)
    throw new Error('Incomplete selected infantry carrier');
  const blob = record.file.slice(start, start + length);
  if (!blob || blob.size !== length || typeof blob.arrayBuffer !== 'function')
    throw new Error('Incomplete infantry slice');
  const buffer = await blob.arrayBuffer();
  aborted(signal);
  stable(record);
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== length)
    throw new Error('Incomplete infantry selected read');
  return new Uint8Array(buffer).slice();
}
function checkIndex(bytes, spec) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    ascii = (a, b) => String.fromCharCode(...bytes.subarray(a, b)),
    clip = spec.kind === 'clip',
    r = spec.record;
  if (
    ascii(0, clip ? 10 : 9) !== (clip ? 'ANIM.PACK\0' : 'SKEL.PACK') ||
    v.getUint32(12, true) !== (clip ? 4 : 3) ||
    v.getUint32(16, true) !== (clip ? 1116 : 53) ||
    v.getUint32(r, true) !== spec.lengthWord ||
    v.getUint32(r + 4, true) !== spec.start ||
    v.getUint32(r + 8, true) !== spec.sourceBytes ||
    ascii(r + (clip ? 21 : 12), spec.recordEnd) !== spec.memberName + '\0'
  )
    throw new Error('Selected infantry index record differs');
  if (
    clip &&
    (v.getUint32(r + 12, true) !== 0x3f800000 ||
      v.getInt16(r + 16, true) !== spec.frameCount ||
      v.getInt16(r + 18, true) !== 19 ||
      v.getUint8(r + 20) !== 1)
  )
    throw new Error('Selected infantry clip index fields differ');
}
export function createLocalInfantryStandingAssets(files) {
  if (files === null || typeof files !== 'object')
    throw new TypeError('Select a game folder using the file picker');
  if (
    files.length !== undefined &&
    (!Number.isSafeInteger(files.length) || files.length < 0 || files.length > maxFiles)
  )
    throw new Error('Selected folder exceeds 65536 metadata entries');
  const required = new Map(
      names.flatMap((n) => {
        const s = specFor(n);
        return [
          [s.index, s.indexBytes],
          [s.bank, s.bankBytes],
        ];
      })
    ),
    selected = new Map(),
    indexCache = new Map();
  let count = 0,
    root = null;
  function add(file) {
    if (++count > maxFiles) throw new Error('Selected folder exceeds 65536 metadata entries');
    const record = snapshot(file);
    let key, at;
    for (const i of [0, 1])
      if (record.parts[i] === 'data' && required.has(record.parts.slice(i).join('/'))) {
        key = record.parts.slice(i).join('/');
        at = i;
        break;
      }
    if (key === undefined) return;
    if (selected.has(key)) throw new Error('Duplicate selected infantry path');
    const prefix = record.parts.slice(0, at + 1).join('/');
    if (root !== null && root !== prefix) throw new Error('Choose one game folder or Data folder');
    root = prefix;
    if (record.size !== required.get(key))
      throw new Error('Selected infantry file has unsupported input size');
    selected.set(key, record);
  }
  if (typeof files[Symbol.iterator] === 'function') {
    for (const file of files) add(file);
  } else {
    if (files.length === undefined)
      throw new TypeError('Selected files must be iterable or FileList-like');
    for (let i = 0; i < files.length; i++) add(files[i]);
  }
  const need = (path) => {
    const record = selected.get(path);
    if (!record) throw new Error(`Missing required game file: ${path}`);
    return record;
  };
  return source(
    'local',
    () => ({
      mode: 'local',
      selectedFileCount: count,
      availableNames: names.filter(
        (n) => selected.has(specFor(n).index) && selected.has(specFor(n).bank)
      ),
      missingPaths: [...required.keys()].filter((p) => !selected.has(p)),
      cachedIndexes: indexCache.size,
    }),
    async (name, spec, signal) => {
      const index = need(spec.index),
        bank = need(spec.bank);
      stable(index);
      stable(bank);
      let bytes = indexCache.get(spec.index);
      if (!bytes) {
        bytes = await verify(
          await slice(index, 0, spec.indexBytes, signal),
          spec.indexBytes,
          spec.indexHash,
          spec.index,
          signal
        );
        stable(index);
        stable(bank);
        aborted(signal);
        indexCache.set(spec.index, bytes.slice());
      }
      checkIndex(bytes, spec);
      const member = await verify(
        await slice(bank, spec.start, spec.sourceBytes, signal),
        spec.sourceBytes,
        spec.sourceSha256,
        name,
        signal
      );
      stable(index);
      stable(bank);
      aborted(signal);
      return member;
    },
    () => indexCache.clear()
  );
}
