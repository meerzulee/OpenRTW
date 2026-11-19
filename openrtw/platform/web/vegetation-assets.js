import { assembleVegetationGeometry, vegetationAdmissionProfile } from '/vegetation-geometry.js';
import {
  TextureFormat,
  RenderState,
  StageState,
  TextureOp,
  TextureArg,
  Address,
  Filter,
  Compare,
} from '/reference/renderer-bridge.js';

// Original payloads stay in the user's folder. These identities join the
// literal summer sparse_tree olive_a.cas climate rows to one mesh/material.
export const campaignVegetationSources = Object.freeze({
  model: Object.freeze({
    name: 'campaignVegetation',
    path: 'data/terrain/aerial_map/tree_models/olive_A.CAS',
    route: '/assets/campaign-vegetation.cas',
    bytes: 2735,
    sha256: 'b0aa2808c6638bf896a0312f4f9d03b0b9aefd42f6a0d311dd829a34ee4464cc',
    versionBits: 0x4047ae14,
    material: 'textures\\olive.tga',
  }),
  texture: Object.freeze({
    name: 'campaignVegetationTexture',
    path: 'data/terrain/aerial_map/tree_models/textures/olive.tga.dds',
    route: '/assets/campaign-vegetation-texture.dds',
    bytes: 5616,
    sha256: 'cef6965ffdadc8c865628e5e6c906e7434b5b348631bf8b74c52d5144ea3953b',
    format: 'DXT5',
    width: 64,
    height: 64,
    levels: 7,
  }),
});
export const campaignVegetationPolicy = Object.freeze({
  id: 'openrtw-olive-static-candidate-v1',
  geometry: 'shared-admitted-CAS-parent-translation-and-centered-2.1-normalization',
  uv: 'unchanged-source-uv',
  binding: 'literal-climate-mesh-and-relative-material-dds-candidate',
  color: 'original-texture-without-diffuse-tint',
  alpha: 'test-greater-than-96-no-blend',
  address: 'wrap',
  min: 'linear',
  mag: 'linear',
  mip: 'linear',
  nativePlacementEquivalent: false,
  nativeMaterialEquivalent: false,
  admissionProfile: vegetationAdmissionProfile,
  formatGate:
    'Explicit repeated-count312 admission only; default reader remains strict; no fallback or byte repair.',
});
const uint = (value) => Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
const digest = async (bytes) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (v) =>
    v.toString(16).padStart(2, '0')
  ).join('');
const checkOpen = (isOpen) => {
  if (!isOpen()) throw new DOMException('Campaign vegetation loading cancelled', 'AbortError');
};
const keys = (value, names) =>
  value !== null &&
  typeof value === 'object' &&
  Object.keys(value).sort().join(',') === names.slice().sort().join(',');
const range = (value, start, end) =>
  keys(value, ['start', 'endExclusive']) && value.start === start && value.endExclusive === end;
