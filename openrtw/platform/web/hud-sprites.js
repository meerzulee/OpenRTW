// Bounded RSD5 subset reconstructed from the retained strat3/shared2 layouts.
// Rectangles/unknown words are source facts. Native placement, hit testing and
// the three trailing word meanings are not established by this parser.
export const hudSpriteLimits = Object.freeze({
  bytes: 262144,
  pages: 8,
  sprites: 4096,
  stringBytes: 2048,
  dimension: 2048,
});
export function parseHudSprites(bytes) {
  if (!(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer))
    throw new TypeError('HUD layout must be an owned non-shared byte view');
  if (bytes.byteLength < 16 || bytes.byteLength > hudSpriteLimits.bytes)
    throw Error('HUD layout byte bound refused');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  const need = (n) => {
    if (!Number.isSafeInteger(n) || n < 0 || n > bytes.length - offset)
      throw Error('Truncated HUD layout');
  };
  const u32 = () => {
    need(4);
    const value = view.getUint32(offset, true);
    offset += 4;
    return value;
  };
  const string = (nul = false) => {
    const n = u32();
    if (n < 1 || n > hudSpriteLimits.stringBytes) throw Error('HUD string bound refused');
    need(n + (nul ? 1 : 0));
    let value = '';
    for (let i = 0; i < n; i++) {
      const b = bytes[offset++];
      if (b < 32 || b > 126) throw Error('HUD string is not bounded printable ASCII');
      value += String.fromCharCode(b);
    }
    if (nul && bytes[offset++] !== 0) throw Error('HUD texture terminator refused');
    return value;
  };
  const version = u32(),
    pageCount = u32(),
    spriteCount = u32();
  if (
    version !== 5 ||
    pageCount < 1 ||
    pageCount > hudSpriteLimits.pages ||
    spriteCount < 1 ||
    spriteCount > hudSpriteLimits.sprites
  )
    throw Error('HUD version or count refused');
  const collection = string(),
    pages = [],
    textures = new Set();
  for (let i = 0; i < pageCount; i++) {
    const start = offset,
      guide = string(),
      texture = string(true),
      width = u32(),
      height = u32(),
      maskBytes = u32();
    if (!/^[A-Za-z0-9_.-]+\.tga$/i.test(texture) || textures.has(texture.toLowerCase()))
      throw Error('HUD texture name refused');
    textures.add(texture.toLowerCase());
    if (
      width < 1 ||
      height < 1 ||
      width > hudSpriteLimits.dimension ||
      height > hudSpriteLimits.dimension ||
      maskBytes !== Math.floor((width * height) / 8) + 1
    )
      throw Error('HUD page geometry/mask refused');
    need(maskBytes);
    const maskOffset = offset,
      mask = bytes.slice(offset, offset + maskBytes);
    offset += maskBytes;
    pages.push({
      index: i,
      guide,
      texture,
      width,
      height,
      mask,
      range: { start, endExclusive: offset, bytes: offset - start },
      maskRange: { start: maskOffset, endExclusive: offset, bytes: maskBytes },
    });
  }
  const spriteStart = offset,
    sprites = [],
    names = new Set();
  for (let i = 0; i < spriteCount; i++) {
    const start = offset,
      name = string();
    if (names.has(name)) throw Error('Duplicate HUD sprite name');
    names.add(name);
    need(16);
    const words = Array.from({ length: 8 }, (_, j) => view.getUint16(offset + j * 2, true));
    offset += 16;
    const [page, x0, x1, y0, y1, ...unknownU16] = words,
      p = pages[page];
    if (!p || x0 > x1 || y0 > y1 || x1 >= p.width || y1 >= p.height)
      throw Error('HUD sprite rectangle is outside its page');
    sprites.push({
      ordinal: i,
      name,
      page,
      x0,
      x1,
      y0,
      y1,
      width: x1 - x0 + 1,
      height: y1 - y0 + 1,
      unknownU16,
      range: { start, endExclusive: offset, bytes: offset - start },
    });
  }
  if (offset !== bytes.length) throw Error('Unexpected HUD layout tail');
  return {
    version,
    collection,
    pages,
    sprites,
    sourceBytes: bytes.length,
    spriteRange: { start: spriteStart, endExclusive: offset, bytes: offset - spriteStart },
    exactEof: true,
    rectanglePolicy: 'inclusive-source-candidate',
  };
}
