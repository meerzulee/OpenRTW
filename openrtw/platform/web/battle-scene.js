import {
  BufferKind,
  Primitive,
  Fvf,
  Transform,
  RenderState,
  StageState,
  TextureOp,
  TextureArg,
} from '/reference/renderer-bridge.js';
import { createGeometryResource, geometryResourceSchema } from '/runtime/geometry-resource.js';

export const battlePresentationPolicy = Object.freeze({
  id: 'openrtw-battle-presentation-v2',
  arena: '64x48-flat-cells;5-metres-per-cell',
  geometry:
    'declared-owned-packed24;candidate-title-layout;not-native-layout-or-parity',
  coordinates:
    'cas-candidate-centered;normalized-uniform-extent;uninterpreted-up-handedness',
  models: 'roman_hastati-only;other-models-labelled-formation-markers',
  texture: 'Julii-Hastati-only;other-factions-diagnostic-part-colors',
  pose: 'unchanged-static-parent-translation-candidate',
  representativeCap: 96,
  formation: 'centred-source-ranks;first-two-spacings-clamped0.08..0.4cells',
  modelHeightCells: 0.34,
  lighting: 'unlit',
  ground: 'optional-original-grass;prototype-four-cell-tiling',
  cameraFocus:
    'selected-visible-geometry-sphere-fit;20-percent-margin;pitch0.62;distance3..150;extreme-aspects-may-clamp',
});
const finite = Number.isFinite,
  uint = (n) => Number.isInteger(n) && n >= 0 && n <= 0xffffffff,
  clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  dot = (a, b) => a.reduce((n, v, i) => n + v * b[i], 0),
  cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
const normalize = (v) => {
  const n = Math.hypot(...v);
  if (!finite(n) || n < 1e-12) throw Error('Invalid battle camera basis');
  return v.map((x) => x / n);
};
const multiply = (a, b) =>
  Array.from({ length: 16 }, (_, i) => {
    let n = 0;
    for (let k = 0; k < 4; k++) n += a[(i >> 2) * 4 + k] * b[k * 4 + (i & 3)];
    return n;
  });
function invert(a) {
  const rows = Array.from({ length: 4 }, (_, r) => [
    ...a.slice(r * 4, r * 4 + 4),
    ...identity.slice(r * 4, r * 4 + 4),
  ]);
  for (let k = 0; k < 4; k++) {
    let best = k;
    for (let r = k + 1; r < 4; r++) if (Math.abs(rows[r][k]) > Math.abs(rows[best][k])) best = r;
    if (Math.abs(rows[best][k]) < 1e-12) throw Error('Singular battle camera');
    [rows[k], rows[best]] = [rows[best], rows[k]];
    const v = rows[k][k];
    rows[k] = rows[k].map((x) => x / v);
    for (let r = 0; r < 4; r++)
      if (r !== k) {
        const factor = rows[r][k];
        rows[r] = rows[r].map((x, c) => x - factor * rows[k][c]);
      }
  }
  return rows.flatMap((row) => row.slice(4));
}
function transform(m, p) {
  return Array.from({ length: 4 }, (_, i) => p.reduce((n, v, k) => n + v * m[k * 4 + i], 0));
}
function packed(points) {
  const bytes = new Uint8Array(points.length * 24),
    v = new DataView(bytes.buffer);
  points.forEach(([x, y, z, color, u = 0, w = 0], i) => {
    const p = i * 24;
    v.setFloat32(p, x, true);
    v.setFloat32(p + 4, y, true);
    v.setFloat32(p + 8, z, true);
    v.setUint32(p + 12, color >>> 0, true);
    v.setFloat32(p + 16, u, true);
    v.setFloat32(p + 20, w, true);
  });
  return bytes;
}
function boxHit(ray, lo, hi) {
  let enter = 0,
    exit = Infinity;
  for (let k = 0; k < 3; k++) {
    if (Math.abs(ray.direction[k]) < 1e-12) {
      if (ray.origin[k] < lo[k] || ray.origin[k] > hi[k]) return null;
      continue;
    }
    let a = (lo[k] - ray.origin[k]) / ray.direction[k],
      b = (hi[k] - ray.origin[k]) / ray.direction[k];
    if (a > b) [a, b] = [b, a];
    enter = Math.max(enter, a);
    exit = Math.min(exit, b);
    if (enter > exit) return null;
  }
  return enter;
}

