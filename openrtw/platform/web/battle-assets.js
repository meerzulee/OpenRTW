import { assembleCasGeometry } from '/cas-geometry.js';
import { awaitAssetRead } from './runtime/asset-read-scope.js';
import { assembleCasProfileGeometry } from '/cas-profile-geometry.js';
import {
  captureInfantryStandingModel,
  mergeInfantryStandingBattleAssets,
} from '/infantry-standing-pose-assets.js';
import {
  RenderState,
  StageState,
  TextureOp,
  TextureArg,
  Address,
  Filter,
  TextureFormat,
} from '/reference/renderer-bridge.js';

// Closed source bindings only. The selected declared lowest-LOD files are an
// explicit optional presentation choice, not recovered native LOD selection.
// No original payload is embedded and no provider/default input is changed.
const models = {
  roman_archer: {
    assetName: 'battleRomanArcherCas',
    path: 'data/models_unit/unit_roman_archer_lowest.cas',
    bytes: 39273,
    sha256: 'e4c226d370ed061c81f0ccda7a0bc88710940935c60e3a0084db673b1f35c87f',
    versionBits: 0x40433333,
    vertices: 125,
    triangles: 166,
    bones: 20,
    parts: 4,
    textureName: 'textures\\unit_roman_archer_julii.tga',
    modelDefinitionLine: 2761,
    declarationLine: 2771,
    declaredLod: 'max',
  },
  roman_triarii: {
    assetName: 'battleRomanTriariiCas',
    path: 'data/models_unit/unit_roman_triarii_lowest.cas',
    bytes: 41173,
    sha256: 'd2ab5c8f79657f374d4c23d1d02e9695b675d34672dad0999a28139ed0fcbea9',
    versionBits: 0x40433333,
    vertices: 171,
    triangles: 204,
    bones: 20,
    parts: 6,
    textureName: 'textures\\unit_roman_triarii_julii.tga',
    modelDefinitionLine: 3121,
    declarationLine: 3131,
    declaredLod: 'max',
  },
  roman_velite: {
    assetName: 'battleRomanVeliteCas',
    path: 'data/models_unit/unit_roman_velite_lowest.cas',
    bytes: 30032,
    sha256: '99c39ba1447a74ee9569e9143e85029e316924216170333201e3610dc893a022',
    versionBits: 0x404a3d71,
    vertices: 141,
    triangles: 167,
    bones: 20,
    parts: 5,
    textureName: 'textures\\unit_roman_peasant_julii.tga',
    modelDefinitionLine: 3138,
    declarationLine: 3149,
    declaredLod: 'max',
    admissionProfile: 'openrtw-cas316-terminal-kind7-v1',
    loader: '_openrtw_load_cas_mesh_terminal_kind7_316',
  },
};
const textures = {
  'romans_julii:roman_archer': {
    assetName: 'battleRomanArcherJuliiTexture',
    path: 'data/models_unit/textures/unit_roman_archer_julii.tga.dds',
    declaredPath: 'data/models_unit/textures/unit_roman_archer_julii.tga',
    declarationLine: 2764,
    bytes: 87536,
    sha256: '0003d22dc206c2d6a9ccaccd5de030171bc9bfcc1499cd97c6dbe1a90bdc00c9',
    pack: {
      path: 'data/packs/models_unit_textures.pak',
      storedName: 'DATA\\MODELS_UNIT\\TEXTURES\\UNIT_ROMAN_ARCHER_JULII.TGA.DDS',
      ordinalZeroBased: 671,
      offset: 79246886,
      bytes: 87536,
    },
  },
  'romans_brutii:roman_archer': {
    assetName: 'battleRomanArcherBrutiiTexture',
    path: 'data/models_unit/textures/unit_roman_archer_brutii.tga.dds',
    declaredPath: 'data/models_unit/textures/unit_roman_archer_brutii.tga',
    declarationLine: 2765,
    bytes: 87536,
    sha256: 'f9d6a4a59a731fd0e929f7a58df6a6ebfc167b76b57959bc27c4b94493b73fc2',
    pack: {
      path: 'data/packs/models_unit_textures.pak',
      storedName: 'DATA\\MODELS_UNIT\\TEXTURES\\UNIT_ROMAN_ARCHER_BRUTII.TGA.DDS',
      ordinalZeroBased: 669,
      offset: 79071814,
      bytes: 87536,
    },
  },
  'romans_julii:roman_triarii': {
    assetName: 'battleRomanTriariiJuliiTexture',
    path: 'data/models_unit/textures/unit_roman_triarii_julii.tga.dds',
    declaredPath: 'data/models_unit/textures/unit_roman_triarii_julii.tga',
    declarationLine: 3124,
    bytes: 87536,
    sha256: '3cd1d35975ebe569d1d1e86a7c262416d5d3312b23f0478351548f64f8e63b47',
    pack: {
      path: 'data/packs/models_unit_textures.pak',
      storedName: 'DATA\\MODELS_UNIT\\TEXTURES\\UNIT_ROMAN_TRIARII_JULII.TGA.DDS',
      ordinalZeroBased: 781,
      offset: 88875846,
      bytes: 87536,
    },
  },
  'romans_brutii:roman_triarii': {
    assetName: 'battleRomanTriariiBrutiiTexture',
    path: 'data/models_unit/textures/unit_roman_triarii_brutii.tga.dds',
    declaredPath: 'data/models_unit/textures/unit_roman_triarii_brutii.tga',
    declarationLine: 3125,
    bytes: 87536,
    sha256: '423e599b0f28b06d53ffde09df950af879c45257a9e81f648d97344c10a703eb',
    pack: {
      path: 'data/packs/models_unit_textures.pak',
      storedName: 'DATA\\MODELS_UNIT\\TEXTURES\\UNIT_ROMAN_TRIARII_BRUTII.TGA.DDS',
      ordinalZeroBased: 779,
      offset: 88700774,
      bytes: 87536,
    },
  },
  'romans_julii:roman_velite': {
    assetName: 'battleRomanVeliteJuliiTexture',
    path: 'data/models_unit/textures/unit_roman_peasant_julii.tga.dds',
    declaredPath: 'data/models_unit/textures/unit_roman_peasant_julii.tga',
    declarationLine: 3141,
    bytes: 87536,
    sha256: '3c54288839e4acedfea5a1c626a79764e44a3ded6caca63dbd18244c117734cc',
    pack: {
      path: 'data/packs/models_unit_textures.pak',
      storedName: 'DATA\\MODELS_UNIT\\TEXTURES\\UNIT_ROMAN_PEASANT_JULII.TGA.DDS',
      ordinalZeroBased: 732,
      offset: 84586582,
      bytes: 87536,
    },
  },
  'romans_brutii:roman_velite': {
    assetName: 'battleRomanVeliteBrutiiTexture',
    path: 'data/models_unit/textures/unit_roman_peasant_brutii.tga.dds',
    declaredPath: 'data/models_unit/textures/unit_roman_peasant_brutii.tga',
    declarationLine: 3142,
    bytes: 87536,
    sha256: 'cff3a91432e1334f52f5315b7444bd10ceb15925596a534506021aa740b83bac',
    pack: {
      path: 'data/packs/models_unit_textures.pak',
      storedName: 'DATA\\MODELS_UNIT\\TEXTURES\\UNIT_ROMAN_PEASANT_BRUTII.TGA.DDS',
      ordinalZeroBased: 730,
      offset: 84411510,
      bytes: 87536,
    },
  },
};
const catalog = {};
for (const sourceFaction of ['romans_julii', 'romans_brutii']) {
  for (const modelType of ['roman_archer', 'roman_triarii', 'roman_velite'])
    catalog[`${sourceFaction}:${modelType}`] = {
      status: 'available',
      modelType,
      sourceFaction,
      role: 'unit',
      cas: models[modelType],
      texture: textures[`${sourceFaction}:${modelType}`],
    };
  catalog[`${sourceFaction}:roman_medium_cavalry`] = {
    status: 'unavailable',
    modelType: 'roman_medium_cavalry',
    sourceFaction,
    reason:
      'Native relative rider/horse composition is unproved; mounted consumer remains unsupported',
    declaredPath: 'data/models_unit/roman_auxillia_infantry_lowest.cas',
    sourceBytes: 29560,
    sourceSha256: '1cdbb31d9e9b4196e57dc6b4e2f62b6b997bf46909746e43a3c76fd2ea8244a9',
    declarationLine: 2911,
  };
}
export const battleAssetSources = deepFreeze(catalog);
export const battleAssetInputs = deepFreeze([
  ...new Map(
    Object.values(catalog)
      .filter((v) => v.status === 'available')
      .flatMap((v) => [v.cas, v.texture])
      .map((v) => [v.assetName, v])
  ).values(),
]);
export const battleAssetPolicy = Object.freeze({
  id: 'openrtw-source-bound-battle-assets-v1',
  geometry: 'existing-static-parent-translation-candidate;centered-uniform-2.1-normalization',
  uv: 'unchanged-source-uv',
  texture: 'exact-source-faction-DXT5;strict-envelope-only',
  binding:
    'literal-DMB-faction-tga-to-packaged-dds-presentation-candidate;native-substitution-unproved',
  color: 'texture-rgba-without-diffuse-tint',
  pose: 'no-animation-or-native-pose-binding',
  mounted: 'unavailable-until-relative-rider-horse-composition-is-supported',
  nativeMaterialEquivalent: false,
});
const uint = (n) => Number.isInteger(n) && n >= 0 && n <= 0xffffffff;
const digest = async (bytes) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (v) =>
    v.toString(16).padStart(2, '0')
  ).join('');
