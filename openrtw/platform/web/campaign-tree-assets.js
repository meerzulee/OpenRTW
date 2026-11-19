import {
  loadSettlementInput,
  settlementPublication,
  settlementLighting,
} from '/settlement-model-assets.js';

const base = 'data/terrain/aerial_map/tree_models/';
const uint = (v) => Number.isInteger(v) && v >= 0 && v <= 0xffffffff;
const bitView = new DataView(new ArrayBuffer(4));
const floats = (words, count) => {
  if (!Array.isArray(words) || words.length !== count) throw Error('Invalid tree CAS float extent');
  return words.map((word) => {
    if (!uint(word)) throw Error('Invalid tree CAS float bits');
    bitView.setUint32(0, word, true);
    const value = bitView.getFloat32(0, true);
    if (!Number.isFinite(value)) throw Error('Nonfinite tree CAS value');
    return value;
  });
};

export function campaignTreeGeometry(value) {
  if (!Array.isArray(value?.meshes) || !value.meshes.length || value.meshes.length > 64)
    throw Error('Invalid campaign tree model');
  const materials = value.materials ?? [
    { name: value.material?.textureName, cull: Boolean(value.material?.lastByte) },
  ];
  const parts = value.meshes
    .filter((mesh) => mesh.name !== 'symbol')
    .map((mesh) => {
      if (
        !uint(mesh.vertices) ||
        !mesh.vertices ||
        mesh.vertices > 16384 ||
        !uint(mesh.triangles) ||
        !mesh.triangles ||
        mesh.triangles > 32768 ||
        !Array.isArray(mesh.indices) ||
        mesh.indices.length !== mesh.triangles * 3 ||
        mesh.indices.some((index) => !uint(index) || index >= mesh.vertices)
      )
        throw Error('Invalid campaign tree mesh dimensions');
      const material = materials[mesh.materialIndex ?? mesh.textureIndex];
      if (!material || typeof material.name !== 'string')
        throw Error('Missing campaign tree material');
      const name = material.name.replace(/\\/g, '/').split('/').at(-1).toLowerCase();
      if (!/^[a-z0-9_ .#-]+\.tga$/.test(name))
        throw Error('Unsupported campaign tree material path');
      return {
        name: mesh.name,
        positions: floats(mesh.positionBits, mesh.vertices * 3),
        normals: floats(mesh.normalBits, mesh.vertices * 3),
        uvs: floats(mesh.uvBits, mesh.vertices * 2),
        indices: [...mesh.indices],
        texturePath: base + 'textures/' + name + '.dds',
        cull: Boolean(material.cull),
      };
    });
  if (!parts.length) throw Error('Campaign tree model has no drawable mesh');
  return parts;
}

export function validateCampaignTreeScene(value, season) {
  if (
    value?.schema !== 'openrtw-campaign-trees-v1' ||
    value.season !== season ||
    !Number.isInteger(value.width) ||
    value.width < 1 ||
    value.width > 255 ||
    !Number.isInteger(value.height) ||
    value.height < 1 ||
    value.height > 156 ||
    !Array.isArray(value.modelPaths) ||
    value.modelPaths.length > 128 ||
    new Set(value.modelPaths).size !== value.modelPaths.length ||
    value.modelPaths.some(
      (path) =>
        typeof path !== 'string' ||
        !path.toLowerCase().startsWith(base) ||
        path.split('/').some((part) => !part || part === '.' || part === '..') ||
        !/^[a-z0-9_./-]+\.cas$/i.test(path)
    ) ||
    !Array.isArray(value.models) ||
    value.models.length > 500000
  )
    throw Error('Invalid campaign tree placement publication');
  const paths = new Set(value.modelPaths),
    counts = { sparse_tree: 0, dense_tree: 0, canopy: 0 };
  for (const row of value.models) {
    if (
      !paths.has(row.path) ||
      !Object.hasOwn(counts, row.role) ||
      !Number.isInteger(row.cellX) ||
      row.cellX < 0 ||
      row.cellX >= value.width ||
      !Number.isInteger(row.cellY) ||
      row.cellY < 0 ||
      row.cellY >= value.height ||
      ![row.x, row.y, row.z].every((v) => Number.isFinite(v) && Math.abs(v) < 10000) ||
      Math.abs(row.x - row.cellX) > 2 ||
      Math.abs(row.z - row.cellY) > 2 ||
      !Number.isInteger(row.swayGroup) ||
      row.swayGroup < 0 ||
      row.swayGroup >= 20
    )
      throw Error('Invalid campaign tree placement');
    counts[row.role]++;
  }
  if (
    counts.sparse_tree !== value.sparseCount ||
    counts.dense_tree !== value.denseCount ||
    counts.canopy !== value.canopyCount
  )
    throw Error('Campaign tree counts disagree');
  return value;
}

function texture(core, bytes) {
  loadSettlementInput(core, bytes, '_openrtw_load_dds_texture_legacy_flags');
  const metadata = settlementPublication(core, '_openrtw_dds_texture_json', 8192);
  if (
    !['DXT1', 'DXT3', 'DXT5'].includes(metadata.format) ||
    !uint(metadata.width) ||
    !metadata.width ||
    metadata.width > 2048 ||
    !uint(metadata.height) ||
    !metadata.height ||
    metadata.height > 2048 ||
    !Array.isArray(metadata.mips) ||
    !metadata.mips.length ||
    metadata.mips.length > 16
  )
    throw Error('Invalid campaign tree DDS metadata');
  let end = 128;
  metadata.mips.forEach((mip, i) => {
    if (
      mip.level !== i ||
      mip.range?.start !== end ||
      !uint(mip.range?.endExclusive) ||
      mip.range.endExclusive <= end ||
      mip.range.endExclusive > bytes.length
    )
      throw Error('Invalid campaign tree DDS extent');
    end = mip.range.endExclusive;
  });
  if (end !== bytes.length) throw Error('Campaign tree DDS trailing bytes');
  return { metadata, source: new Uint8Array(bytes) };
}
const hash = async (bytes) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (v) =>
    v.toString(16).padStart(2, '0')
  ).join('');

export async function loadCampaignTreeAssets(core, provider, { isOpen = () => true } = {}) {
  const open = () => {
    if (!isOpen()) throw new DOMException('Campaign tree loading closed', 'AbortError');
  };
  open();
  const scenes = {};
  for (const season of ['summer', 'winter']) {
    if (typeof core._openrtw_build_campaign_trees !== 'function')
      throw Error('Campaign tree placement API is unavailable');
    const count = core._openrtw_build_campaign_trees(season === 'winter' ? 1 : 0);
    if (!Number.isInteger(count) || count < 0)
      throw Error(
        typeof core._openrtw_error === 'function'
          ? core.UTF8ToString(core._openrtw_error())
          : 'Campaign tree placement build failed'
      );
    scenes[season] = validateCampaignTreeScene(
      settlementPublication(core, '_openrtw_campaign_trees_json'),
      season
    );
    if (count !== scenes[season].models.length)
      throw Error('Campaign tree build count disagrees with publication');
  }
  if (scenes.summer.width !== scenes.winter.width || scenes.summer.height !== scenes.winter.height)
    throw Error('Campaign tree seasons disagree on dimensions');
  const lightingBytes = await provider.read('settlementLighting');
  open();
  const lighting = settlementLighting(lightingBytes),
    models = new Map(),
    textures = new Map(),
    identities = [];
  let inputBytes = 0;
  const account = (bytes) => {
    inputBytes += bytes.length;
    if (inputBytes > 32 * 1024 * 1024) throw Error('Campaign tree input budget exceeded');
  };
  for (const path of new Set([...scenes.summer.modelPaths, ...scenes.winter.modelPaths])) {
    const source = await provider.readModel(path);
    open();
    account(source);
    if (source.length < 4) throw Error('Truncated campaign tree CAS');
    const version = new DataView(source.buffer, source.byteOffset, source.byteLength).getUint32(
      0,
      true
    );
    // Owned tree corpus: 3.12 uses the previously verified repeated static count
    // profile; 3.18 uses the general native chunk/material reader. No repair or
    // geometric normalization is attempted if either parser refuses.
    loadSettlementInput(
      core,
      source,
      version === 0x4047ae14
        ? '_openrtw_load_cas_mesh_repeated_static_count312'
        : '_openrtw_load_cas_mesh_any'
    );
    const parts = campaignTreeGeometry(settlementPublication(core, '_openrtw_cas_mesh_json'));
    models.set(path, parts);
    identities.push({ path, bytes: source.length, sha256: await hash(source) });
    open();
    for (const part of parts)
      if (!textures.has(part.texturePath)) {
        const bytes = await provider.readModel(part.texturePath, { kind: 'texture' });
        open();
        account(bytes);
        textures.set(part.texturePath, texture(core, bytes));
        identities.push({ path: part.texturePath, bytes: bytes.length, sha256: await hash(bytes) });
        open();
      }
  }
  return {
    width: scenes.summer.width,
    height: scenes.summer.height,
    scenes,
    models,
    textures,
    lighting,
    identities,
  };
}
