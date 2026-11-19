const f32 = Math.fround;
const step = 0.5;
const maxSegments = 65536;
const maxStripVertices = 65536;
const clamp01 = (value) => Math.max(0, Math.min(1, value));

/** Fixed-function beach uses UP for lighting (9C48FE), independent of the
 * sloping displacement normal. 9250B7 halves ambient/diffuse; 92443F packs
 * ambient to RGB8; 9C3517 uses MODULATE2X. RGB8 vertex-light baking is the web
 * transport approximation, not a claim of exact D3D8 float lighting.
 */
export function campaignCoastlineLighting(values) {
  const read = (name) => {
    const value = values?.[name];
    if (
      !Array.isArray(value) ||
      value.length !== 3 ||
      value.some((v) => !Number.isFinite(v) || Math.abs(v) > 16)
    )
      throw new TypeError('Invalid coastline strategy lighting ' + name);
    return value.map(f32);
  };
  const ambient = read('ambient_colour'),
    diffuse = read('diffuse_colour'),
    direction = read('diffuse_direction'),
    length = Math.hypot(...direction);
  if (!length) throw new RangeError('Degenerate coastline light direction');
  const upDotLight = Math.max(0, -direction[1] / length);
  const rgb = ambient.map((a, i) => {
    const ambientByte = Math.round(clamp01(f32(a * 0.5)) * 255);
    const light = clamp01(ambientByte / 255 + f32(diffuse[i] * 0.5) * upDotLight);
    return Math.round(light * 255);
  });
  return Object.freeze({
    rgb: Object.freeze(rgb),
    metadata: Object.freeze({
      schema: 'openrtw-coastline-fixed-function-lighting-v1',
      ambient: Object.freeze(ambient),
      diffuse: Object.freeze(diffuse),
      direction: Object.freeze(direction),
      normal: Object.freeze([0, 1, 0]),
      nativeScale: 0.5,
      textureOperation: 'MODULATE2X',
      approximation: 'CPU RGB8 vertex-light bake; native D3D8 float lighting not byte-exact',
      directionQualification: 'strategy direction vector proven; legacy D3DLIGHT8 hookup inferred',
    }),
  });
}

/** 472F39 source projection: blue/cyan rivers and yellow initial cliff class1
 * suppress the beach in 9C5639. Later native cliff passes can replace class1;
 * those transformations are not claimed by this initial-source mask.
 */
export function parseCampaignCoastlineFeatures(input, worldWidth, worldHeight) {
  if (
    !(input instanceof Uint8Array) ||
    !(input.buffer instanceof ArrayBuffer) ||
    input.length < 18 ||
    !Number.isInteger(worldWidth) ||
    worldWidth < 1 ||
    worldWidth > 255 ||
    !Number.isInteger(worldHeight) ||
    worldHeight < 1 ||
    worldHeight > 156
  )
    throw new TypeError('Invalid coastline feature source');
  const h = new DataView(input.buffer, input.byteOffset, input.byteLength),
    width = h.getUint16(12, true),
    height = h.getUint16(14, true),
    offset = 18 + input[0],
    origin = input[17];
  if (
    input[1] !== 0 ||
    input[2] !== 2 ||
    input[16] !== 24 ||
    (origin & ~0x30) !== 0 ||
    width !== worldWidth ||
    height !== worldHeight ||
    offset + width * height * 3 !== input.length
  )
    throw new RangeError('Unsupported coastline feature TGA');
  const alpha = new Uint8Array(width * height).fill(255);
  let rivers = 0,
    cliffs = 0;
  for (let row = 0; row < height; row++)
    for (let column = 0; column < width; column++) {
      const at = offset + 3 * (row * width + column),
        b = input[at],
        g = input[at + 1],
        r = input[at + 2],
        river = r === 0 && b === 255 && (g === 0 || g === 255),
        cliff = r === 255 && g === 255 && b === 0,
        x = origin & 0x10 ? width - 1 - column : column,
        y = origin & 0x20 ? height - 1 - row : row;
      if (river || cliff) alpha[y * width + x] = 0;
      rivers += river;
      cliffs += cliff;
    }
  return Object.freeze({
    alphaAt(x, y) {
      if (
        !Number.isInteger(x) ||
        !Number.isInteger(y) ||
        x < 0 ||
        y < 0 ||
        x >= width ||
        y >= height
      )
        throw new RangeError('Coastline feature coordinate outside source');
      return alpha[y * width + x];
    },
    metadata: Object.freeze({
      schema: 'openrtw-coastline-source-feature-alpha-v1',
      width,
      height,
      rivers,
      initialCliffs: cliffs,
      suppressed: rivers + cliffs,
      policy: '472F39-source-river-and-initial-cliff1-projection',
      limitation:
        'later native cliff-class transformations are not reproduced; no height classifier',
    }),
  });
}

