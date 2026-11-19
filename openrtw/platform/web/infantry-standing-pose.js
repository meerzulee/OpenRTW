import { assembleCasGeometry } from '/cas-geometry.js';
import { assembleCasProfileGeometry } from '/cas-profile-geometry.js';
import { bindInfantryStandingSkeleton } from './infantry-standing-skeleton.js';

// Required, explicit presentation policy. Raw source words are never changed.
export const infantryStandingPosePolicy = Object.freeze({
  id: 'openrtw-infantry-frame0-standing-candidate-v1',
  frame: 0,
  basis: 'raw-CAS-XYZW-Hamilton-parent-times-local',
  mapping: 'ordered-slot-j-to-PLAIN-j-to-CAS-j-plus-1',
  root: 'control-triplet-at-synthetic-root',
  positionChannel: 'retained-not-applied',
  bindScale: 1,
  skeletonScale: 'retained-not-applied',
  normal: 'rigid-rotation-no-renormalization',
  geometry: 'posed-F32-centered-uniform-2.1;existing-part-colors-and-UVs',
  nativeAnimation: false,
});
const catalog = {
  roman_archer: {
    bytes: 39273,
    sha: 'e4c226d370ed061c81f0ccda7a0bc88710940935c60e3a0084db673b1f35c87f',
    raw: 'a95ddb896ccbf844a2c0fb4a6aee647c11152d99726679ce568c67df666725e9',
    version: 0x40433333,
    vertices: 125,
    triangles: 166,
    parts: 4,
    profile: null,
    frames: 21,
    clipBytes: 7093,
    clip: '1fdb03f58c9d1581f95504fd054c295b37e4a03b17b88f34d2337accaf041ee7',
    frame: '37869720865afcdc81064501fbb10c626bc4aa2acab92cbb606247711adc9b2f',
    skeletonBytes: 12017,
    skeleton: '6a4bc06a0510beb46a4b5d2bc79a1830423a232476453a8cac725990e74457a0',
  },
  roman_triarii: {
    bytes: 41173,
    sha: 'd2ab5c8f79657f374d4c23d1d02e9695b675d34672dad0999a28139ed0fcbea9',
    raw: 'd28f85e565ce0c4e624ca9888f889a49b71e79d0dc9addb5c162927feb44401a',
    version: 0x40433333,
    vertices: 171,
    triangles: 204,
    parts: 6,
    profile: null,
    frames: 11,
    clipBytes: 3733,
    clip: '3d953b72209ef5e66788abfca686b8e5dad66f730df545d38af18f47943229a3',
    frame: 'a9940bc64deb4cb54355bb6cad15eecb2ae5e8b5526e6dd0458cab459f504c0e',
    skeletonBytes: 18375,
    skeleton: '4e3c16075e5e385bdb2d2224c88ea874f0949e8edaeaa6cbebcf0890f6810535',
  },
  roman_velite: {
    bytes: 30032,
    sha: '99c39ba1447a74ee9569e9143e85029e316924216170333201e3610dc893a022',
    raw: 'c4a78d46aa4e27bdd23aa3045d45e60d7639e56dc399365cdeb51f842d818685',
    version: 0x404a3d71,
    vertices: 141,
    triangles: 167,
    parts: 5,
    profile: 'openrtw-cas316-terminal-kind7-v1',
    frames: 11,
    clipBytes: 3733,
    clip: '3d953b72209ef5e66788abfca686b8e5dad66f730df545d38af18f47943229a3',
    frame: 'a9940bc64deb4cb54355bb6cad15eecb2ae5e8b5526e6dd0458cab459f504c0e',
    skeletonBytes: 21632,
    skeleton: '54618c53db477c0cb60ebe0058787603fe3ed375a0e8560daa31017f2a8d54a7',
  },
};
const refuse = () => {
  throw Error('Unsupported infantry frame0 candidate input or policy');
};
const uint = (value) => Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
const same = (a, b) => Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i]);
const keys = (value, names) =>
  value &&
  Object.keys(value).length === names.length &&
  names.every((name) => Object.hasOwn(value, name));
