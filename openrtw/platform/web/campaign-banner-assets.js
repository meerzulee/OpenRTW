import {
  loadSettlementInput,
  settlementPublication,
  settlementLighting,
} from '/settlement-model-assets.js';

const cap = 8 * 1024 * 1024;
const uint = (n) => Number.isInteger(n) && n >= 0 && n <= 0xffffffff;
function text(bytes) {
  if (
    !(bytes instanceof Uint8Array) ||
    !(bytes.buffer instanceof ArrayBuffer) ||
    !bytes.length ||
    bytes.length > 256 * 1024
  )
    throw new TypeError('Invalid campaign banner descriptor');
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/;[^\n]*/g, '');
}
const numeric = (s) => Number(s.replace(/f$/i, ''));
export function parseCampaignStandards(bytes) {
  let scale = null,
    section = null,
    armyScale = null,
    clothUv = null;
  const symbols = [],
    seen = new Set();
  for (const line of text(bytes).split(/\r?\n/)) {
    const row = line.trim().split(/[\s,]+/);
    if (!row[0]) continue;
    const [key, ...value] = row;
    if (key === 'file_scale') {
      if (
        value.length !== 1 ||
        !Number.isFinite((scale = numeric(value[0]))) ||
        scale <= 0 ||
        scale > 4
      )
        throw new Error('Invalid campaign banner scale');
    } else if (key === 'file_army_banner') {
      if (
        armyScale !== null ||
        scale === null ||
        value.length !== 1 ||
        value[0].toLowerCase() !== 'data/banners/strat_flag.cas'
      )
        throw new Error('Unsupported campaign army banner source');
      armyScale = scale;
    } else if (key === 'banner_flag') {
      if (clothUv !== null || value.length !== 4) throw new Error('Invalid campaign banner UV row');
      clothUv = value.map(numeric);
      if (
        clothUv.some((v) => !Number.isFinite(v) || v < 0 || v > 1) ||
        clothUv[0] >= clothUv[2] ||
        clothUv[1] >= clothUv[3]
      )
        throw new Error('Invalid campaign banner UV rectangle');
    } else if (key === 'factions' || key === 'rebels_factions') {
      if (value.length) throw new Error('Invalid campaign standards section');
      section = key;
    } else if (key === 'symbols') {
      const match = value.length === 1 && /^banners\/symbols([1-8])\.tga$/i.exec(value[0]);
      if (!section || !match || seen.has(match[1]))
        throw new Error('Unsupported campaign symbol atlas');
      seen.add(match[1]);
      symbols.push({
        key: 'symbols' + match[1],
        asset: 'campaignBannerSymbols' + match[1],
        section,
      });
    }
  }
  if (armyScale === null || clothUv === null || symbols.length !== 8)
    throw new Error('Campaign standards descriptor is incomplete');
  return Object.freeze({
    armyScale: Math.fround(armyScale),
    clothUv: Object.freeze(clothUv),
    symbols: Object.freeze(symbols.map(Object.freeze)),
  });
}

export function parseCampaignBannerFactions(bytes, standards) {
  const factions = new Map();
  let current = null;
  for (const line of text(bytes).split(/\r?\n/)) {
    const row = line.trim().split(/[\s,]+/);
    if (!row[0]) continue;
    const [key, ...value] = row;
    if (key === 'faction') {
      if (
        value.length !== 1 ||
        !/^[a-z][a-z0-9_]{0,127}$/.test(value[0]) ||
        factions.has(value[0]) ||
        factions.size >= 256
      )
        throw new Error('Invalid campaign banner faction');
      current = { id: value[0], primaryRgb: null, standardIndex: null };
      factions.set(value[0], current);
    } else if (key === 'primary_colour' && current) {
      if (
        current.primaryRgb ||
        value.length !== 6 ||
        value[0] !== 'red' ||
        value[2] !== 'green' ||
        value[4] !== 'blue'
      )
        throw new Error('Invalid campaign banner faction colour');
      current.primaryRgb = [value[1], value[3], value[5]].map(Number);
      if (current.primaryRgb.some((v) => !Number.isInteger(v) || v < 0 || v > 255))
        throw new Error('Invalid campaign banner faction colour');
    } else if (key === 'standard_index' && current) {
      if (current.standardIndex !== null || value.length !== 1 || !/^\d+$/.test(value[0]))
        throw new Error('Invalid campaign standard index');
      current.standardIndex = Number(value[0]);
    }
  }
  if (!factions.size) throw new Error('Missing campaign banner factions');
  for (const faction of factions.values()) {
    const index = faction.standardIndex;
    if (!faction.primaryRgb || !uint(index) || index >= standards.symbols.length * 4)
      throw new Error('Campaign banner faction is incomplete');
    faction.page = standards.symbols[Math.floor(index / 4)].key;
    faction.quadrant = index % 4;
    Object.freeze(faction.primaryRgb);
    Object.freeze(faction);
  }
  return factions;
}

