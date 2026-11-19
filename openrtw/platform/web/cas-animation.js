// Owned raw SG snapshots only. No names, skeleton binding, playback clock,
// interpolation, float normalization, native axes or scale are inferred here.
export const casAnimationSourceSha256 =
  '95e15f90bdca0a522d9de67cfcd2e461386f9d91acadb840aef6af417e052428';
const sourceSize = 7093,
  jsonLimit = 64 * 1024,
  uint = (n) => Number.isInteger(n) && n >= 0 && n <= 0xffffffff;
const rangeNames = [
  'headerRange',
  'rotationRange',
  'positionRange',
  'doubledIncrementRange',
  'doubledDistanceRange',
  'controlPositionRange',
  'tailFloatRange',
  'trailingRange',
  'positionMaskRange',
  'opaqueWriterTailRange',
];
const ranges = [
  [0, 5],
  [5, 6389],
  [6389, 6641],
  [6641, 6761],
  [6761, 6801],
  [6801, 7053],
  [7053, 7085],
  [7085, 7093],
  [7085, 7089],
  [7089, 7093],
];
const wordNames = [
  'rotationQuaternionBits',
  'positionChannelBits',
  'doubledIncrementBits',
  'doubledDistanceBits',
  'controlPositionBits',
  'tailFloatBits',
];
const counts = [1596, 63, 30, 10, 63, 8],
  starts = [5, 6389, 6641, 6761, 6801, 7053];
const keys = (value, names) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === names.slice().sort().join(',');
const range = (value, start, end) =>
  keys(value, ['start', 'endExclusive']) && value.start === start && value.endExclusive === end;
const digest = async (bytes) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (v) =>
    v.toString(16).padStart(2, '0')
  ).join('');
function options(isOpen, expectedSha256) {
  if (
    typeof isOpen !== 'function' ||
    typeof expectedSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(expectedSha256)
  )
    throw TypeError('Invalid animation owner options');
}
function checkOpen(isOpen) {
  if (!isOpen()) throw new DOMException('CAS animation loading cancelled', 'AbortError');
}
function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
function copyText(core, pointer, limit = jsonLimit) {
  const heap = core.HEAPU8;
  if (!(heap instanceof Uint8Array) || !uint(pointer) || !pointer || pointer >= heap.length)
    throw Error('Invalid animation JSON pointer');
  const bytes = heap.slice(pointer, Math.min(heap.length, pointer + limit + 1)),
    end = bytes.indexOf(0);
  if (end < 0 || end > limit) throw Error('Animation JSON exceeds its bridge bound');
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end));
}
function copySource(core) {
  const pointer = core._openrtw_cas_animation_source_bytes(),
    size = core._openrtw_cas_animation_source_size(),
    heap = core.HEAPU8;
  if (
    !(heap instanceof Uint8Array) ||
    !uint(pointer) ||
    !pointer ||
    size !== sourceSize ||
    pointer > heap.length - size
  )
    throw Error('Invalid animation source span');
  return heap.slice(pointer, pointer + size);
}
function envelope(value, schema) {
  return (
    value.schema === schema &&
    value.sourceBytes === sourceSize &&
    value.frameCount === 21 &&
    value.rotationSlotCount === 19 &&
    value.positionChannelCount === 1
  );
}
function validateSource(source) {
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
  if (
    source.length !== sourceSize ||
    view.getUint16(0, true) !== 21 ||
    view.getUint16(2, true) !== 19 ||
    source[4] !== 1 ||
    source[7085] !== 1 ||
    source.subarray(7086).some((v) => v !== 0)
  )
    throw Error('Animation source profile differs');
  for (let field = 0; field < counts.length; field++)
    for (let i = 0; i < counts[field]; i++)
      if ((view.getUint32(starts[field] + i * 4, true) & 0x7f800000) === 0x7f800000)
        throw Error('Animation source contains nonfinite words');
  for (let start = 5; start < 6389; start += 16) {
    let norm = 0;
    for (let k = 0; k < 4; k++) {
      const v = view.getFloat32(start + k * 4, true);
      norm += v * v;
    }
    if (!Number.isFinite(norm) || norm === 0 || Math.abs(norm - 1) > 0.001)
      throw Error('Animation quaternion admission differs');
  }
  return view;
}
function validateFull(value, source) {
  if (
    !keys(value, [
      'schema',
      'sourceBytes',
      'frameCount',
      'rotationSlotCount',
      'positionChannelCount',
      ...rangeNames,
      ...wordNames,
      'trailingBytes',
    ]) ||
    !envelope(value, 'openrtw-cas-animation-v1')
  )
    throw Error('Animation projection envelope differs');
  const view = validateSource(source);
  for (let i = 0; i < rangeNames.length; i++)
    if (!range(value[rangeNames[i]], ...ranges[i])) throw Error('Animation source range differs');
  for (let field = 0; field < wordNames.length; field++) {
    const words = value[wordNames[field]];
    if (
      !Array.isArray(words) ||
      words.length !== counts[field] ||
      words.some((word, i) => !uint(word) || word !== view.getUint32(starts[field] + i * 4, true))
    )
      throw Error('Animation raw source words differ');
  }
  if (
    !Array.isArray(value.trailingBytes) ||
    value.trailingBytes.length !== 8 ||
    value.trailingBytes.some((byte, i) => byte !== source[7085 + i])
  )
    throw Error('Animation trailing source bytes differ');
  return value;
}
function frameFrom(value, index, sourceSha256) {
  if (!uint(index) || index >= 21) throw RangeError('Animation frame index is outside 0..20');
  const start = index * 76,
    rotationQuaternionBits = Array.from({ length: 19 }, (_, slot) =>
      value.rotationQuaternionBits.slice(start + slot * 4, start + (slot + 1) * 4)
    );
  return deepFreeze({
    schema: 'openrtw-cas-animation-frame-v1',
    sourceBytes: sourceSize,
    frameCount: 21,
    rotationSlotCount: 19,
    positionChannelCount: 1,
    frameIndex: index,
    rotationRange: { start: 5 + index * 304, endExclusive: 5 + (index + 1) * 304 },
    positionChannelRange: { start: 6389 + index * 12, endExclusive: 6389 + (index + 1) * 12 },
    controlPositionRange: { start: 6801 + index * 12, endExclusive: 6801 + (index + 1) * 12 },
    rotationQuaternionBits,
    positionChannelBits: value.positionChannelBits.slice(index * 3, index * 3 + 3),
    controlPositionBits: value.controlPositionBits.slice(index * 3, index * 3 + 3),
    ...(sourceSha256 ? { sourceSha256 } : {}),
  });
}
function validateFrame(frame, full, index) {
  const expected = frameFrom(full, index);
  if (
    !keys(frame, Object.keys(expected)) ||
    !envelope(frame, 'openrtw-cas-animation-frame-v1') ||
    frame.frameIndex !== index
  )
    throw Error('Animation frame envelope differs');
  for (const name of ['rotationRange', 'positionChannelRange', 'controlPositionRange'])
    if (!range(frame[name], expected[name].start, expected[name].endExclusive))
      throw Error('Animation frame range differs');
  if (
    !Array.isArray(frame.rotationQuaternionBits) ||
    frame.rotationQuaternionBits.length !== 19 ||
    frame.rotationQuaternionBits.some(
      (q, slot) =>
        !Array.isArray(q) ||
        q.length !== 4 ||
        q.some((word, k) => word !== expected.rotationQuaternionBits[slot][k])
    )
  )
    throw Error('Animation frame rotation words differ');
  for (const name of ['positionChannelBits', 'controlPositionBits'])
    if (
      !Array.isArray(frame[name]) ||
      frame[name].length !== 3 ||
      frame[name].some((word, k) => word !== expected[name][k])
    )
      throw Error('Animation frame channel words differ');
  return frame;
}
function capture(core) {
  // Each getter can grow the WASM heap; snapshot from the current heap after
  // the pointer/size getters, and retain no borrowed spans across calls/awaits.
  const json = copyText(core, core._openrtw_cas_animation_json()),
    source = copySource(core);
  return { source, value: validateFull(JSON.parse(json), source) };
}

