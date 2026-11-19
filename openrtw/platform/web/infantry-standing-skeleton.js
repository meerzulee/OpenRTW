// Source-bound PLAIN v3 field reader. Converter labels describe the bytes;
// they do not establish native pose, Boolean, scale or clip-slot semantics.
const freeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
};
export const infantryStandingSkeletonDescriptors = freeze({
  roman_archer: {
    assetName: 'archerSkeleton',
    memberName: 'fs_semi_fast_archer',
    sourceBytes: 12017,
    sourceSha256: '6a4bc06a0510beb46a4b5d2bc79a1830423a232476453a8cac725990e74457a0',
    modelSourceBytes: 39273,
    modelSourceSha256: 'e4c226d370ed061c81f0ccda7a0bc88710940935c60e3a0084db673b1f35c87f',
    modelVersionBits: 0x40433333,
  },
  roman_triarii: {
    assetName: 'spearmanSkeleton',
    memberName: 'fs_slow_spearman',
    sourceBytes: 18375,
    sourceSha256: '4e3c16075e5e385bdb2d2224c88ea874f0949e8edaeaa6cbebcf0890f6810535',
    modelSourceBytes: 41173,
    modelSourceSha256: 'd2ab5c8f79657f374d4c23d1d02e9695b675d34672dad0999a28139ed0fcbea9',
    modelVersionBits: 0x40433333,
  },
  roman_velite: {
    assetName: 'javelinSkeleton',
    memberName: 'fs_semi_fast_javelinman',
    sourceBytes: 21632,
    sourceSha256: '54618c53db477c0cb60ebe0058787603fe3ed375a0e8560daa31017f2a8d54a7',
    modelSourceBytes: 30032,
    modelSourceSha256: '99c39ba1447a74ee9569e9143e85029e316924216170333201e3610dc893a022',
    modelVersionBits: 0x404a3d71,
  },
});
const bindings = new WeakSet();
function descriptor(modelType) {
  if (
    typeof modelType !== 'string' ||
    !Object.hasOwn(infantryStandingSkeletonDescriptors, modelType)
  )
    throw new Error('Unknown infantry standing skeleton model');
  return infantryStandingSkeletonDescriptors[modelType];
}
function check(signal) {
  if (
    signal !== undefined &&
    signal !== null &&
    (typeof signal.aborted !== 'boolean' ||
      typeof signal.addEventListener !== 'function' ||
      typeof signal.removeEventListener !== 'function')
  )
    throw new TypeError('Skeleton signal must be an AbortSignal');
  if (signal?.aborted)
    throw signal.reason ?? new DOMException('Infantry skeleton read aborted', 'AbortError');
}
const hash = async (bytes) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (v) =>
    v.toString(16).padStart(2, '0')
  ).join('');
const hex = (bytes) => Array.from(bytes, (v) => v.toString(16).padStart(2, '0')).join('');

