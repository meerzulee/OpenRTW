import {
  TextureFormat,
  StageState,
  TextureOp,
  TextureArg,
  Address,
  Filter,
} from '/reference/renderer-bridge.js';

export const campaignFogRenderPolicy = Object.freeze({
  id: 'openrtw-campaign-fog-full-world-targets-v1',
  targets: 'state-below-2:[144,0];visible-or-disabled:[255,255]',
  filter: 'native-3x3-neighbours3-centre9-divisor33;copy-border',
  channels: 'rgba:[v-k,v-k,v+2k,a];k=(255-v)>>3',
  binding: 'modulate-texture-current;preserve-current-alpha',
  coverage: 'full-world;world-y-up;uv=x/width,z/height',
  transition: 'immediate-targets;native-time-interpolation-not-reproduced',
});

const maxCells = 1024 * 1024;
const maxVertices = 1024 * 1024;
const uint = (value) => Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
function dimensions(width, height) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 4096 ||
    height > 4096 ||
    width * height > maxCells
  )
    throw new RangeError('Campaign fog texture dimensions exceed policy');
}
function stageIndex(stage) {
  if (!Number.isInteger(stage) || stage < 0 || stage > 7)
    throw new RangeError('Campaign fog stage must be 0..7');
}

/** Owned world-y-up pixels. Remembered and unseen terrain have the same native
 * target; their distinction remains in the separate knowledge/visibility table.
 */
export function campaignFogTexturePixels({ width, height, bytes, enabled = true } = {}) {
  dimensions(width, height);
  const count = width * height;
  if (
    !(bytes instanceof Uint8Array) ||
    !(bytes.buffer instanceof ArrayBuffer) ||
    bytes.length !== count ||
    typeof enabled !== 'boolean'
  )
    throw new TypeError('Invalid campaign fog raster input');
  const target = new Uint8Array(count * 2);
  for (let i = 0; i < count; i++) {
    if (bytes[i] >= 100) throw new RangeError('Transient campaign fog cell in texture input');
    const visible = !enabled || bytes[i] >= 2;
    target[2 * i] = visible ? 255 : 144;
    target[2 * i + 1] = visible ? 255 : 0;
  }
  const blurred = target.slice();
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const cell = x + width * y;
      for (let channel = 0; channel < 2; channel++) {
        let sum = 9 * target[2 * cell + channel];
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            if (dx || dy) sum += 3 * target[2 * (cell + dx + width * dy) + channel];
          }
        blurred[2 * cell + channel] = Math.floor(sum / 33);
      }
    }
  }
  const rgba = new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) {
    const v = blurred[2 * i],
      k = (255 - v) >> 3;
    rgba[4 * i] = Math.max(0, v - k);
    rgba[4 * i + 1] = Math.max(0, v - k);
    rgba[4 * i + 2] = Math.min(255, v + 2 * k);
    rgba[4 * i + 3] = blurred[2 * i + 1];
  }
  return { width, height, rgba };
}

/** Append world-space fog UVs to XYZ/DIFFUSE/TEX1 vertices. The caller selects
 * Fvf.XYZ|Fvf.DIFFUSE|Fvf.TEX2 and stride32. Existing 24 bytes are preserved.
 */
export function extendCampaignFogVertices(bytes, worldWidth, worldHeight) {
  dimensions(worldWidth, worldHeight);
  if (
    !(bytes instanceof Uint8Array) ||
    !(bytes.buffer instanceof ArrayBuffer) ||
    bytes.length % 24 !== 0 ||
    bytes.length / 24 > maxVertices
  )
    throw new TypeError('Invalid campaign fog vertex buffer');
  const count = bytes.length / 24;
  const source = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result = new Uint8Array(count * 32),
    out = new DataView(result.buffer);
  for (let i = 0; i < count; i++) {
    for (const offset of [0, 4, 8, 16, 20])
      if (!Number.isFinite(source.getFloat32(i * 24 + offset, true)))
        throw new RangeError('Nonfinite campaign fog vertex');
    result.set(bytes.subarray(i * 24, i * 24 + 24), i * 32);
    out.setFloat32(i * 32 + 24, source.getFloat32(i * 24, true) / worldWidth, true);
    out.setFloat32(i * 32 + 28, source.getFloat32(i * 24 + 8, true) / worldHeight, true);
  }
  return result;
}

