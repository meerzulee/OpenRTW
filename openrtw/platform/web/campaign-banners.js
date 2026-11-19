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

const uint = (n) => Number.isInteger(n) && n >= 0 && n <= 0xffffffff;
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const clamp = (n) => Math.max(0, Math.min(1, n));
const maxActors = 4096;
export const campaignBannerPolicy = Object.freeze({
  id: 'openrtw-source-campaign-standards-v1',
  army: 'A46A4D-source-pole-scale-and-cloth-bounds;A4129E-fixed-worldXY',
  strength: 'explicit-count-capacity-only;constant-cloth-extents;no-level-or-experience-meter',
  anchor:
    'type4-posed-hand-through-body-transform-plus-native(-.01,+.2,+.09);unattached-prototype-standards-beside-body-bounds',
  emblem: 'source-atlas-quadrant;native-army-.35-square',
  fallback: 'unmodeled-nonarmy-and-navy:source-faction-emblem-only-placeholder',
  rebels: 'source-standard_index;native-rebel-type-substitution-unported',
  lighting: 'source-piece-light*.36;CPU-RGB8-bake;native-material-specular-unported',
  fog: 'caller-supplies-only-actors-with-native-visibility>=2',
  animation:
    'static-source-pole;optional-web-travel-heading-shared-with-body;native-cloth-ripple-unported',
});

function lightRgb(rgb, normal, lighting) {
  const lambert = Math.max(
    0,
    normal.reduce((sum, n, k) => sum + n * lighting.toLight[k], 0)
  );
  return rgb.map((c, k) =>
    Math.round(
      c *
        clamp(
          Math.round(255 * lighting.piece_ambient_colour[k] * 0.36) / 255 +
            0.36 * lighting.piece_diffuse_colour[k] * lambert
        )
    )
  );
}
function put(view, index, x, y, z, rgb, u, v) {
  const at = index * 24;
  view.setFloat32(at, x, true);
  view.setFloat32(at + 4, y, true);
  view.setFloat32(at + 8, z, true);
  view.setUint32(at + 12, (0xff000000 | (rgb[0] << 16) | (rgb[1] << 8) | rgb[2]) >>> 0, true);
  view.setFloat32(at + 16, u, true);
  view.setFloat32(at + 20, v, true);
}
function actorState(actor, modelHeight) {
  if (
    !actor ||
    !uint(actor.id) ||
    typeof actor.faction !== 'string' ||
    actor.faction.length > 128 ||
    !Number.isInteger(actor.x) ||
    !Number.isInteger(actor.y) ||
    actor.x < 0 ||
    actor.y < 0 ||
    actor.x > 4095 ||
    actor.y > 4095 ||
    !Number.isFinite(actor.footY) ||
    Math.abs(actor.footY) > 10000 ||
    !Number.isInteger(actor.armyRecords ?? 0) ||
    (actor.armyRecords ?? 0) < 0 ||
    (actor.armyRecords ?? 0) > 4096 ||
    !Number.isFinite(modelHeight) ||
    modelHeight <= 0 ||
    modelHeight > 100
  )
    throw new TypeError('Invalid campaign banner actor');
  const visualX = actor.visualX ?? actor.x,
    visualY = actor.visualY ?? actor.y,
    heading = actor.heading ?? 0;
  if (
    ![visualX, visualY, heading].every(Number.isFinite) ||
    visualX < 0 ||
    visualY < 0 ||
    visualX > 4095 ||
    visualY > 4095 ||
    Math.abs(heading) > 1e6
  )
    throw new TypeError('Invalid campaign banner travel pose');
  const army = (actor.armyRecords ?? 0) > 0 && actor.type !== 'admiral';
  const anchor = actor.bannerAnchor ?? [
    visualX + 0.5 - 0.01,
    actor.footY + 0.2,
    visualY + 0.5 + 0.09,
  ];
  if (
    !Array.isArray(anchor) ||
    anchor.length !== 3 ||
    anchor.some((v) => !Number.isFinite(v) || Math.abs(v) > 10000)
  )
    throw new TypeError('Invalid campaign banner anchor');
  const strength = actor.strength ?? null;
  if (
    strength !== null &&
    (!Number.isFinite(strength.count) ||
      strength.count < 0 ||
      strength.count > 1e9 ||
      !Number.isFinite(strength.capacity) ||
      strength.capacity <= 0 ||
      strength.capacity > 1e9 ||
      typeof strength.policy !== 'string' ||
      !strength.policy ||
      strength.policy.length > 128)
  )
    throw new TypeError('Invalid campaign banner strength');
  return { army, anchor: [...anchor], strength, visualX, visualY, heading };
}

