// CAS/DDS parsing remains in the core. Every publication is copied before the
// next await: subsequent asset loads replace the core's temporary parse slots.
const cap = 32 * 1024 * 1024;
const uint = (v) => Number.isInteger(v) && v >= 0 && v <= 0xffffffff;

const shadowSchema = 'openrtw-campaign-shadow-volume-v1';
const shadowCardinalYaws = Object.freeze([0, 16384, 32768, 49152]);
const shadowMaxVertices = 59999,
  shadowMaxIndices = 599997,
  shadowMaxCoordinate = 1e6,
  shadowMaxGeometryBytes = 32 * 1024 * 1024,
  shadowMaxPublicationBytes = 64 * 1024 * 1024,
  shadowMaxSkipped = 64;
const shadowModeByRole = Object.freeze({
  buildings: 1,
  wall: 1,
  fort: 1,
  fort_wall: 1,
  watchtower: 1,
  siege: 1,
  blockade: 1,
  land: 3,
  sea: 3,
});
// Core refusals that mean "this model has no supported static volume" rather
// than a corrupt publication. The API returns only 1/0 plus the error string,
// so this narrow allowlist is the contract boundary. Unknown refusals are
// genuine errors and must not be silently converted into missing shadows.
const optionalShadowRefusals = Object.freeze([
  'unsupported horizontal, upward or vertical light',
  'mesh budget exceeded',
  'source geometry budget exceeded',
  'volume geometry budget exceeded',
  'CAS mesh budget exceeded',
  'CAS geometry budget exceeded',
  'geometry work budget exceeded',
  'static one-root CAS required',
  'nonzero root bind translation',
  'unsupported CAS mesh or inconsistent geometry counts',
]);
const finiteVector = (v) =>
  Array.isArray(v) &&
  v.length === 3 &&
  v.every(
    (value) =>
      typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= shadowMaxCoordinate
  );

// Same mapping as campaign_shadows.cpp; unknown/banner roles cast no shadow.
export function campaignShadowModeForRole(role) {
  return typeof role === 'string' && Object.hasOwn(shadowModeByRole, role)
    ? shadowModeByRole[role]
    : 0;
}

// Reads one complete module-owned publication. The caller must only call this
// after a successful build: a refused build deliberately preserves the previous
// wire string, so reading it would attribute stale geometry to this geometry.
export function campaignShadowPublication(core, diffuseDirection, yaw) {
  if (!finiteVector(diffuseDirection)) throw new Error('Invalid campaign shadow direction');
  if (!shadowCardinalYaws.includes(yaw)) throw new Error('Unsupported campaign shadow yaw');
  if (
    typeof core._openrtw_build_campaign_shadow_volume !== 'function' ||
    typeof core._openrtw_campaign_shadow_json !== 'function'
  )
    throw new Error('Campaign shadow build API is unavailable');
  const pointer = core._malloc(12);
  if (!uint(pointer) || !pointer) throw new Error('Campaign shadow direction allocation failed');
  try {
    // malloc may grow the heap, so re-acquire it before writing the direction.
    const heap = core.HEAPU8;
    if (pointer > heap.length - 12) throw new Error('Invalid campaign shadow direction span');
    const view = new DataView(heap.buffer, heap.byteOffset + pointer, 12);
    diffuseDirection.forEach((value, i) => view.setFloat32(i * 4, value, true));
    const result = core._openrtw_build_campaign_shadow_volume(pointer, yaw);
    if (result !== 1) {
      if (result !== 0) throw new Error('Invalid campaign shadow build status');
      const reason = core.UTF8ToString(core._openrtw_error());
      if (optionalShadowRefusals.some((message) => reason.includes(message))) return null;
      throw new Error(`Campaign shadow build failed: ${reason || 'unknown error'}`);
    }
    return shadowVolume(
      settlementPublication(core, '_openrtw_campaign_shadow_json', shadowMaxPublicationBytes),
      yaw
    );
  } finally {
    // The core copied its wire before returning; free on success and refusal.
    core._free(pointer);
  }
}

