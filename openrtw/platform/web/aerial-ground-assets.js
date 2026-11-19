import { decodeTgaTexture } from './texture-image.js';
import { findTerrainMaterialSource } from './terrain-material-source.js';

// Optional source transport only. Literal slots are not seasons, UV rules or
// climate/category joins; importing this module performs no source reads.
const sourcePins = [
  ['alpine.tga', 786476, '2b6cc7bd2ac0cab343112ccb6f6e03d37be60081238326d21e8dd736646592fb'],
  ['arctic.tga', 786476, 'da1e66846158175be403cd140cfe8a74a3df054fb574bddd4456a3ab168f1804'],
  ['beach.tga', 196652, '2061cd09d0bd932f8d2a4f0d1ef2ecbd488f706cc4102164c2191e2138dae091'],
  ['desert_hills.tga', 786476, '79b9e6a873946a438cf4e98f54e990fb74c9fc21b438cb2c0d791c7ceb0ae448'],
  [
    'desert_mountains.tga',
    786476,
    '77ee501a87430841d5752db9a5724cfbd851259bf90a6073bae9ab12cc59c08a',
  ],
  [
    'desert_rocky_low_fertility.tga',
    786476,
    '9226836ae5544b2fd66c175df4fb52e11e648da08d7569ac3c645a99541593db',
  ],
  [
    'desert_rocky_medium_fertility.tga',
    786476,
    'e7640f88f9085b1c21cdac1706fa9ad4ee05eb38eb7db094369009ae41d79379',
  ],
  [
    'desert_sandy_medium_fertility.tga',
    786476,
    '74a4ca51452a26a49dda6d62b77cf634f812d18e09ef0ca4f051d6f5835dcdb3',
  ],
  ['scorched.tga', 49196, '76ebfdcfb56a844ce53c20e3ddc29acebfc6f8cf8dc444df18d2f212fb140f8c'],
  ['swamp.tga', 196652, '26e33b02bf9d945fc2a825b18026b4df5abfbff1814793266a24aa86c9d041af'],
  [
    'temperate_grassland.tga',
    786476,
    'a2ea50856b0f2f264d0bf7beaba099a372948fe4e84aa68791204d8bad8f8e4f',
  ],
  [
    'temperate_grassland_farm.tga',
    196652,
    '3e34f1a1cbf8c198259a04f64f6820ad75486a0ec195c42f7cc4e7158b96928b',
  ],
  [
    'temperate_hills_small.tga',
    196652,
    '38f3d7eda81f08ccc44fdbfb976b0e1f67c5b755434704e9c51057582107143e',
  ],
  [
    'temperate_mountain_small.tga',
    196652,
    'efa445ddcd6bfa225f46c1d4867a1f75639c0090ecace93939c350902d11198c',
  ],
  ['texture1.tga', 786476, '3c96ddf20b70369a60c1c8f33669ac0d0c5f389202d114954672fc452ce38d80'],
  [
    'texture1_hilly.tga',
    196652,
    '3feaa43b3e8ba6bac9eb3b052acdf3e6c24323efc78a17b6811641d07ef067f4',
  ],
  ['texture2.tga', 786476, 'db177eefe8ebbbfe61353ab3d9230a409de293c9ec50cb9eaae09e944dfd9a05'],
];
const freeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
};
export const aerialGroundAssetDescriptors = freeze(
  Object.fromEntries(
    sourcePins.map(([filename, sourceBytes, sourceSha256]) => [
      filename,
      {
        filename,
        sourcePath: 'data/terrain/aerial_map/ground_types/' + filename,
        route: '/assets/aerial-ground/' + filename,
        sourceBytes,
        sourceSha256,
      },
    ])
  )
);
export const aerialGroundAssetLimits = Object.freeze({
  sources: 17,
  totalSourceBytes: 9093868,
  selectedFiles: 65536,
  pathCharacters: 4096,
  streamChunks: 65536,
});
const names = Object.keys(aerialGroundAssetDescriptors),
  providers = new WeakSet();