/** Native quads use a fixed world XY plane. Their source planes can also serve
 * as UI targets; these decorative vertices do not introduce physics collision.
 */
export function campaignBannerVertices(assets, actor, modelHeight = 1.45) {
  const { army, anchor, strength, visualX, visualY, heading } = actorState(actor, modelHeight),
    faction = assets.factions.get(actor.faction);
  if (!faction) throw new Error('Campaign banner faction is unavailable');
  const { topLeft: tl, bottomRight: br } = assets.rectangle,
    width = br[0] - tl[0],
    height = tl[1] - br[1],
    normal = assets.lighting.toLight,
    primary = [...faction.primaryRgb];
  if (army && actor.bannerAnchor === undefined && actor.bodyBoundsX !== undefined) {
    const bounds = actor.bodyBoundsX;
    if (
      !Array.isArray(bounds) ||
      bounds.length !== 2 ||
      [...bounds].some((v) => !Number.isFinite(v)) ||
      bounds[0] > bounds[1]
    )
      throw new TypeError('Invalid campaign banner body bounds');
    let left = tl[0],
      bottom = Infinity;
    for (let i = 0; i < assets.pole.positions.length; i += 3) {
      left = Math.min(left, assets.pole.positions[i]);
      bottom = Math.min(bottom, assets.pole.positions[i + 1]);
    }
    // Presentation fallback for prototype meshes lacking a source attachment.
    // The complete pole and cloth stay outside the body's measured X interval.
    anchor[0] = bounds[1] - left + 0.01;
    anchor[1] = actor.footY - bottom;
  }
  let base = primary,
    lighter = primary.map((c) => c + Math.floor((255 - c) / 2));
  if (primary.every((c) => c > 210)) {
    lighter = primary;
    base = [160, 160, 160];
  }
  const baseLight = lightRgb(base, normal, assets.lighting),
    upperLight = lightRgb(lighter, normal, assets.lighting);
  const cloth = new Uint8Array(army ? 8 * 24 : 0),
    cv = new DataView(cloth.buffer),
    uv = assets.standards.clothUv;
  // A4129E saturates the count first, then forms the +/-10 transition band.
  const count = strength ? Math.min(strength.count, strength.capacity) : 0;
  const levels = strength
    ? [1, clamp((count + 10) / strength.capacity), clamp((count - 10) / strength.capacity), 0]
    : [1, 2 / 3, 1 / 3, 0];
  if (army)
    for (let row = 0; row < 4; row++) {
      const fraction = levels[row],
        y = anchor[1] + br[1] + height * fraction,
        v = uv[3] + (uv[1] - uv[3]) * fraction,
        color = strength
          ? row < 2
            ? upperLight
            : baseLight
          : lightRgb(primary, normal, assets.lighting);
      put(cv, row * 2, anchor[0] + tl[0], y, anchor[2] - 0.06, color, uv[0], v);
      put(cv, row * 2 + 1, anchor[0] + br[0], y, anchor[2] - 0.06, color, uv[2], v);
    }
  const emblem = new Uint8Array(4 * 24),
    ev = new DataView(emblem.buffer),
    size = 0.35,
    left = army ? anchor[0] + tl[0] + (width - size) / 2 : visualX + 0.5 - size / 2,
    bottom = army
      ? anchor[1] + tl[1] - ((height - size) * 0.2 + size)
      : actor.footY + modelHeight - size,
    z = army ? anchor[2] + tl[2] - 0.1 : visualY + 0.5 - 0.1,
    u0 = (faction.quadrant % 2) * 0.5,
    v0 = Math.floor(faction.quadrant / 2) * 0.5,
    white = lightRgb([255, 255, 255], normal, assets.lighting);
  put(ev, 0, left, bottom + size, z, white, u0, v0);
  put(ev, 1, left + size, bottom + size, z, white, u0 + 0.5, v0);
  put(ev, 2, left, bottom, z, white, u0, v0 + 0.5);
  put(ev, 3, left + size, bottom, z, white, u0 + 0.5, v0 + 0.5);
  // CPU cloth/emblem positions and the pole's WORLD matrix use the exact same
  // optional heading. The frame's hit planes are built from these rotated bytes.
  if (heading) {
    const cosine = Math.cos(heading),
      sine = Math.sin(heading),
      ax = army ? anchor[0] : visualX + 0.5,
      az = army ? anchor[2] : visualY + 0.5;
    for (const bytes of [cloth, emblem]) {
      const view = new DataView(bytes.buffer);
      for (let at = 0; at < bytes.length; at += 24) {
        const x = view.getFloat32(at, true) - ax,
          z = view.getFloat32(at + 8, true) - az;
        view.setFloat32(at, ax + cosine * x + sine * z, true);
        view.setFloat32(at + 8, az - sine * x + cosine * z, true);
      }
    }
  }
  return {
    role: army ? 'army-standard' : 'source-emblem-placeholder',
    anchor,
    heading,
    cloth,
    emblem,
    page: faction.page,
    strengthPolicy: army && strength ? strength.policy : null,
  };
}