function copyText(core, pointer, limit) {
  const heap = core.HEAPU8;
  if (!(heap instanceof Uint8Array) || !uint(pointer) || !pointer || pointer >= heap.length)
    throw new Error('Vegetation projection pointer is invalid');
  const wire = heap.slice(pointer, Math.min(heap.length, pointer + limit + 1)),
    end = wire.indexOf(0);
  if (end < 0 || end > limit) throw new Error('Vegetation projection exceeds its bound');
  return new TextDecoder('utf-8', { fatal: true }).decode(wire.subarray(0, end));
}
function publication(core, source, kind, load, limit) {
  const pointer = core._malloc(source.length);
  if (!uint(pointer) || !pointer) throw new Error('Vegetation input allocation failed');
  try {
    const heap = core.HEAPU8;
    if (!(heap instanceof Uint8Array) || pointer > heap.length - source.length)
      throw new Error('Vegetation input span is invalid');
    heap.set(source, pointer);
    // Keep the exact core refusal. No version change, legacy retry or other mesh.
    if (core[load](pointer, source.length) !== 1)
      throw new Error(copyText(core, core._openrtw_error(), 4096));
  } finally {
    core._free(pointer);
  }
  const start = core[`_openrtw_${kind}_source_bytes`](),
    length = core[`_openrtw_${kind}_source_size`](),
    heap = core.HEAPU8;
  if (
    !(heap instanceof Uint8Array) ||
    !uint(start) ||
    !start ||
    length !== source.length ||
    start > heap.length - length
  )
    throw new Error('Vegetation source span is invalid');
  const owned = heap.slice(start, start + length);
  if (!owned.every((value, i) => value === source[i]))
    throw new Error('Vegetation core source bytes differ');
  // Snapshot both publications synchronously before the next digest await.
  return { owned, value: JSON.parse(copyText(core, core[`_openrtw_${kind}_json`](), limit)) };
}
async function sourceCopy(input, spec, isOpen) {
  checkOpen(isOpen);
  if (!(input instanceof Uint8Array) || input.length !== spec.bytes)
    throw new Error('Unexpected vegetation source length');
  const source = new Uint8Array(input);
  if ((await digest(source)) !== spec.sha256)
    throw new Error('Vegetation source differs from retained identity');
  checkOpen(isOpen);
  return source;
}
function validateTexture(metadata, source) {
  const words = [
      0x20534444,
      124,
      0xa1007,
      64,
      64,
      4096,
      0,
      7,
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
    ],
    view = new DataView(source.buffer, source.byteOffset, 128);
  if (words.some((word, i) => view.getUint32(i * 4, true) !== word))
    throw new Error('Vegetation DDS source header differs');
  if (
    !keys(metadata, [
      'schema',
      'sourceBytes',
      'width',
      'height',
      'format',
      'blockBytes',
      'headerFlags',
      'pixelFormatFlags',
      'caps',
      'pitchOrLinearSize',
      'declaredMipMapCount',
      'headerRange',
      'payloadRange',
      'mips',
    ]) ||
    metadata.schema !== 'openrtw-dds-texture-v1' ||
    metadata.sourceBytes !== 5616 ||
    metadata.width !== 64 ||
    metadata.height !== 64 ||
    metadata.format !== 'DXT5' ||
    metadata.blockBytes !== 16 ||
    metadata.headerFlags !== 0xa1007 ||
    metadata.pixelFormatFlags !== 4 ||
    metadata.caps !== 0x401008 ||
    metadata.pitchOrLinearSize !== 4096 ||
    metadata.declaredMipMapCount !== 7 ||
    !range(metadata.headerRange, 0, 128) ||
    !range(metadata.payloadRange, 128, 5616) ||
    !Array.isArray(metadata.mips) ||
    metadata.mips.length !== 7
  )
    throw new Error('Vegetation DDS envelope differs');
  let start = 128;
  for (const [level, mip] of metadata.mips.entries()) {
    const edge = Math.max(1, 64 >> level),
      blocks = Math.ceil(edge / 4),
      end = start + blocks * blocks * 16;
    if (
      !keys(mip, ['level', 'width', 'height', 'blocksX', 'blocksY', 'range']) ||
      mip.level !== level ||
      mip.width !== edge ||
      mip.height !== edge ||
      mip.blocksX !== blocks ||
      mip.blocksY !== blocks ||
      !range(mip.range, start, end) ||
      end > source.length
    )
      throw new Error('Vegetation DDS mip extent differs');
    Object.freeze(mip.range);
    Object.freeze(mip);
    start = end;
  }
  if (start !== source.length) throw new Error('Vegetation DDS source extent differs');
  Object.freeze(metadata.headerRange);
  Object.freeze(metadata.payloadRange);
  Object.freeze(metadata.mips);
  return Object.freeze(metadata);
}

