import { assembleCasGeometry } from '/cas-geometry.js';

// Explicit source-bound presentation policy. The optional campaign idle adapter
// selects this tested static frame; this is not native animation playback.
export const campaignStandingPosePolicy = Object.freeze({
  id: 'openrtw-sg01-frame0-standing-candidate-v1',
  frame: 0,
  basis: 'raw-CAS-XYZW-Hamilton-parent-times-local',
  mapping: 'ordered-slot-j-to-officer-bone-j-plus-1',
  root: 'control-triplet-at-synthetic-root',
  bindScale: 1,
  skeletonScale: 'retained-not-applied',
  normal: 'rigid-rotation-no-renormalization',
  geometry: 'posed-F32-centered-uniform-2.1;existing-part-colors-and-UVs',
  nativeAnimation: false,
});
export const campaignStandingPoseSources = Object.freeze({
  animation: Object.freeze({
    bytes: 7093,
    sha256: '95e15f90bdca0a522d9de67cfcd2e461386f9d91acadb840aef6af417e052428',
    frame0Sha256: 'f59ce3b2b0e67e55310979b751a236d3de0ae13a731075b1e09bc3303b0184b6',
  }),
  model: Object.freeze({
    bytes: 52401,
    sha256: 'a85699cad84e0b5fa154f88efcf1d720dc10232612767f92937b4f788b1a3e0c',
    rawFieldsSha256: 'f80d01895ac38e44c688c40c88e9df97d543a6d3ed6f421260c8c961849b231a',
  }),
  skeleton: Object.freeze({
    bytes: 6126,
    sha256: '782957130e332911519cdd5bbf7d16e030b93287e312d7f8222481ad0427e0e8',
    scaleBits: 1060320051,
  }),
});
export const campaignMarchPosePolicy = Object.freeze({
  ...campaignStandingPosePolicy,
  id: 'openrtw-sg03-source-march-loop-v1',
  frame: 'verified-0-through-20',
  root: 'control-vertical-only;checked-campaign-route-owns-XZ-translation',
  geometry: 'posed-F32-fixed-SG01-center-and-uniform-2.1;existing-colors-and-UVs',
});
export const campaignMarchPoseSources = Object.freeze({
  bytes: 7093,
  sha256: 'eba2096628f2f287ba031dd7faa899010d369242f6c1c9e72c179b4afb7752ed',
  frameSha256: Object.freeze([
    'ace0798f7da1d6cfb00822773916f0922023563f02300a04de9e89655e86dbd8',
    '089bbeb128f9b57512baf769bf13884b0d13404d65f54e71e714e85fca8cc095',
    '8153df6c15cc7bc489ff3d8eb2f0b279072e959f1181463262bee2b287283b68',
    '1e241702a936d15aff17ce64fe7d7f7ffda542051a2a434c0543a7606d419e16',
    'b27d893c9173499efe934177b54b86b91b2388065e75fdba0ded37d1ac0518e0',
    '0a971ec9735bee54e6a826ca1c800b5e5fa47f766f1ffb8e6f4e1425d3a200d4',
    '4d3552e40d7246d55050ab9673c4128c6666e9b989c9f991a967db79d6bff495',
    '492d49fd8b83d90577ddc562f039579b878041c40d43b7f88e81abaa58bf6788',
    '0c424b4ce0d864e4f8307a56929747ae22169034936703984baf3e2efe1a96af',
    '1e2f77cd4e6f7e1f20bf9747be03475840d99f0ad993ac726a53cd06092880cb',
    '552350e21df1a9260a488438aaddd9ee464d8268eae4fd9812e93e5c622fba66',
    '6eb4c4dc98625a93e6cba07c4e223a2786e6ca65255f87478498244b8828f940',
    '94545eaa2b7741060fea8702b1476c3bb6797e8e4abd674e74227768bcb01359',
    'e12ae69489f7d05d00cd5472f0b8fc682c4f73599ffa2f6b6239e58e8e4a9402',
    '5479d29b562e175ac63d4dc9a668e7d494ae597c14294711ef71930fa41ae677',
    '2fce6aa98899cacae1ada3e697fb92a08a29773779e03f88781fee814f01f7f5',
    '1e5da1643a3ab0c09026d09eb5be5dbf194b491824d7b97e69f78f2f647604ce',
    '95d81bc1b9fbb4c6e9c306dd94007e1f02c70d11b764efe7c6cd23a8caacc353',
    '373d0be7fcf064c4441a2b7930fff3d192ce35fa5e775621cd6dc8cb5942f8ef',
    '5f5ab4f0e629663df82bea3f3603ece1260eec309cff42ea784c680a2b37e7be',
    '7bcafe73a9a3a85727343e608c4e9ad6a9ef7fec5d628d7d7d9a528492e2a0f4',
  ]),
});
const refuse = () => {
  throw new Error('Unsupported standing-pose candidate input or policy');
};
const uint = (n) => Number.isInteger(n) && n >= 0 && n <= 0xffffffff;
const exact = (a, b) => Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i]);
const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];

