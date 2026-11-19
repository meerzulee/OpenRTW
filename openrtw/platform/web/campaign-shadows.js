import {
  BufferKind,
  Primitive,
  Fvf,
  Transform,
  RenderState,
  StageState,
  TextureOp,
  TextureArg,
  Blend,
  Compare,
} from '/reference/renderer-bridge.js';

const schema = 'openrtw-campaign-shadow-volume-v1';
const maxVertices = 59999,
  maxIndices = 599997,
  maxInstances = 4096,
  maxGeometryBytes = 32 * 1024 * 1024;
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const stencil = Object.freeze({
  fail: 53,
  zfail: 54,
  pass: 55,
  func: 56,
  ref: 57,
  mask: 58,
  write: 59,
});
const finite = (v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e6;
const vector = (v) => Array.isArray(v) && v.length === 3 && v.every(finite);
const uint = (v) => Number.isInteger(v) && v > 0 && v <= 0xffffffff;

export function campaignShadowSupport(renderer) {
  const caps = renderer.capabilities();
  if (caps.features?.stencil !== true)
    return {
      supported: false,
      reason: 'Campaign shadows require stencil rendering; this renderer advertises stencil:false',
    };
  if (
    caps.features.depth !== true ||
    caps.features.stencilClear !== true ||
    caps.features.campaignShadowZPass !== true ||
    caps.limits?.stencilBits !== 8
  )
    return {
      supported: false,
      reason:
        'Campaign shadows require shared receiver depth, 8-bit stencil clear, and campaignShadowZPass (wrap INCR/DECR, reference-first compare, state restoration)',
    };
  return { supported: true, reason: '' };
}

// This is a decoder for the C++ output, not a second silhouette implementation.
// Copies all caller data before a GPU resource is allocated.
export function campaignShadowGeometry(value) {
  if (
    value?.schema !== schema ||
    ![0, 16384, 32768, 49152].includes(value.yaw) ||
    !Array.isArray(value.positions) ||
    value.positions.length > maxVertices ||
    !Array.isArray(value.indices) ||
    value.indices.length > maxIndices ||
    value.indices.length % 3 ||
    !vector(value.extrusion) ||
    !vector(value.minimum) ||
    !vector(value.maximum)
  )
    throw new Error('Invalid campaign shadow volume publication');
  const vertices = new Uint8Array(value.positions.length * 16),
    vertexView = new DataView(vertices.buffer),
    indices = new Uint8Array(value.indices.length * 2),
    indexView = new DataView(indices.buffer);
  const minimum = [Infinity, Infinity, Infinity],
    maximum = [-Infinity, -Infinity, -Infinity];
  value.positions.forEach((point, i) => {
    if (!vector(point)) throw new Error('Invalid campaign shadow vertex');
    point.forEach((v, k) => {
      vertexView.setFloat32(i * 16 + 4 * k, v, true);
      minimum[k] = Math.min(minimum[k], v);
      maximum[k] = Math.max(maximum[k], v);
    });
    // The volume pass uses ZERO/ONE blending: this colour never alters receivers.
    vertexView.setUint32(i * 16 + 12, 0xffffffff, true);
  });
  value.indices.forEach((v, i) => {
    if (!Number.isInteger(v) || v < 0 || v >= value.positions.length)
      throw new Error('Invalid campaign shadow index');
    indexView.setUint16(i * 2, v, true);
  });
  if (value.positions.length) {
    for (let k = 0; k < 3; k++)
      if (value.minimum[k] !== minimum[k] || value.maximum[k] !== maximum[k])
        throw new Error('Invalid campaign shadow bounds');
  } else if (value.indices.length) throw new Error('Empty campaign shadow has indices');
  return { yaw: value.yaw, vertices, indices, triangles: value.indices.length / 3 };
}

// Join only the supported native culture-model modes to settlement scene rows.
// Visibility stays with the coordinator: use exactly the submitted live or
// remembered model rows. A hidden model must not leak through a shadow.
export function campaignShadowBindings(placement) {
  if (!Array.isArray(placement?.models) || placement.models.length > maxInstances)
    throw new Error('Invalid campaign shadow placement');
  const result = [];
  for (const row of placement.models) {
    if (row.role === 'banner') continue;
    const mode = ['land', 'sea'].includes(row.role)
      ? 3
      : ['buildings', 'wall', 'fort', 'fort_wall', 'watchtower', 'siege', 'blockade'].includes(
            row.role
          )
        ? 1
        : 0;
    const m = row.matrix;
    if (
      !mode ||
      typeof row.path !== 'string' ||
      !row.path.length ||
      !Array.isArray(m) ||
      m.length !== 16 ||
      !m.every(finite)
    )
      throw new Error('Unsupported campaign shadow role or transform');
    const quarter = ((Math.round(Math.atan2(m[8], m[10]) / (Math.PI / 2)) % 4) + 4) % 4;
    const rotations = [
      [1, 0, 0, 1],
      [0, -1, 1, 0],
      [-1, 0, 0, -1],
      [0, 1, -1, 0],
    ];
    const expected = [...identity];
    [expected[0], expected[2], expected[8], expected[10]] = rotations[quarter];
    for (let i = 0; i < 12; i++)
      if (Math.abs(m[i] - expected[i]) > 1e-6)
        throw new Error('Campaign shadows require rigid cardinal placement');
    if (m[15] !== 1 || (mode === 1 && quarter !== 0))
      throw new Error('Unsupported campaign shadow instance yaw');
    result.push({
      key: row.path,
      variant: mode === 1 ? 0 : quarter,
      translation: m.slice(12, 15),
      source: row,
    });
  }
  return result;
}

/** Native static shadow side-wall pass + 0x80000000 fullscreen resolve.
 * `volumes`: Map<path, C++ publication[]> (one yaw or four, in cardinal order).
 * `instances`: campaignShadowBindings result; draw predicate receives source row.
 * `withState`: synchronous backend scope restoring ALL GPU state even on failure,
 * including VIEW/PROJECTION, stream/index, stages, shader and stencil states.
 * Owns buffers only; inherits camera and shared receiver depth, never presents.
 * Older clear-only renderers refuse before allocating any resource.
 */
export function createCampaignShadows({ renderer, volumes, instances, withState }) {
  const support = campaignShadowSupport(renderer);
  if (!support.supported) throw new Error(support.reason);
  if (typeof withState !== 'function')
    throw new Error('Campaign shadows require a state restoration scope');
  if (!(volumes instanceof Map) || !Array.isArray(instances) || instances.length > maxInstances)
    throw new Error('Invalid campaign shadow inventory');
  const geometry = new Map(),
    draws = [],
    buffers = [];
  let totalBytes = 0,
    disposed = false;
  for (const row of instances) {
    if (
      typeof row.key !== 'string' ||
      !Number.isInteger(row.variant) ||
      row.variant < 0 ||
      row.variant > 3 ||
      !vector(row.translation)
    )
      throw new Error('Invalid campaign shadow binding');
    const source = volumes.get(row.key);
    if (!Array.isArray(source) || ![1, 4].includes(source.length) || row.variant >= source.length)
      throw new Error('Missing campaign shadow variant');
    const key = JSON.stringify([row.key, row.variant]);
    if (!geometry.has(key)) {
      const g = campaignShadowGeometry(source[row.variant]);
      if (g.yaw !== row.variant * 16384) throw new Error('Campaign shadow variant yaw mismatch');
      totalBytes += g.vertices.length + g.indices.length;
      if (totalBytes > maxGeometryBytes)
        throw new Error('Campaign shadow inventory exceeds its byte budget');
      geometry.set(key, g);
    }
    const matrix = [...identity];
    matrix.splice(12, 3, ...row.translation);
    draws.push({ key, matrix, source: row.source });
  }
  function release() {
    const errors = [];
    for (const id of buffers.splice(0).reverse())
      try {
        renderer.destroyBuffer(id);
      } catch (e) {
        errors.push(e);
      }
    if (errors.length) throw new AggregateError(errors, 'Campaign shadow cleanup failed');
  }
  function buffer(kind, bytes) {
    const id = renderer.createBuffer({ kind, bytes: bytes.length });
    if (!uint(id)) throw new Error('Invalid campaign shadow buffer');
    buffers.push(id);
    renderer.uploadBuffer(id, bytes);
    return id;
  }
  try {
    for (const g of geometry.values())
      if (g.triangles) {
        g.vb = buffer(BufferKind.VERTEX, g.vertices);
        g.ib = buffer(BufferKind.INDEX16, g.indices);
      }
  } catch (error) {
    try {
      release();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Campaign shadow construction failed');
    }
    throw error;
  }
  return Object.freeze({
    draw({
      width,
      height,
      visible,
      receiverDepthReady,
      cameraOutsideVolumes,
      nearPlaneClearOfVolumes,
      depthCompare,
    }) {
      if (disposed) throw new Error('Campaign shadows are disposed');
      if (
        !uint(width) ||
        !uint(height) ||
        !Number.isInteger(depthCompare) ||
        depthCompare < 1 ||
        depthCompare > 8 ||
        width > 16384 ||
        height > 16384 ||
        typeof visible !== 'function' ||
        receiverDepthReady !== true ||
        cameraOutsideVolumes !== true ||
        nearPlaneClearOfVolumes !== true
      )
        throw new Error(
          'Campaign shadows require receiver depth, explicit visibility, a camera outside the uncapped volumes and a clear near plane'
        );
      const active = draws.filter((row) => visible(row.source) && geometry.get(row.key).triangles);
      if (!active.length) return 0;
      return withState(() => {
        renderer.setVertexProgram?.(0);
        renderer.setMaterialLighting?.({ enabled: false });
        renderer.setDirectionalLighting?.({ enabled: false });
        // This adapter owns the entire stencil attachment for this pass.
        renderer.setRenderState(stencil.write, 0xffffffff);
        renderer.clear({ flags: 4, stencil: 0 });
        for (const state of [
          RenderState.LIGHTING,
          RenderState.FOGENABLE,
          RenderState.SPECULARENABLE,
          RenderState.ALPHATESTENABLE,
        ])
          renderer.setRenderState(state, 0);
        renderer.setRenderState(RenderState.COLORWRITEENABLE, 15);
        renderer.setRenderState(RenderState.ZENABLE, 1);
        renderer.setRenderState(RenderState.ZWRITEENABLE, 0);
        renderer.setRenderState(RenderState.ZFUNC, depthCompare);
        renderer.setRenderState(171, 1); // F46240: BLENDOP ADD
        renderer.setRenderState(RenderState.ALPHABLENDENABLE, 1);
        renderer.setRenderState(RenderState.SRCBLEND, Blend.ZERO);
        renderer.setRenderState(RenderState.DESTBLEND, Blend.ONE);
        renderer.setRenderState(RenderState.STENCILENABLE, 1);
        renderer.setRenderState(stencil.func, Compare.ALWAYS);
        renderer.setRenderState(stencil.fail, 1);
        renderer.setRenderState(stencil.zfail, 1);
        renderer.setRenderState(stencil.ref, 1);
        renderer.setRenderState(stencil.mask, 0xffffffff);
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
        renderer.setFvf(Fvf.XYZ | Fvf.DIFFUSE);
        let count = 0;
        for (const [cull, operation] of [
          [3, 7],
          [2, 8],
        ]) {
          renderer.setRenderState(RenderState.CULLMODE, cull);
          renderer.setRenderState(stencil.pass, operation);
          for (const row of active) {
            const g = geometry.get(row.key);
            renderer.setTransform(Transform.WORLD, row.matrix);
            renderer.setStream(g.vb, 16);
            renderer.setIndices(g.ib, 0);
            renderer.drawIndexed({
              primitive: Primitive.TRIANGLELIST,
              primitiveCount: g.triangles,
            });
            count++;
          }
        }
        renderer.setRenderState(stencil.func, Compare.LESSEQUAL);
        renderer.setRenderState(stencil.pass, 1);
        renderer.setRenderState(RenderState.CULLMODE, 1);
        renderer.setRenderState(RenderState.ZENABLE, 0);
        renderer.setRenderState(RenderState.SRCBLEND, Blend.SRCALPHA);
        renderer.setRenderState(RenderState.DESTBLEND, Blend.INVSRCALPHA);
        renderer.setFvf(Fvf.XYZRHW | Fvf.DIFFUSE);
        const vertices = new Uint8Array(4 * 20),
          view = new DataView(vertices.buffer);
        [
          [-0.5, -0.5],
          [width - 0.5, -0.5],
          [-0.5, height - 0.5],
          [width - 0.5, height - 0.5],
        ].forEach(([x, y], i) => {
          [x, y, 1, 1].forEach((v, k) => view.setFloat32(i * 20 + k * 4, v, true));
          view.setUint32(i * 20 + 16, 0x80000000, true);
        });
        renderer.drawUP({
          vertices,
          vertexStride: 20,
          primitive: Primitive.TRIANGLESTRIP,
          primitiveCount: 2,
        });
        return count;
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      release();
    },
  });
}