const refusal = (message) => new Error('Aerial ground assets: ' + message);
const specFor = (filename) => {
  if (typeof filename !== 'string' || !Object.hasOwn(aerialGroundAssetDescriptors, filename))
    throw refusal('unknown literal filename');
  return aerialGroundAssetDescriptors[filename];
};
const abortError = () => new DOMException('Aerial ground read cancelled', 'AbortError');
const aborted = (signal) => {
  if (signal?.aborted) throw signal.reason === undefined ? abortError() : signal.reason;
};
function checkSignal(signal) {
  if (
    signal !== undefined &&
    signal !== null &&
    (typeof signal.aborted !== 'boolean' ||
      typeof signal.addEventListener !== 'function' ||
      typeof signal.removeEventListener !== 'function')
  )
    throw new TypeError('Aerial ground signal must be an AbortSignal');
  aborted(signal);
}
async function verify(input, spec, signal) {
  aborted(signal);
  if (
    !(input instanceof Uint8Array) ||
    !(input.buffer instanceof ArrayBuffer) ||
    input.length !== spec.sourceBytes
  )
    throw refusal('unexpected selected source extent');
  const bytes = input.slice(),
    hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (value) =>
      value.toString(16).padStart(2, '0')
    ).join('');
  aborted(signal);
  if (hash !== spec.sourceSha256) throw refusal('selected source identity differs');
  return bytes;
}
async function streamed(response, limit, signal, ownership) {
  if (!response.headers || typeof response.headers.get !== 'function')
    throw refusal('missing response headers');
  const header = response.headers.get('Content-Length');
  let declared = null;
  if (header !== null) {
    if (typeof header !== 'string' || !/^(0|[1-9][0-9]*)$/.test(header))
      throw refusal('invalid Content-Length');
    declared = Number(header);
    if (!Number.isSafeInteger(declared) || declared > limit)
      throw refusal('Content-Length exceeds source bound');
  }
  if (!response.body || typeof response.body.getReader !== 'function')
    throw refusal('response has no bounded readable stream');
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
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    aborted(signal);
    for (;;) {
      const { done, value } = await reader.read();
      aborted(signal);
      if (done) break;
      if (++reads > aerialGroundAssetLimits.streamChunks) throw refusal('stream chunk bound');
      if (!(value instanceof Uint8Array) || !(value.buffer instanceof ArrayBuffer))
        throw refusal('stream returned non-owned byte data');
      if (value.length > limit - total || (declared !== null && value.length > declared - total))
        throw refusal('stream byte bound');
      total += value.length;
      chunks.push(value.slice());
    }
    if (declared !== null && declared !== total)
      throw refusal('Content-Length disagrees with drained stream');
  } catch (error) {
    failed = true;
    firstError = error;
    await cancel(error);
  } finally {
    signal.removeEventListener('abort', onAbort);
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
  const result = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    result.set(chunk, at);
    at += chunk.length;
  }
  aborted(signal);
  return result;
}
function source(mode, describe, readImpl, isOpen, clear = () => {}) {
  // Reads have independent owned results. close() is synchronous/idempotent:
  // abort every active stream; a File slice already pending must settle before
  // its result is discarded. Neither path may publish after close/cancellation.
  if (typeof isOpen !== 'function') throw new TypeError('Aerial ground isOpen must be a function');
  let closed = false,
    reason;
  const active = new Set();
  const open = () => {
    if (closed) throw reason;
    if (!isOpen()) throw abortError();
  };
  async function operation(filename, signal, decode) {
    const spec = specFor(filename);
    open();
    checkSignal(signal);
    const controller = new AbortController(),
      relay = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', relay, { once: true });
    active.add(controller);
    let hasPrimary = false;
    try {
      aborted(signal);
      const bytes = await readImpl(spec, controller.signal, open);
      open();
      aborted(controller.signal);
      if (!decode) return bytes;
      const image = decodeTgaTexture(bytes);
      open();
      aborted(controller.signal);
      return Object.freeze({
        source: spec,
        width: image.width,
        height: image.height,
        rgba: image.rgba,
        header: Object.freeze(image.header),
        sourceFacts: Object.freeze(image.sourceFacts),
      });
    } catch (error) {
      hasPrimary = true;
      throw error;
    } finally {
      try {
        signal?.removeEventListener('abort', relay);
      } catch (error) {
        if (!hasPrimary) throw error;
      } finally {
        active.delete(controller);
      }
    }
  }
  const result = Object.freeze({
    mode,
    describe: () => freeze({ ...describe(), closed }),
    read: (filename, { signal } = {}) => operation(filename, signal, false),
    load: (filename, { signal } = {}) => operation(filename, signal, true),
    close(closeReason) {
      if (closed) return;
      closed = true;
      reason =
        closeReason === undefined
          ? new DOMException('Aerial ground source closed', 'AbortError')
          : closeReason;
      clear();
      for (const controller of active) controller.abort(reason);
    },
  });
  providers.add(result);
  return result;
}
export function createDevelopmentAerialGroundAssets({
  fetchImpl = fetch,
  isOpen = () => true,
} = {}) {
  if (typeof fetchImpl !== 'function')
    throw new TypeError('Development aerial ground assets require fetch');
  return source(
    'development',
    () => ({ mode: 'development', availableNames: [...names], missingPaths: [] }),
    async (spec, signal, open) => {
      let response;
      const ownership = { readerOwned: false };
      try {
        response = await fetchImpl(spec.route, { signal });
        open();
        aborted(signal);
        if (!response?.ok) throw refusal('HTTP ' + (response?.status ?? 'unknown'));
        const bytes = await streamed(response, spec.sourceBytes, signal, ownership);
        open();
        return await verify(bytes, spec, signal);
      } catch (error) {
        if (!ownership.readerOwned && response?.body && !response.body.locked)
          try {
            await response.body.cancel(error);
          } catch {}
        throw error;
      }
    },
    isOpen
  );
}
const lower = (value) => value.replace(/[A-Z]/g, (c) => c.toLowerCase()),
  rawPath = (file) => file.webkitRelativePath || file.name;
