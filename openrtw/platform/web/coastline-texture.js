import {
  TextureFormat,
  RenderState,
  StageState,
  TextureOp,
  TextureArg,
  Address,
  Filter,
  Blend,
} from '/reference/renderer-bridge.js';

export const coastlineTextureSha256 =
  'cd0af4fa1d903df2c40ca058deeaeae4c9b356bee0bc558936d072095d72ed47';
export const coastlineTexturePolicy = Object.freeze({
  id: 'openrtw-native-coastline-beach-texture-v1',
  path: 'data/terrain/aerial_map/sea/beach_strip.tga.dds',
  binding: '9C2D54/9C2F0C-static-beach-pass0;animated-surf-not-implemented',
  uv: 'linked-coast-distance-u;v0-to0.95',
  address: 'wrap',
  min: 'linear',
  mag: 'linear',
  mip: 'linear-RGB-bias+2;level0-alpha-browser-static-pass-policy',
  colorSampling: 'web-quality-policy:two-extra-source-RGB-mip-levels;source-bytes-unchanged',
  alpha: 'texture-times-diffuse;srcalpha-invsrcalpha',
  lighting: 'white-diffuse;native-ambient-light-scaling-not-reproduced',
  nativeMaterialEquivalent: false,
});
const sourceSize = 22032,
  uint = (v) => Number.isInteger(v) && v >= 0 && v <= 0xffffffff;
const digest = async (bytes) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (v) =>
    v.toString(16).padStart(2, '0')
  ).join('');
const checkOpen = (isOpen) => {
  if (!isOpen()) throw new DOMException('Coastline texture loading cancelled', 'AbortError');
};
const keys = (value, names) =>
  value !== null &&
  typeof value === 'object' &&
  Object.keys(value).sort().join(',') === names.slice().sort().join(',');
const range = (value, start, end) =>
  keys(value, ['start', 'endExclusive']) && value.start === start && value.endExclusive === end;
function copyText(core, pointer, limit) {
  const heap = core.HEAPU8;
  if (!uint(pointer) || !pointer || pointer >= heap.length)
    throw new Error('Coastline DDS text pointer is invalid');
  const bytes = heap.slice(pointer, Math.min(heap.length, pointer + limit + 1)),
    end = bytes.indexOf(0);
  if (end < 0 || end > limit) throw new Error('Coastline DDS text exceeds its bound');
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end));
}
function validate(metadata, bytes) {
  const words = [
      0x20534444,
      124,
      0xa1007,
      64,
      256,
      16384,
      0,
      9,
      ...Array(11).fill(0),
      32,
      4,
      0x35545844,
      ...Array(5).fill(0),
      0x401008,
      0,
      0,
      0,
      0,
    ],
    header = new DataView(bytes.buffer, bytes.byteOffset, 128);
  if (words.some((word, i) => header.getUint32(i * 4, true) !== word))
    throw new Error('Coastline DDS header differs');
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
    metadata.sourceBytes !== sourceSize ||
    metadata.width !== 256 ||
    metadata.height !== 64 ||
    metadata.format !== 'DXT5' ||
    metadata.blockBytes !== 16 ||
    metadata.headerFlags !== 0xa1007 ||
    metadata.pixelFormatFlags !== 4 ||
    metadata.caps !== 0x401008 ||
    metadata.pitchOrLinearSize !== 16384 ||
    metadata.declaredMipMapCount !== 9 ||
    !range(metadata.headerRange, 0, 128) ||
    !range(metadata.payloadRange, 128, sourceSize) ||
    !Array.isArray(metadata.mips) ||
    metadata.mips.length !== 9
  )
    throw new Error('Core coastline DDS envelope differs');
  let start = 128;
  for (const [level, mip] of metadata.mips.entries()) {
    const width = Math.max(1, 256 >> level),
      height = Math.max(1, 64 >> level),
      blocksX = Math.ceil(width / 4),
      blocksY = Math.ceil(height / 4),
      end = start + blocksX * blocksY * 16;
    if (
      !keys(mip, ['level', 'width', 'height', 'blocksX', 'blocksY', 'range']) ||
      mip.level !== level ||
      mip.width !== width ||
      mip.height !== height ||
      mip.blocksX !== blocksX ||
      mip.blocksY !== blocksY ||
      !range(mip.range, start, end) ||
      end > bytes.length
    )
      throw new Error('Core coastline DDS mip differs');
    Object.freeze(mip.range);
    Object.freeze(mip);
    start = end;
  }
  if (start !== bytes.length) throw new Error('Coastline DDS extent differs');
  Object.freeze(metadata.headerRange);
  Object.freeze(metadata.payloadRange);
  Object.freeze(metadata.mips);
  return Object.freeze(metadata);
}

