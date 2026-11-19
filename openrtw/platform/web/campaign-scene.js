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
  TextureFormat,
  Address,
  Filter,
} from '/reference/renderer-bridge.js';
import { createGeometryResource, geometryResourceSchema } from '/runtime/geometry-resource.js';
import { createCampaignSettlements } from '/campaign-settlements.js';
import { createTerrainAppearance } from '/terrain-appearance.js';
import { createCampaignWater } from '/campaign-water.js';
import { campaignMovementBoundary, smoothCampaignPath } from '/campaign-travel.js';
import {
  decodeCampaignCameraReference,
  originalInitialCampaignView,
} from '/campaign-camera-reference.js';

// New OpenRTW presentation policy, not an original RTW camera/scale/material or
// traversal rule. X is east, Z is north, Y is up. The default HGT scale is1/1000.
// An explicitly bound native-frame profile supplies observed initial matrices
// and a height scale inferred from six exact world-anchor/HGT matches.
// Other viewport projections and subsequent navigation remain reconstructions.
// Supplied validated static meshes keep raw UVs and a fixed presentation height.
// Source-bound Julii named generals and the retained Hastati prototype fallback
// have separate resources; optional source-bound march frames animate travelling
// generals. Other characters use faction flags. Native animation parity is unproved.
// Optional aerialTerrain (aerial-terrain-pages.js createAerialTerrain) replaces the
// grass/hills land groups AND the base colour strips with native composed
// 32x32-texel cell tiles in 1024x1024 RGBA pages drawn through per-page meshes
// (each terrain triangle once); the UV formula is recovered, page mesh/shade/
// culling and every budget below remain OpenRTW policy. Optional heightOverrides
// (Float32Array (x, y, rawHeight) HGT point triples, the core's native decal
// flattening) replace raw samples before anything reads the height grid.
const defaultHeightScale = 0.001,
  modelHeight = 1.45,
  maxActors = 4096,
  maxDecorVertices = 65536;
// Aerial page budgets (OpenRTW policy): at most maxAerialComposePerFrame
// compose attempts per animation frame (frame token from the descriptor's
// scheduleFrame; per draw without one), a second attempt in a draw only while
// that draw spent under maxAerialComposeMillis composing (so one page per
// frame on real cores, where a page takes 20-40 ms); at most maxAerialPageTextures
// resident page textures beyond the pages in view (least recently visible
// pages are evicted and recompose on demand); a page whose compose or upload
// fails keeps drawing (old texture or grey diffuse) and retries after a
// doubling back-off of aerialRetryBaseDraws..aerialRetryMaxDraws draws.
const maxAerialComposePerFrame = 2,
  maxAerialComposeMillis = 8,
  maxAerialPageTextures = 20,
  aerialRetryBaseDraws = 8,
  aerialRetryMaxDraws = 1024;
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  fov = Math.PI / 4;
const finite = Number.isFinite,
  uint = (v) => Number.isInteger(v) && v >= 0 && v <= 0xffffffff;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const normalize = (a) => {
  const n = Math.hypot(...a);
  if (!finite(n) || n < 1e-12) throw new Error('Degenerate campaign camera');
  return a.map((v) => v / n);
};
const matrix = (a) => Array.from(new Float32Array(a));
const multiply = (a, b) =>
  Array.from({ length: 16 }, (_, i) => {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[(i >> 2) * 4 + k] * b[k * 4 + (i & 3)];
    return s;
  });
const transform = (p, m) =>
  Array.from({ length: 4 }, (_, j) => p.reduce((s, v, i) => s + v * m[i * 4 + j], 0));
function inverse(m) {
  const rows = Array.from({ length: 4 }, (_, i) => [
    ...m.slice(i * 4, i * 4 + 4),
    ...identity.slice(i * 4, i * 4 + 4),
  ]);
  for (let k = 0; k < 4; k++) {
    let pivot = k;
    for (let i = k + 1; i < 4; i++) if (Math.abs(rows[i][k]) > Math.abs(rows[pivot][k])) pivot = i;
    if (Math.abs(rows[pivot][k]) < 1e-12) throw new Error('Singular campaign camera');
    [rows[k], rows[pivot]] = [rows[pivot], rows[k]];
    const d = rows[k][k];
    rows[k] = rows[k].map((v) => v / d);
    for (let i = 0; i < 4; i++)
      if (i !== k) {
        const q = rows[i][k];
        rows[i] = rows[i].map((v, j) => v - q * rows[k][j]);
      }
  }
  return rows.flatMap((row) => row.slice(4));
}
function boxHit(ray, lo, hi) {
  let enter = 0,
    exit = ray.limit;
  for (let k = 0; k < 3; k++) {
    const d = ray.direction[k],
      o = ray.origin[k];
    if (Math.abs(d) < 1e-12) {
      if (o < lo[k] || o > hi[k]) return null;
      continue;
    }
    let a = (lo[k] - o) / d,
      b = (hi[k] - o) / d;
    if (a > b) [a, b] = [b, a];
    enter = Math.max(enter, a);
    exit = Math.min(exit, b);
    if (enter > exit) return null;
  }
  return enter;
}

// Rome projection policy and all metadata stay in this title adapter.
export function createCampaignGeometryResource(geometry, { key = null, sourceSha256 = null } = {}) {
  const upstream = geometry?.resource;
  const upstreamDescriptor = upstream == null ? null : upstream.descriptor;
  if (upstream != null && (typeof upstream !== 'object' || Array.isArray(upstream) ||
      !Object.hasOwn(upstream, 'descriptor') || !upstreamDescriptor ||
      typeof upstreamDescriptor !== 'object' || Array.isArray(upstreamDescriptor)))
    throw TypeError('Invalid upstream campaign geometry resource');
  // Title-owned projection, source fields and attachment policy remain explicit
  // metadata. The device resource only owns the packed bytes; it never scales
  // models or interprets their source basis. Preserve upstream declarations too.
  return createGeometryResource({
    schema: geometryResourceSchema,
    layout: { stride: 24, endianness: 'little', attributes: [
      { semantic: 'position', format: 'f32x3', offset: 0 },
      { semantic: 'color', format: 'd3dcolor-bgra8', offset: 12 },
      { semantic: 'uv0', format: 'f32x2', offset: 16 },
    ] },
    primitive: 'triangle-list', indexFormat: 'uint16-le',
    counts: { vertices: geometry.vertices.length / 24, indices: geometry.indexBytes.length / 2 },
    coordinates: { frame: 'campaign-model-candidate', units: 'title-projection',
      up: 'uninterpreted', handedness: 'uninterpreted' },
    vertexBytes: geometry.vertices, indexBytes: geometry.indexBytes,
    extensions: { 'rome-original.campaign-model-geometry/v1': {
      schema: 'rome-original.campaign-model-geometry/v1', key, sourceSha256,
      sourceMetadata: Object.fromEntries(Object.entries(geometry).filter(
        ([name]) => !['vertices', 'indexBytes', 'resource'].includes(name))),
      upstreamDescriptor,
      presentationPolicy: { modelHeight, scale: 'modelHeight / packed Y extent',
        nativeBasis: 'unproved' },
    } },
  });
}

/** All screen coordinates are canvas backing pixels, not CSS/client pixels.
 * Mutators do not draw. Queries use the last successfully presented camera;
 * the caller draws after pan/orbit/zoom/center/reset and owns all input/RAF.
 * projectCell is a ground-center diagnostic, visible means frustum-only.
 * pickCell intersects the actual sampled terrain triangles. pickActor adds
 * rendered banner planes to the within-cell body volume, stopping at terrain.
 * pickTarget also tests displayed source structure bounds under current sight.
 * These UI volumes do not change rendering, collision or campaign movement.
 */