export const battleGeometryExtensionSchema = 'rome-original.battle-static-geometry/v1';
// Packed device layout and coordinate declarations describe the bytes this
// scene already consumed. They are existing title candidate policy, not
// recovered native layout, basis, scale, axis or parity proof.
export const battleGeometryCoordinates = Object.freeze({
  frame: 'cas-candidate-centered',
  units: 'normalized-uniform-extent',
  up: 'uninterpreted',
  handedness: 'uninterpreted',
});
const battleGeometryPresentation = Object.freeze({
  scale: '0.34 battle cells / packed Y extent',
  nativeBasis: 'unproved',
});
function packedBattleLayout() {
  return {
    stride: 24,
    endianness: 'little',
    attributes: [
      { semantic: 'position', format: 'f32x3', offset: 0 },
      { semantic: 'color', format: 'd3dcolor-bgra8', offset: 12 },
      { semantic: 'uv0', format: 'f32x2', offset: 16 },
    ],
  };
}
// The supplied geometry is trusted title data. The shared service owns exact
// copies of only its viewed bytes; this adapter snapshots the remaining
// supplied metadata and declares the existing candidate packing/coordinates.
// Unknown metadata is admitted as data or refused loudly, never stripped.
export function createBattleGeometryResource(
  geometry,
  { key = null, role = 'unit', sourceSha256 = null } = {}
) {
  const vertices = geometry?.vertices,
    indices = geometry?.indexBytes;
  if (
    !(vertices instanceof Uint8Array) ||
    !vertices.length ||
    vertices.length % 24 ||
    vertices.length / 24 > 16384 ||
    !(indices instanceof Uint8Array) ||
    !indices.length ||
    indices.length % 6 ||
    indices.length / 6 > 32768
  )
    throw TypeError('Invalid battle geometry span');
  const sourceMetadata = Object.fromEntries(
    Object.entries(geometry).filter(
      ([name]) => name !== 'vertices' && name !== 'indexBytes' && name !== 'resource'
    )
  );
  const resource = createGeometryResource({
    schema: geometryResourceSchema,
    layout: packedBattleLayout(),
    primitive: 'triangle-list',
    indexFormat: 'uint16-le',
    counts: { vertices: vertices.length / 24, indices: indices.length / 2 },
    coordinates: battleGeometryCoordinates,
    vertexBytes: vertices,
    indexBytes: indices,
    extensions: {
      [battleGeometryExtensionSchema]: {
        schema: battleGeometryExtensionSchema,
        key,
        role,
        sourceSha256,
        sourceMetadata,
        upstreamDescriptor: geometry?.resource?.descriptor ?? null,
        presentation: battleGeometryPresentation,
      },
    },
  });
  // The fixed-function stage sets one FVF for every packed stream in this scene.
  if (resource.descriptor.technical.fvf !== (Fvf.XYZ | Fvf.DIFFUSE | Fvf.TEX1))
    throw TypeError('Unsupported battle geometry FVF');
  return resource;
}