function shadowVolume(value, yaw) {
  if (
    value?.schema !== shadowSchema ||
    value.yaw !== yaw ||
    !Array.isArray(value.positions) ||
    value.positions.length > shadowMaxVertices ||
    !Array.isArray(value.indices) ||
    value.indices.length > shadowMaxIndices ||
    value.indices.length % 3 ||
    ![value.extrusion, value.minimum, value.maximum].every(finiteVector)
  )
    throw new Error('Invalid campaign shadow publication');
  const minimum = [Infinity, Infinity, Infinity],
    maximum = [-Infinity, -Infinity, -Infinity];
  for (const point of value.positions) {
    if (!finiteVector(point)) throw new Error('Invalid campaign shadow vertex');
    for (let k = 0; k < 3; k++) {
      minimum[k] = Math.min(minimum[k], point[k]);
      maximum[k] = Math.max(maximum[k], point[k]);
    }
  }
  if (value.positions.length)
    for (let k = 0; k < 3; k++)
      if (value.minimum[k] !== minimum[k] || value.maximum[k] !== maximum[k])
        throw new Error('Invalid campaign shadow bounds');
  for (const index of value.indices)
    if (!Number.isInteger(index) || index < 0 || index >= value.positions.length)
      throw new Error('Invalid campaign shadow index');
  return value;
}
export function settlementPublication(core, name, limit = cap) {
  const pointer = core[name](),
    heap = core.HEAPU8;
  if (!uint(pointer) || !pointer || pointer >= heap.length)
    throw new Error('Settlement publication is unavailable');
  const end = heap.subarray(pointer, Math.min(heap.length, pointer + limit + 1)).indexOf(0);
  if (end < 0 || end > limit) throw new Error('Settlement publication exceeds its bound');
  return JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(heap.slice(pointer, pointer + end))
  );
}
export function loadSettlementInput(core, bytes, name) {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > cap)
    throw new Error('Invalid settlement input');
  const pointer = core._malloc(bytes.length);
  if (!uint(pointer) || !pointer) throw new Error('Settlement input allocation failed');
  try {
    if (pointer > core.HEAPU8.length - bytes.length)
      throw new Error('Invalid settlement input span');
    core.HEAPU8.set(bytes, pointer);
    if (core[name](pointer, bytes.length) !== 1)
      throw new Error(core.UTF8ToString(core._openrtw_error()));
  } finally {
    core._free(pointer);
  }
}

const floatBuffer = new ArrayBuffer(4),
  floatView = new DataView(floatBuffer);
function f32(bits) {
  if (!uint(bits)) throw new Error('Invalid CAS float bits');
  floatView.setUint32(0, bits, true);
  const value = floatView.getFloat32(0, true);
  if (!Number.isFinite(value)) throw new Error('Invalid CAS float');
  return value;
}
function numbers(value, count, name) {
  if (!Array.isArray(value) || value.length !== count || value.some((v) => !Number.isFinite(v)))
    throw new Error(`Invalid CAS ${name}`);
  return value;
}
export function settlementGeometry(value) {
  if (!Array.isArray(value?.meshes) || value.meshes.length > 256 || !Array.isArray(value.materials))
    throw new Error('Invalid settlement CAS publication');
  const parts = [],
    positions = [],
    normals = [],
    uvs = [],
    indices = [];
  for (const mesh of value.meshes) {
    // 93522D/E3D612 consumes symbol as an anchor. _fade is an ordinary mesh.
    if (mesh.isSymbol || mesh.name === 'symbol') continue;
    const n = mesh.vertices,
      triangles = mesh.triangles,
      base = positions.length / 3;
    if (!uint(n) || !uint(triangles) || base + n > 65535 || indices.length + triangles * 3 > 3e6)
      throw new Error('Settlement geometry exceeds its bounds');
    const material = value.materials[mesh.materialIndex ?? mesh.textureIndex];
    if (!material || typeof material.name !== 'string') throw new Error('Missing CAS material');
    positions.push(...numbers(mesh.candidateBindPositions, n * 3, 'positions'));
    normals.push(...numbers(mesh.candidateBindNormals, n * 3, 'normals'));
    uvs.push(...numbers(mesh.uvBits, n * 2, 'UVs').map(f32));
    const sourceIndices = numbers(mesh.indices, triangles * 3, 'indices');
    if (sourceIndices.some((i) => !uint(i) || i >= n)) throw new Error('Invalid CAS triangle');
    parts.push({ name: mesh.name, firstIndex: indices.length, triangles, material });
    for (const i of sourceIndices) indices.push(base + i);
  }
  if (!indices.length) throw new Error('Settlement model contains no drawable meshes');
  const indexBytes = new Uint8Array(indices.length * 2),
    view = new DataView(indexBytes.buffer);
  indices.forEach((index, i) => view.setUint16(i * 2, index, true));
  return { positions, normals, uvs, indexBytes, parts };
}