function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}
function checkOpen(isOpen) {
  if (!isOpen()) throw new DOMException('Battle assets loading cancelled', 'AbortError');
}
function copyText(core, pointer, limit) {
  const heap = core.HEAPU8;
  if (!(heap instanceof Uint8Array) || !uint(pointer) || !pointer || pointer >= heap.length)
    throw Error('Battle asset projection pointer is invalid');
  const bytes = heap.slice(pointer, Math.min(heap.length, pointer + limit + 1)),
    end = bytes.indexOf(0);
  if (end < 0 || end > limit) throw Error('Battle asset projection exceeds its bound');
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end));
}
function publication(core, source, kind, loader, limit) {
  const pointer = core._malloc(source.length);
  if (!uint(pointer) || !pointer) throw Error('Battle asset input allocation failed');
  let failure;
  try {
    const heap = core.HEAPU8;
    if (!(heap instanceof Uint8Array) || pointer > heap.length - source.length)
      throw Error('Battle asset input span is invalid');
    heap.set(source, pointer);
    if (core[loader](pointer, source.length) !== 1)
      throw Error(
        copyText(core, core._openrtw_error(), 4096) ||
          'Battle asset strict source admission refused'
      );
  } catch (error) {
    failure = error;
  }
  try {
    core._free(pointer);
  } catch (cleanup) {
    if (failure)
      throw new AggregateError(
        [failure, cleanup],
        'Battle asset admission and input cleanup failed'
      );
    throw cleanup;
  }
  if (failure) throw failure;
  const start = core[`_openrtw_${kind}_source_bytes`](),
    size = core[`_openrtw_${kind}_source_size`](),
    heap = core.HEAPU8;
  if (
    !(heap instanceof Uint8Array) ||
    !uint(start) ||
    !start ||
    size !== source.length ||
    start > heap.length - size
  )
    throw Error('Battle asset source publication span is invalid');
  const owned = heap.slice(start, start + size);
  if (owned.some((byte, i) => byte !== source[i]))
    throw Error('Battle asset source publication differs');
  const json = copyText(core, core[`_openrtw_${kind}_json`](), limit);
  return { source: owned, value: JSON.parse(json) };
}
function rawRange(range, bytes, length) {
  if (
    !range ||
    !uint(range.start) ||
    !uint(range.endExclusive) ||
    range.start > range.endExclusive ||
    range.endExclusive > bytes.length ||
    range.endExclusive - range.start !== length
  )
    throw Error('Battle CAS raw source range differs');
}
function rawWords(view, bytes, range, words, width = 4) {
  if (!Array.isArray(words)) throw Error('Battle CAS raw source words are missing');
  rawRange(range, bytes, words.length * width);
  for (let i = 0; i < words.length; i++)
    if (
      !uint(words[i]) ||
      words[i] !== view[width === 4 ? 'getUint32' : 'getUint16'](range.start + i * width, true)
    )
      throw Error('Battle CAS raw words differ from source');
}
function rawBytes(bytes, range, values, prefixed = false) {
  if (!Array.isArray(values)) throw Error('Battle CAS opaque bytes are missing');
  rawRange(range, bytes, values.length + (prefixed ? 4 : 0));
  const start = range.start + (prefixed ? 4 : 0);
  if (
    prefixed &&
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(range.start, true) !==
      values.length
  )
    throw Error('Battle CAS opaque source length differs');
  for (let i = 0; i < values.length; i++)
    if (!uint(values[i]) || values[i] > 255 || values[i] !== bytes[start + i])
      throw Error('Battle CAS opaque source bytes differ');
}
function validateModel(value, bytes, spec) {
  const profile = spec.admissionProfile;
  if (
    value?.schema !== 'openrtw-cas-static-candidate-v1' ||
    (profile ? value.admissionProfile !== profile : value.admissionProfile !== undefined) ||
    value.sourceBytes !== spec.bytes ||
    value.versionBits !== spec.versionBits ||
    value.headerLength !== 38 ||
    value.totalVertices !== spec.vertices ||
    value.totalTriangles !== spec.triangles ||
    value.bones?.length !== spec.bones ||
    value.meshes?.length !== spec.parts ||
    value.material?.textureName !== spec.textureName
  )
    throw Error('Battle model differs from the declared retained source');
  const geometry = profile ? assembleCasProfileGeometry(value) : assembleCasGeometry(value),
    view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== spec.versionBits)
    throw Error('Battle CAS source version differs');
  rawRange(value.bindRange, bytes, value.bones.length * 12);
  rawRange(value.parentsRange, bytes, value.bones.length * 4);
  for (const [index, bone] of value.bones.entries()) {
    rawWords(
      view,
      bytes,
      {
        start: value.bindRange.start + index * 12,
        endExclusive: value.bindRange.start + (index + 1) * 12,
      },
      bone.bindLocalBits
    );
    if (bone.parent !== view.getUint32(value.parentsRange.start + index * 4, true))
      throw Error('Battle CAS source parent differs');
    if (profile) rawBytes(bytes, bone.extra316Range, bone.extra316Bytes, true);
  }
  for (const mesh of value.meshes) {
    for (const [rangeName, wordName, width] of [
      ['positionRange', 'positionBits', 4],
      ['normalRange', 'normalBits', 4],
      ['uvRange', 'uvBits', 4],
      ['indexRange', 'indices', 2],
    ])
      rawWords(view, bytes, mesh[rangeName], mesh[wordName], width);
    if (mesh.chunkKind === 2) rawWords(view, bytes, mesh.assignmentRange, mesh.boneIndices);
    else {
      // In the admitted3.05 record the attached-bone DWORD precedes seven
      // metadata words, two U16 counts and the UV/color bytes (38 bytes total).
      const start = mesh.assignmentRange.start - 38;
      rawRange({ start, endExclusive: start + 4 }, bytes, 4);
      if (start < mesh.recordRange.start || view.getUint32(start, true) !== mesh.attachedBone)
        throw Error('Battle CAS rigid source bone differs');
    }
    if (mesh.vertexColorBytes) {
      rawRange(mesh.colorRange, bytes, mesh.vertexColorBytes.length);
      if (mesh.vertexColorBytes.some((v, i) => v !== bytes[mesh.colorRange.start + i]))
        throw Error('Battle CAS source colors differ');
    }
    if (profile) {
      rawBytes(bytes, mesh.extra1Range, mesh.extra1, true);
      if (mesh.chunkKind === 1) rawBytes(bytes, mesh.extra2Range, mesh.extra2, true);
      else rawRange(mesh.extra2Range, bytes, 0);
    }
  }
  rawRange(value.material.nameRange, bytes, spec.textureName.length + 1);
  if (
    [...spec.textureName].some(
      (v, i) => v.charCodeAt(0) !== bytes[value.material.nameRange.start + i]
    ) ||
    bytes[value.material.nameRange.endExclusive - 1] !== 0
  )
    throw Error('Battle CAS material source name differs');
  if (profile) {
    rawWords(
      view,
      bytes,
      {
        start: value.material.nameRange.endExclusive,
        endExclusive: value.material.nameRange.endExclusive + 28,
      },
      value.material.rawBits
    );
    rawBytes(bytes, value.material.opaqueTailRange, value.material.opaqueTailBytes);
    rawWords(view, bytes, value.terminalKind7Range, value.terminalKind7Words);
    if (
      value.terminalKind7Range.start !== 30020 ||
      value.terminalKind7Range.endExclusive !== 30032 ||
      value.terminalKind7Words.some((v, i) => v !== [12, 7, 0][i])
    )
      throw Error('Battle CAS selected terminal suffix differs');
  }
  // Geometry owns its buffers; the renderer takes its own checked snapshot.
  return Object.freeze(geometry);
}
function validateTexture(value, bytes) {
  const range = (v, start, end) => v?.start === start && v.endExclusive === end,
    view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    value?.schema !== 'openrtw-dds-texture-v1' ||
    value.envelopeProfile !== undefined ||
    value.sourceBytes !== 87536 ||
    value.width !== 256 ||
    value.height !== 256 ||
    value.format !== 'DXT5' ||
    value.blockBytes !== 16 ||
    value.headerFlags !== 0xa1007 ||
    value.pixelFormatFlags !== 4 ||
    value.caps !== 0x401008 ||
    value.pitchOrLinearSize !== 65536 ||
    value.declaredMipMapCount !== 9 ||
    !range(value.headerRange, 0, 128) ||
    !range(value.payloadRange, 128, 87536) ||
    !Array.isArray(value.mips) ||
    value.mips.length !== 9
  )
    throw Error('Battle texture differs from the strict retained DDS envelope');
  const header = [
    0x20534444,
    124,
    0xa1007,
    256,
    256,
    65536,
    0,
    9,
    ...Array(11).fill(0),
    32,
    4,
    TextureFormat.DXT5,
    ...Array(5).fill(0),
    0x401008,
    0,
    0,
    0,
    0,
  ];
  if (header.some((word, i) => view.getUint32(i * 4, true) !== word))
    throw Error('Battle DDS source header differs');
  let start = 128;
  for (const [level, mip] of value.mips.entries()) {
    const edge = Math.max(1, 256 >> level),
      blocks = Math.ceil(edge / 4),
      end = start + blocks * blocks * 16;
    if (
      mip.level !== level ||
      mip.width !== edge ||
      mip.height !== edge ||
      mip.blocksX !== blocks ||
      mip.blocksY !== blocks ||
      !range(mip.range, start, end) ||
      end > bytes.length
    )
      throw Error('Battle DDS source mip range differs');
    start = end;
  }
  if (start !== bytes.length) throw Error('Battle DDS source extent differs');
  return deepFreeze(value);
}
function textureDescriptor(metadata, source, spec, isOpen) {
  return Object.freeze({
    metadata,
    sourceSha256: spec.sha256,
    presentationPolicy: battleAssetPolicy,
    create(renderer) {
      checkOpen(isOpen);
      let id = 0,
        closed = false;
      const owner = Object.freeze({
        bind() {
          if (closed || !id) throw Error('Battle texture is disposed');
          checkOpen(isOpen);
          renderer.setTexture(0, id);
          renderer.setStageState(1, StageState.COLOROP, TextureOp.DISABLE);
          for (const [op, arg] of [
            [StageState.COLOROP, StageState.COLORARG1],
            [StageState.ALPHAOP, StageState.ALPHAARG1],
          ]) {
            renderer.setStageState(0, op, TextureOp.SELECTARG1);
            renderer.setStageState(0, arg, TextureArg.TEXTURE);
          }
          for (const state of [StageState.ADDRESSU, StageState.ADDRESSV])
            renderer.setStageState(0, state, Address.WRAP);
          for (const state of [StageState.MINFILTER, StageState.MAGFILTER, StageState.MIPFILTER])
            renderer.setStageState(0, state, Filter.LINEAR);
          renderer.setRenderState(RenderState.ALPHATESTENABLE, 0);
          renderer.setRenderState(RenderState.ALPHABLENDENABLE, 0);
        },
        dispose() {
          if (closed) return;
          closed = true;
          const old = id;
          id = 0;
          if (old) renderer.destroyTexture(old);
        },
      });
      try {
        id = renderer.createTexture({
          width: 256,
          height: 256,
          levels: 9,
          format: TextureFormat.DXT5,
        });
        if (!uint(id) || !id) throw Error('Battle texture handle is invalid');
        checkOpen(isOpen);
        for (const mip of metadata.mips) {
          checkOpen(isOpen);
          renderer.uploadTexture(
            id,
            mip.level,
            source.subarray(mip.range.start, mip.range.endExclusive),
            { rowPitch: 0 }
          );
          checkOpen(isOpen);
        }
      } catch (error) {
        try {
          owner.dispose();
        } catch (cleanup) {
          throw new AggregateError([error, cleanup], 'Battle texture creation and cleanup failed');
        }
        throw error;
      }
      return owner;
    },
  });
}
async function readOwned(readAsset, spec, isOpen, signal) {
  checkOpen(isOpen);
  const input = await awaitAssetRead(signal, () => readAsset(spec.assetName, { signal }), 'Battle asset read aborted');
  checkOpen(isOpen);
  if (
    !(input instanceof Uint8Array) ||
    !(input.buffer instanceof ArrayBuffer) ||
    input.length !== spec.bytes
  )
    throw Error(`Battle asset ${spec.assetName} has unexpected source length`);
  const source = new Uint8Array(input);
  if ((await awaitAssetRead(signal, () => digest(source), 'Battle asset read aborted')) !== spec.sha256)
    throw Error(`Battle asset ${spec.assetName} source hash differs`);
  checkOpen(isOpen);
  return source;
}
function unavailable(key, spec, error) {
  const split = key.indexOf(':'),
    sourceFaction = spec?.sourceFaction ?? key.slice(0, Math.max(0, split)),
    modelType = spec?.modelType ?? key.slice(split + 1);
  return Object.freeze({
    status: 'unavailable',
    modelType,
    sourceFaction,
    parts: Object.freeze([]),
    reason:
      String(error?.message ?? error).slice(0, 512) || 'The exact battle asset is unavailable',
    error,
    sourceBinding: spec ?? null,
  });
}
const posedModelTypes = new Set(['roman_archer', 'roman_triarii', 'roman_velite']);
function poseSignal(signal) {
  if (
    signal != null &&
    (typeof signal.aborted !== 'boolean' ||
      typeof signal.addEventListener !== 'function' ||
      typeof signal.removeEventListener !== 'function')
  )
    throw TypeError('Battle pose signal must be an AbortSignal');
  if (signal?.aborted)
    throw signal.reason === undefined
      ? new DOMException('Battle pose loading cancelled', 'AbortError')
      : signal.reason;
}
function capturePose(modelType, publication, options) {
  // Attach both handlers immediately, before the loader's next await. A source
  // capture may fail while DDS is pending, including with a falsey thrown value.
  try {
    return Promise.resolve(captureInfantryStandingModel(modelType, publication, options)).then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error })
    );
  } catch (error) {
    return Promise.resolve({ ok: false, error });
  }
}