function indices(values) {
  const b = new Uint8Array(values.length * 2),
    v = new DataView(b.buffer);
  values.forEach((n, i) => v.setUint16(i * 2, n, true));
  return b;
}
function ownAssets(input) {
  if (
    !input ||
    !(input.factions instanceof Map) ||
    !input.factions.size ||
    input.factions.size > 256 ||
    !(input.textures instanceof Map) ||
    input.textures.size > 9
  )
    throw new TypeError('Invalid campaign banner assets');
  const factions = new Map();
  for (const [id, f] of input.factions) {
    if (
      typeof id !== 'string' ||
      id.length > 128 ||
      !Array.isArray(f.primaryRgb) ||
      f.primaryRgb.length !== 3 ||
      f.primaryRgb.some((c) => !Number.isInteger(c) || c < 0 || c > 255) ||
      !Number.isInteger(f.quadrant) ||
      f.quadrant < 0 ||
      f.quadrant > 3 ||
      !input.textures.has(f.page)
    )
      throw new TypeError('Invalid campaign banner faction assets');
    factions.set(id, { primaryRgb: [...f.primaryRgb], quadrant: f.quadrant, page: f.page });
  }
  const lighting = {};
  for (const name of ['piece_ambient_colour', 'piece_diffuse_colour', 'toLight']) {
    const values = input.lighting?.[name];
    if (
      !Array.isArray(values) ||
      values.length !== 3 ||
      values.some((v) => !Number.isFinite(v) || Math.abs(v) > 16)
    )
      throw new TypeError('Invalid campaign banner lighting');
    lighting[name] = [...values];
  }
  const rectangle = {};
  for (const name of ['topLeft', 'bottomRight']) {
    const p = input.rectangle?.[name];
    if (
      !Array.isArray(p) ||
      p.length !== 3 ||
      p.some((v) => !Number.isFinite(v) || Math.abs(v) > 100)
    )
      throw new TypeError('Invalid campaign banner bounds');
    rectangle[name] = [...p];
  }
  if (
    rectangle.topLeft[0] >= rectangle.bottomRight[0] ||
    rectangle.topLeft[1] <= rectangle.bottomRight[1]
  )
    throw new TypeError('Invalid campaign banner rectangle');
  const clothUv = input.standards?.clothUv;
  if (
    !Array.isArray(clothUv) ||
    clothUv.length !== 4 ||
    clothUv.some((v) => !Number.isFinite(v) || v < 0 || v > 1)
  )
    throw new TypeError('Invalid campaign banner texture coordinates');
  const p = input.pole,
    count = p?.positions?.length / 3;
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    count > 65535 ||
    !Array.isArray(p.normals) ||
    p.normals.length !== count * 3 ||
    !Array.isArray(p.uvs) ||
    p.uvs.length !== count * 2 ||
    !(p.indexBytes instanceof Uint8Array) ||
    !uint(p.triangles) ||
    !p.triangles ||
    p.indexBytes.length !== p.triangles * 6 ||
    p.triangles > 65535 ||
    [...p.positions, ...p.normals, ...p.uvs].some((v) => !Number.isFinite(v) || Math.abs(v) > 10000)
  )
    throw new TypeError('Invalid campaign banner pole geometry');
  const pole = {
    positions: [...p.positions],
    normals: [...p.normals],
    uvs: [...p.uvs],
    indexBytes: new Uint8Array(p.indexBytes),
    triangles: p.triangles,
  };
  const ids = new DataView(pole.indexBytes.buffer);
  for (let i = 0; i < pole.indexBytes.length; i += 2)
    if (ids.getUint16(i, true) >= count) throw new TypeError('Invalid campaign banner pole index');
  const textures = new Map();
  let total = 0;
  for (const [key, texture] of input.textures) {
    const m = texture?.metadata,
      b = texture?.source;
    if (
      !(b instanceof Uint8Array) ||
      !(b.buffer instanceof ArrayBuffer) ||
      b.length < 128 ||
      (total += b.length) > 16 * 1024 * 1024 ||
      !['DXT1', 'DXT3', 'DXT5'].includes(m?.format) ||
      !uint(m.width) ||
      !uint(m.height) ||
      !m.width ||
      !m.height ||
      m.width > 2048 ||
      m.height > 2048 ||
      !Array.isArray(m.mips) ||
      !m.mips.length ||
      m.mips.length > 12
    )
      throw new TypeError('Invalid campaign banner texture');
    let end = 128;
    const mips = [];
    for (const [level, mip] of m.mips.entries()) {
      const width = Math.max(1, m.width >> level),
        height = Math.max(1, m.height >> level),
        size = Math.ceil(width / 4) * Math.ceil(height / 4) * (m.format === 'DXT1' ? 8 : 16);
      if (
        mip.level !== level ||
        mip.width !== width ||
        mip.height !== height ||
        mip.range?.start !== end ||
        mip.range.endExclusive !== end + size ||
        end + size > b.length
      )
        throw new TypeError('Invalid campaign banner mip');
      mips.push({ level, start: end, end: end + size });
      end += size;
    }
    if (end !== b.length) throw new TypeError('Invalid campaign banner texture extent');
    textures.set(key, {
      width: m.width,
      height: m.height,
      format: m.format,
      mips,
      source: new Uint8Array(b),
    });
  }
  if (!textures.has('pole')) throw new TypeError('Missing campaign pole texture');
  return { factions, lighting, rectangle, standards: { clothUv: [...clothUv] }, pole, textures };
}

