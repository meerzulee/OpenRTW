// Device-level encoded texels. Decoding, UV/material policy and title metadata
// interpretation belong to the caller. No pixel or metadata normalization.
import { snapshotVersionedExtensions } from './resource-data.js';

export const textureResourceSchema = 'openrtw.texture-resource/v1';
export class TextureResourceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TextureResourceError';
    this.code = code;
  }
}
export const textureResourceLimits = Object.freeze({
  dimension: 4096, levels: 13, bytes: 32 * 1024 * 1024,
  metadataNodes: 4096, metadataDepth: 16, metadataUnits: 32768,
});
const formats = Object.freeze({
  'rgba8-unorm': Object.freeze({ device: 0x80000001, block: 1, bytes: 4 }),
  'bc1-unorm': Object.freeze({ device: 0x31545844, block: 4, bytes: 8 }),
  'bc2-unorm': Object.freeze({ device: 0x33545844, block: 4, bytes: 16 }),
  'bc3-unorm': Object.freeze({ device: 0x35545844, block: 4, bytes: 16 }),
});
const uint = value => Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
function refuse(message) { throw new TypeError('Texture resource: ' + message); }
function record(value, names) {
  if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    refuse('plain record required');
  const fields = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(fields);
  if (keys.length !== names.length || keys.some(key => !names.includes(key)))
    refuse('unknown or missing field');
  for (const name of names)
    if (!Object.hasOwn(fields[name], 'value') || !fields[name].enumerable)
      refuse('data fields required');
}
function metadataSnapshot(input) {
  return snapshotVersionedExtensions(input, {
    nodes: textureResourceLimits.metadataNodes,
    depth: textureResourceLimits.metadataDepth,
    units: textureResourceLimits.metadataUnits,
  }, 'Texture resource');
}

// Input is trusted application data, not executable selected content. Property
// enumeration is not a sandbox/allocation bound for arbitrary hostile objects.
// The admitted plain graph and all retained texels are bounded and copied.
export function createTextureResource(input) {
  record(input, ['schema', 'width', 'height', 'format', 'units', 'origin',
    'colorSpace', 'alphaMode', 'mips', 'extensions']);
  const { schema, width, height, format, units, origin, colorSpace, alphaMode, mips } = input;
  if (schema !== textureResourceSchema || typeof format !== 'string' || !Object.hasOwn(formats, format))
    refuse('unsupported schema or format');
  if (!uint(width) || !width || width > textureResourceLimits.dimension ||
      !uint(height) || !height || height > textureResourceLimits.dimension) refuse('dimensions');
  if (units !== 'texel' || origin !== 'top-left' || colorSpace !== 'uninterpreted' ||
      !['uninterpreted', 'straight', 'opaque'].includes(alphaMode))
    refuse('unsupported units, origin, color space or alpha declaration');
  if (!Array.isArray(mips) || !mips.length || mips.length > textureResourceLimits.levels ||
      mips.length > Math.floor(Math.log2(Math.max(width, height))) + 1)
    refuse('mip count');
  if (Reflect.ownKeys(mips).length !== mips.length + 1) refuse('unexpected mip array fields');
  const layout = formats[format], retained = [], descriptions = [];
  let total = 0;
  for (let level = 0; level < mips.length; level++) {
    const field = Object.getOwnPropertyDescriptor(mips, String(level));
    if (!field || !Object.hasOwn(field, 'value')) refuse('dense mip data required');
    const mip = field.value;
    record(mip, ['width', 'height', 'rowPitch', 'data']);
    const w = Math.max(1, width >> level), h = Math.max(1, height >> level);
    if (mip.width !== w || mip.height !== h || !uint(mip.rowPitch)) refuse('mip dimensions or pitch');
    const rowBytes = Math.ceil(w / layout.block) * layout.bytes, rows = Math.ceil(h / layout.block);
    if ((layout.block !== 1 && mip.rowPitch !== 0) || (mip.rowPitch && mip.rowPitch < rowBytes))
      refuse('unsupported row pitch');
    const bytes = (mip.rowPitch || rowBytes) * rows, data = mip.data;
    if (!(data instanceof Uint8Array) || !(data.buffer instanceof ArrayBuffer) ||
        data.byteLength !== bytes || bytes > textureResourceLimits.bytes - total)
      refuse('mip span or byte budget');
    total += bytes;
    retained.push(new Uint8Array(data)); // Buffer/subarray copies only the view region.
    descriptions.push(Object.freeze({ level, width: w, height: h, rowPitch: mip.rowPitch, bytes }));
  }
  const extensions = metadataSnapshot(input.extensions);
  for (const [key, extension] of Object.entries(extensions))
    if (!/^[a-z0-9][a-z0-9._-]{0,79}\/v[1-9][0-9]*$/.test(key) ||
        !extension || Array.isArray(extension) || extension.schema !== key)
      refuse('versioned extension record required');
  const descriptor = Object.freeze({ schema, width, height, format, units, origin, colorSpace, alphaMode,
    ownership: 'owned-copy', bytes: total, mips: Object.freeze(descriptions),
    extensions });
  return Object.freeze({
    descriptor,
    readMip(level) {
      if (!uint(level) || level >= retained.length) refuse('mip index');
      return new Uint8Array(retained[level]);
    },
    create(device) {
      for (const method of ['createTexture', 'uploadTexture', 'setTexture', 'destroyTexture'])
        if (typeof device?.[method] !== 'function') refuse('missing device method ' + method);
      let id = 0, closed = false;
      const owner = Object.freeze({
        descriptor,
        bind(stage = 0) {
          if (closed) throw new Error('Texture resource is disposed');
          if (!uint(stage)) refuse('texture stage');
          device.setTexture(stage, id);
        },
        dispose() {
          if (closed) return;
          closed = true;
          const old = id;
          id = 0;
          if (old) device.destroyTexture(old);
        },
      });
      try {
        const created = device.createTexture({ width, height, levels: retained.length, format: layout.device });
        if (!uint(created) || !created)
          throw new TextureResourceError('invalid-handle', 'Invalid texture resource handle');
        id = created;
        for (const mip of descriptions)
          device.uploadTexture(id, mip.level, new Uint8Array(retained[mip.level]), { rowPitch: mip.rowPitch });
      } catch (error) {
        try { owner.dispose(); }
        catch (cleanup) { throw new AggregateError([error, cleanup], 'Texture resource creation failed'); }
        throw error;
      }
      return owner;
    },
  });
}
