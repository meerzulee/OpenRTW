import {
  BufferKind,
  TextureFormat,
  Primitive,
  Fvf,
  Transform,
  RenderState,
  StageState,
  TextureOp,
  TextureArg,
  Address,
  Filter,
  Blend,
  Compare,
} from '/reference/renderer-bridge.js';
import { frustumPlanes, aabbIntersectsFrustum } from '/aerial-terrain-pages.js';

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const modulate2x = 5; // D3DTOP_MODULATE2X, supported by the measured renderer profile.
const clamp = (n) => Math.max(0, Math.min(1, n));
const handle = (n) => Number.isInteger(n) && n > 0 && n <= 0xffffffff;
export const campaignTreeRenderPolicy = Object.freeze({
  id: 'openrtw-native-placement-static-tree-batches-v1',
  geometry: 'verbatim-CAS-position-normal-UV;translation-only;cell-units',
  lighting: 'half-terrain-ambient-and-diffuse;MODULATE2X;CPU-diffuse-quantized-to8bits',
  alpha: '9FBC9A:GREATER-ref0;SRCALPHA-INVSRCALPHA;ZWRITE;CCW-cull',
  fog: 'terrain-cover-always-drawn;world-UV-stage1-modulation',
  batching: 'OpenRTW16-cell-chunks-by-texture;16bit-index-splits;frustum-cull',
  wind: 'disabled-static-source-posture;native-timed-shear-not-reproduced',
  shadows: 'not-rendered',
});

function litColors(part, lighting) {
  const colors = new Uint32Array(part.positions.length / 3);
  for (let i = 0; i < colors.length; i++) {
    const lambert = Math.max(
      0,
      lighting.toLight.reduce((sum, v, k) => sum + v * part.normals[i * 3 + k], 0)
    );
    const rgb = lighting.ambient_colour.map((a, k) =>
      Math.round(255 * clamp(0.5 * a + 0.5 * lighting.diffuse_colour[k] * lambert))
    );
    colors[i] = (0xff000000 | (rgb[0] << 16) | (rgb[1] << 8) | rgb[2]) >>> 0;
  }
  return colors;
}

export function buildCampaignTreeBatches(
  assets,
  season,
  { chunkCells = 16, maxVertices = 60000 } = {}
) {
  const scene = assets.scenes[season];
  if (
    !scene ||
    !Number.isInteger(chunkCells) ||
    chunkCells < 1 ||
    chunkCells > 64 ||
    !Number.isInteger(maxVertices) ||
    maxVertices < 3 ||
    maxVertices > 65535
  )
    throw TypeError('Invalid campaign tree batch configuration');
  const groups = new Map(),
    batches = [],
    colors = new Map();
  let totalVertices = 0,
    totalIndices = 0;
  for (const row of scene.models) {
    const parts = assets.models.get(row.path);
    if (!parts) throw Error('Missing campaign tree geometry');
    for (const part of parts) {
      const n = part.positions.length / 3;
      if (!Number.isInteger(n) || n > maxVertices || !assets.textures.has(part.texturePath))
        throw Error('Campaign tree mesh exceeds a batch or lacks its texture');
      totalVertices += n;
      totalIndices += part.indices.length;
      if (totalVertices > 4 * 1024 * 1024 || totalIndices > 12 * 1024 * 1024)
        throw Error('Campaign tree geometry exceeds its browser budget');
      const canopy = row.role === 'canopy';
      const key = `${canopy ? 1 : 0}:${Math.floor(row.cellX / chunkCells)}:${Math.floor(row.cellY / chunkCells)}:${part.texturePath}`;
      let batch = groups.get(key);
      if (!batch || batch.vertexCount + n > maxVertices) {
        batch = {
          texturePath: part.texturePath,
          canopy,
          vertexCount: 0,
          indexCount: 0,
          pieces: [],
        };
        groups.set(key, batch);
        batches.push(batch);
      }
      batch.pieces.push({ row, part });
      batch.vertexCount += n;
      batch.indexCount += part.indices.length;
      if (!colors.has(part)) colors.set(part, litColors(part, assets.lighting));
    }
  }
  for (const batch of batches) {
    batch.vertices = new Uint8Array(batch.vertexCount * 32);
    batch.indexBytes = new Uint8Array(batch.indexCount * 2);
    const vertex = new DataView(batch.vertices.buffer),
      index = new DataView(batch.indexBytes.buffer);
    const min = [Infinity, Infinity, Infinity],
      max = [-Infinity, -Infinity, -Infinity];
    let v = 0,
      at = 0;
    for (const { row, part } of batch.pieces) {
      const start = v,
        packed = colors.get(part);
      for (let i = 0; i < packed.length; i++, v++) {
        const point = [row.x, row.y, row.z].map((offset, k) =>
          Math.fround(offset + part.positions[i * 3 + k])
        );
        for (let k = 0; k < 3; k++) {
          if (!Number.isFinite(point[k])) throw Error('Nonfinite campaign tree vertex');
          vertex.setFloat32(v * 32 + k * 4, point[k], true);
          min[k] = Math.min(min[k], point[k]);
          max[k] = Math.max(max[k], point[k]);
        }
        vertex.setUint32(v * 32 + 12, packed[i], true);
        vertex.setFloat32(v * 32 + 16, part.uvs[i * 2], true);
        vertex.setFloat32(v * 32 + 20, part.uvs[i * 2 + 1], true);
        vertex.setFloat32(v * 32 + 24, point[0] / assets.width, true);
        vertex.setFloat32(v * 32 + 28, point[2] / assets.height, true);
      }
      for (const local of part.indices) index.setUint16(at++ * 2, start + local, true);
    }
    batch.bounds = { min, max };
    batch.triangles = batch.indexCount / 3;
    batch.pieceInstances = batch.pieces.length;
    delete batch.pieces;
  }
  return batches.sort((a, b) => Number(a.canopy) - Number(b.canopy));
}

