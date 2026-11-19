// Source names/coordinates only. Yellow type, offset and clipping are an
// OpenRTW presentation policy, not recovered native font/visibility rules.
export const settlementLabelPolicy = Object.freeze({
  id: 'openrtw-source-settlement-labels-v1',
  name: 'descr_regions.field2-verbatim',
  anchor: 'unique-source-region-rgb-black-marker;world-y=height-1-image-y',
  visibility: 'projectCell-frustum-and-depth;canvas-content-box-clip',
  terrainOcclusion: false,
  currentOwnership: false,
  offsetCssPixels: 8,
});
const integer = (value, max) => Number.isInteger(value) && value >= 0 && value <= max;
const identifier = (value) =>
  typeof value === 'string' && value.length <= 1024 && /^[A-Za-z_][A-Za-z_0-9]*$/.test(value);
const line = (value) => Number.isSafeInteger(value) && value > 0;
const rgb = (value) =>
  Array.isArray(value) && value.length === 3 && value.every((v) => integer(v, 255));
const colorKey = (value) => value[0] * 65536 + value[1] * 256 + value[2];
const fail = () => {
  throw new Error('Settlement label source/region/black-marker binding differs');
};

/** Pure, owned source join in campaign faction/settlement encounter order.
 * Region identity, definition RGB, palette entry and raw black marker must
 * each be unique. Names are exact field2 strings, never localized/humanized.
 * sourceSection records provenance only; neither it nor factionCreator is
 * interpreted as current ownership. No settlement model/level is selected.
 */
export function buildSettlementLabelBindings(campaign, regionData, world, worldIndices) {
  if (
    !Array.isArray(campaign?.factions) ||
    campaign.factions.length > 4096 ||
    !Array.isArray(regionData?.definitions) ||
    regionData.definitions.length > 4096 ||
    !Array.isArray(world?.palette) ||
    world.palette.length > 4096 ||
    !Array.isArray(world.markers) ||
    world.markers.length > 100000 ||
    !integer(world.width, 4096) ||
    !world.width ||
    !integer(world.height, 4096) ||
    !world.height ||
    !Array.isArray(worldIndices) ||
    worldIndices.length !== world.width * world.height
  )
    fail();
  const definitions = new Map(),
    definitionColors = new Set(),
    palette = new Map(),
    markers = new Map();
  for (const row of regionData.definitions) {
    if (!identifier(row?.id) || !identifier(row.field2) || !line(row.line) || !rgb(row.rgb)) fail();
    const key = colorKey(row.rgb);
    if (definitions.has(row.id) || definitionColors.has(key)) fail();
    definitions.set(row.id, row);
    definitionColors.add(key);
  }
  for (let i = 0; i < world.palette.length; i++) {
    const color = world.palette[i];
    if (!rgb(color)) fail();
    const key = colorKey(color);
    if (palette.has(key)) fail();
    palette.set(key, i);
  }
  for (const marker of world.markers)
    if (marker?.rawKind === 'black') {
      if (!integer(marker.regionIndex, world.palette.length - 1)) fail();
      const matches = markers.get(marker.regionIndex) ?? [];
      matches.push(marker);
      markers.set(marker.regionIndex, matches);
    }
  const regions = new Set(),
    sections = new Set(),
    result = [];
  for (const faction of campaign.factions) {
    if (
      !identifier(faction?.id) ||
      sections.has(faction.id) ||
      !Array.isArray(faction.settlements) ||
      faction.settlements.length > 4096 - result.length
    )
      fail();
    sections.add(faction.id);
    for (const settlement of faction.settlements) {
      if (
        !identifier(settlement?.region) ||
        !line(settlement.line) ||
        regions.has(settlement.region)
      )
        fail();
      regions.add(settlement.region);
      const definition = definitions.get(settlement.region);
      if (!definition) fail();
      const regionIndex = palette.get(colorKey(definition.rgb)),
        matches = markers.get(regionIndex);
      if (regionIndex === undefined || matches?.length !== 1) fail();
      const marker = matches[0];
      if (
        marker.coordinateWritten !== true ||
        !integer(marker.imageX, world.width - 1) ||
        !integer(marker.imageY, world.height - 1) ||
        marker.worldX !== marker.imageX ||
        marker.worldY !== world.height - 1 - marker.imageY ||
        worldIndices[marker.worldY * world.width + marker.worldX] !== regionIndex
      )
        fail();
      result.push(
        Object.freeze({
          region: settlement.region,
          name: definition.field2,
          x: marker.worldX,
          y: marker.worldY,
          sourceLine: settlement.line,
          definitionLine: definition.line,
          sourceSection: faction.id,
        })
      );
    }
  }
  return Object.freeze(result);
}

/** Owns one pointer-transparent overlay in an already positioned canvas parent.
 * update(scene) runs after scene.draw(), using its last presented projectCell.
 * Canvas/parent must have no CSS transform; backing/CSS sizes and borders may
 * differ. No observers, events, RAF, GPU resources or campaign commands owned.
 * hide/dispose are idempotent; update after disposal does nothing.
 */