export const campaignCoastlinePolicy = Object.freeze({
  id: 'openrtw-native-coastline-static-beach-v2',
  sampleStep: step,
  contour: 'native-half-cell-edge-zero-crossings;exactly-two-crossings-only',
  joins: 'native-3x3-neighbours;endpoint-box-tolerance0.01;weld-and-average-normal',
  offsets: 'shader-beach-pass0-9C2F0C:+0.15-normal,-0.15-normal;CPU-evaluated',
  uv: 'chain-distance-u;v0-and0.95',
  alpha: 'native-river-or-cliff-suppression-when-source-flags-supplied',
  texture: 'data/terrain/aerial_map/sea/beach_strip.tga.dds',
  batching: 'full-world-u16-batches;native-camera-window-budget-not-reproduced',
  picking: 'unchanged-ground-and-sea-level0;visual-ribbon-only',
  nativeAnimatedSurf: false,
});
const fixedFunctionPolicy = Object.freeze({
  ...campaignCoastlinePolicy,
  id: 'openrtw-native-coastline-static-fixed-function-v1',
  offsets: 'fixed-function-9C48FE:+0.1-normal,-0.2-normal',
});

function normalize(x, y, z) {
  const length = Math.hypot(x, y, z);
  if (!length) return [0, 0, 0];
  const inverse = f32(1 / length);
  return [f32(x * inverse), f32(y * inverse), f32(z * inverse)];
}

/** groundAt is the scene's actual final half-cell terrain, including source
 * flattening and its presentation height scale. alphaAt optionally supplies
 * 0 for native river/cliff cells, otherwise 255. Inputs are sampled once.
 * No renderer or caller data is retained; returned bytes belong to the caller.
 */
