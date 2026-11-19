import { awaitAssetRead } from './runtime/asset-read-scope.js';

// Optional closed provider for six selected archer/triarii/Velite bindings.
// Exact packaged DDS candidates only: no native TGA fallback/LOD/material claim.
const maxFiles = 65536,
  maxPath = 4096,
  packPath = 'data/packs/models_unit_textures.pak',
  packBytes = 92289750,
  indexBytes = 104614;
const indexHash = '6c4c2c15d53909be58fe7cae904775d39254a6f4590b836382fc36b1c9a75dce';
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) freeze(v);
    Object.freeze(value);
  }
  return value;
}
export const battleSourceAssetSpecs = freeze({
  battleRomanArcherCas: {
    path: 'data/models_unit/unit_roman_archer_lowest.cas',
    route: '/assets/battle-roman-archer.cas',
    bytes: 39273,
    sha256: 'e4c226d370ed061c81f0ccda7a0bc88710940935c60e3a0084db673b1f35c87f',
  },
  battleRomanArcherJuliiTexture: {
    path: 'data/models_unit/textures/unit_roman_archer_julii.tga.dds',
    route: '/assets/battle-roman-archer-julii-texture.dds',
    bytes: 87536,
    sha256: '0003d22dc206c2d6a9ccaccd5de030171bc9bfcc1499cd97c6dbe1a90bdc00c9',
    pack: {
      path: 'data/packs/models_unit_textures.pak',
      storedName: 'DATA\\MODELS_UNIT\\TEXTURES\\UNIT_ROMAN_ARCHER_JULII.TGA.DDS',
      ordinalZeroBased: 671,
      offset: 79246886,
      bytes: 87536,
    },
    declaredPath: 'data/models_unit/textures/unit_roman_archer_julii.tga',
  },
  battleRomanTriariiCas: {
    path: 'data/models_unit/unit_roman_triarii_lowest.cas',
    route: '/assets/battle-roman-triarii.cas',
    bytes: 41173,
    sha256: 'd2ab5c8f79657f374d4c23d1d02e9695b675d34672dad0999a28139ed0fcbea9',
  },
  battleRomanTriariiJuliiTexture: {
    path: 'data/models_unit/textures/unit_roman_triarii_julii.tga.dds',
    route: '/assets/battle-roman-triarii-julii-texture.dds',
    bytes: 87536,
    sha256: '3cd1d35975ebe569d1d1e86a7c262416d5d3312b23f0478351548f64f8e63b47',
    pack: {
      path: 'data/packs/models_unit_textures.pak',
      storedName: 'DATA\\MODELS_UNIT\\TEXTURES\\UNIT_ROMAN_TRIARII_JULII.TGA.DDS',
      ordinalZeroBased: 781,
      offset: 88875846,
      bytes: 87536,
    },
    declaredPath: 'data/models_unit/textures/unit_roman_triarii_julii.tga',
  },
  battleRomanArcherBrutiiTexture: {
    path: 'data/models_unit/textures/unit_roman_archer_brutii.tga.dds',
    route: '/assets/battle-roman-archer-brutii-texture.dds',
    bytes: 87536,
    sha256: 'f9d6a4a59a731fd0e929f7a58df6a6ebfc167b76b57959bc27c4b94493b73fc2',
    pack: {
      path: 'data/packs/models_unit_textures.pak',
      storedName: 'DATA\\MODELS_UNIT\\TEXTURES\\UNIT_ROMAN_ARCHER_BRUTII.TGA.DDS',
      ordinalZeroBased: 669,
      offset: 79071814,
      bytes: 87536,
    },
    declaredPath: 'data/models_unit/textures/unit_roman_archer_brutii.tga',
  },
  battleRomanTriariiBrutiiTexture: {
    path: 'data/models_unit/textures/unit_roman_triarii_brutii.tga.dds',
    route: '/assets/battle-roman-triarii-brutii-texture.dds',
    bytes: 87536,
    sha256: '423e599b0f28b06d53ffde09df950af879c45257a9e81f648d97344c10a703eb',
    pack: {
      path: 'data/packs/models_unit_textures.pak',
      storedName: 'DATA\\MODELS_UNIT\\TEXTURES\\UNIT_ROMAN_TRIARII_BRUTII.TGA.DDS',
      ordinalZeroBased: 779,
      offset: 88700774,
      bytes: 87536,
    },
    declaredPath: 'data/models_unit/textures/unit_roman_triarii_brutii.tga',
  },
  battleRomanVeliteCas: {
    path: 'data/models_unit/unit_roman_velite_lowest.cas',
    route: '/assets/battle-roman-velite.cas',
    bytes: 30032,
    sha256: '99c39ba1447a74ee9569e9143e85029e316924216170333201e3610dc893a022',
  },
  battleRomanVeliteJuliiTexture: {
    path: 'data/models_unit/textures/unit_roman_peasant_julii.tga.dds',
    route: '/assets/battle-roman-velite-julii-texture.dds',
    bytes: 87536,
    sha256: '3c54288839e4acedfea5a1c626a79764e44a3ded6caca63dbd18244c117734cc',
    pack: {
      path: 'data/packs/models_unit_textures.pak',
      storedName: 'DATA\\MODELS_UNIT\\TEXTURES\\UNIT_ROMAN_PEASANT_JULII.TGA.DDS',
      ordinalZeroBased: 732,
      offset: 84586582,
      bytes: 87536,
    },
    declaredPath: 'data/models_unit/textures/unit_roman_peasant_julii.tga',
  },
  battleRomanVeliteBrutiiTexture: {
    path: 'data/models_unit/textures/unit_roman_peasant_brutii.tga.dds',
    route: '/assets/battle-roman-velite-brutii-texture.dds',
    bytes: 87536,
    sha256: 'cff3a91432e1334f52f5315b7444bd10ceb15925596a534506021aa740b83bac',
    pack: {
      path: 'data/packs/models_unit_textures.pak',
      storedName: 'DATA\\MODELS_UNIT\\TEXTURES\\UNIT_ROMAN_PEASANT_BRUTII.TGA.DDS',
      ordinalZeroBased: 730,
      offset: 84411510,
      bytes: 87536,
    },
    declaredPath: 'data/models_unit/textures/unit_roman_peasant_brutii.tga',
  },
});
export const battleSourceKeys = Object.freeze([
  'romans_julii:roman_archer',
  'romans_brutii:roman_archer',
  'romans_julii:roman_triarii',
  'romans_brutii:roman_triarii',
  'romans_julii:roman_velite',
  'romans_brutii:roman_velite',
]);
const bindings = freeze({
  'romans_julii:roman_archer': ['battleRomanArcherCas', 'battleRomanArcherJuliiTexture'],
  'romans_julii:roman_triarii': ['battleRomanTriariiCas', 'battleRomanTriariiJuliiTexture'],
  'romans_brutii:roman_archer': ['battleRomanArcherCas', 'battleRomanArcherBrutiiTexture'],
  'romans_brutii:roman_triarii': ['battleRomanTriariiCas', 'battleRomanTriariiBrutiiTexture'],
  'romans_julii:roman_velite': ['battleRomanVeliteCas', 'battleRomanVeliteJuliiTexture'],
  'romans_brutii:roman_velite': ['battleRomanVeliteCas', 'battleRomanVeliteBrutiiTexture'],
});
const names = Object.keys(battleSourceAssetSpecs),
  lower = (s) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