const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];
function check(signal) {
  if (
    signal != null &&
    (typeof signal.aborted !== 'boolean' ||
      typeof signal.addEventListener !== 'function' ||
      typeof signal.removeEventListener !== 'function')
  )
    throw TypeError('Infantry pose signal must be an AbortSignal');
  if (signal?.aborted)
    throw signal.reason === undefined
      ? new DOMException('Infantry pose cancelled', 'AbortError')
      : signal.reason;
}
// Domain: bounded plain parsed publications. This is not an allocation-bound
// claim for arbitrary Proxies. Check array extent before traversing/allocating.
function copy(input) {
  let remaining = 50000;
  const ancestors = new Set();
  function visit(value, depth = 0) {
    if (--remaining < 0 || depth > 32) refuse();
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) refuse();
      return value;
    }
    if (typeof value === 'string') {
      if (value.length > 512) refuse();
      return value;
    }
    if (!value || typeof value !== 'object' || ancestors.has(value)) refuse();
    const array = Array.isArray(value),
      proto = Object.getPrototypeOf(value);
    if (!array && proto !== Object.prototype && proto !== null) refuse();
    ancestors.add(value);
    const out = array ? [] : Object.create(null);
    if (array) {
      const length = value.length;
      if (!Number.isInteger(length) || length < 0 || length > 20000) refuse();
      let enumerable = 0;
      for (const key in value)
        if (Object.hasOwn(value, key)) {
          if (++enumerable > length || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length)
            refuse();
        }
      for (let i = 0; i < length; i++) {
        const item = Object.getOwnPropertyDescriptor(value, String(i));
        if (!item || !('value' in item)) refuse();
        out.push(visit(item.value, depth + 1));
      }
    } else {
      let count = 0;
      for (const key in value)
        if (Object.hasOwn(value, key)) {
          if (++count > 64) refuse();
          const item = Object.getOwnPropertyDescriptor(value, key);
          if (!item || !('value' in item)) refuse();
          out[key] = visit(item.value, depth + 1);
        }
    }
    ancestors.delete(value);
    return out;
  }
  return visit(input);
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonical(value[k]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
async function digest(bytes) {
  if (!globalThis.crypto?.subtle) refuse();
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (v) =>
    v.toString(16).padStart(2, '0')
  ).join('');
}
function encoded(value) {
  const bytes = new TextEncoder().encode(canonical(value));
  if (bytes.length > 1024 * 1024) refuse();
  return bytes;
}
function words(value, count) {
  if (!Array.isArray(value) || value.length !== count || value.some((v) => !uint(v))) refuse();
}
function range(value, start, end) {
  if (
    !keys(value, ['start', 'endExclusive']) ||
    value.start !== start ||
    value.endExclusive !== end
  )
    refuse();
}
const scratch = new DataView(new ArrayBuffer(4));
function number(bits) {
  if (!uint(bits)) refuse();
  scratch.setUint32(0, bits, true);
  const value = scratch.getFloat32(0, true);
  if (!Number.isFinite(value)) refuse();
  return value;
}
function word(value) {
  if (!Number.isFinite(value) || Math.abs(value) > 3.4028234663852886e38) refuse();
  scratch.setFloat32(0, value, true);
  return scratch.getUint32(0, true);
}
function rotation(bits) {
  const q = bits.map(number),
    n2 = q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3];
  if (!Number.isFinite(n2) || n2 === 0 || Math.abs(n2 - 1) > 0.001) refuse();
  if (q[0] === 0 && q[1] === 0 && q[2] === 0 && Math.abs(q[3]) === 1) return identity.slice();
  let negative = q[3] < 0;
  if (q[3] === 0)
    for (let i = 0; i < 3; i++)
      if (q[i] !== 0) {
        negative = q[i] < 0;
        break;
      }
  const length = Math.sqrt(n2);
  for (let i = 0; i < 4; i++) {
    q[i] = (negative ? -q[i] : q[i]) / length;
    if (q[i] === 0) q[i] = 0;
  }
  const [x, y, z, w] = q;
  return [
    1 - 2 * (y * y + z * z),
    2 * (x * y - z * w),
    2 * (x * z + y * w),
    2 * (x * y + z * w),
    1 - 2 * (x * x + z * z),
    2 * (y * z - x * w),
    2 * (x * z - y * w),
    2 * (y * z + x * w),
    1 - 2 * (x * x + y * y),
  ];
}
function apply(m, v) {
  if (same(m, identity)) return v.slice();
  return [0, 1, 2].map((i) => m[i * 3] * v[0] + m[i * 3 + 1] * v[1] + m[i * 3 + 2] * v[2]);
}
function multiply(a, b) {
  if (same(a, identity)) return b.slice();
  if (same(b, identity)) return a.slice();
  return Array.from({ length: 9 }, (_, k) => {
    const i = Math.floor(k / 3),
      j = k % 3;
    return a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  });
}
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