// Copy before the first digest await. Bound the copy and refuse accessors,
// holes, cycles, nonfinite values and exotic objects instead of borrowing data.
function copy(input) {
  let remaining = 50000;
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
    if (!value || typeof value !== 'object') refuse();
    const array = Array.isArray(value),
      proto = Object.getPrototypeOf(value);
    if (!array && proto !== Object.prototype && proto !== null) refuse();
    const length = array ? value.length : 0;
    if (array && (!Number.isInteger(length) || length < 0 || length > 20000)) refuse();
    const keys = array ? Array.from({ length }, (_, i) => String(i)) : Object.keys(value);
    if (keys.length > (array ? 20000 : 64)) refuse();
    const out = array ? [] : Object.create(null);
    for (const key of keys) {
      const item = Object.getOwnPropertyDescriptor(value, key);
      if (!item || !('value' in item)) refuse();
      out[key] = visit(item.value, depth + 1);
    }
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
async function hash(value) {
  const bytes = new TextEncoder().encode(canonical(value));
  if (bytes.length > 1024 * 1024 || !globalThis.crypto?.subtle) refuse();
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('');
}
function range(value, start, end) {
  if (value?.start !== start || value.endExclusive !== end) refuse();
}
function words(value, count) {
  if (!Array.isArray(value) || value.length !== count || value.some((v) => !uint(v))) refuse();
}
const scratch = new DataView(new ArrayBuffer(4));
function number(bits) {
  if (!uint(bits)) refuse();
  scratch.setUint32(0, bits, true);
  const n = scratch.getFloat32(0, true);
  if (!Number.isFinite(n)) refuse();
  return n;
}
function word(n) {
  if (!Number.isFinite(n) || Math.abs(n) > 3.4028234663852886e38) refuse();
  scratch.setFloat32(0, n, true);
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
  if (exact(m, identity)) return v.slice();
  return [0, 1, 2].map((i) => m[i * 3] * v[0] + m[i * 3 + 1] * v[1] + m[i * 3 + 2] * v[2]);
}
function multiply(a, b) {
  if (exact(a, identity)) return b.slice();
  if (exact(b, identity)) return a.slice();
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

// Inputs are source-bound snapshots, never a live C heap. The skeleton binding
// is {sourceBytes,sourceSha256,scaleBits,parents:[19 signed parent indices]}.
// Its stored scale is recorded but deliberately not used by this exact policy.
// Model is the admitted {model,sourceSha256} general descriptor; texture is not
// touched. Returned arrays/buffers own their storage and never mutate inputs.
export async function assembleCampaignStandingPose(input = {}) {
  return assembleSourcePose(input, false);
}
export async function assembleCampaignMarchPose(input = {}) {
  return assembleSourcePose(input, true);
}
async function assembleSourcePose({ frame, model, skeleton, policy, normalization } = {}, march) {
  const expectedPolicy = march ? campaignMarchPosePolicy : campaignStandingPosePolicy,
    expectedAnimation = march ? campaignMarchPoseSources : campaignStandingPoseSources.animation;
  if (!policy || Object.keys(expectedPolicy).some((k) => policy[k] !== expectedPolicy[k])) refuse();
  const f = copy(frame),
    m = copy(model?.model),
    s = copy(skeleton),
    modelSha = model?.sourceSha256;
  if (
    modelSha !== campaignStandingPoseSources.model.sha256 ||
    m?.sourceBytes !== 52401 ||
    m.versionBits !== 0x404a3d71 ||
    m.headerLength !== 38 ||
    m.totalVertices !== 587 ||
    m.totalTriangles !== 962 ||
    m.bones?.length !== 20 ||
    m.meshes?.length !== 4 ||
    m.material?.textureName !== 'textures\\officer_roman_general_julii.tga'
  )
    refuse();
  if (
    f?.schema !== 'openrtw-cas-animation-frame-v1' ||
    f.sourceBytes !== 7093 ||
    f.sourceSha256 !== expectedAnimation.sha256 ||
    f.frameCount !== 21 ||
    f.rotationSlotCount !== 19 ||
    f.positionChannelCount !== 1 ||
    (!march ? f.frameIndex !== 0 : !uint(f.frameIndex) || f.frameIndex >= 21) ||
    !Array.isArray(f.rotationQuaternionBits) ||
    f.rotationQuaternionBits.length !== 19
  )
    refuse();
  range(f.rotationRange, 5 + f.frameIndex * 304, 309 + f.frameIndex * 304);
  range(f.positionChannelRange, 6389 + f.frameIndex * 12, 6401 + f.frameIndex * 12);
  range(f.controlPositionRange, 6801 + f.frameIndex * 12, 6813 + f.frameIndex * 12);
  for (const q of f.rotationQuaternionBits) {
    words(q, 4);
    rotation(q);
  }
  words(f.positionChannelBits, 3);
  words(f.controlPositionBits, 3);
  f.positionChannelBits.forEach(number);
  f.controlPositionBits.forEach(number);
  if (
    s?.sourceBytes !== 6126 ||
    s.sourceSha256 !== campaignStandingPoseSources.skeleton.sha256 ||
    s.scaleBits !== 1060320051 ||
    !Array.isArray(s.parents) ||
    s.parents.length !== 19
  )
    refuse();
  for (let i = 0; i < 20; i++) {
    const b = m.bones[i];
    if (
      b.id !== i ||
      !uint(b.parent) ||
      (i === 0 ? b.parent !== 0 : b.parent >= i) ||
      (i > 0 && s.parents[i - 1] !== b.parent - 1)
    )
      refuse();
  }
  if (!m.bones[0].bindLocalBits.every((v) => number(v) === 0)) refuse();
  const geometry = assembleCasGeometry(m);
  const raw = copy(m);
  for (const b of raw.bones) delete b.candidateBindWorld;
  for (const part of raw.meshes) delete part.candidateBindPositions;
  const frameIdentity = {};
  for (const k of [
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
  ])
    frameIdentity[k] = f[k];
  const [frameHash, modelHash] = await Promise.all([hash(frameIdentity), hash(raw)]);
  if (
    frameHash !==
      (march
        ? campaignMarchPoseSources.frameSha256[f.frameIndex]
        : campaignStandingPoseSources.animation.frame0Sha256) ||
    modelHash !== campaignStandingPoseSources.model.rawFieldsSha256
  )
    refuse();
  const bones = [],
    root = march ? [0, number(f.controlPositionBits[1]), 0] : f.controlPositionBits.map(number);
  for (let i = 0; i < 20; i++) {
    const b = m.bones[i];
    let r, t;
    if (i === 0) {
      r = identity.slice();
      t = root.slice();
    } else {
      const p = bones[b.parent];
      r = multiply(p.worldRotation, rotation(f.rotationQuaternionBits[i - 1]));
      t = apply(p.worldRotation, b.bindLocalBits.map(number)).map(
        (v, k) => v + p.worldTranslation[k]
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
        p = apply(b.worldRotation, part.positionBits.slice(i * 3, i * 3 + 3).map(number)),
        n = apply(b.worldRotation, part.normalBits.slice(i * 3, i * 3 + 3).map(number));
      for (let k = 0; k < 3; k++) {
        positions.push(word(p[k] + b.worldTranslation[k]));
        normals.push(exact(b.worldRotation, identity) ? part.normalBits[i * 3 + k] : word(n[k]));
      }
    }
    return {
      name: part.name,
      chunkKind: part.chunkKind,
      positionBits: positions,
      normalBits: normals,
      uvBits: part.uvBits.slice(),
      boneIndices: part.boneIndices.slice(),
      indices: part.indices.slice(),
    };
  });
  const bounds = [
    [Infinity, Infinity, Infinity],
    [-Infinity, -Infinity, -Infinity],
  ];
  for (const part of parts)
    for (let i = 0; i < part.positionBits.length; i++) {
      const v = number(part.positionBits[i]),
        k = i % 3;
      bounds[0][k] = Math.min(bounds[0][k], v);
      bounds[1][k] = Math.max(bounds[1][k], v);
    }
  const normalized = march ? copy(normalization) : null;
  if (
    march &&
    (!Array.isArray(normalized?.center) ||
      normalized.center.length !== 3 ||
      normalized.center.some((v) => !Number.isFinite(v) || Math.abs(v) > 10000) ||
      !Number.isFinite(normalized.extent) ||
      normalized.extent <= 0 ||
      normalized.extent > 10000)
  )
    refuse();
  const center = march ? normalized.center : bounds[0].map((v, k) => (v + bounds[1][k]) / 2),
    extent = march ? normalized.extent : Math.max(...bounds[0].map((v, k) => bounds[1][k] - v));
  if (!Number.isFinite(extent) || extent <= 0) refuse();
  const vertices = geometry.vertices.slice(),
    view = new DataView(vertices.buffer);
  let vertex = 0;
  for (const part of parts)
    for (let i = 0; i < part.positionBits.length; i += 3, vertex++)
      for (let k = 0; k < 3; k++)
        view.setFloat32(
          vertex * 24 + k * 4,
          ((number(part.positionBits[i + k]) - center[k]) * 2.1) / extent,
          true
        );
  const pose = freeze({
    schema: 'openrtw-campaign-standing-pose-v1',
    frameIndex: f.frameIndex,
    nativeAnimation: false,
    policy: { ...expectedPolicy },
    sourceSha256: { model: modelSha, animation: f.sourceSha256, skeleton: s.sourceSha256 },
    rawRootMovementBits: f.controlPositionBits.slice(),
    bones,
    parts,
    bounds,
  });
  return Object.freeze({
    pose,
    geometry: Object.freeze({
      ...geometry,
      vertices,
      indexBytes: geometry.indexBytes.slice(),
      bounds: bounds.map((row) => row.slice()),
      // A479BF/92D4DA selects skeleton node type4: slot15 in the verified
      // strat_named_with_army skeleton, CAS bone16 (Lhand). Keep this point in
      // exactly the same centered F32 space as the displayed posed vertices.
      bannerAttachment: Object.freeze({
        bone: 16,
        skeletonType: 4,
        point: Object.freeze(
          bones[16].worldTranslation.map((v, k) => Math.fround(((v - center[k]) * 2.1) / extent))
        ),
      }),
    }),
    presentationPolicy: expectedPolicy,
  });
}