export function createSettlementLabels({ canvas, bindings }) {
  const parent = canvas?.parentElement,
    document = canvas?.ownerDocument,
    view = document?.defaultView;
  if (
    !parent ||
    !document ||
    typeof view?.getComputedStyle !== 'function' ||
    !Array.isArray(bindings) ||
    bindings.length > 4096
  )
    throw new TypeError('Invalid settlement label overlay inputs');
  if (!['relative', 'absolute', 'fixed', 'sticky'].includes(view.getComputedStyle(parent).position))
    throw new TypeError('Settlement label canvas parent must be positioned');
  const seen = new Set(),
    owned = bindings.map((row) => {
      if (
        !identifier(row?.region) ||
        !identifier(row.name) ||
        seen.has(row.region) ||
        !integer(row.x, 4095) ||
        !integer(row.y, 4095) ||
        !line(row.sourceLine) ||
        !line(row.definitionLine) ||
        !identifier(row.sourceSection)
      )
        fail();
      seen.add(row.region);
      return Object.freeze({
        region: row.region,
        name: row.name,
        x: row.x,
        y: row.y,
        sourceLine: row.sourceLine,
        definitionLine: row.definitionLine,
        sourceSection: row.sourceSection,
      });
    });
  const root = document.createElement('div'),
    elements = [];
  root.className = 'openrtw-settlement-labels';
  root.dataset.settlementLabels = 'true';
  root.dataset.policy = settlementLabelPolicy.id;
  root.dataset.count = String(owned.length);
  root.dataset.visibleCount = '0';
  root.setAttribute('aria-hidden', 'true');
  root.hidden = true;
  Object.assign(root.style, {
    position: 'absolute',
    pointerEvents: 'none',
    overflow: 'hidden',
    zIndex: '1',
    display: 'none',
    margin: '0',
    padding: '0',
    border: '0',
  });
  try {
    for (const row of owned) {
      const element = document.createElement('span');
      element.textContent = row.name;
      element.title = `${row.name} · ${row.region}`;
      Object.assign(element.dataset, {
        region: row.region,
        name: row.name,
        x: String(row.x),
        y: String(row.y),
        sourceLine: String(row.sourceLine),
        definitionLine: String(row.definitionLine),
        sourceSection: row.sourceSection,
      });
      Object.assign(element.style, {
        position: 'absolute',
        pointerEvents: 'none',
        display: 'none',
        whiteSpace: 'nowrap',
        margin: '0',
        padding: '0',
        border: '0',
        font: '600 13px/1.2 Georgia, "Times New Roman", serif',
        color: '#ffe467',
        textShadow: '0 1px 2px #000, 1px 0 2px #000, -1px 0 2px #000',
        transform: 'translate(-50%, -100%)',
      });
      element.hidden = true;
      root.appendChild(element);
      elements.push(element);
    }
    parent.appendChild(root);
  } catch (error) {
    root.remove();
    throw error;
  }
  let disposed = false;
  function hide() {
    root.hidden = true;
    root.style.display = 'none';
    root.dataset.visibleCount = '0';
    for (const element of elements) {
      element.hidden = true;
      element.style.display = 'none';
    }
  }
  function update(scene, fog = null) {
    if (disposed) return 0;
    if (typeof scene?.projectCell !== 'function') {
      hide();
      throw new TypeError('Settlement labels require scene.projectCell');
    }
    if (fog !== null && typeof fog?.labelVisible !== 'function') {
      hide();
      throw new TypeError('Settlement labels require fog.labelVisible');
    }
    if (canvas.parentElement !== parent) {
      hide();
      return 0;
    }
    const rect = canvas.getBoundingClientRect(),
      parentRect = parent.getBoundingClientRect(),
      style = view.getComputedStyle(canvas);
    const css = (value) => {
      const n = Number.parseFloat(value);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    };
    const left = css(style.borderLeftWidth) + css(style.paddingLeft),
      right = css(style.borderRightWidth) + css(style.paddingRight),
      top = css(style.borderTopWidth) + css(style.paddingTop),
      bottom = css(style.borderBottomWidth) + css(style.paddingBottom);
    const width = rect.width - left - right,
      height = rect.height - top - bottom;
    if (
      !integer(canvas.width, 16384) ||
      !canvas.width ||
      !integer(canvas.height, 16384) ||
      !canvas.height ||
      ![rect.left, rect.top, parentRect.left, parentRect.top, width, height].every(
        Number.isFinite
      ) ||
      width <= 0 ||
      height <= 0
    ) {
      hide();
      return 0;
    }
    // Absolute child coordinates use the parent's padding box and scroll origin.
    const x = rect.left + left - parentRect.left - parent.clientLeft + parent.scrollLeft,
      y = rect.top + top - parentRect.top - parent.clientTop + parent.scrollTop;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      hide();
      return 0;
    }
    // Stage all queries before publishing positions; a failed query leaves hidden.
    let positions;
    try {
      positions = owned.map((row) => {
        // B001BC: labels need current sight (byte >= 2), not remembered land.
        if (fog !== null && fog.labelVisible(row.x, row.y) !== true) return null;
        const p = scene.projectCell(row.x, row.y);
        if (
          p?.visible !== true ||
          ![p.px, p.py, p.depth].every(Number.isFinite) ||
          p.depth < 0 ||
          p.depth > 1 ||
          p.px < 0 ||
          p.py < 0 ||
          p.px >= canvas.width ||
          p.py >= canvas.height
        )
          return null;
        return {
          left: (p.px * width) / canvas.width,
          top: (p.py * height) / canvas.height - settlementLabelPolicy.offsetCssPixels,
        };
      });
    } catch (error) {
      hide();
      throw error;
    }
    Object.assign(root.style, {
      left: `${x}px`,
      top: `${y}px`,
      width: `${width}px`,
      height: `${height}px`,
    });
    let count = 0;
    positions.forEach((p, i) => {
      const element = elements[i];
      if (!p) {
        element.hidden = true;
        element.style.display = 'none';
        return;
      }
      element.style.left = `${p.left}px`;
      element.style.top = `${p.top}px`;
      element.hidden = false;
      element.style.display = 'block';
      count++;
    });
    root.dataset.visibleCount = String(count);
    root.hidden = count === 0;
    root.style.display = count ? 'block' : 'none';
    return count;
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    hide();
    root.remove();
    elements.length = 0;
  }
  return Object.freeze({ update, hide, dispose });
}