function floats(words, count, name) {
  if (!Array.isArray(words) || words.length !== count || words.some((v) => !uint(v)))
    throw new Error('Invalid banner CAS ' + name);
  const data = new DataView(new ArrayBuffer(4));
  return words.map((word) => {
    data.setUint32(0, word, true);
    const value = data.getFloat32(0, true);
    if (!Number.isFinite(value) || Math.abs(value) > 10000)
      throw new Error('Invalid banner CAS float');
    return value;
  });
}
export function campaignBannerGeometry(value, scale) {
  if (
    !Array.isArray(value?.meshes) ||
    value.meshes.length > 32 ||
    !Number.isFinite(scale) ||
    scale <= 0 ||
    scale > 4
  )
    throw new Error('Invalid campaign banner CAS publication');
  const find = (name) => {
    const found = value.meshes.filter((m) => m.name === name);
    if (found.length !== 1) throw new Error('Missing or duplicate banner ' + name + ' mesh');
    const m = found[0];
    if (
      !uint(m.vertices) ||
      !m.vertices ||
      m.vertices > 65535 ||
      !uint(m.triangles) ||
      !m.triangles ||
      m.triangles > 65535
    )
      throw new Error('Invalid campaign banner mesh bounds');
    return m;
  };
  const pole = find('pole'),
    cloth = find('banner'),
    positions = floats(pole.positionBits, pole.vertices * 3, 'positions'),
    normals = floats(pole.normalBits, pole.vertices * 3, 'normals'),
    uvs = floats(pole.uvBits, pole.vertices * 2, 'UVs'),
    clothPositions = floats(cloth.positionBits, cloth.vertices * 3, 'cloth positions');
  const materialIndex = pole.materialIndex ?? pole.textureIndex,
    material = value.materials?.[materialIndex];
  if (
    !uint(materialIndex) ||
    typeof material?.name !== 'string' ||
    material.name.replace(/\\/g, '/').toLowerCase().split('/').at(-1) !== 'strat_flag.tga'
  )
    throw new Error('Unsupported campaign banner pole material');
  if (
    !Array.isArray(pole.indices) ||
    pole.indices.length !== pole.triangles * 3 ||
    pole.indices.some((v) => !uint(v) || v >= pole.vertices)
  )
    throw new Error('Invalid campaign banner indices');
  const indexBytes = new Uint8Array(pole.indices.length * 2),
    data = new DataView(indexBytes.buffer);
  pole.indices.forEach((n, i) => data.setUint16(i * 2, n, true));
  const centroid = [0, 0, 0];
  for (let i = 0; i < cloth.vertices; i++)
    for (let k = 0; k < 3; k++) centroid[k] += clothPositions[i * 3 + k] / cloth.vertices;
  const corner = (predicate) => {
    const points = [];
    for (let i = 0; i < cloth.vertices; i++) {
      const p = clothPositions.slice(i * 3, i * 3 + 3);
      if (predicate(p)) points.push(p);
    }
    if (!points.length) throw new Error('Degenerate source banner rectangle');
    return [0, 1, 2].map((k) =>
      Math.fround((points.reduce((s, p) => s + p[k], 0) / points.length) * scale)
    );
  };
  const topLeft = corner((p) => p[0] < centroid[0] && p[1] > centroid[1]),
    bottomRight = corner((p) => p[0] > centroid[0] && p[1] < centroid[1]);
  if (topLeft[0] >= bottomRight[0] || topLeft[1] <= bottomRight[1])
    throw new Error('Degenerate source banner rectangle');
  return {
    pole: {
      positions: positions.map((v) => Math.fround(v * scale)),
      normals,
      uvs,
      indexBytes,
      triangles: pole.triangles,
    },
    rectangle: Object.freeze({
      topLeft: Object.freeze(topLeft),
      bottomRight: Object.freeze(bottomRight),
    }),
    policy: 'A46A4D-raw-pole-and-banner-rectangle;no-mesh-metadata-transform;static-pole',
  };
}