// FA7A00 tries CAS-directory/material-name first; ADE638/934A60 uses
// CAS-directory/textures/basename only when that failed. Owned files carry DDS
// companions; support for other native texture carriers is still absent.
export function settlementTexturePaths(modelPath, name) {
  if (typeof name !== 'string' || name.length > 1024) throw new Error('Invalid CAS material path');
  const material = name.replace(/\\/g, '/');
  if (material.startsWith('/') || material.split('/').some((p) => !p || p === '.' || p === '..'))
    throw new Error('Invalid CAS material path');
  const directory = modelPath.slice(0, modelPath.lastIndexOf('/') + 1),
    base = material.split('/').at(-1);
  return [
    ...new Set(
      [directory + material, directory + 'textures/' + base].map((path) =>
        (path.toLowerCase().endsWith('.dds') ? path : path + '.dds').toLowerCase()
      )
    ),
  ];
}

export function settlementLighting(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/;[^\n]*/g, '');
  const values = {};
  for (const key of [
    'ambient_colour',
    'diffuse_colour',
    'piece_ambient_colour',
    'piece_diffuse_colour',
    'diffuse_direction',
  ]) {
    const match = text.match(new RegExp('^\\s*' + key + '\\s+([^\\r\\n]+)', 'm'));
    const row = match?.[1].trim().split(/\s+/).map(Number);
    if (!row || row.length !== 3 || row.some((v) => !Number.isFinite(v) || Math.abs(v) > 16))
      throw new Error(`Invalid strategy lighting ${key}`);
    values[key] = row;
  }
  const length = Math.hypot(...values.diffuse_direction);
  if (!length) throw new Error('Degenerate strategy light direction');
  values.toLight = values.diffuse_direction.map((v) => -v / length);
  return values;
}

function ddsPublication(core, source) {
  // Legacy DDS flag omissions occur in owned strat textures and are bounded by
  // the core's dedicated profile; this does not implement a second DDS reader.
  loadSettlementInput(core, source, '_openrtw_load_dds_texture_legacy_flags');
  const metadata = settlementPublication(core, '_openrtw_dds_texture_json', 8192);
  if (
    !['DXT1', 'DXT3', 'DXT5'].includes(metadata.format) ||
    !uint(metadata.width) ||
    !metadata.width ||
    metadata.width > 4096 ||
    !uint(metadata.height) ||
    !metadata.height ||
    metadata.height > 4096 ||
    !Array.isArray(metadata.mips) ||
    !metadata.mips.length ||
    metadata.mips.length > 16
  )
    throw new Error('Invalid settlement DDS metadata');
  let previous = 128;
  for (const [i, mip] of metadata.mips.entries()) {
    if (
      mip.level !== i ||
      !uint(mip.range?.start) ||
      !uint(mip.range?.endExclusive) ||
      mip.range.start < previous ||
      mip.range.endExclusive <= mip.range.start ||
      mip.range.endExclusive > source.length
    )
      throw new Error('Invalid settlement DDS mip span');
    previous = mip.range.endExclusive;
  }
  return { metadata, source: source.slice() };
}

function shadowRequirements(placement) {
  const modes = new Map();
  for (const row of placement.models) {
    const mode = campaignShadowModeForRole(row?.role);
    if (!mode || typeof row.path !== 'string' || !row.path) continue;
    modes.set(row.path, modes.get(row.path) === 3 || mode === 3 ? 3 : 1);
  }
  return modes;
}

function settlementPlacement(placement) {
  if (
    placement?.schema !== 'openrtw-settlement-models-v1' ||
    !Array.isArray(placement.models) ||
    placement.models.length > 8192 ||
    !Array.isArray(placement.modelPaths) ||
    placement.modelPaths.length > 512
  )
    throw new Error('Invalid settlement placement list');
  return placement;
}