// Optional explicit keys only. No arbitrary manifest, original-file I/O, HTTP,
// model substitution, implicit legacy DDS retry, or GPU allocation occurs here.
// Every C source/JSON publication is copied before the following digest await.
export async function loadBattleAssets(
  core,
  readAsset,
  { keys = [], isOpen = () => true, poseAssets = null, signal } = {}
) {
  if (
    typeof readAsset !== 'function' ||
    typeof isOpen !== 'function' ||
    !Array.isArray(keys) ||
    keys.length > 64
  )
    throw TypeError('Invalid optional battle asset request');
  const requests = [],
    count = keys.length;
  for (let i = 0; i < count; i++) {
    if (!Object.hasOwn(keys, i)) throw TypeError('Invalid optional battle asset request');
    const key = keys[i];
    if (
      typeof key !== 'string' ||
      key.length > 255 ||
      !/^[A-Za-z_][A-Za-z0-9_]{0,126}:[A-Za-z_][A-Za-z0-9_]{0,126}$/.test(key)
    )
      throw TypeError('Invalid optional battle asset request');
    requests.push(key);
  }
  const posing = poseAssets !== null;
  if (posing && (!poseAssets || typeof poseAssets.stage !== 'function'))
    throw TypeError('Invalid optional battle pose adapter');
  const owner = () => {
    poseSignal(signal);
    return isOpen();
  };
  checkOpen(owner);
  const result = Object.create(null),
    captures = posing ? new Map() : null;
  let hasFailure = false,
    failure;
  try {
    for (const key of new Set(requests)) {
      checkOpen(owner);
      const spec = Object.hasOwn(battleAssetSources, key) ? battleAssetSources[key] : null;
      if (!spec || spec.status !== 'available') {
        result[key] = unavailable(
          key,
          spec,
          new Error(spec?.reason ?? 'No exact source-bound battle model binding')
        );
        continue;
      }
      if (spec.cas.admissionProfile && typeof core?.[spec.cas.loader] !== 'function') {
        result[key] = unavailable(
          key,
          spec,
          new Error('Required explicit battle CAS profile export is unavailable')
        );
        continue;
      }
      try {
        const cas = await readOwned(readAsset, spec.cas, owner, signal);
        checkOpen(owner);
        const model = publication(
          core,
          cas,
          'cas_mesh',
          spec.cas.loader ?? '_openrtw_load_cas_mesh',
          4 * 1024 * 1024
        );
        checkOpen(owner);
        const geometry = validateModel(model.value, model.source, spec.cas);
        if (posing && posedModelTypes.has(spec.modelType) && !captures.has(spec.modelType))
          captures.set(
            spec.modelType,
            capturePose(spec.modelType, model, { signal, isOpen: owner })
          );
        checkOpen(owner);
        if ((await awaitAssetRead(signal, () => digest(model.source), 'Battle asset read aborted')) !== spec.cas.sha256)
          throw Error('Published battle CAS source hash differs');
        checkOpen(owner);
        const dds = await readOwned(readAsset, spec.texture, owner, signal);
        checkOpen(owner);
        const texture = publication(core, dds, 'dds_texture', '_openrtw_load_dds_texture', 8192),
          metadata = validateTexture(texture.value, texture.source);
        checkOpen(owner);
        if ((await awaitAssetRead(signal, () => digest(texture.source), 'Battle asset read aborted')) !== spec.texture.sha256)
          throw Error('Published battle DDS source hash differs');
        checkOpen(owner);
        const part = Object.freeze({
          role: 'unit',
          geometry,
          texture: textureDescriptor(metadata, texture.source, spec.texture, owner),
          sourceSha256: spec.cas.sha256,
          textureSourceSha256: spec.texture.sha256,
        });
        result[key] = Object.freeze({
          status: 'available',
          modelType: spec.modelType,
          sourceFaction: spec.sourceFaction,
          parts: Object.freeze([part]),
          sourceBinding: spec,
        });
      } catch (error) {
        checkOpen(owner);
        if (error?.name === 'AbortError') throw error;
        result[key] = unavailable(key, spec, error);
      }
    }
    checkOpen(owner);
  } catch (error) {
    hasFailure = true;
    failure = error;
  }
  let outcomes;
  if (posing)
    try {
      outcomes = new Map(
        await Promise.all(
          [...captures].map(async ([modelType, pending]) => [modelType, await pending])
        )
      );
    } catch (error) {
      if (!hasFailure) {
        hasFailure = true;
        failure = error;
      }
    }
  if (hasFailure) throw failure;
  const assets = Object.freeze(result);
  if (!posing) return assets;
  checkOpen(owner);
  const snapshots = Object.create(null);
  for (const entry of Object.values(assets))
    if (
      entry.status === 'available' &&
      posedModelTypes.has(entry.modelType) &&
      !Object.hasOwn(snapshots, entry.modelType)
    ) {
      const captured = outcomes.get(entry.modelType);
      if (!captured || !captured.ok)
        throw captured
          ? captured.error
          : new Error('Available infantry model lacks its owned pose snapshot');
      snapshots[entry.modelType] = captured.value;
    }
  // Captures unused after an explicit model/texture refusal are drained above;
  // that unavailable entry keeps its original asset error. Never pose fallback.
  if (!Object.keys(snapshots).length) return assets;
  const candidates = await poseAssets.stage(snapshots, { signal });
  checkOpen(owner);
  const merged = mergeInfantryStandingBattleAssets(assets, candidates);
  checkOpen(owner);
  return merged;
}
