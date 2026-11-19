import { createTextureResource, textureResourceSchema, TextureResourceError } from '/runtime/texture-resource.js';
import { assembleCasGeometry } from '/cas-geometry.js';
import {
  TextureFormat,
  RenderState,
  StageState,
  TextureOp,
  TextureArg,
  Address,
  Filter,
} from '/reference/renderer-bridge.js';

export const campaignGeneralSources = Object.freeze({
  model: Object.freeze({
    bytes: 52401,
    sha256: 'a85699cad84e0b5fa154f88efcf1d720dc10232612767f92937b4f788b1a3e0c',
  }),
  texture: Object.freeze({
    bytes: 21968,
    sha256: '3768d9273e3ba4fc8005577b38f79714207260ca3f0160858fe02454f2116a8c',
  }),
});
export const campaignGeneralPolicy = Object.freeze({
  id: 'openrtw-julii-general-static-candidate-v1',
  pose: 'source-f32-plus-parent-translation-candidate;no-animation-or-skinning',
  axes: 'unchanged-candidate-y-up',
  geometry: 'centered-uniform-2.1-normalization',
  color: 'texture-rgba-without-diffuse-tint',
  uv: 'unchanged-source-uv',
  address: 'wrap',
  min: 'linear',
  mag: 'linear',
  mip: 'linear',
  alpha: 'sampled-output-no-blend-or-test',
  binding: 'literal-julii-named-model-with-separate-dds-candidate;native-fallback-unproved',
  envelope: 'explicit-legacy-flags-v1;strict-dds-loader-unchanged',
});
const uint = (value) => Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
const digest = async (bytes) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (v) =>
    v.toString(16).padStart(2, '0')
  ).join('');
const checkOpen = (isOpen) => {
  if (!isOpen()) throw new DOMException('Campaign model loading cancelled', 'AbortError');
};
const exactRange = (range, start, end) => range?.start === start && range.endExclusive === end;

// All C API work in this function is synchronous. Both spans are copied before
// returning, so no subsequent digest await can retain a resettable heap view.
function publication(core, source, kind, load, limit) {
  const pointer = core._malloc(source.length);
  if (!uint(pointer) || !pointer) throw new Error('Campaign model input allocation failed');
  try {
    const heap = core.HEAPU8;
    if (!(heap instanceof Uint8Array) || pointer > heap.length - source.length)
      throw new Error('Campaign model input span is invalid');
    heap.set(source, pointer);
    if (core[load](pointer, source.length) !== 1)
      throw new Error(core.UTF8ToString(core._openrtw_error()));
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
    throw new Error('Campaign model source span is invalid');
  const owned = heap.slice(start, start + length);
  if (!owned.every((value, i) => value === source[i]))
    throw new Error('Campaign model source bytes differ');
  const jsonPointer = core[`_openrtw_${kind}_json`](),
    jsonHeap = core.HEAPU8;
  if (
    !(jsonHeap instanceof Uint8Array) ||
    !uint(jsonPointer) ||
    !jsonPointer ||
    jsonPointer >= jsonHeap.length
  )
    throw new Error('Campaign model projection is unavailable');
  const wire = jsonHeap.slice(jsonPointer, Math.min(jsonHeap.length, jsonPointer + limit + 1)),
    end = wire.indexOf(0);
  if (end < 0 || end > limit) throw new Error('Campaign model projection exceeds its bound');
  return {
    owned,
    value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(wire.subarray(0, end))),
  };
}

function validateTexture(metadata, bytes) {
  if (
    metadata?.schema !== 'openrtw-dds-texture-v1' ||
    metadata.envelopeProfile !== 'legacy-flags-v1' ||
    metadata.sourceBytes !== 21968 ||
    metadata.width !== 128 ||
    metadata.height !== 128 ||
    metadata.format !== 'DXT5' ||
    metadata.blockBytes !== 16 ||
    metadata.headerFlags !== 0xa1006 ||
    metadata.pixelFormatFlags !== 4 ||
    metadata.caps !== 0x1000 ||
    metadata.pitchOrLinearSize !== 16384 ||
    metadata.declaredMipMapCount !== 6 ||
    !exactRange(metadata.headerRange, 0, 128) ||
    !exactRange(metadata.payloadRange, 128, 21968) ||
    !Array.isArray(metadata.mips) ||
    metadata.mips.length !== 6
  )
    throw new Error('General DDS candidate envelope differs');
  const headerWords = [
      0x20534444,
      124,
      0xa1006,
      128,
      128,
      16384,
      0,
      6,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      32,
      4,
      TextureFormat.DXT5,
      0,
      0,
      0,
      0,
      0,
      0x1000,
      0,
      0,
      0,
      0,
    ],
    view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (headerWords.some((word, i) => view.getUint32(i * 4, true) !== word))
    throw new Error('General DDS source header differs');
  let start = 128;
  for (const [level, mip] of metadata.mips.entries()) {
    const edge = 128 >> level,
      blocks = Math.ceil(edge / 4),
      end = start + blocks * blocks * 16;
    if (
      mip.level !== level ||
      mip.width !== edge ||
      mip.height !== edge ||
      mip.blocksX !== blocks ||
      mip.blocksY !== blocks ||
      !exactRange(mip.range, start, end) ||
      end > bytes.length
    )
      throw new Error('General DDS mip extent differs');
    Object.freeze(mip.range);
    Object.freeze(mip);
    start = end;
  }
  if (start !== bytes.length) throw new Error('General DDS source extent differs');
  Object.freeze(metadata.headerRange);
  Object.freeze(metadata.payloadRange);
  Object.freeze(metadata.mips);
  return Object.freeze(metadata);
}

