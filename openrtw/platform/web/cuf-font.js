const fonts = new WeakMap();
const maxBytes = 4 * 1024 * 1024;
const maxText = 1024;
const maxExtent = 16384;

export function parseCufFont(input) {
  if (
    !(input instanceof Uint8Array) ||
    !(input.buffer instanceof ArrayBuffer) ||
    input.length < 32 + 65536 * 2 ||
    input.length > maxBytes
  )
    throw new TypeError('Invalid CUF input extent');
  const bytes = new Uint8Array(input),
    view = new DataView(bytes.buffer);
  if (view.getUint32(0, true) !== 0x30465543) throw new Error('Expected CUF0 signature');
  const glyphCount = view.getUint16(26, true),
    bitmapBytes = view.getUint32(28, true);
  const metricsAt = 32 + 65536 * 2,
    offsetsAt = metricsAt + glyphCount * 4;
  const bitmapAt = offsetsAt + glyphCount * 4;
  if (!glyphCount || bitmapAt + bitmapBytes !== bytes.length)
    throw new Error('Invalid CUF tables or bitmap extent');
  const lineHeight = view.getInt16(8, true),
    baseline = view.getInt16(14, true);
  const widthAdjustment = view.getInt16(20, true),
    pointSize = view.getUint16(6, true);
  // OpenRTW input policy, not native parser restrictions.
  if (
    lineHeight < 1 ||
    lineHeight > 512 ||
    Math.abs(baseline) > 512 ||
    Math.abs(widthAdjustment) > 512 ||
    !pointSize ||
    pointSize > 512
  )
    throw new Error('CUF dimensions exceed HUD policy');
  const mapping = new Uint16Array(65536),
    glyphs = [];
  for (let i = 0; i < mapping.length; i++) {
    const index = view.getUint16(32 + 2 * i, true);
    if (index !== 0xffff && index >= glyphCount) throw new Error('CUF mapping outside glyph table');
    mapping[i] = index;
  }
  for (let i = 0; i < glyphCount; i++) {
    const at = metricsAt + 4 * i,
      width = bytes[at + 2],
      height = bytes[at + 3];
    const offset = view.getUint32(offsetsAt + 4 * i, true);
    // Owned CUFs use 0x7fffffff for zero-area control glyphs (TAB/LF/CR/
    // line separator). F81B30 classifies these before any bitmap access.
    const control = view.getInt8(at + 1) === -128 && width * height === 0;
    if (!control && (offset > bitmapBytes || width * height > bitmapBytes - offset))
      throw new Error('CUF glyph bitmap outside input');
    glyphs.push(
      Object.freeze({
        index: i,
        bearing: view.getInt8(at),
        advance: view.getInt8(at + 1),
        width,
        height,
        offset,
      })
    );
  }
  const font = Object.freeze({
    glyphCount,
    bitmapBytes,
    lineHeight,
    baseline,
    widthAdjustment,
    pointSize,
    sourceBytes: bytes.length,
  });
  fonts.set(font, { mapping, glyphs, bitmap: bytes.subarray(bitmapAt) });
  return font;
}

function checked(font, text) {
  const data = fonts.get(font);
  if (!data || typeof text !== 'string' || text.length > maxText || /[\0\r\n\t\u2028]/.test(text))
    throw new TypeError('Invalid single-line CUF text or font');
  return data;
}

export function layoutCufText(font, text) {
  const data = checked(font, text),
    glyphs = [];
  let pen = 0,
    copiedPixels = 0;
  // The native mapping indexes UTF-16 code units, not UTF-8 bytes/code points.
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i),
      index = data.mapping[code];
    if (index === 0xffff) throw new Error('CUF text contains an unmapped character');
    const source = data.glyphs[index];
    if (source.advance === -128) throw new Error('CUF control/sentinel glyph is unsupported');
    const draw = code !== 32 && source.bearing !== -128;
    const width = draw ? source.width : 0,
      height = draw ? source.height : 0;
    const y = draw ? font.baseline - source.bearing : 0;
    copiedPixels += width * height;
    if (copiedPixels > 1024 * 1024) throw new Error('CUF glyph coverage exceeds layout bound');
    glyphs.push(
      Object.freeze({
        code,
        index,
        x: pen,
        y,
        width,
        height,
        advance: source.advance,
        alpha: data.bitmap.slice(source.offset, source.offset + width * height),
      })
    );
    pen += source.advance;
    if (Math.abs(pen) > maxExtent) throw new Error('CUF text exceeds layout bound');
  }
  return {
    width: text.length ? pen - font.widthAdjustment : 0,
    lineHeight: font.lineHeight,
    glyphs,
  };
}

export function measureCufText(font, text) {
  return layoutCufText(font, text).width;
}

export function rasterizeCufText(font, text, { color = [0, 0, 0] } = {}) {
  if (
    !Array.isArray(color) ||
    color.length !== 3 ||
    color.some((v) => !Number.isInteger(v) || v < 0 || v > 255)
  )
    throw new TypeError('Invalid CUF color');
  const layout = layoutCufText(font, text);
  let left = 0,
    top = 0,
    right = Math.max(0, layout.width),
    bottom = font.lineHeight;
  for (const g of layout.glyphs) {
    if (!g.width || !g.height) continue;
    left = Math.min(left, g.x);
    top = Math.min(top, g.y);
    right = Math.max(right, g.x + g.width);
    bottom = Math.max(bottom, g.y + g.height);
  }
  const width = Math.max(1, right - left),
    height = Math.max(1, bottom - top);
  if (width > maxExtent || height > 1024 || width * height > 1024 * 1024)
    throw new Error('CUF raster exceeds output bound');
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (const g of layout.glyphs) {
    for (let y = 0; y < g.height; y++)
      for (let x = 0; x < g.width; x++) {
        const alpha = g.alpha[y * g.width + x];
        if (!alpha) continue;
        const at = ((g.y - top + y) * width + g.x - left + x) * 4;
        rgba[at] = color[0];
        rgba[at + 1] = color[1];
        rgba[at + 2] = color[2];
        // Constant foreground color, unpremultiplied source-over. Integer
        // rounding is an OpenRTW canvas policy, not original GPU pixel parity.
        rgba[at + 3] = Math.round(alpha + (rgba[at + 3] * (255 - alpha)) / 255);
      }
  }
  return {
    width,
    height,
    originX: left,
    originY: top,
    logicalWidth: layout.width,
    lineHeight: font.lineHeight,
    rgba,
  };
}

