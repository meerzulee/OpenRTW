// Device-level packed triangle geometry. The service owns exact vertex/index
// bytes and their declared encoded layout; decoding, CAS/Rome names, camera,
// axis conversion, material/UV/shader policy and GPU lifetime stay with the
// caller. No transform or normalization is performed here.
import { snapshotVersionedExtensions } from './resource-data.js';

export const geometryResourceSchema = 'openrtw.geometry-resource/v1';
export class GeometryResourceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GeometryResourceError';
    this.code = code;
  }
}
export const geometryResourceLimits = Object.freeze({
  vertices: 16384,
  triangles: 32768,
  bytes: 8 * 1024 * 1024,
  metadataNodes: 1048576,
  metadataDepth: 32,
  metadataUnits: 4194304,
});
// The only admitted encoding: exact float32 little-endian positions and UVs
// with packed D3DCOLOR/BGRA bytes between them. Attribute semantics and FVF
// bits are technical device packing, not title material or shading policy.
const attributeFormats = Object.freeze({
  position: Object.freeze({ format: 'f32x3', offset: 0, bytes: 12, fvf: 0x002, floats: [0, 4, 8] }),
  color: Object.freeze({ format: 'd3dcolor-bgra8', offset: 12, bytes: 4, fvf: 0x040 }),
  uv0: Object.freeze({ format: 'f32x2', offset: 16, bytes: 8, fvf: 0x100, floats: [16, 20] }),
});
const attributeOrder = Object.freeze(['position', 'color', 'uv0']);
const supportedStride = 24;
const indexFormats = Object.freeze({ 'uint16-le': Object.freeze({ device: 1, bytes: 2 }) });
const primitives = Object.freeze({ 'triangle-list': 4 });
const uint = (value) => Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
const token = (value) => typeof value === 'string' && /^[A-Za-z0-9+.-][A-Za-z0-9._:+-]{0,63}$/.test(value);
function refuse(message) {
  throw new TypeError('Geometry resource: ' + message);
}
function record(value, names) {
  if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    refuse('plain record required');
  const fields = Object.getOwnPropertyDescriptors(value),
    keys = Reflect.ownKeys(fields);
  if (keys.length !== names.length || keys.some((key) => !names.includes(key)))
    refuse('unknown or missing field');
  for (const name of names)
    if (!Object.hasOwn(fields[name], 'value') || !fields[name].enumerable)
      refuse('data fields required');
}
function declaredLayout(input) {
  record(input, ['stride', 'endianness', 'attributes']);
  if (input.stride !== supportedStride || input.endianness !== 'little')
    refuse('unsupported vertex layout');
  const attributes = input.attributes;
  if (!Array.isArray(attributes) || attributes.length !== attributeOrder.length ||
      Reflect.ownKeys(attributes).length !== attributes.length + 1)
    refuse('dense vertex attributes required');
  const admitted = [];
  for (let i = 0; i < attributes.length; i++) {
    const field = Object.getOwnPropertyDescriptor(attributes, String(i));
    if (!field || !Object.hasOwn(field, 'value')) refuse('dense vertex attributes required');
    record(field.value, ['semantic', 'format', 'offset']);
    if (typeof field.value.semantic !== 'string' || !Object.hasOwn(attributeFormats, field.value.semantic))
      refuse('unsupported vertex attribute');
    const supported = attributeFormats[field.value.semantic];
    if (!supported || supported.format !== field.value.format || supported.offset !== field.value.offset ||
        admitted.some((attribute) => attribute.semantic === field.value.semantic))
      refuse('unsupported vertex attribute');
    admitted.push(Object.freeze({ semantic: field.value.semantic, format: supported.format,
      offset: supported.offset }));
  }
  admitted.sort((a, b) => a.offset - b.offset);
  return Object.freeze({ stride: supportedStride, endianness: 'little',
    attributes: Object.freeze(admitted) });
}
function declaredCoordinates(input) {
  record(input, ['frame', 'units', 'up', 'handedness']);
  for (const name of ['frame', 'units', 'up', 'handedness'])
    if (!token(input[name])) refuse('coordinate declaration');
  // Declarations are retained verbatim. The service ships caller bytes and
  // never converts axes, scale, orientation or units.
  return Object.freeze({ frame: input.frame, units: input.units, up: input.up,
    handedness: input.handedness });
}
function finiteAttribute(bytes, stride, vertices, offsets, message) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < vertices; i++)
    for (const offset of offsets)
      if (!Number.isFinite(view.getFloat32(i * stride + offset, true))) refuse(message);
}
function ownedBytes(value, bytes, label) {
  if (!(value instanceof Uint8Array) || !(value.buffer instanceof ArrayBuffer) ||
      value.byteLength !== bytes)
    refuse(label);
  return new Uint8Array(value); // Buffer/subarray copies only the view region.
}

