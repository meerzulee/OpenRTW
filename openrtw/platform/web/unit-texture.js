import { createTextureResource, textureResourceSchema, TextureResourceError } from '/runtime/texture-resource.js';
import {
  TextureFormat,
  RenderState,
  StageState,
  TextureOp,
  TextureArg,
  Address,
  Filter,
} from '/reference/renderer-bridge.js';

export const hastatiTextureSha256 =
  '3ee5ad251dfb9a255fa103b1c4377b6ebf2b6d59d8e2583fffa0f2ec05338e1c';
export const unitTexturePolicy = Object.freeze({
  id: 'openrtw-hastati-texture-candidate-v1',
  color: 'texture-rgba-without-diffuse-tint',
  uv: 'unchanged-source-uv',
  address: 'wrap',
  min: 'linear',
  mag: 'linear',
  mip: 'linear',
  alpha: 'sampled-output-no-blend-or-test',
  binding: 'separate-tga-dds-candidate-not-native-material-proof',
});
const sourceSize = 87536,
  uint = (v) => Number.isInteger(v) && v >= 0 && v <= 0xffffffff;
const digest = async (bytes) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (v) =>
    v.toString(16).padStart(2, '0')
  ).join('');
const checkOpen = (isOpen) => {
  if (!isOpen()) throw new DOMException('Unit texture loading cancelled', 'AbortError');
};
function range(value, start, end) {
  return value && value.start === start && value.endExclusive === end;
}
function validate(metadata, bytes) {
  const h = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    metadata?.schema !== 'openrtw-dds-texture-v1' ||
    metadata.sourceBytes !== sourceSize ||
    metadata.width !== 256 ||
    metadata.height !== 256 ||
    metadata.format !== 'DXT5' ||
    metadata.blockBytes !== 16 ||
    metadata.headerFlags !== 0xa1007 ||
    metadata.pixelFormatFlags !== 4 ||
    metadata.caps !== 0x401008 ||
    metadata.pitchOrLinearSize !== 65536 ||
    metadata.declaredMipMapCount !== 9 ||
    h.getUint32(0, true) !== 0x20534444 ||
    h.getUint32(8, true) !== metadata.headerFlags ||
    h.getUint32(12, true) !== metadata.height ||
    h.getUint32(16, true) !== metadata.width ||
    h.getUint32(20, true) !== metadata.pitchOrLinearSize ||
    h.getUint32(28, true) !== metadata.declaredMipMapCount ||
    h.getUint32(80, true) !== metadata.pixelFormatFlags ||
    h.getUint32(84, true) !== TextureFormat.DXT5 ||
    h.getUint32(108, true) !== metadata.caps ||
    !range(metadata.headerRange, 0, 128) ||
    !range(metadata.payloadRange, 128, sourceSize) ||
    !Array.isArray(metadata.mips) ||
    metadata.mips.length !== 9
  )
    throw new Error('Core DDS candidate envelope differs');
  let start = 128;
  for (const [level, mip] of metadata.mips.entries()) {
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
      throw new Error('Core DDS mip extent differs');
    Object.freeze(mip.range);
    Object.freeze(mip);
    start = end;
  }
  if (start !== sourceSize) throw new Error('Core DDS payload does not end at the source extent');
  Object.freeze(metadata.headerRange);
  Object.freeze(metadata.payloadRange);
  Object.freeze(metadata.mips);
  return Object.freeze(metadata);
}

