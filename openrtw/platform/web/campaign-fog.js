// Knowledge is supplied by the C++ fog table, indexed x + width*y with y north.
// 495F67 commits bytes 0=unexplored, 1=remembered, >=2=visible; values >=100
// are transient native reveal markers and must never reach a published view.
// This adapter owns its bytes and creates masks in an explicit caller palette.
// It makes no claim about the original renderer's RGB/alpha combination, blur,
// animation, terrain material, or remembered-structure model selection.
const uint = (value) => Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
const category = (value) => Math.min(value, 2);
const color = (value) =>
  Array.isArray(value) &&
  value.length === 4 &&
  value.every((channel) => Number.isInteger(channel) && channel >= 0 && channel <= 255);

export function createCampaignFog({ width, height }) {
  if (
    !Number.isInteger(width) ||
    width < 1 ||
    width > 255 ||
    !Number.isInteger(height) ||
    height < 1 ||
    height > 156
  )
    throw new TypeError('Invalid campaign fog dimensions');
  const size = width * height;
  let table = null,
    identity = null,
    tableIdentity = null,
    counts = null;
  let enabled = true,
    version = 0,
    maskRevision = 0,
    tableVersion = 0;
  const ready = () => {
    if (table === null) throw new Error('Campaign fog has not been adopted');
  };
  const inside = (x, y) =>
    Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < width && y < height;
  const stateAt = (x, y) => {
    ready();
    return inside(x, y) ? table[x + width * y] : 0;
  };
  const qualifies = (x, y, threshold) => {
    ready();
    return inside(x, y) && (!enabled || table[x + width * y] >= threshold);
  };
  function mask(palette, northUp) {
    ready();
    if (!palette || !['unseen', 'remembered', 'visible'].every((key) => color(palette[key])))
      throw new TypeError('Fog masks require an explicit RGBA palette');
    const colors = [palette.unseen, palette.remembered, palette.visible],
      rgba = new Uint8Array(size * 4);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const row = northUp ? height - 1 - y : y;
        rgba.set(colors[enabled ? category(table[x + width * y]) : 2], 4 * (x + width * row));
      }
    return {
      width,
      height,
      rgba,
      revision: maskRevision,
      orientation: northUp ? 'north-up' : 'world-y-up',
    };
  }
  return Object.freeze({
    width,
    height,
    get enabled() {
      return enabled;
    },
    get identity() {
      return identity;
    },
    get tableIdentity() {
      return tableIdentity;
    },
    get counts() {
      return counts;
    },
    get revision() {
      return identity?.revision ?? null;
    },
    get version() {
      return version;
    },
    get maskRevision() {
      return maskRevision;
    },
    adopt({ bytes, playerFaction, generation, revision, enabled: nextEnabled = true }) {
      if (
        !(bytes instanceof Uint8Array) ||
        bytes.length !== size ||
        typeof playerFaction !== 'string' ||
        !/^[A-Za-z_][A-Za-z0-9_]{0,255}$/.test(playerFaction) ||
        !uint(generation) ||
        !uint(revision) ||
        typeof nextEnabled !== 'boolean'
      )
        throw new TypeError('Invalid campaign fog publication');
      // Copy before inspection. A rejected publication never changes the last
      // adopted view, and later core slot reuse cannot change these queries.
      const next = new Uint8Array(bytes);
      let tableChanged = table === null,
        classChanged = table === null;
      let unexplored = 0,
        remembered = 0,
        visible = 0;
      for (let i = 0; i < size; i++) {
        if (next[i] >= 100) throw new RangeError('Transient or invalid campaign fog cell');
        if (next[i] === 0) unexplored++;
        else if (next[i] === 1) remembered++;
        else visible++;
        if (table !== null && next[i] !== table[i]) {
          tableChanged = true;
          if (category(next[i]) !== category(table[i])) classChanged = true;
        }
      }
      const identityChanged =
        identity === null ||
        identity.playerFaction !== playerFaction ||
        identity.generation !== generation ||
        identity.revision !== revision;
      const enabledChanged = enabled !== nextEnabled;
      const maskChanged = table === null || enabledChanged || (nextEnabled && classChanged);
      const viewChanged = identityChanged || enabledChanged || classChanged;
      const changed = tableChanged || identityChanged || enabledChanged;
      if (tableChanged) {
        table = next;
        tableIdentity = Object.freeze({ version: ++tableVersion });
        counts = Object.freeze({
          total: size,
          unexplored,
          remembered,
          visible,
          explored: remembered + visible,
        });
      }
      if (identityChanged) identity = Object.freeze({ playerFaction, generation, revision });
      enabled = nextEnabled;
      if (changed) version++;
      if (maskChanged) maskRevision++;
      return Object.freeze({ changed, tableChanged, viewChanged, maskChanged });
    },
    stateAt,
    // 9BE403 and B001BC gate live characters and labels at >=2. The >=1
    // predicate is knowledge only; the scene must decide live versus shroud
    // geometry separately. It is not proof that a current model belongs in fog.
    actorVisible: (x, y) => qualifies(x, y, 2),
    labelVisible: (x, y) => qualifies(x, y, 2),
    structureKnown: (x, y) => qualifies(x, y, 1),
    terrainExplored: (x, y) => qualifies(x, y, 1),
    buildWorldMask: (palette) => mask(palette, false),
    buildMinimapMask: (palette) => mask(palette, true),
    snapshot() {
      ready();
      return {
        schema: 'openrtw-campaign-fog-view-v1',
        width,
        height,
        ...identity,
        enabled,
        version,
        maskRevision,
        counts,
        bytes: table.slice(),
      };
    },
  });
}