export async function assembleInfantryStandingPose({
  modelType,
  frame,
  model,
  skeleton,
  policy,
  signal,
} = {}) {
  check(signal);
  if (typeof modelType !== 'string' || !Object.hasOwn(catalog, modelType)) refuse();
  const spec = catalog[modelType];
  const p = copy(policy),
    f = copy(frame),
    wrapper = copy(model);
  if (
    !keys(p, Object.keys(infantryStandingPosePolicy)) ||
    Object.keys(infantryStandingPosePolicy).some(
      (key) => p[key] !== infantryStandingPosePolicy[key]
    )
  )
    refuse();
  if (!keys(wrapper, ['model', 'sourceSha256']) || wrapper.sourceSha256 !== spec.sha) refuse();
  const m = wrapper.model;
  if (
    m?.sourceBytes !== spec.bytes ||
    m.versionBits !== spec.version ||
    m.totalVertices !== spec.vertices ||
    m.totalTriangles !== spec.triangles ||
    m.bones?.length !== 20 ||
    m.meshes?.length !== spec.parts ||
    (spec.profile === null
      ? Object.hasOwn(m, 'admissionProfile')
      : m.admissionProfile !== spec.profile)
  )
    refuse();
  const frameKeys = [
    'schema',
    'sourceBytes',
    'sourceSha256',
    'frameCount',
    'rotationSlotCount',
    'positionChannelCount',
    'frameIndex',
    'rotationRange',
    'positionChannelRange',
    'controlPositionRange',
    'rotationQuaternionBits',
    'positionChannelBits',
    'controlPositionBits',
    ...(spec.frames === 11 ? ['admissionProfile'] : []),
  ];
  if (
    !keys(f, frameKeys) ||
    f.schema !== 'openrtw-cas-animation-frame-v1' ||
    f.sourceBytes !== spec.clipBytes ||
    f.sourceSha256 !== spec.clip ||
    f.frameCount !== spec.frames ||
    f.rotationSlotCount !== 19 ||
    f.positionChannelCount !== 1 ||
    f.frameIndex !== 0 ||
    (spec.frames === 11 && f.admissionProfile !== 'openrtw-cas-animation-standing11-v1')
  )
    refuse();
  range(f.rotationRange, 5, 309);
  range(f.positionChannelRange, spec.frames === 21 ? 6389 : 3349, spec.frames === 21 ? 6401 : 3361);
  range(f.controlPositionRange, spec.frames === 21 ? 6801 : 3561, spec.frames === 21 ? 6813 : 3573);
  if (!Array.isArray(f.rotationQuaternionBits) || f.rotationQuaternionBits.length !== 19) refuse();
  for (const q of f.rotationQuaternionBits) {
    words(q, 4);
    rotation(q);
  }
  words(f.positionChannelBits, 3);
  words(f.controlPositionBits, 3);
  f.positionChannelBits.forEach(number);
  f.controlPositionBits.forEach(number);
  // Existing private WeakSet provenance admits the real frozen provider object.
  // Only this known fresh-copy getter is read; no generic accessor traversal.
  const binding = bindInfantryStandingSkeleton(skeleton, m);
  if (
    skeleton.modelType !== modelType ||
    skeleton.sourceBytesCount !== spec.skeletonBytes ||
    skeleton.sourceSha256 !== spec.skeleton ||
    skeleton.scaleBits !== 1065353216 ||
    binding.orderedParentsEqual !== 19 ||
    binding.rawPoseTriplesEqual !== 1
  )
    refuse();
  const source = skeleton.sourceBytes;
  if (!(source instanceof Uint8Array) || source.length !== spec.skeletonBytes) refuse();
  const sourceCopy = source.slice();
  const s = copy({
    schema: skeleton.schema,
    modelType,
    sourceBytesCount: skeleton.sourceBytesCount,
    sourceSha256: skeleton.sourceSha256,
    sourceVersionBranch: skeleton.sourceVersionBranch,
    scaleBits: skeleton.scaleBits,
    parents: skeleton.parents,
    modelBoneIds: skeleton.modelBoneIds,
    nodes: skeleton.nodes,
    headerRange: skeleton.headerRange,
    nodesRange: skeleton.nodesRange,
    translationRightsCount: skeleton.translationRightsCount,
    ikLerpFractionBits: skeleton.ikLerpFractionBits,
    exactEOF: skeleton.exactEOF,
    sourceF32Words: skeleton.sourceF32Words,
    noNodeNamesStored: skeleton.noNodeNamesStored,
    rootConvention: skeleton.rootConvention,
  });
  const rows = copy(binding.rows);
  for (let i = 0; i < 20; i++) {
    const b = m.bones[i];
    if (
      b.id !== i ||
      !uint(b.parent) ||
      (i === 0 ? b.parent !== 0 : b.parent >= i) ||
      (i > 0 && (s.parents[i - 1] !== b.parent - 1 || s.modelBoneIds[i - 1] !== i))
    )
      refuse();
  }
  if (!m.bones[0].bindLocalBits.every((v) => v === 0)) refuse();
  const geometry = spec.profile ? assembleCasProfileGeometry(m) : assembleCasGeometry(m);
  const raw = copy(m);
  for (const b of raw.bones) delete b.candidateBindWorld;
  for (const part of raw.meshes) delete part.candidateBindPositions;
  const [rawHash, frameHash, skeletonHash] = await Promise.all([
    digest(encoded(raw)),
    digest(encoded(f)),
    digest(sourceCopy),
  ]);
  check(signal);
  if (rawHash !== spec.raw || frameHash !== spec.frame || skeletonHash !== spec.skeleton) refuse();
  const bones = [];
  for (let i = 0; i < 20; i++) {
    const b = m.bones[i];
    let r, t;
    if (i === 0) {
      r = identity.slice();
      t = f.controlPositionBits.map(number);
    } else {
      const parent = bones[b.parent];
      r = multiply(parent.worldRotation, rotation(f.rotationQuaternionBits[i - 1]));
      t = apply(parent.worldRotation, b.bindLocalBits.map(number)).map(
        (v, k) => v + parent.worldTranslation[k]
      );
    }
    if ([...r, ...t].some((v) => !Number.isFinite(v))) refuse();
    bones.push({ id: i, parent: b.parent, worldRotation: r, worldTranslation: t });
  }
  const parts = m.meshes.map((part) => {
    const positions = [],
      normals = [];
    for (let i = 0; i < part.vertices; i++) {
      const b = bones[part.boneIndices[i]],
        point = apply(b.worldRotation, part.positionBits.slice(i * 3, i * 3 + 3).map(number)),
        normal = apply(b.worldRotation, part.normalBits.slice(i * 3, i * 3 + 3).map(number));
      for (let k = 0; k < 3; k++) {
        positions.push(word(point[k] + b.worldTranslation[k]));
        normals.push(
          same(b.worldRotation, identity) ? part.normalBits[i * 3 + k] : word(normal[k])
        );
      }
    }
    return {
      name: part.name,
      chunkKind: part.chunkKind,
      vertices: part.vertices,
      triangles: part.triangles,
      positionBits: positions,
      normalBits: normals,
      sourcePositionBits: part.positionBits.slice(),
      sourceNormalBits: part.normalBits.slice(),
      uvBits: part.uvBits.slice(),
      boneIndices: part.boneIndices.slice(),
      indices: part.indices.slice(),
      extra1: part.extra1.slice(),
      extra2: part.extra2.slice(),
      ...(Object.hasOwn(part, 'vertexColorBytes')
        ? {
            vertexColorFlag: part.vertexColorFlag,
            vertexColorBytes: part.vertexColorBytes.slice(),
            colorRange: { ...part.colorRange },
          }
        : {}),
    };
  });
  const bounds = [
    [Infinity, Infinity, Infinity],
    [-Infinity, -Infinity, -Infinity],
  ];
  for (const part of parts)
    for (let i = 0; i < part.positionBits.length; i++) {
      const value = number(part.positionBits[i]),
        axis = i % 3;
      bounds[0][axis] = Math.min(bounds[0][axis], value);
      bounds[1][axis] = Math.max(bounds[1][axis], value);
    }
  const center = bounds[0].map((v, k) => (v + bounds[1][k]) / 2),
    extent = Math.max(...bounds[0].map((v, k) => bounds[1][k] - v));
  if (!Number.isFinite(extent) || extent <= 0) refuse();
  const vertices = geometry.vertices.slice(),
    view = new DataView(vertices.buffer, vertices.byteOffset, vertices.byteLength),
    finalXYZF32Bits = [],
    normalizedBounds = [
      [Infinity, Infinity, Infinity],
      [-Infinity, -Infinity, -Infinity],
    ];
  let vertex = 0;
  for (const part of parts)
    for (let i = 0; i < part.positionBits.length; i += 3, vertex++)
      for (let axis = 0; axis < 3; axis++) {
        const value = ((number(part.positionBits[i + axis]) - center[axis]) * 2.1) / extent;
        view.setUint32(vertex * 24 + axis * 4, word(value), true);
        finalXYZF32Bits.push(view.getUint32(vertex * 24 + axis * 4, true));
        const packed = view.getFloat32(vertex * 24 + axis * 4, true);
        normalizedBounds[0][axis] = Math.min(normalizedBounds[0][axis], packed);
        normalizedBounds[1][axis] = Math.max(normalizedBounds[1][axis], packed);
      }
  check(signal);
  const pose = freeze({
    schema: 'openrtw-infantry-standing-pose-v1',
    modelType,
    frameIndex: 0,
    nativeAnimation: false,
    policy: p,
    modelAdmissionProfile: spec.profile,
    sourceSha256: { model: spec.sha, animation: spec.clip, skeleton: spec.skeleton },
    sourceFingerprints: { rawModel: rawHash, frame0: frameHash },
    rawRootMovementBits: f.controlPositionBits.slice(),
    rawPositionChannelBits: f.positionChannelBits.slice(),
    skeleton: s,
    bindingRows: rows,
    orderedParentsEqual: 19,
    retainedBindTripleMismatches: 18,
    bones,
    parts,
    bounds,
    normalization: {
      center,
      extent,
      height: 2.1,
      scale: 2.1 / extent,
      operation: '(posedF32-center)*2.1/extent;finalF32',
    },
    posedXYZF32Bits: parts.flatMap((part) => part.positionBits),
    posedNormalF32Bits: parts.flatMap((part) => part.normalBits),
    finalXYZF32Bits,
  });
  return Object.freeze({
    pose,
    geometry: Object.freeze({
      ...geometry,
      vertices,
      indexBytes: geometry.indexBytes.slice(),
      parts: freeze(copy(geometry.parts)),
      bounds: freeze(bounds.map((row) => row.slice())),
      normalizedBounds: freeze(normalizedBounds),
    }),
    presentationPolicy: infantryStandingPosePolicy,
    get skeletonSourceBytes() {
      return sourceCopy.slice();
    },
  });
}