export async function loadSettlementModelAssets(
  core,
  provider,
  { isOpen = () => true, collectShadows = false } = {}
) {
  const open = () => {
    if (!isOpen()) throw new DOMException('Settlement loading cancelled', 'AbortError');
  };
  open();
  if (
    typeof provider.readModel !== 'function' ||
    typeof core._openrtw_build_settlement_models !== 'function'
  )
    throw new Error('Settlement model API is unavailable');
  for (const [asset, entry] of [
    ['aerialCultures', '_openrtw_load_culture_models'],
    ['aerialFactionCultures', '_openrtw_load_faction_cultures'],
    ['settlementBuildings', '_openrtw_load_settlement_buildings'],
  ]) {
    // Reloading faction cultures invalidates the core's decal epoch. Reuse the
    // descriptor already admitted by loadAerialTerrain so flattening and
    // composed underlays survive the later model inventory pass.
    if (
      entry === '_openrtw_load_faction_cultures' &&
      typeof core._openrtw_aerial_bases_json === 'function' &&
      core._openrtw_aerial_bases_json() &&
      Array.isArray(settlementPublication(core, '_openrtw_aerial_bases_json').factionCultures)
    )
      continue;
    const bytes = await provider.read(asset);
    open();
    loadSettlementInput(core, bytes, entry);
  }
  const lightBytes = await provider.read('settlementLighting');
  open();
  const lighting = settlementLighting(lightBytes);
  const symbolPathPointer = core._openrtw_settlement_symbol_path();
  if (!symbolPathPointer) throw new Error('Settlement symbol path is unavailable');
  const symbolPath = core.UTF8ToString(symbolPathPointer);
  const symbolBytes = await provider.readModel(symbolPath);
  open();
  loadSettlementInput(core, symbolBytes, '_openrtw_load_cas_mesh_any');
  const symbol = settlementPublication(core, '_openrtw_cas_mesh_json');
  if (
    !Array.isArray(symbol.symbolAnchor) ||
    !Number.isFinite(symbol.symbolAnchor[1]) ||
    core._openrtw_set_settlement_symbol_anchor(symbol.symbolAnchor[1]) !== 1
  )
    throw new Error('Settlement symbol anchor is unavailable');
  if (core._openrtw_build_settlement_models() <= 0)
    throw new Error(core.UTF8ToString(core._openrtw_error()));
  const placement = settlementPlacement(
    settlementPublication(core, '_openrtw_settlement_models_json')
  );
  const models = new Map(),
    textures = new Map(),
    shadowVolumes = new Map(),
    shadowStatus = {
      requested: collectShadows === true,
      state: collectShadows === true ? 'collected' : 'not-requested',
      models: 0,
      variants: 0,
      geometryBytes: 0,
      skippedCount: 0,
      skipped: [],
    },
    shadowModes = new Map();
  // An immutable core may predate the shadow exports. That is a missing optional
  // capability, not a settlement asset failure: record it and keep rendering.
  if (collectShadows === true) {
    if (
      typeof core._openrtw_build_campaign_shadow_volume !== 'function' ||
      typeof core._openrtw_campaign_shadow_json !== 'function'
    ) {
      shadowStatus.state = 'unavailable';
      shadowStatus.reason = 'campaign shadow build API is unavailable';
    } else for (const [path, mode] of shadowRequirements(placement)) shadowModes.set(path, mode);
  }
  // OpenRTW browser admission budgets, not native limits. A malformed inventory
  // must not retain hundreds of individually bounded files until tab exhaustion.
  let sourceBytes = symbolBytes.length,
    vertices = 0;
  const account = (bytes) => {
    sourceBytes += bytes.length;
    if (sourceBytes > 64 * 1024 * 1024)
      throw new Error('Settlement assets exceed their total input bound');
  };
  for (const path of placement.modelPaths) {
    const source = await provider.readModel(path);
    open();
    account(source);
    loadSettlementInput(core, source, '_openrtw_load_cas_mesh_any');
    const model = settlementGeometry(settlementPublication(core, '_openrtw_cas_mesh_json'));
    vertices += model.positions.length / 3;
    if (vertices > 1024 * 1024)
      throw new Error('Settlement geometry exceeds its total vertex bound');
    const shadowMode = shadowModes.get(path);
    if (shadowMode) {
      const yaws = shadowMode === 3 ? shadowCardinalYaws : [0],
        variants = [];
      let refused = null;
      for (const yaw of yaws) {
        open();
        const publication = campaignShadowPublication(core, lighting.diffuse_direction, yaw);
        if (publication === null) {
          // The core preserves its previous wire string on refusal. Do not read
          // it; drop the whole path instead of misattributing retained geometry.
          refused = core.UTF8ToString(core._openrtw_error()) || 'unsupported static model';
          break;
        }
        variants.push(publication);
      }
      open();
      if (refused !== null) {
        shadowStatus.skippedCount++;
        if (shadowStatus.skipped.length < shadowMaxSkipped)
          shadowStatus.skipped.push(`${path}: ${refused}`.slice(0, 256));
      } else {
        const bytes = variants.reduce(
          (sum, value) => sum + value.positions.length * 16 + value.indices.length * 2,
          0
        );
        if (shadowStatus.geometryBytes + bytes > shadowMaxGeometryBytes)
          throw new Error('Settlement shadow geometry exceeds its total bound');
        shadowVolumes.set(path, variants);
        shadowStatus.models++;
        shadowStatus.variants += variants.length;
        shadowStatus.geometryBytes += bytes;
      }
    }
    for (const part of model.parts) {
      let lastError;
      for (const texturePath of settlementTexturePaths(path, part.material.name)) {
        try {
          if (!textures.has(texturePath)) {
            const bytes = await provider.readModel(texturePath, { kind: 'texture' });
            open();
            account(bytes);
            textures.set(texturePath, ddsPublication(core, bytes));
          }
          part.texturePath = texturePath;
          break;
        } catch (error) {
          open();
          lastError = error;
        }
      }
      if (!part.texturePath) throw lastError;
    }
    models.set(path, model);
  }
  return {
    placement,
    // Canonical comparison key for the bounded live-refresh path. Rebuilding
    // only queued work produces the same completed placement bytes, so the
    // caller can keep its current GPU owners instead of replacing geometry.
    placementWire: JSON.stringify(placement),
    models,
    textures,
    lighting,
    shadowVolumes,
    shadowStatus,
  };
}

