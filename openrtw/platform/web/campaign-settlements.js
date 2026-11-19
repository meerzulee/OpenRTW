import {
  BufferKind,
  Primitive,
  Fvf,
  Transform,
  RenderState,
  StageState,
  TextureArg,
} from '/reference/renderer-bridge.js';

// Source coordinates stay unchanged. These static props do not participate in
// actor picking, AP, ownership, pathfinding or settlement simulation.
const sourceRows = Object.freeze([
  Object.freeze({
    region: 'Etruria',
    x: 91,
    y: 80,
    sourceLine: 454,
    sourceSection: 'romans_julii',
    level: 'large_town',
  }),
  Object.freeze({
    region: 'Umbria',
    x: 96,
    y: 82,
    sourceLine: 489,
    sourceSection: 'romans_julii',
    level: 'large_town',
  }),
]);
const identity = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const uint = (v) => Number.isInteger(v) && v >= 0 && v <= 0xffffffff;
const finite = Number.isFinite;
const modelHash = 'c7df731873dc764dc6cc98f6921f3339605f2db5ec6b4836215368afd9cb1997';
const textureHash = 'c06b1002d731b3a3040f324dcf138545acc6bd3bf4ce3bf1c8621197313d3724';

/** Caller supplies the scene's same read-only visible terrain/water surface.
 * draw inherits VIEW/PROJECTION, restores WORLD identity, and never presents.
 * There is deliberately no picking API or registration in the actor ID map.
 */
