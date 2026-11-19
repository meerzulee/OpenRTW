const stride = 24,
  rate = 30,
  period = 1040,
  maxSeconds = 1e9,
  maxDimension = 1024;
const maxVertices = 131072,
  maxStripVertices = 65536,
  maxOwnedBytes = 16 * 1024 * 1024;
const seaLevel = 0,
  crest = 0.018,
  shoreClearance = 0.08,
  tau = 2 * Math.PI;
const clamp01 = (value) => Math.max(0, Math.min(1, value));
const finite = Number.isFinite;

export const campaignWaterPolicy = Object.freeze({
  id: 'openrtw-campaign-water-presentation-v2',
  seaLevel,
  gridStep: 1,
  groundSampleStep: 0.5,
  updateRateHz: rate,
  periodSeconds: period,
  vertexStride: stride,
  color: 'muted-depth-gradient;directional-swell-highlights;two-faint-source-detail-layers',
  shallowRgb: Object.freeze([50, 116, 121]),
  shelfRgb: Object.freeze([26, 77, 104]),
  deepRgb: Object.freeze([13, 41, 68]),
  shelfColourDepth: 0.4,
  deepColourDepth: 1.8,
  foam: 'restrained-coastal-wash;optional-original-surf-on-source-beach-contour',
  waves: 'nonnegative-crest-only-in-fully-submerged-adjacent-half-cell-source-quads',
  maximumCrest: crest,
  shoreClearance,
  uv: 'two-rotated-scales;continuous-spatial-warp;independent-periodic-drift',
  detailOpacityBytes: Object.freeze([48, 32]),
  textureStages: 'stage0-only;stage1-remains-available-for-world-space-fog',
  picking: 'unchanged-seaLevel0;no-picking-or-anchor-api',
  nativeMaterialEquivalent: false,
});

/** groundAt must be the scene's same finite, piecewise-linear half-cell ground
 * sampler in world coordinates, before max(ground,0). Sampling happens once.
 * Each coarse quad checks all nine source lattice points. A positive crest is
 * enabled only when EVERY incident quad is wholly below -shoreClearance.
 * Consequently coast/land quads remain flat at0; the continuous opaque base
 * never dips below0 or exposes holes. This guard relies on that supplied
 * half-cell piecewise-linear surface, not arbitrary unsampled height functions.
 *
 * Public byte buffers are owned mutable upload storage, stable for this owner.
 * The caller owns GPU resources/RAF and uploads vertices only when update()
 * returns true. Index bytes never change. No renderer, timer or source refs are
 * retained. Time is quantized; backwards seeks are allowed and deterministic.
 */
