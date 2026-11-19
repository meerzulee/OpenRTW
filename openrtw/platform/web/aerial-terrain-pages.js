// Pure page geometry for the native aerial (campaign) ground tiles. No imports,
// DOM, GPU, WASM or asset reads: node-testable as-is. The one exception is
// feedAerialDecals at the end, which drives a core module and an asset reader
// that the caller injects (importing this module still reads nothing).
//
// Recovered native facts (RomeTW.exe, see the aerial brief section 1):
// - every cell owns a 32x32 texel tile: 1 border texel + 15 + 15 + 1 border
//   texel, tile row 0 is the NORTH edge, column 0 the WEST edge (9E5B9D/9E65EA);
// - the native per-cell mesh has 3x3 vertices at the cell corners, edge
//   midpoints and the odd HGT cell centre, i.e. the same samples the scene's
//   half-cell grid already owns (9B4442 vertex loop);
// - UVs (RECOVERED): the atlas slot allocator 9E5739 stores per tile
//   f4=(y+1)/pageH, f5=(y+h-1)/pageH, f6=(x+1)/pageW, f7=(x+w-1)/pageW for a
//   w=h=32 slot at page texel (x,y), and the 9B4442 vertex loop applies
//   U=f6+0.5*j*(f7-f6), V=f5+0.5*i*(f4-f5), i.e. exactly
//   u=(ox+1+15j)/P, v=(oy+31-15i)/P (9E5B9D copies staging row j to page row
//   y+j, so V=(y+31)/P at i=0 is the south edge and tile row 0 is north).
// OpenRTW policy (NOT recovered): pages hold 32x32 cells at (32*(X%32),
// 32*(Y%32)); vertex positions use the scene's scaled HGT samples; the
// diffuse is the scene's existing base-vertex grey light rule; frustum
// culling is conservative; the native per-page slot order/allocation is not
// reproduced (only the UV formula, which is independent of it).
const tileTexels = 32,
  pageCells = 32,
  pageTexels = pageCells * tileTexels,
  pageBytes = pageTexels * pageTexels * 4;
const vertexStride = 24,
  cellVertices = 9,
  cellTriangles = 8,
  maxPageVertices = pageCells * pageCells * cellVertices;
const finite = Number.isFinite;
const light = (() => {
  const l = [-0.4, 0.85, -0.35],
    n = Math.hypot(...l);
  return l.map((v) => v / n);
})();

export const aerialTerrainPagePolicy = Object.freeze({
  id: 'openrtw-native-aerial-tiles-v1',
  tileTexels,
  pageCells,
  pageTexels,
  pageBytes,
  tilePlacement:
    'tile(X,Y) at page texel origin (32*(X%32),32*(Y%32)); tile row0=north, column0=west',
  vertexLayout: 'xyz-f32,diffuse-u32-argb,uv-f32;stride24',
  cellVertices,
  cellTriangles,
  indexFormat: 'uint16-le',
  maxPageVertices,
  positions: '((2X+j)*step, h(2X+j,2Y+i), (2Y+i)*step); scene-scaled Float32 HGT samples',
  uv: 'u=(ox+1+15j)/P v=(oy+31-15i)/P = native 9E5739 slot floats f6+0.5j(f7-f6), f5+0.5i(f4-f5) for a 32x32 slot at (ox,oy); recovered',
  topology:
    'per quad a=(j,i) b=(j+1,i) c=(j,i+1) d=(j+1,i+1): [a,c,b],[b,c,d]; base-strip diagonal and winding',
  diffuse:
    'grey round(255*(.55+.45*max(0,dot(normal,normalize(-.4,.85,-.35))))); scene base-vertex normal rule',
  culling:
    'page AABB vs six planes of the combined row-vector view-projection; D3D clip 0<=z<=w; conservative',
  texture: Object.freeze({
    format: 'RGBA8',
    levels: 1,
    address: 'clamp',
    min: 'linear',
    mag: 'linear',
    mip: 'none',
    colorOp: 'texture-modulate-diffuse',
    alpha: 'opaque',
  }),
  nativeTilePixels: true,
  nativeMeshUvEquivalence: true,
  nativePositionsOrDiffuse: false,
  knownGaps:
    '9E7A86 settlement/fort/port/watchtower underlay decals are composed by the core only when the optional decal inputs load (feedAerialDecals), otherwise the plain ground tiles show; shared border texels differ where neighbouring tiles blend different materials (native per-tile masks); the native draw factor over quarter-brightness (dense forest) words is unrecovered',
});