// This explicitly structural entry is bounded to the selected maximum extent.
// It makes no source-identity/admission claim; parseInfantryStandingSkeleton is
// the runtime source-bound entry. Keeping the grammar separate permits refusal
// checks that reach the actual field guards rather than only the SHA guard.
export function decodeInfantryStandingSkeletonFields(input) {
  if (!(input instanceof Uint8Array) || input.byteLength < 782 || input.byteLength > 21632)
    throw new Error('Unsupported bounded PLAIN skeleton extent');
  const bytes = new Uint8Array(input),
    view = new DataView(bytes.buffer),
    fields = [];
  let offset = 0,
    floatWords = 0;
  const range = (start, endExclusive) => ({ start, endExclusive });
  function take(path, length, kind, decode) {
    const start = offset;
    if (!Number.isSafeInteger(length) || length < 0 || length > bytes.length - start)
      throw new Error(`Incomplete PLAIN field: ${path}`);
    const end = start + length,
      value = decode(start, end),
      field = {
        path,
        range: range(start, end),
        kind,
        rawHex: hex(bytes.subarray(start, end)),
        value,
      };
    fields.push(field);
    offset = end;
    return field;
  }
  const u32 = (path) => take(path, 4, 'I', (s) => view.getUint32(s, true));
  const i32 = (path) => take(path, 4, 'i', (s) => view.getInt32(s, true));
  const u16 = (path) => take(path, 2, 'H', (s) => view.getUint16(s, true));
  const i16 = (path) => take(path, 2, 'h', (s) => view.getInt16(s, true));
  function f32(path) {
    const field = take(path, 4, 'sourceF32', (s) => {
      const number = view.getFloat32(s, true);
      if (!Number.isFinite(number)) throw new Error(`Nonfinite PLAIN field: ${path}`);
      return { bits: view.getUint32(s, true), number };
    });
    floatWords++;
    return field;
  }
  const vector = (path) => [0, 1, 2].map((i) => f32(`${path}[${i}]`));
  const bool = (path) =>
    take(path, 1, 'sourceBoolByte', (s) => ({ raw: bytes[s], nonzero: bytes[s] !== 0 }));
  function string(path) {
    let end = offset;
    const bound = Math.min(bytes.length, offset + 512);
    while (end < bound && bytes[end] !== 0) end++;
    if (end === bound) throw new Error(`Missing bounded PLAIN NUL string: ${path}`);
    return take(path, end - offset + 1, 'sourceNulString', (s, e) => {
      let utf8 = null;
      try {
        utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
          bytes.subarray(s, e - 1)
        );
      } catch {}
      return { utf8, payloadBytes: e - s - 1 };
    });
  }
  function params(prefix) {
    const out = {
      deltaRot: i16(prefix + '.deltaRot'),
      deltaImpact: vector(prefix + '.deltaImpact'),
      deltaAngle: i16(prefix + '.deltaAngle'),
      deltaLength: f32(prefix + '.deltaLength'),
      impactFrame: u16(prefix + '.impactFrame'),
      impactDist: f32(prefix + '.impactDist'),
      minTurnDel: i16(prefix + '.minTurnDel'),
      maxTurnDel: i16(prefix + '.maxTurnDel'),
      launchDir: vector(prefix + '.launchDir'),
      eventCount: u32(prefix + '.eventCount'),
      events: [],
    };
    if (out.eventCount.value > 128) throw new Error('PLAIN event count exceeds 128');
    for (let i = 0; i < out.eventCount.value; i++) {
      const p = `${prefix}.events[${i}]`;
      out.events.push({
        type: u32(p + '.type'),
        startFrame: u16(p + '.startFrame'),
        endFrame: u16(p + '.endFrame'),
        id: string(p + '.id'),
        randomFrame: bool(p + '.randomFrame'),
        looped: bool(p + '.looped'),
      });
    }
    return out;
  }
  const header = {
    scale: f32('header.scale'),
    nodeCount: u16('header.nodeCount'),
    translationRights: u16('header.translationRights'),
    ikLerpFraction: f32('header.ikLerpFraction'),
  };
  if (header.nodeCount.value !== 19)
    throw new Error('PLAIN skeleton requires exactly 19 ordered nodes');
  const nodes = [];
  for (let slot = 0; slot < 19; slot++) {
    const p = `nodes[${slot}]`,
      start = offset,
      type = u32(p + '.type'),
      poseFields = vector(p + '.pose'),
      parent = i32(p + '.parent'),
      translation = bool(p + '.hasTranslation'),
      ik = bool(p + '.applyIK'),
      ignored = take(p + '.ignored', 2, 'sourceIgnoredBytes', (s, e) =>
        Array.from(bytes.subarray(s, e))
      );
    if (parent.value < -1 || parent.value >= slot)
      throw new Error('Unsupported PLAIN ordered parent');
    nodes.push({
      slot,
      modelBoneId: slot + 1,
      sourceRange: range(start, offset),
      attachmentType: type.value,
      poseBits: poseFields.map((f) => f.value.bits),
      pose: poseFields.map((f) => f.value.number),
      poseRange: range(start + 4, start + 16),
      parentIndex: parent.value,
      parentRange: parent.range,
      hasTranslationRaw: translation.value.raw,
      applyIkRaw: ik.value.raw,
      flagsRange: range(start + 20, start + 22),
      sourceSkippedOpaqueBytes: ignored.value,
      sourceSkippedOpaqueRange: ignored.range,
    });
  }
  const animationSlots = [];
  for (let slot = 0; slot < 300; slot++) {
    const p = `animationSlots[${slot}]`,
      start = offset,
      path = string(p + '.path');
    animationSlots.push({
      slot,
      path,
      params: path.value.payloadBytes ? params(p + '.params') : null,
      range: range(start, offset),
    });
  }
  const tail = {
    walkSpeed: f32('tail.walkSpeed'),
    runSpeed: f32('tail.runSpeed'),
    chargeSpeed: f32('tail.chargeSpeed'),
    canMissile: bool('tail.canMissile'),
    canIpTurn: bool('tail.canIpTurn'),
  };
  if (offset !== bytes.length) throw new Error('PLAIN skeleton has unparsed trailing bytes');
  const result = {
    schema: 'openrtw-infantry-plain-fields-v1',
    sourceBytesCount: bytes.length,
    sourceVersionBranch: 3,
    headerRange: range(0, 12),
    nodesRange: range(12, 468),
    header,
    nodeCount: 19,
    scaleBits: header.scale.value.bits,
    scale: header.scale.value.number,
    translationRightsCount: header.translationRights.value,
    ikLerpFractionBits: header.ikLerpFraction.value.bits,
    ikLerpFraction: header.ikLerpFraction.value.number,
    parents: nodes.map((n) => n.parentIndex),
    modelBoneIds: nodes.map((n) => n.modelBoneId),
    nodes,
    animationSlots,
    tail,
    fields,
    exactEOF: offset,
    sourceF32Words: floatWords,
    noNodeNamesStored: true,
    nativePoseBasisProven: false,
    rootConvention:
      'Diagnostic only: PLAIN slot i corresponds to candidate CAS ID i+1 after omitting CAS ID0; compare parent with CAS parent minus1.',
  };
  Object.defineProperty(result, 'sourceBytes', { enumerable: true, get: () => bytes.slice() });
  // sourceBytes is an owned-copy getter; never traverse/freeze a typed array.
  for (const [key, value] of Object.entries(result)) if (key !== 'sourceBytes') freeze(value);
  return Object.freeze(result);
}