// Texture loading is independently usable while tree geometry admission is open.
export async function loadCampaignVegetationTexture(core, input, { isOpen = () => true } = {}) {
  if (typeof isOpen !== 'function') throw new TypeError('Vegetation isOpen must be a function');
  const spec = campaignVegetationSources.texture,
    source = await sourceCopy(input, spec, isOpen),
    dds = publication(core, source, 'dds_texture', '_openrtw_load_dds_texture', 8192),
    metadata = validateTexture(dds.value, dds.owned);
  if ((await digest(dds.owned)) !== spec.sha256)
    throw new Error('Vegetation DDS publication hash differs');
  checkOpen(isOpen);
  return Object.freeze({
    metadata,
    sourceSha256: spec.sha256,
    presentationPolicy: campaignVegetationPolicy,
    create(renderer) {
      checkOpen(isOpen);
      let id = 0,
        closed = false;
      const owner = Object.freeze({
        bind() {
          checkOpen(isOpen);
          if (closed || !id) throw new Error('Vegetation texture is disposed');
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
          renderer.setRenderState(RenderState.ALPHABLENDENABLE, 0);
          renderer.setRenderState(RenderState.ALPHATESTENABLE, 1);
          renderer.setRenderState(RenderState.ALPHAFUNC, Compare.GREATER);
          renderer.setRenderState(RenderState.ALPHAREF, 96);
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
          width: 64,
          height: 64,
          levels: 7,
          format: TextureFormat.DXT5,
        });
        if (!uint(id) || !id) throw new Error('Invalid vegetation texture handle');
        checkOpen(isOpen);
        for (const mip of metadata.mips) {
          renderer.uploadTexture(
            id,
            mip.level,
            dds.owned.subarray(mip.range.start, mip.range.endExclusive),
            { rowPitch: 0 }
          );
          checkOpen(isOpen);
        }
      } catch (error) {
        try {
          owner.dispose();
        } catch (cleanup) {
          throw new AggregateError([error, cleanup], 'Vegetation texture creation failed');
        }
        throw error;
      }
      return owner;
    },
  });
}

// Explicit source-bound admission. The default reader still refuses this tree;
// a missing opt-in export or refused profile never triggers a fallback/retry.
export async function loadCampaignVegetationAsset(
  core,
  casInput,
  ddsInput,
  { isOpen = () => true } = {}
) {
  if (typeof isOpen !== 'function') throw new TypeError('Vegetation isOpen must be a function');
  checkOpen(isOpen);
  // Both caller-owned inputs are detached before the first asynchronous digest.
  if (
    !(ddsInput instanceof Uint8Array) ||
    ddsInput.length !== campaignVegetationSources.texture.bytes
  )
    throw new Error('Unexpected vegetation source length');
  const ddsSource = new Uint8Array(ddsInput),
    spec = campaignVegetationSources.model,
    source = await sourceCopy(casInput, spec, isOpen);
  if (typeof core?._openrtw_load_cas_mesh_repeated_static_count312 !== 'function')
    throw new Error('Explicit vegetation CAS admission is unavailable');
  const cas = publication(
    core,
    source,
    'cas_mesh',
    '_openrtw_load_cas_mesh_repeated_static_count312',
    1024 * 1024
  );
  const model = cas.value;
  if (
    model?.schema !== 'openrtw-cas-static-candidate-v1' ||
    model.sourceBytes !== spec.bytes ||
    model.versionBits !== spec.versionBits ||
    model.headerLength !== 38 ||
    model.material?.textureName !== spec.material
  )
    throw new Error('Vegetation CAS projection differs');
  const geometry = assembleVegetationGeometry(model);
  if ((await digest(cas.owned)) !== spec.sha256)
    throw new Error('Vegetation CAS publication hash differs');
  checkOpen(isOpen);
  const texture = await loadCampaignVegetationTexture(core, ddsSource, { isOpen });
  checkOpen(isOpen);
  return Object.freeze({
    geometry,
    model,
    texture,
    sourceSha256: spec.sha256,
    presentationPolicy: campaignVegetationPolicy,
  });
}
