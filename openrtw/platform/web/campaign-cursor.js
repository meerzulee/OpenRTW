// Native action-to-art table: CCD82F -> CCCD0F -> CCA4B2. BAFC1F copies
// the RSD tail hotspot, subtracted at CCAEDF..CCAEF9 before cursor drawing.
// The caller selects supported actions; this owner only presents source art.
const policy = 'openrtw-campaign-cursor-presentation-v2';
const definitions = Object.freeze({
  select: { sprite: 'CURSOR_SELECT', ordinal: 11, rect: [175, 52, 198, 80], hotspot: [1, 2] },
  selectable: {
    sprite: 'CURSOR_COHORT_INFO',
    ordinal: 12,
    rect: [200, 52, 224, 88],
    hotspot: [2, 2],
  },
  move: { sprite: 'CURSOR_WALK', ordinal: 10, rect: [218, 0, 255, 33], hotspot: [15, 7] },
  blocked: { sprite: 'CURSOR_NO_MOVE', ordinal: 66, rect: [205, 90, 227, 112], hotspot: [12, 10] },
});
const states = new Set([
  'select',
  'selectable',
  'inspect',
  'move',
  'blocked',
  'attack-unavailable',
  'drag',
  'busy',
]);
const keys = [
  'campaignCursorPolicy',
  'campaignCursorSource',
  'campaignCursorSprite',
  'campaignCursorHotspot',
  'campaignCursorHotspotNativeProved',
  'campaignCursorState',
  'campaignCursorResolvedState',
  'campaignCursorFallbackReason',
];
const activeTargets = new WeakSet();
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function validate(target, layout, atlases) {
  if (
    !target?.style ||
    !target.dataset ||
    !['getPropertyValue', 'getPropertyPriority', 'setProperty', 'removeProperty'].every(
      (key) => typeof target.style[key] === 'function'
    ) ||
    typeof target.ownerDocument?.createElement !== 'function'
  )
    throw TypeError('Invalid campaign cursor target');
  if (
    layout?.version !== 5 ||
    layout.collection !== 'SHARED_SPRITES' ||
    layout.sourceBytes !== 55161 ||
    layout.exactEof !== true ||
    !Array.isArray(layout.pages) ||
    layout.pages.length !== 2 ||
    !Array.isArray(layout.sprites) ||
    layout.sprites.length > 4096 ||
    !Array.isArray(atlases) ||
    atlases.length !== 2
  )
    throw TypeError('Invalid campaign cursor layout');
}

function crop(target, layout, atlases, definition) {
  const matches = layout.sprites.filter((sprite) => sprite?.name === definition.sprite),
    sprite = matches[0];
  const [x0, y0, x1, y1] = definition.rect,
    [hx, hy] = definition.hotspot;
  const width = x1 - x0 + 1,
    height = y1 - y0 + 1,
    page = layout.pages[0],
    atlas = atlases[0];
  if (
    matches.length !== 1 ||
    sprite.ordinal !== definition.ordinal ||
    sprite.page !== 0 ||
    sprite.x0 !== x0 ||
    sprite.y0 !== y0 ||
    sprite.x1 !== x1 ||
    sprite.y1 !== y1 ||
    sprite.width !== width ||
    sprite.height !== height ||
    !Array.isArray(sprite.unknownU16) ||
    sprite.unknownU16.length !== 3 ||
    [0, 1, 2].some((i) => sprite.unknownU16[i] !== [257, hx, hy][i]) ||
    page?.index !== 0 ||
    page.texture !== 'sharedpage_01.tga' ||
    page.width !== 512 ||
    page.height !== 512 ||
    atlas?.width !== 512 ||
    atlas.height !== 512 ||
    typeof atlas.getContext !== 'function'
  )
    throw TypeError('Unsupported original cursor source: ' + definition.sprite);
  const canvas = target.ownerDocument.createElement('canvas');
  try {
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (
      !context ||
      typeof context.drawImage !== 'function' ||
      typeof canvas.toDataURL !== 'function'
    )
      throw Error('Cursor canvas unavailable');
    context.imageSmoothingEnabled = false;
    context.drawImage(atlas, x0, y0, width, height, 0, 0, width, height);
    const png = canvas.toDataURL('image/png');
    if (
      typeof png !== 'string' ||
      png.length > 16384 ||
      !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(png)
    )
      throw Error('Cursor PNG bound refused');
    const metadata = Object.freeze({
      schema: 'openrtw-campaign-cursor-v1',
      policy,
      source: 'SHARED_SPRITES/sharedpage_01.tga:' + definition.sprite,
      sprite: definition.sprite,
      sourceRect: Object.freeze([...definition.rect]),
      width,
      height,
      hotspot: Object.freeze([...definition.hotspot]),
      hotspotNativeProved: true,
    });
    return Object.freeze({ cursor: `url("${png}") ${hx} ${hy}, auto`, metadata });
  } finally {
    try {
      canvas.width = 0;
    } finally {
      canvas.height = 0;
    }
  }
}

/** Pre-encodes each admitted sprite once. Missing optional art keeps SELECT.
 * No listeners, requests, object URLs, frame timers or retained atlas surfaces.
 * Later external inline cursor replacements remain owned by their caller.
 */