export async function parseInfantryStandingSkeleton(modelType, input, { signal } = {}) {
  const spec = descriptor(modelType);
  check(signal);
  if (!(input instanceof Uint8Array) || input.byteLength !== spec.sourceBytes)
    throw new Error('Selected infantry skeleton has an unexpected length');
  // Buffer.slice() aliases its producer and retains a pool-relative byte offset.
  const bytes = new Uint8Array(input); // Own the exact view before the digest await.
  const actual = await hash(bytes);
  check(signal);
  if (actual !== spec.sourceSha256)
    throw new Error('Selected infantry skeleton differs from the verified source');
  const fields = decodeInfantryStandingSkeletonFields(bytes);
  check(signal);
  const result = {
    ...fields,
    schema: 'openrtw-infantry-standing-skeleton-v1',
    modelType,
    sourceSha256: spec.sourceSha256,
    sourceBinding: spec,
  };
  delete result.sourceBytes;
  Object.defineProperty(result, 'sourceBytes', { enumerable: true, get: () => fields.sourceBytes });
  Object.freeze(result);
  bindings.add(result);
  return result;
}

// A synchronous, copied diagnostic join for already source-verified CAS JSON.
// Model hash verification belongs to the model loader; JSON dimensions alone
// cannot prove source identity or native pose equivalence.
export function bindInfantryStandingSkeleton(binding, model) {
  if (!bindings.has(binding))
    throw new Error('Binding requires a source-verified infantry skeleton');
  const spec = descriptor(binding.modelType);
  if (
    !model ||
    model.sourceBytes !== spec.modelSourceBytes ||
    model.versionBits !== spec.modelVersionBits ||
    !Array.isArray(model.bones) ||
    model.bones.length !== 20
  )
    throw new Error('Binding requires the selected 20-bone CAS shape');
  const rows = [];
  for (let id = 0; id < 20; id++) {
    const bone = model.bones[id];
    if (
      !bone ||
      bone.id !== id ||
      !Number.isInteger(bone.parent) ||
      bone.parent < 0 ||
      bone.parent >= (id || 1) ||
      typeof bone.name !== 'string' ||
      bone.name.length > 512 ||
      !Array.isArray(bone.bindLocalBits) ||
      bone.bindLocalBits.length !== 3 ||
      ![0, 1, 2].every(
        (i) =>
          Object.hasOwn(bone.bindLocalBits, i) &&
          Number.isInteger(bone.bindLocalBits[i]) &&
          bone.bindLocalBits[i] >= 0 &&
          bone.bindLocalBits[i] <= 0xffffffff &&
          ((bone.bindLocalBits[i] >>> 23) & 255) !== 255
      )
    )
      throw new Error('Invalid ordered CAS bind metadata');
    if (id === 0) {
      if (bone.parent !== 0 || bone.bindLocalBits.some((word) => word !== 0))
        throw new Error('Unsupported omitted CAS root');
      continue;
    }
    const node = binding.nodes[id - 1];
    if (bone.parent - 1 !== node.parentIndex) throw new Error('PLAIN/CAS ordered parent mismatch');
    const bindLocalBits = bone.bindLocalBits.slice(),
      plainPoseBits = node.poseBits.slice();
    rows.push({
      plainSlot: id - 1,
      modelBoneId: id,
      casOnlyName: bone.name,
      parentIndex: node.parentIndex,
      plainPoseBits,
      bindLocalBits,
      rawWordsEqual: plainPoseBits.every((word, i) => word === bindLocalBits[i]),
    });
  }
  return freeze({
    schema: 'openrtw-infantry-standing-diagnostic-binding-v1',
    modelType: binding.modelType,
    skeleton: binding,
    rows,
    orderedParentsEqual: 19,
    rawPoseTriplesEqual: rows.filter((row) => row.rawWordsEqual).length,
    modelSourceVerification:
      'Required from the caller model loader; this join verifies copied JSON shape/order only.',
    nativePoseBasisProven: false,
  });
}
