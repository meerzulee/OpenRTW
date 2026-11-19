import { loadCasAnimation, snapshotCasAnimationFrame } from './cas-animation.js';

// Explicit raw-source identities. These describe selected source files, without
// assigning skeleton slots, root/control policy, scale, timing, or a native pose.
export const infantryStanding11Descriptor = Object.freeze({
  sourceId: 'infantry-standing-lis-361',
  memberName: 'data/animations/LIS 01 Stand Idle.cas',
  sourceBytes: 3733,
  sourceSha256: '3d953b72209ef5e66788abfca686b8e5dad66f730df545d38af18f47943229a3',
  frameCount: 11,
  rotationSlotCount: 19,
  positionChannelCount: 1,
  admissionProfile: 'openrtw-cas-animation-standing11-v1',
});
export const infantryStandingLid21Descriptor = Object.freeze({
  sourceId: 'infantry-standing-lid-224',
  memberName: 'data/animations/LID_01_Standing idle new actor.cas',
  sourceBytes: 7093,
  sourceSha256: '1fdb03f58c9d1581f95504fd054c295b37e4a03b17b88f34d2337accaf041ee7',
  frameCount: 21,
  rotationSlotCount: 19,
  positionChannelCount: 1,
});
const selected = infantryStanding11Descriptor,
  jsonLimit = 64 * 1024;
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
  [5, 3349],
  [3349, 3481],
  [3481, 3541],
  [3541, 3561],
  [3561, 3693],
  [3693, 3725],
  [3725, 3733],
  [3725, 3729],
  [3729, 3733],
];
const wordNames = [
  'rotationQuaternionBits',
  'positionChannelBits',
  'doubledIncrementBits',
  'doubledDistanceBits',
  'controlPositionBits',
  'tailFloatBits',
];
const counts = [836, 33, 15, 5, 33, 8],
  starts = [5, 3349, 3481, 3541, 3561, 3693];