// Bounded live refresh of a completed-production placement. This deliberately
// reloads no culture/faction/building descriptor and no settlement symbol CAS:
// every input it reads was already admitted by loadSettlementModelAssets and
// reloading faction cultures invalidates a live production session's decal
// epoch. isCurrent is a session/lifecycle lease; it is checked after every
// await and immediately before every core CAS/DDS/shadow operation, so a late
// read can never publish geometry or issue campaign core work.
export async function refreshSettlementModelAssets(
  core,
  provider,
  prior,
  { isCurrent = () => true, collectShadows = false } = {}
) {
  if (
    !prior ||
    !(prior.models instanceof Map) ||
    !(prior.textures instanceof Map) ||
    !prior.lighting ||
    typeof provider?.readModel !== 'function'
  )
    throw new Error('Settlement refresh inputs are unavailable');
  const guard = () => {
    if (isCurrent() !== true)
      throw new DOMException('Settlement refresh cancelled', 'AbortError');
  };
  guard();
  if (core._openrtw_build_settlement_models() <= 0)
    throw new Error(core.UTF8ToString(core._openrtw_error()));
  guard();
  // Copy the complete publication before another await can replace the core slot.
  const placement = settlementPlacement(
    settlementPublication(core, '_openrtw_settlement_models_json')
  );
  const placementWire = JSON.stringify(placement);
  const priorWire = prior.placementWire ?? JSON.stringify(prior.placement);
  if (
    priorWire === placementWire &&
    prior.shadowStatus?.requested === (collectShadows === true)
  )
    return {
      placement,
      placementWire,
      models: prior.models,
      textures: prior.textures,
      lighting: prior.lighting,
      shadowVolumes: prior.shadowVolumes,
      shadowStatus: prior.shadowStatus,
      changed: false,
    };

  const models = new Map(),
    textures = new Map(),
    shadowVolumes = new Map(),
    shadowStatus = {
      requested: collectShadows === true,
      state: collectShadows === true ? 'collected' : 'not-requested',
      models: 0,
      variants: 0,
      geometryBytes: 0,
      skippedCount: 0,
      skipped: [],
    },
    shadowModes = new Map();
  let shadowSupported = false;
  if (collectShadows === true) {
    if (
      typeof core._openrtw_build_campaign_shadow_volume !== 'function' ||
      typeof core._openrtw_campaign_shadow_json !== 'function'
    ) {
      shadowStatus.state = 'unavailable';
      shadowStatus.reason = 'campaign shadow build API is unavailable';
    } else {
      shadowSupported = true;
      for (const [path, mode] of shadowRequirements(placement)) shadowModes.set(path, mode);
    }
  }
  let sourceBytes = 0,
    vertices = 0;
  const account = (bytes) => {
    sourceBytes += bytes.length;
    if (sourceBytes > 64 * 1024 * 1024)
      throw new Error('Settlement assets exceed their total input bound');
  };
  for (const path of new Set(placement.modelPaths)) {
    const admittedModel = prior.models.get(path);
    let model = admittedModel,
      casLive = false;
    if (!model) {
      if (typeof path !== 'string' || !path) throw new Error('Invalid settlement model path');
      const source = await provider.readModel(path);
      guard();
      account(source);
      loadSettlementInput(core, source, '_openrtw_load_cas_mesh_any');
      guard();
      model = settlementGeometry(settlementPublication(core, '_openrtw_cas_mesh_json'));
      casLive = true;
    }
    vertices += model.positions.length / 3;
    if (vertices > 1024 * 1024)
      throw new Error('Settlement geometry exceeds its total vertex bound');
    const shadowMode = shadowModes.get(path);
    if (shadowMode) {
      const yaws = shadowMode === 3 ? shadowCardinalYaws : [0],
        reusable = prior.shadowVolumes?.get(path);
      let variants = reusable?.length === yaws.length ? reusable : null;
      if (variants === null) {
        if (!casLive) {
          const source = await provider.readModel(path);
          guard();
          account(source);
          loadSettlementInput(core, source, '_openrtw_load_cas_mesh_any');
          guard();
          casLive = true;
        }
        variants = [];
        let refused = null;
        for (const yaw of yaws) {
          guard();
          const publication = campaignShadowPublication(core, prior.lighting.diffuse_direction, yaw);
          if (publication === null) {
            refused = core.UTF8ToString(core._openrtw_error()) || 'unsupported static model';
            break;
          }
          variants.push(publication);
        }
        guard();
        if (refused !== null) {
          shadowStatus.skippedCount++;
          if (shadowStatus.skipped.length < shadowMaxSkipped)
            shadowStatus.skipped.push(`${path}: ${refused}`.slice(0, 256));
          variants = null;
        }
      }
      if (variants !== null) {
        const bytes = variants.reduce(
          (sum, value) => sum + value.positions.length * 16 + value.indices.length * 2,
          0
        );
        if (shadowStatus.geometryBytes + bytes > shadowMaxGeometryBytes)
          throw new Error('Settlement shadow geometry exceeds its total bound');
        shadowVolumes.set(path, variants);
        shadowStatus.models++;
        shadowStatus.variants += variants.length;
        shadowStatus.geometryBytes += bytes;
      }
    }
    for (let partIndex = 0; partIndex < model.parts.length; partIndex++) {
      let part = model.parts[partIndex];
      if (typeof part.texturePath === 'string' && textures.has(part.texturePath)) continue;
      let lastError;
      for (const texturePath of settlementTexturePaths(path, part.material.name)) {
        try {
          if (!textures.has(texturePath)) {
            const admitted = prior.textures.get(texturePath);
            if (admitted) textures.set(texturePath, admitted);
            else {
              const bytes = await provider.readModel(texturePath, { kind: 'texture' });
              guard();
              account(bytes);
              textures.set(texturePath, ddsPublication(core, bytes));
            }
          }
          if (part.texturePath !== texturePath) {
            // Geometry stays shared. Changed material bindings belong to this
            // candidate, including when later admission fails or is cancelled.
            if (model === admittedModel) {
              model = { ...model, parts: model.parts.map((value) => ({ ...value })) };
              part = model.parts[partIndex];
            }
            part.texturePath = texturePath;
          }
          break;
        } catch (error) {
          guard();
          lastError = error;
        }
      }
      if (!part.texturePath || !textures.has(part.texturePath))
        throw lastError ?? new Error('Settlement material texture is unavailable');
    }
    models.set(path, model);
  }
  if (collectShadows === true && shadowSupported !== true) {
    shadowVolumes.clear();
    shadowStatus.models = shadowStatus.variants = shadowStatus.geometryBytes = 0;
    shadowStatus.skippedCount = 0;
    shadowStatus.skipped = [];
  }
  return {
    placement,
    placementWire,
    models,
    textures,
    lighting: prior.lighting,
    shadowVolumes,
    shadowStatus,
    changed: true,
  };
}