export function createCampaignCoastline({
  worldWidth,
  worldHeight,
  groundAt,
  alphaAt = null,
  lighting = null,
  geometryProfile = 'shader-beach',
} = {}) {
  if (
    !Number.isInteger(worldWidth) ||
    worldWidth < 1 ||
    worldWidth > 255 ||
    !Number.isInteger(worldHeight) ||
    worldHeight < 1 ||
    worldHeight > 156 ||
    typeof groundAt !== 'function' ||
    (alphaAt !== null && typeof alphaAt !== 'function')
  )
    throw new TypeError('Invalid campaign coastline dimensions or sampler');
  if (geometryProfile !== 'shader-beach' && geometryProfile !== 'fixed-function')
    throw new TypeError('Invalid campaign coastline geometry profile');
  // 9C2F0C gives the non-animated shader beach pass0 symmetric +/-0.15
  // displacement constants. The old fixed-function fallback has +0.1/-0.2.
  // Both are source profiles with total width0.3; only their placement differs.
  const offsets = geometryProfile === 'shader-beach' ? [0.15, -0.15] : [0.1, -0.2];
  if (
    lighting !== null &&
    (!Array.isArray(lighting.rgb) ||
      lighting.rgb.length !== 3 ||
      lighting.rgb.some((v) => !Number.isInteger(v) || v < 0 || v > 255) ||
      lighting.metadata?.schema !== 'openrtw-coastline-fixed-function-lighting-v1')
  )
    throw new TypeError('Invalid coastline vertex lighting');
  const rgb = lighting ? [...lighting.rgb] : [255, 255, 255],
    packedRgb = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
  const columns = 2 * worldWidth + 1,
    rows = 2 * worldHeight + 1,
    cellColumns = columns - 1,
    cellRows = rows - 1;
  const samples = new Float32Array(columns * rows);
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < columns; x++) {
      const h = groundAt(x * step, y * step);
      if (!Number.isFinite(h) || Math.abs(h) > 1024)
        throw new RangeError('Invalid coastline ground sample');
      samples[y * columns + x] = h;
    }
  const alpha = new Uint8Array(worldWidth * worldHeight).fill(255);
  if (alphaAt)
    for (let y = 0; y < worldHeight; y++)
      for (let x = 0; x < worldWidth; x++) {
        const a = alphaAt(x, y);
        if (a !== 0 && a !== 255) throw new RangeError('Invalid coastline source alpha');
        alpha[y * worldWidth + x] = a;
      }
  const grid = new Int32Array(cellColumns * cellRows).fill(-1),
    segments = [];
  let ambiguous = 0,
    zeroLength = 0;
  function crossing(a, b, x, z, axis, direction) {
    if (a <= 0 === b <= 0) return null;
    const delta = f32(b - a),
      t = f32(f32(-a * step) / delta);
    const point = [x, 0, z];
    point[axis] = f32(point[axis] + direction * t);
    return { point, slope: f32(delta * 2) };
  }
  for (let y = 0; y < cellRows; y++)
    for (let x = 0; x < cellColumns; x++) {
      const hBL = samples[y * columns + x],
        hBR = samples[y * columns + x + 1],
        hTL = samples[(y + 1) * columns + x],
        hTR = samples[(y + 1) * columns + x + 1],
        x0 = x * step,
        z0 = y * step;
      const edges = [
        crossing(hTL, hTR, x0, z0 + step, 0, 1),
        crossing(hTR, hBR, x0 + step, z0 + step, 2, -1),
        crossing(hBR, hBL, x0 + step, z0, 0, -1),
        crossing(hBL, hTL, x0, z0, 2, 1),
      ];
      const count = edges.reduce((n, e) => n + (e !== null), 0);
      if (count !== 2) {
        if (count === 4) ambiguous++;
        continue;
      }
      if (segments.length === maxSegments)
        throw new RangeError('Campaign coastline segment budget exceeded');
      const [top, right, bottom, left] = edges;
      let a, b, slope;
      if (top && right) {
        a = right;
        b = top;
        slope = f32((right.slope - top.slope) * f32(0.707));
      } else if (top && bottom) {
        a = top;
        b = bottom;
        slope = f32((top.slope - bottom.slope) * 0.5);
      } else if (top && left) {
        a = top;
        b = left;
        slope = f32((top.slope - left.slope) * f32(0.707));
      } else if (right && bottom) {
        a = bottom;
        b = right;
        slope = f32((bottom.slope - right.slope) * f32(0.707));
      } else if (right && left) {
        a = left;
        b = right;
        slope = f32((left.slope - right.slope) * 0.5);
      } else {
        a = left;
        b = bottom;
        slope = f32((left.slope - bottom.slope) * f32(0.707));
      }
      if (slope > 0) [a, b] = [b, a];
      const dx = f32(a.point[0] - b.point[0]),
        dz = f32(a.point[2] - b.point[2]),
        length = f32(Math.hypot(dx, dz));
      const inverse = length ? f32(1 / length) : 0,
        normal = normalize(f32(-dz * inverse), Math.abs(slope), f32(dx * inverse));
      const opacity = alpha[(y >> 1) * worldWidth + (x >> 1)];
      grid[y * cellColumns + x] = segments.length;
      segments.push({
        x,
        y,
        a: a.point,
        b: b.point,
        na: normal,
        nb: [...normal],
        aa: opacity,
        ab: opacity,
        length,
        previous: -1,
        next: -1,
      });
      if (!length) zeroLength++;
    }
  // Retain the native deterministic grid/neighbour order. Matching tolerance is
  // a box, not a distance; subsequent welding uses the previous B exactly.
  const epsilon = f32(0.01);
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    for (let y = Math.max(0, s.y - 1); y < Math.min(cellRows, s.y + 2); y++)
      for (let x = Math.max(0, s.x - 1); x < Math.min(cellColumns, s.x + 2); x++) {
        const j = grid[y * cellColumns + x];
        if (j < 0 || i === j || s.next >= 0 || segments[j].previous >= 0) continue;
        const n = segments[j];
        if (s.b.every((v, k) => v >= n.a[k] - epsilon && v <= n.a[k] + epsilon)) {
          s.next = j;
          n.previous = i;
        }
      }
  }
  for (const s of segments)
    if (!s.length) {
      if (s.previous >= 0) segments[s.previous].next = -1;
      if (s.next >= 0) segments[s.next].previous = -1;
      if (s.previous >= 0 && s.next >= 0 && s.previous !== s.next) {
        segments[s.previous].next = s.next;
        segments[s.next].previous = s.previous;
      }
      s.previous = s.next = -1;
    }
  let linkedPairs = 0;
  for (const s of segments)
    if (s.length && s.next >= 0) {
      const n = segments[s.next];
      n.a = [...s.b];
      const normal = normalize(...s.nb.map((v, k) => f32(v + n.na[k])));
      s.nb = normal;
      n.na = [...normal];
      s.ab = Math.min(s.ab, n.aa);
      n.aa = s.ab;
      linkedPairs++;
    }
  const strips = [],
    used = new Uint8Array(segments.length);
  let points = [],
    indices = [],
    chains = 0,
    totalVertices = 0,
    totalTriangles = 0;
  function flush() {
    if (!points.length) return;
    const vertices = new Uint8Array(points.length * 24),
      data = new DataView(vertices.buffer),
      indexBytes = new Uint8Array(indices.length * 2),
      ids = new DataView(indexBytes.buffer);
    points.forEach((p, i) => {
      const at = i * 24;
      for (let k = 0; k < 3; k++) data.setFloat32(at + 4 * k, p[k], true);
      data.setUint32(at + 12, p[3], true);
      data.setFloat32(at + 16, p[4], true);
      data.setFloat32(at + 20, p[5], true);
    });
    indices.forEach((id, i) => ids.setUint16(i * 2, id, true));
    strips.push(
      Object.freeze({
        vertices,
        indexBytes,
        vertexCount: points.length,
        triangleCount: indices.length / 3,
      })
    );
    totalVertices += points.length;
    totalTriangles += indices.length / 3;
    points = [];
    indices = [];
  }
  function pair(position, normal, opacity, distance) {
    for (const [offset, v] of [
      [f32(offsets[0]), 0],
      [f32(offsets[1]), f32(0.95)],
    ]) {
      points.push([
        ...position.map((p, k) => f32(p + f32(offset * normal[k]))),
        ((opacity << 24) | packedRgb) >>> 0,
        distance,
        v,
      ]);
    }
  }
  function emit(first) {
    chains++;
    let id = first,
      distance = 0,
      previousPair = -1;
    while (id >= 0 && !used[id]) {
      const s = segments[id];
      used[id] = 1;
      if (points.length + (previousPair < 0 ? 4 : 2) > maxStripVertices) {
        flush();
        previousPair = -1;
      }
      if (previousPair < 0) {
        previousPair = points.length;
        pair(s.a, s.na, s.aa, distance);
      }
      distance = f32(distance + s.length);
      const nextPair = points.length;
      pair(s.b, s.nb, s.ab, distance);
      indices.push(
        nextPair,
        previousPair,
        nextPair + 1,
        previousPair,
        previousPair + 1,
        nextPair + 1
      );
      previousPair = nextPair;
      id = s.next;
    }
  }
  for (let i = 0; i < segments.length; i++)
    if (segments[i].length && segments[i].previous < 0 && !used[i]) emit(i);
  for (let i = 0; i < segments.length; i++) if (segments[i].length && !used[i]) emit(i);
  flush();
  return Object.freeze({
    strips: Object.freeze(strips),
    metadata: Object.freeze({
      schema: 'openrtw-campaign-coastline-geometry-v1',
      worldWidth,
      worldHeight,
      sourceGroundSamples: samples.length,
      segments: segments.length,
      zeroLength,
      ambiguous,
      linkedPairs,
      chains,
      vertices: totalVertices,
      triangles: totalTriangles,
      sourceAlpha: alphaAt !== null,
      suppressedSegments: segments.filter((s) => s.length && s.aa === 0 && s.ab === 0).length,
      partialAlphaSegments: segments.filter((s) => s.length && s.aa !== s.ab).length,
      lighting: lighting?.metadata ?? null,
      maxSegments,
      maxStripVertices,
      presentationPolicy:
        geometryProfile === 'shader-beach' ? campaignCoastlinePolicy : fixedFunctionPolicy,
    }),
  });
}
