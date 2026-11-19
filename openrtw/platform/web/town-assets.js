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

// Exact selected source assets. Relative TGA-to-DDS selection and the material's
// alpha/fade behavior remain candidates, not recovered native renderer rules.
export const townSources = Object.freeze({
  model: Object.freeze({
    bytes: 25434,
    sha256: 'c7df731873dc764dc6cc98f6921f3339605f2db5ec6b4836215368afd9cb1997',
  }),
  texture: Object.freeze({
    bytes: 1520,
    sha256: 'c06b1002d731b3a3040f324dcf138545acc6bd3bf4ce3bf1c8621197313d3724',
  }),
});
export const townPresentationPolicy = Object.freeze({
  id: 'openrtw-roman-large-town-static-candidate-v1',
  axes: 'unchanged-candidate-y-up;rotation-zero',
  geometry: 'source-parent-translations;centered-uniform-2.1',
  footprint: 'uniform-max-xz-span-two-world-cells',
  anchor: 'full-visible-surface-support;no-source-cell-change',
  draw: 'primary-part-zero-only;fade-part-one-owned-and-withheld',
  uv: 'unchanged-source-uv',
  color: 'texture-rgba-without-diffuse-tint',
  alpha: 'sampled-output-no-blend-or-test',
  address: 'wrap',
  min: 'linear',
  mag: 'linear',
  mip: 'linear',
  qualification:
    'initial-source-visualization;no-native-scale-fade-alpha-ownership-or-walkability-proof',
});
const uint = (v) => Number.isInteger(v) && v >= 0 && v <= 0xffffffff;
const digest = async (bytes) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (v) =>
    v.toString(16).padStart(2, '0')
  ).join('');
const open = (isOpen) => {
  if (!isOpen()) throw new DOMException('Town loading cancelled', 'AbortError');
};
const exactRange = (r, a, b) => r?.start === a && r.endExclusive === b;
function freezeTree(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}

// The C API source and JSON are copied synchronously, before any digest await.
function publication(core, source, kind, load, jsonCap) {
  const input = core._malloc(source.length);
  if (!uint(input) || !input) throw new Error('Town input allocation failed');
  try {
    const heap = core.HEAPU8;
    if (!(heap instanceof Uint8Array) || input > heap.length - source.length)
      throw new Error('Town input span is invalid');
    heap.set(source, input);
    if (core[load](input, source.length) !== 1)
      throw new Error(core.UTF8ToString(core._openrtw_error()));
  } finally {
    core._free(input);
  }
  const pointer = core[`_openrtw_${kind}_source_bytes`](),
    length = core[`_openrtw_${kind}_source_size`](),
    heap = core.HEAPU8;
  if (
    !(heap instanceof Uint8Array) ||
    !uint(pointer) ||
    !pointer ||
    length !== source.length ||
    pointer > heap.length - length
  )
    throw new Error('Town owned source span is invalid');
  const owned = heap.slice(pointer, pointer + length);
  if (!owned.every((v, i) => v === source[i])) throw new Error('Town C API source bytes differ');
  const json = core[`_openrtw_${kind}_json`](),
    next = core.HEAPU8;
  if (!(next instanceof Uint8Array) || !uint(json) || !json || json >= next.length)
    throw new Error('Town projection is unavailable');
  const bytes = next.slice(json, Math.min(next.length, json + jsonCap + 1)),
    end = bytes.indexOf(0);
  if (end < 0 || end > jsonCap) throw new Error('Town projection exceeds its bound');
  return {
    owned,
    value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end))),
  };
}
function validateModel(model) {
  if (
    model?.schema !== 'openrtw-cas-static-candidate-v1' ||
    model.sourceBytes !== 25434 ||
    model.versionBits !== 0x4047ae14 ||
    model.headerLength !== 38 ||
    model.frameCount !== 68 ||
    model.rotationKeyCount !== 0 ||
    model.translationKeyCount !== 0 ||
    model.totalVertices !== 635 ||
    model.totalTriangles !== 306 ||
    !Array.isArray(model.bones) ||
    model.bones.length !== 1 ||
    !Array.isArray(model.meshes) ||
    model.meshes.length !== 2 ||
    model.material?.textureName !== 'textures\\set_rome_village.tga'
  )
    throw new Error('Town model differs from retained source layout');
  const expected = [
    ['roman_large_town_buildings', 499, 242],
    ['roman_large_town_buildings_fade', 136, 64],
  ];
  for (const [i, p] of model.meshes.entries())
    if (
      p.name !== expected[i][0] ||
      p.vertices !== expected[i][1] ||
      p.triangles !== expected[i][2] ||
      p.chunkKind !== 1 ||
      p.attachedBone !== 0 ||
      p.vertexColorFlag !== 1
    )
      throw new Error('Town ordered parts differ');
}
function validateTexture(metadata, bytes) {
  if (
    metadata?.schema !== 'openrtw-dds-texture-v1' ||
    Object.hasOwn(metadata, 'envelopeProfile') ||
    metadata.sourceBytes !== 1520 ||
    metadata.width !== 32 ||
    metadata.height !== 32 ||
    metadata.format !== 'DXT5' ||
    metadata.blockBytes !== 16 ||
    metadata.headerFlags !== 0xa1007 ||
    metadata.pixelFormatFlags !== 4 ||
    metadata.caps !== 0x401008 ||
    metadata.pitchOrLinearSize !== 1024 ||
    metadata.declaredMipMapCount !== 6 ||
    !exactRange(metadata.headerRange, 0, 128) ||
    !exactRange(metadata.payloadRange, 128, 1520) ||
    !Array.isArray(metadata.mips) ||
    metadata.mips.length !== 6
  )
    throw new Error('Town strict DDS envelope differs');
  const words = [
      0x20534444,
      124,
      0xa1007,
      32,
      32,
      1024,
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
      0x401008,
      0,
      0,
      0,
      0,
    ],
    view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (words.some((v, i) => view.getUint32(i * 4, true) !== v))
    throw new Error('Town DDS source header differs');
  let start = 128;
  for (const [level, mip] of metadata.mips.entries()) {
    const edge = Math.max(1, 32 >> level),
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
      throw new Error('Town DDS mip range differs');
    start = end;
  }
  if (start !== bytes.length) throw new Error('Town DDS source extent differs');
  return freezeTree(metadata);
}
function textureDescriptor(metadata, bytes, isOpen) {
  return Object.freeze({
    metadata,
    sourceSha256: townSources.texture.sha256,
    presentationPolicy: townPresentationPolicy,
    create(renderer) {
      open(isOpen);
      let id = 0,
        closed = false;
      const owner = Object.freeze({
        bind() {
          if (closed || !id) throw new Error('Town texture is disposed');
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
          width: 32,
          height: 32,
          levels: 6,
          format: TextureFormat.DXT5,
        });
        if (!uint(id) || !id) throw new Error('Invalid town texture handle');
        for (const mip of metadata.mips) {
          open(isOpen);
          renderer.uploadTexture(
            id,
            mip.level,
            bytes.subarray(mip.range.start, mip.range.endExclusive),
            { rowPitch: 0 }
          );
        }
        open(isOpen);
      } catch (error) {
        try {
          owner.dispose();
        } catch (cleanup) {
          throw new AggregateError([error, cleanup], 'Town texture creation failed');
        }
        throw error;
      }
      return owner;
    },
  });
}