// The default binds the retained SG01 bytes. Other source-like fixtures require
// an explicit expected digest. Hash the owned input before publishing to core.
// The returned clip has no live-core dependency and survives replacement/reset.
export async function loadCasAnimation(
  core,
  input,
  { isOpen = () => true, expectedSha256 = casAnimationSourceSha256 } = {}
) {
  options(isOpen, expectedSha256);
  checkOpen(isOpen);
  if (!(input instanceof Uint8Array) || input.length !== sourceSize)
    throw Error('Unexpected CAS animation source length');
  const source = new Uint8Array(input);
  if ((await digest(source)) !== expectedSha256)
    throw Error('CAS animation source identity differs');
  checkOpen(isOpen);
  const pointer = core._malloc(sourceSize);
  if (!uint(pointer) || !pointer) throw Error('Animation input allocation failed');
  try {
    const heap = core.HEAPU8;
    if (!(heap instanceof Uint8Array) || pointer > heap.length - sourceSize)
      throw Error('Animation input span is invalid');
    heap.set(source, pointer);
    if (core._openrtw_load_cas_animation(pointer, sourceSize) !== 1)
      throw Error(copyText(core, core._openrtw_error(), 4096) || 'CAS animation load refused');
  } finally {
    core._free(pointer);
  }
  checkOpen(isOpen);
  const captured = capture(core);
  if (captured.source.some((byte, i) => byte !== source[i]))
    throw Error('Published animation source differs');
  const snapshot = deepFreeze({ ...captured.value, sourceSha256: expectedSha256 });
  return Object.freeze({
    snapshot,
    sourceSha256: expectedSha256,
    get sourceBytes() {
      return source.slice();
    },
    frame(index) {
      return frameFrom(snapshot, index, expectedSha256);
    },
  });
}

// Explicit C-frame selection/readback, independent of rendering. All C JSON and
// source bytes are copied and checked before the digest await; no core access
// occurs afterward. A refused C select never falls back to a guessed frame.
export async function snapshotCasAnimationFrame(
  core,
  index,
  { isOpen = () => true, expectedSha256 = casAnimationSourceSha256 } = {}
) {
  options(isOpen, expectedSha256);
  checkOpen(isOpen);
  if (!uint(index) || index >= 21) throw RangeError('Animation frame index is outside 0..20');
  if (core._openrtw_select_cas_animation_frame(index) !== 1)
    throw Error(copyText(core, core._openrtw_error(), 4096) || 'CAS animation frame refused');
  const frame = JSON.parse(copyText(core, core._openrtw_cas_animation_frame_json())),
    captured = capture(core);
  validateFrame(frame, captured.value, index);
  if ((await digest(captured.source)) !== expectedSha256)
    throw Error('CAS animation frame source identity differs');
  checkOpen(isOpen);
  return deepFreeze({ ...frame, sourceSha256: expectedSha256 });
}