export function createCampaignTrees({ renderer, assets, fog = null, season = 'summer' }) {
  if (fog && (fog.width !== assets.width || fog.height !== assets.height))
    throw TypeError('Campaign tree fog dimensions differ');
  let batches = [],
    buffers = [],
    currentSeason = null,
    disposed = false,
    drawn = 0,
    visibleInstances = 0;
  const textures = new Map();
  const alive = () => {
    if (disposed) throw Error('Campaign trees are disposed');
  };
  function destroyBuffers(ids) {
    const errors = [];
    for (const id of ids)
      try {
        renderer.destroyBuffer(id);
      } catch (e) {
        errors.push(e);
      }
    if (errors.length) throw new AggregateError(errors, 'Campaign tree buffer cleanup failed');
  }
  function setSeason(value) {
    alive();
    if (!['summer', 'winter'].includes(value)) throw TypeError('Invalid campaign tree season');
    if (value === currentSeason) return;
    const next = buildCampaignTreeBatches(assets, value),
      nextBuffers = [];
    const upload = (kind, bytes) => {
      const id = renderer.createBuffer({ kind, bytes: bytes.length });
      if (!handle(id)) throw Error('Invalid campaign tree buffer');
      nextBuffers.push(id);
      renderer.uploadBuffer(id, bytes);
      return id;
    };
    try {
      for (const batch of next) {
        batch.vb = upload(BufferKind.VERTEX, batch.vertices);
        batch.ib = upload(BufferKind.INDEX16, batch.indexBytes);
        batch.vertices = batch.indexBytes = null;
      }
    } catch (error) {
      try {
        destroyBuffers(nextBuffers);
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], 'Campaign tree season staging failed');
      }
      throw error;
    }
    const old = buffers;
    buffers = nextBuffers;
    batches = next;
    currentSeason = value;
    drawn = visibleInstances = 0;
    destroyBuffers(old);
  }
  const owner = Object.freeze({
    setSeason,
    status() {
      alive();
      const scene = assets.scenes[currentSeason];
      return {
        schema: 'openrtw-campaign-tree-bindings-v1',
        season: currentSeason,
        instances: scene.models.length,
        sparse: scene.sparseCount,
        dense: scene.denseCount,
        canopy: scene.canopyCount,
        models: assets.models.size,
        textures: textures.size,
        batches: batches.length,
        drawnBatches: drawn,
        visiblePieceInstances: visibleInstances,
        noTreeFlagsProvided: scene.noTreeFlagsProvided,
        tileIdsProvided: scene.tileIdsProvided,
        policy: campaignTreeRenderPolicy,
      };
    },
    draw(combined, timeSeconds = 0, fogTexture = null) {
      alive();
      if (!Number.isFinite(timeSeconds) || timeSeconds < 0 || (fog && !fogTexture))
        throw TypeError('Invalid campaign tree draw inputs');
      const planes = frustumPlanes(combined);
      drawn = visibleInstances = 0;
      renderer.setFvf(Fvf.XYZ | Fvf.DIFFUSE | Fvf.TEX2);
      renderer.setTransform(Transform.WORLD, identity);
      renderer.setMaterialLighting({ enabled: false });
      renderer.setDirectionalLighting({ enabled: false });
      try {
        for (const state of [
          RenderState.LIGHTING,
          RenderState.FOGENABLE,
          RenderState.SPECULARENABLE,
        ])
          renderer.setRenderState(state, 0);
        for (const state of [
          RenderState.ZENABLE,
          RenderState.ZWRITEENABLE,
          RenderState.ALPHATESTENABLE,
          RenderState.ALPHABLENDENABLE,
        ])
          renderer.setRenderState(state, 1);
        renderer.setRenderState(RenderState.CULLMODE, 3);
        renderer.setRenderState(RenderState.ZFUNC, Compare.LESSEQUAL);
        renderer.setRenderState(RenderState.ALPHAREF, 0);
        renderer.setRenderState(RenderState.ALPHAFUNC, Compare.GREATER);
        renderer.setRenderState(RenderState.SRCBLEND, Blend.SRCALPHA);
        renderer.setRenderState(RenderState.DESTBLEND, Blend.INVSRCALPHA);
        renderer.setStageState(0, StageState.COLOROP, modulate2x);
        renderer.setStageState(0, StageState.COLORARG1, TextureArg.TEXTURE);
        renderer.setStageState(0, StageState.COLORARG2, TextureArg.DIFFUSE);
        renderer.setStageState(0, StageState.ALPHAOP, TextureOp.MODULATE);
        renderer.setStageState(0, StageState.ALPHAARG1, TextureArg.TEXTURE);
        renderer.setStageState(0, StageState.ALPHAARG2, TextureArg.DIFFUSE);
        for (const state of [StageState.ADDRESSU, StageState.ADDRESSV])
          renderer.setStageState(0, state, Address.WRAP);
        for (const state of [StageState.MINFILTER, StageState.MAGFILTER, StageState.MIPFILTER])
          renderer.setStageState(0, state, Filter.LINEAR);
        if (fogTexture) fogTexture.bind(1);
        else renderer.setStageState(1, StageState.COLOROP, TextureOp.DISABLE);
        for (const batch of batches)
          if (aabbIntersectsFrustum(planes, batch.bounds.min, batch.bounds.max)) {
            renderer.setTexture(0, textures.get(batch.texturePath));
            renderer.setStream(batch.vb, 32);
            renderer.setIndices(batch.ib, 0);
            renderer.drawIndexed({
              primitive: Primitive.TRIANGLELIST,
              primitiveCount: batch.triangles,
            });
            drawn++;
            visibleInstances += batch.pieceInstances;
          }
      } finally {
        if (fogTexture) fogTexture.unbind(1);
        renderer.setTexture(0, 0);
        renderer.setStageState(1, StageState.COLOROP, TextureOp.DISABLE);
        for (const [op, arg] of [
          [StageState.COLOROP, StageState.COLORARG1],
          [StageState.ALPHAOP, StageState.ALPHAARG1],
        ]) {
          renderer.setStageState(0, op, TextureOp.SELECTARG1);
          renderer.setStageState(0, arg, TextureArg.DIFFUSE);
        }
        renderer.setStageState(0, StageState.COLORARG2, TextureArg.CURRENT);
        renderer.setRenderState(RenderState.ALPHATESTENABLE, 0);
        renderer.setRenderState(RenderState.ALPHABLENDENABLE, 0);
        renderer.setRenderState(RenderState.CULLMODE, 1);
        renderer.setRenderState(RenderState.ALPHAREF, 0);
        for (const state of [StageState.MINFILTER, StageState.MAGFILTER])
          renderer.setStageState(0, state, Filter.POINT);
        renderer.setStageState(0, StageState.MIPFILTER, Filter.NONE);
        renderer.setFvf(Fvf.XYZ | Fvf.DIFFUSE | Fvf.TEX1);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      const errors = [];
      try {
        destroyBuffers(buffers);
      } catch (e) {
        errors.push(e);
      }
      buffers = [];
      batches = [];
      for (const id of textures.values())
        try {
          renderer.destroyTexture(id);
        } catch (e) {
          errors.push(e);
        }
      textures.clear();
      if (errors.length) throw new AggregateError(errors, 'Campaign tree cleanup failed');
    },
  });
  try {
    for (const [path, texture] of assets.textures) {
      const m = texture.metadata,
        id = renderer.createTexture({
          width: m.width,
          height: m.height,
          levels: m.mips.length,
          format: TextureFormat[m.format],
        });
      if (!handle(id)) throw Error('Invalid campaign tree texture');
      textures.set(path, id);
      for (const mip of m.mips)
        renderer.uploadTexture(
          id,
          mip.level,
          texture.source.subarray(mip.range.start, mip.range.endExclusive),
          { rowPitch: 0 }
        );
    }
    setSeason(season);
  } catch (error) {
    try {
      owner.dispose();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Campaign tree creation failed');
    }
    throw error;
  }
  return owner;
}
