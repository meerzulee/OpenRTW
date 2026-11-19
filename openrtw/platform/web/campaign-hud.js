import { describeFailure } from '/runtime/failure.js';
import { parseHudSprites } from '/hud-sprites.js';
import { decodeTgaTexture } from '/texture-image.js';
import { decodeUnitCardTga } from '/unit-card-image.js';
import { createCampaignCursor } from '/campaign-cursor.js';
import { createCampaignBuildingView } from '/campaign-building-view.js';
import {
  parseCufFont,
  parseFontDatabase,
  rasterizeCufText,
  measureCufText,
  createCufTextPresenter,
} from '/cuf-font.js';

// Calibration to measured art landmarks in the retained native1280x1024 PNG.
// This does not establish native UI vertices, control placement or a general
// resolution policy. Other sizes retain the responsive uniform composition.
export const originalCampaignHudReference = Object.freeze({
  id: 'openrtw-captured-hud-landmarks-v1',
  width: 1280,
  height: 1024,
  scaleX: 1.25,
  scaleY: 4 / 3,
  sourcePngSha256: '7af2fef5e1ffa5f70d3948f7a4f67742c4d42acb850866be1f1a95664c8b5d41',
  nativeLayoutProved: false,
});

// C91F37 places a 1024x181 artwork group, with 281px side panels and a
// 147px-high middle. The retained 1280x1024 capture supplies its X/Y mapping.
// Smaller viewports compress X while retaining readable control/card text;
// that responsive rule is a web policy, not a recovered native resolution rule.
export function campaignHudGeometry(width) {
  if (!Number.isFinite(width) || width < 1 || width > 16384)
    throw TypeError('Invalid HUD viewport width');
  const scaleX = Math.min(1.25, width / 1024), scaleY = 4 / 3;
  return {
    scaleX, scaleY,
    sideWidth: 281 * scaleX,
    height: 181 * scaleY,
    middleHeight: 147 * scaleY,
    middleWidth: width - 562 * scaleX,
  };
}

export function campaignHudMinimapPick({ px, py, view, frame, worldWidth, worldHeight }) {
  if (!Number.isFinite(px) || !Number.isFinite(py) || !view || !frame ||
      !(view.width > 0) || !(view.height > 0) ||
      px < view.x || py < view.y || px >= view.x + view.width || py >= view.y + view.height)
    return null;
  return {
    x: Math.max(0, Math.min(worldWidth - 1,
      Math.floor(frame.x + ((px - view.x) / view.width) * frame.width))),
    y: Math.max(0, Math.min(worldHeight - 1,
      Math.floor(frame.y + (1 - (py - view.y) / view.height) * frame.height))),
  };
}

const unitCardBindings = Object.freeze([
  {
    dictionary: 'roman_generals_guard_cavalry_early',
    asset: 'unitCardJuliiGeneral',
    bytes: 6881,
    sha256: 'f52c6a3c5914983c01aab34fef32a048a733189b27dfa07d1293a565cd688232',
  },
  {
    dictionary: 'roman_hastati',
    asset: 'unitCardJuliiHastati',
    bytes: 7253,
    sha256: 'a911e7538af6a6c537718329a0f1a54251e67bf05447055639842504f8b3bcc4',
  },
  {
    dictionary: 'roman_triarii',
    asset: 'unitCardJuliiTriarii',
    bytes: 8028,
    sha256: '158895488ef6eee6d4fbf285f42abb36eaac95476dfe766ad00d41cabd59ea5d',
  },
  {
    dictionary: 'roman_archer',
    asset: 'unitCardJuliiArcher',
    bytes: 6752,
    sha256: '7daaf1c23573d7e3a72e1796f3e029a0b572d4e12df4daee5610ed2721f14e66',
  },
]);

// Campaign count is optional. EDU sourceSoldierCount is an unscaled definition,
// not the current army strength; retain it in the tooltip without a false badge.
export function campaignHudUnitCount(row) {
  const valid = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 0x7fffffff;
  const explicit = row.count !== undefined && row.count !== null;
  const base = row.unitDefinition?.sourceSoldierCount;
  if ((explicit && !valid(row.count)) || (base !== undefined && base !== null && !valid(base)))
    throw TypeError('Invalid HUD soldier count');
  return explicit
    ? {
        badge: String(row.count),
        description: `${row.count} soldiers`,
        detail: 'Count declared in the campaign source',
      }
    : {
        badge: '',
        description: 'Soldier count unavailable',
        detail:
          base !== undefined && base !== null
            ? `Unit definition lists ${base} soldiers before battle-size scaling; current army strength is not available`
            : 'No count declared in the campaign or matched unit definition',
      };
}

const humanizeHud = (value) =>
  value
    .replace(/_/g, ' ')
    .replace(/^roman\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase());

// Readable web labels for the admitted card identities; source identifiers and
// count qualifications remain in the card tooltip.
export function campaignHudUnitLabel(row) {
  switch (row.unitDefinition?.dictionary) {
    case 'roman_generals_guard_cavalry_early':
      return "General's Bodyguard";
    case 'roman_archer':
      return 'Archers';
    default:
      return humanizeHud(row.name);
  }
}

// Building bodies are retained as opaque campaign records. Only a single,
// complete type row becomes an inspection label; no simulation is inferred.
export function campaignHudBuildingLabel(building) {
  const types = (building?.source ?? [])
    .map((row) => row.text.split(';', 1)[0].trim())
    .filter((text) => /^type\b/.test(text));
  const match = types.length === 1 && /^type\s+([\w+-]+)\s+([\w+-]+)$/.exec(types[0]);
  return match
    ? { name: humanizeHud(match[2]), group: humanizeHud(match[1]) }
    : { name: 'Building', group: 'Details unavailable' };
}

// OpenRTW framing, not recovered native radar behavior. The overview follows
// explored terrain; a visible selection uses a bounded regional crop. Hidden
// selections never influence the crop, and every frame uses the same fog mask.
export function campaignHudMinimapFrame({
  worldWidth,
  worldHeight,
  fog = null,
  mode = 'world',
  aspect = 2,
  focus = null,
}) {
  if (
    !Number.isInteger(worldWidth) ||
    worldWidth < 1 ||
    worldWidth > 4096 ||
    !Number.isInteger(worldHeight) ||
    worldHeight < 1 ||
    worldHeight > 4096 ||
    !Number.isFinite(aspect) ||
    aspect <= 0 ||
    !['local', 'world'].includes(mode) ||
    (focus !== null &&
      (!Number.isInteger(focus.x) ||
        focus.x < 0 ||
        focus.x >= worldWidth ||
        !Number.isInteger(focus.y) ||
        focus.y < 0 ||
        focus.y >= worldHeight))
  )
    throw TypeError('Invalid HUD minimap framing');
  const full = { x: 0, y: 0, width: worldWidth, height: worldHeight, mode: 'world' };
  if (mode === 'world') return full;
  if (
    focus !== null &&
    (fog === null ||
      (typeof fog.actorVisible === 'function' && fog.actorVisible(focus.x, focus.y) === true))
  ) {
    // Forty-eight north/south cells keep an Italian army or town legible without
    // expanding to distant discoveries. Clamp at map edges without changing zoom.
    const height = Math.min(48, worldHeight, worldWidth / aspect),
      width = height * aspect;
    return {
      x: Math.max(0, Math.min(worldWidth - width, focus.x + 0.5 - width / 2)),
      y: Math.max(0, Math.min(worldHeight - height, focus.y + 0.5 - height / 2)),
      width,
      height,
      mode: 'local',
      scope: 'selection',
    };
  }
  if (!fog?.enabled || typeof fog.terrainExplored !== 'function') return full;
  let left = worldWidth,
    right = -1,
    bottom = worldHeight,
    top = -1;
  for (let y = 0; y < worldHeight; y++)
    for (let x = 0; x < worldWidth; x++)
      if (fog.terrainExplored(x, y)) {
        left = Math.min(left, x);
        right = Math.max(right, x + 1);
        bottom = Math.min(bottom, y);
        top = Math.max(top, y + 1);
      }
  if (right < 0) return full;
  const cx = (left + right) / 2,
    cy = (bottom + top) / 2;
  let width = Math.max(32, right - left + 10),
    height = Math.max(24, top - bottom + 10);
  if (width / height < aspect) width = height * aspect;
  else height = width / aspect;
  width = Math.min(width, worldWidth);
  height = Math.min(height, worldHeight);
  return {
    x: Math.max(0, Math.min(worldWidth - width, cx - width / 2)),
    y: Math.max(0, Math.min(worldHeight - height, cy - height / 2)),
    width,
    height,
    mode: 'local',
  };
}

// Shared HUD projection: drawing, dropdowns, callbacks and selected army details
// must use the same visibility result. Raw simulation IDs remain with the core.
export function campaignHudVisibility({
  characters,
  selectedId = null,
  army = null,
  fog = null,
  worldWidth,
  worldHeight,
}) {
  if (
    fog !== null &&
    (fog.width !== worldWidth ||
      fog.height !== worldHeight ||
      typeof fog.actorVisible !== 'function' ||
      typeof fog.buildMinimapMask !== 'function' ||
      !Number.isSafeInteger(fog.maskRevision) ||
      fog.maskRevision < 0 ||
      typeof fog.enabled !== 'boolean')
  )
    throw TypeError('Invalid HUD fog view');
  if (selectedId !== null && !characters.some((c) => c.id === selectedId))
    throw TypeError('Invalid HUD selected ID');
  if (army && (selectedId === null || army.actorId !== selectedId))
    throw TypeError('HUD army actor binding refused');
  const visible =
    fog === null
      ? characters
      : characters.filter((c) => {
          const shown = fog.actorVisible(c.x, c.y);
          if (typeof shown !== 'boolean') throw TypeError('Invalid HUD actor visibility');
          return shown;
        });
  const hiddenSelection = selectedId !== null && !visible.some((c) => c.id === selectedId);
  return {
    characters: visible,
    selectedId: hiddenSelection ? null : selectedId,
    army: hiddenSelection ? null : army,
    hiddenSelection,
  };
}