export function createCampaignBanners({ renderer, assets: input }) {
  const assets = ownAssets(input),
    buffers = [],
    textures = new Map();
  let disposed = false,
    last = { armies: 0, placeholders: 0, strength: 0 },
    frameTargets = new WeakMap();
  const noTargets = Object.freeze([]);
  const alive = () => {
    if (disposed) throw new Error('Campaign banners disposed');
  };
  const release = () => {
    const errors = [];
    for (const id of textures.values())
      try {
        renderer.destroyTexture(id);
      } catch (e) {
        errors.push(e);
      }
    textures.clear();
    for (const id of buffers.splice(0))
      try {
        renderer.destroyBuffer(id);
      } catch (e) {
        errors.push(e);
      }
    if (errors.length) throw new AggregateError(errors, 'Campaign banner cleanup failed');
  };
  let poleVb, poleIb, clothVb, clothIb, emblemVb, emblemIb;
  const api = Object.freeze({
    hasActor(actor) {
      alive();
      return assets.factions.has(actor?.faction);
    },
    // The scene supplies its last successfully presented actor-array identity.
    // Retaining weak frame keys preserves old picks when a later present fails.
    hitTargets(actors) {
      alive();
      return frameTargets.get(actors) ?? noTargets;
    },
    status() {
      alive();
      return {
        armyStandards: last.armies,
        emblemPlaceholders: last.placeholders,
        rendered: last.armies + last.placeholders,
        withStrength: last.strength,
        handAttached: last.handAttached ?? 0,
        poleVertices: assets.pole.positions.length / 3,
        poleTriangles: assets.pole.triangles,
        policy: campaignBannerPolicy,
      };
    },
    draw({ actors, view, projection, modelHeight = 1.45, timeSeconds = 0 } = {}) {
      alive();
      if (
        !Array.isArray(actors) ||
        actors.length > maxActors ||
        !Number.isFinite(timeSeconds) ||
        timeSeconds < 0
      )
        throw new TypeError('Invalid campaign banner frame');
      for (const m of [view, projection])
        if (
          m !== undefined &&
          (!m || m.length !== 16 || Array.from(m).some((v) => !Number.isFinite(v)))
        )
          throw new TypeError('Invalid campaign banner view');
      const ids = new Set(),
        rows = [];
      for (const actor of actors) {
        if (ids.has(actor?.id)) throw new TypeError('Duplicate campaign banner actor');
        ids.add(actor?.id);
        if (assets.factions.has(actor?.faction))
          rows.push({
            ...campaignBannerVertices(assets, actor, modelHeight),
            id: actor.id,
            x: actor.x,
            y: actor.y,
          });
      }
      const next = {
        armies: rows.filter((r) => r.role === 'army-standard').length,
        placeholders: rows.filter((r) => r.role !== 'army-standard').length,
        strength: rows.filter((r) => r.strengthPolicy).length,
        handAttached: actors.filter(
          (actor) => assets.factions.has(actor.faction) && actor.bannerAnchor
        ).length,
      };
      renderer.setFvf(Fvf.XYZ | Fvf.DIFFUSE | Fvf.TEX1);
      renderer.setMaterialLighting({ enabled: false });
      renderer.setDirectionalLighting({ enabled: false });
      if (view) renderer.setTransform(Transform.VIEW, view);
      if (projection) renderer.setTransform(Transform.PROJECTION, projection);
      renderer.setStageState(1, StageState.COLOROP, TextureOp.DISABLE);
      renderer.setTexture(1, 0);
      renderer.setRenderState(RenderState.ZENABLE, 1);
      renderer.setRenderState(RenderState.ZWRITEENABLE, 1);
      renderer.setRenderState(RenderState.ZFUNC, Compare.LESSEQUAL);
      renderer.setRenderState(RenderState.CULLMODE, 1);
      renderer.setRenderState(RenderState.ALPHATESTENABLE, 1);
      renderer.setRenderState(RenderState.ALPHAREF, 10);
      renderer.setRenderState(RenderState.ALPHAFUNC, Compare.GREATER);
      renderer.setRenderState(RenderState.ALPHABLENDENABLE, 1);
      renderer.setRenderState(RenderState.SRCBLEND, Blend.SRCALPHA);
      renderer.setRenderState(RenderState.DESTBLEND, Blend.INVSRCALPHA);
      renderer.setStageState(0, StageState.COLOROP, TextureOp.MODULATE2X);
      renderer.setStageState(0, StageState.COLORARG1, TextureArg.TEXTURE);
      renderer.setStageState(0, StageState.COLORARG2, TextureArg.DIFFUSE);
      renderer.setStageState(0, StageState.ALPHAOP, TextureOp.MODULATE);
      renderer.setStageState(0, StageState.ALPHAARG1, TextureArg.TEXTURE);
      renderer.setStageState(0, StageState.ALPHAARG2, TextureArg.DIFFUSE);
      renderer.setStageState(0, StageState.TEXCOORDINDEX, 0);
      renderer.setStageState(0, StageState.TEXTURETRANSFORMFLAGS, 0);
      for (const state of [StageState.ADDRESSU, StageState.ADDRESSV])
        renderer.setStageState(0, state, Address.WRAP);
      for (const state of [StageState.MINFILTER, StageState.MAGFILTER, StageState.MIPFILTER])
        renderer.setStageState(0, state, Filter.LINEAR);
      const draw = (vb, ib, count) => {
        renderer.setStream(vb, 24);
        renderer.setIndices(ib, 0);
        renderer.drawIndexed({ primitive: Primitive.TRIANGLELIST, primitiveCount: count });
      };
      try {
        for (const row of rows) {
          if (row.role === 'army-standard') {
            const matrix = [...identity];
            if (row.heading) {
              const cosine = Math.cos(row.heading),
                sine = Math.sin(row.heading);
              matrix[0] = matrix[10] = cosine;
              matrix[2] = -sine;
              matrix[8] = sine;
            }
            matrix.splice(12, 3, ...row.anchor);
            renderer.setTransform(Transform.WORLD, matrix);
            renderer.setTexture(0, textures.get('pole'));
            draw(poleVb, poleIb, assets.pole.triangles);
            renderer.setTransform(Transform.WORLD, identity);
            renderer.uploadBuffer(clothVb, row.cloth, { discard: true });
            draw(clothVb, clothIb, 6);
          }
          renderer.setTransform(Transform.WORLD, identity);
          renderer.setTexture(0, textures.get(row.page));
          renderer.uploadBuffer(emblemVb, row.emblem, { discard: true });
          draw(emblemVb, emblemIb, 2);
        }
        last = next;
      } finally {
        renderer.setTransform(Transform.WORLD, identity);
        renderer.setTexture(0, 0);
        renderer.setRenderState(RenderState.ALPHATESTENABLE, 0);
        renderer.setRenderState(RenderState.ALPHABLENDENABLE, 0);
        renderer.setRenderState(RenderState.ALPHAREF, 0);
        renderer.setRenderState(RenderState.CULLMODE, 1);
        for (const [op, arg] of [
          [StageState.COLOROP, StageState.COLORARG1],
          [StageState.ALPHAOP, StageState.ALPHAARG1],
        ]) {
          renderer.setStageState(0, op, TextureOp.SELECTARG1);
          renderer.setStageState(0, arg, TextureArg.DIFFUSE);
        }
      }
      const quad = (bytes, indices) => {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        return Object.freeze(
          indices.map((i) =>
            Object.freeze([0, 4, 8].map((offset) => view.getFloat32(i * 24 + offset, true)))
          )
        );
      };
      frameTargets.set(
        actors,
        Object.freeze(
          rows.map((row) =>
            Object.freeze({
              kind: 'character',
              id: row.id,
              x: row.x,
              y: row.y,
              policy: 'rendered-source-cloth-and-emblem-planes;texture-alpha-not-a-hit-mask',
              quads: Object.freeze([
                ...(row.cloth.length ? [quad(row.cloth, [0, 1, 6, 7])] : []),
                quad(row.emblem, [0, 1, 2, 3]),
              ]),
            })
          )
        )
      );
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      frameTargets = new WeakMap();
      release();
    },
  });
  try {
    const buffer = (kind, bytes, dynamic = false) => {
      const id = renderer.createBuffer({ kind, bytes: bytes.length, dynamic });
      if (!uint(id) || !id) throw new Error('Invalid campaign banner buffer');
      buffers.push(id);
      renderer.uploadBuffer(id, bytes);
      return id;
    };
    const pole = new Uint8Array((assets.pole.positions.length / 3) * 24),
      pv = new DataView(pole.buffer);
    for (let i = 0; i < assets.pole.positions.length / 3; i++)
      put(
        pv,
        i,
        ...assets.pole.positions.slice(i * 3, i * 3 + 3),
        lightRgb([255, 255, 255], assets.pole.normals.slice(i * 3, i * 3 + 3), assets.lighting),
        ...assets.pole.uvs.slice(i * 2, i * 2 + 2)
      );
    poleVb = buffer(BufferKind.VERTEX, pole);
    poleIb = buffer(BufferKind.INDEX16, assets.pole.indexBytes);
    clothVb = buffer(BufferKind.VERTEX, new Uint8Array(192), true);
    clothIb = buffer(
      BufferKind.INDEX16,
      indices([0, 2, 1, 1, 2, 3, 2, 4, 3, 3, 4, 5, 4, 6, 5, 5, 6, 7])
    );
    emblemVb = buffer(BufferKind.VERTEX, new Uint8Array(96), true);
    emblemIb = buffer(BufferKind.INDEX16, indices([0, 2, 1, 1, 2, 3]));
    for (const [key, t] of assets.textures) {
      const id = renderer.createTexture({
        width: t.width,
        height: t.height,
        levels: t.mips.length,
        format: TextureFormat[t.format],
      });
      if (!uint(id) || !id) throw new Error('Invalid campaign banner texture');
      textures.set(key, id);
      for (const m of t.mips)
        renderer.uploadTexture(id, m.level, t.source.subarray(m.start, m.end), { rowPitch: 0 });
    }
  } catch (error) {
    try {
      api.dispose();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Campaign banner construction failed');
    }
    throw error;
  }
  return api;
}
