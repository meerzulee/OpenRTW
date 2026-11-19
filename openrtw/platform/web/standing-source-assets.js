import { awaitAssetRead } from './runtime/asset-read-scope.js';

// Optional, exact-source inputs for the standing pose and source march keys. This provider
// does not assign native pose, scale-composition or skeleton-name semantics.
const maxFiles = 65536,
  maxPath = 4096;
const specs = {
  clip: {
    route: '/assets/standing-sg01.cas',
    bytes: 7093,
    sha256: '95e15f90bdca0a522d9de67cfcd2e461386f9d91acadb840aef6af417e052428',
    index: 'data/animations/pack.idx',
    indexBytes: 76745,
    indexHash: '51b949e33f6e6abaf00fb07e5a06f2c733e9783468dad6aefee49a2798541546',
    bank: 'data/animations/pack.dat',
    bankBytes: 10636564,
    start: 4669735,
    record: 32707,
    recordEnd: 32754,
    ordinal: 491,
  },
  skeleton: {
    route: '/assets/standing-skeleton.bin',
    bytes: 6126,
    sha256: '782957130e332911519cdd5bbf7d16e030b93287e312d7f8222481ad0427e0e8',
    index: 'data/animations/skeletons.idx',
    indexBytes: 1546,
    indexHash: 'cc0b2f29a378d5f25c160f1f566e3de2892f2544146e0129626445992b4bcfcd',
    bank: 'data/animations/skeletons.dat',
    bankBytes: 577425,
    start: 564645,
    record: 1467,
    recordEnd: 1501,
    ordinal: 50,
  },
  march: {
    route: '/assets/walking-sg03.cas',
    bytes: 7093,
    sha256: 'eba2096628f2f287ba031dd7faa899010d369242f6c1c9e72c179b4afb7752ed',
    index: 'data/animations/pack.idx',
    indexBytes: 76745,
    indexHash: '51b949e33f6e6abaf00fb07e5a06f2c733e9783468dad6aefee49a2798541546',
    bank: 'data/animations/pack.dat',
    bankBytes: 10636564,
    start: 4683921,
    record: 32813,
    recordEnd: 32866,
    ordinal: 493,
  },
};
const names = ['clip', 'skeleton'],
  lower = (s) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
function specFor(name) {
  if (typeof name !== 'string' || !Object.hasOwn(specs, name))
    throw new Error(`Unknown standing asset: ${String(name)}`);
  return specs[name];
}
function aborted(signal) {
  if (signal?.aborted)
    throw signal.reason ?? new DOMException('Standing asset read aborted', 'AbortError');
}
function checkSignal(signal) {
  if (
    signal !== undefined &&
    signal !== null &&
    (typeof signal.aborted !== 'boolean' ||
      typeof signal.addEventListener !== 'function' ||
      typeof signal.removeEventListener !== 'function')
  )
    throw new TypeError('Standing asset signal must be an AbortSignal');
  aborted(signal);
}
async function digest(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (v) =>
    v.toString(16).padStart(2, '0')
  ).join('');
}
async function verify(bytes, size, hash, label, signal) {
  aborted(signal);
  if (bytes.length !== size) throw new Error(`Selected ${label} has an unexpected length`);
  const actual = await digest(bytes);
  aborted(signal);
  if (actual !== hash) throw new Error(`Selected ${label} differs from the verified source`);
  return bytes;
}

// The same bounded streaming/real-EOF/cancel policy as the default provider.
async function boundedResponse(response, limit, signal) {
  const header = response.headers.get('Content-Length');
  let declared = null;
  if (header !== null) {
    if (!/^(0|[1-9][0-9]*)$/.test(header)) throw new Error('Invalid asset Content-Length');
    declared = Number(header);
    if (!Number.isSafeInteger(declared) || declared > limit)
      throw new Error('Asset Content-Length exceeds its input bound');
  }
  // Modern browser fetch exposes a stream. Refuse an unavailable stream rather
  // than allocate an unbounded arrayBuffer based only on a server's assertion.
  if (!response.body || typeof response.body.getReader !== 'function')
    throw new Error('Asset response has no bounded readable stream');
  const reader = response.body.getReader(),
    chunks = [];
  let total = 0,
    reads = 0,
    cancelTask = null;
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
      if (++reads > 65536) throw new Error('Asset stream exceeds its chunk-count bound');
      if (!(value instanceof Uint8Array)) throw new Error('Asset stream returned non-byte data');
      if (
        value.byteLength > limit - total ||
        (declared !== null && value.byteLength > declared - total)
      )
        throw new Error('Asset stream exceeds its input bound');
      total += value.byteLength;
      chunks.push(value.slice());
    }
    if (declared !== null && total !== declared)
      throw new Error('Asset response length disagrees with Content-Length');
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    aborted(signal);
    return bytes;
  } catch (error) {
    await cancel(error);
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (cancelTask) await cancelTask;
    reader.releaseLock();
  }
}

