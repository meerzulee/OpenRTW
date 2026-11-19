import {
  BufferKind,
  Primitive,
  Fvf,
  Transform,
  RenderState,
  StageState,
  TextureOp,
  TextureArg,
  TextureFormat,
  Address,
  Filter,
  Blend,
  Compare,
} from '/reference/renderer-bridge.js';
import { createGeometryResource, geometryResourceSchema } from '/runtime/geometry-resource.js';

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const clamp = (v) => Math.max(0, Math.min(1, v));
const uint = (v) => Number.isInteger(v) && v > 0 && v <= 0xffffffff;

export function settlementFrustumPlanes(m) {
  if (!Array.isArray(m) || m.length !== 16 || m.some((v) => !Number.isFinite(v)))
    throw new Error('Invalid settlement view projection');
  const column = (i) => [m[i], m[i + 4], m[i + 8], m[i + 12]];
  const w = column(3),
    z = column(2),
    planes = [];
  for (const i of [0, 1])
    for (const sign of [1, -1]) planes.push(column(i).map((v, j) => w[j] + sign * v));
  planes.push(
    z,
    z.map((v, j) => w[j] - v)
  );
  return planes.map((p) => {
    const len = Math.hypot(...p.slice(0, 3));
    return p.map((v) => v / len);
  });
}

// 934E31 -> 92520B/9250B7: half piece light and MODULATE2X; mode 0
// (banners) uses full terrain light and MODULATE. F46BB0 quantises ambient.
// CAS colours are ignored by 934709. Normals are rotated with the instance,
// without normalization (native NORMALIZENORMALS is off). This CPU diffuse
// bridge has no material specular path: specular remains an explicit omission.
export function settlementVertexBytes(model, matrix, lighting, banner = false) {
  const count = model.positions.length / 3,
    bytes = new Uint8Array(count * 24),
    view = new DataView(bytes.buffer);
  const ambient = lighting[banner ? 'ambient_colour' : 'piece_ambient_colour'];
  const diffuse = lighting[banner ? 'diffuse_colour' : 'piece_diffuse_colour'];
  const factor = banner ? 1 : 0.5;
  for (let i = 0; i < count; i++) {
    const at = i * 3,
      n = model.normals.slice(at, at + 3);
    const normal = [0, 1, 2].map(
      (k) => n[0] * matrix[k] + n[1] * matrix[k + 4] + n[2] * matrix[k + 8]
    );
    const lambert = Math.max(
      0,
      normal.reduce((sum, v, k) => sum + v * lighting.toLight[k], 0)
    );
    const rgb = ambient.map((a, k) =>
      Math.round(255 * clamp(Math.round(255 * a * factor) / 255 + factor * diffuse[k] * lambert))
    );
    for (let k = 0; k < 3; k++) view.setFloat32(i * 24 + k * 4, model.positions[at + k], true);
    view.setUint32(i * 24 + 12, (0xff000000 | (rgb[0] << 16) | (rgb[1] << 8) | rgb[2]) >>> 0, true);
    view.setFloat32(i * 24 + 16, model.uvs[i * 2], true);
    view.setFloat32(i * 24 + 20, model.uvs[i * 2 + 1], true);
  }
  return bytes;
}

// Declares one admitted orientation draw unit to the shared geometry service:
// the exact packed vertex bytes this orientation bakes plus a copy of the
// model's shared index span. The service owns bit-exact copies, so pooled
// Buffer/subarray sources and later caller mutations can never alias the
// uploaded bytes. Transforms, CPU lighting, culling, materials, UVs, hit
// targets and GPU lifetime remain title policy in this module. The extension
// owns the complete admitted source/title projection and placement record;
// coordinates are the uninterpreted title projection. Packed indices are
// retained by the resource rather than duplicated in its metadata.
export function createSettlementGeometryResource(row, source, vertexBytes) {
  const fields = Object.getOwnPropertyDescriptors(source);
  const names = Reflect.ownKeys(fields);
  if (![Object.prototype, null].includes(Object.getPrototypeOf(source)) || names.some(
    name => typeof name !== 'string' || !fields[name].enumerable ||
      !Object.hasOwn(fields[name], 'value')))
    throw new TypeError('Invalid settlement source metadata');
  const sourceMetadata = Object.fromEntries(names.filter(name => name !== 'indexBytes')
    .map(name => [name, fields[name].value]));
  return createGeometryResource({
    schema: geometryResourceSchema,
    layout: { stride: 24, endianness: 'little', attributes: [
      { semantic: 'position', format: 'f32x3', offset: 0 },
      { semantic: 'color', format: 'd3dcolor-bgra8', offset: 12 },
      { semantic: 'uv0', format: 'f32x2', offset: 16 },
    ] },
    primitive: 'triangle-list',
    indexFormat: 'uint16-le',
    counts: { vertices: vertexBytes.length / 24, indices: source.indexBytes.length / 2 },
    coordinates: { frame: 'settlement-source-model', units: 'title-projection',
      up: 'uninterpreted', handedness: 'uninterpreted' },
    vertexBytes,
    indexBytes: source.indexBytes,
    extensions: { 'rome-original.settlement-static-geometry/v1': {
      schema: 'rome-original.settlement-static-geometry/v1',
      path: row.path,
      banner: row.role === 'banner',
      matrix: row.matrix,
      parts: source.parts,
      placement: row,
      sourceMetadata,
    } },
  });
}