function checkWorld(worldWidth, worldHeight) {
  if (
    !Number.isInteger(worldWidth) ||
    worldWidth < 1 ||
    worldWidth > 4096 ||
    !Number.isInteger(worldHeight) ||
    worldHeight < 1 ||
    worldHeight > 4096
  )
    throw new RangeError('Unsupported aerial terrain world dimensions');
}

/** Page grid for a world of W x H cells: ceil(W/32) x ceil(H/32) pages, row-major. */
export function aerialPageLayout({ worldWidth, worldHeight } = {}) {
  checkWorld(worldWidth, worldHeight);
  const pagesX = Math.ceil(worldWidth / pageCells),
    pagesY = Math.ceil(worldHeight / pageCells),
    pages = [];
  for (let pageY = 0; pageY < pagesY; pageY++)
    for (let pageX = 0; pageX < pagesX; pageX++) {
      const cellX0 = pageX * pageCells,
        cellY0 = pageY * pageCells;
      pages.push(
        Object.freeze({
          pageX,
          pageY,
          cellX0,
          cellY0,
          cellsX: Math.min(pageCells, worldWidth - cellX0),
          cellsY: Math.min(pageCells, worldHeight - cellY0),
        })
      );
    }
  return Object.freeze({ pageCells, pageTexels, pagesX, pagesY, pages: Object.freeze(pages) });
}

/** Grey base-vertex shade per HGT sample (row-major z*width+x), byte 0..255.
 * Identical formula to campaign-scene.js base vertices: one-sided clamped
 * neighbours, normal=normalize([(l-r)/dx,1,(s-n)/dz]), .55+.45*lambert. */
export function aerialVertexShades(heights, terrainWidth, terrainHeight, step = 0.5) {
  if (
    !(heights instanceof Float32Array) ||
    !Number.isInteger(terrainWidth) ||
    !Number.isInteger(terrainHeight) ||
    terrainWidth < 2 ||
    terrainHeight < 2 ||
    heights.length !== terrainWidth * terrainHeight ||
    !finite(step) ||
    step <= 0
  )
    throw new TypeError('Invalid aerial shade height grid');
  const shades = new Uint8Array(heights.length),
    gridWidth = terrainWidth - 1,
    gridHeight = terrainHeight - 1;
  for (let z = 0; z < terrainHeight; z++)
    for (let x = 0; x < terrainWidth; x++) {
      const lx = Math.max(0, x - 1),
        rx = Math.min(gridWidth, x + 1),
        sz = Math.max(0, z - 1),
        nz = Math.min(gridHeight, z + 1);
      const left = heights[z * terrainWidth + lx],
        right = heights[z * terrainWidth + rx],
        south = heights[sz * terrainWidth + x],
        north = heights[nz * terrainWidth + x];
      const n = [(left - right) / ((rx - lx) * step), 1, (south - north) / ((nz - sz) * step)],
        length = Math.hypot(...n);
      if (!finite(length) || length < 1e-12) throw new RangeError('Degenerate aerial shade normal');
      // Same operation order as the scene: normalize first, then the dot product.
      const normal = n.map((value) => value / length),
        lambert = Math.max(0, normal[0] * light[0] + normal[1] * light[1] + normal[2] * light[2]);
      shades[z * terrainWidth + x] = Math.round(255 * (0.55 + 0.45 * lambert));
    }
  return shades;
}

/** Build every page's static vertex/index bytes. Only in-map cells receive
 * geometry; page texel slots beyond the map are never referenced. Each page
 * has at most 32*32*9=9216 vertices, so all local indices fit U16. Output
 * byte arrays are fresh caller-owned storage; the input heights are not kept. */