/** Owns one RGBA8 texture. Fog.snapshot() supplies a copied world-order table;
 * fog.maskRevision changes for visibility classes or the display toggle.
 */
export function createCampaignFogTexture({ renderer, fog } = {}) {
  if (
    !renderer ||
    !fog ||
    typeof fog.snapshot !== 'function' ||
    !['createTexture', 'uploadTexture', 'destroyTexture', 'setTexture', 'setStageState'].every(
      (name) => typeof renderer[name] === 'function'
    )
  )
    throw new TypeError('Invalid campaign fog texture owner');
  let texture = 0,
    disposed = false,
    revision = -1,
    width = 0,
    height = 0;
  const alive = () => {
    if (disposed) throw new Error('Campaign fog texture is disposed');
  };
  function update() {
    alive();
    const nextRevision = fog.maskRevision;
    if (!Number.isSafeInteger(nextRevision) || nextRevision < 0)
      throw new TypeError('Invalid campaign fog mask revision');
    if (nextRevision === revision) return false;
    const snapshot = fog.snapshot();
    if (snapshot.maskRevision !== nextRevision)
      throw new Error('Campaign fog snapshot revision changed');
    const pixels = campaignFogTexturePixels(snapshot);
    if (texture && (width !== pixels.width || height !== pixels.height))
      throw new Error('Campaign fog texture dimensions changed');
    if (!texture) {
      width = pixels.width;
      height = pixels.height;
      texture = renderer.createTexture({ width, height, levels: 1, format: TextureFormat.RGBA8 });
      if (!uint(texture) || !texture) {
        texture = 0;
        throw new Error('Invalid campaign fog texture handle');
      }
    }
    renderer.uploadTexture(texture, 0, pixels.rgba, { rowPitch: width * 4 });
    revision = nextRevision;
    return true;
  }
  function unbind(stage = 1) {
    alive();
    stageIndex(stage);
    renderer.setTexture(stage, 0);
    renderer.setStageState(stage, StageState.COLOROP, TextureOp.DISABLE);
    renderer.setStageState(stage, StageState.ALPHAOP, TextureOp.DISABLE);
    renderer.setStageState(stage, StageState.TEXCOORDINDEX, 0);
    renderer.setStageState(stage, StageState.TEXTURETRANSFORMFLAGS, 0);
  }
  const owner = Object.freeze({
    policy: campaignFogRenderPolicy,
    get revision() {
      return revision;
    },
    get width() {
      return width;
    },
    get height() {
      return height;
    },
    update,
    bind(stage = 1) {
      alive();
      stageIndex(stage);
      update();
      renderer.setTexture(stage, texture);
      renderer.setStageState(stage, StageState.COLOROP, TextureOp.MODULATE);
      renderer.setStageState(stage, StageState.COLORARG1, TextureArg.TEXTURE);
      renderer.setStageState(stage, StageState.COLORARG2, TextureArg.CURRENT);
      renderer.setStageState(stage, StageState.ALPHAOP, TextureOp.SELECTARG1);
      renderer.setStageState(stage, StageState.ALPHAARG1, TextureArg.CURRENT);
      renderer.setStageState(stage, StageState.TEXCOORDINDEX, 1);
      renderer.setStageState(stage, StageState.TEXTURETRANSFORMFLAGS, 0);
      for (const state of [StageState.ADDRESSU, StageState.ADDRESSV])
        renderer.setStageState(stage, state, Address.CLAMP);
      for (const state of [StageState.MINFILTER, StageState.MAGFILTER])
        renderer.setStageState(stage, state, Filter.LINEAR);
      renderer.setStageState(stage, StageState.MIPFILTER, Filter.NONE);
    },
    unbind,
    dispose() {
      if (disposed) return;
      disposed = true;
      const old = texture;
      texture = 0;
      if (old) renderer.destroyTexture(old);
    },
  });
  try {
    update();
  } catch (error) {
    try {
      owner.dispose();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Campaign fog creation failed');
    }
    throw error;
  }
  return owner;
}