function source(mode, describe, readImpl) {
  const read = async (name, { signal } = {}) => {
    specFor(name);
    checkSignal(signal);
    return awaitAssetRead(signal, () => readImpl(name, { signal }), 'Standing asset read aborted');
  };
  return {
    mode,
    describe,
    read,
    async load({ signal } = {}) {
      checkSignal(signal);
      return awaitAssetRead(signal, async () => {
        const clipBytes = await read('clip', { signal }),
          skeletonBytes = await read('skeleton', { signal });
        const skeletonBinding = await parseStandingSkeletonBinding(skeletonBytes, { signal });
        aborted(signal);
        return { clipBytes, skeletonBytes, skeletonBinding };
      }, 'Standing asset load aborted');
    },
    async loadMarch({ signal } = {}) {
      checkSignal(signal);
      return awaitAssetRead(signal, async () => {
        const clipBytes = await read('march', { signal }),
          skeletonBytes = await read('skeleton', { signal });
        const skeletonBinding = await parseStandingSkeletonBinding(skeletonBytes, { signal });
        aborted(signal);
        return { clipBytes, skeletonBytes, skeletonBinding };
      }, 'Standing asset load aborted');
    },
  };
}
export function createDevelopmentStandingAssets({ fetchImpl = fetch } = {}) {
  if (typeof fetchImpl !== 'function')
    throw new TypeError('Development standing assets require fetch');
  return source(
    'development',
    () => ({ mode: 'development', availableNames: [...names], missingPaths: [] }),
    async (name, { signal } = {}) => {
      const spec = specFor(name);
      checkSignal(signal);
      let response;
      try {
        response = await fetchImpl(spec.route, { signal });
        aborted(signal);
        if (!response?.ok)
          throw new Error(`Cannot load standing ${name}: HTTP ${response?.status ?? 'unknown'}`);
        return await verify(
          await boundedResponse(response, spec.bytes, signal),
          spec.bytes,
          spec.sha256,
          name,
          signal
        );
      } catch (error) {
        if (response?.body && !response.body.locked)
          try {
            await response.body.cancel(error);
          } catch {}
        throw error;
      }
    }
  );
}