export async function loadTownAssets(core, casInput, ddsInput, { isOpen = () => true } = {}) {
  open(isOpen);
  if (
    !(casInput instanceof Uint8Array) ||
    casInput.length !== townSources.model.bytes ||
    !(ddsInput instanceof Uint8Array) ||
    ddsInput.length !== townSources.texture.bytes
  )
    throw new Error('Unexpected town source length');
  const casBytes = new Uint8Array(casInput),
    ddsBytes = new Uint8Array(ddsInput);
  if ((await digest(casBytes)) !== townSources.model.sha256)
    throw new Error('Town CAS differs from retained source');
  open(isOpen);
  const cas = publication(core, casBytes, 'cas_mesh', '_openrtw_load_cas_mesh', 4 * 1024 * 1024);
  if ((await digest(cas.owned)) !== townSources.model.sha256)
    throw new Error('Town owned CAS hash differs');
  open(isOpen);
  validateModel(cas.value);
  const geometry = assembleCasGeometry(cas.value);
  if ((await digest(ddsBytes)) !== townSources.texture.sha256)
    throw new Error('Town DDS differs from retained source');
  open(isOpen);
  const dds = publication(core, ddsBytes, 'dds_texture', '_openrtw_load_dds_texture', 8192),
    metadata = validateTexture(dds.value, dds.owned);
  if ((await digest(dds.owned)) !== townSources.texture.sha256)
    throw new Error('Town owned DDS hash differs');
  open(isOpen);
  let firstIndex = 0,
    firstVertex = 0;
  const partRanges = cas.value.meshes.map((p, index) => {
    const result = Object.freeze({
      index,
      name: p.name,
      firstVertex,
      vertices: p.vertices,
      firstIndex,
      indexCount: p.triangles * 3,
      triangles: p.triangles,
      recordRange: Object.freeze({ ...p.recordRange }),
      colorRange: Object.freeze({ ...p.colorRange }),
    });
    firstIndex += p.triangles * 3;
    firstVertex += p.vertices;
    return result;
  });
  return Object.freeze({
    geometry,
    model: freezeTree(cas.value),
    texture: textureDescriptor(metadata, dds.owned, isOpen),
    sourceSha256: townSources.model.sha256,
    presentationPolicy: townPresentationPolicy,
    partRanges: Object.freeze(partRanges),
  });
}