// Strict retained beach descriptor. Core DDS admission remains authoritative;
// this owner checks exact source publication and owns all nine compressed mips.
// Source, published bytes and bounded JSON are copied before another await.
export async function loadCoastlineTexture(
  core,
  input,
  { isOpen = () => true, lighting = null, samplingProfile = 'independent-alpha' } = {}
) {
  if (typeof isOpen !== 'function') throw new TypeError('Coastline isOpen must be a function');
  if (samplingProfile !== 'independent-alpha' && samplingProfile !== 'source-mips')
    throw new TypeError('Invalid coastline sampling profile');
  if (
    lighting !== null &&
    (!Array.isArray(lighting.rgb) ||
      lighting.rgb.length !== 3 ||
      lighting.rgb.some((v) => !Number.isInteger(v) || v < 0 || v > 255) ||
      lighting.metadata?.schema !== 'openrtw-coastline-fixed-function-lighting-v1')
  )
    throw new TypeError('Invalid coastline texture lighting');
  const colorOp = lighting ? TextureOp.MODULATE2X : TextureOp.MODULATE;
  const presentationPolicy = Object.freeze({
    ...coastlineTexturePolicy,
    mip: samplingProfile === 'source-mips' ? 'linear-native-sampler' : coastlineTexturePolicy.mip,
    samplingProfile,
    samplingQualification:
      samplingProfile === 'source-mips'
        ? 'native-F46240/F57B90-LINEAR-min-mag-mip;native-upload-chain-unproved'
        : 'web-static-pass-policy:implicit-LOD-RGB-and-level0-alpha;source-mips-fallback-if-renderer-extension-unavailable',
    lighting: lighting?.metadata ?? coastlineTexturePolicy.lighting,
    colorOperation: lighting ? 'MODULATE2X' : 'MODULATE-unlit-fallback',
    alphaTest: 'native-beach-reference0;GREATER0-equivalent-to-NOTEQUAL0',
  });
  checkOpen(isOpen);
  if (
    !(input instanceof Uint8Array) ||
    !(input.buffer instanceof ArrayBuffer) ||
    input.length !== sourceSize
  )
    throw new Error('Unexpected coastline DDS source length');
  const source = new Uint8Array(input);
  if ((await digest(source)) !== coastlineTextureSha256)
    throw new Error('Coastline DDS differs from the retained candidate');
  checkOpen(isOpen);
  const pointer = core._malloc(source.length);
  if (!uint(pointer) || !pointer) throw new Error('Coastline DDS input allocation failed');
  try {
    if (pointer > core.HEAPU8.length - source.length)
      throw new Error('Coastline DDS input span is invalid');
    core.HEAPU8.set(source, pointer);
    if (core._openrtw_load_dds_texture(pointer, source.length) !== 1)
      throw new Error(copyText(core, core._openrtw_error(), 1024));
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
    throw new Error('Core coastline DDS source span is invalid');
  const owned = heap.slice(sourcePointer, sourcePointer + length);
  if (!owned.every((value, i) => value === source[i]))
    throw new Error('Core coastline DDS source bytes differ');
  const metadata = validate(
    JSON.parse(copyText(core, core._openrtw_dds_texture_json(), 8192)),
    owned
  );
  if ((await digest(owned)) !== coastlineTextureSha256)
    throw new Error('Published coastline DDS hash differs');
  checkOpen(isOpen);
  return Object.freeze({
    metadata,
    sourceSha256: coastlineTextureSha256,
    presentationPolicy,
    create(renderer) {
      checkOpen(isOpen);
      const alphaLodAvailable = typeof renderer.setTextureAlphaLod0 === 'function',
        independentAlpha = samplingProfile === 'independent-alpha' && alphaLodAvailable,
        colorLodBiasAvailable = typeof renderer.setTextureColorLodBias === 'function',
        colorLodBias = independentAlpha && colorLodBiasAvailable ? 2 : 0,
        actualPolicy = Object.freeze({
          ...presentationPolicy,
          requestedSamplingProfile: samplingProfile,
          samplingProfile: independentAlpha ? 'independent-alpha' : 'source-mips',
          mip: independentAlpha
            ? colorLodBias
              ? coastlineTexturePolicy.mip
              : 'linear-RGB;level0-alpha-browser-static-pass-policy'
            : 'linear-native-sampler',
          alphaLod0Available: alphaLodAvailable,
          alphaLod0Enabled: independentAlpha,
          colorLodBiasAvailable,
          colorLodBias,
          colorSampling:
            colorLodBias !== 0
              ? coastlineTexturePolicy.colorSampling
              : 'ordinary-implicit-RGB-LOD;no-color-bias',
          fallback:
            samplingProfile === 'independent-alpha' && !alphaLodAvailable
              ? 'renderer-alphaLOD0-unavailable;ordinary-source-mips'
              : null,
        });
      let id = 0,
        closed = false,
        alphaBound = false,
        colorBound = false;
      function resetSampling() {
        const failures = [];
        if (colorBound) {
          try {
            renderer.setTextureColorLodBias(0, 0);
            colorBound = false;
          } catch (error) {
            failures.push(error);
          }
        }
        if (alphaBound) {
          try {
            renderer.setTextureAlphaLod0(0, false);
            alphaBound = false;
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length) throw new AggregateError(failures, 'Coastline sampling reset failed');
      }
      const owner = Object.freeze({
        presentationPolicy: actualPolicy,
        bind() {
          if (closed || !id) throw new Error('Coastline texture is disposed');
          checkOpen(isOpen);
          // Mark before calling so a later bind failure can still be cleaned.
          if (alphaLodAvailable) {
            alphaBound = independentAlpha;
            renderer.setTextureAlphaLod0(0, independentAlpha);
          }
          if (colorLodBiasAvailable) {
            colorBound = colorLodBias !== 0;
            renderer.setTextureColorLodBias(0, colorLodBias);
          }
          renderer.setTexture(0, id);
          renderer.setStageState(1, StageState.COLOROP, TextureOp.DISABLE);
          renderer.setStageState(0, StageState.COLOROP, colorOp);
          renderer.setStageState(0, StageState.COLORARG1, TextureArg.TEXTURE);
          renderer.setStageState(0, StageState.COLORARG2, TextureArg.DIFFUSE);
          renderer.setStageState(0, StageState.ALPHAOP, TextureOp.MODULATE);
          renderer.setStageState(0, StageState.ALPHAARG1, TextureArg.TEXTURE);
          renderer.setStageState(0, StageState.ALPHAARG2, TextureArg.DIFFUSE);
          renderer.setStageState(0, StageState.TEXCOORDINDEX, 0);
          renderer.setStageState(0, StageState.TEXTURETRANSFORMFLAGS, 0);
          for (const state of [StageState.ADDRESSU, StageState.ADDRESSV])
            renderer.setStageState(0, state, Address.WRAP);
          for (const state of [StageState.MINFILTER, StageState.MAGFILTER])
            renderer.setStageState(0, state, Filter.LINEAR);
          // Keep RGB minification: top-mip-only RGB aliases the source ripples.
          // The opt-in renderer flag separately reads source alpha at level0.
          renderer.setStageState(0, StageState.MIPFILTER, Filter.LINEAR);
          // 9C6756 gives the beach pass alpha reference0; F461E0 uploads it.
          // F443D0 chooses GREATER or NOTEQUAL, equivalent for alpha>=0/ref0.
          renderer.setRenderState(RenderState.ALPHATESTENABLE, 1);
          renderer.setRenderState(RenderState.ALPHAREF, 0);
          renderer.setRenderState(RenderState.ALPHAFUNC, 5);
          renderer.setRenderState(RenderState.ALPHABLENDENABLE, 1);
          renderer.setRenderState(RenderState.SRCBLEND, Blend.SRCALPHA);
          renderer.setRenderState(RenderState.DESTBLEND, Blend.INVSRCALPHA);
        },
        unbind: resetSampling,
        dispose() {
          if (closed) return;
          closed = true;
          const old = id;
          id = 0;
          const failures = [];
          try {
            resetSampling();
          } catch (error) {
            failures.push(error);
          }
          try {
            if (old) renderer.destroyTexture(old);
          } catch (error) {
            failures.push(error);
          }
          if (failures.length)
            throw new AggregateError(failures, 'Coastline texture disposal failed');
        },
      });
      try {
        id = renderer.createTexture({
          width: 256,
          height: 64,
          levels: 9,
          format: TextureFormat.DXT5,
        });
        if (!uint(id) || !id) {
          id = 0;
          throw new Error('Invalid coastline texture handle');
        }
        checkOpen(isOpen);
        for (const mip of metadata.mips) {
          renderer.uploadTexture(
            id,
            mip.level,
            owned.subarray(mip.range.start, mip.range.endExclusive),
            { rowPitch: 0 }
          );
          checkOpen(isOpen);
        }
      } catch (error) {
        try {
          owner.dispose();
        } catch (cleanup) {
          throw new AggregateError([error, cleanup], 'Coastline texture creation failed');
        }
        throw error;
      }
      return owner;
    },
  });
}
