// Pure OpenRTW batching policy. No native category producer, climate, season,
// interpolation, UV or material-blending equivalence is implied.
const maxWorldWidth = 255,
  maxWorldHeight = 156,
  maxMaterials = 32,
  maxKeyLength = 256;
const maxStripVertices = 65536,
  maxIndexBytes = 1909440;
export const aerialTerrainBatchPolicy = Object.freeze({
  id: 'openrtw-aerial-terrain-centroid-batches-v1',
  sampleStep: 0.5,
  cellSelection: 'floor triangle centroid in world X/Z; row-major caller cell keys',
  topology: 'unchanged half-cell grid, source diagonal and winding',
  materialOrder: 'first occurrence in row-major world-cell input',
  indexFormat: 'uint16-le',
  nativeEquivalence: false,
});

/** Input domain: an already-owned bounded record and dense data array of string
 * keys, rather than arbitrary objects/proxies. Keys are labels only; no path,
 * category, fallback or native map interpretation occurs here.
 *
 * Every source triangle appears once, in its source order within its material.
 * Strip vertex offsets/counts match campaign-scene's existing land VBs. Output
 * byte arrays are fresh caller-owned mutable upload storage; no input array or
 * output buffer is retained by this module. Frozen metadata never aliases input.
 */
export function buildAerialTerrainBatches(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw new TypeError('Invalid aerial terrain batch options');
  const { worldWidth, worldHeight, terrainWidth, terrainHeight, cellMaterialKeys } = options;
  if (
    !Number.isInteger(worldWidth) ||
    worldWidth < 1 ||
    worldWidth > maxWorldWidth ||
    !Number.isInteger(worldHeight) ||
    worldHeight < 1 ||
    worldHeight > maxWorldHeight ||
    terrainWidth !== 2 * worldWidth + 1 ||
    terrainHeight !== 2 * worldHeight + 1
  )
    throw new RangeError('Unsupported aerial terrain dimensions');
  const cells = worldWidth * worldHeight;
  if (!Array.isArray(cellMaterialKeys) || cellMaterialKeys.length !== cells)
    throw new TypeError('Aerial material keys must be a dense world-cell array');
  const ids = new Uint8Array(cells),
    keys = [],
    keyIds = new Map(),
    cellCounts = new Uint32Array(maxMaterials);
  for (let i = 0; i < cells; i++) {
    const entry = Object.getOwnPropertyDescriptor(cellMaterialKeys, String(i));
    if (!entry || !Object.hasOwn(entry, 'value'))
      throw new TypeError('Aerial material keys must be own data entries');
    const key = entry.value;
    if (typeof key !== 'string' || key.length < 1 || key.length > maxKeyLength)
      throw new TypeError('Invalid aerial material key');
    let id = keyIds.get(key);
    if (id === undefined) {
      if (keys.length === maxMaterials) throw new RangeError('Aerial material count exceeds 32');
      id = keys.length;
      keys.push(key);
      keyIds.set(key, id);
    }
    ids[i] = id;
    cellCounts[id]++;
  }
  const gridWidth = terrainWidth - 1,
    gridHeight = terrainHeight - 1;
  const triangleCount = gridWidth * gridHeight * 2,
    expectedIndexBytes = triangleCount * 6;
  if (expectedIndexBytes > maxIndexBytes) throw new RangeError('Aerial index byte budget exceeded');
  const maxQuadRows = Math.floor(maxStripVertices / terrainWidth) - 1;
  const totals = new Uint32Array(keys.length),
    strips = [];
  let uploadedVertices = 0,
    ownedIndexBytes = 0;
  // Centroids are (3*q+1)/6 and (3*q+2)/6 for the two unchanged triangles.
  // Integer numerators avoid rounding; qz is GLOBAL, including odd strip starts.
  const materialFor = (qx, qz, triangle) => {
    const numerator = triangle === 0 ? 1 : 2;
    const x = Math.floor((3 * qx + numerator) / 6),
      z = Math.floor((3 * qz + numerator) / 6);
    return ids[z * worldWidth + x];
  };
  for (let startZ = 0; startZ < gridHeight; startZ += maxQuadRows) {
    const quadRows = Math.min(maxQuadRows, gridHeight - startZ),
      vertexCount = terrainWidth * (quadRows + 1);
    if (vertexCount > maxStripVertices) throw new RangeError('Aerial strip exceeds U16 vertices');
    const counts = new Uint32Array(keys.length);
    for (let z = 0; z < quadRows; z++)
      for (let x = 0; x < gridWidth; x++) {
        counts[materialFor(x, startZ + z, 0)]++;
        counts[materialFor(x, startZ + z, 1)]++;
      }
    const batches = [],
      views = new Array(keys.length),
      cursors = new Uint32Array(keys.length);
    for (let id = 0; id < keys.length; id++)
      if (counts[id]) {
        const indexBytes = new Uint8Array(counts[id] * 6);
        views[id] = new DataView(indexBytes.buffer);
        totals[id] += counts[id];
        ownedIndexBytes += indexBytes.length;
        batches.push(
          Object.freeze({
            materialKey: keys[id],
            materialIndex: id,
            triangleCount: counts[id],
            indexBytes,
          })
        );
      }
    const append = (id, a, b, c) => {
      const view = views[id],
        offset = cursors[id];
      view.setUint16(offset, a, true);
      view.setUint16(offset + 2, b, true);
      view.setUint16(offset + 4, c, true);
      cursors[id] += 6;
    };
    for (let z = 0; z < quadRows; z++)
      for (let x = 0; x < gridWidth; x++) {
        const a = z * terrainWidth + x;
        append(materialFor(x, startZ + z, 0), a, a + terrainWidth, a + 1);
        append(materialFor(x, startZ + z, 1), a + 1, a + terrainWidth, a + terrainWidth + 1);
      }
    uploadedVertices += vertexCount;
    strips.push(
      Object.freeze({
        startZ,
        quadRows,
        sourceVertexOffset: startZ * terrainWidth,
        vertexCount,
        triangleCount: gridWidth * quadRows * 2,
        batches: Object.freeze(batches),
      })
    );
  }
  const materials = Object.freeze(
    keys.map((materialKey, id) =>
      Object.freeze({
        materialKey,
        materialIndex: id,
        cellCount: cellCounts[id],
        triangleCount: totals[id],
      })
    )
  );
  const metadata = Object.freeze({
    schema: 'openrtw-aerial-terrain-batches-v1',
    worldWidth,
    worldHeight,
    terrainWidth,
    terrainHeight,
    sampleStep: 0.5,
    sourceVertices: terrainWidth * terrainHeight,
    uploadedVertices,
    triangleCount,
    ownedIndexBytes,
    materialCount: keys.length,
    stripCount: strips.length,
    maxStripVertices,
    maxMaterials,
    maxKeyLength,
    maxIndexBytes,
    presentationPolicy: aerialTerrainBatchPolicy,
  });
  return Object.freeze({ metadata, materials, strips: Object.freeze(strips) });
}