function normalizedPath(path) {
  if (
    typeof path !== 'string' ||
    path.length === 0 ||
    path.length > maxPath ||
    /[\x00-\x1f\x7f]/.test(path)
  )
    throw new Error('Selected file has an invalid relative path');
  const clean = path.replace(/\\/g, '/');
  if (clean.startsWith('/') || /^[a-zA-Z]:/.test(clean))
    throw new Error('Selected paths must be relative to the chosen folder');
  const parts = clean.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..'))
    throw new Error('Selected paths cannot contain empty or traversal components');
  return parts.map(lower);
}
const rawPath = (file) => file.webkitRelativePath || file.name;
function snapshot(file) {
  if (!file || typeof file.name !== 'string' || typeof file.slice !== 'function')
    throw new TypeError('Select browser File objects from your game folder');
  const path = rawPath(file),
    parts = normalizedPath(path),
    size = file.size,
    lastModified = file.lastModified;
  if (!Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(lastModified))
    throw new Error(`Invalid selected file metadata: ${path}`);
  return { file, path, parts, size, lastModified };
}
function stable(r) {
  if (
    r.file.size !== r.size ||
    r.file.lastModified !== r.lastModified ||
    rawPath(r.file) !== r.path
  )
    throw new Error(`Selected file changed during standing read: ${r.path}`);
}
async function slice(r, start, length, signal) {
  aborted(signal);
  stable(r);
  if (start > r.size || length > r.size - start)
    throw new Error(`Selected file is incomplete: ${r.path}`);
  const blob = r.file.slice(start, start + length);
  if (!blob || blob.size !== length || typeof blob.arrayBuffer !== 'function')
    throw new Error(`Selected slice is incomplete: ${r.path}`);
  const buffer = await blob.arrayBuffer();
  aborted(signal);
  stable(r);
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== length)
    throw new Error(`Selected read is incomplete: ${r.path}`);
  return new Uint8Array(buffer).slice();
}
function ascii(bytes, start, end) {
  return String.fromCharCode(...bytes.subarray(start, end));
}
function checkIndex(bytes, name) {
  const s = specs[name],
    v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    r = s.record;
  // Whole-index digests bind the prior complete, unique selected-name audit.
  // These are selected-record checks, not a new generic archive parser.
  const animation = name === 'clip' || name === 'march';
  if (
    ascii(bytes, 0, animation ? 10 : 9) !== (animation ? 'ANIM.PACK\0' : 'SKEL.PACK') ||
    v.getUint32(12, true) !== (animation ? 4 : 3) ||
    v.getUint32(16, true) !== (animation ? 1116 : 53) ||
    v.getUint32(r, true) !== (name === 'march' ? 41 : animation ? 35 : 22) ||
    v.getUint32(r + 4, true) !== s.start ||
    v.getUint32(r + 8, true) !== s.bytes
  )
    throw new Error(`Selected ${s.index} record differs from the verified source`);
  const nameStart = r + (animation ? 21 : 12);
  if (
    ascii(bytes, nameStart, s.recordEnd) !==
    (name === 'march'
      ? 'data/animations/SG 03 MARCH.cas\0'
      : animation
        ? 'data/animations/SG 01.cas\0'
        : 'strat_named_with_army\0')
  )
    throw new Error(`Selected ${s.index} name differs from the verified source`);
  if (
    animation &&
    (v.getUint32(r + 12, true) !== 1060320051 ||
      v.getInt16(r + 16, true) !== 21 ||
      v.getInt16(r + 18, true) !== 19 ||
      v.getUint8(r + 20) !== 1)
  )
    throw new Error('Selected SG01 index fields differ from the verified source');
}
export function createLocalStandingAssets(files) {
  if (files === null || typeof files !== 'object')
    throw new TypeError('Select a game folder using the file picker');
  if (
    files.length !== undefined &&
    (!Number.isSafeInteger(files.length) || files.length < 0 || files.length > maxFiles)
  )
    throw new Error(`Selected folder exceeds ${maxFiles} file metadata entries`);
  const required = new Map(
      names.flatMap((n) => [
        [specs[n].index, specs[n].indexBytes],
        [specs[n].bank, specs[n].bankBytes],
      ])
    ),
    selected = new Map();
  let count = 0,
    root = null;
  const add = (file) => {
    if (++count > maxFiles)
      throw new Error(`Selected folder exceeds ${maxFiles} file metadata entries`);
    const r = snapshot(file);
    let key, at;
    for (const i of [0, 1])
      if (r.parts[i] === 'data' && required.has(r.parts.slice(i).join('/'))) {
        key = r.parts.slice(i).join('/');
        at = i;
        break;
      }
    if (key === undefined) return;
    if (selected.has(key)) throw new Error(`Duplicate selected required path: ${key}`);
    const prefix = r.parts.slice(0, at + 1).join('/');
    if (root !== null && root !== prefix)
      throw new Error('Choose one game folder or its Data folder, not mixed roots');
    root = prefix;
    if (r.size !== required.get(key))
      throw new Error(`Selected ${key} has an unsupported input size`);
    selected.set(key, r);
  };
  if (typeof files[Symbol.iterator] === 'function') {
    for (const file of files) add(file);
  } else {
    if (files.length === undefined)
      throw new TypeError('Selected files must be iterable or FileList-like');
    for (let i = 0; i < files.length; i++) add(files[i]);
  }
  const need = (path) => {
    const r = selected.get(path);
    if (!r) throw new Error(`Missing required game file: ${path}`);
    return r;
  };
  return source(
    'local',
    () => ({
      mode: 'local',
      selectedFileCount: count,
      availableNames: names.filter(
        (n) => selected.has(specs[n].index) && selected.has(specs[n].bank)
      ),
      missingPaths: [...required.keys()].filter((p) => !selected.has(p)),
    }),
    async (name, { signal } = {}) => {
      const s = specFor(name);
      checkSignal(signal);
      const index = need(s.index),
        bank = need(s.bank);
      const indexBytes = await verify(
        await slice(index, 0, s.indexBytes, signal),
        s.indexBytes,
        s.indexHash,
        s.index,
        signal
      );
      stable(index);
      stable(bank);
      checkIndex(indexBytes, name);
      const bytes = await verify(
        await slice(bank, s.start, s.bytes, signal),
        s.bytes,
        s.sha256,
        name,
        signal
      );
      stable(index);
      stable(bank);
      aborted(signal);
      return bytes;
    }
  );
}