export function buildAerialPages({
  heights,
  worldWidth,
  worldHeight,
  terrainWidth,
  terrainHeight,
  step = 0.5,
} = {}) {
  checkWorld(worldWidth, worldHeight);
  if (terrainWidth !== 2 * worldWidth + 1 || terrainHeight !== 2 * worldHeight + 1)
    throw new RangeError('Aerial terrain samples disagree with the world cells');
  if (!(heights instanceof Float32Array) || heights.length !== terrainWidth * terrainHeight)
    throw new TypeError('Aerial pages need the scene Float32 height grid');
  for (const value of heights)
    if (!finite(value)) throw new RangeError('Aerial page height is not finite');
  const shades = aerialVertexShades(heights, terrainWidth, terrainHeight, step),
    layout = aerialPageLayout({ worldWidth, worldHeight });
  const pages = layout.pages.map((page) => {
    const { cellX0, cellY0, cellsX, cellsY } = page,
      cells = cellsX * cellsY,
      vertexCount = cells * cellVertices,
      triangleCount = cells * cellTriangles;
    if (vertexCount > maxPageVertices || vertexCount > 65536)
      throw new RangeError('Aerial page exceeds U16 vertices');
    const vertices = new Uint8Array(vertexCount * vertexStride),
      view = new DataView(vertices.buffer);
    const indices = new Uint8Array(triangleCount * 6),
      indexView = new DataView(indices.buffer);
    let minY = Infinity,
      maxY = -Infinity,
      v = 0,
      at = 0;
    for (let cy = 0; cy < cellsY; cy++)
      for (let cx = 0; cx < cellsX; cx++) {
        const X = cellX0 + cx,
          Y = cellY0 + cy,
          ox = tileTexels * cx,
          oy = tileTexels * cy,
          base = v;
        for (let i = 0; i < 3; i++)
          for (let j = 0; j < 3; j++) {
            const gx = 2 * X + j,
              gz = 2 * Y + i,
              sample = gz * terrainWidth + gx,
              h = heights[sample],
              g = shades[sample],
              o = v * vertexStride;
            view.setFloat32(o, gx * step, true);
            view.setFloat32(o + 4, h, true);
            view.setFloat32(o + 8, gz * step, true);
            view.setUint32(o + 12, (0xff000000 | (g << 16) | (g << 8) | g) >>> 0, true);
            view.setFloat32(o + 16, (ox + 1 + 15 * j) / pageTexels, true);
            view.setFloat32(o + 20, (oy + 31 - 15 * i) / pageTexels, true);
            minY = Math.min(minY, h);
            maxY = Math.max(maxY, h);
            v++;
          }
        for (let qi = 0; qi < 2; qi++)
          for (let qj = 0; qj < 2; qj++) {
            const a = base + qi * 3 + qj,
              b = a + 1,
              c = a + 3,
              d = a + 4;
            for (const index of [a, c, b, b, c, d]) {
              indexView.setUint16(at, index, true);
              at += 2;
            }
          }
      }
    const bounds = Object.freeze({
      min: Object.freeze([2 * cellX0 * step, minY, 2 * cellY0 * step]),
      max: Object.freeze([2 * (cellX0 + cellsX) * step, maxY, 2 * (cellY0 + cellsY) * step]),
    });
    return Object.freeze({ ...page, vertexCount, triangleCount, vertices, indices, bounds });
  });
  const metadata = Object.freeze({
    schema: 'openrtw-aerial-terrain-pages-v1',
    worldWidth,
    worldHeight,
    terrainWidth,
    terrainHeight,
    sampleStep: step,
    pagesX: layout.pagesX,
    pagesY: layout.pagesY,
    pageCells,
    pageTexels,
    pages: pages.length,
    vertices: pages.reduce((n, p) => n + p.vertexCount, 0),
    triangles: pages.reduce((n, p) => n + p.triangleCount, 0),
    policy: aerialTerrainPagePolicy.id,
  });
  return Object.freeze({ metadata, pages: Object.freeze(pages) });
}

/** Six inside-positive planes [a,b,c,d] of a row-vector combined matrix
 * (clip_j = sum_i p_i*m[i*4+j]) with D3D clip -w<=x,y<=w and 0<=z<=w. */