export function createCampaignCursor({ target, layout, atlases }) {
  if (activeTargets.has(target)) throw Error('Campaign cursor target already owned');
  validate(target, layout, atlases);
  const art = new Map(),
    refused = new Map();
  for (const [state, definition] of Object.entries(definitions)) {
    try {
      art.set(state, crop(target, layout, atlases, definition));
    } catch (error) {
      if (state === 'select') throw error;
      refused.set(state, String(error.message).slice(0, 256));
    }
  }
  layout = atlases = null;
  const metadata = art.get('select').metadata;
  let before = {
    value: target.style.getPropertyValue('cursor'),
    priority: target.style.getPropertyPriority('cursor'),
    data: Object.fromEntries(
      keys.map((key) => [key, { present: own(target.dataset, key), value: target.dataset[key] }])
    ),
  };
  const priority = before.priority;
  let cursor = null,
    published = null,
    current = null,
    disposed = false;
  const ownsStyle = () =>
    target.style.getPropertyValue('cursor') === cursor &&
    target.style.getPropertyPriority('cursor') === priority;
  function resolve(name) {
    let resolved =
      name === 'inspect' ? 'selectable' : name === 'attack-unavailable' ? 'blocked' : name;
    let reason = null;
    if (resolved === 'drag' || resolved === 'busy') {
      reason = 'No admitted source art for this optional state';
      resolved = 'select';
    } else if (!art.has(resolved)) {
      reason = refused.get(resolved) ?? 'Optional source cursor is unavailable';
      resolved = 'select';
    }
    const value = art.get(resolved);
    return {
      value,
      status: Object.freeze({
        ...value.metadata,
        schema: 'openrtw-campaign-cursor-state-v1',
        requestedState: name,
        resolvedState: resolved,
        fallback: reason !== null,
        reason,
        applied: true,
        nativeActionSelectionProved: false,
        animated: false,
      }),
    };
  }
  function publish(name) {
    const { value, status } = resolve(name);
    const next = {
      campaignCursorPolicy: policy,
      campaignCursorSource: value.metadata.source,
      campaignCursorSprite: value.metadata.sprite,
      campaignCursorHotspot: value.metadata.hotspot.join(','),
      campaignCursorHotspotNativeProved: String(value.metadata.hotspotNativeProved),
      campaignCursorState: name,
      campaignCursorResolvedState: status.resolvedState,
      campaignCursorFallbackReason: status.reason ?? '',
    };
    const previousValue = target.style.getPropertyValue('cursor'),
      previousPriority = target.style.getPropertyPriority('cursor');
    const changed = [],
      nextPublished = { ...published };
    try {
      target.style.setProperty('cursor', value.cursor, priority);
      for (const key of keys)
        if (published === null || target.dataset[key] === published[key]) {
          changed.push([key, { present: own(target.dataset, key), value: target.dataset[key] }]);
          target.dataset[key] = next[key];
          nextPublished[key] = next[key];
        }
    } catch (error) {
      const failures = [];
      for (const [key, previous] of changed.reverse())
        try {
          if (target.dataset[key] === next[key]) {
            if (previous.present) target.dataset[key] = previous.value;
            else delete target.dataset[key];
          }
        } catch (rollback) {
          failures.push(rollback);
        }
      try {
        if (
          target.style.getPropertyValue('cursor') === value.cursor &&
          target.style.getPropertyPriority('cursor') === priority
        ) {
          if (previousValue) target.style.setProperty('cursor', previousValue, previousPriority);
          else target.style.removeProperty('cursor');
        }
      } catch (rollback) {
        failures.push(rollback);
      }
      if (failures.length)
        throw new AggregateError(
          [error, ...failures],
          'Campaign cursor publication and restoration failed'
        );
      throw error;
    }
    cursor = value.cursor;
    published = nextPublished;
    current = status;
    return status;
  }
  publish('select');
  activeTargets.add(target);
  return Object.freeze({
    metadata,
    setState(name) {
      if (disposed) throw Error('Campaign cursor is disposed');
      if (!states.has(name)) throw TypeError('Unsupported campaign cursor state');
      if (!ownsStyle())
        return Object.freeze({
          ...current,
          requestedState: name,
          applied: false,
          reason: 'External cursor style is active',
        });
      return current.requestedState === name ? current : publish(name);
    },
    status() {
      if (disposed) throw Error('Campaign cursor is disposed');
      return ownsStyle()
        ? current
        : Object.freeze({ ...current, applied: false, reason: 'External cursor style is active' });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      const errors = [];
      for (const key of keys)
        try {
          if (target.dataset[key] === published[key]) {
            if (before.data[key].present) target.dataset[key] = before.data[key].value;
            else delete target.dataset[key];
          }
        } catch (error) {
          errors.push(error);
        }
      try {
        if (ownsStyle()) {
          if (before.value) target.style.setProperty('cursor', before.value, before.priority);
          else target.style.removeProperty('cursor');
        }
      } catch (error) {
        errors.push(error);
      }
      activeTargets.delete(target);
      art.clear();
      refused.clear();
      cursor = before = published = current = target = null;
      if (errors.length) throw new AggregateError(errors, 'Campaign cursor restoration failed');
    },
  });
}
