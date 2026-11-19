import { decodeTgaTexture } from '/texture-image.js';

// Owned imperial-campaign rasters, also named by retained native D273E3/D27519.
// Native political/fog compositing and zoom sampling are separate presentation.
export const campaignRadarMapSources = Object.freeze({
  campaignRadarMap1: Object.freeze({
    bytes: 120120,
    width: 255,
    height: 156,
    sha256: '1752a1f223c1559f4ba4c24b6a9cc1f2e0ec3351f786f20881217a50a1d0cf34',
  }),
  campaignRadarMap2: Object.freeze({
    bytes: 477404,
    width: 510,
    height: 312,
    sha256: 'b67e168a3700ee1897045a1424e50fe09863b9ba6056bd4a46e827021409af4e',
  }),
});

function refuse(message) {
  throw new Error('Unsupported campaign radar map: ' + message);
}

// Bounded map1 profile only: RGB24 RLE, 255x156, no ID/color map/placement,
// plus the observed 495-byte legacy extension and standard 26-byte footer.
// Valid origin flags are decoded here; the async loader additionally requires
// the exact original digest (whose descriptor is bottom-left/zero).
export function decodeCampaignRadarMap1(bytes) {
  if (!(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer))
    throw TypeError('Radar map must be a non-shared Uint8Array');
  if (bytes.length < 18 + 495 + 26 + 4 || bytes.length > 120120) refuse('byte extent');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    width = view.getUint16(12, true),
    height = view.getUint16(14, true),
    descriptor = bytes[17];
  if (
    bytes[0] !== 0 ||
    bytes[1] !== 0 ||
    bytes[2] !== 10 ||
    bytes.slice(3, 12).some((value) => value !== 0) ||
    width !== 255 ||
    height !== 156 ||
    bytes[16] !== 24 ||
    (descriptor & ~0x30) !== 0
  )
    refuse('map1 header');
  const footerStart = bytes.length - 26,
    extensionStart = view.getUint32(footerStart, true),
    signature = 'TRUEVISION-XFILE.\0';
  if (
    extensionStart < 18 ||
    extensionStart !== footerStart - 495 ||
    view.getUint32(footerStart + 4, true) !== 0 ||
    view.getUint16(extensionStart, true) !== 495 ||
    [...signature].some((c, i) => bytes[footerStart + 8 + i] !== c.charCodeAt(0))
  )
    refuse('map1 legacy extension/footer');
  const rgba = new Uint8Array(width * height * 4),
    pixels = width * height,
    top = Boolean(descriptor & 0x20),
    right = Boolean(descriptor & 0x10);
  let offset = 18,
    pixel = 0;
  const write = (source) => {
    const sy = Math.floor(pixel / width),
      sx = pixel % width,
      x = right ? width - 1 - sx : sx,
      y = top ? sy : height - 1 - sy,
      target = (y * width + x) * 4;
    rgba[target] = bytes[source + 2];
    rgba[target + 1] = bytes[source + 1];
    rgba[target + 2] = bytes[source];
    rgba[target + 3] = 255;
    pixel++;
  };
  while (pixel < pixels) {
    if (offset >= extensionStart) refuse('truncated RLE packet');
    const packet = bytes[offset++],
      count = (packet & 127) + 1,
      repeated = Boolean(packet & 128),
      byteCount = repeated ? 3 : count * 3;
    if (count > pixels - pixel) refuse('RLE output overflow');
    if (byteCount > extensionStart - offset) refuse('truncated RLE pixels');
    for (let i = 0; i < count; i++) write(offset + (repeated ? 0 : i * 3));
    offset += byteCount;
  }
  if (offset !== extensionStart) refuse('unexpected RLE tail');
  return {
    width,
    height,
    rgba,
    sourceFacts: Object.freeze({
      pixelStart: 18,
      pixelEndExclusive: offset,
      footerStart,
      legacyExtension: Object.freeze({
        start: extensionStart,
        endExclusive: footerStart,
        bytes: new Uint8Array(bytes.subarray(extensionStart, footerStart)),
      }),
      descriptor,
    }),
  };
}

/** Optional readAsset(name,{signal}) uses the existing root-owned asset reader.
 * A missing/foreign base returns rgba:null; failed optional detail retains base.
 * Returned RGBA is independently owned and top-left; no source bytes retained.
 */
export async function loadCampaignRadarMap(readAsset, { isOpen = () => true, signal } = {}) {
  if (typeof readAsset !== 'function' || typeof isOpen !== 'function')
    throw TypeError('Invalid radar map reader/lifetime check');
  const open = () => {
    if (signal?.aborted)
      throw signal.reason ?? new DOMException('Radar map loading cancelled', 'AbortError');
    if (!isOpen()) throw new DOMException('Radar map loading closed', 'AbortError');
  };
  const reason = (error) => String(error?.message ?? error).slice(0, 256);
  const read = async (name) => {
    open();
    const spec = campaignRadarMapSources[name],
      input = await readAsset(name, { signal });
    open();
    if (
      !(input instanceof Uint8Array) ||
      !(input.buffer instanceof ArrayBuffer) ||
      input.length !== spec.bytes
    )
      refuse(name + ' byte extent');
    const bytes = new Uint8Array(input),
      hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (v) =>
        v.toString(16).padStart(2, '0')
      ).join('');
    open();
    if (hash !== spec.sha256) refuse(name + ' source hash');
    const image =
      name === 'campaignRadarMap1' ? decodeCampaignRadarMap1(bytes) : decodeTgaTexture(bytes);
    if (
      image.width !== spec.width ||
      image.height !== spec.height ||
      (name === 'campaignRadarMap2' &&
        (image.header.pixelBits !== 24 || image.header.descriptor !== 0))
    )
      refuse(name + ' geometry');
    open();
    return Object.freeze({ width: image.width, height: image.height, rgba: image.rgba });
  };
  open();
  let base;
  try {
    base = await read('campaignRadarMap1');
    open();
  } catch (error) {
    open();
    if (error?.name === 'AbortError') throw error;
    return Object.freeze({
      width: 0,
      height: 0,
      rgba: null,
      status: Object.freeze({
        schema: 'openrtw-campaign-radar-map-v1',
        state: 'fallback',
        fallback: 'coordinate-matched-geographic-raster',
        reason: reason(error),
      }),
    });
  }
  let detail,
    detailReason = null;
  try {
    detail = await read('campaignRadarMap2');
    open();
  } catch (error) {
    open();
    if (error?.name === 'AbortError') throw error;
    detailReason = reason(error);
  }
  open();
  return Object.freeze({
    ...base,
    ...(detail ? { detail } : {}),
    status: Object.freeze({
      schema: 'openrtw-campaign-radar-map-v1',
      state: 'active',
      sourceSha256: campaignRadarMapSources.campaignRadarMap1.sha256,
      detail: detail ? 'active' : 'fallback',
      detailReason,
      detailSourceSha256: detail ? campaignRadarMapSources.campaignRadarMap2.sha256 : null,
      policy: 'original-raster;top-left-world-domain;native-overlay-unproved',
    }),
  });
}