export function frustumPlanes(combined) {
  if (!combined || combined.length !== 16 || !Array.from(combined).every(finite))
    throw new TypeError('Invalid combined view-projection matrix');
  const column = (j) => [combined[j], combined[4 + j], combined[8 + j], combined[12 + j]],
    c0 = column(0),
    c1 = column(1),
    c2 = column(2),
    c3 = column(3);
  const add = (a, b) => a.map((v, k) => v + b[k]),
    sub = (a, b) => a.map((v, k) => v - b[k]);
  return Object.freeze(
    [add(c3, c0), sub(c3, c0), add(c3, c1), sub(c3, c1), c2, sub(c3, c2)].map((p) =>
      Object.freeze(p)
    )
  );
}

/** Conservative: false only when the whole box lies outside one plane. */
export function aabbIntersectsFrustum(planes, min, max) {
  if (
    !Array.isArray(planes) ||
    planes.length !== 6 ||
    !min ||
    !max ||
    min.length !== 3 ||
    max.length !== 3
  )
    throw new TypeError('Invalid frustum or bounds');
  for (const [a, b, c, d] of planes) {
    const x = a >= 0 ? max[0] : min[0],
      y = b >= 0 ? max[1] : min[1],
      z = c >= 0 ? max[2] : min[2];
    if (a * x + b * y + c * z + d < 0) return false;
  }
  return true;
}

/** Bind the core page compositor to the geometry policy above. The scene
 * receives this frozen descriptor as its aerialTerrain input. composePage
 * (pageX,pageY,winter:boolean) must return an owned 1024*1024*4 RGBA copy.
 * Optional: seasonalPages (row-major booleans, pagesY*pagesX; a false page
 * composes identical bytes in both seasons and keeps its texture across a
 * season change; null = every page seasonal), clock (milliseconds, for the
 * scene's per-frame compose time budget; default performance.now), and
 * scheduleFrame(callback) (an animation-frame hook that ends the scene's
 * per-frame compose budget; default requestAnimationFrame, null = per draw). */
export function createAerialTerrain({
  pageCells: cells,
  pageTexels: texels,
  pagesX,
  pagesY,
  composePage,
  season,
  seasonalPages = null,
  clock,
  scheduleFrame,
} = {}) {
  if (
    cells !== pageCells ||
    texels !== pageTexels ||
    !Number.isInteger(pagesX) ||
    pagesX < 1 ||
    pagesX > 128 ||
    !Number.isInteger(pagesY) ||
    pagesY < 1 ||
    pagesY > 128 ||
    typeof composePage !== 'function' ||
    (season !== 'summer' && season !== 'winter')
  )
    throw new TypeError('Invalid aerial terrain descriptor');
  if (
    seasonalPages !== null &&
    (!Array.isArray(seasonalPages) ||
      seasonalPages.length !== pagesX * pagesY ||
      seasonalPages.some((value) => typeof value !== 'boolean'))
  )
    throw new TypeError('Invalid aerial terrain descriptor');
  if (clock === undefined)
    clock =
      typeof globalThis.performance?.now === 'function'
        ? () => globalThis.performance.now()
        : () => Date.now();
  if (scheduleFrame === undefined)
    scheduleFrame =
      typeof globalThis.requestAnimationFrame === 'function'
        ? (callback) => {
            globalThis.requestAnimationFrame(callback);
          }
        : null;
  if (
    typeof clock !== 'function' ||
    (scheduleFrame !== null && typeof scheduleFrame !== 'function')
  )
    throw new TypeError('Invalid aerial terrain descriptor');
  return Object.freeze({
    pageCells,
    pageTexels,
    pagesX,
    pagesY,
    composePage,
    season,
    seasonalPages: seasonalPages && Object.freeze([...seasonalPages]),
    clock,
    scheduleFrame,
    policy: aerialTerrainPagePolicy,
    buildPages: buildAerialPages,
    frustumPlanes,
    aabbIntersectsFrustum,
  });
}