/** Native source matrices, per-material textures and texture buckets. The known
 * cell gate uses the native geometry threshold (byte >= 1) for this initial
 * static snapshot. Native live structures require >= 2; their separate updated
 * shroud records are not reconstructed here.
 * Inherits VIEW/PROJECTION; restores the scene's neutral states; never presents.
 */
export function createCampaignSettlementModels({ renderer, assets }) {
  const { placement, models, textures, lighting } = assets;
  const buffers = [],
    textureIds = new Map(),
    geometry = new Map(),
    buckets = new Map();
  let disposed = false,
    lastDraws = 0,
    lastVisibleBindings = null,
    frameTargets = new WeakMap(),
    // The fixed-function encoding admitted below. Every admitted resource
    // declares the same packing; draw reads these descriptor-derived values
    // instead of independent constants.
    declaredFvf = Fvf.XYZ | Fvf.DIFFUSE | Fvf.TEX1,
    declaredStride = 24,
    declaredPrimitive = Primitive.TRIANGLELIST;
  const bindings = placement.models.map((row) => {
    if (
      !models.has(row.path) ||
      !Array.isArray(row.matrix) ||
      row.matrix.length !== 16 ||
      row.matrix.some((v) => !Number.isFinite(v) || Math.abs(v) > 1e6) ||
      row.matrix[3] !== 0 ||
      row.matrix[7] !== 0 ||
      row.matrix[11] !== 0 ||
      row.matrix[15] !== 1
    )
      throw new Error('Invalid settlement model matrix or path');
    return Object.freeze({ ...row, matrix: Object.freeze([...row.matrix]) });
  });
  const targets = new Map(),
    noTargets = Object.freeze([]),
    localBounds = new Map();
  for (const row of bindings) {
    if (
      !['settlement', 'port'].includes(row.kind) ||
      !Number.isSafeInteger(row.objectId) ||
      row.objectId < 0 ||
      typeof row.region !== 'string' ||
      !row.region ||
      row.region.length > 1024 ||
      ![row.x, row.y].every((v) => Number.isSafeInteger(v) && v >= 0 && v <= 4095)
    )
      continue;
    let local = localBounds.get(row.path);
    if (!local) {
      local = [
        [Infinity, Infinity, Infinity],
        [-Infinity, -Infinity, -Infinity],
      ];
      const positions = models.get(row.path).positions;
      for (let i = 0; i < positions.length; i++) {
        if (!Number.isFinite(positions[i])) throw Error('Invalid settlement hit geometry');
        local[0][i % 3] = Math.min(local[0][i % 3], positions[i]);
        local[1][i % 3] = Math.max(local[1][i % 3], positions[i]);
      }
      localBounds.set(row.path, local);
    }
    const bounds = [
        [Infinity, Infinity, Infinity],
        [-Infinity, -Infinity, -Infinity],
      ],
      m = row.matrix;
    for (let corner = 0; corner < 8; corner++) {
      const p = [0, 1, 2].map((k) => local[(corner >> k) & 1][k]);
      for (let k = 0; k < 3; k++) {
        const v = p[0] * m[k] + p[1] * m[k + 4] + p[2] * m[k + 8] + m[k + 12];
        bounds[0][k] = Math.min(bounds[0][k], v);
        bounds[1][k] = Math.max(bounds[1][k], v);
      }
    }
    targets.set(
      row,
      Object.freeze({
        kind: row.kind,
        objectId: row.objectId,
        region: row.region,
        x: row.x,
        y: row.y,
        role: row.role,
        policy: 'transformed-source-model-bounds;UI-target-not-physics',
        bounds: Object.freeze(bounds.map(Object.freeze)),
      })
    );
  }
  function release() {
    const errors = [];
    for (const id of textureIds.values())
      try {
        renderer.destroyTexture(id);
      } catch (e) {
        errors.push(e);
      }
    textureIds.clear();
    for (const id of buffers.splice(0))
      try {
        renderer.destroyBuffer(id);
      } catch (e) {
        errors.push(e);
      }
    if (errors.length) throw new AggregateError(errors, 'Settlement resource cleanup failed');
  }
  const owner = Object.freeze({
    bindings,
    hitTargets(combined) {
      if (disposed) throw new Error('Settlement models are disposed');
      return frameTargets.get(combined) ?? noTargets;
    },
    get lastDraws() {
      return lastDraws;
    },
    // Only a completely submitted frame exposes its visibility set. The shadow
    // scene consumes these exact rows instead of recomputing fog/frustum
    // predicates, and a failed draw leaves no stale set behind.
    get lastVisibleBindings() {
      return lastVisibleBindings;
    },
    draw(combined, fog = null) {
      if (disposed) throw new Error('Settlement models are disposed');
      lastDraws = 0;
      lastVisibleBindings = null;
      if (fog !== null && typeof fog?.structureKnown !== 'function')
        throw new TypeError('Settlement models require fog.structureKnown');
      const planes = settlementFrustumPlanes(combined);
      const visible = new Set(
        bindings.filter((row) => {
          if (fog !== null) {
            // A port's sea mesh can occupy a different cell. Its source x/y
            // still identify the owning object; matrix translation cannot.
            if (![row.x, row.y].every((v) => Number.isSafeInteger(v) && v >= 0))
              throw new Error('Settlement model fog cell is invalid');
            if (fog.structureKnown(row.x, row.y) !== true) return false;
          }
          return planes.every(
            (p) =>
              p[0] * row.matrix[12] + p[1] * row.matrix[13] + p[2] * row.matrix[14] + p[3] >= -2
          );
        })
      );
      renderer.setFvf(declaredFvf);
      renderer.setMaterialLighting({ enabled: false });
      renderer.setDirectionalLighting({ enabled: false });
      for (const state of [RenderState.LIGHTING, RenderState.FOGENABLE, RenderState.SPECULARENABLE])
        renderer.setRenderState(state, 0);
      renderer.setRenderState(RenderState.ZENABLE, 1);
      renderer.setRenderState(RenderState.ZWRITEENABLE, 1);
      renderer.setRenderState(RenderState.ZFUNC, Compare.LESSEQUAL);
      renderer.setRenderState(RenderState.ALPHAREF, 45); // A63E29/F461E0
      renderer.setRenderState(RenderState.ALPHAFUNC, Compare.GREATER);
      renderer.setRenderState(RenderState.SRCBLEND, Blend.SRCALPHA);
      renderer.setRenderState(RenderState.DESTBLEND, Blend.INVSRCALPHA);
      for (const state of [StageState.ADDRESSU, StageState.ADDRESSV])
        renderer.setStageState(0, state, Address.WRAP);
      for (const state of [StageState.MINFILTER, StageState.MAGFILTER, StageState.MIPFILTER])
        renderer.setStageState(0, state, Filter.LINEAR);
      try {
        // A62E78/A63E29: texture first-use order, not one pass per object kind.
        for (const [path, draws] of buckets) {
          renderer.setTexture(0, textureIds.get(path));
          for (const { row, part, vb, ib } of draws) {
            if (!visible.has(row)) continue;
            const banner = row.role === 'banner';
            const alpha =
              textures.get(path).metadata.format !== 'DXT1' ||
              ['buildings', 'wall'].includes(row.role);
            renderer.setRenderState(RenderState.ALPHATESTENABLE, alpha ? 1 : 0);
            renderer.setRenderState(RenderState.ALPHABLENDENABLE, alpha ? 1 : 0);
            renderer.setRenderState(RenderState.CULLMODE, part.material.cull ? 3 : 1);
            renderer.setStageState(0, StageState.COLOROP, TextureOp.MODULATE);
            renderer.setStageState(0, StageState.COLORARG1, TextureArg.TEXTURE);
            renderer.setStageState(0, StageState.COLORARG2, TextureArg.DIFFUSE);
            renderer.setStageState(0, StageState.ALPHAOP, TextureOp.MODULATE);
            renderer.setStageState(0, StageState.ALPHAARG1, TextureArg.TEXTURE);
            renderer.setStageState(0, StageState.ALPHAARG2, TextureArg.DIFFUSE);
            // The bridge lacks D3DTOP_MODULATE2X. MODULATE then ADD(CURRENT,
            // CURRENT) is equivalent, including its clamp after multiplication.
            renderer.setStageState(
              1,
              StageState.COLOROP,
              banner ? TextureOp.DISABLE : TextureOp.ADD
            );
            renderer.setStageState(1, StageState.COLORARG1, TextureArg.CURRENT);
            renderer.setStageState(1, StageState.COLORARG2, TextureArg.CURRENT);
            renderer.setStageState(1, StageState.ALPHAOP, TextureOp.SELECTARG1);
            renderer.setStageState(1, StageState.ALPHAARG1, TextureArg.CURRENT);
            renderer.setTransform(Transform.WORLD, row.matrix);
            renderer.setStream(vb, declaredStride);
            renderer.setIndices(ib, 0);
            renderer.drawIndexed({
              primitive: declaredPrimitive,
              primitiveCount: part.triangles,
              startIndex: part.firstIndex,
            });
            lastDraws++;
          }
        }
      } finally {
        renderer.setTransform(Transform.WORLD, identity);
        renderer.setTexture(0, 0);
        renderer.setTexture(1, 0);
        renderer.setStageState(1, StageState.COLOROP, TextureOp.DISABLE);
        for (const [op, arg] of [
          [StageState.COLOROP, StageState.COLORARG1],
          [StageState.ALPHAOP, StageState.ALPHAARG1],
        ]) {
          renderer.setStageState(0, op, TextureOp.SELECTARG1);
          renderer.setStageState(0, arg, TextureArg.DIFFUSE);
        }
        renderer.setStageState(0, StageState.COLORARG2, TextureArg.CURRENT);
        for (const state of [StageState.MINFILTER, StageState.MAGFILTER])
          renderer.setStageState(0, state, Filter.POINT);
        renderer.setStageState(0, StageState.MIPFILTER, Filter.NONE);
        renderer.setRenderState(RenderState.ALPHAREF, 0);
        renderer.setRenderState(RenderState.ALPHATESTENABLE, 0);
        renderer.setRenderState(RenderState.ALPHABLENDENABLE, 0);
        renderer.setRenderState(RenderState.CULLMODE, 1);
      }
      // Publish the exact submitted row set only after the complete pass and
      // its restoration succeeded. The shadow scene reuses it rather than
      // recomputing fog or frustum predicates.
      lastVisibleBindings = Object.freeze([...visible]);
      frameTargets.set(
        combined,
        Object.freeze([...visible].map((row) => targets.get(row)).filter(Boolean))
      );
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      lastVisibleBindings = null;
      frameTargets = new WeakMap();
      release();
    },
  });
  const buffer = (kind, bytes) => {
    const id = renderer.createBuffer({ kind, bytes: bytes.length });
    if (!uint(id)) throw new Error('Invalid settlement buffer');
    buffers.push(id);
    renderer.uploadBuffer(id, bytes);
    return id;
  };
  try {
    for (const [path, texture] of textures) {
      const m = texture.metadata;
      const id = renderer.createTexture({
        width: m.width,
        height: m.height,
        levels: m.mips.length,
        format: TextureFormat[m.format],
      });
      if (!uint(id)) throw new Error('Invalid settlement texture');
      textureIds.set(path, id);
      for (const mip of m.mips)
        renderer.uploadTexture(
          id,
          mip.level,
          texture.source.subarray(mip.range.start, mip.range.endExclusive),
          { rowPitch: 0 }
        );
    }
    for (const row of bindings) {
      let model = geometry.get(row.path);
      if (!model) {
        model = { source: models.get(row.path), ib: null, orientations: new Map() };
        geometry.set(row.path, model);
      }
      // One shared index buffer per model. Port rotations need separate baked
      // diffuse vertex buffers because this bridge FVF has no NORMAL channel.
      const orientation = JSON.stringify([row.role === 'banner', ...row.matrix.slice(0, 12)]);
      let entry = model.orientations.get(orientation);
      if (!entry) {
        // CPU admission completes before this unit's first device call; the
        // resource.upload port order (allocate/allocate/upload/upload) differs
        // from the legacy alternating sequence, so uploads stay caller-owned
        // through the existing buffer() owner and read back fresh owned copies.
        const resource = createSettlementGeometryResource(
          row,
          model.source,
          settlementVertexBytes(model.source, row.matrix, lighting, row.role === 'banner')
        );
        const technical = resource.descriptor.technical;
        if (
          technical.fvf !== declaredFvf ||
          resource.descriptor.layout.stride !== declaredStride ||
          technical.primitive !== declaredPrimitive ||
          technical.buffers.vertex !== BufferKind.VERTEX ||
          technical.buffers.index !== BufferKind.INDEX16
        )
          throw new TypeError('Unsupported settlement geometry encoding');
        declaredFvf = technical.fvf;
        declaredStride = resource.descriptor.layout.stride;
        declaredPrimitive = technical.primitive;
        if (model.ib === null) model.ib = buffer(technical.buffers.index, resource.readIndices());
        entry = { vb: buffer(technical.buffers.vertex, resource.readVertices()), resource };
        model.orientations.set(orientation, entry);
      }
      for (const part of model.source.parts) {
        if (!textures.has(part.texturePath)) throw new Error('Missing settlement texture');
        if (!buckets.has(part.texturePath)) buckets.set(part.texturePath, []);
        buckets.get(part.texturePath).push({ row, part, vb: entry.vb, ib: model.ib });
      }
    }
  } catch (error) {
    try {
      release();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Settlement construction failed');
    }
    throw error;
  }
  return owner;
}