// Default campaign presentation treats this selected animation as optional.
// A foreign/modified bank may refuse this exact profile without refusing the
// player's otherwise usable campaign folder. The strict provider remains
// available to diagnostics and tests; no hosted fallback is introduced.
export function createOptionalLocalStandingAssets(files) {
  try {
    return createLocalStandingAssets(files);
  } catch (error) {
    const reason = String(error?.message ?? error).slice(0, 512);
    return source(
      'local',
      () => ({ mode: 'local', availableNames: [], missingPaths: [], optionalRejected: reason }),
      async (_name, { signal } = {}) => {
        checkSignal(signal);
        throw new Error(`Optional standing assets were rejected: ${reason}`);
      }
    );
  }
}

export async function parseStandingSkeletonBinding(input, { signal } = {}) {
  checkSignal(signal);
  if (!(input instanceof Uint8Array) || input.byteLength !== specs.skeleton.bytes)
    throw new Error('Standing skeleton must be the selected 6126-byte source');
  // Buffer.slice() aliases the input and may retain a nonzero view offset.
  const bytes = new Uint8Array(input);
  await verify(bytes, specs.skeleton.bytes, specs.skeleton.sha256, 'standing skeleton', signal);
  const v = new DataView(bytes.buffer),
    range = (start, endExclusive) => ({ start, endExclusive });
  const scaleBits = v.getUint32(0, true),
    scale = v.getFloat32(0, true),
    nodeCount = v.getUint16(4, true),
    translationRightsCount = v.getUint16(6, true),
    ikLerpFractionBits = v.getUint32(8, true),
    ikLerpFraction = v.getFloat32(8, true);
  if (nodeCount !== 19 || !Number.isFinite(scale) || !Number.isFinite(ikLerpFraction))
    throw new Error('Unsupported selected skeleton header');
  const nodes = [];
  for (let slot = 0; slot < nodeCount; slot++) {
    const start = 12 + slot * 24,
      parentIndex = v.getInt32(start + 16, true),
      poseBits = [0, 1, 2].map((i) => v.getUint32(start + 4 + i * 4, true)),
      pose = [0, 1, 2].map((i) => v.getFloat32(start + 4 + i * 4, true));
    if (parentIndex < -1 || parentIndex >= slot || !pose.every(Number.isFinite))
      throw new Error('Unsupported selected skeleton parent or pose');
    nodes.push({
      slot,
      sourceRange: range(start, start + 24),
      attachmentType: v.getUint32(start, true),
      poseBits,
      pose,
      parentIndex,
      hasTranslationRaw: v.getUint8(start + 20),
      applyIkRaw: v.getUint8(start + 21),
      sourceSkippedOpaqueBytes: Array.from(bytes.subarray(start + 22, start + 24)),
    });
  }
  aborted(signal);
  return {
    schema: 'openrtw-standing-skeleton-binding-v1',
    meaning: 'source-bound ordered skeleton; native mapping and scale composition unproved',
    sourceSha256: specs.skeleton.sha256,
    sourceBytes: bytes.length,
    headerRange: range(0, 12),
    nodesRange: range(12, 468),
    retainedRemainderRange: range(468, bytes.length),
    scaleBits,
    scale,
    nodeCount,
    translationRightsCount,
    ikLerpFractionBits,
    ikLerpFraction,
    parents: nodes.map((n) => n.parentIndex),
    nodes,
  };
}