// ---------------------------------------------------------------------------
// Native aerial decals: settlement, fort, port and watchtower underlays.
//
// Recovered native chain (RomeTW.exe; the core ports it, see the decal brief):
// the descr_aerial_map_bases.txt parser registers type/filename/range rows,
// 9E8019 -> 9E8110 load each 32-bit TGA, 9B92B6 selects one base per map object
// (culture binding from descr_cultures.txt, culture from descr_sm_factions.txt)
// and flattens the HGT points inside its range, 9BE9D0/9BEA2B/9BE7CB place the
// per-chunk 20-byte records and 9E7A86 blends them into the tile words before
// the page publish. All of that runs in the core; feedAerialDecals only moves
// the descriptors and images into it, builds the records BEFORE the caller
// builds the compositor (openrtw_build_aerial_compositor takes the records it
// finds), and returns the flattened HGT points for the scene height grid.
// OpenRTW policy (not native): every distinct image the bases table names is
// read once and loaded under each type name that uses it; a missing, refused
// or unknown image skips only that image (the core is expected to draw no
// decal for a base whose image never loaded; flattening does not need it);
// a missing descriptor or a refused build drops the decals and the flattening.
export const aerialDecalExports = Object.freeze([
  '_openrtw_load_aerial_bases',
  '_openrtw_load_cultures',
  '_openrtw_load_faction_cultures',
  '_openrtw_load_aerial_base_image',
  '_openrtw_aerial_bases_json',
  '_openrtw_build_aerial_decals',
  '_openrtw_aerial_decals_json',
  '_openrtw_aerial_flattened_count',
  '_openrtw_aerial_flattened_points',
]);
const maxDecalBases = 1024,
  maxDecalReport = 256 * 1024,
  maxDecalListed = 16;
const coreError = (core) => {
  const pointer = core._openrtw_error?.();
  return pointer ? core.UTF8ToString(pointer) : '';
};
function withCoreBytes(core, bytes, run) {
  const pointer = core._malloc(Math.max(1, bytes.length));
  if (!pointer) throw new Error('Core input allocation failed');
  try {
    core.HEAPU8.set(bytes, pointer); // Re-read HEAPU8: a malloc may grow the memory.
    return run(pointer);
  } finally {
    core._free(pointer);
  }
}
function loadCoreInput(core, fn, bytes) {
  if (withCoreBytes(core, bytes, (pointer) => core[fn](pointer, bytes.length)) !== 1)
    throw new Error(coreError(core) || `Core refused ${fn}`);
}
function readCoreJson(core, fn, label) {
  const pointer = core[fn]();
  if (!pointer) throw new Error(coreError(core) || `Core ${label} report is unavailable`);
  const wire = core.UTF8ToString(pointer, maxDecalReport + 1);
  if (wire.length > maxDecalReport) throw new Error(`Core ${label} report exceeds its bound`);
  return JSON.parse(wire);
}
// openrtw_aerial_bases_json: the entries as a bare array or under entries/bases/types;
// each {name, filename, range, loaded} (only name and filename are required; the
// core's AerialDecalBase field names type/file are accepted as aliases).
function decalBaseEntries(value) {
  const list = Array.isArray(value)
    ? value
    : [value?.entries, value?.bases, value?.types].find(Array.isArray);
  if (!list || list.length > maxDecalBases) throw new Error('Core aerial bases report is invalid');
  return list.map((entry) => {
    const name = entry?.name ?? entry?.type,
      filename = entry?.filename ?? entry?.file;
    if (
      typeof name !== 'string' ||
      !/^[\x21-\x7e]{1,256}$/.test(name) ||
      typeof filename !== 'string' ||
      filename.length > 512 ||
      (entry.range !== undefined && !finite(entry.range)) ||
      (entry.loaded !== undefined && typeof entry.loaded !== 'boolean')
    )
      throw new Error('Core aerial bases report is invalid');
    return { name, filename, loaded: entry.loaded ?? null };
  });
}
// openrtw_aerial_decals_json counts, at the top level or under "counts".
function decalCount(report, keys) {
  for (const scope of [report, report?.counts])
    for (const key of keys) if (uint(scope?.[key])) return scope[key];
  return null;
}
const uint = (value) => Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
const listed = (list) => list.slice(0, maxDecalListed);

