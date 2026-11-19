// Literal shipped aerial material declarations only. The source does not name
// texture columns as seasons, map numeric categories to these roles, or define
// UVs/blend weights. No renderer selection or implicit default fallback occurs.
export const terrainMaterialSourceSpec = Object.freeze({
  path: 'data/descr_aerial_map_ground_types.txt',
  bytes: 5221,
  sha256: '85584eb063c2cd260e9ba40b2694359c133e92abe24549e88747f06b7dece98f',
});
export const terrainMaterialSourceLimits = Object.freeze({
  textBytes: 65536,
  climates: 32,
  rowsPerClimate: 64,
  nameBytes: 64,
  textureNameBytes: 128,
});
const models = new WeakSet(),
  name = (value) => typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value);
const refuse = (message) => {
  throw new TypeError('Terrain material source: ' + message);
};
const checkOpen = (isOpen) => {
  if (!isOpen()) throw new DOMException('Terrain material source loading cancelled', 'AbortError');
};
const digest = async (bytes) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (value) =>
    value.toString(16).padStart(2, '0')
  ).join('');

// Strict line-oriented subset actually present in the pinned descriptor.
// Preserve ordered unnamed texture slots and one-based original line numbers.
export function parseTerrainMaterialSource(text) {
  if (
    typeof text !== 'string' ||
    !text.length ||
    text.length > terrainMaterialSourceLimits.textBytes ||
    /[^\x09\x0a\x0d\x20-\x7e]/.test(text)
  )
    refuse('invalid bounded ASCII text');
  const climates = [],
    seen = new Set();
  let pending = null,
    current = null;
  for (const [index, raw] of text.split('\n').entries()) {
    const line = raw.split(';', 1)[0].trim();
    if (!line) continue;
    const tokens = line.split(/\s+/),
      sourceLine = index + 1;
    if (pending) {
      if (line !== '{') refuse('expected climate opening brace');
      current = { name: pending.name, sourceLine: pending.sourceLine, rows: [] };
      pending = null;
      continue;
    }
    if (current) {
      if (line === '}') {
        if (!current.rows.length) refuse('empty climate block');
        climates.push(
          Object.freeze({ ...current, endLine: sourceLine, rows: Object.freeze(current.rows) })
        );
        current = null;
        continue;
      }
      if (
        tokens.length < 2 ||
        tokens.length > 3 ||
        !name(tokens[0]) ||
        tokens
          .slice(1)
          .some(
            (value) =>
              value.length > terrainMaterialSourceLimits.textureNameBytes ||
              !/^[A-Za-z0-9_]+\.tga$/.test(value)
          )
      )
        refuse('invalid ground texture row');
      if (
        current.rows.length >= terrainMaterialSourceLimits.rowsPerClimate ||
        current.rows.some((row) => row.groundType === tokens[0])
      )
        refuse('duplicate or excessive ground rows');
      current.rows.push(
        Object.freeze({
          groundType: tokens[0],
          textureSlots: Object.freeze(tokens.slice(1)),
          sourceLine,
        })
      );
      continue;
    }
    if (tokens.length !== 2 || tokens[0] !== 'climate' || !name(tokens[1]))
      refuse('expected climate declaration');
    if (climates.length >= terrainMaterialSourceLimits.climates || seen.has(tokens[1]))
      refuse('duplicate or excessive climates');
    seen.add(tokens[1]);
    pending = { name: tokens[1], sourceLine };
  }
  if (pending || current || !climates.length) refuse('incomplete or empty descriptor');
  const model = Object.freeze({
    schema: 'openrtw-terrain-material-source-v1',
    textBytes: text.length,
    climates: Object.freeze(climates),
  });
  models.add(model);
  return model;
}

// Return literal facts. A default row is reported separately when present;
// choosing it for an undeclared climate/role is still the caller's policy.
export function findTerrainMaterialSource(model, { climateName, groundType } = {}) {
  if (!models.has(model) || !name(climateName) || !name(groundType))
    refuse('invalid literal lookup');
  const climate = model.climates.find((value) => value.name === climateName),
    declaration = climate?.rows.find((value) => value.groundType === groundType) ?? null;
  const defaultDeclaration =
    model.climates
      .find((value) => value.name === 'default')
      ?.rows.find((value) => value.groundType === groundType) ?? null;
  return Object.freeze({
    status: declaration
      ? 'declared'
      : climate
        ? 'ground_type_not_declared'
        : 'climate_not_declared',
    climateName,
    groundType,
    declaration,
    defaultDeclaration,
    nativeSelectionEquivalent: false,
  });
}

// Exact source admission owns the input before the asynchronous digest.
// Returned data is independent of caller mutation; no asset payload is fetched.
export async function loadTerrainMaterialSource(input, { isOpen = () => true } = {}) {
  if (typeof isOpen !== 'function') refuse('isOpen must be a function');
  checkOpen(isOpen);
  if (
    !(input instanceof Uint8Array) ||
    !(input.buffer instanceof ArrayBuffer) ||
    input.length !== terrainMaterialSourceSpec.bytes
  )
    refuse('unexpected source extent');
  const source = input.slice();
  if ((await digest(source)) !== terrainMaterialSourceSpec.sha256)
    refuse('source identity differs');
  checkOpen(isOpen);
  const declarations = parseTerrainMaterialSource(
    new TextDecoder('utf-8', { fatal: true }).decode(source)
  );
  checkOpen(isOpen);
  return Object.freeze({ source: terrainMaterialSourceSpec, declarations });
}
