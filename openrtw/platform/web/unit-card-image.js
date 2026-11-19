// Presentation-only envelope for the four retained original Julii unit cards.
// Their extension occupies495 bytes but declares494. This explicit legacy
// subset does not relax texture-image.js or infer native alpha/gamma blending.
export const unitCardImageLimits = Object.freeze({
  maxInputBytes: 2 * 1024 * 1024,
  maxDimension: 512,
  maxPixels: 512 * 512,
  maxPackets: 512 * 512,
});

function refuse(message) {
  throw new Error(`Unsupported or malformed unit-card TGA: ${message}`);
}

// RLE true-color32/attribute8, no palette/interleave. Output is a new top-left
// RGBA array, preserving literal channels/alpha without unpremultiplication,
// premultiplication, gamma conversion, native material or composition claims.
export function decodeUnitCardTga(bytes) {
  if (!(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer)) {
    throw new TypeError('Unit-card input must be a non-shared Uint8Array');
  }
  if (bytes.byteLength < 18 + 495 + 26 || bytes.byteLength > unitCardImageLimits.maxInputBytes) {
    refuse('input byte bound');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint16(12, true),
    height = view.getUint16(14, true);
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
  if (
    header.imageType !== 10 ||
    header.colorMapType !== 0 ||
    header.colorMapFirst !== 0 ||
    header.colorMapLength !== 0 ||
    header.colorMapEntryBits !== 0 ||
    header.pixelBits !== 32 ||
    header.attributeBits !== 8 ||
    (header.descriptor & 0xc0) !== 0
  ) {
    refuse('only RLE true-color32/attribute8 without palette/interleave is admitted');
  }
  if (
    width < 1 ||
    height < 1 ||
    width > unitCardImageLimits.maxDimension ||
    height > unitCardImageLimits.maxDimension ||
    width * height > unitCardImageLimits.maxPixels
  ) {
    refuse('dimension or pixel bound');
  }
  const footerStart = bytes.byteLength - 26;
  const signature = 'TRUEVISION-XFILE.\0';
  for (let i = 0; i < signature.length; ++i) {
    if (bytes[footerStart + 8 + i] !== signature.charCodeAt(i)) refuse('footer signature');
  }
  const extensionStart = view.getUint32(footerStart, true);
  const developerOffset = view.getUint32(footerStart + 4, true);
  const pixelStart = 18 + header.idLength;
  if (
    developerOffset !== 0 ||
    extensionStart < pixelStart ||
    extensionStart > footerStart ||
    footerStart - extensionStart !== 495
  ) {
    refuse('exact495-byte extension/developer envelope');
  }
  const declaredSize = view.getUint16(extensionStart, true);
  if (declaredSize !== 494) refuse('selected legacy extension must declare494');

  const pixelCount = width * height;
  const rgba = new Uint8Array(pixelCount * 4);
  let offset = pixelStart,
    written = 0,
    packetCount = 0,
    rawPackets = 0,
    runPackets = 0;
  const emit = (source) => {
    const sourceY = Math.floor(written / width),
      sourceX = written % width;
    const x = header.rightOrigin ? width - 1 - sourceX : sourceX;
    const y = header.topOrigin ? sourceY : height - 1 - sourceY;
    const target = (y * width + x) * 4;
    rgba[target] = bytes[source + 2];
    rgba[target + 1] = bytes[source + 1];
    rgba[target + 2] = bytes[source];
    rgba[target + 3] = bytes[source + 3];
    ++written;
  };
  while (written < pixelCount) {
    if (offset >= extensionStart || ++packetCount > unitCardImageLimits.maxPackets) {
      refuse('truncated or excessive RLE packets');
    }
    const packet = bytes[offset++],
      count = (packet & 127) + 1;
    if (count > pixelCount - written) refuse('RLE packet overruns pixel extent');
    if (packet & 128) {
      if (extensionStart - offset < 4) refuse('truncated RLE run pixel');
      for (let i = 0; i < count; ++i) emit(offset);
      offset += 4;
      ++runPackets;
    } else {
      if (count * 4 > extensionStart - offset) refuse('truncated RLE raw pixels');
      for (let i = 0; i < count; ++i) emit(offset + i * 4);
      offset += count * 4;
      ++rawPackets;
    }
  }
  if (offset !== extensionStart) refuse('RLE stream must end exactly at extension');
  return {
    width,
    height,
    rgba,
    header,
    extension: {
      declaredSize,
      alphaAttributesType: bytes[extensionStart + 494],
      // All495 source bytes, including unknown metadata and offset fields.
      bytes: bytes.slice(extensionStart, footerStart),
    },
    sourceFacts: {
      envelopeProfile: 'openrtw-unit-card-tga10-legacy494-v1',
      alphaPolicy: 'literal-bgra-no-unpremultiply',
      byteLength: bytes.byteLength,
      pixelStart,
      pixelEndExclusive: offset,
      packetCount,
      rawPackets,
      runPackets,
      developerOffset,
      extensionRange: { start: extensionStart, endExclusive: footerStart },
      footerRange: { start: footerStart, endExclusive: bytes.byteLength },
    },
  };
}