function snapshot(file) {
  if (!file || typeof file.name !== 'string' || typeof file.slice !== 'function')
    throw new TypeError('Select browser File objects');
  const path = rawPath(file);
  if (
    typeof path !== 'string' ||
    !path.length ||
    path.length > aerialGroundAssetLimits.pathCharacters ||
    /[\x00-\x1f\x7f]/.test(path)
  )
    throw refusal('invalid selected relative path');
  const clean = path.replace(/\\/g, '/');
  if (clean.startsWith('/') || /^[A-Za-z]:/.test(clean))
    throw refusal('selected path must be relative');
  const parts = clean.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..'))
    throw refusal('selected traversal path');
  const size = file.size,
    lastModified = file.lastModified;
  if (!Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(lastModified))
    throw refusal('invalid selected metadata');
  return { file, path, parts: parts.map(lower), size, lastModified };
}
function stable(record) {
  if (
    record.file.size !== record.size ||
    record.file.lastModified !== record.lastModified ||
    rawPath(record.file) !== record.path
  )
    throw refusal('selected file changed during read');
}
async function localRead(record, spec, signal, open) {
  open();
  aborted(signal);
  stable(record);
  const blob = record.file.slice(0, spec.sourceBytes);
  if (!blob || blob.size !== spec.sourceBytes || typeof blob.arrayBuffer !== 'function')
    throw refusal('incomplete selected slice');
  const buffer = await blob.arrayBuffer();
  open();
  aborted(signal);
  stable(record);
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== spec.sourceBytes)
    throw refusal('incomplete selected read');
  const bytes = await verify(new Uint8Array(buffer), spec, signal);
  open();
  stable(record);
  return bytes;
}
export function createLocalAerialGroundAssets(files, { isOpen = () => true } = {}) {
  if (files === null || typeof files !== 'object')
    throw new TypeError('Select one game folder or Data folder');
  if (
    files.length !== undefined &&
    (!Number.isSafeInteger(files.length) ||
      files.length < 0 ||
      files.length > aerialGroundAssetLimits.selectedFiles)
  )
    throw refusal('selected folder metadata bound');
  const required = new Map(
      names.map((filename) => {
        const spec = specFor(filename);
        return [lower(spec.sourcePath), spec];
      })
    ),
    selected = new Map();
  let count = 0,
    root = null;
  function add(file) {
    if (++count > aerialGroundAssetLimits.selectedFiles)
      throw refusal('selected folder metadata bound');
    const record = snapshot(file);
    let key, at;
    for (const i of [0, 1])
      if (record.parts[i] === 'data' && required.has(record.parts.slice(i).join('/'))) {
        key = record.parts.slice(i).join('/');
        at = i;
        break;
      }
    if (key === undefined) return;
    if (selected.has(key)) throw refusal('duplicate selected source path');
    const prefix = record.parts.slice(0, at + 1).join('/');
    if (root !== null && root !== prefix) throw refusal('choose one game folder or Data folder');
    root = prefix;
    if (record.size !== required.get(key).sourceBytes)
      throw refusal('selected source size differs');
    selected.set(key, record);
  }
  if (typeof files[Symbol.iterator] === 'function') {
    for (const file of files) add(file);
  } else {
    if (files.length === undefined)
      throw new TypeError('Selected files must be iterable or FileList-like');
    for (let i = 0; i < files.length; i++) add(files[i]);
  }
  return source(
    'local',
    () => ({
      mode: 'local',
      selectedFileCount: count,
      availableNames: names.filter((filename) => selected.has(lower(specFor(filename).sourcePath))),
      missingPaths: [...required.keys()].filter((path) => !selected.has(path)),
    }),
    async (spec, signal, open) => {
      const record = selected.get(lower(spec.sourcePath));
      if (!record) throw refusal('missing selected source: ' + spec.sourcePath);
      return await localRead(record, spec, signal, open);
    },
    isOpen,
    () => selected.clear()
  );
}

// Select only a literal declared slot. Reporting a default declaration never
// activates it for an absent climate/role, and the numeric slot is not a season.
export async function loadDeclaredAerialGroundTexture(
  provider,
  declarations,
  { climateName, groundType, slotIndex = 0, signal } = {}
) {
  if (!providers.has(provider)) throw new TypeError('Use an aerial ground source factory');
  if (!Number.isSafeInteger(slotIndex) || slotIndex < 0 || slotIndex > 1)
    throw refusal('invalid literal slot index');
  const literal = findTerrainMaterialSource(declarations, { climateName, groundType });
  if (!literal.declaration || slotIndex >= literal.declaration.textureSlots.length)
    throw refusal('literal texture slot not declared');
  const filename = literal.declaration.textureSlots[slotIndex];
  specFor(filename);
  const image = await provider.load(filename, { signal });
  return Object.freeze({
    ...image,
    literalSelection: Object.freeze({
      climateName,
      groundType,
      slotIndex,
      sourceLine: literal.declaration.sourceLine,
      filename,
      nativeSelectionEquivalent: false,
    }),
  });
}