// Only this loader touches the C++ DDS API. Copy every span and bounded JSON
// before awaiting again: closing/resetting the owner never leaves a heap view.
export async function loadUnitTexture(core, input, { isOpen = () => true } = {}) {
  checkOpen(isOpen);
  if (!(input instanceof Uint8Array) || input.length !== sourceSize)
    throw new Error('Unexpected Hastati DDS source length');
  const source = new Uint8Array(input);
  if ((await digest(source)) !== hastatiTextureSha256)
    throw new Error('Hastati DDS differs from the retained candidate');
  checkOpen(isOpen);
  const pointer = core._malloc(source.length);
  if (!pointer) throw new Error('DDS input allocation failed');
  try {
    core.HEAPU8.set(source, pointer);
    if (core._openrtw_load_dds_texture(pointer, source.length) !== 1)
      throw new Error(core.UTF8ToString(core._openrtw_error()));
  } finally {
    core._free(pointer);
  }
  checkOpen(isOpen);
  const sourcePointer = core._openrtw_dds_texture_source_bytes(),
    length = core._openrtw_dds_texture_source_size(),
    heap = core.HEAPU8;
  if (
    !uint(sourcePointer) ||
    !sourcePointer ||
    length !== sourceSize ||
    sourcePointer > heap.length - length
  )
    throw new Error('Core DDS source span is invalid');
  const owned = heap.slice(sourcePointer, sourcePointer + length);
  if (!owned.every((value, i) => value === source[i]))
    throw new Error('Core DDS source bytes differ');
  const jsonPointer = core._openrtw_dds_texture_json(),
    limit = 8192;
  if (!uint(jsonPointer) || !jsonPointer || jsonPointer >= heap.length)
    throw new Error('Core DDS metadata is unavailable');
  const wire = heap.slice(jsonPointer, Math.min(heap.length, jsonPointer + limit + 1)),
    end = wire.indexOf(0);
  if (end < 0 || end > limit) throw new Error('Core DDS metadata exceeds its bound');
  const metadata = validate(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(wire.subarray(0, end))),
    owned
  );
  if ((await digest(owned)) !== hastatiTextureSha256)
    throw new Error('Core DDS source hash differs');
  checkOpen(isOpen);
  const resource = createTextureResource({
    schema: textureResourceSchema, width: metadata.width, height: metadata.height,
    format: 'bc3-unorm', units: 'texel', origin: 'top-left',
    colorSpace: 'uninterpreted', alphaMode: 'uninterpreted',
    mips: metadata.mips.map(mip => ({ width: mip.width, height: mip.height, rowPitch: 0,
      data: owned.subarray(mip.range.start, mip.range.endExclusive) })),
    extensions: { 'rome-original.dds-texture/v1': { schema: 'rome-original.dds-texture/v1', sourceSha256: hastatiTextureSha256, metadata } },
  });
  return Object.freeze({
    metadata,
    resource: resource.descriptor,
    sourceSha256: hastatiTextureSha256,
    presentationPolicy: unitTexturePolicy,
    create(renderer) {
      let texture;
      try { texture = resource.create(renderer); }
      catch (error) {
        if (error instanceof TextureResourceError && error.code === 'invalid-handle')
          throw new Error('Invalid unit texture handle', { cause: error });
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

// TGA decoding/origin handling belongs to texture-image.js. This adapter owns
// its normalized texels and context texture; sampling/lighting are new policy.
export function createTerrainTexture(image, { sourceSha256, label }) {
  const { width, height, rgba } = image ?? {};
  if (
    !uint(width) ||
    !width ||
    width > 4096 ||
    width & (width - 1) ||
    !uint(height) ||
    !height ||
    height > 4096 ||
    height & (height - 1) ||
    !(rgba instanceof Uint8Array) ||
    rgba.length !== width * height * 4 ||
    rgba.length > 16 * 1024 * 1024 ||
    !/^[0-9a-f]{64}$/.test(sourceSha256) ||
    !['grass', 'hills'].includes(label)
  )
    throw new Error('Invalid terrain texture descriptor');
  const maxOwnedBytes = 32 * 1024 * 1024,
    mips = [];
  let retainedBytes = 0,
    w = width,
    h = height;
  // Every level is owned. Only the original base texels come from the file;
  // these generated box levels are OpenRTW presentation policy.
  const retain = (pixels, mipWidth, mipHeight) => {
    if (pixels.length > maxOwnedBytes - retainedBytes)
      throw new Error('Terrain mip ownership exceeds its byte bound');
    retainedBytes += pixels.length;
    mips.push({ width: mipWidth, height: mipHeight, pixels });
  };
  retain(rgba.slice(), w, h);
  while (w > 1 || h > 1) {
    const previous = mips.at(-1),
      nextWidth = Math.max(1, w >> 1),
      nextHeight = Math.max(1, h >> 1),
      bytes = nextWidth * nextHeight * 4;
    if (bytes > maxOwnedBytes - retainedBytes)
      throw new Error('Terrain mip ownership exceeds its byte bound');
    const pixels = new Uint8Array(bytes);
    for (let y = 0; y < nextHeight; y++)
      for (let x = 0; x < nextWidth; x++) {
        const x0 = x * 2,
          x1 = Math.min(x0 + 1, w - 1),
          y0 = y * 2,
          y1 = Math.min(y0 + 1, h - 1);
        const a = (y0 * w + x0) * 4,
          b = (y0 * w + x1) * 4,
          c = (y1 * w + x0) * 4,
          d = (y1 * w + x1) * 4,
          out = (y * nextWidth + x) * 4;
        for (let channel = 0; channel < 4; channel++)
          pixels[out + channel] =
            (previous.pixels[a + channel] +
              previous.pixels[b + channel] +
              previous.pixels[c + channel] +
              previous.pixels[d + channel] +
              2) >>
            2;
      }
    retain(pixels, nextWidth, nextHeight);
    w = nextWidth;
    h = nextHeight;
  }
  const metadata = Object.freeze({
    label,
    width,
    height,
    format: 'RGBA8',
    levels: mips.length,
    mips: Object.freeze(
      mips.map((m, level) =>
        Object.freeze({ level, width: m.width, height: m.height, bytes: m.pixels.length })
      )
    ),
    header: Object.freeze({ ...image.header }),
    sourceFacts: Object.freeze({ ...image.sourceFacts }),
  });
  const presentationPolicy = Object.freeze({
    id: 'openrtw-terrain-texture-presentation-v2',
    uv: 'world-x-z-divided-by4',
    origin: 'decoded-top-left-no-extra-flip',
    selection: 'land-triangle-mean-height>=0;hills-height-span>=0.35',
    color: 'original-texels-times-grayscale-height-normal-light',
    address: 'wrap',
    min: 'linear',
    mag: 'linear',
    mip: 'linear',
    generatedMipmaps: 'rgba8-box2x2-round-half-up-clamped-edge',
    alpha: 'opaque-no-blend-or-test',
  });
  return Object.freeze({
    metadata,
    sourceSha256,
    presentationPolicy,
    create(renderer) {
      let id = 0,
        closed = false;
      const owner = Object.freeze({
        bind() {
          if (closed || !id) throw new Error('Terrain texture is disposed');
          renderer.setTexture(0, id);
          renderer.setStageState(0, StageState.COLOROP, TextureOp.MODULATE);
          renderer.setStageState(0, StageState.COLORARG1, TextureArg.TEXTURE);
          renderer.setStageState(0, StageState.COLORARG2, TextureArg.DIFFUSE);
          renderer.setStageState(0, StageState.ALPHAOP, TextureOp.SELECTARG1);
          renderer.setStageState(0, StageState.ALPHAARG1, TextureArg.TEXTURE);
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
          width,
          height,
          levels: mips.length,
          format: TextureFormat.RGBA8,
        });
        if (!uint(id) || !id) throw new Error('Invalid terrain texture handle');
        for (const [level, mip] of mips.entries())
          renderer.uploadTexture(id, level, mip.pixels, { rowPitch: mip.width * 4 });
      } catch (error) {
        try {
          owner.dispose();
        } catch (cleanup) {
          throw new AggregateError([error, cleanup], 'Terrain texture creation failed');
        }
        throw error;
      }
      return owner;
    },
  });
}