function dds(core, bytes) {
  loadSettlementInput(core, bytes, '_openrtw_load_dds_texture_legacy_flags');
  const m = settlementPublication(core, '_openrtw_dds_texture_json', 8192);
  if (
    !['DXT1', 'DXT3', 'DXT5'].includes(m.format) ||
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
    throw new Error('Invalid campaign banner DDS');
  const blockBytes = m.format === 'DXT1' ? 8 : 16;
  let offset = 128;
  for (const [level, p] of m.mips.entries()) {
    const w = Math.max(1, m.width >> level),
      h = Math.max(1, m.height >> level),
      end = offset + Math.ceil(w / 4) * Math.ceil(h / 4) * blockBytes;
    if (
      p.level !== level ||
      p.width !== w ||
      p.height !== h ||
      p.range?.start !== offset ||
      p.range?.endExclusive !== end ||
      end > bytes.length
    )
      throw new Error('Invalid campaign banner DDS mip');
    offset = end;
  }
  if (offset !== bytes.length) throw new Error('Invalid campaign banner DDS extent');
  return { metadata: m, source: new Uint8Array(bytes) };
}

export async function loadCampaignBannerAssets(core, provider, { isOpen = () => true } = {}) {
  const open = () => {
    if (!isOpen()) throw new DOMException('Campaign banner loading cancelled', 'AbortError');
  };
  let total = 0;
  const read = async (name) => {
    open();
    const bytes = await provider.read(name);
    open();
    if (
      !(bytes instanceof Uint8Array) ||
      !(bytes.buffer instanceof ArrayBuffer) ||
      !bytes.length ||
      bytes.length > cap ||
      (total += bytes.length) > 16 * 1024 * 1024
    )
      throw new Error('Campaign banner asset budget exceeded');
    return new Uint8Array(bytes);
  };
  const standards = parseCampaignStandards(await read('campaignStandards')),
    factions = parseCampaignBannerFactions(await read('aerialFactionCultures'), standards),
    lighting = settlementLighting(await read('settlementLighting'));
  const modelBytes = await read('campaignBannerModel');
  loadSettlementInput(core, modelBytes, '_openrtw_load_cas_mesh_any');
  const geometry = campaignBannerGeometry(
    settlementPublication(core, '_openrtw_cas_mesh_json'),
    standards.armyScale
  );
  const textures = new Map();
  textures.set('pole', dds(core, await read('campaignBannerTexture')));
  for (const page of standards.symbols) textures.set(page.key, dds(core, await read(page.asset)));
  return {
    standards,
    factions,
    lighting,
    ...geometry,
    textures,
    metadata: Object.freeze({
      schema: 'openrtw-campaign-banner-assets-v1',
      sourceBytes: total,
      armyScale: standards.armyScale,
      factions: factions.size,
      pages: standards.symbols.length,
      poleVertices: geometry.pole.positions.length / 3,
      poleTriangles: geometry.pole.triangles,
      rectangle: geometry.rectangle,
      policy: geometry.policy,
      navy: 'not-admitted;source-emblem-placeholder',
      rebelStandards: 'descr_sm_factions-standard_index;per-rebel-type-substitution-unported',
    }),
  };
}