export function createCampaignScene({
  renderer,
  canvas,
  worldWidth,
  worldHeight,
  terrainWidth,
  terrainHeight,
  heightAt,
  unitGeometry,
  unitTexture = null,
  terrainTextures = null,
  generalModel = null,
  waterTexture = null,
  townAssets = null,
  settlementModels = null,
  settlements = null,
  cameraReference = null,
  aerialTerrain = null,
  heightOverrides = null,
  fog = null,
  coastline = null,
  trees = null,
  banners = null,
}) {
  if (
    !Number.isInteger(worldWidth) ||
    worldWidth < 1 ||
    worldWidth > 255 ||
    !Number.isInteger(worldHeight) ||
    worldHeight < 1 ||
    worldHeight > 156 ||
    terrainWidth !== 2 * worldWidth + 1 ||
    terrainHeight !== 2 * worldHeight + 1 ||
    typeof heightAt !== 'function' ||
    !canvas?.dataset
  )
    throw new TypeError('Unsupported campaign terrain dimensions');
  if (
    fog !== null &&
    (typeof fog.create !== 'function' ||
      typeof fog.extendVertices !== 'function' ||
      typeof fog.visibility?.actorVisible !== 'function' ||
      typeof fog.visibility?.structureKnown !== 'function')
  )
    throw new TypeError('Invalid campaign fog descriptor');
  if (
    coastline !== null &&
    (typeof coastline.create !== 'function' || typeof coastline.buildGeometry !== 'function')
  )
    throw new TypeError('Invalid campaign coastline descriptor');
  if (trees !== null && typeof trees.create !== 'function')
    throw new TypeError('Invalid campaign trees descriptor');
  if (banners !== null && typeof banners.create !== 'function')
    throw new TypeError('Invalid campaign banners descriptor');
  const groundStride = fog ? 32 : 24;
  const groundBytes = (bytes) => (fog ? fog.extendVertices(bytes) : bytes);
  const reference =
    cameraReference === null ? null : decodeCampaignCameraReference(cameraReference);
  if (
    reference &&
    (worldWidth !== 255 || worldHeight !== 156 || terrainWidth !== 511 || terrainHeight !== 313)
  )
    throw new TypeError('Original camera reference requires its source world dimensions');
  const heightScale = reference?.heightScale ?? defaultHeightScale;
  if ((townAssets === null) !== (settlements === null))
    throw new TypeError('Town assets and source bindings must be supplied together');
  const size = () => {
    const w = canvas.width,
      h = canvas.height;
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > 4096 || h > 4096)
      throw new RangeError('Unsupported campaign viewport');
    return { width: w, height: h };
  };
  size();
  const caps = renderer.capabilities();
  if (
    !caps.features?.unlitFvf ||
    !caps.features?.xyz ||
    !caps.features?.depth ||
    !caps.features?.buffers ||
    !caps.indexFormats?.includes(16)
  )
    throw new Error('Renderer cannot display the campaign scene');
  if (
    aerialTerrain !== null &&
    (!aerialTerrain ||
      typeof aerialTerrain !== 'object' ||
      aerialTerrain.pageCells !== 32 ||
      aerialTerrain.pageTexels !== 1024 ||
      aerialTerrain.pagesX !== Math.ceil(worldWidth / 32) ||
      aerialTerrain.pagesY !== Math.ceil(worldHeight / 32) ||
      typeof aerialTerrain.composePage !== 'function' ||
      !['summer', 'winter'].includes(aerialTerrain.season) ||
      aerialTerrain.policy?.id !== 'openrtw-native-aerial-tiles-v1' ||
      ['buildPages', 'frustumPlanes', 'aabbIntersectsFrustum'].some(
        (name) => typeof aerialTerrain[name] !== 'function'
      ) ||
      ((aerialTerrain.seasonalPages ?? null) !== null &&
        (!Array.isArray(aerialTerrain.seasonalPages) ||
          aerialTerrain.seasonalPages.length !== aerialTerrain.pagesX * aerialTerrain.pagesY ||
          aerialTerrain.seasonalPages.some((value) => typeof value !== 'boolean'))) ||
      ((aerialTerrain.clock ?? null) !== null && typeof aerialTerrain.clock !== 'function') ||
      ((aerialTerrain.scheduleFrame ?? null) !== null &&
        typeof aerialTerrain.scheduleFrame !== 'function'))
  )
    throw new TypeError('Invalid aerial terrain descriptor');
  if (
    waterTexture !== null &&
    (typeof waterTexture.create !== 'function' ||
      !waterTexture.metadata ||
      typeof waterTexture.sourceSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(waterTexture.sourceSha256))
  )
    throw new TypeError('Invalid campaign water descriptor');
  const step = 0.5,
    stride = terrainWidth,
    gridWidth = terrainWidth - 1,
    gridHeight = terrainHeight - 1,
    vertexCount = stride * terrainHeight,
    heights = new Float32Array(vertexCount);
  if (
    heightOverrides !== null &&
    (!(heightOverrides instanceof Float32Array) ||
      heightOverrides.length % 3 ||
      heightOverrides.length / 3 > vertexCount)
  )
    throw new TypeError('Invalid terrain height overrides');
  let low = Infinity,
    high = -Infinity;
  // Own every original sample once, including odd cell centres. GPU strips,
  // interpolation and triangle intersections share these final Float32 heights.
  for (let z = 0; z < terrainHeight; z++)
    for (let x = 0; x < terrainWidth; x++) {
      const value = heightAt(x, z);
      if (!finite(value) || Math.abs(value) > 1e6)
        throw new RangeError('HGT height exceeds the finite presentation range');
      heights[z * stride + x] = value * heightScale;
    }
  heightAt = null;
  // Optional (x, y, rawHeight) HGT point triples replace raw samples before any
  // mesh, page, water, picking or model placement reads the grid: the core's
  // port of the native settlement/fort/port/watchtower flattening (9B92B6),
  // scaled like the raw grid. Later triples win. Native also forces the
  // flattened points' normals to (0,1,0); the scene derives its shade from
  // neighbouring heights instead (identical inside the flat disc, an
  // approximation on its rim).
  const overridePoints = heightOverrides === null ? 0 : heightOverrides.length / 3;
  for (let k = 0; k < overridePoints * 3; k += 3) {
    const x = heightOverrides[k],
      z = heightOverrides[k + 1],
      value = heightOverrides[k + 2];
    if (
      !Number.isInteger(x) ||
      !Number.isInteger(z) ||
      x < 0 ||
      z < 0 ||
      x >= terrainWidth ||
      z >= terrainHeight ||
      !finite(value) ||
      Math.abs(value) > 1e6
    )
      throw new RangeError('Terrain height override lies outside the HGT point grid');
    heights[z * stride + x] = value * heightScale;
  }
  const overridesSupplied = heightOverrides !== null;
  heightOverrides = null;
  for (const value of heights) {
    low = Math.min(low, value);
    high = Math.max(high, value);
  }
  function groundSurface(x, z) {
    x = clamp(x, 0, worldWidth);
    z = clamp(z, 0, worldHeight);
    const gx = x / step,
      gz = z / step,
      ix = Math.min(gridWidth - 1, Math.floor(gx)),
      iz = Math.min(gridHeight - 1, Math.floor(gz)),
      u = gx - ix,
      v = gz - iz,
      a = iz * stride + ix;
    return u + v <= 1
      ? heights[a] + u * (heights[a + 1] - heights[a]) + v * (heights[a + stride] - heights[a])
      : heights[a + stride + 1] +
          (1 - u) * (heights[a + stride] - heights[a + stride + 1]) +
          (1 - v) * (heights[a + 1] - heights[a + stride + 1]);
  }
  // Zero is an explicit presentation sea level, not a native traversal rule.
  const surface = (x, z) =>
    waterTexture === null ? groundSurface(x, z) : Math.max(0, groundSurface(x, z));
  const terrainVertices = new Uint8Array(vertexCount * 24),
    terrainView = new DataView(terrainVertices.buffer);
  const write = (view, index, x, y, z, color, u = 0, v = 0) => {
    const at = index * 24;
    view.setFloat32(at, x, true);
    view.setFloat32(at + 4, y, true);
    view.setFloat32(at + 8, z, true);
    view.setUint32(at + 12, color >>> 0, true);
    view.setFloat32(at + 16, u, true);
    view.setFloat32(at + 20, v, true);
  };
  for (let z = 0; z < terrainHeight; z++)
    for (let x = 0; x < terrainWidth; x++) {
      const i = z * stride + x,
        h = heights[i],
        lx = Math.max(0, x - 1),
        rx = Math.min(gridWidth, x + 1),
        sz = Math.max(0, z - 1),
        nz = Math.min(gridHeight, z + 1);
      const left = heights[z * stride + lx],
        right = heights[z * stride + rx],
        south = heights[sz * stride + x],
        north = heights[nz * stride + x];
      const normal = normalize([
          (left - right) / ((rx - lx) * step),
          1,
          (south - north) / ((nz - sz) * step),
        ]),
        light = normalize([-0.4, 0.85, -0.35]),
        shade = 0.55 + 0.45 * Math.max(0, dot(normal, light));
      const t = clamp(h / 6.5, 0, 1),
        d = clamp(-h / 1.4, 0, 1),
        rgb =
          h < 0
            ? [30 - 15 * d, 100 - 55 * d, 155 - 50 * d]
            : [76 + 165 * t, 143 + 80 * t, 70 + 155 * t];
      const channels = rgb.map((c) => Math.round(c * shade)),
        color = (0xff000000 | (channels[0] << 16) | (channels[1] << 8) | channels[2]) >>> 0;
      write(
        terrainView,
        i,
        x * step,
        h,
        z * step,
        color,
        (x * step) / worldWidth,
        (z * step) / worldHeight
      );
    }
  // Original texture bytes cover unchanged source triangles. A continuous
  // vertex weight blends hills over grass; these are presentation coefficients.
  let landVertices = null,
    appearance = null;
  const landCounts = [0, 0];
  if (terrainTextures !== null) {
    if (
      !terrainTextures.grass ||
      !terrainTextures.hills ||
      [terrainTextures.grass, terrainTextures.hills].some(
        (t) =>
          typeof t.create !== 'function' ||
          !t.metadata ||
          !t.presentationPolicy ||
          typeof t.sourceSha256 !== 'string'
      )
    )
      throw new TypeError('Invalid terrain textures');
  }
  // Native aerial pages supersede the grass/hills groups: neither their VBs/IBs
  // nor their textures are created, so no unused land resource is owned.
  if (terrainTextures !== null && aerialTerrain === null) {
    appearance = createTerrainAppearance({
      heights,
      width: terrainWidth,
      height: terrainHeight,
      step,
    });
    landVertices = terrainVertices.slice();
    const view = new DataView(landVertices.buffer);
    for (let z = 0; z < terrainHeight; z++)
      for (let x = 0; x < terrainWidth; x++) {
        const i = z * stride + x;
        view.setUint32(i * 24 + 12, appearance.colors[i], true);
        view.setFloat32(i * 24 + 16, (x * step) / 4, true);
        view.setFloat32(i * 24 + 20, (z * step) / 4, true);
      }
  }
  // Full-grid indices exceed U16. Duplicate only strip boundary rows; every
  // local index remains<=65535. The511x313 source uses127/127/58 quad rows.
  const strips = [],
    maxQuadRows = Math.floor(65536 / stride) - 1;
  for (let startZ = 0; startZ < gridHeight; startZ += maxQuadRows) {
    const quadRows = Math.min(maxQuadRows, gridHeight - startZ),
      rows = quadRows + 1,
      indices = new Uint8Array(gridWidth * quadRows * 6 * 2),
      view = new DataView(indices.buffer),
      buckets = [[], []];
    let at = 0;
    for (let z = 0; z < quadRows; z++)
      for (let x = 0; x < gridWidth; x++) {
        const a = z * stride + x;
        for (const tri of [
          [a, a + stride, a + 1],
          [a + 1, a + stride, a + stride + 1],
        ]) {
          for (const index of tri) {
            view.setUint16(at, index, true);
            at += 2;
          }
          if (landVertices) {
            const sourceIndices = tri.map((index) => index + startZ * stride);
            if (
              waterTexture !== null ||
              sourceIndices.reduce((sum, index) => sum + heights[index], 0) / 3 >= 0
            ) {
              buckets[0].push(...tri);
              if (sourceIndices.some((index) => appearance.hillWeights[index] > 0))
                buckets[1].push(...tri);
            }
          }
        }
      }
    const landIndices = buckets.map((bucket, group) => {
      landCounts[group] += bucket.length / 3;
      if (!bucket.length) return null;
      const bytes = new Uint8Array(bucket.length * 2),
        view = new DataView(bytes.buffer);
      bucket.forEach((index, i) => view.setUint16(i * 2, index, true));
      return bytes;
    });
    const begin = startZ * stride * 24,
      end = (startZ + rows) * stride * 24;
    strips.push({
      startZ,
      quadRows,
      vertices: terrainVertices.slice(begin, end),
      indices,
      landVertices: landVertices?.slice(begin, end) ?? null,
      landIndices,
      landCounts: buckets.map((b) => b.length / 3),
      vb: 0,
      ib: 0,
      landVb: 0,
      landIb: [0, 0],
    });
  }
  // Static per-page meshes reuse the exact scene Float32 heights. Page textures
  // stay lazy: created and composed in draw() only once a page is in view.
  let aerial = null;
  if (aerialTerrain !== null) {
    const built = aerialTerrain.buildPages({
      heights,
      worldWidth,
      worldHeight,
      terrainWidth,
      terrainHeight,
      step,
    });
    if (
      !built ||
      !Array.isArray(built.pages) ||
      built.pages.length !== aerialTerrain.pagesX * aerialTerrain.pagesY
    )
      throw new RangeError('Aerial page geometry disagrees with its page grid');
    const seasonalPages = aerialTerrain.seasonalPages ?? null;
    const pages = built.pages.map((page, index) => {
      if (
        !(page?.vertices instanceof Uint8Array) ||
        page.vertices.length !== page.vertexCount * 24 ||
        !(page.indices instanceof Uint8Array) ||
        page.indices.length !== page.triangleCount * 6 ||
        !page.vertexCount ||
        page.vertexCount > 65536 ||
        !page.triangleCount ||
        ![page.bounds?.min, page.bounds?.max].every(
          (p) => Array.isArray(p) && p.length === 3 && p.every(finite)
        )
      )
        throw new RangeError('Invalid aerial page geometry');
      if (page.pageY * aerialTerrain.pagesX + page.pageX !== index)
        throw new RangeError('Aerial page geometry is not row-major');
      const indexView = new DataView(
        page.indices.buffer,
        page.indices.byteOffset,
        page.indices.byteLength
      );
      for (let k = 0; k < page.triangleCount * 3; k++)
        if (indexView.getUint16(k * 2, true) >= page.vertexCount)
          throw new RangeError('Aerial page index exceeds its vertices');
      return {
        pageX: page.pageX,
        pageY: page.pageY,
        cellsX: page.cellsX,
        cellsY: page.cellsY,
        vertexCount: page.vertexCount,
        triangleCount: page.triangleCount,
        center: [
          (page.bounds.min[0] + page.bounds.max[0]) / 2,
          (page.bounds.min[2] + page.bounds.max[2]) / 2,
        ],
        min: [...page.bounds.min],
        max: [...page.bounds.max],
        vertices: page.vertices.slice(),
        indices: page.indices.slice(),
        vb: 0,
        ib: 0,
        texture: 0,
        season: null,
        visible: false,
        seasonal: seasonalPages ? seasonalPages[index] : true,
        lastVisible: -1,
        failures: 0,
        retryAt: 0,
      };
    });
    const clock =
      aerialTerrain.clock ??
      (typeof globalThis.performance?.now === 'function'
        ? () => globalThis.performance.now()
        : () => Date.now());
    aerial = {
      composePage: aerialTerrain.composePage,
      frustumPlanes: aerialTerrain.frustumPlanes,
      intersects: aerialTerrain.aabbIntersectsFrustum,
      policy: aerialTerrain.policy,
      pagesX: aerialTerrain.pagesX,
      pagesY: aerialTerrain.pagesY,
      pages,
      season: aerialTerrain.season,
      clock,
      scheduleFrame: aerialTerrain.scheduleFrame ?? null,
      pending: 0,
      failed: 0,
      composedLastDraw: 0,
      drawnLastDraw: 0,
      drawnPendingLastDraw: 0,
      composeCount: 0,
      frameComposes: 0,
      frameReset: false,
      drawCount: 0,
      textures: 0,
      evictions: 0,
      failures: 0,
      lastError: null,
    };
    // The base strips are neither uploaded nor drawn: the page meshes carry the
    // identical triangles (built above only for their CPU-side diagnostics).
    for (const strip of strips) {
      strip.vertices = null;
      strip.indices = null;
    }
  }
  const models = new Map();
  function modelRecord(key, geometry, texture, sourceSha256 = null, walkingInput = null) {
    if (
      !(geometry?.vertices instanceof Uint8Array) ||
      geometry.vertices.length % 24 ||
      !(geometry.indexBytes instanceof Uint8Array) ||
      geometry.indexBytes.length % 6 ||
      !Array.isArray(geometry.parts) ||
      !geometry.parts.length ||
      geometry.parts.length > 64 ||
      !Array.isArray(geometry.bounds) ||
      geometry.bounds.length !== 2 ||
      geometry.bounds.some((p) => !Array.isArray(p) || p.length !== 3 || !p.every(finite))
    )
      throw new TypeError('Invalid campaign model geometry');
    const vertexCount = geometry.vertices.length / 24,
      triangles = geometry.indexBytes.length / 6;
    if (
      !vertexCount ||
      vertexCount > 16384 ||
      !triangles ||
      triangles > 32768 ||
      geometry.parts.some(
        (p) =>
          !p ||
          typeof p.name !== 'string' ||
          p.name.length > 255 ||
          !uint(p.vertices) ||
          !p.vertices ||
          !uint(p.triangles) ||
          !p.triangles
      ) ||
      geometry.parts.reduce((n, p) => n + p.vertices, 0) !== vertexCount ||
      geometry.parts.reduce((n, p) => n + p.triangles, 0) !== triangles
    )
      throw new RangeError('Campaign model exceeds geometry bounds');
    if (
      texture !== null &&
      (typeof texture.create !== 'function' ||
        !texture.metadata ||
        typeof texture.sourceSha256 !== 'string' ||
        !texture.presentationPolicy)
    )
      throw new TypeError('Invalid campaign model texture');
    const resource = createCampaignGeometryResource(geometry, { key, sourceSha256 });
    // The current scene's fixed-function stage supports this declared packing.
    if (resource.descriptor.technical.fvf !== (Fvf.XYZ | Fvf.DIFFUSE | Fvf.TEX1))
      throw TypeError('Unsupported campaign model FVF');
    const vertices = resource.readVertices(),
      indices = resource.readIndices(),
      view = new DataView(vertices.buffer),
      indexView = new DataView(indices.buffer);
    let minY = Infinity,
      maxY = -Infinity,
      minX = Infinity,
      maxX = -Infinity;
    for (let i = 0; i < vertexCount; i++) {
      for (const offset of [0, 4, 8, 16, 20])
        if (
          !finite(view.getFloat32(i * 24 + offset, true)) ||
          Math.abs(view.getFloat32(i * 24 + offset, true)) > 100
        )
          throw new RangeError('Invalid normalized campaign model vertex');
      minY = Math.min(minY, view.getFloat32(i * 24 + 4, true));
      maxY = Math.max(maxY, view.getFloat32(i * 24 + 4, true));
      minX = Math.min(minX, view.getFloat32(i * 24, true));
      maxX = Math.max(maxX, view.getFloat32(i * 24, true));
    }
    for (let i = 0; i < triangles * 3; i++)
      if (indexView.getUint16(i * 2, true) >= vertexCount)
        throw new RangeError('Campaign model index exceeds its vertices');
    if (maxY - minY < 1e-6) throw new RangeError('Campaign model has no height');
    const attachment = geometry.bannerAttachment;
    if (
      attachment !== undefined &&
      (attachment.skeletonType !== 4 ||
        !uint(attachment.bone) ||
        !Array.isArray(attachment.point) ||
        attachment.point.length !== 3 ||
        [...attachment.point].some((v) => !finite(v) || Math.abs(v) > 100))
    )
      throw new TypeError('Invalid campaign banner hand attachment');
    let walking = null;
    if (walkingInput !== null) {
      if (
        walkingInput.schema !== 'openrtw-campaign-walking-frames-v1' ||
        walkingInput.sourceSha256 !==
          'eba2096628f2f287ba031dd7faa899010d369242f6c1c9e72c179b4afb7752ed' ||
        !Array.isArray(walkingInput.frames) ||
        walkingInput.frames.length !== 21 ||
        !finite(walkingInput.strideLength) ||
        walkingInput.strideLength < 0.01 ||
        walkingInput.strideLength > 10 ||
        !finite(walkingInput.cycleSeconds) ||
        walkingInput.cycleSeconds <= 0 ||
        walkingInput.cycleSeconds > 10
      )
        throw TypeError('Invalid source walking descriptor');
      const frames = walkingInput.frames.map((frame) => {
        if (
          !(frame?.vertices instanceof Uint8Array) ||
          frame.vertices.length !== vertices.length ||
          !(frame.indexBytes instanceof Uint8Array) ||
          frame.indexBytes.length !== indices.length ||
          frame.indexBytes.some((v, i) => v !== indices[i]) ||
          !Array.isArray(frame.bannerAttachment?.point) ||
          frame.bannerAttachment.point.length !== 3 ||
          frame.bannerAttachment.point.some((v) => !finite(v) || Math.abs(v) > 100)
        )
          throw TypeError('Invalid source walking frame');
        const bytes = new Uint8Array(frame.vertices),
          view = new DataView(bytes.buffer);
        for (let i = 0; i < vertexCount; i++)
          for (const offset of [0, 4, 8, 16, 20])
            if (
              !finite(view.getFloat32(i * 24 + offset, true)) ||
              Math.abs(view.getFloat32(i * 24 + offset, true)) > 100
            )
              throw TypeError('Invalid source walking vertex');
        return { bytes, view, bannerPoint: [...frame.bannerAttachment.point] };
      });
      walking = {
        frames,
        strideLength: walkingInput.strideLength,
        cycleSeconds: walkingInput.cycleSeconds,
        actorBuffers: new Map(),
        vb: 0,
      };
    }
    return {
      key,
      resource,
      vertices,
      indices,
      view,
      vertexCount,
      triangles,
      parts: geometry.parts.length,
      minY,
      scale: modelHeight / (maxY - minY),
      bannerPoint: attachment ? [...attachment.point] : null,
      bodyBoundsX: [minX, maxX],
      texture,
      sourceSha256,
      textureOwner: null,
      vb: 0,
      ib: 0,
      walking,
    };
  }
  // The old candidate remains an explicit prototype fallback, independently of
  // the source-bound campaign general. Neither may borrow another model's GPU state.
  models.set('hastati-candidate', modelRecord('hastati-candidate', unitGeometry, unitTexture));
  if (generalModel !== null) {
    if (
      !generalModel ||
      !generalModel.texture ||
      typeof generalModel.sourceSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(generalModel.sourceSha256)
    )
      throw new TypeError('Invalid campaign general descriptor');
    models.set(
      'roman-general-julii',
      modelRecord(
        'roman-general-julii',
        generalModel.geometry,
        generalModel.texture,
        generalModel.sourceSha256,
        generalModel.walking ?? null
      )
    );
  }
  const modelFvf = models.get('hastati-candidate').resource.descriptor.technical.fvf;
  const maxDistance = Math.max(80, Math.hypot(worldWidth, worldHeight) * 2.2);
  let focusX,
    focusZ,
    yaw,
    pitch,
    distance,
    referencePose = false,
    disposed = false,
    lastFrame = null,
    lastActors = [];
  function resetCamera() {
    if (reference) {
      const c = originalInitialCampaignView.inferredCamera;
      [focusX, , focusZ] = c.focus;
      yaw = c.yawRadians;
      pitch = c.pitchRadians;
      distance = c.distance;
      referencePose = true;
    } else {
      focusX = Math.min(89, worldWidth - 1) + 0.5;
      focusZ = Math.min(82, worldHeight - 1) + 0.5;
      yaw = 0;
      pitch = 0.9;
      distance = 22;
    }
  }
  resetCamera();
  const alive = () => {
    if (disposed) throw new Error('Campaign scene is disposed');
  };
  function camera() {
    const viewport = size(),
      focus = [focusX, reference ? 0 : surface(focusX, focusZ), focusZ],
      s = Math.sin(pitch),
      c = Math.cos(pitch);
    const eye = [
      focusX + Math.sin(yaw) * distance * c,
      focus[1] + distance * s,
      focusZ - Math.cos(yaw) * distance * c,
    ];
    const forward = normalize(focus.map((v, k) => v - eye[k])),
      right = normalize(cross([0, 1, 0], forward)),
      up = cross(forward, right);
    const view = referencePose
      ? Array.from(reference.view)
      : matrix([
          right[0],
          up[0],
          forward[0],
          0,
          right[1],
          up[1],
          forward[1],
          0,
          right[2],
          up[2],
          forward[2],
          0,
          -dot(right, eye),
          -dot(up, eye),
          -dot(forward, eye),
          1,
        ]);
    const near = 0.1,
      far = Math.max(2048, maxDistance * 4 + high - low),
      ys = 1 / Math.tan(fov / 2),
      xs = ys / (viewport.width / viewport.height);
    const referenceProjection =
      referencePose &&
      viewport.width === reference.viewport.width &&
      viewport.height === reference.viewport.height;
    const projection = referenceProjection
      ? Array.from(reference.projection)
      : matrix([
          xs,
          0,
          0,
          0,
          0,
          ys,
          0,
          0,
          0,
          0,
          far / (far - near),
          1,
          0,
          0,
          (-near * far) / (far - near),
          0,
        ]);
    const combined = multiply(view, projection);
    return {
      ...viewport,
      view,
      projection,
      combined,
      inverse: inverse(combined),
      focus,
      eye,
      yaw,
      pitch,
      distance,
      referencePose,
      referenceProjection,
    };
  }
  function project(frame, x, y, z) {
    const p = transform([x, y, z, 1], frame.combined);
    if (Math.abs(p[3]) < 1e-8) return { px: null, py: null, depth: null, visible: false };
    // The existing shader flips clip-Y; present() flips the backbuffer again.
    // Its +1/viewport clip shift gives +0.5 displayed pixels on both axes.
    const px = ((p[0] / p[3] + 1) * frame.width) / 2 + 0.5,
      py = ((1 - p[1] / p[3]) * frame.height) / 2 + 0.5,
      depth = p[2] / p[3];
    return {
      px,
      py,
      depth,
      visible:
        p[3] > 0 &&
        depth >= 0 &&
        depth <= 1 &&
        px >= 0 &&
        py >= 0 &&
        px < frame.width &&
        py < frame.height,
    };
  }
  function rayFor(px, py, frame = lastFrame ?? camera()) {
    if (!finite(px) || !finite(py)) return null;
    if (px < 0 || py < 0 || px >= frame.width || py >= frame.height) return null;
    const nx = (2 * (px - 0.5)) / frame.width - 1,
      ny = 1 - (2 * (py - 0.5)) / frame.height;
    const unpack = (z) => {
      const p = transform([nx, ny, z, 1], frame.inverse);
      if (Math.abs(p[3]) < 1e-12) throw new Error('Invalid campaign pick ray');
      return p.slice(0, 3).map((v) => v / p[3]);
    };
    const origin = unpack(0),
      end = unpack(1),
      delta = end.map((v, k) => v - origin[k]);
    return { origin, direction: normalize(delta), limit: Math.hypot(...delta) };
  }
  const pickCounters = { terrainQueries: 0, terrainCells: 0, triangleTests: 0, cacheHits: 0 };
  let pickCache = null;
  function terrainHit(ray) {
    pickCounters.terrainQueries++;
    pickCounters.terrainCells = pickCounters.triangleTests = 0;
    if (!ray) return null;
    const { origin: o, direction: d } = ray;
    let enter = 0,
      exit = ray.limit;
    const bounds = [
      [0, low, 0],
      [worldWidth, high, worldHeight],
    ];
    for (let axis = 0; axis < 3; axis++) {
      if (Math.abs(d[axis]) < 1e-12) {
        if (o[axis] < bounds[0][axis] || o[axis] > bounds[1][axis]) return null;
      } else {
        let a = (bounds[0][axis] - o[axis]) / d[axis],
          b = (bounds[1][axis] - o[axis]) / d[axis];
        if (a > b) [a, b] = [b, a];
        enter = Math.max(enter, a);
        exit = Math.min(exit, b);
        if (enter > exit) return null;
      }
    }
    let nearest = ray.limit,
      found = false;
    // Walk the regular half-cell lattice in ray order, rather than scanning
    // the whole world. Every visited cell keeps its original two triangles.
    // Moller-Trumbore is two-sided to agree with the disabled cull state.
    function triangle(a, b, c) {
      pickCounters.triangleTests++;
      const ax = (a % stride) * step,
        az = Math.floor(a / stride) * step,
        ay = heights[a],
        bx = (b % stride) * step,
        bz = Math.floor(b / stride) * step,
        by = heights[b],
        cx = (c % stride) * step,
        cz = Math.floor(c / stride) * step,
        cy = heights[c];
      const e1x = bx - ax,
        e1y = by - ay,
        e1z = bz - az,
        e2x = cx - ax,
        e2y = cy - ay,
        e2z = cz - az;
      const px = d[1] * e2z - d[2] * e2y,
        py = d[2] * e2x - d[0] * e2z,
        pz = d[0] * e2y - d[1] * e2x,
        det = e1x * px + e1y * py + e1z * pz;
      if (Math.abs(det) < 1e-10) return;
      const inv = 1 / det,
        tx = o[0] - ax,
        ty = o[1] - ay,
        tz = o[2] - az,
        u = (tx * px + ty * py + tz * pz) * inv;
      if (u < -1e-8 || u > 1 + 1e-8) return;
      const qx = ty * e1z - tz * e1y,
        qy = tz * e1x - tx * e1z,
        qz = tx * e1y - ty * e1x,
        v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
      if (v < -1e-8 || u + v > 1 + 1e-8) return;
      const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (t >= 0 && t <= nearest) {
        nearest = t;
        found = true;
      }
    }
    const axisCell = (axis, count) => {
      const q = (o[axis] + enter * d[axis]) / step;
      return clamp(d[axis] < 0 ? Math.ceil(q) - 1 : Math.floor(q), 0, count - 1);
    };
    let x = axisCell(0, gridWidth),
      z = axisCell(2, gridHeight);
    const sx = Math.abs(d[0]) < 1e-12 ? 0 : Math.sign(d[0]),
      sz = Math.abs(d[2]) < 1e-12 ? 0 : Math.sign(d[2]),
      deltaX = sx ? step / Math.abs(d[0]) : Infinity,
      deltaZ = sz ? step / Math.abs(d[2]) : Infinity;
    let nextX = sx ? Math.max(enter, ((x + (sx > 0 ? 1 : 0)) * step - o[0]) / d[0]) : Infinity,
      nextZ = sz ? Math.max(enter, ((z + (sz > 0 ? 1 : 0)) * step - o[2]) / d[2]) : Infinity;
    for (let visited = 0; visited <= gridWidth + gridHeight; visited++) {
      if (x < 0 || z < 0 || x >= gridWidth || z >= gridHeight) break;
      pickCounters.terrainCells++;
      const a = z * stride + x;
      triangle(a, a + stride, a + 1);
      triangle(a + 1, a + stride, a + stride + 1);
      const boundary = Math.min(nextX, nextZ, exit);
      if ((found && nearest <= boundary + 1e-7) || boundary >= exit) break;
      const crossX = nextX <= nextZ + 1e-10,
        crossZ = nextZ <= nextX + 1e-10;
      if (crossX) {
        x += sx;
        nextX += deltaX;
      }
      if (crossZ) {
        z += sz;
        nextZ += deltaZ;
      }
    }
    return found ? { t: nearest, x: o[0] + nearest * d[0], z: o[2] + nearest * d[2] } : null;
  }
  function visibleHit(ray) {
    const ground = terrainHit(ray);
    if (waterTexture === null || !ray || Math.abs(ray.direction[1]) < 1e-12) return ground;
    const t = -ray.origin[1] / ray.direction[1];
    if (t < 0 || t > ray.limit || (ground && t > ground.t + 1e-7)) return ground;
    const x = ray.origin[0] + t * ray.direction[0],
      z = ray.origin[2] + t * ray.direction[2];
    return x >= 0 && x <= worldWidth && z >= 0 && z <= worldHeight ? { t, x, z } : ground;
  }
  function pickQuery(px, py) {
    alive();
    const frame = lastFrame ?? camera();
    if (pickCache?.frame === frame && pickCache.px === px && pickCache.py === py) {
      pickCounters.cacheHits++;
      return pickCache;
    }
    const ray = rayFor(px, py, frame),
      ground = visibleHit(ray),
      cell = ground
        ? {
            x: clamp(Math.floor(ground.x), 0, worldWidth - 1),
            y: clamp(Math.floor(ground.z), 0, worldHeight - 1),
          }
        : null;
    return (pickCache = { frame, px, py, ray, ground, cell });
  }
  function pickCell(px, py) {
    const { cell } = pickQuery(px, py);
    return cell ? { ...cell } : null;
  }
  function projectCell(x, y) {
    alive();
    if (
      !Number.isInteger(x) ||
      !Number.isInteger(y) ||
      x < 0 ||
      y < 0 ||
      x >= worldWidth ||
      y >= worldHeight
    )
      return null;
    return { x, y, ...project(lastFrame ?? camera(), x + 0.5, surface(x + 0.5, y + 0.5), y + 0.5) };
  }
  function shapeHit(ray, shape) {
    let nearest = shape.bounds ? boxHit(ray, shape.bounds[0], shape.bounds[1]) : null;
    for (const q of shape.quads ?? [])
      for (const indices of [
        [0, 1, 2],
        [1, 3, 2],
      ]) {
        const [a, b, c] = indices.map((i) => q[i]),
          e1 = b.map((v, k) => v - a[k]),
          e2 = c.map((v, k) => v - a[k]),
          p = cross(ray.direction, e2),
          det = dot(e1, p);
        if (Math.abs(det) < 1e-10) continue;
        const offset = ray.origin.map((v, k) => v - a[k]),
          u = dot(offset, p) / det,
          vq = cross(offset, e1),
          v = dot(ray.direction, vq) / det,
          t = dot(e2, vq) / det;
        if (u >= -1e-8 && v >= -1e-8 && u + v <= 1 + 1e-8 && t >= 0 && t <= ray.limit)
          nearest = nearest === null ? t : Math.min(nearest, t);
      }
    return nearest;
  }
  const currentSight = (x, y) => !fog || fog.visibility.actorVisible(x, y) === true;
  function actorHit({ ray, ground }) {
    if (!ray) return null;
    let nearest = ground ? ground.t + 1e-5 : ray.limit,
      chosen = null;
    const actorsById = new Map(lastActors.map((actor) => [actor.id, actor]));
    function consider(actor, t, hitPart) {
      if (
        t !== null &&
        currentSight(actor.x, actor.y) &&
        (t < nearest - 1e-7 ||
          (Math.abs(t - nearest) <= 1e-7 && (chosen === null || actor.id < chosen.id)))
      ) {
        nearest = t;
        chosen = {
          kind: 'character',
          id: actor.id,
          actorId: actor.id,
          x: actor.x,
          y: actor.y,
          distance: t,
          hitPart,
        };
      }
    }
    // A conservative body volume, contained inside the actor's source cell.
    // No screen-radius fallback; outstretched model arms are not collision data.
    for (const actor of lastActors) {
      const x = actor.visualX + 0.5,
        z = actor.visualY + 0.5,
        y = actor.footY;
      const c = Math.cos(actor.heading),
        s = Math.sin(actor.heading),
        ox = ray.origin[0] - x,
        oz = ray.origin[2] - z,
        localRay = {
          ...ray,
          origin: [c * ox - s * oz, ray.origin[1] - y, s * ox + c * oz],
          direction: [
            c * ray.direction[0] - s * ray.direction[2],
            ray.direction[1],
            s * ray.direction[0] + c * ray.direction[2],
          ],
        };
      const t = boxHit(localRay, [-0.3, 0, -0.3], [0.3, modelHeight, 0.3]);
      consider(actor, t, 'body');
    }
    // Source cloth/emblem planes follow the exact same hand or prototype
    // placement as the presented draw. This is UI hit geometry, not collision.
    for (const shape of bannerOwner?.hitTargets?.(lastActors) ?? []) {
      const actor = actorsById.get(shape.id);
      if (actor && currentSight(actor.x, actor.y)) consider(actor, shapeHit(ray, shape), 'banner');
    }
    return chosen;
  }
  function pickActor(px, py) {
    return actorHit(pickQuery(px, py))?.id ?? null;
  }
  function pickTarget(px, py) {
    const query = pickQuery(px, py);
    if (!query.ray) return null;
    let chosen = actorHit(query),
      nearest = chosen?.distance ?? (query.ground ? query.ground.t + 1e-5 : query.ray.limit);
    for (const shape of townOwner?.hitTargets?.(query.frame.combined) ?? []) {
      if (!currentSight(shape.x, shape.y)) continue;
      const t = shapeHit(query.ray, shape);
      if (
        t !== null &&
        (t < nearest - 1e-7 ||
          (Math.abs(t - nearest) <= 1e-7 &&
            chosen?.kind !== 'character' &&
            (chosen === null || shape.objectId < chosen.objectId)))
      ) {
        nearest = t;
        chosen = {
          kind: shape.kind,
          objectId: shape.objectId,
          region: shape.region,
          x: shape.x,
          y: shape.y,
          distance: t,
          hitPart: 'structure',
        };
      }
    }
    return (
      chosen ??
      (query.cell
        ? { kind: 'ground', ...query.cell, distance: query.ground.t, hitPart: 'ground' }
        : null)
    );
  }
  function pickCandidates(frame, actors) {
    const candidates = [],
      byId = new Map(actors.map((actor) => [actor.id, actor]));
    const add = (point, details) => {
      if (candidates.length >= maxActors) return;
      const p = project(frame, ...point);
      if (p.visible) candidates.push({ ...details, px: p.px, py: p.py });
    };
    for (const shape of bannerOwner?.hitTargets?.(actors) ?? []) {
      const actor = byId.get(shape.id);
      if (!actor || !currentSight(actor.x, actor.y)) continue;
      for (const quad of shape.quads ?? [])
        for (const fraction of [0.2, 0.5, 0.8])
          add(
            [0, 1, 2].map(
              (axis) =>
                ((quad[0][axis] + quad[1][axis]) * (1 - fraction) +
                  (quad[2][axis] + quad[3][axis]) * fraction) /
                2
            ),
            { kind: 'banner', actorId: actor.id }
          );
    }
    for (const shape of townOwner?.hitTargets?.(frame.combined) ?? [])
      if (shape.kind === 'port' && currentSight(shape.x, shape.y) && shape.bounds)
        add(
          shape.bounds[0].map((value, axis) => (value + shape.bounds[1][axis]) / 2),
          { kind: 'port', objectId: shape.objectId, region: shape.region }
        );
    return JSON.stringify(candidates);
  }
  const textureWire =
    unitTexture === null
      ? null
      : JSON.stringify({
          metadata: unitTexture.metadata,
          sourceSha256: unitTexture.sourceSha256,
          presentationPolicy: unitTexture.presentationPolicy,
        });
  const terrainWire =
    terrainTextures === null || aerial
      ? null
      : JSON.stringify({
          grass: {
            metadata: terrainTextures.grass.metadata,
            sourceSha256: terrainTextures.grass.sourceSha256,
          },
          hills: {
            metadata: terrainTextures.hills.metadata,
            sourceSha256: terrainTextures.hills.sourceSha256,
          },
          presentationPolicy: terrainTextures.grass.presentationPolicy,
          appearance: appearance.metadata,
          blendPolicy: 'opaque-grass-base-with-continuous-hills-overlay',
          coveragePolicy:
            waterTexture === null
              ? 'triangle-mean-height>=0-with-blue-ground-fallback'
              : 'complete-ground-depth-clipped-by-sea-level0-plane',
          sampleStep: step,
          triangles: { grass: landCounts[0], hills: landCounts[1] },
        });
  // The aerial wire keeps the supplied grass/hills identities (unused here) and
  // adds the dynamic page state; without aerialTerrain the wire is unchanged.
  const aerialWireBase = aerial
    ? JSON.parse(
        JSON.stringify({
          ...(terrainTextures
            ? {
                grass: {
                  metadata: terrainTextures.grass.metadata,
                  sourceSha256: terrainTextures.grass.sourceSha256,
                },
                hills: {
                  metadata: terrainTextures.hills.metadata,
                  sourceSha256: terrainTextures.hills.sourceSha256,
                },
                presentationPolicy: terrainTextures.grass.presentationPolicy,
              }
            : {}),
          landGroups: 'superseded-by-native-aerial-pages',
          sampleStep: step,
          aerialPolicy: {
            id: aerial.policy.id,
            uv: aerial.policy.uv,
            diffuse: aerial.policy.diffuse,
            culling: aerial.policy.culling,
            texture: aerial.policy.texture,
          },
        })
      )
    : null;
  function aerialCounts() {
    let composed = 0,
      stale = 0;
    for (const page of aerial.pages)
      if (page.texture) {
        if (page.season === aerial.season) composed++;
        else stale++;
      }
    return { composed, stale };
  }
  function aerialWire() {
    const { composed, stale } = aerialCounts();
    return JSON.stringify({
      ...aerialWireBase,
      aerial: {
        policy: aerial.policy.id,
        pageCells: 32,
        pageTexels: 1024,
        pagesX: aerial.pagesX,
        pagesY: aerial.pagesY,
        pages: aerial.pages.length,
        season: aerial.season,
        seasonalPages: aerial.pages.filter((page) => page.seasonal).length,
        composed,
        stale,
        pending: aerial.pending,
        failed: aerial.failed,
        composedThisDraw: aerial.composedLastDraw,
        drawnPages: aerial.drawnLastDraw,
        drawnPendingPages: aerial.drawnPendingLastDraw,
        maxComposePerFrame: maxAerialComposePerFrame,
        composeMillisBudget: maxAerialComposeMillis,
        frameBudget: aerial.scheduleFrame ? 'animation-frame' : 'draw',
        totalComposes: aerial.composeCount,
        textures: aerial.textures,
        maxTextures: maxAerialPageTextures,
        evicted: aerial.evictions,
        failures: aerial.failures,
        lastError: aerial.lastError,
      },
    });
  }
  // A first compose creates the page texture; a stale page keeps drawing its
  // previous texture until the new season's pixels replace its only level.
  function composeAerialPage(page) {
    const pixels = aerial.composePage(page.pageX, page.pageY, aerial.season === 'winter');
    if (!(pixels instanceof Uint8Array) || pixels.length !== 1024 * 1024 * 4)
      throw new RangeError('Aerial page compose returned an invalid RGBA span');
    if (!page.texture) {
      const id = renderer.createTexture({
        width: 1024,
        height: 1024,
        levels: 1,
        format: TextureFormat.RGBA8,
      });
      if (!uint(id) || !id) throw new Error('Invalid aerial page texture handle');
      page.texture = id;
      aerial.textures++;
      try {
        renderer.uploadTexture(id, 0, pixels, { rowPitch: 1024 * 4 });
      } catch (error) {
        page.texture = 0;
        aerial.textures--;
        try {
          renderer.destroyTexture(id);
        } catch (cleanup) {
          throw new AggregateError([error, cleanup], 'Aerial page texture creation failed');
        }
        throw error;
      }
    } else renderer.uploadTexture(page.texture, 0, pixels, { rowPitch: 1024 * 4 });
    page.season = aerial.season;
    aerial.composeCount++;
  }
  // The per-frame budget: attempts accumulate until the scheduled animation
  // frame callback runs (callbacks registered during a frame run in order in
  // the next one, so every draw of that next frame sees a fresh budget).
  function noteAerialAttempts(count) {
    aerial.frameComposes += count;
    if (aerial.scheduleFrame && !aerial.frameReset) {
      aerial.frameReset = true;
      aerial.scheduleFrame(() => {
        aerial.frameReset = false;
        aerial.frameComposes = 0;
      });
    }
  }
  function updateAerial(frame) {
    aerial.drawCount++;
    const planes = aerial.frustumPlanes(frame.combined),
      wanted = [],
      distance = (page) =>
        Math.hypot(page.center[0] - frame.focus[0], page.center[1] - frame.focus[2]);
    let failed = 0;
    for (const page of aerial.pages) {
      page.visible = aerial.intersects(planes, page.min, page.max);
      if (!page.visible) continue;
      page.lastVisible = aerial.drawCount;
      if (page.season !== aerial.season) {
        if (page.retryAt > aerial.drawCount) failed++;
        else wanted.push(page);
      }
    }
    // Nearest to the focus first; at most the frame budget, the next attempt
    // only while the compose time spent in this draw is under the budget.
    wanted.sort((a, b) => distance(a) - distance(b) || a.pageY - b.pageY || a.pageX - b.pageX);
    const allowed = aerial.scheduleFrame
      ? Math.max(0, maxAerialComposePerFrame - aerial.frameComposes)
      : maxAerialComposePerFrame;
    const start = aerial.clock();
    let attempted = 0,
      composed = 0;
    for (const page of wanted) {
      if (attempted >= allowed || (attempted && aerial.clock() - start >= maxAerialComposeMillis))
        break;
      attempted++;
      try {
        composeAerialPage(page);
        composed++;
        page.failures = 0;
        page.retryAt = 0;
      } catch (error) {
        // A refused compose or a failed texture create/upload keeps the page
        // drawing (old texture or grey diffuse) and retries after a back-off.
        page.failures++;
        page.retryAt =
          aerial.drawCount +
          Math.min(aerialRetryMaxDraws, aerialRetryBaseDraws << Math.min(page.failures - 1, 7));
        aerial.failures++;
        aerial.lastError = String(error?.message ?? error);
        failed++;
      }
    }
    if (attempted) noteAerialAttempts(attempted);
    aerial.composedLastDraw = composed;
    aerial.pending = wanted.length - attempted;
    aerial.failed = failed;
    // Least-recently-visible eviction of pages outside the view; pages in view
    // always keep their texture (a fully zoomed-out view may exceed the cap).
    if (aerial.textures > maxAerialPageTextures) {
      const idle = aerial.pages
        .filter((page) => page.texture && !page.visible)
        .sort((a, b) => a.lastVisible - b.lastVisible || a.pageY - b.pageY || a.pageX - b.pageX);
      for (const page of idle) {
        if (aerial.textures <= maxAerialPageTextures) break;
        const texture = page.texture;
        page.texture = 0;
        page.season = null;
        aerial.textures--;
        aerial.evictions++;
        renderer.destroyTexture(texture);
      }
    }
  }
  const waterGeometry =
    waterTexture === null
      ? null
      : createCampaignWater({ worldWidth, worldHeight, groundAt: groundSurface });
  const coastGeometry =
    coastline?.buildGeometry({ worldWidth, worldHeight, groundAt: groundSurface }) ?? null;
  if (
    coastGeometry !== null &&
    (!Array.isArray(coastGeometry.strips) ||
      coastGeometry.strips.length > 128 ||
      coastGeometry.strips.some(
        (s) =>
          !(s.vertices instanceof Uint8Array) ||
          !(s.indexBytes instanceof Uint8Array) ||
          !Number.isInteger(s.vertexCount) ||
          s.vertexCount < 1 ||
          s.vertexCount > 65536 ||
          s.vertices.length !== s.vertexCount * 24 ||
          !Number.isInteger(s.triangleCount) ||
          s.triangleCount < 1 ||
          s.indexBytes.length !== s.triangleCount * 6
      ))
  )
    throw new TypeError('Invalid campaign coastline geometry');
  const waterWire =
    waterTexture === null
      ? null
      : JSON.stringify({
          metadata: waterTexture.metadata,
          sourceSha256: waterTexture.sourceSha256,
          presentationPolicy: {
            ...(waterTexture.presentationPolicy?.id === 'openrtw-original-water-display-v3'
              ? {
                  ...waterGeometry.metadata.presentationPolicy,
                  anchor: 'max(full-grid-ground,0)',
                  detailOpacityBytes: [48, 32],
                  materialPolicy: waterTexture.presentationPolicy,
                  surf: waterTexture.surf ?? null,
                }
              : {
                  ...waterGeometry.metadata.presentationPolicy,
                  id: 'openrtw-calm-water-presentation-v1',
                  geometryPolicy: waterGeometry.metadata.presentationPolicy.id,
                  anchor: 'max(full-grid-ground,0)',
                  color: 'depth-diffuse-times(191/255+64/255*original-water-texture)',
                  textureMix: 64 / 255,
                  depthColorMix: 191 / 255,
                }),
          },
          geometry: waterGeometry.metadata,
          texturePolicy: waterTexture.presentationPolicy ?? null,
        });
  const modelMetadata = JSON.parse(
    JSON.stringify(
      [...models.values()].map((m) => ({
        key: m.key,
        vertices: m.vertexCount,
        triangles: m.triangles,
        parts: m.parts,
        walking: m.walking
          ? {
              frameCount: m.walking.frames.length,
              strideLength: m.walking.strideLength,
              cycleSeconds: m.walking.cycleSeconds,
              nativeAnimation: false,
            }
          : null,
        sourceSha256: m.sourceSha256,
        texture: m.texture
          ? {
              metadata: m.texture.metadata,
              sourceSha256: m.texture.sourceSha256,
              presentationPolicy: m.texture.presentationPolicy,
            }
          : null,
      }))
    )
  );
  const owned = [],
    terrainOwners = [null, null];
  const stagedOwners = new Set(),
    consumedStaged = new WeakSet();
  let waterOwner = null,
    townOwner = null,
    shadowScene = null,
    townWire = null,
    fogOwner = null,
    coastOwner = null,
    treeOwner = null,
    bannerOwner = null;
  let movementInput = null,
    movementFogRevision = null,
    movementSelection = null,
    movementBuffers = [],
    movementCellCount = 0,
    movementVertexCount = 0,
    movementBuilds = 0;
  function releaseMovementBuffers(buffers = movementBuffers) {
    const failures = [];
    for (const entry of buffers)
      try {
        renderer.destroyBuffer(entry.vb);
      } catch (error) {
        failures.push(error);
      }
    return failures;
  }
  function release() {
    const failures = [];
    failures.push(...releaseMovementBuffers());
    movementBuffers = [];
    movementInput = null;
    // Staged live-refresh owners were never published. Retire their shadow
    // reader before its town owner, exactly like the published pair below.
    for (const staged of stagedOwners) {
      consumedStaged.add(staged);
      if (staged.shadow)
        try {
          staged.shadow.dispose();
        } catch (error) {
          failures.push(error);
        }
      try {
        staged.town.dispose();
      } catch (error) {
        failures.push(error);
      }
    }
    stagedOwners.clear();
    for (const extra of [coastOwner, treeOwner, bannerOwner])
      if (extra) {
        try {
          extra.dispose();
        } catch (error) {
          failures.push(error);
        }
      }
    coastOwner = treeOwner = bannerOwner = null;
    const fogTexture = fogOwner;
    fogOwner = null;
    if (fogTexture)
      try {
        fogTexture.dispose();
      } catch (error) {
        failures.push(error);
      }
    // Release the optional shadow owner before the settlement owner it reads.
    const shadows = shadowScene;
    shadowScene = null;
    try {
      delete canvas.dataset.campaignShadows;
    } catch (error) {
      failures.push(error);
    }
    if (shadows)
      try {
        shadows.dispose();
      } catch (error) {
        failures.push(error);
      }
    const towns = townOwner;
    townOwner = null;
    if (towns)
      try {
        towns.dispose();
      } catch (error) {
        failures.push(error);
      }
    for (const model of models.values()) {
      model.resource = model.vertices = model.indices = model.view = null;
      if (model.walking) {
        model.walking.frames = [];
        model.walking.actorBuffers.clear();
      }
      const texture = model.textureOwner;
      model.textureOwner = null;
      if (texture)
        try {
          texture.dispose();
        } catch (error) {
          failures.push(error);
        }
    }
    models.clear();
    for (let i = 0; i < terrainOwners.length; i++) {
      const texture = terrainOwners[i];
      terrainOwners[i] = null;
      if (texture)
        try {
          texture.dispose();
        } catch (error) {
          failures.push(error);
        }
    }
    if (aerial) {
      aerial.textures = 0;
      for (const page of aerial.pages) {
        const texture = page.texture;
        page.texture = 0;
        page.season = null;
        if (texture)
          try {
            renderer.destroyTexture(texture);
          } catch (error) {
            failures.push(error);
          }
      }
    }
    const water = waterOwner;
    waterOwner = null;
    if (water)
      try {
        water.dispose();
      } catch (error) {
        failures.push(error);
      }
    for (let i = owned.length - 1; i >= 0; i--) {
      const id = owned[i];
      owned[i] = 0;
      if (id)
        try {
          renderer.destroyBuffer(id);
        } catch (error) {
          failures.push(error);
        }
    }
    if (failures.length)
      throw new AggregateError(failures, 'Campaign scene resource cleanup failed');
  }
  // Atomic live-refresh ownership. A caller admits CPU-side assets, then stages
  // the candidate town/shadow owners here before publication. Construction and
  // validation failures retire the staged pair immediately and leave the
  // current presentation untouched; commit swaps both owners in one synchronous
  // step and retires the old shadow reader before the old town owner.
  function validSettlementTown(owner) {
    return Boolean(
      owner &&
        typeof owner.draw === 'function' &&
        typeof owner.dispose === 'function' &&
        Array.isArray(owner.bindings)
    );
  }
  function validSettlementShadow(owner) {
    return Boolean(
      owner &&
        typeof owner.draw === 'function' &&
        typeof owner.dispose === 'function' &&
        typeof owner.status === 'function'
    );
  }
  function stageSettlementOwners({ create, createShadows, wire } = {}) {
    alive();
    if (typeof create !== 'function') throw new TypeError('Invalid settlement owner factory');
    if (createShadows !== undefined && typeof createShadows !== 'function')
      throw new TypeError('Invalid campaign shadow scene factory');
    const staged = { town: null, shadow: null, wire: null };
    try {
      staged.town = create(renderer);
      if (!validSettlementTown(staged.town))
        throw new TypeError('Invalid campaign settlement scene');
      if (createShadows !== undefined) {
        staged.shadow = createShadows(renderer, staged.town);
        if (!validSettlementShadow(staged.shadow))
          throw new TypeError('Invalid campaign shadow scene');
      }
      const value = typeof wire === 'function' ? wire(staged.town) : wire;
      if (typeof value !== 'string' || value.length > 1024 * 1024)
        throw new RangeError('Settlement diagnostics exceed their bound');
      staged.wire = value;
    } catch (error) {
      const failures = [];
      if (staged.shadow)
        try {
          staged.shadow.dispose();
        } catch (cleanup) {
          failures.push(cleanup);
        }
      if (staged.town)
        try {
          staged.town.dispose();
        } catch (cleanup) {
          failures.push(cleanup);
        }
      if (failures.length)
        throw new AggregateError(
          [error, ...failures],
          'Staged settlement presentation cleanup failed'
        );
      throw error;
    }
    Object.freeze(staged);
    stagedOwners.add(staged);
    return staged;
  }
  function commitSettlementOwners(staged) {
    alive();
    if (!stagedOwners.has(staged) || consumedStaged.has(staged))
      throw new TypeError('Unknown or consumed settlement staging');
    consumedStaged.add(staged);
    stagedOwners.delete(staged);
    const previousShadow = shadowScene,
      previousTown = townOwner;
    shadowScene = staged.shadow;
    townOwner = staged.town;
    townWire = staged.wire;
    // Structure hit targets belong to the new owner. No cached pick value may
    // survive the replacement, even though the terrain query itself is static.
    pickCache = null;
    const failures = [];
    try {
      canvas.dataset.settlementBindings = townWire;
    } catch (error) {
      failures.push(error);
    }
    try {
      if (shadowScene) canvas.dataset.campaignShadows = JSON.stringify(shadowScene.status());
      else delete canvas.dataset.campaignShadows;
    } catch (error) {
      failures.push(error);
    }
    if (previousShadow && previousShadow !== shadowScene)
      try {
        previousShadow.dispose();
      } catch (error) {
        failures.push(error);
      }
    if (previousTown && previousTown !== townOwner)
      try {
        previousTown.dispose();
      } catch (error) {
        failures.push(error);
      }
    if (failures.length)
      throw new AggregateError(failures, 'Replaced settlement presentation cleanup failed');
  }
  function discardSettlementOwners(staged) {
    alive();
    if (!stagedOwners.has(staged)) return;
    consumedStaged.add(staged);
    stagedOwners.delete(staged);
    const failures = [];
    if (staged.shadow)
      try {
        staged.shadow.dispose();
      } catch (error) {
        failures.push(error);
      }
    try {
      staged.town.dispose();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length)
      throw new AggregateError(failures, 'Staged settlement presentation cleanup failed');
  }
  let decorVb;
  const waterStrips = [],
    coastStrips = [];
  const decorBytes = new Uint8Array(maxDecorVertices * 24),
    decorView = new DataView(decorBytes.buffer);
  // Cache terrain-following movement geometry across camera/animation frames.
  // Each cell follows the same four half-cell quads as the ground mesh. Fog and
  // structures only hide destinations; the caller owns executable route search.
  function updateMovementRange(input, selectedId, actors) {
    const fogRevision = fog?.visibility.maskRevision ?? null,
      selected = actors.find((actor) => actor.id === selectedId),
      selection = selected
        ? `${selectedId}:${selected.x}:${selected.y}:${selected.actionPoints ?? ''}`
        : null;
    if (
      input === movementInput &&
      selection === movementSelection &&
      fogRevision === movementFogRevision
    )
      return;
    const validPoint = (p) =>
      p &&
      Number.isInteger(p.x) &&
      Number.isInteger(p.y) &&
      p.x >= 0 &&
      p.y >= 0 &&
      p.x < worldWidth &&
      p.y < worldHeight;
    if (
      input !== null &&
      (input.policy?.id !== 'openrtw-executable-cardinal-range-v1' ||
        input.width !== worldWidth ||
        input.height !== worldHeight ||
        !(uint(input.actorId) || (input.actorId === null && input.status !== 'ok')) ||
        !(validPoint(input.origin) || (input.origin === null && input.status !== 'ok')) ||
        !uint(input.availableAp) ||
        input.availableAp > 80 ||
        !Array.isArray(input.cells) ||
        input.cells.length > worldWidth * worldHeight ||
        input.cells.some(
          (p) =>
            !validPoint(p) ||
            !Number.isInteger(p.steps) ||
            p.steps < 1 ||
            p.steps > input.availableAp
        ))
    )
      throw new TypeError('Invalid campaign movement range');
    const mask = new Uint8Array(worldWidth * worldHeight),
      cells = [];
    const admittedSelection = Boolean(
      input?.status === 'ok' &&
        input.availableAp > 0 &&
        selected &&
        input.actorId === selectedId &&
        input.origin.x === selected.x &&
        input.origin.y === selected.y &&
        (selected.actionPoints === undefined || selected.actionPoints === input.availableAp)
    );
    if (admittedSelection)
      for (const cell of input.cells) {
        const index = cell.x + worldWidth * cell.y;
        if (mask[index]) throw new TypeError('Duplicate campaign movement range cell');
        if (fog && !fog.visibility.terrainExplored?.(cell.x, cell.y)) continue;
        mask[index] = 1;
        cells.push(cell);
      }
    const shape = campaignMovementBoundary({
      width: worldWidth,
      height: worldHeight,
      cells,
      origin: admittedSelection ? input.origin : null,
    });
    // The origin belongs to the displayed connected area, but is not added to
    // the caller's executable destination mask. No per-cell outlines are drawn.
    const areaCells = [];
    for (let y = 0; y < worldHeight; y++)
      for (let x = 0; x < worldWidth; x++)
        if (shape.mask[x + y * worldWidth]) areaCells.push({ x, y });
    const next = [],
      maxVertices = 65520,
      bytes = new Uint8Array(areaCells.length ? maxVertices * 24 : 0),
      view = new DataView(bytes.buffer);
    let count = 0,
      total = 0;
    function flush() {
      if (!count) return;
      const data = groundBytes(bytes.subarray(0, count * 24)),
        vb = renderer.createBuffer({ kind: BufferKind.VERTEX, bytes: data.length });
      if (!uint(vb) || !vb) throw new Error('Invalid campaign movement buffer handle');
      next.push({ vb, vertices: count });
      renderer.uploadBuffer(vb, data);
      total += count;
      count = 0;
    }
    function vertex(x, z, color) {
      if (count === maxVertices) flush();
      write(view, count++, x, surface(x, z) + 0.035, z, color);
    }
    function quad(ax, az, bx, bz, cx, cz, dx, dz, color) {
      for (const [x, z] of [
        [ax, az],
        [bx, bz],
        [cx, cz],
        [bx, bz],
        [dx, dz],
        [cx, cz],
      ])
        vertex(x, z, color);
    }
    function fillColor(x, z) {
      let distance = 0.5;
      for (let y = Math.floor(z) - 1; y <= Math.floor(z) + 1; y++)
        for (let bx = Math.floor(x) - 1; bx <= Math.floor(x) + 1; bx++) {
          if (
            bx >= 0 &&
            y >= 0 &&
            bx < worldWidth &&
            y < worldHeight &&
            shape.mask[bx + y * worldWidth]
          )
            continue;
          distance = Math.min(
            distance,
            Math.hypot(Math.max(bx - x, 0, x - bx - 1), Math.max(y - z, 0, z - y - 1))
          );
        }
      return ((Math.round(27 * Math.min(1, distance / 0.3)) << 24) | 0x57bb70) >>> 0;
    }
    function boundary(a, b) {
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      if (length < 1e-10) return;
      const count = Math.max(1, Math.ceil(length / 0.1)),
        nx = ((a.y - b.y) / length) * 0.018,
        nz = ((b.x - a.x) / length) * 0.018;
      for (let k = 0; k < count; k++) {
        const ax = a.x + ((b.x - a.x) * k) / count,
          az = a.y + ((b.y - a.y) * k) / count,
          bx = a.x + ((b.x - a.x) * (k + 1)) / count,
          bz = a.y + ((b.y - a.y) * (k + 1)) / count;
        quad(ax + nx, az + nz, bx + nx, bz + nz, ax - nx, az - nz, bx - nx, bz - nz, 0x986cda85);
      }
    }
    try {
      for (const { x, y } of areaCells) {
        for (let z = 0; z < 2; z++)
          for (let dx = 0; dx < 2; dx++) {
            const ax = x + dx * 0.5,
              az = y + z * 0.5;
            for (const [vx, vz] of [
              [ax, az],
              [ax + 0.5, az],
              [ax, az + 0.5],
              [ax + 0.5, az],
              [ax + 0.5, az + 0.5],
              [ax, az + 0.5],
            ])
              vertex(vx, vz, fillColor(vx, vz));
          }
      }
      for (const loop of shape.loops)
        for (let i = 0; i < loop.length; i++) boundary(loop[i], loop[(i + 1) % loop.length]);
      flush();
    } catch (error) {
      const failures = releaseMovementBuffers(next);
      if (failures.length)
        throw new AggregateError([error, ...failures], 'Campaign movement upload cleanup failed');
      throw error;
    }
    const old = movementBuffers;
    movementBuffers = next;
    movementInput = input;
    movementSelection = selection;
    movementFogRevision = fogRevision;
    movementCellCount = areaCells.length;
    movementVertexCount = total;
    movementBuilds++;
    const failures = releaseMovementBuffers(old);
    if (failures.length)
      throw new AggregateError(failures, 'Campaign movement buffer cleanup failed');
  }
  function drawGroundIndexed(command) {
    renderer.setFvf(Fvf.XYZ | Fvf.DIFFUSE | (fog ? Fvf.TEX2 : Fvf.TEX1));
    fogOwner?.bind();
    renderer.drawIndexed(command);
  }
  function draw({
    characters = [],
    selectedId = null,
    target = null,
    route = null,
    movementRange = null,
    travelPoses = [],
    faction = '',
    timeSeconds = 0,
  } = {}) {
    alive();
    if (
      !Array.isArray(characters) ||
      characters.length > maxActors ||
      typeof faction !== 'string' ||
      faction.length > 256
    )
      throw new TypeError('Invalid campaign scene characters');
    if (!finite(timeSeconds) || timeSeconds < 0 || timeSeconds > 86400)
      throw new RangeError('Invalid campaign presentation time');
    if (!Array.isArray(travelPoses) || travelPoses.length > maxActors)
      throw TypeError('Invalid campaign travel poses');
    const poses = new Map();
    for (const pose of travelPoses) {
      if (
        !pose ||
        !uint(pose.actorId) ||
        poses.has(pose.actorId) ||
        !finite(pose.x) ||
        !finite(pose.y) ||
        pose.x < 0 ||
        pose.y < 0 ||
        pose.x >= worldWidth ||
        pose.y >= worldHeight ||
        !finite(pose.heading) ||
        Math.abs(pose.heading) > 1e6 ||
        typeof pose.moving !== 'boolean' ||
        (pose.distance !== undefined &&
          (!finite(pose.distance) || pose.distance < 0 || pose.distance > 65536))
      )
        throw TypeError('Invalid campaign travel pose');
      poses.set(pose.actorId, pose);
    }
    const travelling = travelPoses.some((p) => p.moving);
    const ids = new Set(),
      actors = [];
    for (const c of characters) {
      if (
        !uint(c.id) ||
        ids.has(c.id) ||
        !Number.isInteger(c.x) ||
        !Number.isInteger(c.y) ||
        c.x < 0 ||
        c.y < 0 ||
        c.x >= worldWidth ||
        c.y >= worldHeight ||
        !uint(c.color) ||
        typeof c.hasHastati !== 'boolean' ||
        typeof c.faction !== 'string' ||
        c.faction.length > 256
      )
        throw new TypeError('Invalid campaign scene character');
      const modelKey = Object.hasOwn(c, 'modelKey')
        ? c.modelKey
        : c.hasHastati
          ? 'hastati-candidate'
          : null;
      if (modelKey !== null && (typeof modelKey !== 'string' || !models.has(modelKey)))
        throw new TypeError('Unknown campaign actor model');
      ids.add(c.id);
      if ((!faction || c.faction === faction) && (!fog || fog.visibility.actorVisible(c.x, c.y)))
        actors.push({
          id: c.id,
          x: c.x,
          y: c.y,
          color: c.color,
          modelKey,
          faction: c.faction,
          type: c.type ?? '',
          armyRecords: c.armyRecords ?? 0,
          subFaction: c.subFaction ?? null,
          strength: c.strength ?? null,
          actionPoints: c.actionPoints,
          visualX: poses.get(c.id)?.x ?? c.x,
          visualY: poses.get(c.id)?.y ?? c.y,
          heading: poses.get(c.id)?.heading ?? 0,
          moving: poses.get(c.id)?.moving ?? false,
          travelDistance: poses.get(c.id)?.distance ?? null,
        });
    }
    if (selectedId !== null && !uint(selectedId))
      throw new TypeError('Invalid selected campaign ID');
    const validPoint = (p) =>
      p &&
      Number.isInteger(p.x) &&
      Number.isInteger(p.y) &&
      p.x >= 0 &&
      p.y >= 0 &&
      p.x < worldWidth &&
      p.y < worldHeight;
    if (target !== null && !validPoint(target)) throw new TypeError('Invalid campaign target');
    const points = travelling ? [] : Array.isArray(route) ? route : (route?.points ?? []);
    if (
      !Array.isArray(points) ||
      points.length > 81 ||
      points.some((p) => !validPoint(p)) ||
      points.some(
        (p, i) => i && Math.abs(p.x - points[i - 1].x) + Math.abs(p.y - points[i - 1].y) !== 1
      )
    )
      throw new TypeError('Invalid campaign route points');
    updateMovementRange(travelling ? null : movementRange, selectedId, actors);
    const frame = camera();
    fogOwner?.update();
    let count = 0;
    for (const actor of actors) {
      const x = actor.visualX + 0.5,
        z = actor.visualY + 0.5,
        cosine = Math.cos(actor.heading),
        sine = Math.sin(actor.heading);
      actor.footY = surface(x, z) + 0.06;
      const model = models.get(actor.modelKey);
      if (model) {
        let modelView = model.view,
          minY = model.minY,
          bannerPoint = model.bannerPoint;
        if (model.walking && actor.moving) {
          const walk = model.walking,
            cycles =
              actor.travelDistance === null
                ? timeSeconds / walk.cycleSeconds
                : actor.travelDistance / (walk.strideLength * model.scale),
            phase = (cycles % 1) * 20,
            index = Math.min(19, Math.floor(phase)),
            fraction = phase - index,
            a = walk.frames[index],
            b = walk.frames[index + 1];
          let buffer = walk.actorBuffers.get(actor.id);
          if (!buffer) {
            const bytes = a.bytes.slice();
            buffer = { bytes, view: new DataView(bytes.buffer) };
            walk.actorBuffers.set(actor.id, buffer);
          }
          minY = Infinity;
          for (let i = 0; i < model.vertexCount; i++)
            for (const offset of [0, 4, 8]) {
              const at = i * 24 + offset,
                value =
                  a.view.getFloat32(at, true) +
                  (b.view.getFloat32(at, true) - a.view.getFloat32(at, true)) * fraction;
              buffer.view.setFloat32(at, value, true);
              if (offset === 4) minY = Math.min(minY, buffer.view.getFloat32(at, true));
            }
          modelView = buffer.view;
          actor.walkVertices = buffer.bytes;
          actor.walkingFrame = phase;
          bannerPoint = a.bannerPoint.map((v, k) => v + (b.bannerPoint[k] - v) * fraction);
        }
        let base = actor.footY - minY * model.scale;
        // Raise the static candidate enough that its supplied vertices, including
        // feet on a slope, stay above the same interpolated terrain surface.
        for (let i = 0; i < model.vertexCount; i++)
          base = Math.max(
            base,
            surface(
              x +
                (cosine * modelView.getFloat32(i * 24, true) +
                  sine * modelView.getFloat32(i * 24 + 8, true)) *
                  model.scale,
              z +
                (-sine * modelView.getFloat32(i * 24, true) +
                  cosine * modelView.getFloat32(i * 24 + 8, true)) *
                  model.scale
            ) +
              0.06 -
              modelView.getFloat32(i * 24 + 4, true) * model.scale
          );
        actor.modelBase = base;
        actor.footY = base + minY * model.scale;
        if (bannerPoint) {
          // Match the body's full transform, then apply 4DA8FD's map-unit offset.
          // Travel applies the same heading to the mesh and its hand attachment.
          const hx = bannerPoint[0] * model.scale - 0.01,
            hz = bannerPoint[2] * model.scale + 0.09;
          actor.bannerAnchor = [
            x + cosine * hx + sine * hz,
            base + bannerPoint[1] * model.scale + 0.2,
            z - sine * hx + cosine * hz,
          ];
        } else {
          // Prototype models without a recovered hand keep their standard
          // beside the measured body, never at its center.
          actor.bodyBoundsX = model.bodyBoundsX.map((v) => x + v * model.scale);
        }
      }
    }
    for (const model of models.values())
      if (model.walking)
        for (const id of model.walking.actorBuffers.keys())
          if (!actors.some((a) => a.id === id && a.moving && a.modelKey === model.key))
            model.walking.actorBuffers.delete(id);
    const vertex = (p, color) => {
      if (count >= maxDecorVertices)
        throw new RangeError('Campaign decorations exceed their buffer');
      write(decorView, count++, ...p, color);
    };
    const triangle = (a, b, c, color) => {
      vertex(a, color);
      vertex(b, color);
      vertex(c, color);
    };
    const quad = (a, b, c, d, color) => {
      triangle(a, b, c, color);
      triangle(b, d, c, color);
    };
    const ground = (x, z) => [x, surface(x, z) + 0.12, z];
    function ribbon(ax, az, bx, bz, halfWidth, color) {
      const length = Math.hypot(bx - ax, bz - az),
        nx = (-(bz - az) / length) * halfWidth,
        nz = ((bx - ax) / length) * halfWidth;
      quad(
        ground(ax + nx, az + nz),
        ground(bx + nx, bz + nz),
        ground(ax - nx, az - nz),
        ground(bx - nx, bz - nz),
        color
      );
    }
    function ring(x, z, r, color) {
      for (let i = 0; i < 32; i++) {
        const a = (i * 2 * Math.PI) / 32,
          b = ((i + 1) * 2 * Math.PI) / 32;
        ribbon(
          x + r * Math.cos(a),
          z + r * Math.sin(a),
          x + r * Math.cos(b),
          z + r * Math.sin(b),
          0.018,
          color
        );
      }
    }
    const routeCurve = points.length >= 2 ? smoothCampaignPath(points) : [];
    for (let i = 1; i < routeCurve.length; i++) {
      const a = routeCurve[i - 1],
        b = routeCurve[i];
      ribbon(a.x + 0.5, a.y + 0.5, b.x + 0.5, b.y + 0.5, 0.028, 0xe67fe79a);
    }
    for (const c of actors) {
      const x = c.visualX + 0.5,
        z = c.visualY + 0.5,
        y = surface(x, z) + 0.06,
        k = (c.color | 0xff000000) >>> 0;
      // A model stands on its source terrain; only the selected actor gets a ring.
      if (c.modelKey === null && !bannerOwner?.hasActor(c)) {
        quad(
          [x - 0.025, y, z],
          [x + 0.025, y, z],
          [x - 0.025, y + modelHeight, z],
          [x + 0.025, y + modelHeight, z],
          0xffd3d7da
        );
        quad(
          [x, y, z - 0.025],
          [x, y, z + 0.025],
          [x, y + modelHeight, z - 0.025],
          [x, y + modelHeight, z + 0.025],
          0xffd3d7da
        );
        const rx = Math.cos(frame.yaw) * 0.38,
          rz = Math.sin(frame.yaw) * 0.38;
        triangle(
          [x, y + modelHeight, z],
          [x + rx, y + modelHeight - 0.25, z + rz],
          [x, y + modelHeight - 0.5, z],
          k
        );
      }
      if (c.id === selectedId) ring(x, z, 0.43, 0xe678e789);
    }
    if (target && !travelling) ring(target.x + 0.5, target.y + 0.5, 0.28, 0xe696f1ad);
    const markers = actors.map((c) => ({
      id: c.id,
      x: c.x,
      y: c.y,
      ...project(
        frame,
        c.visualX + 0.5,
        surface(c.visualX + 0.5, c.visualY + 0.5),
        c.visualY + 0.5
      ),
    }));
    const cameraWire = JSON.stringify({
      focus: { x: frame.focus[0], height: frame.focus[1], z: frame.focus[2] },
      eye: { x: frame.eye[0], y: frame.eye[1], z: frame.eye[2] },
      yaw: frame.yaw,
      pitch: frame.pitch,
      distance: frame.distance,
      heightScale,
      modelHeight,
      viewport: { width: frame.width, height: frame.height },
      terrain: {
        vertices: vertexCount,
        triangles: gridWidth * gridHeight * 2,
        sampleStep: step,
        strips: strips.length,
        uploadedVertices: aerial
          ? aerial.pages.reduce((n, p) => n + p.vertexCount, 0)
          : strips.reduce((n, s) => n + s.vertices.length / 24, 0),
        groundMesh: aerial ? 'aerial-page-meshes' : 'base-strips',
        seaLevel: waterTexture === null ? null : 0,
        ...(overridesSupplied ? { flattenedPoints: overridePoints } : {}),
      },
      unit: { vertices: 171, triangles: 218, parts: 6 },
      visibility: 'frustum-only',
      policy: 'openrtw-presentation-v1',
      ...(reference
        ? {
            reference: {
              profileId: originalInitialCampaignView.profileId,
              captureSha256: originalInitialCampaignView.source.captureSha256,
              viewWordsApplied: frame.referencePose,
              projectionWordsApplied: frame.referenceProjection,
              heightScaleInference:
                'six-static-world-height-correspondences;whole-terrain-unproved',
              navigation: 'reconstruction',
              nativeOneToOneProved: false,
            },
          }
        : {}),
    });
    const markersWire = JSON.stringify(
      markers.map(({ id, x, y, px, py, visible }) => ({ id, x, y, px, py, visible }))
    );
    const bindingsWire = JSON.stringify({
      schema: 'openrtw-campaign-model-bindings-v1',
      selectionPolicy: 'retained-julii-named-descriptor-with-hastati-prototype-fallback',
      models: modelMetadata,
      actors: actors.map(({ id, modelKey }) => ({ id, modelKey })),
    });
    if (aerial) updateAerial(frame);
    renderer.setRenderTarget(0, { depth: 'primary', resetViewport: true });
    renderer.setViewport({ width: frame.width, height: frame.height });
    renderer.setVertexProgram?.(0);
    renderer.setFvf(modelFvf);
    renderer.setMaterialLighting({ enabled: false });
    renderer.setDirectionalLighting({ enabled: false });
    for (const state of [
      RenderState.LIGHTING,
      RenderState.ALPHATESTENABLE,
      RenderState.ALPHABLENDENABLE,
      RenderState.FOGENABLE,
      RenderState.SPECULARENABLE,
    ])
      renderer.setRenderState(state, 0);
    renderer.setRenderState(RenderState.CULLMODE, 1);
    renderer.setRenderState(RenderState.ZENABLE, 1);
    renderer.setRenderState(RenderState.ZWRITEENABLE, 1);
    renderer.setRenderState(RenderState.ZFUNC, 4);
    renderer.setTexture(0, 0);
    renderer.setStageState(1, StageState.COLOROP, TextureOp.DISABLE);
    for (const [op, arg] of [
      [StageState.COLOROP, StageState.COLORARG1],
      [StageState.ALPHAOP, StageState.ALPHAARG1],
    ]) {
      renderer.setStageState(0, op, TextureOp.SELECTARG1);
      renderer.setStageState(0, arg, TextureArg.DIFFUSE);
    }
    renderer.setTransform(Transform.WORLD, identity);
    renderer.setTransform(Transform.VIEW, frame.view);
    renderer.setTransform(Transform.PROJECTION, frame.projection);
    renderer.clear({ color: 0xff182634, depth: 1, flags: 3 });
    if (!aerial)
      for (const strip of strips) {
        renderer.setStream(strip.vb, groundStride);
        renderer.setIndices(strip.ib, 0);
        drawGroundIndexed({
          primitive: Primitive.TRIANGLELIST,
          primitiveCount: gridWidth * strip.quadRows * 2,
        });
      }
    else {
      // Every terrain triangle is drawn exactly once through the page meshes:
      // pages in view without a texture (pending, failed, evicted) with their
      // grey diffuse under the untextured state set above, then pages with a
      // composed texture as opaque clamped TEXTURE x DIFFUSE; no second pass
      // relies on depth equality. Pages outside the frustum are skipped.
      aerial.drawnLastDraw = aerial.drawnPendingLastDraw = 0;
      for (const page of aerial.pages)
        if (page.visible && !page.texture) {
          renderer.setStream(page.vb, groundStride);
          renderer.setIndices(page.ib, 0);
          drawGroundIndexed({
            primitive: Primitive.TRIANGLELIST,
            primitiveCount: page.triangleCount,
          });
          aerial.drawnPendingLastDraw++;
        }
      for (const page of aerial.pages)
        if (page.visible && page.texture) {
          if (!aerial.drawnLastDraw) {
            renderer.setStageState(1, StageState.COLOROP, TextureOp.DISABLE);
            renderer.setStageState(0, StageState.COLOROP, TextureOp.MODULATE);
            renderer.setStageState(0, StageState.COLORARG1, TextureArg.TEXTURE);
            renderer.setStageState(0, StageState.COLORARG2, TextureArg.DIFFUSE);
            renderer.setStageState(0, StageState.ALPHAOP, TextureOp.SELECTARG1);
            renderer.setStageState(0, StageState.ALPHAARG1, TextureArg.DIFFUSE);
            for (const state of [StageState.ADDRESSU, StageState.ADDRESSV])
              renderer.setStageState(0, state, Address.CLAMP);
            for (const state of [StageState.MINFILTER, StageState.MAGFILTER])
              renderer.setStageState(0, state, Filter.LINEAR);
            renderer.setStageState(0, StageState.MIPFILTER, Filter.NONE);
            renderer.setRenderState(RenderState.ALPHATESTENABLE, 0);
            renderer.setRenderState(RenderState.ALPHABLENDENABLE, 0);
            renderer.setRenderState(RenderState.ZWRITEENABLE, 1);
          }
          renderer.setTexture(0, page.texture);
          renderer.setStream(page.vb, groundStride);
          renderer.setIndices(page.ib, 0);
          drawGroundIndexed({
            primitive: Primitive.TRIANGLELIST,
            primitiveCount: page.triangleCount,
          });
          aerial.drawnLastDraw++;
        }
      if (aerial.drawnLastDraw) {
        // Restore the untextured stage and the D3D8 sampler defaults (WRAP, POINT,
        // no mip, COLORARG2 CURRENT) so a later textured bind that assumes them is unaffected.
        renderer.setTexture(0, 0);
        for (const [op, arg] of [
          [StageState.COLOROP, StageState.COLORARG1],
          [StageState.ALPHAOP, StageState.ALPHAARG1],
        ]) {
          renderer.setStageState(0, op, TextureOp.SELECTARG1);
          renderer.setStageState(0, arg, TextureArg.DIFFUSE);
        }
        renderer.setStageState(0, StageState.COLORARG2, TextureArg.CURRENT);
        for (const state of [StageState.ADDRESSU, StageState.ADDRESSV])
          renderer.setStageState(0, state, Address.WRAP);
        for (const state of [StageState.MINFILTER, StageState.MAGFILTER])
          renderer.setStageState(0, state, Filter.POINT);
        renderer.setStageState(0, StageState.MIPFILTER, Filter.NONE);
      }
    }
    if (landVertices)
      for (let group = 0; group < 2; group++)
        if (landCounts[group]) {
          terrainOwners[group].bind();
          renderer.setStageState(
            0,
            StageState.ALPHAOP,
            group ? TextureOp.MODULATE : TextureOp.SELECTARG1
          );
          renderer.setStageState(0, StageState.ALPHAARG1, TextureArg.TEXTURE);
          renderer.setStageState(0, StageState.ALPHAARG2, TextureArg.DIFFUSE);
          renderer.setRenderState(RenderState.ZWRITEENABLE, group ? 0 : 1);
          renderer.setRenderState(RenderState.ALPHABLENDENABLE, group ? 1 : 0);
          if (group) {
            renderer.setRenderState(RenderState.SRCBLEND, Blend.SRCALPHA);
            renderer.setRenderState(RenderState.DESTBLEND, Blend.INVSRCALPHA);
          }
          for (const strip of strips)
            if (strip.landCounts[group]) {
              renderer.setStream(strip.landVb, groundStride);
              renderer.setIndices(strip.landIb[group], 0);
              drawGroundIndexed({
                primitive: Primitive.TRIANGLELIST,
                primitiveCount: strip.landCounts[group],
              });
            }
        }
    renderer.setRenderState(RenderState.ZWRITEENABLE, 1);
    renderer.setRenderState(RenderState.ALPHABLENDENABLE, 0);
    renderer.setStageState(0, StageState.ALPHAOP, TextureOp.SELECTARG1);
    if (waterOwner?.drawSurface) {
      waterOwner.drawSurface({
        geometry: waterGeometry,
        timeSeconds,
        groundBytes,
        groundStride,
        drawGroundIndexed,
        depthWrite: !coastOwner,
        coastGeometry,
      });
    } else if (waterOwner) {
      // Calm depth colour is opaque. A faint original-texture layer keeps wave
      // detail without letting its black/white source contrast dominate the map.
      const changed = waterGeometry.update(timeSeconds);
      renderer.setTexture(0, 0);
      renderer.setRenderState(RenderState.ZENABLE, 1);
      renderer.setRenderState(RenderState.ZWRITEENABLE, coastOwner ? 0 : 1);
      renderer.setRenderState(RenderState.ZFUNC, 4);
      renderer.setRenderState(RenderState.ALPHATESTENABLE, 0);
      renderer.setRenderState(RenderState.ALPHABLENDENABLE, 0);
      for (const [op, arg] of [
        [StageState.COLOROP, StageState.COLORARG1],
        [StageState.ALPHAOP, StageState.ALPHAARG1],
      ]) {
        renderer.setStageState(0, op, TextureOp.SELECTARG1);
        renderer.setStageState(0, arg, TextureArg.DIFFUSE);
      }
      for (const strip of waterStrips) {
        if (changed)
          renderer.uploadBuffer(strip.vb, groundBytes(strip.geometry.vertices), { discard: true });
        renderer.setStream(strip.vb, groundStride);
        renderer.setIndices(strip.ib, 0);
        drawGroundIndexed({
          primitive: Primitive.TRIANGLELIST,
          primitiveCount: strip.geometry.triangleCount,
        });
      }
      waterOwner.bind();
      renderer.setStageState(0, StageState.ALPHAOP, TextureOp.SELECTARG1);
      renderer.setStageState(0, StageState.ALPHAARG1, TextureArg.TFACTOR);
      renderer.setRenderState(RenderState.TEXTUREFACTOR, 0x40000000);
      renderer.setRenderState(RenderState.SRCBLEND, Blend.SRCALPHA);
      renderer.setRenderState(RenderState.DESTBLEND, Blend.INVSRCALPHA);
      renderer.setRenderState(RenderState.ALPHABLENDENABLE, 1);
      renderer.setRenderState(RenderState.ZWRITEENABLE, 0);
      for (const strip of waterStrips) {
        renderer.setStream(strip.vb, groundStride);
        renderer.setIndices(strip.ib, 0);
        drawGroundIndexed({
          primitive: Primitive.TRIANGLELIST,
          primitiveCount: strip.geometry.triangleCount,
        });
      }
      renderer.setRenderState(RenderState.TEXTUREFACTOR, 0xffffffff);
      renderer.setRenderState(RenderState.ALPHABLENDENABLE, 0);
      renderer.setRenderState(RenderState.ZWRITEENABLE, 1);
      renderer.setStageState(0, StageState.ALPHAARG1, TextureArg.DIFFUSE);
    }
    if (coastOwner) {
      // 9CB0DC moves the ribbon 0.1 toward the eye before depth testing.
      // Derive the direction from the actual view, including captured cameras.
      const towardEye = normalize([-frame.view[2], -frame.view[6], -frame.view[10]]),
        coastWorld = [...identity];
      for (let axis = 0; axis < 3; axis++) coastWorld[12 + axis] = towardEye[axis] * 0.1;
      renderer.setTransform(Transform.WORLD, coastWorld);
      renderer.setRenderState(RenderState.ZENABLE, 1);
      renderer.setRenderState(RenderState.ZWRITEENABLE, 0);
      renderer.setRenderState(RenderState.ZFUNC, 4);
      renderer.setRenderState(RenderState.CULLMODE, 1);
      try {
        coastOwner.bind();
        for (const strip of coastStrips) {
          renderer.setStream(strip.vb, groundStride);
          renderer.setIndices(strip.ib, 0);
          drawGroundIndexed({
            primitive: Primitive.TRIANGLELIST,
            primitiveCount: strip.triangleCount,
          });
        }
      } finally {
        try {
          coastOwner.unbind?.();
        } finally {
          renderer.setTransform(Transform.WORLD, identity);
          renderer.setRenderState(RenderState.ZWRITEENABLE, 1);
          renderer.setRenderState(RenderState.ALPHABLENDENABLE, 0);
          renderer.setRenderState(RenderState.ALPHATESTENABLE, 0);
        }
      }
    }
    fogOwner?.unbind();
    renderer.setFvf(modelFvf);
    if (townOwner) townOwner.draw(frame.combined, fog?.visibility ?? null);
    // The optional static pass consumes exactly the rows the settlement owner
    // submitted this frame, on the same camera, before any later layer.
    if (shadowScene) shadowScene.draw(frame);
    if (treeOwner) treeOwner.draw(frame.combined, timeSeconds, fogOwner);
    fogOwner?.unbind();
    renderer.setFvf(modelFvf);
    renderer.setRenderState(RenderState.ZWRITEENABLE, 1);
    renderer.setRenderState(RenderState.ALPHABLENDENABLE, 0);
    renderer.setRenderState(RenderState.ALPHATESTENABLE, 0);
    renderer.setTexture(0, 0);
    for (const [op, arg] of [
      [StageState.COLOROP, StageState.COLORARG1],
      [StageState.ALPHAOP, StageState.ALPHAARG1],
    ]) {
      renderer.setStageState(0, op, TextureOp.SELECTARG1);
      renderer.setStageState(0, arg, TextureArg.DIFFUSE);
    }
    if (movementBuffers.length || count) {
      renderer.setRenderState(RenderState.ZWRITEENABLE, 0);
      renderer.setRenderState(RenderState.ALPHABLENDENABLE, 1);
      renderer.setRenderState(RenderState.SRCBLEND, Blend.SRCALPHA);
      renderer.setRenderState(RenderState.DESTBLEND, Blend.INVSRCALPHA);
      try {
        if (movementBuffers.length) {
          renderer.setFvf(Fvf.XYZ | Fvf.DIFFUSE | (fog ? Fvf.TEX2 : Fvf.TEX1));
          fogOwner?.bind();
          for (const buffer of movementBuffers) {
            renderer.setStream(buffer.vb, groundStride);
            renderer.draw({
              primitive: Primitive.TRIANGLELIST,
              primitiveCount: buffer.vertices / 3,
            });
          }
          fogOwner?.unbind();
          renderer.setFvf(modelFvf);
        }
        if (count) {
          renderer.uploadBuffer(decorVb, decorBytes.subarray(0, count * 24), { discard: true });
          renderer.setStream(decorVb, 24);
          renderer.draw({ primitive: Primitive.TRIANGLELIST, primitiveCount: count / 3 });
        }
      } finally {
        fogOwner?.unbind();
        renderer.setFvf(modelFvf);
        renderer.setRenderState(RenderState.ZWRITEENABLE, 1);
        renderer.setRenderState(RenderState.ALPHABLENDENABLE, 0);
      }
    }
    for (const model of models.values()) {
      renderer.setStream(model.vb, model.resource.descriptor.layout.stride);
      renderer.setIndices(model.ib, 0);
      if (model.textureOwner) model.textureOwner.bind();
      else {
        renderer.setTexture(0, 0);
        for (const state of [StageState.COLORARG1, StageState.ALPHAARG1])
          renderer.setStageState(0, state, TextureArg.DIFFUSE);
      }
      for (const c of actors)
        if (c.modelKey === model.key) {
          if (c.walkVertices) {
            renderer.uploadBuffer(model.walking.vb, c.walkVertices, { discard: true });
            renderer.setStream(model.walking.vb, model.resource.descriptor.layout.stride);
          } else renderer.setStream(model.vb, model.resource.descriptor.layout.stride);
          const scale = model.scale,
            cosine = Math.cos(c.heading),
            sine = Math.sin(c.heading);
          renderer.setTransform(Transform.WORLD, [
            cosine * scale,
            0,
            -sine * scale,
            0,
            0,
            scale,
            0,
            0,
            sine * scale,
            0,
            cosine * scale,
            0,
            c.visualX + 0.5,
            c.modelBase,
            c.visualY + 0.5,
            1,
          ]);
          renderer.drawIndexed({
            primitive: model.resource.descriptor.technical.primitive,
            primitiveCount: model.resource.descriptor.counts.triangles,
          });
        }
    }
    if (bannerOwner)
      bannerOwner.draw({
        actors,
        view: frame.view,
        projection: frame.projection,
        modelHeight,
        timeSeconds,
      });
    renderer.setTexture(0, 0);
    for (const state of [StageState.COLORARG1, StageState.ALPHAARG1])
      renderer.setStageState(0, state, TextureArg.DIFFUSE);
    renderer.present();
    lastFrame = frame;
    lastActors = actors;
    canvas.dataset.scene = '3d';
    if (coastOwner)
      canvas.dataset.coastline = JSON.stringify({
        state: 'active',
        ...coastGeometry.metadata,
        texturePolicy: coastOwner.presentationPolicy ?? null,
      });
    if (treeOwner) canvas.dataset.trees = JSON.stringify(treeOwner.status());
    if (bannerOwner) canvas.dataset.banners = JSON.stringify(bannerOwner.status());
    if (fogOwner) {
      canvas.dataset.fogRendering = JSON.stringify(fogOwner.policy);
      canvas.dataset.fogVisibility = JSON.stringify({
        playerFaction: fog.visibility.identity.playerFaction,
        characters: actors.length,
        structureDraws: townOwner?.lastDraws ?? null,
      });
    }
    canvas.dataset.camera = cameraWire;
    canvas.dataset.projectedMarkers = markersWire;
    canvas.dataset.pickCandidates = pickCandidates(frame, actors);
    canvas.dataset.modelBindings = bindingsWire;
    if (movementInput)
      canvas.dataset.movementRange = JSON.stringify({
        actorId: movementInput.actorId,
        origin: movementInput.origin,
        availableAp: movementInput.availableAp,
        cellCount: movementCellCount,
        vertices: movementVertexCount,
        buffers: movementBuffers.length,
        builds: movementBuilds,
        policy: movementInput.policy.id,
        status: movementInput.status,
      });
    else delete canvas.dataset.movementRange;
    if (textureWire) canvas.dataset.unitTexture = textureWire;
    else delete canvas.dataset.unitTexture;
    const terrainState = aerial ? aerialWire() : terrainWire;
    if (terrainState) canvas.dataset.terrainTextures = terrainState;
    else delete canvas.dataset.terrainTextures;
    if (waterWire) canvas.dataset.waterTexture = waterWire;
    else delete canvas.dataset.waterTexture;
    if (waterGeometry)
      canvas.dataset.waterAnimation = JSON.stringify({
        frame: waterGeometry.frame,
        timeSeconds: waterGeometry.timeSeconds,
        running: false,
        pauseReason: 'caller-controlled',
      });
    if (townWire) canvas.dataset.settlementBindings = townWire;
    else delete canvas.dataset.settlementBindings;
    // Bounded per-frame admission diagnostic; the helper owns its own 8 KiB cap.
    if (shadowScene) canvas.dataset.campaignShadows = JSON.stringify(shadowScene.status());
    else delete canvas.dataset.campaignShadows;
  }
  const api = Object.freeze({
    draw,
    cameraFrame() {
      alive();
      const frame = lastFrame ?? camera();
      return { combined: [...frame.combined], width: frame.width, height: frame.height };
    },
    pickCell,
    pickActor,
    pickTarget,
    // Live production refresh: stage validates both owners before publication.
    stageSettlementOwners,
    commitSettlementOwners,
    discardSettlementOwners,
    pickingStats() {
      alive();
      return { ...pickCounters, maxTerrainCells: gridWidth + gridHeight + 1 };
    },
    projectCell,
    // Season only selects the aerial winter column; a change marks every
    // composed SEASONAL page stale (season-invariant pages keep their texture)
    // and recomposes lazily during later draws.
    setSeason(value) {
      alive();
      treeOwner?.setSeason(value);
      if (value !== 'summer' && value !== 'winter') throw new TypeError('Invalid campaign season');
      if (aerial && aerial.season !== value) {
        const previous = aerial.season;
        aerial.season = value;
        // Only a CURRENT season-invariant page carries over; an invalidated
        // (season null) page stays stale until it recomposes.
        for (const page of aerial.pages)
          if (page.texture && !page.seasonal && page.season === previous) page.season = value;
      }
    },
    // Marks composed aerial pages stale after the core's page inputs changed
    // (e.g. rebuilt decal records): pages = null for every page, or an array
    // of {pageX, pageY}. A stale page keeps drawing its old texture until it
    // recomposes lazily in view, unless discard removes it immediately (for
    // lost fog knowledge); its failure back-off restarts. Page meshes
    // and heights are static: changed flattening needs a new scene. Returns
    // the number of composed pages marked stale.
    invalidateAerialPages(pages = null, { discard = false } = {}) {
      alive();
      if (!aerial) return 0;
      if (typeof discard !== 'boolean') throw new TypeError('Invalid aerial discard policy');
      if (
        pages !== null &&
        (!Array.isArray(pages) ||
          pages.length > aerial.pages.length ||
          pages.some(
            (p) =>
              !Number.isInteger(p?.pageX) ||
              !Number.isInteger(p?.pageY) ||
              p.pageX < 0 ||
              p.pageY < 0 ||
              p.pageX >= aerial.pagesX ||
              p.pageY >= aerial.pagesY
          ))
      )
        throw new TypeError('Invalid aerial page list');
      const targets =
        pages === null
          ? aerial.pages
          : pages.map((p) => aerial.pages[p.pageY * aerial.pagesX + p.pageX]);
      let marked = 0;
      for (const page of new Set(targets)) {
        if (page.texture && page.season !== null) marked++;
        if (discard && page.texture) {
          renderer.destroyTexture(page.texture);
          page.texture = 0;
          aerial.textures--;
        }
        page.season = null;
        page.failures = 0;
        page.retryAt = 0;
      }
      return marked;
    },
    aerialStatus() {
      alive();
      if (!aerial) return null;
      return {
        season: aerial.season,
        pages: aerial.pages.length,
        ...aerialCounts(),
        pending: aerial.pending,
        failed: aerial.failed,
        failures: aerial.failures,
        lastError: aerial.lastError,
        textures: aerial.textures,
        evicted: aerial.evictions,
        composedLastDraw: aerial.composedLastDraw,
        drawnLastDraw: aerial.drawnLastDraw,
        drawnPendingLastDraw: aerial.drawnPendingLastDraw,
      };
    },
    pan(dx, dy) {
      alive();
      if (!finite(dx) || !finite(dy) || Math.abs(dx) > 1e6 || Math.abs(dy) > 1e6)
        throw new RangeError('Invalid campaign pan');
      if (dx || dy) referencePose = false;
      const unit = (2 * distance * Math.tan(fov / 2)) / size().height;
      focusX = clamp(
        focusX - Math.cos(yaw) * dx * unit - (Math.sin(yaw) * dy * unit) / Math.sin(pitch),
        0,
        worldWidth
      );
      focusZ = clamp(
        focusZ - Math.sin(yaw) * dx * unit + (Math.cos(yaw) * dy * unit) / Math.sin(pitch),
        0,
        worldHeight
      );
    },
    orbit(dx, dy) {
      alive();
      if (!finite(dx) || !finite(dy) || Math.abs(dx) > 1e6 || Math.abs(dy) > 1e6)
        throw new RangeError('Invalid campaign orbit');
      if (dx || dy) referencePose = false;
      yaw =
        ((((yaw + dx * 0.008 + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) - Math.PI;
      pitch = clamp(pitch + dy * 0.008, 0.35, 1.45);
    },
    zoom(factor) {
      alive();
      if (!finite(factor) || factor <= 0) throw new RangeError('Invalid campaign zoom');
      if (factor !== 1) referencePose = false;
      distance = clamp(distance * factor, 8, maxDistance);
    },
    center(x, y) {
      alive();
      if (
        !Number.isInteger(x) ||
        !Number.isInteger(y) ||
        x < 0 ||
        y < 0 ||
        x >= worldWidth ||
        y >= worldHeight
      )
        throw new RangeError('Invalid campaign center');
      referencePose = false;
      focusX = x + 0.5;
      focusZ = y + 0.5;
    },
    reset() {
      alive();
      resetCamera();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      lastActors = [];
      lastFrame = null;
      for (const model of models.values()) model.walking?.actorBuffers.clear();
      const failures = [], attempt = (cleanup) => {
        try { cleanup(); } catch (error) { failures.push(error); }
      };
      attempt(release);
      for (const key of [
        'waterAnimation', 'coastline', 'trees', 'banners', 'fogRendering',
        'fogVisibility', 'movementRange', 'pickCandidates',
      ]) attempt(() => { delete canvas.dataset[key]; });
      let ownsDiagnostics = false;
      try {
        ownsDiagnostics = canvas.dataset.scene === '3d';
      } catch (error) {
        failures.push(error);
      }
      if (ownsDiagnostics)
        for (const key of [
          'scene', 'camera', 'projectedMarkers', 'unitTexture', 'terrainTextures',
          'waterTexture', 'modelBindings', 'settlementBindings',
        ]) attempt(() => { delete canvas.dataset[key]; });
      if (failures.length)
        throw new AggregateError(failures, 'Campaign scene disposal failed');
    },
  });
  // Allocate all CPU storage and the public object before creating GPU resources.
  // Every created ID is registered before its upload, and all IDs are attempted
  // on a later creation/upload failure. The supplied renderer is never disposed.
  try {
    const buffer = (kind, data, dynamic = false) => {
      const id = renderer.createBuffer({ kind, bytes: data.length, dynamic });
      if (!uint(id) || !id) throw new Error('Invalid campaign buffer handle');
      owned.push(id);
      renderer.uploadBuffer(id, data);
      return id;
    };
    if (!aerial)
      for (const strip of strips) {
        strip.vb = buffer(BufferKind.VERTEX, groundBytes(strip.vertices));
        strip.ib = buffer(BufferKind.INDEX16, strip.indices);
      }
    else
      for (const page of aerial.pages) {
        page.vb = buffer(BufferKind.VERTEX, groundBytes(page.vertices));
        page.ib = buffer(BufferKind.INDEX16, page.indices);
        page.vertices = page.indices = null;
      }
    for (const model of models.values()) {
      model.vb = buffer(model.resource.descriptor.technical.buffers.vertex, model.vertices);
      model.ib = buffer(model.resource.descriptor.technical.buffers.index, model.indices);
      if (model.walking)
        model.walking.vb = buffer(model.resource.descriptor.technical.buffers.vertex, model.walking.frames[0].bytes, true);
    }
    decorVb = renderer.createBuffer({
      kind: BufferKind.VERTEX,
      bytes: maxDecorVertices * 24,
      dynamic: true,
    });
    if (!uint(decorVb) || !decorVb) throw new Error('Invalid campaign decoration buffer handle');
    owned.push(decorVb);
    for (const model of models.values())
      if (model.texture) model.textureOwner = model.texture.create(renderer);
    if (landVertices) {
      for (const strip of strips) {
        strip.landVb = buffer(BufferKind.VERTEX, groundBytes(strip.landVertices));
        for (let group = 0; group < 2; group++)
          if (strip.landIndices[group])
            strip.landIb[group] = buffer(BufferKind.INDEX16, strip.landIndices[group]);
      }
      terrainOwners[0] = terrainTextures.grass.create(renderer);
      terrainOwners[1] = terrainTextures.hills.create(renderer);
    }
    if (waterTexture) {
      waterOwner = waterTexture.create(renderer);
      if (!waterOwner.drawSurface)
        for (const geometry of waterGeometry.strips)
          waterStrips.push({
            geometry,
            vb: buffer(BufferKind.VERTEX, groundBytes(geometry.vertices), true),
            ib: buffer(BufferKind.INDEX16, geometry.indexBytes),
          });
    }
    if (fog) fogOwner = fog.create(renderer);
    if (coastline) {
      for (const strip of coastGeometry.strips)
        coastStrips.push({
          triangleCount: strip.triangleCount,
          vb: buffer(BufferKind.VERTEX, groundBytes(strip.vertices)),
          ib: buffer(BufferKind.INDEX16, strip.indexBytes),
        });
      coastOwner = coastline.create(renderer);
    }
    if (trees) treeOwner = trees.create({ renderer, fog: fog?.visibility ?? null });
    if (banners) bannerOwner = banners.create({ renderer });
    let optionalModelsFailure = null;
    if (settlementModels !== null) {
      try {
        townOwner = settlementModels.create(renderer);
        townWire = JSON.stringify({
          schema: 'openrtw-campaign-settlement-bindings-v2',
          meaning:
            'native-initial-selection-and-transforms;frustum-and-known-fog-cells;static-side-wall-shadow-volumes-only-when-admitted-and-view-proven',
          settlementCount: settlementModels.placement.settlementCount,
          portCount: settlementModels.placement.portCount,
          bannerCount: settlementModels.placement.bannerCount,
          garrisonBannerCount: settlementModels.placement.garrisonBannerCount,
          problems: settlementModels.placement.problems,
          models: townOwner.bindings,
        });
        if (townWire.length > 1024 * 1024)
          throw new RangeError('Settlement diagnostics exceed their bound');
        // Optional static-shadow owner: an injected factory closes over the
        // admitted volumes, so this scene keeps no shadow import or inventory.
        if (townOwner && settlementModels.createShadows !== undefined) {
          if (typeof settlementModels.createShadows !== 'function')
            throw new TypeError('Invalid campaign shadow scene factory');
          const created = settlementModels.createShadows(renderer, townOwner);
          try {
            if (
              !created ||
              typeof created.draw !== 'function' ||
              typeof created.dispose !== 'function' ||
              typeof created.status !== 'function'
            ) throw new TypeError('Invalid campaign shadow scene');
          } catch (invalid) {
            // Interface reads may throw too. The returned owner still needs
            // retirement before it can be refused as an optional presentation.
            try {
              created?.dispose?.();
            } catch (cleanup) {
              throw new AggregateError([invalid, cleanup], 'Invalid campaign shadow scene cleanup failed');
            }
            throw invalid;
          }
          shadowScene = created;
        }
      } catch (error) {
        // Constructor failures release their resources. Cleanup failures remain
        // fatal; a clean refusal of optional models keeps the previous preview.
        if (error instanceof AggregateError) throw error;
        const failed = townOwner;
        townOwner = null;
        townWire = null;
        try {
          failed?.dispose();
        } catch (cleanup) {
          throw new AggregateError([error, cleanup], 'Optional campaign settlement cleanup failed');
        }
        optionalModelsFailure = String(error.message || error);
        settlementModels.onFailure?.(optionalModelsFailure);
      }
    }
    if (!townOwner && townAssets !== null) {
      townOwner = createCampaignSettlements({
        renderer,
        assets: townAssets,
        settlements,
        surfaceAt: surface,
        footprintCells: 2,
        drawParts: [0],
      });
      townWire = JSON.stringify({
        schema: 'openrtw-campaign-settlement-bindings-v1',
        meaning:
          'initial-source-static-presentation;no-native-scale-fade-or-current-ownership-proof',
        settlements: townOwner.bindings,
        ...(optionalModelsFailure ? { optionalModelsFailure } : {}),
      });
      if (townWire.length > 8192) throw new RangeError('Town diagnostics exceed their bound');
    }
  } catch (error) {
    try {
      release();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Campaign scene construction failed');
    }
    throw error;
  }
  return api;
}