// OpenRTW single-line presentation policy: clip long labels at whole glyphs,
// retain the complete DOM text for accessibility, and never stretch the bitmap.
// Native glyph metrics/alpha are retained; widget layout and ellipsis are not a
// claim about the original UI. The native select popup remains browser text.
export function fitCufText(font, text, maxWidth) {
  if (!Number.isInteger(maxWidth) || maxWidth < 1 || maxWidth > maxExtent)
    throw TypeError('Invalid CUF label width');
  const layout = layoutCufText(font, text);
  if (layout.width <= maxWidth) return text;
  const suffix = '...';
  const suffixWidth = measureCufText(font, suffix);
  if (suffixWidth > maxWidth) throw Error('CUF label is too narrow');
  let pen = 0,
    prefix = 0;
  // Advances are signed in the source, so a binary search would incorrectly
  // assume monotonic width. Inspect the already validated glyph metrics once.
  for (let i = 0; i < layout.glyphs.length; i++) {
    pen += layout.glyphs[i].advance;
    if (pen + suffixWidth <= maxWidth) prefix = i + 1;
  }
  return text.slice(0, prefix) + suffix;
}

export function createCufTextPresenter({
  node,
  font = null,
  createCanvas,
  maxWidth = 1024,
  color = [0, 0, 0],
}) {
  if (
    !node?.ownerDocument ||
    typeof createCanvas !== 'function' ||
    (font !== null && !fonts.has(font))
  )
    throw TypeError('Invalid CUF text presenter');
  const fallback = node.ownerDocument.createElement('span');
  fallback.className = 'hud-cuf-text';
  node.classList.add('hud-cuf-label');
  node.replaceChildren(fallback);
  let bitmap = null,
    previous = null,
    status = null,
    disposed = false;
  return Object.freeze({
    set(text) {
      if (disposed) throw Error('CUF text presenter is disposed');
      if (typeof text !== 'string' || text.length > maxText)
        throw TypeError('Invalid CUF label text');
      if (text === previous) return status;
      fallback.textContent = text;
      node.dataset.font = 'fallback';
      if (bitmap) bitmap.hidden = true;
      status = { state: 'fallback', text };
      if (font && text)
        try {
          const renderedText = fitCufText(font, text, maxWidth);
          const raster = rasterizeCufText(font, renderedText, { color });
          if (!bitmap) {
            bitmap = createCanvas();
            bitmap.className = 'hud-cuf-bitmap';
            bitmap.setAttribute('aria-hidden', 'true');
            node.append(bitmap);
          }
          bitmap.width = raster.width;
          bitmap.height = raster.height;
          bitmap.style.left = raster.originX + 'px';
          bitmap.style.top = raster.originY + 'px';
          const context = bitmap.getContext('2d');
          if (!context) throw Error('CUF label canvas unavailable');
          context.putImageData(new ImageData(raster.rgba, raster.width, raster.height), 0, 0);
          bitmap.hidden = false;
          node.dataset.font = 'cuf';
          status = {
            state: 'active',
            text,
            renderedText,
            truncated: renderedText !== text,
            width: raster.width,
            height: raster.height,
          };
        } catch (error) {
          if (bitmap) bitmap.hidden = true;
          status.reason = String(error.message).slice(0, 256);
        }
      previous = text;
      return Object.freeze(status);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (bitmap) bitmap.width = bitmap.height = 0;
      bitmap = null;
      node.textContent = previous ?? '';
      node.classList.remove('hud-cuf-label');
      delete node.dataset.font;
      font = null;
    },
  });
}

const fontNames = ['tnr', 'tnr_med', 'tnr_sml', 'verdana', 'verdana_med', 'verdana_sml'];
export function parseFontDatabase(bytes) {
  if (
    !(bytes instanceof Uint8Array) ||
    !(bytes.buffer instanceof ArrayBuffer) ||
    !bytes.length ||
    bytes.length > 65536 ||
    bytes.some((b) => b === 0 || b > 127)
  )
    throw new TypeError('Invalid font database');
  const entries = [],
    seen = new Set();
  for (const line of new TextDecoder().decode(bytes).split(/\r?\n/)) {
    const words = line.split(';', 1)[0].trim().split(/\s+/);
    if (!words[0]) continue;
    const [keyword, name, filename, size, option] = words;
    if (
      keyword !== 'font' ||
      !fontNames.includes(name) ||
      seen.has(name) ||
      words.length < 4 ||
      words.length > 5 ||
      (option && option !== 'kerned') ||
      !/^[a-zA-Z0-9_-]+\.cuf$/i.test(filename) ||
      !/^\d{1,3}$/.test(size) ||
      Number(size) < 1 ||
      Number(size) > 512
    )
      throw new Error('Unsupported font database row');
    seen.add(name);
    entries.push(
      Object.freeze({ name, filename, size: Number(size), kerned: option === 'kerned' })
    );
  }
  if (!entries.length) throw new Error('Empty font database');
  return Object.freeze(entries);
}