// Full base geography is public cartography in this web presentation. Sight
// subdues unknown/remembered terrain but still gates every live object marker.
// The main 3D shroud is independent and is not changed by this HUD policy.
const minimapFogPalette = Object.freeze({
  unseen: Object.freeze([0, 0, 0, 96]),
  remembered: Object.freeze([0, 0, 0, 64]),
  visible: Object.freeze([0, 0, 0, 0]),
});
export function createCampaignHudFogMask(createCanvas) {
  let source = null,
    cachedFog = null,
    cachedRevision = -1,
    cachedEnabled = null,
    disposed = false;
  return {
    draw(context, fog, view) {
      if (disposed) throw Error('HUD fog mask is disposed');
      if (fog === null) return;
      if (
        !source ||
        cachedFog !== fog ||
        cachedRevision !== fog.maskRevision ||
        cachedEnabled !== fog.enabled ||
        source.width !== fog.width ||
        source.height !== fog.height
      ) {
        const image = fog.buildMinimapMask(minimapFogPalette);
        if (
          image.width !== fog.width ||
          image.height !== fog.height ||
          image.orientation !== 'north-up' ||
          !(image.rgba instanceof Uint8Array) ||
          image.rgba.length !== image.width * image.height * 4
        )
          throw TypeError('Invalid HUD fog minimap mask');
        if (!source) source = createCanvas(image.width, image.height);
        source.width = image.width;
        source.height = image.height;
        source
          .getContext('2d')
          .putImageData(
            new ImageData(new Uint8ClampedArray(image.rgba), image.width, image.height),
            0,
            0
          );
        cachedFog = fog;
        cachedRevision = fog.maskRevision;
        cachedEnabled = fog.enabled;
      }
      context.save();
      try {
        context.beginPath();
        context.rect(view.x, view.y, view.width, view.height);
        context.clip();
        context.imageSmoothingEnabled = false;
        if (view.source) {
          const s = view.source;
          context.drawImage(
            source,
            s.x,
            s.y,
            s.width,
            s.height,
            view.x,
            view.y,
            view.width,
            view.height
          );
        } else context.drawImage(source, view.x, view.y, view.width, view.height);
      } finally {
        context.restore();
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (source) source.width = source.height = 0;
      source = cachedFog = null;
    },
  };
}

// Original source cutouts, responsive OpenRTW placement. This does not recover
// native HUD composition or add construction, diplomacy, combat or economy.
export async function createCampaignHud({
  mount,
  readAsset,
  isOpen,
  onSelect,
  onContinue,
  onEndTurn,
  onCenter,
  onMenu,
  onProduction = null,
  onMapNavigate = null,
  buildingAssets = null,
  cursorTarget = null,
  referenceLayout = null,
}) {
  if (
    !(mount instanceof HTMLElement) ||
    ![readAsset, isOpen, onSelect, onContinue, onEndTurn, onCenter, onMenu].every(
      (v) => typeof v === 'function'
    )
  )
    throw TypeError('Invalid campaign HUD adapter');
  if (referenceLayout !== null && referenceLayout !== originalCampaignHudReference)
    throw TypeError('Unsupported campaign HUD reference');
  if (onMapNavigate !== null && typeof onMapNavigate !== 'function')
    throw TypeError('Invalid HUD map navigation callback');
  if (onProduction !== null && typeof onProduction !== 'function')
    throw TypeError('Invalid HUD production callback');
  const abort = new AbortController(),
    canvases = [],
    textOwners = new Set(),
    listeners = [],
    localCleanups = [],
    unitCardArt = new Map();
  let disposed = false,
    host = null,
    atlases = [],
    sharedAtlases = [],
    layout = null,
    last = null,
    lastInput = null,
    mapSource = null,
    fogMask = null,
    resizeObserver = null,
    cursorOwner = null,
    buildingView = null,
    calendarFont = null,
    calendarFontSource = null;
  const live = () => !disposed && isOpen();
  const requireLive = () => {
    if (!live()) throw new DOMException('Campaign HUD initialization closed', 'AbortError');
  };
  const listen = (node, name, callback) => {
    const guarded = function (...args) {
      if (!disposed) return callback.apply(this, args);
    };
    // Retain the attempted registration even if a platform adapter attaches
    // the listener and then throws. Refused removals leave only inert callbacks.
    listeners.push([node, name, guarded]);
    node.addEventListener(name, guarded);
    if (disposed) node.removeEventListener(name, guarded);
  };
  function dispose() {
    if (disposed) return;
    disposed = true;
    const errors = [], attempt = (cleanup) => {
      try { cleanup(); } catch (error) { errors.push(error); }
    };
    // Retract ownership before entering any external cleanup hook.
    const building = buildingView, observer = resizeObserver, cursor = cursorOwner,
      mask = fogMask, ownedHost = host, labels = [...textOwners],
      cleanups = localCleanups.splice(0), bindings = listeners.splice(0),
      bitmaps = canvases.splice(0);
    buildingView = resizeObserver = cursorOwner = fogMask = host = null;
    textOwners.clear();
    calendarFont = calendarFontSource = null;
    atlases = [];
    sharedAtlases = [];
    unitCardArt.clear();
    layout = last = lastInput = mapSource = null;
    attempt(() => abort.abort());
    attempt(() => building?.dispose());
    for (const cleanup of cleanups) attempt(cleanup);
    attempt(() => observer?.disconnect());
    attempt(() => mount.style.removeProperty('height'));
    attempt(() => { mount.dataset.ready = 'false'; });
    for (const key of [
      'scale', 'scaleX', 'scaleY', 'layoutPolicy', 'referencePngSha256', 'nativeLayoutProved',
      'unitCardSources', 'sharedLayoutSha256', 'sharedTextureHashes',
      'sharedSourceSprites', 'unitCardAlphaPolicy', 'calendarFont', 'hudTypography',
      'fog', 'minimapFrame', 'selectedSettlementId', 'selectedId', 'inspection',
    ]) attempt(() => { delete mount.dataset[key]; });
    attempt(() => cursor?.dispose());
    attempt(() => mask?.dispose());
    for (const owner of labels) attempt(() => owner.dispose());
    for (const [node, name, callback] of bindings)
      attempt(() => node.removeEventListener(name, callback));
    for (const bitmap of bitmaps) {
      attempt(() => { bitmap.width = 0; });
      attempt(() => { bitmap.height = 0; });
    }
    attempt(() => ownedHost?.remove());
    if (errors.length) {
      const detail = errors.map(describeFailure).join('\n').slice(0, 2048);
      attempt(() => { mount.dataset.cleanupError = detail; });
      throw new AggregateError(errors, 'Campaign HUD cleanup failed: ' + detail);
    }
  }
  const canvas = (width, height) => {
    const c = document.createElement('canvas');
    canvases.push(c);
    c.width = width;
    c.height = height;
    const context = c.getContext('2d');
    if (!context) throw Error('HUD 2D canvas unavailable');
    return [c, context];
  };
  const element = (tag, className, text) => {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  try {
    requireLive();
    listen(window, 'pagehide', dispose);
    requireLive();
    mount.dataset.ready = 'loading';
    delete mount.dataset.cleanupError;
    const names = [
      'campaignHudLayout',
      'campaignHudAtlas1',
      'campaignHudAtlas2',
      'campaignHudAtlas3',
      'campaignHudSharedLayout',
      'campaignHudSharedAtlas0',
      'campaignHudSharedAtlas1',
      ...unitCardBindings.map((v) => v.asset),
    ];
    const inputSizes = {
      campaignHudLayout: 84213,
      campaignHudAtlas1: 1048620,
      campaignHudAtlas2: 1048620,
      campaignHudAtlas3: 243044,
      campaignHudSharedLayout: 55161,
      campaignHudSharedAtlas0: 1048620,
      campaignHudSharedAtlas1: 377276,
      ...Object.fromEntries(unitCardBindings.map((v) => [v.asset, v.bytes])),
    };
    const digest = async (bytes) => {
      const result = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (v) =>
        v.toString(16).padStart(2, '0')
      ).join('');
      requireLive();
      return result;
    };
    let loaded = await Promise.all(
      names.map(async (name) => {
        const input = await readAsset(name, { signal: abort.signal });
        requireLive();
        if (
          !(input instanceof Uint8Array) ||
          !(input.buffer instanceof ArrayBuffer) ||
          input.length !== inputSizes[name]
        )
          throw TypeError('HUD asset byte extent refused');
        const bytes = input.slice();
        const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (v) =>
          v.toString(16).padStart(2, '0')
        ).join('');
        requireLive();
        return { name, bytes, hash };
      })
    );
    requireLive();
    layout = parseHudSprites(loaded[0].bytes);
    if (
      layout.collection !== 'CAMPAIGN_UI_SPRITES' ||
      layout.pages.length !== 3 ||
      layout.sprites.length !== 251
    )
      throw Error('Unsupported campaign HUD collection');
    for (let i = 0; i < 3; i++) {
      const page = layout.pages[i];
      if (page.texture !== `stratpage_0${i + 1}.tga`)
        throw Error('Campaign HUD page binding refused');
      const image = decodeTgaTexture(loaded[i + 1].bytes);
      if (image.width !== page.width || image.height !== page.height)
        throw Error('Campaign HUD atlas dimensions disagree with layout');
      const [c, context] = canvas(image.width, image.height);
      context.putImageData(
        new ImageData(new Uint8ClampedArray(image.rgba), image.width, image.height),
        0,
        0
      );
      atlases.push(c);
    }
    const byName = new Map(loaded.map((a) => [a.name, a])),
      hashes = Object.fromEntries(loaded.slice(1, 4).map((a) => [a.name, a.hash])),
      layoutHash = loaded[0].hash;
    const sharedLayout = parseHudSprites(byName.get('campaignHudSharedLayout').bytes);
    if (
      sharedLayout.collection !== 'SHARED_SPRITES' ||
      sharedLayout.pages.length !== 2 ||
      sharedLayout.sprites.length !== 264
    )
      throw Error('Unsupported shared HUD collection');
    const sharedTextureHashes = {};
    for (let i = 0; i < 2; i++) {
      const page = sharedLayout.pages[i],
        asset = byName.get(`campaignHudSharedAtlas${i}`),
        expected = i === 0 ? ['sharedpage_01.tga', 512, 512] : ['sharedpage_00.tga', 348, 271];
      if (page.texture !== expected[0] || page.width !== expected[1] || page.height !== expected[2])
        throw Error('Shared HUD page binding refused');
      const image = decodeTgaTexture(asset.bytes);
      if (image.width !== page.width || image.height !== page.height)
        throw Error('Shared HUD atlas dimensions disagree');
      const [c, context] = canvas(image.width, image.height);
      context.putImageData(
        new ImageData(new Uint8ClampedArray(image.rgba), image.width, image.height),
        0,
        0
      );
      sharedAtlases.push(c);
      sharedTextureHashes[asset.name] = asset.hash;
    }
    const background = sharedLayout.sprites.find((s) => s.name === 'STRAT_CARD_BACKGROUND');
    if (
      !background ||
      background.page !== 0 ||
      background.x0 !== 207 ||
      background.x1 !== 254 ||
      background.y0 !== 448 ||
      background.y1 !== 511 ||
      background.width !== 48 ||
      background.height !== 64
    )
      throw Error('Source unit-card background bounds changed');
    const [scratch, scratchContext] = canvas(48, 64),
      cardSources = [];
    for (const binding of unitCardBindings) {
      const asset = byName.get(binding.asset);
      if (asset.hash !== binding.sha256) throw Error('Selected original unit-card source differs');
      const image = decodeUnitCardTga(asset.bytes);
      if (image.width !== 48 || image.height !== 64)
        throw Error('Selected original unit-card dimensions differ');
      const rgbaSha256 = await digest(image.rgba);
      requireLive();
      scratchContext.putImageData(new ImageData(new Uint8ClampedArray(image.rgba), 48, 64), 0, 0);
      const [composed, context] = canvas(48, 64);
      context.drawImage(
        sharedAtlases[background.page],
        background.x0,
        background.y0,
        48,
        64,
        0,
        0,
        48,
        64
      );
      context.drawImage(scratch, 0, 0);
      const url = composed.toDataURL('image/png');
      if (!url.startsWith('data:image/png;base64,') || url.length > 131072)
        throw Error('Composed unit-card PNG bound refused');
      unitCardArt.set(
        binding.dictionary,
        Object.freeze({ url, sourceSha256: asset.hash, rgbaSha256 })
      );
      cardSources.push({
        dictionary: binding.dictionary,
        asset: binding.asset,
        sourceSha256: asset.hash,
        rgbaSha256,
        width: 48,
        height: 64,
        alphaAttributesType: image.extension.alphaAttributesType,
        extensionDeclaredSize: image.extension.declaredSize,
      });
    }
    const sharedLayoutHash = byName.get('campaignHudSharedLayout').hash;
    loaded = null;
    byName.clear();
    // C9819B requests ID 5 for the date widget. CA9FB8 maps it to verdana_sml;
    // the player's descriptor selects the font. Kerned and alternative file
    // bindings retain readable DOM text until those paths are supported.
    try {
      const databaseBytes = await readAsset('campaignFontDb', { signal: abort.signal });
      requireLive();
      const binding = parseFontDatabase(databaseBytes).find(
        (entry) => entry.name === 'verdana_sml'
      );
      if (!binding || binding.filename.toLowerCase() !== 'sml_font_10.cuf' || binding.kerned)
        throw Error('Unsupported calendar font binding');
      const fontBytes = await readAsset('campaignCalendarFont', { signal: abort.signal });
      requireLive();
      const parsed = parseCufFont(fontBytes);
      if (binding.size !== parsed.pointSize)
        throw Error('Calendar font size differs from descriptor');
      calendarFontSource = {
        state: 'loaded',
        name: binding.name,
        filename: binding.filename,
        sourceSha256: await digest(fontBytes),
        descriptorSha256: await digest(databaseBytes),
        lineHeight: parsed.lineHeight,
        baseline: parsed.baseline,
        widthAdjustment: parsed.widthAdjustment,
        placement: 'native-unkerned-glyph-metrics;existing-hud-widget-position-and-scaling',
        pixelParity: false,
      };
      calendarFont = parsed;
      mount.dataset.calendarFont = JSON.stringify(calendarFontSource);
    } catch (error) {
      requireLive();
      calendarFontSource = { state: 'fallback', reason: String(error.message).slice(0, 256) };
      mount.dataset.calendarFont = JSON.stringify(calendarFontSource);
    }
    mount.dataset.hudTypography = JSON.stringify({
      ...calendarFontSource,
      binding: 'ID5-verdana_sml',
      nativeBindings: ['Army:C91F37', 'selector:C978A6', 'calendar:C9819B'],
      otherLabels: 'OpenRTW-consistent-source-font-policy',
      selectPopup: 'accessible-browser-text',
      nativeLayoutProved: false,
    });
    const textLabel = (node, text, maxWidth = 1024, color = [0, 0, 0]) => {
      const owner = createCufTextPresenter({
        node,
        font: calendarFont,
        createCanvas: () => document.createElement('canvas'),
        maxWidth,
        color,
      });
      textOwners.add(owner);
      owner.set(text);
      return owner;
    };
    function paragraphLabel(node, text) {
      const fallback = element('span', 'hud-paragraph-text', text);
      node.replaceChildren(fallback);
      node.classList.add('hud-cuf-paragraph');
      let bitmaps = [], lastWidth = 0, closed = false;
      const release = () => {
        const owned = bitmaps, errors = [];
        bitmaps = [];
        for (const bitmap of owned)
          for (const dimension of ['width', 'height'])
            try { bitmap[dimension] = 0; } catch (error) { errors.push(error); }
        if (errors.length) throw new AggregateError(errors, 'HUD paragraph bitmap cleanup failed');
      };
      const render = (requestedWidth) => {
        if (closed || !live()) return;
        const width = Math.max(80, Math.min(1024, Math.floor(requestedWidth)));
        if (lastWidth === width) return;
        lastWidth = width;
        release();
        node.replaceChildren(fallback);
        node.dataset.font = 'fallback';
        if (!calendarFont || text.length > 8192) return;
        try {
          const lines = [];
          for (const paragraph of text.split(/\r\n?|\n/)) {
            let line = '';
            for (const word of paragraph.trim().split(/\s+/).filter(Boolean)) {
              // A long unbreakable source word retains complete DOM prose.
              if (measureCufText(calendarFont, word) > width) return;
              const next = line ? line + ' ' + word : word;
              if (measureCufText(calendarFont, next) <= width) line = next;
              else { lines.push(line); line = word; }
              if (lines.length > 256) return;
            }
            lines.push(line);
          }
          if (lines.length > 256) return;
          const rasters = lines.map((line) => rasterizeCufText(calendarFont, line));
          if (rasters.some((raster) => raster.width > width) ||
              rasters.reduce((sum, raster) => sum + raster.width * raster.height, 0) > 2 * 1024 * 1024)
            return;
          const fragment = document.createDocumentFragment();
          for (const raster of rasters) {
            const row = element('span', 'hud-paragraph-line'),
              bitmap = document.createElement('canvas');
            bitmaps.push(bitmap);
            row.style.height = Math.max(15, calendarFont.lineHeight + 2) + 'px';
            row.setAttribute('aria-hidden', 'true');
            bitmap.setAttribute('aria-hidden', 'true');
            bitmap.width = raster.width;
            bitmap.height = raster.height;
            bitmap.style.left = raster.originX + 'px';
            bitmap.style.top = raster.originY + 'px';
            const context = bitmap.getContext('2d');
            if (!context) throw Error('Building paragraph canvas unavailable');
            context.putImageData(new ImageData(raster.rgba, raster.width, raster.height), 0, 0);
            row.append(bitmap);
            fragment.append(row);
          }
          node.append(fragment);
          node.dataset.font = 'cuf';
        } catch {
          release();
          node.replaceChildren(fallback);
        }
      };
      const viewport = typeof innerWidth === 'number' ? innerWidth : 574;
      render(Math.min(416, viewport - 158));
      const observer = new ResizeObserver(() => {
        const width = node.getBoundingClientRect().width;
        if (width > 0) render(width);
      });
      observer.observe(node);
      const owner = {
        dispose() {
          if (closed) return;
          closed = true;
          textOwners.delete(owner);
          const errors = [], attempt = (cleanup) => {
            try { cleanup(); } catch (error) { errors.push(error); }
          };
          attempt(() => observer.disconnect());
          attempt(release);
          attempt(() => { node.textContent = text; });
          attempt(() => node.classList.remove('hud-cuf-paragraph'));
          attempt(() => { delete node.dataset.font; });
          if (errors.length) throw new AggregateError(errors, 'HUD paragraph cleanup failed');
        },
      };
      textOwners.add(owner);
      return owner;
    }
    if (cursorTarget !== null)
      cursorOwner = createCampaignCursor({
        target: cursorTarget,
        layout: sharedLayout,
        atlases: sharedAtlases,
      });
    const sprites = new Map(layout.sprites.map((s) => [s.name, s])),
      used = new Set();
    const sprite = (name) => {
      const s = sprites.get(name);
      if (!s) throw Error('Missing source HUD sprite: ' + name);
      used.add(name);
      return s;
    };
    const paint = (context, name, x, y, w, h) => {
      const s = sprite(name);
      context.drawImage(
        atlases[s.page],
        s.x0,
        s.y0,
        s.width,
        s.height,
        x,
        y,
        w ?? s.width,
        h ?? s.height
      );
    };
    const cut = (name) => {
      const s = sprite(name),
        [c, context] = canvas(s.width, s.height);
      paint(context, name, 0, 0);
      c.setAttribute('aria-hidden', 'true');
      return c;
    };
    const expected = {
      STRAT_HUD_LEFT: [281, 181],
      STRAT_HUD_MIDDLE: [462, 147],
      STRAT_HUD_RIGHT: [281, 181],
      END_TURN_BUTTON_IMAGE: [52, 53],
    };
    for (const [name, size] of Object.entries(expected)) {
      const s = sprite(name);
      if (s.width !== size[0] || s.height !== size[1])
        throw Error('Campaign HUD source panel bounds changed');
    }
    const buttonParts = ['TEXT_BUTTON_BG_L_END', 'TEXT_BUTTON_BG_MID', 'TEXT_BUTTON_BG_R_END'].map(
      (name) => {
        const part = sharedLayout.sprites.find((s) => s.name === name);
        if (!part) throw Error('Missing source button sprite: ' + name);
        return part;
      }
    );
    const [buttonArt, buttonContext] = canvas(120, 32);
    for (const [i, x, width] of [[0, 0, 7], [1, 7, 105], [2, 112, 8]]) {
      const s = buttonParts[i];
      buttonContext.drawImage(
        sharedAtlases[s.page], s.x0, s.y0, s.width, s.height, x, 0, width, 32
      );
    }
    const buttonUrl = buttonArt.toDataURL('image/png'),
      [tabMarble, tabContext] = canvas(76, 14),
      marble = sprite('MARBLE_BG');
    tabContext.drawImage(atlases[marble.page], marble.x0, marble.y0, 76, 14, 0, 0, 76, 14);
    const tabMarbleUrl = tabMarble.toDataURL('image/png');
    host = element('div', 'openrtw-original-hud');
    host.dataset.presentation = 'openrtw-responsive-inspection-source-sprites-v5';
    const style = element('style');
    style.textContent = `
.openrtw-original-hud{position:absolute;left:0;bottom:0;display:grid;align-items:end;gap:0;min-width:0;padding:0;margin:0;border:0;background:transparent;color:#30271e;font:12px system-ui,sans-serif;filter:drop-shadow(0 -3px 5px #0005)}
.openrtw-original-hud *{box-sizing:border-box}
.openrtw-original-hud .hud-panel{position:relative;min-width:0;padding:0;margin:0;border:0;background:transparent}
.openrtw-original-hud canvas{display:block;aspect-ratio:auto;border:0;padding:0;margin:0;background:transparent}
.openrtw-original-hud .hud-panel>canvas:first-child{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
.openrtw-original-hud .hud-name{position:absolute;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.openrtw-original-hud .hud-ap{position:absolute;font-weight:700}
.openrtw-original-hud .hud-select{position:absolute;padding:1px 3px;margin:0;border:1px solid #9b8a6c;border-radius:2px;font:12px/19px system-ui,sans-serif;color:#211a12;background:#f5ecd8}
.openrtw-original-hud .hud-map{position:absolute!important;inset:auto}
.openrtw-original-hud .hud-tabs{position:absolute;display:flex;align-items:end}
.openrtw-original-hud .hud-tab{position:relative;height:31px;padding:0;margin:0;border:0;background:none;color:#211a12}
.openrtw-original-hud .hud-tab>canvas{position:absolute;left:0;bottom:0;clip-path:inset(0 0 14px 0)}
.openrtw-original-hud .hud-tab>span{position:absolute;left:0;right:0;bottom:0;height:14px;display:grid;place-items:center;overflow:hidden;text-align:center;background:#e5dec9 url('${tabMarbleUrl}') center/auto 14px;line-height:14px}
.openrtw-original-hud .hud-army-heading{position:absolute;display:flex;align-items:baseline}
.openrtw-original-hud .hud-army-heading strong{font:700 12px Georgia,serif}
.openrtw-original-hud .hud-army-heading span{color:#65543c;white-space:nowrap}
.openrtw-original-hud .hud-roster{position:absolute;display:flex;overflow-x:auto;overflow-y:hidden;margin:0;list-style:none;scrollbar-width:thin;scrollbar-color:#9b8969 transparent}
.openrtw-original-hud .hud-roster li{position:relative;flex:0 0 82px;min-width:0;display:flex;flex-direction:column;border:1px solid #b7a783;border-radius:0}
.openrtw-original-hud .hud-unit-name{overflow:hidden;font-weight:650}
.openrtw-original-hud .hud-unit-count{line-height:13px;font-size:10px;font-weight:650;text-align:center}
.openrtw-original-hud .hud-roster li.hud-original-card{border:0;align-items:center}
.openrtw-original-hud .hud-unit-picture{display:block;max-width:none;object-fit:contain;margin:0;padding:0;border:0;aspect-ratio:3/4}
.openrtw-original-hud .hud-roster .hud-empty{flex:1 0 64px;justify-content:center;background:#f7efdc75;color:#6a5942;font-size:11px}
.openrtw-original-hud .hud-calendar{position:absolute;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:18px}
.openrtw-original-hud .hud-calendar[data-font="cuf"]{height:22px;line-height:13px}
.openrtw-original-hud .hud-calendar[data-font="cuf"] .hud-calendar-text{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.openrtw-original-hud .hud-calendar canvas{position:absolute;width:auto;height:auto;max-width:none;pointer-events:none}
.openrtw-original-hud .hud-end{position:absolute;display:flex;align-items:center;justify-content:flex-start;margin:0;border:0;border-radius:2px;background:transparent;color:#33291c;text-align:left;cursor:pointer}
.openrtw-original-hud .hud-end>canvas{flex:0 0 60px;width:60px;height:60px;pointer-events:none}
.openrtw-original-hud .hud-end-copy{min-width:0;display:flex;flex-direction:column;gap:3px}
.openrtw-original-hud .hud-end-copy strong{font:700 14px/18px Georgia,serif}
.openrtw-original-hud .hud-end-copy small{font-size:10px;line-height:13px;color:#69573e}
.openrtw-original-hud .hud-actions{position:absolute;display:grid}
.openrtw-original-hud .hud-actions button{min-width:0;margin:0;overflow:hidden;text-overflow:ellipsis;font:11px/19px system-ui,sans-serif;color:#33291c;background:transparent url('${buttonUrl}') center/100% 100%;border:0;border-radius:0;cursor:pointer}
.openrtw-original-hud .hud-actions button:first-child{font-weight:650}
.openrtw-original-hud button:disabled:not(.hud-tab){opacity:.45;cursor:not-allowed}
.openrtw-original-hud button:not(:disabled):hover{filter:brightness(1.06)}
.openrtw-original-hud button:focus-visible,.openrtw-original-hud select:focus-visible{outline:2px solid #255bc3;outline-offset:2px}
.openrtw-original-hud .hud-cuf-label[data-font="cuf"]{line-height:15px}
.openrtw-original-hud .hud-cuf-label>.hud-cuf-text{position:static;inset:auto;font:inherit;color:inherit;line-height:inherit}
.openrtw-original-hud .hud-cuf-label[data-font="cuf"]>.hud-cuf-text{position:absolute!important;width:1px!important;height:1px!important;inset:auto!important;padding:0!important;overflow:hidden!important;clip-path:inset(50%);white-space:nowrap}
.openrtw-original-hud .hud-cuf-label>canvas.hud-cuf-bitmap{position:relative;inset:auto;display:block;width:auto;height:auto;max-width:none;flex:0 0 auto;pointer-events:none;margin:0}
.openrtw-original-hud .hud-cuf-label>canvas.hud-cuf-bitmap[hidden]{display:none}
.openrtw-original-hud .hud-tab .hud-cuf-label>canvas,.openrtw-original-hud .hud-actions .hud-cuf-label>canvas,.openrtw-original-hud .hud-unit-count>canvas{margin-left:auto;margin-right:auto}
.openrtw-original-hud .hud-tab .hud-cuf-label[data-font="cuf"]{bottom:0;text-shadow:none}
.openrtw-original-hud .hud-empty .hud-cuf-label{max-width:100%}
.openrtw-original-hud .hud-end-copy .hud-cuf-label{min-height:15px}

.openrtw-original-hud{grid-template-columns:var(--hud-side) minmax(0,1fr) var(--hud-side);height:var(--hud-height);transform:none}
.openrtw-original-hud .hud-panel{height:var(--hud-height)}.openrtw-original-hud .hud-middle{height:var(--hud-middle)}
.openrtw-original-hud .hud-name{left:16px;right:80px;top:20px;font-size:15px;line-height:20px;font-weight:700}
.openrtw-original-hud .hud-ap{right:14px;top:41px;line-height:17px;font-size:12px;color:#3f5425}
.openrtw-original-hud .hud-select{left:calc(135px * var(--hud-sx));top:calc(40px * var(--hud-sy));width:calc(111px * var(--hud-sx));height:calc(31px * var(--hud-sy));opacity:0;z-index:4;cursor:pointer}
.openrtw-original-hud .hud-selector-label{position:absolute;left:calc(135px * var(--hud-sx));top:calc(46px * var(--hud-sy));width:calc(111px * var(--hud-sx));height:24px;overflow:hidden;text-align:center;white-space:nowrap;pointer-events:none}
.openrtw-original-hud .hud-selector-label>canvas{margin:auto!important}
.openrtw-original-hud .hud-select:focus-visible{opacity:.01}.openrtw-original-hud .hud-selector-label:has(+select:focus-visible){outline:2px solid #255bc3}
.openrtw-original-hud .hud-cycle{position:absolute;top:calc(40px * var(--hud-sy));width:calc(17px * var(--hud-sx));height:calc(31px * var(--hud-sy));margin:0;padding:0;border:0;background:transparent}
.openrtw-original-hud .hud-cycle>canvas{width:100%;height:100%}.openrtw-original-hud .hud-previous{left:calc(116px * var(--hud-sx))}.openrtw-original-hud .hud-next{left:calc(248px * var(--hud-sx))}
.openrtw-original-hud .hud-map{left:calc(12.5px * var(--hud-sx))!important;top:calc(15px * var(--hud-sy))!important;width:calc(256px * var(--hud-sx))!important;height:calc(165px * var(--hud-sy))!important;image-rendering:auto;cursor:crosshair}
.openrtw-original-hud .hud-map:focus-visible{outline:2px solid #f4d44e;outline-offset:-3px}
.openrtw-original-hud .hud-map-toolbar{position:absolute;left:calc(15.5px * var(--hud-sx));top:calc(159px * var(--hud-sy));height:calc(21px * var(--hud-sy));display:flex;gap:calc(3px * var(--hud-sx))}
.openrtw-original-hud .hud-map-mode{position:relative;flex:none;width:calc(21px * var(--hud-sx));min-width:0;height:100%;padding:0;margin:0;border:0;border-radius:50%;background:transparent}
.openrtw-original-hud .hud-map-mode>canvas.hud-map-icon{position:absolute;inset:0;width:100%;height:100%}
.openrtw-original-hud .hud-map-mode>.hud-cuf-bitmap,.openrtw-original-hud .hud-map-mode>.hud-cuf-text{position:absolute!important;width:1px!important;height:1px!important;overflow:hidden;clip-path:inset(50%)}
.openrtw-original-hud .hud-tabs{left:50%;bottom:100%;height:calc(25px * var(--hud-sy));gap:0;transform:translateX(-50%);z-index:1}
.openrtw-original-hud .hud-tab{flex:none;height:100%;cursor:pointer}.openrtw-original-hud .hud-tab>canvas{width:100%;height:100%;clip-path:none}
.openrtw-original-hud .hud-tab>span{height:100%;display:grid;align-items:center;justify-items:center;background:transparent}
.openrtw-original-hud .hud-tab:disabled{opacity:.6}.openrtw-original-hud .hud-tab[aria-selected="true"]{z-index:2}
.openrtw-original-hud .hud-army-heading{top:41px;left:16px;right:100px;justify-content:flex-start;line-height:17px;gap:10px}
.openrtw-original-hud .hud-roster{left:16px;right:16px;top:62px;bottom:8px;gap:9px;align-items:flex-start;padding:0 0 3px;scroll-snap-type:x proximity}
.openrtw-original-hud .hud-roster li{flex-basis:80px;height:116px;padding:4px;background:#f7efdc75;border-color:#b7a783;gap:5px;scroll-snap-align:start}
.openrtw-original-hud .hud-roster li.hud-original-card{padding:0;background:transparent;gap:5px}
.openrtw-original-hud .hud-unit-name{position:static;display:block;width:100%;height:30px;padding:0;margin:0;overflow:hidden;white-space:normal;font:12px/15px Georgia,serif;text-align:center;order:2}
.openrtw-original-hud .hud-unit-name-line{display:block;height:15px;white-space:nowrap;overflow:hidden}.openrtw-original-hud .hud-unit-name-line>canvas{margin-left:auto!important;margin-right:auto!important}
.openrtw-original-hud .hud-unit-picture{width:60px!important;height:80px!important;flex-basis:80px;image-rendering:pixelated}
.openrtw-original-hud .hud-unit-count{position:absolute;right:6px;top:64px;padding:0 2px;background:#f5ead4df;border:1px solid #a18d68;margin:0;order:3}
.openrtw-original-hud .hud-unit-kind{display:none}.openrtw-original-hud .hud-roster .hud-empty{height:88px;align-items:flex-start;padding:12px;line-height:17px;border:0;background:none}
.openrtw-original-hud .hud-settlement{position:absolute;left:16px;right:16px;top:62px;bottom:12px;display:flex;align-items:flex-start;gap:20px;overflow:auto;padding:4px 0;font:13px/21px Georgia,serif}
.openrtw-original-hud .hud-settlement p{margin:0 0 3px}.openrtw-original-hud .hud-overview-hint{color:#68573d;font-size:12px}
.openrtw-original-hud .hud-town-details{min-width:120px;flex:1}.openrtw-original-hud .hud-town-summary{flex:1;color:#64533b;font-size:12px;line-height:19px}
.openrtw-original-hud .hud-buildings{position:absolute;left:12px;right:12px;top:58px;bottom:8px;overflow:auto;margin:0;padding:0}
.openrtw-original-hud .hud-buildings:not([data-source-view]){display:flex;flex-wrap:wrap;align-content:flex-start;gap:6px;list-style:none}
.openrtw-original-hud .hud-buildings>li{min-width:100px;padding:6px 9px;border:1px solid #b7a783;font:12px/16px Georgia,serif}.openrtw-original-hud .hud-buildings strong,.openrtw-original-hud .hud-buildings small{display:block}
.openrtw-original-hud .hud-calendar{left:calc(145px * var(--hud-sx));top:calc(93px * var(--hud-sy));right:6px;font-size:12px;height:24px}
.openrtw-original-hud .hud-treasury{position:absolute;left:calc(145px * var(--hud-sx));top:calc(77px * var(--hud-sy));height:24px;font-size:12px}
.openrtw-original-hud .hud-cash-icon{position:absolute;left:calc(122px * var(--hud-sx));top:calc(75px * var(--hud-sy));width:calc(19px * var(--hud-sx));height:calc(20px * var(--hud-sy))}
.openrtw-original-hud .hud-season{position:absolute;left:calc(237px * var(--hud-sx));top:calc(75px * var(--hud-sy));width:calc(32px * var(--hud-sx));height:calc(32px * var(--hud-sy))}
.openrtw-original-hud .hud-end{left:calc(218px * var(--hud-sx));top:calc(122px * var(--hud-sy));width:calc(60px * var(--hud-sx));height:calc(60px * var(--hud-sy));padding:0;margin:0;display:block}
.openrtw-original-hud .hud-end>canvas{width:100%;height:100%}.openrtw-original-hud .hud-end-copy{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
.openrtw-original-hud .hud-actions{position:static;display:block}
.openrtw-original-hud .hud-actions button,.openrtw-original-hud .hud-building-preview{position:absolute;margin:0;padding:0;border:0;border-radius:50%;background:transparent;color:#30271e;display:grid;place-items:center;white-space:nowrap}
.openrtw-original-hud .hud-actions button>canvas.hud-control-art,.openrtw-original-hud .hud-building-preview>canvas{position:absolute;inset:0;width:100%;height:100%;z-index:0}
.openrtw-original-hud .hud-actions button>.hud-cuf-bitmap,.openrtw-original-hud .hud-actions button>.hud-cuf-text{position:relative;z-index:1}
.openrtw-original-hud .hud-continue,.openrtw-original-hud .hud-building-preview{left:calc(26px * var(--hud-sx));top:calc(16px * var(--hud-sy));width:calc(86px * var(--hud-sx));height:calc(86px * var(--hud-sy))}
.openrtw-original-hud .hud-center{left:calc(26px * var(--hud-sx));top:calc(98px * var(--hud-sy));width:calc(86px * var(--hud-sx));height:calc(86px * var(--hud-sy))}
.openrtw-original-hud .hud-menu{left:calc(157px * var(--hud-sx));top:calc(122px * var(--hud-sy));width:calc(60px * var(--hud-sx));height:calc(60px * var(--hud-sy))}
.openrtw-original-hud .hud-menu>.hud-cuf-bitmap,.openrtw-original-hud .hud-menu>.hud-cuf-text{position:absolute!important;width:1px!important;height:1px!important;overflow:hidden;clip-path:inset(50%)}
.openrtw-original-hud[data-compact="true"] .hud-roster{gap:7px}.openrtw-original-hud[data-compact="true"] .hud-roster li{flex-basis:72px;height:100px}
.openrtw-original-hud[data-compact="true"] .hud-unit-picture{width:48px!important;height:64px!important;flex-basis:64px}
.openrtw-original-hud[data-compact="true"] .hud-unit-count{top:48px}
.openrtw-original-hud[data-narrow="true"] .hud-town-summary{display:none}.openrtw-original-hud[data-narrow="true"] .hud-roster li{flex-basis:70px}
.openrtw-original-hud[data-narrow="true"] .hud-name{right:16px}.openrtw-original-hud[data-narrow="true"] .hud-actions button{font-size:10px}
.openrtw-original-hud [hidden]{display:none!important}
.campaign-building-preview .hud-cuf-label{position:relative}
.campaign-building-preview .hud-cuf-label[data-font="cuf"]>.hud-cuf-text{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.campaign-building-preview .hud-cuf-label>canvas.hud-cuf-bitmap{display:block;width:auto;height:auto;max-width:none;aspect-ratio:auto;background:transparent;border:0;pointer-events:none}
.campaign-building-preview .hud-cuf-label>canvas.hud-cuf-bitmap[hidden]{display:none}
.campaign-building-preview .hud-cuf-paragraph[data-font="cuf"]>.hud-paragraph-text{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:pre-wrap}
.campaign-building-preview .hud-paragraph-line{display:block;position:relative;white-space:normal}
.campaign-building-preview .hud-paragraph-line>canvas{position:relative;display:block;width:auto;height:auto;max-width:none;aspect-ratio:auto;border:0;background:transparent}
`;
    host.append(style);
    const panel = (name, classes) => {
      const p = element('section', 'hud-panel ' + classes);
      p.append(cut(name));
      host.append(p);
      return p;
    };
    const left = panel('STRAT_HUD_LEFT', 'hud-left'),
      middle = panel('STRAT_HUD_MIDDLE', 'hud-middle'),
      right = panel('STRAT_HUD_RIGHT', 'hud-right');
    // Responsive port layout retains source art; only plain middle marble tiles.
    // The old captured-reference calibration is not claimed for this layout.
    const middleArt = middle.firstElementChild,
      middleSprite = sprite('STRAT_HUD_MIDDLE');
    const fit = () => {
      if (!live() || !host) return;
      const width = mount.getBoundingClientRect().width;
      if (!(width > 0)) return;
      const geometry = campaignHudGeometry(width),
        compact = width < 1100;
      host.dataset.compact = String(compact);
      host.dataset.narrow = String(width < 760);
      host.style.width = width + 'px';
      for (const [key, value] of Object.entries({
        '--hud-side': geometry.sideWidth + 'px',
        '--hud-height': geometry.height + 'px',
        '--hud-middle': geometry.middleHeight + 'px',
        '--hud-sx': String(geometry.scaleX),
        '--hud-sy': String(geometry.scaleY),
      })) host.style.setProperty(key, value);
      mount.style.height = geometry.height + 'px';
      mount.dataset.scale = mount.dataset.scaleX = String(geometry.scaleX);
      mount.dataset.scaleY = String(geometry.scaleY);
      mount.dataset.layoutPolicy = 'native-art-and-C91F37-anchors;capture-mapping;responsive-middle';
      mount.dataset.nativeLayoutProved = 'false';
      mount.dataset.referencePngSha256 = originalCampaignHudReference.sourcePngSha256;
      for (const b of tabButtons) {
        b.style.width = Number(b.dataset.logicalWidth) * geometry.scaleX + 'px';
        b.style.marginLeft = b === tabButtons[0] ? '0px' : -8 * geometry.scaleX + 'px';
      }
      const artWidth = Math.max(32, Math.ceil(geometry.middleWidth / geometry.scaleX));
      map.width = 256;
      map.height = 165;
      if (middleArt.width === artWidth) {
        if (lastInput) update(lastInput);
        return;
      }
      middleArt.width = artWidth;
      const context = middleArt.getContext('2d'),
        s = middleSprite,
        atlas = atlases[s.page];
      context.drawImage(atlas, s.x0, s.y0, 16, 147, 0, 0, 16, 147);
      for (let x = 16; x < artWidth - 16; ) {
        const width = Math.min(430, artWidth - 16 - x);
        context.drawImage(atlas, s.x0 + 16, s.y0, width, 147, x, 0, width, 147);
        x += width;
      }
      context.drawImage(atlas, s.x0 + 446, s.y0, 16, 147, artWidth - 16, 0, 16, 147);
      if (lastInput) update(lastInput);
    };
    const resizeTarget = mount.parentElement;
    if (!resizeTarget) throw TypeError('Campaign HUD mount must be attached');
    resizeObserver = new ResizeObserver(fit);
    resizeObserver.observe(resizeTarget);
    const selectedName = element('strong', 'hud-name', 'Select a character'),
      actionPoints = element('span', 'hud-ap'),
      select = element('select', 'hud-select');
    select.dataset.hudCharacter = '';
    select.setAttribute('aria-label', 'Select campaign character');
    middle.append(selectedName, actionPoints);
    const selectorLabel = element('span', 'hud-selector-label'),
      selectorLabelText = textLabel(selectorLabel, 'Imperial campaign', 105);
    right.append(selectorLabel, select);
    const previous = element('button', 'hud-cycle hud-previous'),
      nextCharacter = element('button', 'hud-cycle hud-next');
    for (const [button, name, label, step] of [
      [previous, 'PREV_BUTTON', 'Previous character', -1],
      [nextCharacter, 'NEXT_BUTTON', 'Next character', 1],
    ]) {
      button.type = 'button';
      button.title = label;
      button.setAttribute('aria-label', label);
      button.append(cut(name));
      listen(button, 'click', () => {
        if (!enabled('canSelect') || !last.characters.length) return;
        const index = last.characters.findIndex((c) => String(c.id) === select.value),
          target = index < 0 ? (step > 0 ? 0 : last.characters.length - 1)
            : (index + step + last.characters.length) % last.characters.length;
        onSelect(last.characters[target].id);
      });
      right.append(button);
    }
    const selectedNameText = textLabel(selectedName, 'Select a character', 280),
      actionPointsText = textLabel(actionPoints, '', 112, [63, 84, 37]);
    const [map, mapContext] = canvas(256, 139);
    map.className = 'hud-map';
    map.setAttribute('role', 'img');
    map.setAttribute('aria-label', 'Campaign map overview');
    left.append(map);
    const mapToolbar = element('div', 'hud-map-toolbar'),
      mapTitle = element('span', 'hud-map-title'),
      mapMode = element('button', 'hud-map-mode');
    const mapTitleText = textLabel(mapTitle, 'Explored map', 130),
      mapModeText = textLabel(mapMode, 'World', 43);
    const mapModeIcon = cut('RADAR_BUTTON_PLUS');
    mapModeIcon.className = 'hud-map-icon';
    mapMode.append(mapModeIcon);
    mapTitle.hidden = true;
    mapMode.type = 'button';
    mapMode.dataset.hudMapMode = '';
    mapMode.title = 'Switch between explored territory and the whole campaign map';
    mapMode.setAttribute('aria-label', 'Show whole campaign map');
    mapToolbar.append(mapTitle, mapMode);
    left.append(mapToolbar);
    [mapSource] = canvas(1, 1);
    fogMask = createCampaignHudFogMask((width, height) => canvas(width, height)[0]);
    const tabs = element('div', 'hud-tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'Selection details');
    const tabButtons = [];
    function paintTab(button, selected) {
      const art = button.firstElementChild,
        prefix = 'HUD_TEXT_TAB_', suffix = selected ? '_SELECTED' : '';
      if (art.dataset.selected === String(selected)) return;
      art.width = art.width;
      const context = art.getContext('2d'),
        left = sprite(prefix + 'LEFT' + suffix),
        center = sprite(prefix + 'MID' + suffix),
        right = sprite(prefix + 'RIGHT' + suffix);
      paint(context, left.name, 0, 0);
      for (let x = 20; x < art.width - 20; x += center.width) {
        const w = Math.min(center.width, art.width - 20 - x);
        context.drawImage(atlases[center.page], center.x0, center.y0, w, 25, x, 0, w, 25);
      }
      paint(context, right.name, art.width - 20, 0);
      art.dataset.selected = String(selected);
    }
    let activeTab = 'army';
    for (const [key, label, name, title] of [
      ['army', 'Army', 'TAB_ARMIES_SELECTED', 'Inspect the selected character army'],
      ['town', 'Town', 'TAB_BUILDINGS_DISABLED', 'Inspect the selected settlement'],
      [
        'buildings',
        'Buildings',
        'TAB_BUILDINGS_DISABLED',
        'View settlement buildings',
      ],
      ['passengers', '', null, 'Passengers'],
    ]) {
      const b = element('button', 'hud-tab');
      b.type = 'button';
      const copy = element('span');
      textLabel(copy, label, 67);
      const captionWidth = calendarFont ? measureCufText(calendarFont, label) : label.length * 7,
        [art] = canvas(captionWidth + 60, 25);
      art.setAttribute('aria-hidden', 'true');
      b.dataset.logicalWidth = String(art.width);
      b.append(art, copy);
      paintTab(b, false);
      b.title = title;
      b.dataset.hudTab = key;
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-label', label || 'Passengers');
      b.setAttribute('aria-selected', 'false');
      b.disabled = true;
      listen(b, 'click', () => {
        if (!live() || b.disabled || !lastInput) return;
        activeTab = key;
        update(lastInput);
      });
      listen(b, 'keydown', (event) => {
        if (
          !live() ||
          b.disabled ||
          !lastInput ||
          !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)
        )
          return;
        const available = tabButtons.filter((button) => !button.disabled),
          index = available.indexOf(b),
          next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? available.length - 1
                : (index + (event.key === 'ArrowRight' ? 1 : available.length - 1)) %
                  available.length;
        event.preventDefault();
        activeTab = available[next].dataset.hudTab;
        update(lastInput);
        available[next].focus?.();
      });
      tabButtons.push(b);
      tabs.append(b);
    }
    middle.append(tabs);
    const armyHeading = element('div', 'hud-army-heading'),
      armyCount = element('span');
    const armyTitle = element('strong');
    const armyTitleText = textLabel(armyTitle, 'Army', 140);
    const armyCountText = textLabel(armyCount, '', 140);
    armyHeading.append(armyTitle, armyCount);
    const roster = element('ul', 'hud-roster');
    roster.setAttribute('aria-label', 'Selected character army');
    middle.append(armyHeading, roster);
    const settlementView = element('div', 'hud-settlement'),
      buildingsView = element(buildingAssets ? 'div' : 'ul', 'hud-buildings');
    settlementView.hidden = buildingsView.hidden = true;
    buildingsView.setAttribute('aria-label', 'Existing settlement buildings');
    middle.append(settlementView, buildingsView);
    if (buildingAssets) {
      // Original shared scroll pieces; this nine-slice responsive dialog frame
      // does not establish the unrecovered native building-window rectangle.
      const [frameArt, frameContext] = canvas(198, 121),
        rows = [['SCROLL_TOP_LEFT', 'SCROLL_TOP_CENTER', 'SCROLL_TOP_RIGHT'],
          ['SCROLL_MID_LEFT', 'SCROLL_MID', 'SCROLL_MID_RIGHT'],
          ['SCROLL_BOTTOM_LEFT', 'SCROLL_BOTTOM_CENTER', 'SCROLL_BOTTOM_RIGHT']];
      let closeArtUrl = null;
      for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) {
        const s = sharedLayout.sprites.find((part) => part.name === rows[row][col]);
        if (!s) throw Error('Missing source scroll frame');
        frameContext.drawImage(sharedAtlases[s.page], s.x0, s.y0, s.width, s.height,
          [0, 67, 131][col], [0, 26, 90][row], [67, 64, 67][col], [26, 64, 31][row]);
      }
      const frameUrl = frameArt.toDataURL('image/png'),
        closeSprite = sharedLayout.sprites.find((part) => part.name === 'SCROLL_CLOSE_GADGET');
      if (closeSprite) {
        const [closeArt, context] = canvas(closeSprite.width, closeSprite.height);
        context.drawImage(sharedAtlases[closeSprite.page], closeSprite.x0, closeSprite.y0,
          closeSprite.width, closeSprite.height, 0, 0, closeSprite.width, closeSprite.height);
        closeArtUrl = closeArt.toDataURL('image/png');
      }
      buildingsView.dataset.sourceView = 'true';
      buildingView = createCampaignBuildingView({
        mount: buildingsView,
        assets: buildingAssets,
        isOpen: live,
        decorateDialog(dialog, { closeButton }) {
          dialog.style.border = 'solid transparent';
          dialog.style.borderWidth = '26px 67px 31px';
          dialog.style.borderImage = `url('${frameUrl}') 26 67 31 67 fill / 26px 67px 31px 67px / 0 stretch`;
          dialog.style.padding = '12px 0';
          dialog.style.background = 'transparent';
          if (closeArtUrl) {
            closeButton.style.background = `transparent url('${closeArtUrl}') center/16px 16px no-repeat`;
            closeButton.style.border = '0';
            closeButton.style.fontSize = '0';
            closeButton.style.minWidth = '32px';
            closeButton.title = 'Close building inspection';
          }
          return { dispose() {} };
        },
        createTextLabel(node, text) {
          if (node.className.split(' ').includes('campaign-building-preview-description'))
            return paragraphLabel(node, text);
          const label = textLabel(node, text,
            node.className.split(' ').includes('campaign-building-fallback') ? 70 : 416);
          return { dispose() { label.dispose(); textOwners.delete(label); } };
        },
      });
    }
    const calendar = element('strong', 'hud-calendar'),
      end = element('button', 'hud-end');
    const calendarText = element('span', 'hud-calendar-text'),
      [calendarBitmap, calendarContext] = canvas(1, 1);
    calendarBitmap.setAttribute('aria-hidden', 'true');
    calendarBitmap.hidden = true;
    calendar.append(calendarText, calendarBitmap);
    const treasury = element('span', 'hud-treasury'),
      treasuryText = textLabel(treasury, '', 96),
      cashIcon = cut('CONSTRUCTION_COST_ICON'),
      seasonIcon = cut('SEASON_ICON_SUMMER');
    cashIcon.className = 'hud-cash-icon';
    seasonIcon.className = 'hud-season';
    right.append(treasury, cashIcon, seasonIcon);
    let calendarValue = null;
    function updateCalendar(text) {
      if (text === calendarValue) return;
      const date = /\b\d+\s+(?:BC|AD)\b/i.exec(text)?.[0] ?? text;
      calendarText.textContent = date;
      calendar.title = text;
      calendar.dataset.font = 'fallback';
      calendarBitmap.hidden = true;
      if (calendarFont) {
        try {
          // C9819B initializes the calendar color to opaque black. The source
          // alpha and per-glyph placement are preserved; CSS scaling and final
          // canvas blend rounding remain presentation choices.
          const raster = rasterizeCufText(calendarFont, date);
          calendarBitmap.width = raster.width;
          calendarBitmap.height = raster.height;
          calendarBitmap.style.left = raster.originX + 'px';
          calendarBitmap.style.top = raster.originY + 'px';
          calendarContext.putImageData(
            new ImageData(raster.rgba, raster.width, raster.height),
            0,
            0
          );
          calendarBitmap.hidden = false;
          calendar.dataset.font = 'cuf';
          mount.dataset.calendarFont = JSON.stringify({
            ...calendarFontSource,
            state: 'active',
            text,
            logicalWidth: raster.logicalWidth,
            width: raster.width,
            height: raster.height,
          });
        } catch (error) {
          mount.dataset.calendarFont = JSON.stringify({
            ...calendarFontSource,
            state: 'fallback',
            reason: String(error.message).slice(0, 256),
          });
        }
      }
      calendarValue = text;
      const season = /winter/i.test(text) ? 'SEASON_ICON_WINTER' : 'SEASON_ICON_SUMMER';
      seasonIcon.width = seasonIcon.width;
      paint(seasonIcon.getContext('2d'), season, 0, 0, seasonIcon.width, seasonIcon.height);
    }
    end.type = 'button';
    end.dataset.hudEndTurn = '';
    end.title = 'End turn';
    end.setAttribute('aria-label', 'End turn');
    const endCopy = element('span', 'hud-end-copy');
    const endTitle = element('strong');
    textLabel(endTitle, 'End turn', 90);
    end.title = 'End turn and replenish action points';
    endCopy.append(endTitle);
    const [endArt, endContext] = canvas(60, 60);
    endArt.setAttribute('aria-hidden', 'true');
    paint(endContext, 'BUTTON_OUTER_RING_MED', 0, 0, 60, 60);
    paint(endContext, 'END_TURN_BUTTON_IMAGE', 4, 3, 52, 53);
    end.append(endArt, endCopy);
    right.append(calendar, end);
    const actions = element('div', 'hud-actions'),
      continueButton = element('button', '', 'Continue'),
      center = element('button', '', 'Center'),
      menu = element('button', '', 'Menu');
    for (const b of [continueButton, center, menu]) {
      b.type = 'button';
      textLabel(b, b.textContent, 70);
    }
    continueButton.dataset.hudContinue = '';
    center.dataset.hudCenter = '';
    menu.dataset.hudMenu = '';
    continueButton.classList.add('hud-continue');
    center.classList.add('hud-center');
    menu.classList.add('hud-menu');
    for (const [button, size, image] of [
      [continueButton, 86, 'BLANK_BUTTON_IMAGE'],
      [center, 86, 'BLANK_BUTTON_IMAGE'],
      [menu, 60, 'FACTION_LOGO_ALEMANNI'],
    ]) {
      const [art, context] = canvas(size, size);
      art.className = 'hud-control-art';
      art.setAttribute('aria-hidden', 'true');
      paint(context, size === 86 ? 'BUTTON_OUTER_RING_LRG' : 'BUTTON_OUTER_RING_MED', 0, 0, size, size);
      paint(context, image, size === 86 ? 5 : 4, size === 86 ? 5 : 4, size - (size === 86 ? 10 : 8), size - (size === 86 ? 10 : 8));
      button.replaceChildren(art, ...Array.from(button.children));
    }
    const buildingPreview = element('button', 'hud-building-preview');
    buildingPreview.type = 'button';
    buildingPreview.title = onProduction ? 'Construction and recruitment' : 'Inspect settlement buildings';
    buildingPreview.setAttribute('aria-label', buildingPreview.title);
    const [buildingPreviewArt, buildingPreviewContext] = canvas(86, 86);
    paint(buildingPreviewContext, 'BUTTON_OUTER_RING_LRG', 0, 0);
    paint(buildingPreviewContext, 'BUILD_BUTTON_IMAGE', 5, 5);
    buildingPreview.append(buildingPreviewArt);
    buildingPreview.hidden = true;
    listen(buildingPreview, 'click', () => {
      if (!live() || buildingPreview.disabled || !lastInput) return;
      if (onProduction) onProduction(lastInput.selectedSettlement?.id);
      else if (buildingView) buildingView.open(0);
      else { activeTab = 'buildings'; update(lastInput); }
    });
    right.append(buildingPreview);
    actions.append(continueButton, center, menu);
    right.append(actions);
    const enabled = (key) => live() && last?.[key] &&
      (!['canNavigate', 'canMapControl'].includes(key) || buildingView?.status.selectedIndex == null);
    listen(select, 'change', () => {
      if (enabled('canSelect')) {
        const id = Number(select.value);
        if (select.value !== '' && last.characters.some((c) => c.id === id)) onSelect(id);
      }
    });
    listen(continueButton, 'click', () => {
      if (enabled('canContinue')) onContinue();
    });
    listen(end, 'click', () => {
      if (enabled('canEndTurn')) onEndTurn();
    });
    listen(center, 'click', () => {
      if (enabled('canCenter')) onCenter();
    });
    listen(menu, 'click', () => {
      if (enabled('canMenu')) onMenu();
    });
    let mapModeValue = 'world',
      frameKey = null,
      minimapFrame = null,
      uploadedMap = null,
      navigationView = null,
      keyboardCell = null;
    localCleanups.push(() => {
      frameKey = minimapFrame = uploadedMap = navigationView = keyboardCell = null;
    });
    listen(mapMode, 'click', () => {
      if (!enabled('canMapControl') || !lastInput) return;
      mapModeValue = mapModeValue === 'local' ? 'world' : 'local';
      update(lastInput);
    });
    const navigate = (cell) => {
      if (!enabled('canNavigate') || !cell || !onMapNavigate) return;
      keyboardCell = cell;
      onMapNavigate({ ...cell });
    };
    listen(map, 'click', (event) => {
      if (!enabled('canNavigate') || !navigationView || (event.button ?? 0) !== 0) return;
      const rect = map.getBoundingClientRect();
      if (!(rect.width > 0) || !(rect.height > 0)) return;
      const cell = campaignHudMinimapPick({
        ...navigationView,
        px: ((event.clientX - rect.left) / rect.width) * map.width,
        py: ((event.clientY - rect.top) / rect.height) * map.height,
      });
      if (cell) {
        map.focus?.({ preventScroll: true });
        navigate(cell);
      }
    });
    listen(map, 'keydown', (event) => {
      if (!enabled('canNavigate') || !navigationView ||
          !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', ' '].includes(event.key))
        return;
      event.preventDefault();
      event.stopPropagation();
      const { frame, worldWidth, worldHeight } = navigationView,
        point = keyboardCell ?? { x: Math.floor(frame.x + frame.width / 2), y: Math.floor(frame.y + frame.height / 2) },
        step = event.shiftKey ? 8 : 1;
      navigate({
        x: Math.max(0, Math.min(worldWidth - 1, point.x +
          (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0))),
        y: Math.max(0, Math.min(worldHeight - 1, point.y +
          (event.key === 'ArrowDown' ? -step : event.key === 'ArrowUp' ? step : 0))),
      });
    });
    for (const name of ['RADAR_HORIZONTAL_SIDE', 'RADAR_VERTICAL_SIDE', 'RADAR_CORNER_PIECE'])
      sprite(name);
    const integer = (value, min, max) =>
      Number.isSafeInteger(value) && value >= min && value <= max;
    let rosterKey = null,
      contextIdentity = null,
      settlementKey = null,
      rosterTextOwners = [];
    function update(state) {
      if (!live()) return false;
      if (
        !state ||
        !Array.isArray(state.characters) ||
        state.characters.length > 4096 ||
        !integer(state.worldWidth, 1, 4096) ||
        !integer(state.worldHeight, 1, 4096) ||
        typeof state.calendar !== 'string' ||
        state.calendar.length > 256
      )
        throw TypeError('Invalid HUD state');
      const rawCharacters = state.characters.map((c) => {
        if (
          !c ||
          !integer(c.id, 0, 0xffffffff) ||
          typeof c.name !== 'string' ||
          c.name.length > 512 ||
          !integer(c.x, 0, state.worldWidth - 1) ||
          !integer(c.y, 0, state.worldHeight - 1) ||
          !integer(c.actionPoints, 0, 0xffffffff)
        )
          throw TypeError('Invalid HUD character');
        return { id: c.id, name: c.name, x: c.x, y: c.y, actionPoints: c.actionPoints };
      });
      if (new Set(rawCharacters.map((c) => c.id)).size !== rawCharacters.length)
        throw TypeError('Duplicate HUD character');
      const fog = state.fog ?? null;
      const { characters, selectedId, army, hiddenSelection } = campaignHudVisibility({
        characters: rawCharacters,
        selectedId: state.selectedId ?? null,
        army: state.army ?? null,
        fog,
        worldWidth: state.worldWidth,
        worldHeight: state.worldHeight,
      });
      let settlement = state.selectedSettlement ?? null;
      if (settlement) {
        if (
          selectedId !== null ||
          !integer(settlement.id, 0, 0xffffffff) ||
          !integer(settlement.x, 0, state.worldWidth - 1) ||
          !integer(settlement.y, 0, state.worldHeight - 1) ||
          !integer(settlement.population, 0, 0xffffffff) ||
          !['name', 'region', 'level', 'sourceFaction'].every(
            (key) => typeof settlement[key] === 'string' && settlement[key].length <= 512
          ) ||
          !Array.isArray(settlement.buildings) ||
          settlement.buildings.length > 1024 ||
          settlement.buildings.some(
            (building) =>
              !building ||
              !Array.isArray(building.source) ||
              building.source.length > 1024 ||
              building.source.some(
                (row) => !row || typeof row.text !== 'string' || row.text.length > 4096
              )
          )
        )
          throw TypeError('Invalid HUD settlement inspection');
        if (fog && !fog.actorVisible(settlement.x, settlement.y)) settlement = null;
      }
      if (state.canMenu !== undefined && typeof state.canMenu !== 'boolean')
        throw TypeError('Invalid HUD menu state');
      for (const key of ['canSelect', 'canContinue', 'canEndTurn', 'canCenter'])
        if (typeof state[key] !== 'boolean') throw TypeError('Invalid HUD control state');
      const rows = army?.rows ?? [];
      if (!Array.isArray(rows) || rows.length > 256) throw TypeError('Invalid HUD army rows');
      rows.forEach((row, i) => {
        if (
          !row ||
          row.sourceArmyIndex !== i ||
          typeof row.name !== 'string' ||
          row.name.length > 512 ||
          (row.count !== null && row.count !== undefined && !integer(row.count, 0, 0xffffffff))
        )
          throw TypeError('Invalid HUD army source row');
      });
      const mini = state.minimap;
      if (
        mini &&
        (!integer(mini.width, 1, 1024) ||
          !integer(mini.height, 1, 1024) ||
          !(mini.rgba instanceof Uint8Array || mini.rgba instanceof Uint8ClampedArray) ||
          !(mini.rgba.buffer instanceof ArrayBuffer) ||
          mini.rgba.length !== mini.width * mini.height * 4)
      )
        throw TypeError('Invalid HUD minimap');
      if (mini?.detail && (
          !integer(mini.detail.width, 1, 1024) || !integer(mini.detail.height, 1, 1024) ||
          !(mini.detail.rgba instanceof Uint8Array || mini.detail.rgba instanceof Uint8ClampedArray) ||
          !(mini.detail.rgba.buffer instanceof ArrayBuffer) ||
          mini.detail.rgba.length !== mini.detail.width * mini.detail.height * 4))
        throw TypeError('Invalid HUD minimap detail');
      const footprint = state.cameraFootprint ?? state.mapCamera?.footprint ?? [];
      if (!Array.isArray(footprint) || footprint.length > 32 || footprint.some((p) =>
          !p || !Number.isFinite(p.x) || !Number.isFinite(p.y) ||
          Math.abs(p.x) > 65536 || Math.abs(p.y) > 65536))
        throw TypeError('Invalid HUD camera footprint');
      const canMapControl = state.canNavigate ?? state.canMenu ?? state.canSelect,
        canNavigate = Boolean(onMapNavigate) && (state.canNavigate ?? false);
      if (typeof canMapControl !== 'boolean' ||
          (state.canNavigate !== undefined && typeof state.canNavigate !== 'boolean'))
        throw TypeError('Invalid HUD map navigation state');
      const options = document.createDocumentFragment(),
        empty = element('option', '', 'Select character');
      empty.value = '';
      empty.disabled = true;
      options.append(empty);
      for (const c of characters) {
        const o = element('option', '', c.name);
        o.value = String(c.id);
        options.append(o);
      }
      const humanize = humanizeHud;
      const nextRosterKey = JSON.stringify([selectedId, army?.faction, rows]);
      if (nextRosterKey !== rosterKey) {
        const items = document.createDocumentFragment(),
          nextTextOwners = [];
        const rowText = (node, text, maxWidth = 58, color) => {
          const owner = textLabel(node, text, maxWidth, color);
          nextTextOwners.push(owner);
        };
        for (const row of rows) {
          const li = element('li'),
            name = element('strong', 'hud-unit-name'),
            label = campaignHudUnitLabel(row),
            lines = [''];
          const captionWidth = (text) => {
            try {
              return calendarFont ? measureCufText(calendarFont, text) : text.length * 6;
            } catch {
              return text.length * 6;
            }
          };
          for (const word of label.split(/\s+/)) {
            const i = lines.length - 1,
              next = lines[i] ? lines[i] + ' ' + word : word;
            if (!lines[i] || captionWidth(next) <= 70 || lines.length === 2) lines[i] = next;
            else lines.push(word);
          }
          for (let i = 0; i < lines.length; i++) {
            const line = element('span', 'hud-unit-name-line');
            rowText(line, lines[i] + (i < lines.length - 1 ? ' ' : ''), 70);
            name.append(line);
          }
          name.title = label;
          li.append(name);
          const dictionary = row.unitDefinition?.dictionary,
            art =
              army?.faction === 'romans_julii' && typeof dictionary === 'string'
                ? unitCardArt.get(dictionary)
                : null;
          li.dataset.hudUnitCard = art ? 'original' : 'text-fallback';
          li.dataset.dictionary = typeof dictionary === 'string' ? dictionary : '';
          li.dataset.sourceRow = String(row.sourceArmyIndex);
          li.dataset.actorId = String(selectedId);
          if (art) {
            li.className = 'hud-original-card';
            li.dataset.sourceSha = art.sourceSha256;
            li.dataset.rgbaHash = art.rgbaSha256;
            const image = element('img', 'hud-unit-picture');
            image.dataset.hudUnitCardImage = '';
            image.src = art.url;
            image.width = 48;
            image.height = 64;
            image.alt = label;
            li.append(image);
          }
          const countInfo = campaignHudUnitCount(row);
          li.dataset.countSource = countInfo.badge ? 'campaign' : 'unavailable';
          li.setAttribute(
            'aria-label',
            label + (countInfo.badge ? ': ' + countInfo.description : '')
          );
          li.title = `${label}\n${countInfo.description}: ${countInfo.detail}`;
          if (countInfo.badge) {
            const count = element('span', 'hud-unit-count');
            count.style.whiteSpace = 'nowrap';
            count.title = countInfo.detail;
            rowText(count, countInfo.badge);
            li.append(count);
          }
          const definition = row.unitDefinition,
            kind = [definition?.category, definition?.unitClass]
              .filter((v) => typeof v === 'string' && v.length <= 128 && v.trim())
              .map(humanize)
              .join(' · ');
          if (kind) {
            const meta = element('span', 'hud-unit-kind', kind);
            meta.title = kind;
            if (!art) rowText(meta, kind, 58, [105, 87, 62]);
            li.append(meta);
          }
          items.append(li);
        }
        if (!rows.length) {
          const empty = element('li', 'hud-empty'),
            copy = element('span');
          rowText(
            copy,
            selectedId === null
              ? 'Select an army'
              : 'No army',
            400,
            [106, 89, 66]
          );
          empty.append(copy);
          items.append(empty);
        }
        roster.replaceChildren(items);
        for (const owner of rosterTextOwners) {
          owner.dispose();
          textOwners.delete(owner);
        }
        rosterTextOwners = nextTextOwners;
        rosterKey = nextRosterKey;
      }
      const chosen = characters.find((c) => c.id === selectedId);
      const nextContextIdentity = chosen
        ? `actor:${chosen.id}`
        : settlement
          ? `town:${settlement.id}`
          : 'none';
      if (nextContextIdentity !== contextIdentity) {
        activeTab = settlement ? 'town' : 'army';
        contextIdentity = nextContextIdentity;
      }
      for (const b of tabButtons) {
        const key = b.dataset.hudTab,
          available = key === 'army' ? Boolean(chosen) : key === 'passengers' ? false : Boolean(settlement),
          selected = available && key === activeTab;
        b.disabled = !available;
        b.setAttribute('aria-selected', String(selected));
        b.tabIndex = selected ? 0 : -1;
        paintTab(b, selected);
      }
      const showingArmy = Boolean(chosen) && activeTab === 'army';
      roster.hidden = !showingArmy;
      settlementView.hidden = showingArmy || activeTab === 'buildings';
      buildingsView.hidden = !settlement || activeTab !== 'buildings';
      if (buildingView) buildingView.update({ settlement, disabled: !state.canSelect });
      const nextSettlementKey = JSON.stringify([nextContextIdentity, settlement]);
      if (nextSettlementKey !== settlementKey) {
        settlementView.replaceChildren();
        if (!buildingView) buildingsView.replaceChildren();
        if (settlement) {
          const details = element('div', 'hud-town-details'),
            summary = element('div', 'hud-town-summary');
          details.append(
            element('p', '', humanize(settlement.level)),
            element('p', '', `Population ${settlement.population.toLocaleString('en-US')}`),
            element('p', '', `${settlement.buildings.length} buildings`)
          );
          summary.append(
            element('p', '', humanize(settlement.sourceFaction).replace(/^Romans /, ''))
          );
          settlementView.append(details, summary);
          for (const building of buildingView ? [] : settlement.buildings) {
            const label = campaignHudBuildingLabel(building),
              item = element('li');
            item.append(element('strong', '', label.name), element('small', '', label.group));
            buildingsView.append(item);
          }
          if (!buildingView && !settlement.buildings.length)
            buildingsView.append(element('li', '', 'No buildings'));
        }
        settlementKey = nextSettlementKey;
      }
      select.replaceChildren(options);
      select.value = selectedId === null ? '' : String(selectedId);
      select.disabled = !state.canSelect;
      previous.disabled = nextCharacter.disabled = !state.canSelect || characters.length < 2;
      selectorLabelText.set(chosen?.name ?? settlement?.name ?? '');
      selectedNameText.set(
        chosen ? chosen.name : settlement ? settlement.name : ''
      );
      selectedName.title = chosen?.name ?? settlement?.name ?? '';
      actionPointsText.set(chosen ? `${chosen.actionPoints} AP` : '');
      actionPoints.title = chosen ? `${chosen.actionPoints} action points` : '';
      select.dataset.font = 'fallback';
      armyTitleText.set(
        chosen
          ? ''
          : settlement
            ? activeTab === 'buildings'
              ? 'Buildings'
              : 'Settlement'
            : ''
      );
      armyCountText.set(chosen ? `${rows.length} ${rows.length === 1 ? 'unit' : 'units'}` : '');
      armyTitle.hidden = !settlement;
      armyCount.hidden = !chosen;
      continueButton.title = chosen
        ? 'Continue the selected character journey'
        : 'Select a character with a planned journey';
      center.title = chosen
        ? 'Center the map on the selected character'
        : 'Select a character to center the map';
      menu.title = 'Campaign menu · WASD / arrows to pan · scroll to zoom';
      updateCalendar(state.calendar);
      const treasuryLabel = Number.isSafeInteger(state.initialTreasury)
        ? String(state.initialTreasury)
        : state.initialTreasury;
      const hasTreasury = treasuryLabel !== undefined && treasuryLabel !== null;
      if (hasTreasury && (typeof treasuryLabel !== 'string' || !/^[+-]?\d{1,20}$/.test(treasuryLabel)))
        throw TypeError('Invalid HUD initial treasury');
      treasuryText.set(treasuryLabel ?? '');
      treasury.title = 'Starting treasury';
      cashIcon.hidden = !hasTreasury;
      continueButton.hidden = Boolean(settlement);
      buildingPreview.hidden = !settlement;
      buildingPreview.disabled = !state.canSelect || !settlement ||
        (!onProduction && !settlement.buildings.length);
      continueButton.disabled = !state.canContinue || hiddenSelection;
      end.disabled = !state.canEndTurn;
      center.disabled = !state.canCenter || hiddenSelection;
      menu.disabled = !(state.canMenu ?? state.canSelect);
      mapContext.fillStyle = '#2b241b';
      mapContext.fillRect(0, 0, map.width, map.height);
      let mapView = { x: 4, y: 4, width: map.width - 8, height: map.height - 8 };
      const focus = chosen ?? settlement;
      const nextFrameKey = JSON.stringify([
        mapModeValue,
        state.worldWidth,
        state.worldHeight,
        fog?.maskRevision,
        fog?.enabled,
        map.width,
        map.height,
        focus?.x,
        focus?.y,
      ]);
      if (frameKey !== nextFrameKey || minimapFrame?.fog !== fog) {
        minimapFrame = {
          ...campaignHudMinimapFrame({
            worldWidth: state.worldWidth,
            worldHeight: state.worldHeight,
            fog,
            mode: mapModeValue,
            aspect: mapView.width / mapView.height,
            focus: focus ? { x: focus.x, y: focus.y } : null,
          }),
          fog,
        };
        frameKey = nextFrameKey;
      }
      const frame = minimapFrame;
      if (mini) {
        const raster = frame.width < state.worldWidth && mini.detail ? mini.detail : mini;
        const scale = Math.min(mapView.width / frame.width, mapView.height / frame.height),
          width = frame.width * scale,
          height = frame.height * scale;
        mapView = { x: (map.width - width) / 2, y: (map.height - height) / 2, width, height };
        if (
          uploadedMap !== raster.rgba ||
          mapSource.width !== raster.width ||
          mapSource.height !== raster.height
        ) {
          mapSource.width = raster.width;
          mapSource.height = raster.height;
          mapSource
            .getContext('2d')
            .putImageData(
              new ImageData(new Uint8ClampedArray(raster.rgba), raster.width, raster.height),
              0,
              0
            );
          uploadedMap = raster.rgba;
        }
        const source = {
          x: (frame.x / state.worldWidth) * raster.width,
          y: (1 - (frame.y + frame.height) / state.worldHeight) * raster.height,
          width: (frame.width / state.worldWidth) * raster.width,
          height: (frame.height / state.worldHeight) * raster.height,
        };
        mapContext.imageSmoothingEnabled = false;
        mapContext.drawImage(
          mapSource,
          source.x,
          source.y,
          source.width,
          source.height,
          mapView.x,
          mapView.y,
          width,
          height
        );
      } else {
        mapContext.font = '12px system-ui';
        mapContext.fillStyle = '#e9dbbd';
        mapContext.fillText('Map overview unavailable', 8, 18);
      }
      fogMask.draw(mapContext, fog, {
        ...mapView,
        source: fog
          ? {
              x: (frame.x / state.worldWidth) * fog.width,
              y: (1 - (frame.y + frame.height) / state.worldHeight) * fog.height,
              width: (frame.width / state.worldWidth) * fog.width,
              height: (frame.height / state.worldHeight) * fog.height,
            }
          : null,
      });
      for (const c of characters) {
        mapContext.fillStyle = c.id === selectedId ? '#ffdd38' : '#9d2020';
        const fx = (c.x + 0.5 - frame.x) / frame.width,
          fy = (c.y + 0.5 - frame.y) / frame.height;
        if (fx < 0 || fx >= 1 || fy < 0 || fy >= 1) continue;
        const px = mapView.x + fx * mapView.width,
          py = mapView.y + (1 - fy) * mapView.height;
        mapContext.fillStyle = '#f4e4bb';
        mapContext.fillRect(
          Math.round(px) - 2,
          Math.round(py) - 2,
          c.id === selectedId ? 6 : 4,
          c.id === selectedId ? 6 : 4
        );
        mapContext.fillStyle = c.id === selectedId ? '#ffdd38' : '#9d2020';
        mapContext.fillRect(
          Math.round(px) - 1,
          Math.round(py) - 1,
          c.id === selectedId ? 4 : 2,
          c.id === selectedId ? 4 : 2
        );
      }
      if (settlement) {
        const px = mapView.x + ((settlement.x + 0.5 - frame.x) / frame.width) * mapView.width,
          py = mapView.y + (1 - (settlement.y + 0.5 - frame.y) / frame.height) * mapView.height;
        mapContext.fillStyle = '#f4e4bb';
        mapContext.fillRect(Math.round(px) - 3, Math.round(py) - 3, 7, 7);
        mapContext.fillStyle = '#ffdd38';
        mapContext.fillRect(Math.round(px) - 2, Math.round(py) - 2, 5, 5);
      }
      if (footprint.length >= 3) {
        mapContext.save();
        try {
          mapContext.beginPath();
          mapContext.rect(mapView.x, mapView.y, mapView.width, mapView.height);
          mapContext.clip();
          mapContext.beginPath();
          for (let i = 0; i < footprint.length; i++) {
            const p = footprint[i],
              x = mapView.x + ((p.x - frame.x) / frame.width) * mapView.width,
              y = mapView.y + (1 - (p.y - frame.y) / frame.height) * mapView.height;
            if (i === 0) mapContext.moveTo(x, y);
            else mapContext.lineTo(x, y);
          }
          mapContext.closePath();
          mapContext.strokeStyle = '#ed2424';
          mapContext.lineWidth = 1.5;
          mapContext.stroke();
        } finally {
          mapContext.restore();
        }
      }
      navigationView = { view: mapView, frame, worldWidth: state.worldWidth, worldHeight: state.worldHeight };
      if (footprint.length) keyboardCell = {
        x: Math.max(0, Math.min(state.worldWidth - 1, Math.floor(footprint.reduce((sum, p) => sum + p.x, 0) / footprint.length))),
        y: Math.max(0, Math.min(state.worldHeight - 1, Math.floor(footprint.reduce((sum, p) => sum + p.y, 0) / footprint.length))),
      };
      map.tabIndex = canNavigate ? 0 : -1;
      map.setAttribute('role', onMapNavigate ? 'button' : 'img');
      map.setAttribute('aria-disabled', String(!canNavigate));
      map.setAttribute('aria-keyshortcuts', 'ArrowUp ArrowDown ArrowLeft ArrowRight Enter Space');
      map.title = onMapNavigate ? 'Click to move the camera. Arrow keys pan; Shift pans faster.' : 'Campaign map, north up';
      mapMode.disabled = !canMapControl;
      paint(mapContext, 'RADAR_HORIZONTAL_SIDE', 0, 0, map.width, 3);
      paint(mapContext, 'RADAR_HORIZONTAL_SIDE', 0, map.height - 3, map.width, 3);
      paint(mapContext, 'RADAR_VERTICAL_SIDE', 0, 0, 3, map.height);
      paint(mapContext, 'RADAR_VERTICAL_SIDE', map.width - 3, 0, 3, map.height);
      for (const [x, y] of [
        [0, 0],
        [map.width - 3, 0],
        [0, map.height - 3],
        [map.width - 3, map.height - 3],
      ])
        paint(mapContext, 'RADAR_CORNER_PIECE', x, y, 3, 3);
      const regional = frame.scope === 'selection';
      mapTitleText.set(
        regional ? 'Regional map' : frame.mode === 'local' ? 'Explored map' : 'Campaign map'
      );
      mapModeText.set(mapModeValue === 'local' ? 'World' : 'Local');
      mapModeIcon.width = mapModeIcon.width;
      paint(mapModeIcon.getContext('2d'), mapModeValue === 'world' ? 'RADAR_BUTTON_PLUS' : 'RADAR_BUTTON_MINUS', 0, 0);
      mapMode.setAttribute(
        'aria-label',
        mapModeValue === 'local'
          ? 'Show whole campaign map'
          : focus
            ? 'Show selected region'
            : 'Frame explored territory'
      );
      map.setAttribute(
        'aria-label',
        `${regional ? 'Selected region' : frame.mode === 'local' ? 'Explored territory' : 'Whole campaign'} map, north up. Yellow marks the current selection.`
      );
      mount.dataset.minimapFrame = JSON.stringify({
        mode: frame.mode,
        scope: regional ? 'selection' : frame.mode === 'local' ? 'explored' : 'world',
        x: frame.x,
        y: frame.y,
        width: frame.width,
        height: frame.height,
        worldWidth: state.worldWidth,
        worldHeight: state.worldHeight,
      });
      last = {
        characters,
        canMapControl,
        canNavigate,
        canSelect: state.canSelect,
        canMenu: state.canMenu ?? state.canSelect,
        canContinue: state.canContinue && !hiddenSelection,
        canEndTurn: state.canEndTurn,
        canCenter: state.canCenter && !hiddenSelection,
      };
      if (fog)
        mount.dataset.fog = JSON.stringify({
          enabled: fog.enabled,
          maskRevision: fog.maskRevision,
          visibleCharacters: characters.length,
          ...fog.counts,
          minimapPolicy: 'public-base-geography;unseen-alpha96-black;remembered-alpha64-black;objects-current-sight',
        });
      else delete mount.dataset.fog;
      mount.dataset.selectedId = selectedId === null ? '' : String(selectedId);
      mount.dataset.selectedSettlementId = settlement ? String(settlement.id) : '';
      mount.dataset.inspection = settlement ? activeTab : chosen ? 'army' : 'overview';
      mount.dataset.sourceSprites = JSON.stringify([...used]);
      lastInput = state;
      return true;
    }
    for (const control of [select, continueButton, end, center, menu]) control.disabled = true;
    requireLive();
    mount.append(host);
    fit();
    mount.dataset.sourceSprites = JSON.stringify([...used]);
    mount.dataset.layoutSha256 = layoutHash;
    mount.dataset.textureHashes = JSON.stringify(hashes);
    mount.dataset.sharedLayoutSha256 = sharedLayoutHash;
    mount.dataset.sharedTextureHashes = JSON.stringify(sharedTextureHashes);
    mount.dataset.sharedSourceSprites = JSON.stringify([
      {
        name: background.name,
        ordinal: background.ordinal,
        page: background.page,
        x0: background.x0,
        x1: background.x1,
        y0: background.y0,
        y1: background.y1,
      },
      ...buttonParts.map((s) => ({
        name: s.name, ordinal: s.ordinal, page: s.page,
        x0: s.x0, x1: s.x1, y0: s.y0, y1: s.y1,
      })),
    ]);
    mount.dataset.unitCardSources = JSON.stringify(cardSources);
    mount.dataset.unitCardAlphaPolicy = 'literal-source-rgba-canvas-source-over-candidate';
    mount.dataset.ready = 'true';
    return {
      update,
      createTextLabel(node, maxWidth = 1024, color = [0, 0, 0]) {
        if (!live()) return null;
        const owner = textLabel(node, node.textContent ?? '', maxWidth, color);
        let closed = false;
        return Object.freeze({
          set(text) {
            return !closed && live() ? owner.set(text) : false;
          },
          dispose() {
            if (closed) return;
            closed = true;
            owner.dispose();
            textOwners.delete(owner);
          },
        });
      },
      setCursor(state) {
        if (!live()) return false;
        return cursorOwner?.setState(state) ?? false;
      },
      cursorStatus() {
        return live() && cursorOwner ? cursorOwner.status() : null;
      },
      dispose,
    };
  } catch (error) {
    try {
      dispose();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Campaign HUD initialization and cleanup failed'
      );
    }
    throw error;
  }
}