export function createCampaignWater({ worldWidth, worldHeight, groundAt }) {
  if (
    !Number.isInteger(worldWidth) ||
    !Number.isInteger(worldHeight) ||
    worldWidth < 1 ||
    worldHeight < 1 ||
    worldWidth > maxDimension ||
    worldHeight > maxDimension ||
    typeof groundAt !== 'function'
  )
    throw new TypeError('Invalid campaign water dimensions or ground sampler');
  const columns = worldWidth + 1,
    rows = worldHeight + 1,
    count = columns * rows,
    cells = worldWidth * worldHeight;
  if (count > maxVertices) throw new RangeError('Campaign water vertex budget exceeded');
  const quadRowsPerStrip = Math.floor(maxStripVertices / columns) - 1;
  const stripCount = Math.ceil(worldHeight / quadRowsPerStrip),
    uploadedVertices = count + (stripCount - 1) * columns;
  const sampleColumns = 2 * worldWidth + 1,
    sampleRows = 2 * worldHeight + 1,
    sampleCount = sampleColumns * sampleRows;
  const retainedBytes = count * 35 + uploadedVertices * stride * 2 + cells * 12;
  const temporaryBytes = (sampleCount + cells) * 8;
  if (quadRowsPerStrip < 1 || retainedBytes + temporaryBytes > maxOwnedBytes)
    throw new RangeError('Campaign water owned memory budget exceeded');

  let samples = new Float64Array(sampleCount),
    cellGround = new Float64Array(cells);
  for (let z = 0; z < sampleRows; z++)
    for (let x = 0; x < sampleColumns; x++) {
      const height = groundAt(x * 0.5, z * 0.5);
      if (!finite(height) || Math.abs(height) > 1024)
        throw new RangeError('Campaign water ground sample is invalid');
      samples[z * sampleColumns + x] = height;
    }
  for (let z = 0; z < worldHeight; z++)
    for (let x = 0; x < worldWidth; x++) {
      let high = -Infinity;
      for (let dz = 0; dz < 3; dz++)
        for (let dx = 0; dx < 3; dx++)
          high = Math.max(high, samples[(2 * z + dz) * sampleColumns + 2 * x + dx]);
      cellGround[z * worldWidth + x] = high;
    }
  const amplitude = new Float32Array(count),
    foam = new Float32Array(count);
  const sinA = new Float32Array(count),
    cosA = new Float32Array(count),
    sinB = new Float32Array(count),
    cosB = new Float32Array(count),
    sinC = new Float32Array(count),
    cosC = new Float32Array(count);
  const red = new Uint8Array(count),
    green = new Uint8Array(count),
    blue = new Uint8Array(count);
  for (let z = 0; z < rows; z++)
    for (let x = 0; x < columns; x++) {
      const i = z * columns + x,
        depth = Math.max(0, -samples[2 * z * sampleColumns + 2 * x]);
      let safe = true;
      for (let dz = -1; dz <= 0; dz++)
        for (let dx = -1; dx <= 0; dx++) {
          const cx = x + dx,
            cz = z + dz;
          if (
            cx >= 0 &&
            cx < worldWidth &&
            cz >= 0 &&
            cz < worldHeight &&
            cellGround[cz * worldWidth + cx] >= -shoreClearance
          )
            safe = false;
        }
      amplitude[i] = safe ? crest * clamp01((depth - shoreClearance) / 0.65) : 0;
      foam[i] = depth > 0 ? clamp01(1 - depth / 0.22) : 0;
      const near = clamp01(depth / 0.4),
        shelf = near * near * (3 - 2 * near),
        far = clamp01((depth - 0.4) / 1.4),
        deep = far * far * (3 - 2 * far);
      red[i] = Math.round(50 - 24 * shelf - 13 * deep);
      green[i] = Math.round(116 - 39 * shelf - 36 * deep);
      blue[i] = Math.round(121 - 17 * shelf - 36 * deep);
      const a = x * 0.53 + z * 0.31,
        b = -x * 0.29 + z * 0.64,
        c = x * 0.115 - z * 0.08;
      sinA[i] = Math.sin(a);
      cosA[i] = Math.cos(a);
      sinB[i] = Math.sin(b);
      cosB[i] = Math.cos(b);
      sinC[i] = Math.sin(c);
      cosC[i] = Math.cos(c);
    }
  // Release the callback and construction-only source samples; animation uses
  // only bounded derived arrays and six time sin/cos values per update.
  samples = null;
  cellGround = null;
  groundAt = null;
  const strips = [],
    views = [];
  for (let startZ = 0; startZ < worldHeight; startZ += quadRowsPerStrip) {
    const quadRows = Math.min(quadRowsPerStrip, worldHeight - startZ),
      vertexCount = columns * (quadRows + 1);
    const vertices = new Uint8Array(vertexCount * stride),
      detailVertices = new Uint8Array(vertexCount * stride),
      indexBytes = new Uint8Array(worldWidth * quadRows * 12);
    const indices = new DataView(indexBytes.buffer);
    let at = 0;
    for (let z = 0; z < quadRows; z++)
      for (let x = 0; x < worldWidth; x++) {
        const a = z * columns + x;
        indices.setUint16(at, a, true);
        indices.setUint16(at + 2, a + columns, true);
        indices.setUint16(at + 4, a + 1, true);
        indices.setUint16(at + 6, a + 1, true);
        indices.setUint16(at + 8, a + columns, true);
        indices.setUint16(at + 10, a + columns + 1, true);
        at += 12;
      }
    strips.push(
      Object.freeze({
        startZ,
        quadRows,
        vertexCount,
        triangleCount: worldWidth * quadRows * 2,
        vertices,
        detailVertices,
        indexBytes,
      })
    );
    views.push([new DataView(vertices.buffer), new DataView(detailVertices.buffer)]);
  }
  let lastTick = -1;
  function update(seconds) {
    if (!finite(seconds) || seconds < 0 || seconds > maxSeconds)
      throw new RangeError('Invalid campaign water elapsed seconds');
    const tick = Math.floor(seconds * rate);
    if (tick === lastTick) return false;
    const time = (tick % (period * rate)) / rate;
    const sa = Math.sin((tau * time) / 8),
      ca = Math.cos((tau * time) / 8),
      sb = Math.sin((tau * time) / 13),
      cb = Math.cos((tau * time) / 13),
      sc = Math.sin((tau * time) / 20),
      cc = Math.cos((tau * time) / 20);
    const driftU = time / 130,
      driftV = -time / 260;
    for (let s = 0; s < strips.length; s++) {
      const strip = strips[s],
        [view, detail] = views[s],
        first = strip.startZ * columns;
      for (let j = 0; j < strip.vertexCount; j++) {
        const i = first + j,
          x = i % columns,
          z = Math.floor(i / columns),
          at = j * stride;
        const a = sinA[i] * ca + cosA[i] * sa,
          b = sinB[i] * cb + cosB[i] * sb,
          c = sinC[i] * cc + cosC[i] * sc,
          slope = 0.65 * (cosA[i] * ca - sinA[i] * sa) +
            0.35 * (cosB[i] * cb - sinB[i] * sb),
          wave = Math.max(-1, Math.min(1, 0.62 * a + 0.28 * b + 0.1 * c));
        // Broad, low-contrast light follows the wave slope. There is no
        // camera-dependent reflection or point sparkle to alias at map scale.
        const facing = Math.max(0, slope),
          glint = facing * facing * facing * facing,
          light = 0.97 + 0.025 * wave + 0.015 * c,
          f = foam[i] * (0.035 + 0.035 * (a + 1) * 0.5),
          r = Math.round((red[i] * light + 5 * glint) * (1 - f) + 148 * f),
          g = Math.round((green[i] * light + 9 * glint) * (1 - f) + 174 * f),
          blueValue = Math.round((blue[i] * light + 10 * glint) * (1 - f) + 166 * f),
          color = (0xff000000 | (r << 16) | (g << 8) | blueValue) >>> 0,
          height = amplitude[i] * (wave + 1) * 0.5;
        view.setFloat32(at, x, true);
        view.setFloat32(at + 4, height, true);
        view.setFloat32(at + 8, z, true);
        view.setUint32(at + 12, color, true);
        view.setFloat32(at + 16, x * 0.19 + z * 0.055 + 0.23 * sinC[i] + driftU + 0.018 * b, true);
        view.setFloat32(at + 20, z * 0.19 - x * 0.055 + 0.19 * cosC[i] + driftV + 0.015 * a, true);
        detail.setFloat32(at, x, true);
        detail.setFloat32(at + 4, height, true);
        detail.setFloat32(at + 8, z, true);
        detail.setUint32(at + 12, color, true);
        detail.setFloat32(at + 16, x * 0.105 - z * 0.227 + 0.17 * cosC[i] - time / 208 + 0.022 * a, true);
        detail.setFloat32(at + 20, z * 0.105 + x * 0.227 - 0.21 * sinC[i] + time / 104 - 0.018 * b, true);
      }
    }
    lastTick = tick;
    return true;
  }
  update(0);
  const metadata = Object.freeze({
    schema: 'openrtw-campaign-water-geometry-v2',
    worldWidth,
    worldHeight,
    gridStep: 1,
    columns,
    rows,
    vertices: count,
    uploadedVertices,
    triangles: cells * 2,
    strips: strips.length,
    sourceGroundSamples: sampleCount,
    retainedBytes,
    constructionPeakBytes: retainedBytes + temporaryBytes,
    animatedVertexBytes: uploadedVertices * stride * 2,
    uploadBytesPerFrameWithFog: uploadedVertices * 32 * 2,
    maxStripVertices,
    maxVertices,
    maxOwnedBytes,
    presentationPolicy: campaignWaterPolicy,
  });
  return Object.freeze({
    strips: Object.freeze(strips),
    metadata,
    update,
    createSurf: createCampaignWaterSurf,
    get frame() {
      return lastTick;
    },
    get timeSeconds() {
      return lastTick / rate;
    },
  });
}