const uint = (value) => Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
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
function capability(core, profile = 'standing11') {
  const loader =
    profile === 'standing11'
      ? '_openrtw_load_cas_animation_standing11'
      : '_openrtw_load_cas_animation';
  if (!core || typeof core[loader] !== 'function')
    throw Error(`Explicit ${profile} animation export is unavailable`);
  for (const name of [
    '_malloc',
    '_free',
    '_openrtw_cas_animation_json',
    '_openrtw_cas_animation_source_bytes',
    '_openrtw_cas_animation_source_size',
    '_openrtw_select_cas_animation_frame',
    '_openrtw_cas_animation_frame_json',
    '_openrtw_error',
  ])
    if (typeof core[name] !== 'function') throw Error('Incomplete infantry animation bridge');
}
function owner(options) {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(options)) ||
    Object.keys(options).some((key) => key !== 'isOpen')
  )
    throw TypeError('Invalid infantry animation options');
  const isOpen = Object.hasOwn(options, 'isOpen') ? options.isOpen : () => true;
  if (typeof isOpen !== 'function') throw TypeError('Invalid infantry animation owner');
  return isOpen;
}
function checkOpen(isOpen) {
  if (!isOpen()) throw new DOMException('Infantry animation loading cancelled', 'AbortError');
}
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function text(core, pointer, limit = jsonLimit) {
  const heap = core.HEAPU8;
  if (!(heap instanceof Uint8Array) || !uint(pointer) || !pointer || pointer >= heap.length)
    throw Error('Invalid infantry animation JSON pointer');
  const bytes = heap.slice(pointer, Math.min(heap.length, pointer + limit + 1)),
    end = bytes.indexOf(0);
  if (end < 0 || end > limit) throw Error('Infantry animation JSON exceeds its bound');
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end));
}
function sourceCopy(core) {
  const pointer = core._openrtw_cas_animation_source_bytes(),
    size = core._openrtw_cas_animation_source_size(),
    heap = core.HEAPU8;
  if (
    !(heap instanceof Uint8Array) ||
    !uint(pointer) ||
    !pointer ||
    size !== selected.sourceBytes ||
    pointer > heap.length - size
  )
    throw Error('Invalid infantry animation source span');
  return heap.slice(pointer, pointer + size);
}
function envelope(value, schema) {
  return (
    value.schema === schema &&
    value.admissionProfile === selected.admissionProfile &&
    value.sourceBytes === 3733 &&
    value.frameCount === 11 &&
    value.rotationSlotCount === 19 &&
    value.positionChannelCount === 1
  );
}
function validateSource(source) {
  if (source.length !== 3733) throw Error('Infantry animation source length differs');
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
  if (
    view.getUint16(0, true) !== 11 ||
    view.getUint16(2, true) !== 19 ||
    source[4] !== 1 ||
    source[3725] !== 1 ||
    source.subarray(3726).some((v) => v !== 0)
  )
    throw Error('Infantry animation source profile differs');
  for (let field = 0; field < counts.length; field++)
    for (let i = 0; i < counts[field]; i++)
      if ((view.getUint32(starts[field] + i * 4, true) & 0x7f800000) === 0x7f800000)
        throw Error('Infantry animation contains nonfinite words');
  for (let start = 5; start < 3349; start += 16) {
    let norm = 0;
    for (let k = 0; k < 4; k++) {
      const v = view.getFloat32(start + k * 4, true);
      norm += v * v;
    }
    if (!Number.isFinite(norm) || norm === 0 || Math.abs(norm - 1) > 0.001)
      throw Error('Infantry animation quaternion admission differs');
  }
  return view;
}
function validateFull(value, source) {
  if (
    !keys(value, [
      'schema',
      'admissionProfile',
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
    throw Error('Infantry animation projection envelope differs');
  const view = validateSource(source);
  for (let i = 0; i < rangeNames.length; i++)
    if (!range(value[rangeNames[i]], ...ranges[i])) throw Error('Infantry animation range differs');
  for (let field = 0; field < wordNames.length; field++) {
    const words = value[wordNames[field]];
    if (!Array.isArray(words) || words.length !== counts[field])
      throw Error('Infantry animation word count differs');
    for (let i = 0; i < words.length; i++)
      if (!uint(words[i]) || words[i] !== view.getUint32(starts[field] + i * 4, true))
        throw Error('Infantry animation raw source words differ');
  }
  if (!Array.isArray(value.trailingBytes) || value.trailingBytes.length !== 8)
    throw Error('Infantry animation ending length differs');
  for (let i = 0; i < 8; i++)
    if (value.trailingBytes[i] !== source[3725 + i])
      throw Error('Infantry animation ending bytes differ');
  return value;
}
function frameFrom(full, index, sourceSha256) {
  if (!uint(index) || index >= 11)
    throw RangeError('Infantry animation frame index is outside 0..10');
  const at = index * 76;
  return freeze({
    schema: 'openrtw-cas-animation-frame-v1',
    admissionProfile: selected.admissionProfile,
    sourceBytes: 3733,
    frameCount: 11,
    rotationSlotCount: 19,
    positionChannelCount: 1,
    frameIndex: index,
    rotationRange: { start: 5 + index * 304, endExclusive: 5 + (index + 1) * 304 },
    positionChannelRange: { start: 3349 + index * 12, endExclusive: 3349 + (index + 1) * 12 },
    controlPositionRange: { start: 3561 + index * 12, endExclusive: 3561 + (index + 1) * 12 },
    rotationQuaternionBits: Array.from({ length: 19 }, (_, slot) =>
      full.rotationQuaternionBits.slice(at + slot * 4, at + (slot + 1) * 4)
    ),
    positionChannelBits: full.positionChannelBits.slice(index * 3, index * 3 + 3),
    controlPositionBits: full.controlPositionBits.slice(index * 3, index * 3 + 3),
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
    throw Error('Infantry animation frame envelope differs');
  for (const name of ['rotationRange', 'positionChannelRange', 'controlPositionRange'])
    if (!range(frame[name], expected[name].start, expected[name].endExclusive))
      throw Error('Infantry animation frame range differs');
  if (!Array.isArray(frame.rotationQuaternionBits) || frame.rotationQuaternionBits.length !== 19)
    throw Error('Infantry animation frame slots differ');
  for (let slot = 0; slot < 19; slot++) {
    const q = frame.rotationQuaternionBits[slot];
    if (!Array.isArray(q) || q.length !== 4)
      throw Error('Infantry animation frame quaternion shape differs');
    for (let k = 0; k < 4; k++)
      if (q[k] !== expected.rotationQuaternionBits[slot][k])
        throw Error('Infantry animation frame raw words differ');
  }
  for (const name of ['positionChannelBits', 'controlPositionBits']) {
    if (!Array.isArray(frame[name]) || frame[name].length !== 3)
      throw Error('Infantry animation frame channel shape differs');
    for (let k = 0; k < 3; k++)
      if (frame[name][k] !== expected[name][k])
        throw Error('Infantry animation frame channel words differ');
  }
  return frame;
}
function capture(core) {
  // Refresh the heap after getters: C calls may grow/reallocate memory. Copies
  // and source-word joins complete synchronously, before any digest await.
  const json = text(core, core._openrtw_cas_animation_json()),
    source = sourceCopy(core);
  return { source, value: validateFull(JSON.parse(json), source) };
}
function decorated(clip, descriptor) {
  return Object.freeze({
    snapshot: clip.snapshot,
    sourceDescriptor: descriptor,
    sourceSha256: descriptor.sourceSha256,
    get sourceBytes() {
      return clip.sourceBytes;
    },
    frame(index) {
      return clip.frame(index);
    },
  });
}

export async function loadInfantryStanding11(core, input, options = {}) {
  capability(core);
  const isOpen = owner(options);
  checkOpen(isOpen);
  if (!(input instanceof Uint8Array) || input.length !== 3733)
    throw Error('Unexpected standing11 animation source length');
  const source = new Uint8Array(input);
  if ((await digest(source)) !== selected.sourceSha256)
    throw Error('Standing11 animation source identity differs');
  checkOpen(isOpen);
  const pointer = core._malloc(3733);
  if (!uint(pointer) || !pointer) throw Error('Infantry animation input allocation failed');
  let hasFailure = false,
    failure;
  try {
    const heap = core.HEAPU8;
    if (!(heap instanceof Uint8Array) || pointer > heap.length - 3733)
      throw Error('Infantry animation input span is invalid');
    heap.set(source, pointer);
    if (core._openrtw_load_cas_animation_standing11(pointer, 3733) !== 1)
      throw Error(text(core, core._openrtw_error(), 4096) || 'Standing11 animation load refused');
  } catch (error) {
    hasFailure = true;
    failure = error;
  }
  // A throwing cleanup must not replace the original failure, even when that
  // thrown value is false, zero, null, or undefined. Cleanup still runs once.
  try {
    core._free(pointer);
  } catch (error) {
    if (!hasFailure) {
      hasFailure = true;
      failure = error;
    }
  }
  if (hasFailure) throw failure;
  checkOpen(isOpen);
  const captured = capture(core);
  for (let i = 0; i < 3733; i++)
    if (captured.source[i] !== source[i])
      throw Error('Published infantry animation source differs');
  const snapshot = freeze({ ...captured.value, sourceSha256: selected.sourceSha256 });
  const frames = Array.from({ length: 11 }, (_, index) =>
    frameFrom(snapshot, index, selected.sourceSha256)
  );
  return decorated(
    {
      snapshot,
      get sourceBytes() {
        return source.slice();
      },
      frame(index) {
        if (!uint(index) || index >= 11)
          throw RangeError('Infantry animation frame index is outside 0..10');
        return frames[index];
      },
    },
    selected
  );
}

// Explicit native readback. No C call or borrowed heap span survives the await.
export async function snapshotInfantryStanding11Frame(core, index, options = {}) {
  capability(core);
  const isOpen = owner(options);
  checkOpen(isOpen);
  if (!uint(index) || index >= 11)
    throw RangeError('Infantry animation frame index is outside 0..10');
  if (core._openrtw_select_cas_animation_frame(index) !== 1)
    throw Error(text(core, core._openrtw_error(), 4096) || 'Standing11 animation frame refused');
  const frame = JSON.parse(text(core, core._openrtw_cas_animation_frame_json())),
    captured = capture(core);
  validateFrame(frame, captured.value, index);
  if ((await digest(captured.source)) !== selected.sourceSha256)
    throw Error('Standing11 animation frame source identity differs');
  checkOpen(isOpen);
  return freeze({ ...frame, sourceSha256: selected.sourceSha256 });
}

// LID224 is a different exact source from SG491. Reuse every existing 21-frame
// structural guard with its explicit LID digest; the default SG module is intact.
export async function loadInfantryStandingLid21(core, input, options = {}) {
  capability(core, 'lid21');
  const isOpen = owner(options);
  checkOpen(isOpen);
  const clip = await loadCasAnimation(core, input, {
    isOpen,
    expectedSha256: infantryStandingLid21Descriptor.sourceSha256,
  });
  checkOpen(isOpen);
  return decorated(clip, infantryStandingLid21Descriptor);
}
export async function snapshotInfantryStandingLid21Frame(core, index, options = {}) {
  capability(core, 'lid21');
  const isOpen = owner(options);
  checkOpen(isOpen);
  return snapshotCasAnimationFrame(core, index, {
    isOpen,
    expectedSha256: infantryStandingLid21Descriptor.sourceSha256,
  });
}