/** Feed the optional decal inputs to the core and build its decal records and
 * flattened points; call it after the campaign, regions and region map are
 * loaded and BEFORE openrtw_build_aerial_compositor. readAsset(name) resolves
 * to verified bytes (or rejects); assetName(filename) maps a bases "filename"
 * to an asset name or null. images=false skips the TGAs (flattening only, for
 * the grass/hills fallback). Throws, with nothing to undo in the caller, when
 * the core lacks the exports, a descriptor is unavailable or the build is
 * refused. After a successful build it never throws (the records are in the
 * core): later report problems are warnings, and invalid flattened points
 * leave flattened=null. Returns {records, flattened, wire}; flattened is an
 * owned Float32Array of (x, y, rawHeight) HGT point triples or null. */
export async function feedAerialDecals({
  core,
  readAsset,
  assetName,
  terrainWidth,
  terrainHeight,
  images = true,
  requireOpen = () => {},
} = {}) {
  if (
    !core ||
    typeof readAsset !== 'function' ||
    typeof assetName !== 'function' ||
    typeof requireOpen !== 'function' ||
    typeof images !== 'boolean' ||
    !Number.isInteger(terrainWidth) ||
    !Number.isInteger(terrainHeight) ||
    terrainWidth < 2 ||
    terrainHeight < 2 ||
    terrainWidth > 8193 ||
    terrainHeight > 8193
  )
    throw new TypeError('Invalid aerial decal feed');
  const absent = aerialDecalExports.filter((name) => typeof core[name] !== 'function');
  if (absent.length)
    throw new Error('This core build lacks the aerial decal exports: ' + absent.join(', '));
  const [basesBytes, culturesBytes, factionBytes] = await Promise.all([
    readAsset('aerialBases'),
    readAsset('aerialCultures'),
    readAsset('aerialFactionCultures'),
  ]);
  requireOpen();
  loadCoreInput(core, '_openrtw_load_aerial_bases', basesBytes);
  loadCoreInput(core, '_openrtw_load_cultures', culturesBytes);
  loadCoreInput(core, '_openrtw_load_faction_cultures', factionBytes);
  const entries = decalBaseEntries(
    readCoreJson(core, '_openrtw_aerial_bases_json', 'aerial bases')
  );
  // One read per distinct image; unknown names never reach readAsset.
  const byAsset = new Map(),
    missing = [],
    refused = [],
    warnings = [];
  for (const entry of entries) {
    const name = assetName(entry.filename);
    if (name === null) {
      if (images)
        missing.push({ filename: entry.filename, reason: 'not one of the pinned bases images' });
      continue;
    }
    if (!byAsset.has(name)) byAsset.set(name, { filename: entry.filename, names: [] });
    if (!byAsset.get(name).names.includes(entry.name)) byAsset.get(name).names.push(entry.name);
  }
  let loadedImages = 0;
  const loadedNames = new Set();
  if (images) {
    const reads = await Promise.all(
      [...byAsset].map(async ([name, use]) => {
        try {
          return { use, bytes: await readAsset(name) };
        } catch (error) {
          if (error?.name === 'AbortError') throw error;
          return { use, error: String(error?.message ?? error) };
        }
      })
    );
    requireOpen();
    const encoder = new TextEncoder();
    for (const { use, bytes, error } of reads) {
      if (error !== undefined) {
        missing.push({ filename: use.filename, reason: error });
        continue;
      }
      if (!(bytes instanceof Uint8Array)) {
        missing.push({ filename: use.filename, reason: 'asset reader returned no bytes' });
        continue;
      }
      let loaded = false;
      for (const typeName of use.names) {
        const result = withCoreBytes(core, encoder.encode(typeName + '\0'), (namePointer) =>
          withCoreBytes(core, bytes, (pointer) =>
            core._openrtw_load_aerial_base_image(namePointer, pointer, bytes.length)
          )
        );
        if (result === 1) {
          loaded = true;
          loadedNames.add(typeName);
        } else refused.push({ name: typeName, reason: coreError(core) || 'refused' });
      }
      if (loaded) loadedImages++;
    }
    // The loaded flags must now agree with what the core accepted.
    try {
      const after = decalBaseEntries(
        readCoreJson(core, '_openrtw_aerial_bases_json', 'aerial bases')
      );
      if (
        after.some((entry) => entry.loaded !== null && entry.loaded !== loadedNames.has(entry.name))
      )
        warnings.push('core loaded flags disagree with the accepted images');
    } catch (error) {
      warnings.push(String(error?.message ?? error));
    }
  }
  requireOpen();
  const records = core._openrtw_build_aerial_decals(),
    buildError = coreError(core);
  if (!Number.isInteger(records) || records < 0 || buildError)
    throw new Error(buildError || 'Core refused the aerial decals');
  // From here on the records are in the core: never throw.
  let report = null;
  try {
    report = readCoreJson(core, '_openrtw_aerial_decals_json', 'aerial decals');
    if (!report || typeof report !== 'object' || Array.isArray(report))
      throw new Error('Core aerial decals report is invalid');
  } catch (error) {
    report = null;
    warnings.push(String(error?.message ?? error));
  }
  const reportRecords = decalCount(report, ['records', 'recordCount']),
    reportFlattened = decalCount(report, [
      'flattenedPoints',
      'flattened',
      'flattenedCount',
      'flattened_points',
    ]),
    unresolvedList = [report?.unresolvedSettlements, report?.unresolved].find(Array.isArray),
    unresolved = unresolvedList
      ? unresolvedList.length
      : decalCount(report, ['unresolvedSettlements', 'unresolved', 'unresolved_settlements']);
  if (reportRecords !== null && reportRecords !== records)
    warnings.push(`decal report lists ${reportRecords} records, the build returned ${records}`);
  let flattened = null,
    flattenedPoints = 0,
    flatteningError = null;
  try {
    const count = core._openrtw_aerial_flattened_count() >>> 0;
    if (count > terrainWidth * terrainHeight)
      throw new Error(
        `Core lists ${count} flattened points for a ${terrainWidth}x${terrainHeight} grid`
      );
    const pointer = count ? core._openrtw_aerial_flattened_points() >>> 0 : 0,
      heap = core.HEAPU8;
    if (count && (!pointer || pointer > heap.length - count * 12))
      throw new Error('Core flattened point span is invalid');
    // Copy out of the heap before any later core call can move or reuse it.
    const points = new Float32Array(heap.slice(pointer, pointer + count * 12).buffer);
    for (let k = 0; k < points.length; k += 3) {
      const x = points[k],
        y = points[k + 1],
        h = points[k + 2];
      if (
        !Number.isInteger(x) ||
        !Number.isInteger(y) ||
        x < 0 ||
        y < 0 ||
        x >= terrainWidth ||
        y >= terrainHeight ||
        !finite(h) ||
        Math.abs(h) > 1e6
      )
        throw new Error('Core flattened point lies outside the HGT grid');
    }
    if (reportFlattened !== null && reportFlattened !== count)
      warnings.push(
        `decal report lists ${reportFlattened} flattened points, the core returned ${count}`
      );
    flattened = points;
    flattenedPoints = count;
  } catch (error) {
    flatteningError = String(error?.message ?? error);
  }
  return {
    records,
    flattened,
    wire: {
      schema: 'openrtw-aerial-decals-status-v1',
      state: 'active',
      records,
      objects: decalCount(report, ['objects', 'objectCount']),
      unresolvedSettlements: unresolved,
      ...(unresolvedList
        ? {
            unresolved: listed(unresolvedList).map((v) =>
              typeof v === 'string' ? v : JSON.stringify(v)
            ),
          }
        : {}),
      flattenedPoints,
      flattening: flatteningError === null ? 'core-points' : 'refused',
      ...(flatteningError === null ? {} : { flatteningError }),
      bases: entries.length,
      images: {
        requested: images ? byAsset.size : 0,
        loaded: loadedImages,
        typesLoaded: loadedNames.size,
        missing: missing.length,
        refused: refused.length,
        missingFiles: listed(missing),
        refusedTypes: listed(refused),
      },
      warnings: listed(warnings),
    },
  };
}