export function createCampaignSettlements({
  renderer,
  assets,
  settlements,
  surfaceAt,
  footprintCells = 2,
  drawParts = [0],
}) {
  if (
    typeof surfaceAt !== 'function' ||
    !finite(footprintCells) ||
    footprintCells < 0.25 ||
    footprintCells > 4 ||
    !Array.isArray(settlements) ||
    settlements.length !== 2 ||
    !Array.isArray(drawParts) ||
    !drawParts.length ||
    drawParts.length > 2 ||
    new Set(drawParts).size !== drawParts.length ||
    drawParts.some((p) => p !== 0 && p !== 1)
  )
    throw new TypeError('Invalid town scene inputs');
  const selected = sourceRows.map((expected) => {
    const matches = settlements.filter((row) => row?.region === expected.region);
    if (
      matches.length !== 1 ||
      Object.entries(expected).some(([key, value]) => matches[0][key] !== value)
    )
      throw new Error('Town source binding differs');
    return { ...expected };
  });
  const g = assets?.geometry,
    parts = assets?.partRanges;
  if (
    assets?.sourceSha256 !== modelHash ||
    assets.texture?.sourceSha256 !== textureHash ||
    typeof assets.texture.create !== 'function' ||
    !(g?.vertices instanceof Uint8Array) ||
    g.vertices.length !== 635 * 24 ||
    !(g.indexBytes instanceof Uint8Array) ||
    g.indexBytes.length !== 918 * 2 ||
    !Array.isArray(parts) ||
    parts.length !== 2 ||
    parts[0].name !== 'roman_large_town_buildings' ||
    parts[1].name !== 'roman_large_town_buildings_fade'
  )
    throw new TypeError('Invalid town geometry owner');
  const vertices = g.vertices.slice(),
    indices = g.indexBytes.slice(),
    view = new DataView(vertices.buffer),
    indexView = new DataView(indices.buffer),
    points = [];
  const lo = [Infinity, Infinity, Infinity],
    hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 635; i++) {
    const p = [0, 1, 2].map((k) => view.getFloat32(i * 24 + k * 4, true));
    if (
      p.some((v) => !finite(v) || Math.abs(v) > 100) ||
      [16, 20].some((at) => !finite(view.getFloat32(i * 24 + at, true)))
    )
      throw new Error('Town vertex is invalid');
    p.forEach((v, k) => {
      lo[k] = Math.min(lo[k], v);
      hi[k] = Math.max(hi[k], v);
    });
    points.push(p);
  }
  for (let i = 0; i < 918; i++)
    if (indexView.getUint16(i * 2, true) >= 635) throw new Error('Town index is invalid');
  let firstVertex = 0,
    firstIndex = 0;
  const ownedParts = parts.map((part, i) => {
    const vertices = i === 0 ? 499 : 136,
      triangles = i === 0 ? 242 : 64;
    if (
      part.index !== i ||
      part.firstVertex !== firstVertex ||
      part.vertices !== vertices ||
      part.firstIndex !== firstIndex ||
      part.triangles !== triangles ||
      part.indexCount !== triangles * 3
    )
      throw new Error('Town part range is invalid');
    for (let at = firstIndex; at < firstIndex + triangles * 3; at++) {
      const index = indexView.getUint16(at * 2, true);
      if (index < firstVertex || index >= firstVertex + vertices)
        throw new Error('Town part index is invalid');
    }
    const ranges = {};
    for (const key of ['recordRange', 'colorRange']) {
      const r = part[key];
      if (
        !r ||
        !uint(r.start) ||
        !uint(r.endExclusive) ||
        r.start > r.endExclusive ||
        r.endExclusive > 25434
      )
        throw new Error('Town source range is invalid');
      ranges[key] = Object.freeze({ ...r });
    }
    const result = Object.freeze({
      index: i,
      name: part.name,
      firstVertex,
      vertices,
      firstIndex,
      indexCount: triangles * 3,
      triangles,
      ...ranges,
    });
    firstVertex += vertices;
    firstIndex += triangles * 3;
    return result;
  });
  const span = Math.max(hi[0] - lo[0], hi[2] - lo[2]),
    scale = footprintCells / span;
  if (!finite(span) || span <= 0 || !finite(scale) || scale <= 0)
    throw new Error('Town footprint is degenerate');
  const chosen = drawParts.map((i) => ownedParts[i]);
  const bindings = Object.freeze(
    selected.map((row) => {
      let base = -Infinity;
      for (const part of chosen)
        for (let i = part.firstVertex; i < part.firstVertex + part.vertices; i++) {
          const p = points[i],
            height = surfaceAt(row.x + 0.5 + p[0] * scale, row.y + 0.5 + p[2] * scale);
          if (!finite(height) || Math.abs(height) > 1e6) throw new Error('Town surface is invalid');
          base = Math.max(base, height - p[1] * scale);
        }
      if (!finite(base)) throw new Error('Town anchor is invalid');
      return Object.freeze({
        ...row,
        modelKey: 'roman-large-town',
        modelSha256: modelHash,
        textureSha256: textureHash,
        worldX: row.x + 0.5,
        worldZ: row.y + 0.5,
        base,
        scale,
        footprintCells,
        drawParts: Object.freeze([...drawParts]),
        parts: Object.freeze(ownedParts),
        policy: 'openrtw-roman-large-town-static-candidate-v1',
      });
    })
  );
  let vb = 0,
    ib = 0,
    texture = null,
    disposed = false;
  function release() {
    const errors = [],
      owner = texture;
    texture = null;
    if (owner)
      try {
        owner.dispose();
      } catch (error) {
        errors.push(error);
      }
    for (const old of [ib, vb])
      if (old)
        try {
          renderer.destroyBuffer(old);
        } catch (error) {
          errors.push(error);
        }
    vb = 0;
    ib = 0;
    if (errors.length) throw new AggregateError(errors, 'Town resource cleanup failed');
  }
  const api = Object.freeze({
    bindings,
    draw(combined, fog = null) {
      if (disposed) throw new Error('Town scene is disposed');
      if (fog !== null && typeof fog?.structureKnown !== 'function')
        throw new TypeError('Town scene requires fog.structureKnown');
      // These fixed source props use the known-cell geometry threshold. They
      // remain an initial snapshot, not native live or updated shroud records.
      const visible = bindings.filter(
        (town) => fog === null || fog.structureKnown(town.x, town.y) === true
      );
      renderer.setFvf(Fvf.XYZ | Fvf.DIFFUSE | Fvf.TEX1);
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
      renderer.setStream(vb, 24);
      renderer.setIndices(ib, 0);
      try {
        texture.bind();
        for (const town of visible) {
          const s = town.scale;
          renderer.setTransform(Transform.WORLD, [
            s,
            0,
            0,
            0,
            0,
            s,
            0,
            0,
            0,
            0,
            s,
            0,
            town.worldX,
            town.base,
            town.worldZ,
            1,
          ]);
          for (const part of chosen)
            renderer.drawIndexed({
              primitive: Primitive.TRIANGLELIST,
              primitiveCount: part.triangles,
              startIndex: part.firstIndex,
            });
        }
      } finally {
        renderer.setTransform(Transform.WORLD, identity);
        renderer.setTexture(0, 0);
        for (const state of [StageState.COLORARG1, StageState.ALPHAARG1])
          renderer.setStageState(0, state, TextureArg.DIFFUSE);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      release();
    },
  });
  try {
    vb = renderer.createBuffer({ kind: BufferKind.VERTEX, bytes: vertices.length });
    if (!uint(vb) || !vb) throw new Error('Invalid town vertex buffer');
    renderer.uploadBuffer(vb, vertices);
    ib = renderer.createBuffer({ kind: BufferKind.INDEX16, bytes: indices.length });
    if (!uint(ib) || !ib) throw new Error('Invalid town index buffer');
    renderer.uploadBuffer(ib, indices);
    texture = assets.texture.create(renderer);
    if (!texture || typeof texture.bind !== 'function' || typeof texture.dispose !== 'function')
      throw new Error('Invalid town texture owner');
  } catch (error) {
    try {
      release();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Town scene creation failed');
    }
    throw error;
  }
  return api;
}