// Input is trusted application data, not executable selected content. Property
// enumeration is not a sandbox/allocation bound for arbitrary hostile objects.
// Every retained byte and extension field is bounded and copied.
export function createGeometryResource(input) {
  record(input, ['schema', 'layout', 'primitive', 'indexFormat', 'counts', 'coordinates',
    'vertexBytes', 'indexBytes', 'extensions']);
  const { schema, primitive, indexFormat, counts } = input;
  if (schema !== geometryResourceSchema || typeof primitive !== 'string' ||
      !Object.hasOwn(primitives, primitive) || typeof indexFormat !== 'string' ||
      !Object.hasOwn(indexFormats, indexFormat))
    refuse('unsupported schema, primitive or index format');
  const layout = declaredLayout(input.layout);
  record(counts, ['vertices', 'indices']);
  const vertices = counts.vertices, indices = counts.indices;
  if (!uint(vertices) || !vertices || vertices > geometryResourceLimits.vertices)
    refuse('vertex count');
  if (!uint(indices) || !indices || indices % 3 || indices > geometryResourceLimits.triangles * 3)
    refuse('index count');
  const indexFormatInfo = indexFormats[indexFormat];
  const vertexBytes = layout.stride * vertices, indexByteCount = indexFormatInfo.bytes * indices;
  if (vertexBytes > geometryResourceLimits.bytes ||
      indexByteCount > geometryResourceLimits.bytes - vertexBytes)
    refuse('byte budget');
  const ownedVertices = ownedBytes(input.vertexBytes, vertexBytes, 'vertex span'),
    ownedIndices = ownedBytes(input.indexBytes, indexByteCount, 'index span');
  finiteAttribute(ownedVertices, layout.stride, vertices, attributeFormats.position.floats,
    'non-finite position');
  finiteAttribute(ownedVertices, layout.stride, vertices, attributeFormats.uv0.floats,
    'non-finite uv');
  const indexView = new DataView(ownedIndices.buffer, ownedIndices.byteOffset, ownedIndices.byteLength);
  for (let i = 0; i < indices; i++)
    if (indexView.getUint16(i * 2, true) >= vertices) refuse('index out of range');
  const coordinates = declaredCoordinates(input.coordinates);
  const extensions = snapshotVersionedExtensions(input.extensions,
    { nodes: geometryResourceLimits.metadataNodes, depth: geometryResourceLimits.metadataDepth,
      units: geometryResourceLimits.metadataUnits }, 'Geometry resource');
  const fvf = attributeOrder.reduce((bits, semantic) => bits | attributeFormats[semantic].fvf, 0);
  const technical = Object.freeze({
    buffers: Object.freeze({ vertex: 0, index: indexFormatInfo.device }),
    primitive: primitives[primitive],
    fvf,
  });
  const descriptor = Object.freeze({
    schema,
    layout,
    primitive,
    indexFormat,
    counts: Object.freeze({ vertices, indices, triangles: indices / 3 }),
    coordinates,
    ownership: 'owned-copy',
    vertexBytes,
    indexBytes: indexByteCount,
    bytes: vertexBytes + indexByteCount,
    technical,
    extensions,
  });
  return Object.freeze({
    descriptor,
    readVertices() {
      return new Uint8Array(ownedVertices);
    },
    readIndices() {
      return new Uint8Array(ownedIndices);
    },
    // Trusted synchronous device ports. The caller allocates and registers each
    // handle in its own owner before allocateBuffer returns, and owns every
    // allocation even when a later upload fails. This service never destroys a
    // device resource and never retains a device handle.
    upload(ports) {
      for (const name of ['allocateBuffer', 'uploadBuffer'])
        if (typeof ports?.[name] !== 'function') refuse('missing device port ' + name);
      const vertexBuffer = ports.allocateBuffer(0,
        Object.freeze({ kind: technical.buffers.vertex, bytes: descriptor.vertexBytes }));
      if (!uint(vertexBuffer) || !vertexBuffer)
        throw new GeometryResourceError('invalid-handle', 'Invalid vertex buffer handle');
      const indexBuffer = ports.allocateBuffer(1,
        Object.freeze({ kind: technical.buffers.index, bytes: descriptor.indexBytes }));
      if (!uint(indexBuffer) || !indexBuffer)
        throw new GeometryResourceError('invalid-handle', 'Invalid index buffer handle');
      ports.uploadBuffer(vertexBuffer, new Uint8Array(ownedVertices));
      ports.uploadBuffer(indexBuffer, new Uint8Array(ownedIndices));
      return Object.freeze({ vertexBuffer, indexBuffer });
    },
  });
}