function textureDescriptor(metadata, owned) {
  const resource = createTextureResource({
    schema: textureResourceSchema, width: metadata.width, height: metadata.height,
    format: 'bc3-unorm', units: 'texel', origin: 'top-left',
    colorSpace: 'uninterpreted', alphaMode: 'uninterpreted',
    mips: metadata.mips.map(mip => ({ width: mip.width, height: mip.height, rowPitch: 0,
      data: owned.subarray(mip.range.start, mip.range.endExclusive) })),
    extensions: { 'rome-original.dds-texture/v1': { schema: 'rome-original.dds-texture/v1', sourceSha256: campaignGeneralSources.texture.sha256, metadata } },
  });
  return Object.freeze({
    metadata,
    resource: resource.descriptor,
    sourceSha256: campaignGeneralSources.texture.sha256,
    presentationPolicy: campaignGeneralPolicy,
    create(renderer) {
      let texture;
      try { texture = resource.create(renderer); }
      catch (error) {
        if (error instanceof TextureResourceError && error.code === 'invalid-handle')
          throw new Error('Invalid campaign general texture handle', { cause: error });
        throw error;
      }
      return Object.freeze({
        bind() {
          texture.bind(0);
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
        dispose() { texture.dispose(); },
      });
    },
  });
}

// This is a strict source-bound candidate loader, separate from the unchanged
// Hastati/strict DDS adapters. The caller owns core lifetime and cancellation.
export async function loadCampaignGeneral(core, casInput, ddsInput, { isOpen = () => true } = {}) {
  checkOpen(isOpen);
  if (
    !(casInput instanceof Uint8Array) ||
    casInput.length !== campaignGeneralSources.model.bytes ||
    !(ddsInput instanceof Uint8Array) ||
    ddsInput.length !== campaignGeneralSources.texture.bytes
  )
    throw new Error('Unexpected campaign general source length');
  const casSource = new Uint8Array(casInput),
    ddsSource = new Uint8Array(ddsInput);
  if ((await digest(casSource)) !== campaignGeneralSources.model.sha256)
    throw new Error('Campaign general CAS differs from retained source');
  checkOpen(isOpen);
  const cas = publication(core, casSource, 'cas_mesh', '_openrtw_load_cas_mesh', 4 * 1024 * 1024);
  if ((await digest(cas.owned)) !== campaignGeneralSources.model.sha256)
    throw new Error('Core campaign general CAS source hash differs');
  checkOpen(isOpen);
  const model = cas.value;
  if (
    model?.schema !== 'openrtw-cas-static-candidate-v1' ||
    model.sourceBytes !== 52401 ||
    model.versionBits !== 0x404a3d71 ||
    model.headerLength !== 38 ||
    model.totalVertices !== 587 ||
    model.totalTriangles !== 962 ||
    !Array.isArray(model.bones) ||
    model.bones.length !== 20 ||
    !Array.isArray(model.meshes) ||
    model.meshes.length !== 4 ||
    model.material?.textureName !== 'textures\\officer_roman_general_julii.tga'
  )
    throw new Error('Model differs from retained Julii general layout');
  const geometry = assembleCasGeometry(model);
  // Source-bound general fallback uses the same selected hand in its bind pose.
  const hand = model.bones[16].candidateBindWorld,
    center = geometry.bounds[0].map((v, k) => (v + geometry.bounds[1][k]) / 2),
    extent = Math.max(...geometry.bounds[0].map((v, k) => geometry.bounds[1][k] - v));
  if (!Array.isArray(hand) || hand.length !== 3 || hand.some((v) => !Number.isFinite(v)))
    throw new Error('Campaign general hand attachment is unavailable');
  geometry.bannerAttachment = Object.freeze({
    bone: 16,
    skeletonType: 4,
    point: Object.freeze(hand.map((v, k) => Math.fround(((v - center[k]) * 2.1) / extent))),
  });
  if ((await digest(ddsSource)) !== campaignGeneralSources.texture.sha256)
    throw new Error('Campaign general DDS differs from retained candidate');
  checkOpen(isOpen);
  const dds = publication(
      core,
      ddsSource,
      'dds_texture',
      '_openrtw_load_dds_texture_legacy_flags',
      8192
    ),
    metadata = validateTexture(dds.value, dds.owned);
  if ((await digest(dds.owned)) !== campaignGeneralSources.texture.sha256)
    throw new Error('Core campaign general DDS source hash differs');
  checkOpen(isOpen);
  return Object.freeze({
    geometry,
    model,
    sourceSha256: campaignGeneralSources.model.sha256,
    texture: textureDescriptor(metadata, dds.owned),
    presentationPolicy: campaignGeneralPolicy,
  });
}