export function createBattleScene({
  renderer,
  canvas,
  labelLayer,
  unitGeometry,
  unitTexture = null,
  terrainTexture = null,
  modelAssets = null,
}) {
  if (
    !renderer ||
    !canvas?.dataset ||
    !labelLayer ||
    typeof labelLayer.replaceChildren !== 'function'
  )
    throw TypeError('Battle scene requires owned canvas and label layer');
  const size = () => {
    const width = canvas.width,
      height = canvas.height;
    if (
      !Number.isInteger(width) ||
      width < 1 ||
      width > 4096 ||
      !Number.isInteger(height) ||
      height < 1 ||
      height > 4096
    )
      throw RangeError('Battle viewport bound exceeded');
    return { width, height };
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
    throw Error('Renderer cannot display battle geometry');
  if (
    !(unitGeometry?.vertices instanceof Uint8Array) ||
    unitGeometry.vertices.length !== 4104 ||
    !(unitGeometry.indexBytes instanceof Uint8Array) ||
    unitGeometry.indexBytes.length !== 1308 ||
    !Array.isArray(unitGeometry.parts) ||
    unitGeometry.parts.length !== 6
  )
    throw Error('Battle Hastati geometry differs');
  const legacyResource = createBattleGeometryResource(unitGeometry),
    vbBytes = legacyResource.readVertices(),
    ibBytes = legacyResource.readIndices(),
    vbView = new DataView(vbBytes.buffer),
    ibView = new DataView(ibBytes.buffer);
  let minY = Infinity,
    maxY = -Infinity,
    extentX = 0,
    extentZ = 0;
  for (let i = 0; i < 171; i++) {
    for (const offset of [0, 4, 8, 16, 20])
      if (
        !finite(vbView.getFloat32(i * 24 + offset, true)) ||
        Math.abs(vbView.getFloat32(i * 24 + offset, true)) > 100
      )
        throw Error('Invalid battle source vertex');
    minY = Math.min(minY, vbView.getFloat32(i * 24 + 4, true));
    maxY = Math.max(maxY, vbView.getFloat32(i * 24 + 4, true));
    extentX = Math.max(extentX, Math.abs(vbView.getFloat32(i * 24, true)));
    extentZ = Math.max(extentZ, Math.abs(vbView.getFloat32(i * 24 + 8, true)));
  }
  for (let i = 0; i < 654; i++)
    if (ibView.getUint16(i * 2, true) >= 171) throw Error('Invalid battle source index');
  if (maxY - minY < 1e-6) throw Error('Battle model has no height');
  // Optional assets are an exact source-faction:model join. Snapshot all CPU
  // geometry before publishing any GPU owner; a missing key never borrows a
  // different faction/model. Mounted parts must already share an admitted
  // basis. This scene does not invent rider/horse offsets or relative scales.
  // The map is an already-bounded plain loader publication; Object.entries
  // enumerates its keys before the64-entry check, not arbitrary-object safety.
  const bindings = new Map(),
    assetParts = [];
  let ownedModelBytes = 0;
  const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value),
    text = (value) =>
      typeof value === 'string' && value.length > 0 && value.length <= 255 && !value.includes(':');
  if (modelAssets !== null) {
    if (
      typeof modelAssets !== 'object' ||
      Array.isArray(modelAssets) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(modelAssets))
    )
      throw TypeError('Invalid battle model assets map');
    const entries = Object.entries(modelAssets);
    if (entries.length > 64) throw RangeError('Battle model assets map exceeds its bound');
    for (const [key, entry] of entries) {
      if (
        !entry ||
        !text(entry.modelType) ||
        !text(entry.sourceFaction) ||
        key !== entry.sourceFaction + ':' + entry.modelType ||
        !['available', 'unavailable'].includes(entry.status) ||
        !Array.isArray(entry.parts)
      )
        throw TypeError('Invalid battle model asset binding');
      if (entry.status === 'unavailable') {
        if (
          entry.parts.length ||
          typeof entry.reason !== 'string' ||
          !entry.reason.length ||
          entry.reason.length > 512
        )
          throw TypeError('Invalid unavailable battle model binding');
        bindings.set(key, { status: 'unavailable', key, reason: entry.reason, parts: [] });
        continue;
      }
      if (entry.parts.length !== 1 && entry.parts.length !== 2)
        throw TypeError('Unsupported battle model part count');
      const roles = entry.parts.map((part) => part?.role).sort();
      if (
        !(
          (roles.length === 1 && roles[0] === 'unit') ||
          (roles.length === 2 && roles[0] === 'horse' && roles[1] === 'rider')
        )
      )
        throw TypeError('Unsupported battle model part roles');
      const record = {
        status: 'available',
        key,
        parts: [],
        minY: Infinity,
        maxY: -Infinity,
        extentX: 0,
        extentZ: 0,
      };
      for (const part of entry.parts) {
        const g = part.geometry,
          v = g?.vertices,
          ix = g?.indexBytes;
        if (
          !(v instanceof Uint8Array) ||
          !v.length ||
          v.length % 24 ||
          v.length / 24 > 16384 ||
          !(ix instanceof Uint8Array) ||
          !ix.length ||
          ix.length % 6 ||
          ix.length / 6 > 32768 ||
          !Array.isArray(g.parts) ||
          !g.parts.length ||
          g.parts.length > 64 ||
          !digest(part.sourceSha256) ||
          (part.texture === null
            ? part.textureSourceSha256 !== null
            : !part.texture ||
              typeof part.texture.create !== 'function' ||
              !digest(part.textureSourceSha256) ||
              part.texture.sourceSha256 !== part.textureSourceSha256)
        )
          throw TypeError('Invalid battle model part descriptor');
        const vertices = v.length / 24,
          triangles = ix.length / 6;
        if (
          g.parts.some(
            (p) =>
              !p ||
              typeof p.name !== 'string' ||
              p.name.length > 255 ||
              !uint(p.vertices) ||
              !p.vertices ||
              !uint(p.triangles) ||
              !p.triangles
          ) ||
          g.parts.reduce((n, p) => n + p.vertices, 0) !== vertices ||
          g.parts.reduce((n, p) => n + p.triangles, 0) !== triangles
        )
          throw TypeError('Invalid battle model part counts');
        const bytes = v.length + ix.length;
        if (bytes > 32 * 1024 * 1024 - ownedModelBytes)
          throw RangeError('Battle model geometry ownership exceeds its bound');
        ownedModelBytes += bytes;
        const resource = createBattleGeometryResource(g, {
          key,
          role: part.role,
          sourceSha256: part.sourceSha256,
        });
        if (resource.descriptor.technical.fvf !== legacyResource.descriptor.technical.fvf)
          throw TypeError('Unsupported battle model geometry FVF');
        const verticesCopy = resource.readVertices(),
          indicesCopy = resource.readIndices(),
          view = new DataView(verticesCopy.buffer),
          indices = new DataView(indicesCopy.buffer);
        for (let i = 0; i < vertices; i++) {
          for (const offset of [0, 4, 8, 16, 20])
            if (
              !finite(view.getFloat32(i * 24 + offset, true)) ||
              Math.abs(view.getFloat32(i * 24 + offset, true)) > 100
            )
              throw TypeError('Invalid battle model vertex');
          record.minY = Math.min(record.minY, view.getFloat32(i * 24 + 4, true));
          record.maxY = Math.max(record.maxY, view.getFloat32(i * 24 + 4, true));
          record.extentX = Math.max(record.extentX, Math.abs(view.getFloat32(i * 24, true)));
          record.extentZ = Math.max(record.extentZ, Math.abs(view.getFloat32(i * 24 + 8, true)));
        }
        for (let i = 0; i < triangles * 3; i++)
          if (indices.getUint16(i * 2, true) >= vertices)
            throw TypeError('Invalid battle model index');
        const copied = {
          role: part.role,
          resource,
          triangles: resource.descriptor.counts.triangles,
          texture: part.texture,
          sourceSha256: part.sourceSha256,
          textureSourceSha256: part.textureSourceSha256,
          vb: 0,
          ib: 0,
          owner: null,
        };
        record.parts.push(copied);
        assetParts.push(copied);
      }
      if (record.maxY - record.minY < 1e-6) throw RangeError('Battle bound model has no height');
      bindings.set(key, record);
    }
  }
  const legacy = {
      status: 'available',
      key: null,
      parts: [],
      resource: legacyResource,
      minY,
      maxY,
      extentX,
      extentZ,
    },
    policy =
      modelAssets === null
        ? battlePresentationPolicy
        : {
            ...battlePresentationPolicy,
            id: 'openrtw-battle-presentation-v3',
            models:
              'exact-source-faction:model-assets;legacy-Hastati-only-for-absent-keys;other-models-labelled',
            texture:
              'each-bound-part-owned-texture;missing-textures-labelled;legacy-Julii-Hastati-preserved',
            composition:
              'one-unit-or-source-common-basis-rider-and-horse;no-part-offset-or-independent-scale',
          };
  function assetFor(unit, faction) {
    return (
      bindings.get(faction + ':' + unit.model) ?? (unit.model === 'roman_hastati' ? legacy : null)
    );
  }
  const buffers = [],
    textures = [],
    labels = new Map();
  let disposed = false,
    frame = null,
    lastUnits = [],
    focusX = 32,
    focusZ = 24,
    yaw = 0,
    pitch = 1.02,
    distance = 78;
  const alive = () => {
    if (disposed) throw Error('Battle scene is disposed');
  };
  const release = () => {
    const errors = [];
    for (let i = textures.length - 1; i >= 0; i--) {
      const owner = textures[i];
      textures[i] = null;
      if (owner)
        try {
          owner.dispose();
        } catch (e) {
          errors.push(e);
        }
    }
    for (let i = buffers.length - 1; i >= 0; i--) {
      const id = buffers[i];
      buffers[i] = 0;
      if (id)
        try {
          renderer.destroyBuffer(id);
        } catch (e) {
          errors.push(e);
        }
    }
    labelLayer.replaceChildren();
    labels.clear();
    if (errors.length) throw new AggregateError(errors, 'Battle resource cleanup failed');
  };
  function buffer(kind, data, dynamic = false) {
    const id = renderer.createBuffer({ kind, bytes: data.length, dynamic });
    if (!uint(id) || !id) throw Error('Invalid battle buffer handle');
    buffers.push(id);
    renderer.uploadBuffer(id, data);
    return id;
  }
  let groundVb,
    groundIb,
    gridVb,
    decorVb,
    modelVb,
    modelIb,
    grassOwner = null,
    hastatiOwner = null;
  try {
    groundVb = buffer(
      BufferKind.VERTEX,
      packed([
        [0, 0, 0, 0xffb0b0b0, 0, 0],
        [64, 0, 0, 0xffb0b0b0, 16, 0],
        [0, 0, 48, 0xffb0b0b0, 0, 12],
        [64, 0, 48, 0xffb0b0b0, 16, 12],
      ])
    );
    groundIb = buffer(BufferKind.INDEX16, new Uint8Array([0, 0, 1, 0, 2, 0, 1, 0, 3, 0, 2, 0]));
    // The bridge admits triangle primitives only. Each grid stroke is a thin
    // ground quad; its width is presentation policy, not a native battle rule.
    const grid = [],
      stroke = (x0, z0, x1, z1) => {
        const a = [x0, 0.006, z0, 0xff65745b],
          b = [x1, 0.006, z0, 0xff65745b],
          c = [x0, 0.006, z1, 0xff65745b],
          d = [x1, 0.006, z1, 0xff65745b];
        grid.push(a, b, c, b, d, c);
      };
    for (let x = 0; x <= 64; x++) stroke(Math.max(0, x - 0.025), 0, Math.min(64, x + 0.025), 48);
    for (let z = 0; z <= 48; z++) stroke(0, Math.max(0, z - 0.025), 64, Math.min(48, z + 0.025));
    gridVb = buffer(BufferKind.VERTEX, packed(grid));
    decorVb = buffer(BufferKind.VERTEX, new Uint8Array(40 * 42 * 24), true);
    modelVb = buffer(legacyResource.descriptor.technical.buffers.vertex, vbBytes);
    modelIb = buffer(legacyResource.descriptor.technical.buffers.index, ibBytes);
    if (terrainTexture) {
      grassOwner = terrainTexture.create(renderer);
      textures.push(grassOwner);
    }
    if (unitTexture) {
      hastatiOwner = unitTexture.create(renderer);
      textures.push(hastatiOwner);
    }
    for (const part of assetParts) {
      part.vb = buffer(
        part.resource.descriptor.technical.buffers.vertex,
        part.resource.readVertices()
      );
      part.ib = buffer(part.resource.descriptor.technical.buffers.index, part.resource.readIndices());
      if (part.texture) {
        part.owner = part.texture.create(renderer);
        textures.push(part.owner);
      }
    }
  } catch (error) {
    try {
      release();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Battle scene creation failed');
    }
    throw error;
  }
  function camera() {
    const viewport = size(),
      focus = [focusX, 0, focusZ],
      eye = [
        focusX + Math.sin(yaw) * distance * Math.cos(pitch),
        distance * Math.sin(pitch),
        focusZ - Math.cos(yaw) * distance * Math.cos(pitch),
      ],
      forward = normalize(focus.map((v, k) => v - eye[k])),
      right = normalize(cross([0, 1, 0], forward)),
      up = cross(forward, right),
      view = new Float32Array([
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
      ]),
      ys = 1 / Math.tan(Math.PI / 8),
      xs = ys / (viewport.width / viewport.height),
      near = 0.1,
      far = 512,
      projection = new Float32Array([
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
      ]),
      combined = multiply(view, projection);
    return {
      ...viewport,
      eye,
      view: Array.from(view),
      projection: Array.from(projection),
      combined,
      inverse: invert(combined),
    };
  }
  function project(f, x, y, z) {
    const p = transform(f.combined, [x, y, z, 1]);
    return {
      px: ((p[0] / p[3] + 1) * f.width) / 2,
      py: ((1 - p[1] / p[3]) * f.height) / 2,
      visible:
        p[3] > 0 && p[2] >= 0 && p[2] <= p[3] && Math.abs(p[0]) <= p[3] && Math.abs(p[1]) <= p[3],
    };
  }
  function ray(px, py) {
    alive();
    if (
      !frame ||
      !finite(px) ||
      !finite(py) ||
      px < 0 ||
      py < 0 ||
      px >= frame.width ||
      py >= frame.height
    )
      return null;
    const x = (px / frame.width) * 2 - 1,
      y = 1 - (py / frame.height) * 2,
      p = transform(frame.inverse, [x, y, 0, 1]),
      q = transform(frame.inverse, [x, y, 1, 1]);
    if (Math.abs(p[3]) < 1e-12 || Math.abs(q[3]) < 1e-12) return null;
    const origin = p.slice(0, 3).map((v) => v / p[3]),
      end = q.slice(0, 3).map((v) => v / q[3]);
    return { origin, direction: normalize(end.map((v, k) => v - origin[k])) };
  }
  function formation(unit) {
    const count = Math.min(unit.soldiers, 96),
      rows = Math.min(Math.max(1, unit.formationRanks), Math.max(1, count)),
      columns = Math.ceil(count / rows),
      sx = clamp(unit.spacingMillimetres[0] / 5000, 0.08, 0.4),
      sz = clamp(unit.spacingMillimetres[1] / 5000, 0.08, 0.4);
    return {
      count,
      rows,
      columns,
      sx,
      sz,
      halfX: Math.max(0.46, ((columns - 1) * sx) / 2 + 0.12),
      halfZ: Math.max(0.46, ((rows - 1) * sz) / 2 + 0.12),
    };
  }
  function pickingExtent(unit) {
    if (unit.asset?.status !== 'available') return { halfX: 0.43, halfZ: 0.33 };
    const f = formation(unit);
    if (unit.asset === legacy) return f;
    const scale = 0.34 / (unit.asset.maxY - unit.asset.minY);
    return {
      halfX: Math.max(f.halfX, ((f.columns - 1) * f.sx) / 2 + unit.asset.extentX * scale),
      halfZ: Math.max(f.halfZ, ((f.rows - 1) * f.sz) / 2 + unit.asset.extentZ * scale),
    };
  }
  function centerFormation(id) {
    alive();
    const unit = uint(id) ? lastUnits.find((u) => u.id === id && u.soldiers) : null;
    if (!unit) return false;
    const viewport = size();
    let halfX = 0.48,
      halfZ = 0.48,
      height = 0.65;
    if (unit.asset?.status === 'available') {
      const f = formation(unit),
        asset = unit.asset,
        scale = 0.34 / (asset.maxY - asset.minY);
      halfX = Math.max(halfX, ((f.columns - 1) * f.sx) / 2 + asset.extentX * scale);
      halfZ = Math.max(halfZ, ((f.rows - 1) * f.sz) / 2 + asset.extentZ * scale);
      height = 0.34 + 0.015;
    }
    // Fit the actual drawn extent, including the selection square. The capped
    // perspective camera remains presentation policy, not original RTW scale.
    const radius = Math.hypot(halfX, halfZ, height),
      halfFov = Math.atan(Math.tan(Math.PI / 8) * Math.min(1, viewport.width / viewport.height));
    const closeDistance = clamp((1.2 * radius) / Math.sin(halfFov), 3, 150);
    focusX = unit.x + 0.5;
    focusZ = unit.y + 0.5;
    yaw = 0;
    pitch = 0.62;
    distance = closeDistance;
    return true;
  }
  function diffuse() {
    renderer.setTexture(0, 0);
    renderer.setStageState(1, StageState.COLOROP, TextureOp.DISABLE);
    for (const [op, arg] of [
      [StageState.COLOROP, StageState.COLORARG1],
      [StageState.ALPHAOP, StageState.ALPHAARG1],
    ]) {
      renderer.setStageState(0, op, TextureOp.SELECTARG1);
      renderer.setStageState(0, arg, TextureArg.DIFFUSE);
    }
  }
  function draw({ snapshot, selectedId = null }) {
    alive();
    if (
      snapshot?.width !== 64 ||
      snapshot.height !== 48 ||
      snapshot.cellMetres !== 5 ||
      !Array.isArray(snapshot.units) ||
      snapshot.units.length > 40 ||
      !Array.isArray(snapshot.teams) ||
      snapshot.teams.length !== 2
    )
      throw Error('Invalid battle render snapshot');
    if (snapshot.teams.some((team) => !team || !text(team.faction)))
      throw Error('Invalid battle render team');
    const ids = new Set();
    for (const u of snapshot.units) {
      if (
        !u ||
        !uint(u.id) ||
        ids.has(u.id) ||
        ![0, 1].includes(u.team) ||
        !Number.isInteger(u.x) ||
        u.x < 0 ||
        u.x >= 64 ||
        !Number.isInteger(u.y) ||
        u.y < 0 ||
        u.y >= 48 ||
        !uint(u.soldiers) ||
        u.soldiers > 2000 ||
        typeof u.type !== 'string' ||
        u.type.length > 255 ||
        typeof u.model !== 'string' ||
        u.model.length > 255 ||
        !uint(u.formationRanks) ||
        !Array.isArray(u.spacingMillimetres) ||
        u.spacingMillimetres.length !== 4 ||
        u.spacingMillimetres.some((v) => !uint(v))
      )
        throw Error('Invalid battle render unit');
      ids.add(u.id);
    }
    const units = snapshot.units.map((u) => ({
      ...u,
      spacingMillimetres: u.spacingMillimetres.slice(),
      faction: snapshot.teams[u.team].faction,
      asset: assetFor(u, snapshot.teams[u.team].faction),
    }));
    const f = camera(),
      points = [],
      projected = [];
    const tri = (a, b, c, k) => points.push([...a, k], [...b, k], [...c, k]);
    for (const u of units) {
      const live = u.soldiers > 0,
        available = u.asset?.status === 'available',
        x = u.x + 0.5,
        z = u.y + 0.5,
        k = live ? (u.team === 0 ? 0xff4e95ed : 0xffdc6666) : 0xff555555;
      if (!available || !live) {
        const a = [x - 0.4, 0.02, z - 0.3],
          b = [x + 0.4, 0.02, z - 0.3],
          c = [x - 0.4, 0.02, z + 0.3],
          d = [x + 0.4, 0.02, z + 0.3],
          top = [x, live ? 0.65 : 0.08, z];
        for (const edge of [
          [a, b],
          [b, d],
          [d, c],
          [c, a],
        ])
          tri(edge[0], edge[1], top, k);
        tri(a, c, b, k);
        tri(b, c, d, k);
      }
      if (u.id === selectedId) {
        const a = [x - 0.48, 0.025, z - 0.48],
          b = [x + 0.48, 0.025, z - 0.48],
          c = [x - 0.48, 0.025, z + 0.48],
          d = [x + 0.48, 0.025, z + 0.48];
        tri(a, b, c, 0xffffdc66);
        tri(b, d, c, 0xffffdc66);
      }
      const p = project(f, x, 0.8, z),
        reps = available && live ? formation(u).count : 0;
      projected.push({
        id: u.id,
        team: u.team,
        x: u.x,
        y: u.y,
        ...p,
        representatives: reps,
        visibleFigureCount: reps,
        capped: reps > 0 && u.soldiers > reps,
        model: u.model,
        kind: !live
          ? 'eliminated-formation-marker'
          : available
            ? u.asset === legacy
              ? 'original-static-Hastati'
              : 'original-static-bound-model'
            : 'labelled-formation-marker',
        ...(u.asset && u.asset !== legacy
          ? {
              assetBinding: {
                key: u.asset.key,
                status: u.asset.status,
                ...(available
                  ? {
                      parts: u.asset.parts.map((part) => ({
                        role: part.role,
                        sourceSha256: part.sourceSha256,
                        textureSourceSha256: part.textureSourceSha256,
                        triangles: part.triangles,
                      })),
                    }
                  : { reason: u.asset.reason }),
              },
            }
          : {}),
      });
      let label = labels.get(u.id);
      if (!label) {
        label = labelLayer.ownerDocument.createElement('span');
        label.className = 'battle-formation-label';
        label.style.position = 'absolute';
        label.style.pointerEvents = 'none';
        label.style.transform = 'translate(-50%,-100%)';
        label.style.maxWidth = '180px';
        label.style.font = '11px sans-serif';
        label.style.color = '#fff';
        label.style.textShadow = '0 1px 3px #000';
        labels.set(u.id, label);
        labelLayer.append(label);
      }
      label.textContent = `${u.type} · ${u.soldiers}${reps && u.soldiers > reps ? ` (${reps} figures)` : ''}${!available ? ' · model unavailable' : ''}${available && u.asset !== legacy && u.asset.parts.some((part) => !part.texture) ? ' · texture unavailable' : ''}`;
      label.hidden = !p.visible;
      label.style.left = p.px + 'px';
      label.style.top = p.py + 'px';
    }
    for (const [id, label] of labels)
      if (!ids.has(id)) {
        label.remove();
        labels.delete(id);
      }
    renderer.setRenderTarget(0, { depth: 'primary', resetViewport: true });
    renderer.setViewport({ width: f.width, height: f.height });
    renderer.setVertexProgram?.(0);
    let activeFvf = legacyResource.descriptor.technical.fvf;
    renderer.setFvf(activeFvf);
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
    renderer.setTransform(Transform.WORLD, identity);
    renderer.setTransform(Transform.VIEW, f.view);
    renderer.setTransform(Transform.PROJECTION, f.projection);
    renderer.clear({ color: 0xff203040, depth: 1, flags: 3 });
    diffuse();
    if (grassOwner) grassOwner.bind();
    renderer.setStream(groundVb, 24);
    renderer.setIndices(groundIb, 0);
    renderer.drawIndexed({ primitive: Primitive.TRIANGLELIST, primitiveCount: 2 });
    diffuse();
    renderer.setStream(gridVb, 24);
    renderer.draw({ primitive: Primitive.TRIANGLELIST, primitiveCount: 228 });
    if (points.length) {
      renderer.uploadBuffer(decorVb, packed(points), { discard: true });
      renderer.setStream(decorVb, 24);
      renderer.draw({ primitive: Primitive.TRIANGLELIST, primitiveCount: points.length / 3 });
    }
    for (const u of units)
      if (u.asset?.status === 'available' && u.soldiers) {
        const asset = u.asset,
          scale = 0.34 / (asset.maxY - asset.minY),
          f = formation(u),
          parts =
            asset === legacy
              ? [
                  {
                    vb: modelVb,
                    ib: modelIb,
                    resource: legacyResource,
                    owner: u.faction === 'romans_julii' ? hastatiOwner : null,
                  },
                ]
              : asset.parts;
        for (const part of parts) {
          const descriptor = part.resource.descriptor;
          renderer.setStream(part.vb, descriptor.layout.stride);
          renderer.setIndices(part.ib, 0);
          if (descriptor.technical.fvf !== activeFvf) {
            activeFvf = descriptor.technical.fvf;
            renderer.setFvf(activeFvf);
          }
          if (part.owner) part.owner.bind();
          else diffuse();
          for (let i = 0; i < f.count; i++) {
            const col = i % f.columns,
              row = Math.floor(i / f.columns),
              x = u.x + 0.5 + (col - (f.columns - 1) / 2) * f.sx,
              z = u.y + 0.5 + (row - (f.rows - 1) / 2) * f.sz;
            renderer.setTransform(Transform.WORLD, [
              scale,
              0,
              0,
              0,
              0,
              scale,
              0,
              0,
              0,
              0,
              scale,
              0,
              x,
              -asset.minY * scale + 0.015,
              z,
              1,
            ]);
            renderer.drawIndexed({
              primitive: descriptor.technical.primitive,
              primitiveCount: descriptor.counts.triangles,
            });
          }
        }
      }
    diffuse();
    renderer.present();
    frame = f;
    lastUnits = units;
    canvas.dataset.battleCamera = JSON.stringify({
      focus: { x: focusX, y: focusZ },
      yaw,
      pitch,
      distance,
      viewport: { width: f.width, height: f.height },
    });
    canvas.dataset.projectedUnits = JSON.stringify(projected);
    canvas.dataset.battlePresentation = JSON.stringify(policy);
  }
  return Object.freeze({
    draw,
    centerFormation,
    pickCell(px, py) {
      const r = ray(px, py);
      if (!r || Math.abs(r.direction[1]) < 1e-12) return null;
      const t = -r.origin[1] / r.direction[1];
      if (t < 0) return null;
      const x = Math.floor(r.origin[0] + t * r.direction[0]),
        y = Math.floor(r.origin[2] + t * r.direction[2]);
      return x >= 0 && x < 64 && y >= 0 && y < 48 ? { x, y } : null;
    },
    pickUnit(px, py) {
      const r = ray(px, py);
      if (!r) return null;
      let best = null,
        distance = Infinity;
      const ground = Math.abs(r.direction[1]) > 1e-12 ? -r.origin[1] / r.direction[1] : Infinity;
      for (const u of lastUnits)
        if (u.soldiers) {
          const f = pickingExtent(u),
            t = boxHit(
              r,
              [u.x + 0.5 - f.halfX, 0, u.y + 0.5 - f.halfZ],
              [u.x + 0.5 + f.halfX, 0.85, u.y + 0.5 + f.halfZ]
            );
          if (t !== null && t <= ground + 1e-6 && t < distance) {
            best = u.id;
            distance = t;
          }
        }
      return best;
    },
    projectCell(x, y) {
      alive();
      if (!frame || !finite(x) || !finite(y) || x < 0 || x >= 64 || y < 0 || y >= 48) return null;
      return project(frame, x + 0.5, 0, y + 0.5);
    },
    pan(dx, dy) {
      alive();
      if (!finite(dx) || !finite(dy)) throw TypeError('Invalid battle pan');
      const scale = distance / Math.max(1, size().height);
      focusX = clamp(focusX - dx * Math.cos(yaw) * scale - dy * Math.sin(yaw) * scale, 0, 64);
      focusZ = clamp(focusZ + dx * Math.sin(yaw) * scale - dy * Math.cos(yaw) * scale, 0, 48);
    },
    orbit(dx, dy) {
      alive();
      if (!finite(dx) || !finite(dy)) throw TypeError('Invalid battle orbit');
      yaw = (yaw + dx * 0.006) % (Math.PI * 2);
      pitch = clamp(pitch + dy * 0.006, 0.35, 1.45);
    },
    zoom(factor) {
      alive();
      if (!finite(factor) || factor <= 0) throw TypeError('Invalid battle zoom');
      distance = clamp(distance * factor, 3, 150);
    },
    center(x, y) {
      alive();
      if (!finite(x) || !finite(y)) throw TypeError('Invalid battle center');
      focusX = clamp(x + 0.5, 0, 64);
      focusZ = clamp(y + 0.5, 0, 48);
    },
    reset() {
      alive();
      focusX = 32;
      focusZ = 24;
      yaw = 0;
      pitch = 1.02;
      distance = 78;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        release();
      } finally {
        lastUnits = [];
        frame = null;
        delete canvas.dataset.battleCamera;
        delete canvas.dataset.projectedUnits;
        delete canvas.dataset.battlePresentation;
      }
    },
  });
}