function spec(name) {
  if (typeof name !== 'string' || !Object.hasOwn(battleSourceAssetSpecs, name))
    throw Error('Unknown optional battle asset: ' + String(name));
  return battleSourceAssetSpecs[name];
}
function check(signal, isOpen) {
  if (!isOpen()) throw new DOMException('Battle source loading cancelled', 'AbortError');
  if (signal?.aborted) throw signal.reason;
}
function signalCheck(signal, isOpen) {
  if (
    signal !== undefined &&
    signal !== null &&
    (typeof signal.aborted !== 'boolean' ||
      typeof signal.addEventListener !== 'function' ||
      typeof signal.removeEventListener !== 'function')
  )
    throw TypeError('Battle source signal must be an AbortSignal');
  check(signal, isOpen);
}
async function digest(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (v) =>
    v.toString(16).padStart(2, '0')
  ).join('');
}
async function verify(bytes, size, hash, signal, isOpen) {
  check(signal, isOpen);
  if (bytes.length !== size) throw Error('Selected battle source length differs');
  const actual = await digest(bytes);
  check(signal, isOpen);
  if (actual !== hash) throw Error('Selected battle source hash differs');
  return bytes;
}
function failure(error, cleanup, failed = true) {
  if (cleanup.length)
    throw new AggregateError(
      failed ? [error, ...cleanup] : cleanup,
      'Battle source read/cleanup failed'
    );
  if (failed) throw error;
}
async function boundedBody(response, limit, signal, isOpen) {
  let reader,
    result,
    error,
    cancelTask,
    failed = false;
  const cleanup = [];
  const cancel = (reason) =>
    (cancelTask ??= (async () => {
      try {
        await reader.cancel(reason);
      } catch (e) {
        cleanup.push(e);
      }
    })());
  const onAbort = () => {
    if (reader) cancel(signal.reason);
  };
  try {
    const header = response.headers.get('Content-Length');
    let declared = null;
    if (header !== null) {
      if (!/^(0|[1-9][0-9]*)$/.test(header)) throw Error('Invalid battle source Content-Length');
      declared = Number(header);
      if (!Number.isSafeInteger(declared) || declared > limit)
        throw Error('Battle source Content-Length exceeds bound');
    }
    if (!response.body || typeof response.body.getReader !== 'function')
      throw Error('Battle source body has no bounded stream');
    reader = response.body.getReader();
    signal?.addEventListener('abort', onAbort, { once: true });
    const chunks = [];
    let total = 0,
      reads = 0;
    for (;;) {
      check(signal, isOpen);
      const { done, value } = await reader.read();
      check(signal, isOpen);
      if (done) break;
      if (++reads > 65536) throw Error('Battle source chunk-count bound exceeded');
      if (!(value instanceof Uint8Array)) throw Error('Battle source chunk is not bytes');
      if (value.length > limit - total || (declared !== null && value.length > declared - total))
        throw Error('Battle source body exceeds bound');
      total += value.length;
      chunks.push(value.slice());
    }
    if (declared !== null && total !== declared) throw Error('Battle source body length disagrees');
    result = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      result.set(chunk, at);
      at += chunk.length;
    }
    check(signal, isOpen);
  } catch (e) {
    failed = true;
    error = e;
    if (reader) await cancel(e);
    else if (response.body && !response.body.locked)
      try {
        await response.body.cancel(e);
      } catch (e) {
        cleanup.push(e);
      }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (cancelTask) await cancelTask;
    if (reader)
      try {
        reader.releaseLock();
      } catch (e) {
        cleanup.push(e);
      }
  }
  failure(error, cleanup, failed);
  return result;
}
export function createDevelopmentBattleAssets({ fetchImpl = fetch, isOpen = () => true } = {}) {
  if (typeof fetchImpl !== 'function' || typeof isOpen !== 'function')
    throw TypeError('Optional battle development provider requires fetch/isOpen');
  return Object.freeze({
    mode: 'development',
    describe: () => ({
      mode: 'development',
      availableNames: names.slice(),
      availableKeys: battleSourceKeys.slice(),
      missingPaths: [],
    }),
    async read(name, { signal } = {}) {
      const s = spec(name);
      signalCheck(signal, isOpen);
      return awaitAssetRead(signal, async () => {
        let response;
        try {
          response = await fetchImpl(s.route, { signal });
          check(signal, isOpen);
          if (!response?.ok)
            throw Error(`Cannot load optional battle source: HTTP ${response?.status ?? 'unknown'}`);
        } catch (error) {
          const cleanup = [];
          if (response?.body && !response.body.locked)
            try {
              await response.body.cancel(error);
            } catch (e) {
              cleanup.push(e);
            }
          failure(error, cleanup);
        }
        const bytes = await boundedBody(response, s.bytes, signal, isOpen);
        return verify(bytes, s.bytes, s.sha256, signal, isOpen);
      }, 'Battle source read aborted');
    },
  });
}
function pathParts(path) {
  if (
    typeof path !== 'string' ||
    !path.length ||
    path.length > maxPath ||
    /[\x00-\x1f\x7f]/.test(path)
  )
    throw Error('Invalid optional battle relative path');
  const clean = path.replace(/\\/g, '/');
  if (clean.startsWith('/') || /^[A-Za-z]:/.test(clean))
    throw Error('Optional battle paths must be relative');
  const parts = clean.split('/');
  if (parts.some((v) => !v || v === '.' || v === '..'))
    throw Error('Optional battle path traversal/empty component');
  return parts.map(lower);
}
const rawPath = (file) => file.webkitRelativePath || file.name;
function inspect(file) {
  if (!file || typeof file.name !== 'string' || typeof file.slice !== 'function')
    throw TypeError('Select browser File objects for optional battle assets');
  const path = rawPath(file),
    parts = pathParts(path),
    size = file.size,
    lastModified = file.lastModified;
  if (!Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(lastModified))
    throw Error('Invalid optional battle file metadata');
  return { file, path, parts, size, lastModified };
}
function stable(r) {
  if (
    r.file.size !== r.size ||
    r.file.lastModified !== r.lastModified ||
    rawPath(r.file) !== r.path
  )
    throw Error('Selected optional battle file changed');
}
async function slice(r, start, length, signal, isOpen) {
  check(signal, isOpen);
  stable(r);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(length) ||
    start < 0 ||
    length < 0 ||
    start > r.size ||
    length > r.size - start
  )
    throw Error('Optional battle selected range exceeds file');
  const blob = r.file.slice(start, start + length);
  if (!blob || blob.size !== length || typeof blob.arrayBuffer !== 'function')
    throw Error('Optional battle slice length differs');
  const buffer = await blob.arrayBuffer();
  check(signal, isOpen);
  stable(r);
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== length)
    throw Error('Optional battle selected read length differs');
  return new Uint8Array(buffer).slice();
}
export function createLocalBattleAssets(files, { isOpen = () => true } = {}) {
  if (typeof isOpen !== 'function' || files === null || typeof files !== 'object')
    throw TypeError('Optional battle provider requires selected File objects/isOpen');
  if (
    files.length !== undefined &&
    (!Number.isSafeInteger(files.length) || files.length < 0 || files.length > maxFiles)
  )
    throw Error('Optional battle selected file count exceeds bound');
  const required = new Map(
    names.filter((n) => !spec(n).pack).map((n) => [spec(n).path, spec(n).bytes])
  );
  required.set(packPath, packBytes);
  const selected = new Map();
  let count = 0,
    root = null,
    verifiedIndex = null;
  const add = (file) => {
    if (++count > maxFiles) throw Error('Optional battle selected file count exceeds bound');
    const r = inspect(file);
    let key, at;
    for (const i of [0, 1])
      if (r.parts[i] === 'data' && required.has(r.parts.slice(i).join('/'))) {
        key = r.parts.slice(i).join('/');
        at = i;
        break;
      }
    if (key === undefined) return;
    if (selected.has(key)) throw Error('Duplicate optional battle selected path');
    const prefix = r.parts.slice(0, at + 1).join('/');
    if (root !== null && root !== prefix)
      throw Error('Optional battle files have mixed selected roots');
    root = prefix;
    if (r.size !== required.get(key)) throw Error('Optional battle selected file size differs');
    selected.set(key, r);
  };
  if (typeof files[Symbol.iterator] === 'function') {
    for (const file of files) add(file);
  } else {
    if (files.length === undefined)
      throw TypeError('Optional battle files must be iterable or FileList-like');
    for (let i = 0; i < files.length; i++) add(files[i]);
  }
  const need = (path) => {
      const r = selected.get(path);
      if (!r) throw Error('Missing optional battle file: ' + path);
      return r;
    },
    has = (name) => selected.has(spec(name).pack ? packPath : spec(name).path);
  return Object.freeze({
    mode: 'local',
    describe: () => ({
      mode: 'local',
      selectedFileCount: count,
      availableNames: names.filter(has),
      availableKeys: battleSourceKeys.filter((key) => bindings[key].every(has)),
      missingPaths: [...required.keys()].filter((p) => !selected.has(p)),
    }),
    async read(name, { signal } = {}) {
      const s = spec(name);
      signalCheck(signal, isOpen);
      return awaitAssetRead(signal, async () => {
        const r = need(s.pack ? packPath : s.path);
        stable(r);
        let bytes;
        if (s.pack) {
          if (!verifiedIndex) {
            const owned = await slice(r, 0, indexBytes, signal, isOpen);
            await verify(owned, indexBytes, indexHash, signal, isOpen);
            stable(r);
            verifiedIndex = owned;
          }
          // The owned immutable104614-byte index binds these six fixed ranges. No
          // generic parser, loose DDS fallback or whole archive read is allowed.
          stable(r);
          bytes = await slice(r, s.pack.offset, s.bytes, signal, isOpen);
        } else bytes = await slice(r, 0, s.bytes, signal, isOpen);
        bytes = await verify(bytes, s.bytes, s.sha256, signal, isOpen);
        stable(r);
        check(signal, isOpen);
        return bytes;
      }, 'Battle source read aborted');
    },
  });
}
