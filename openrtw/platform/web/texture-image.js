// Browser presentation adapter. These are new admission limits, not recovered
// original engine limits; this module does not change the C++ map TGA reader.
export const textureImageLimits = Object.freeze({
  maxInputBytes: 16 * 1024 * 1024,
  maxDimension: 4096,
  maxPixels: 4 * 1024 * 1024,
});

function refuse(message) {
  throw new Error(`Unsupported or malformed TGA texture: ${message}`);
}

// Strict uncompressed true-color TGA2 subset. Output RGBA is owned, top-row
// first and left-to-right, regardless of either source origin bit. Attribute
// bytes are preserved for 32-bit/8-attribute-bit input, with no premultiplication
// or color-space conversion. 24-bit input gains opaque alpha. Other alpha
// declarations refuse; original material/blend/UV semantics remain external.
// Nonzero x/y placement origins are retained as facts, not canvas placement.
export function decodeTgaTexture(bytes) {
  if (!(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer)) {
    throw new TypeError('TGA texture input must be a non-shared Uint8Array');
  }
  if (bytes.byteLength < 18 || bytes.byteLength > textureImageLimits.maxInputBytes) {
    refuse('input byte limit');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header = {
    idLength: bytes[0],
    colorMapType: bytes[1],
    imageType: bytes[2],
    colorMapFirst: view.getUint16(3, true),
    colorMapLength: view.getUint16(5, true),
    colorMapEntryBits: bytes[7],
    xOrigin: view.getUint16(8, true),
    yOrigin: view.getUint16(10, true),
    pixelBits: bytes[16],
    descriptor: bytes[17],
    attributeBits: bytes[17] & 15,
    rightOrigin: Boolean(bytes[17] & 16),
    topOrigin: Boolean(bytes[17] & 32),
  };
  const width = view.getUint16(12, true),
    height = view.getUint16(14, true);
  if (
    header.imageType !== 2 ||
    header.colorMapType !== 0 ||
    header.colorMapFirst !== 0 ||
    header.colorMapLength !== 0 ||
    header.colorMapEntryBits !== 0
  ) {
    refuse('only type2 without a color map is admitted');
  }
  if (
    (header.descriptor & 0xc0) !== 0 ||
    !(
      (header.pixelBits === 24 && header.attributeBits === 0) ||
      (header.pixelBits === 32 && header.attributeBits === 8)
    )
  ) {
    refuse('pixel/attribute/interleave declaration');
  }
  if (
    width < 1 ||
    height < 1 ||
    width > textureImageLimits.maxDimension ||
    height > textureImageLimits.maxDimension ||
    width * height > textureImageLimits.maxPixels
  ) {
    refuse('dimension or pixel budget');
  }
  // All products are bounded integer values at most 2^24; no bitwise narrowing.
  const pixelStart = 18 + header.idLength;
  const pixelBytes = width * height * (header.pixelBits / 8);
  if (pixelStart > bytes.byteLength || pixelBytes > bytes.byteLength - pixelStart) {
    refuse('truncated image ID or pixel data');
  }
  const pixelEndExclusive = pixelStart + pixelBytes;
  const trailing = bytes.byteLength - pixelEndExclusive;
  if (trailing !== 0 && trailing !== 26) refuse('unexpected trailing bytes');
  const footerPresent = trailing === 26;
  if (footerPresent) {
    if (
      view.getUint32(pixelEndExclusive, true) !== 0 ||
      view.getUint32(pixelEndExclusive + 4, true) !== 0
    ) {
      refuse('extension/developer areas are outside this subset');
    }
    const signature = 'TRUEVISION-XFILE.\0';
    for (let i = 0; i < signature.length; ++i) {
      if (bytes[pixelEndExclusive + 8 + i] !== signature.charCodeAt(i)) refuse('footer signature');
    }
  }

  const rgba = new Uint8Array(width * height * 4);
  const stride = header.pixelBits / 8;
  for (let sy = 0; sy < height; ++sy) {
    const y = header.topOrigin ? sy : height - 1 - sy;
    for (let sx = 0; sx < width; ++sx) {
      const x = header.rightOrigin ? width - 1 - sx : sx;
      const source = pixelStart + (sy * width + sx) * stride;
      const target = (y * width + x) * 4;
      rgba[target] = bytes[source + 2];
      rgba[target + 1] = bytes[source + 1];
      rgba[target + 2] = bytes[source];
      rgba[target + 3] = header.pixelBits === 32 ? bytes[source + 3] : 255;
    }
  }
  return {
    width,
    height,
    rgba,
    header,
    sourceFacts: {
      byteLength: bytes.byteLength,
      pixelStart,
      pixelEndExclusive,
      footerPresent,
    },
  };
}