export const campaignSurfPolicy = Object.freeze({
  id: 'openrtw-campaign-source-surf-presentation-v1',
  contour: 'reuse-source-beach-linked-pairs-and-source-alpha',
  placement: 'sea-level0;offshore-only-offset-from-source-beach-centre',
  animation: 'browser-policy:five-second-gentle-wash;alongshore-phase;no-native-parity',
  maximumOpacity: 0.18,
  maximumOffshoreOffset: 0.38,
  nativeMaterialEquivalent: false,
});

/** Reuse the beach's welded pairs, connectivity and river/cliff alpha. This
 * avoids a second coastline approximation and never samples terrain again.
 * The browser wash lives at sea level, on the seaward side of the contour;
 * source terrain depth still occludes it. Native animated offsets/lighting
 * from 9C2F0C are NOT reproduced. All input bytes are copied/derived once.
 */
export function createCampaignWaterSurf(coastGeometry) {
  const profile = coastGeometry?.metadata?.presentationPolicy?.id,
    fixed = profile === 'openrtw-native-coastline-static-fixed-function-v1';
  if (
    (!fixed && profile !== 'openrtw-native-coastline-static-beach-v2') ||
    !Array.isArray(coastGeometry.strips) || coastGeometry.strips.length > 128
  ) throw new TypeError('Invalid source beach geometry for campaign surf');
  let count = 0, retainedBytes = 0;
  for (const s of coastGeometry.strips) {
    if (!(s.vertices instanceof Uint8Array) || !(s.indexBytes instanceof Uint8Array) ||
      !Number.isInteger(s.vertexCount) || s.vertexCount < 2 || s.vertexCount % 2 ||
      s.vertexCount > maxStripVertices || s.vertices.length !== s.vertexCount * stride ||
      !Number.isInteger(s.triangleCount) || s.triangleCount < 1 ||
      s.indexBytes.length !== s.triangleCount * 6)
      throw new TypeError('Invalid source beach strip for campaign surf');
    count += s.vertexCount;
    retainedBytes += s.vertexCount * 40 + s.indexBytes.length;
    if (count > maxVertices || retainedBytes > 8 * 1024 * 1024)
      throw new RangeError('Campaign surf owned memory budget exceeded');
    const indices = new DataView(s.indexBytes.buffer, s.indexBytes.byteOffset, s.indexBytes.byteLength);
    for (let at = 0; at < s.indexBytes.length; at += 2)
      if (indices.getUint16(at, true) >= s.vertexCount)
        throw new RangeError('Invalid source beach index for campaign surf');
  }
  const strips = [], entries = [];
  for (const s of coastGeometry.strips) {
    const data = new DataView(s.vertices.buffer, s.vertices.byteOffset, s.vertices.byteLength),
      vertices = new Uint8Array(s.vertices.length),
      view = new DataView(vertices.buffer),
      // Per pair: centre X/Z, offshore X/Z, U, phase sin/cos, source alpha.
      pairs = new Float32Array(s.vertexCount / 2 * 8);
    for (let pair = 0; pair < s.vertexCount / 2; pair++) {
      const at = pair * 48, p = pair * 8;
      for (const offset of [0, 4, 8, 16, 20, 24, 28, 32, 40, 44])
        if (!finite(data.getFloat32(at + offset, true)))
          throw new RangeError('Nonfinite source beach vertex for campaign surf');
      const ax = data.getFloat32(at, true), az = data.getFloat32(at + 8, true),
        bx = data.getFloat32(at + 24, true), bz = data.getFloat32(at + 32, true),
        u = data.getFloat32(at + 16, true),
        phase = u * 0.37 + ax * 0.08 - az * 0.06;
      // P=(A+B)/2 for +/-0.15; P=(2A+B)/3 for +0.1/-0.2.
      pairs[p] = fixed ? (2 * ax + bx) / 3 : (ax + bx) / 2;
      pairs[p + 1] = fixed ? (2 * az + bz) / 3 : (az + bz) / 2;
      pairs[p + 2] = (bx - ax) / 0.3;
      pairs[p + 3] = (bz - az) / 0.3;
      if (Math.hypot(pairs[p + 2], pairs[p + 3]) > 1.01)
        throw new RangeError('Invalid source beach normal for campaign surf');
      pairs[p + 4] = u;
      pairs[p + 5] = Math.sin(phase);
      pairs[p + 6] = Math.cos(phase);
      pairs[p + 7] = Math.min(data.getUint32(at + 12, true) >>> 24,
        data.getUint32(at + 36, true) >>> 24);
    }
    strips.push(Object.freeze({ vertices, indexBytes: s.indexBytes.slice(),
      vertexCount: s.vertexCount, triangleCount: s.triangleCount }));
    entries.push({ pairs, view });
  }
  let lastTick = -1;
  function update(seconds) {
    if (!finite(seconds) || seconds < 0 || seconds > maxSeconds)
      throw new RangeError('Invalid campaign surf elapsed seconds');
    const tick = Math.floor(seconds * rate);
    if (tick === lastTick) return false;
    const time = (tick % (period * rate)) / rate,
      sa = Math.sin(tau * time / 5), ca = Math.cos(tau * time / 5);
    for (const { pairs, view } of entries) {
      for (let pair = 0; pair < pairs.length / 8; pair++) {
        const p = pair * 8,
          pulse = clamp01(0.5 + 0.5 * (pairs[p + 5] * ca + pairs[p + 6] * sa)),
          // The wash travels toward shore as it gathers and fades.
          offset = 0.07 + 0.11 * (1 - pulse),
          alpha = Math.round(pairs[p + 7] * (0.035 + 0.145 * pulse)),
          color = ((alpha << 24) | 0xbed6cd) >>> 0;
        for (let edge = 0; edge < 2; edge++) {
          const at = (pair * 2 + edge) * stride,
            distance = offset + edge * 0.2;
          view.setFloat32(at, pairs[p] + pairs[p + 2] * distance, true);
          view.setFloat32(at + 4, 0, true);
          view.setFloat32(at + 8, pairs[p + 1] + pairs[p + 3] * distance, true);
          view.setUint32(at + 12, color, true);
          view.setFloat32(at + 16, pairs[p + 4] * 0.45 + time / 260, true);
          view.setFloat32(at + 20, edge ? 0.95 : 0, true);
        }
      }
    }
    lastTick = tick;
    return true;
  }
  update(0);
  return Object.freeze({ strips: Object.freeze(strips), update,
    metadata: Object.freeze({ schema: 'openrtw-campaign-surf-geometry-v1',
      vertices: count, retainedBytes, presentationPolicy: campaignSurfPolicy }),
    get frame() { return lastTick; },
  });
}
