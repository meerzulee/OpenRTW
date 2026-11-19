import { assembleCasGeometryProfileData, casGeometryLimits } from '/cas-geometry.js';

// Explicit projection policies, not source identities or recovered native
// semantics. Exact source/hash binding remains the caller's responsibility.
// Supported input domain: plain parsed CAPI JSON whose wire size is bounded
// by its owner. This does not accept arbitrary getters/proxies or claim a
// bounded allocation cost for enumerating an arbitrary JavaScript object.
export const casProfileGeometryProfiles = Object.freeze({
  'openrtw-cas316-terminal-kind7-v1': Object.freeze({
    versionBits: 0x404a3d71,
    bones: 20,
    staticParts: 3,
    dynamicParts: 2,
    color: 1,
    opaquePart: 4,
  }),
  'openrtw-cas312-rider-repeated-count-v1': Object.freeze({
    versionBits: 0x4047ae14,
    bones: 20,
    staticParts: 3,
    dynamicParts: 1,
    color: 1,
    opaquePart: null,
  }),
  'openrtw-cas305-empty-static-v1': Object.freeze({
    versionBits: 0x40433333,
    bones: 21,
    staticParts: 0,
    dynamicParts: 1,
    color: 0,
    opaquePart: 0,
  }),
});
export const casProfileGeometryPolicy = Object.freeze({
  id: 'openrtw-explicit-cas-profile-geometry-v1',
  pose: 'source-f32-plus-parent-translation-candidate',
  axes: 'unchanged-source-axes',
  normalization: 'shared-centered-uniform-2.1-extent',
  uv: 'unchanged-source-uv',
  indices: 'unchanged-source-u16-winding',
  color: 'existing-diagnostic-part-palette;source-rgba-retained-without-shader-interpretation',
  opaque: 'owned-source-extra-and-tail-bytes;terminal-kind7-retained-without-semantics',
  mountedComposition: 'unsupported-without-independent-relative-basis',
  nativePoseEquivalent: false,
  nativeScaleEquivalent: false,
  nativeMaterialEquivalent: false,
});
export const casProfileGeometryLimits = Object.freeze({
  ...casGeometryLimits,
  frames: 4096,
  channelKeys: 32768,
  boneExtraBytes: 256,
  opaqueMeshExtraBytes: 31,
});
const uint = (value) => Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
const text = (value) => typeof value === 'string' && /^[\x20-\x7e]{1,255}$/.test(value);
const refuse = () => {
  throw new Error('Invalid explicit CAS profile geometry');
};
function array(value, length, test = () => true) {
  if (!Array.isArray(value) || value.length !== length) refuse();
  for (let i = 0; i < length; i++) if (!Object.hasOwn(value, i) || !test(value[i], i)) refuse();
}
const byte = (value) => uint(value) && value <= 255;
function range(value, sourceBytes, start, end, container = null) {
  if (
    !value ||
    Object.keys(value).length !== 2 ||
    !uint(value.start) ||
    !uint(value.endExclusive) ||
    value.start !== start ||
    value.endExclusive !== end ||
    start > end ||
    end > sourceBytes ||
    (container && (start < container.start || end > container.endExclusive))
  )
    refuse();
}
function boundedRange(value, sourceBytes, container = null) {
  if (!value || !uint(value.start) || !uint(value.endExclusive)) refuse();
  range(value, sourceBytes, value.start, value.endExclusive, container);
}
const copyRange = (value) =>
  Object.freeze({ start: value.start, endExclusive: value.endExclusive });
const copyBytes = (value) => Object.freeze(value.slice());

function validate(model, profile) {
  if (
    model.schema !== 'openrtw-cas-static-candidate-v1' ||
    model.versionBits !== profile.versionBits ||
    model.headerLength !== 38 ||
    !uint(model.sourceBytes) ||
    !model.sourceBytes ||
    model.sourceBytes > casGeometryLimits.sourceBytes ||
    !uint(model.frameCount) ||
    !model.frameCount ||
    model.frameCount > casProfileGeometryLimits.frames ||
    !uint(model.rotationKeyCount) ||
    !uint(model.translationKeyCount) ||
    model.rotationKeyCount + model.translationKeyCount > casProfileGeometryLimits.channelKeys
  )
    refuse();
  const size = model.sourceBytes;
  array(model.bones, profile.bones);
  array(model.meshes, profile.staticParts + profile.dynamicParts);
  array(model.chunks, 2);
  array(model.opaqueChunks, 3);
  range(model.headerRange, size, 0, 42);
  boundedRange(model.animationRange, size);
  if (model.animationRange.start !== 42) refuse();
  range(model.parentsRange, size, 52, 52 + profile.bones * 4, model.animationRange);
  range(
    model.frameTimeRange,
    size,
    model.parentsRange.endExclusive + 4,
    model.parentsRange.endExclusive + 4 + model.frameCount * 4,
    model.animationRange
  );
  boundedRange(model.boneHeadersRange, size, model.animationRange);
  if (model.boneHeadersRange.start !== model.frameTimeRange.endExclusive) refuse();
  let cursor = model.boneHeadersRange.start,
    rotations = 0,
    translations = 0;
  for (const [i, bone] of model.bones.entries()) {
    if (
      !bone ||
      bone.id !== i ||
      !uint(bone.parent) ||
      (i === 0 ? bone.parent !== 0 : bone.parent >= i) ||
      !text(bone.name) ||
      !uint(bone.rotationKeys) ||
      bone.rotationKeys > model.frameCount ||
      !uint(bone.translationKeys) ||
      bone.translationKeys > model.frameCount ||
      !uint(bone.rotationOffset) ||
      !uint(bone.translationOffset)
    )
      refuse();
    rotations += bone.rotationKeys;
    translations += bone.translationKeys;
    if (rotations + translations > casProfileGeometryLimits.channelKeys) refuse();
    const baseEnd = cursor + 25 + bone.name.length;
    let end = baseEnd;
    if (profile.versionBits === 0x404a3d71) {
      if (
        !Array.isArray(bone.extra316Bytes) ||
        bone.extra316Bytes.length > casProfileGeometryLimits.boneExtraBytes
      )
        refuse();
      array(bone.extra316Bytes, bone.extra316Bytes.length, byte);
      end += 4 + bone.extra316Bytes.length;
      range(bone.extra316Range, size, baseEnd, end, model.boneHeadersRange);
    } else if (Object.hasOwn(bone, 'extra316Bytes') || Object.hasOwn(bone, 'extra316Range'))
      refuse();
    range(bone.headerRange, size, cursor, end, model.boneHeadersRange);
    cursor = end;
  }
  if (
    cursor !== model.boneHeadersRange.endExclusive ||
    rotations !== model.rotationKeyCount ||
    translations !== model.translationKeyCount ||
    (profile.versionBits === 0x40433333 && (rotations !== 0 || translations !== 0))
  )
    refuse();
  let rotationOffset = 0,
    translationOffset = rotations * 16;
  for (const bone of model.bones) {
    if (bone.rotationOffset !== rotationOffset || bone.translationOffset !== translationOffset)
      refuse();
    rotationOffset += bone.rotationKeys * 16;
    translationOffset += bone.translationKeys * 12;
  }
  range(model.rotationRange, size, cursor, cursor + rotations * 16, model.animationRange);
  cursor = model.rotationRange.endExclusive;
  range(model.translationRange, size, cursor, cursor + translations * 12, model.animationRange);
  cursor = model.translationRange.endExclusive;
  range(model.bindRange, size, cursor, cursor + profile.bones * 12, model.animationRange);
  cursor = model.bindRange.endExclusive;
  if (cursor !== model.animationRange.endExclusive) refuse();
  let partIndex = 0,
    totalVertices = 0,
    totalTriangles = 0;
  for (const [index, count] of [profile.staticParts, profile.dynamicParts].entries()) {
    const kind = index + 1,
      chunk = model.chunks[index],
      chunkStart = cursor;
    if (!chunk || chunk.kind !== kind || chunk.meshes !== count) refuse();
    boundedRange(chunk.range, size);
    if (chunk.range.start !== chunkStart) refuse();
    cursor += 12;
    for (let part = 0; part < count; part++, partIndex++) {
      const mesh = model.meshes[partIndex];
      if (
        !mesh ||
        mesh.chunkKind !== kind ||
        !text(mesh.name) ||
        !uint(mesh.vertices) ||
        !mesh.vertices ||
        !uint(mesh.triangles) ||
        !mesh.triangles ||
        mesh.vertexColorFlag !== profile.color
      )
        refuse();
      totalVertices += mesh.vertices;
      totalTriangles += mesh.triangles;
      if (
        totalVertices > casGeometryLimits.vertices ||
        totalTriangles > casGeometryLimits.triangles
      )
        refuse();
      boundedRange(mesh.recordRange, size, chunk.range);
      if (mesh.recordRange.start !== cursor) refuse();
      const opaque = partIndex === profile.opaquePart,
        extraBytes = opaque ? 31 : 1;
      array(mesh.extra1, extraBytes, opaque ? byte : (value) => value === 0);
      array(mesh.extra2, kind === 1 ? 1 : 0, (value) => value === 0);
      let extraStart = cursor + 5 + mesh.name.length;
      range(mesh.extra1Range, size, extraStart, extraStart + 4 + extraBytes, mesh.recordRange);
      extraStart = mesh.extra1Range.endExclusive;
      range(
        mesh.extra2Range,
        size,
        extraStart,
        extraStart + (kind === 1 ? 5 : 0),
        mesh.recordRange
      );
      // After extra2: optional rigid bone DWORD, seven metadata DWORDs, two
      // U16 counts, UV byte and color byte. No source fields are fabricated.
      const assignments = mesh.extra2Range.endExclusive + (kind === 1 ? 4 : 0) + 34;
      range(
        mesh.assignmentRange,
        size,
        assignments,
        assignments + (kind === 1 ? 0 : mesh.vertices * 4),
        mesh.recordRange
      );
      const colorBytes = profile.color * mesh.vertices * 4;
      array(mesh.vertexColorBytes, colorBytes, byte);
      boundedRange(mesh.uvRange, size, mesh.recordRange);
      range(
        mesh.colorRange,
        size,
        mesh.uvRange.endExclusive,
        mesh.uvRange.endExclusive + colorBytes,
        mesh.recordRange
      );
      if (mesh.colorRange.endExclusive + 1 !== mesh.recordRange.endExclusive) refuse();
      cursor = mesh.recordRange.endExclusive;
    }
    cursor += kind === 1 ? 6 : 4;
    if (chunk.range.endExclusive !== cursor) refuse();
  }
  if (
    !uint(model.totalVertices) ||
    !uint(model.totalTriangles) ||
    model.totalVertices !== totalVertices ||
    model.totalTriangles !== totalTriangles
  )
    refuse();
  for (const [i, kind] of [3, 8, 10].entries()) {
    const chunk = model.opaqueChunks[i];
    if (!chunk || chunk.kind !== kind || chunk.meshes !== 0) refuse();
    range(chunk.range, size, cursor, cursor + 16);
    cursor += 16;
  }
  const material = model.material;
  if (!material || !text(material.textureName) || material.lastByte !== 1) refuse();
  boundedRange(material.range, size);
  if (material.range.start !== cursor) refuse();
  range(
    material.nameRange,
    size,
    cursor + 17,
    cursor + 18 + material.textureName.length,
    material.range
  );
  range(
    material.opaqueTailRange,
    size,
    material.nameRange.endExclusive + 28,
    material.nameRange.endExclusive + 56,
    material.range
  );
  array(material.opaqueTailBytes, 28, byte);
  if (material.opaqueTailRange.endExclusive + 1 !== material.range.endExclusive) refuse();
  if (profile.versionBits === 0x404a3d71) {
    array(model.terminalKind7Words, 3, (value, i) => value === [12, 7, 0][i]);
    range(model.terminalKind7Range, size, material.range.endExclusive, size);
    if (model.terminalKind7Range.endExclusive - model.terminalKind7Range.start !== 12) refuse();
  } else if (
    material.range.endExclusive !== size ||
    Object.hasOwn(model, 'terminalKind7Range') ||
    Object.hasOwn(model, 'terminalKind7Words')
  )
    refuse();
}

function retainedOpaque(model) {
  const bones = Object.freeze(
    model.bones.map((bone) =>
      Object.hasOwn(bone, 'extra316Bytes')
        ? Object.freeze({
            range: copyRange(bone.extra316Range),
            bytes: copyBytes(bone.extra316Bytes),
          })
        : null
    )
  );
  const meshes = Object.freeze(
    model.meshes.map((mesh) =>
      Object.freeze({
        extra1Range: copyRange(mesh.extra1Range),
        extra1: copyBytes(mesh.extra1),
        extra2Range: copyRange(mesh.extra2Range),
        extra2: copyBytes(mesh.extra2),
        vertexColorFlag: mesh.vertexColorFlag,
        colorRange: copyRange(mesh.colorRange),
        vertexColorBytes: copyBytes(mesh.vertexColorBytes),
      })
    )
  );
  const material = Object.freeze({
    range: copyRange(model.material.opaqueTailRange),
    bytes: copyBytes(model.material.opaqueTailBytes),
  });
  const terminal = Object.hasOwn(model, 'terminalKind7Words')
    ? Object.freeze({
        range: copyRange(model.terminalKind7Range),
        words: copyBytes(model.terminalKind7Words),
      })
    : null;
  return Object.freeze({
    boneExtras316: bones,
    meshExtras: meshes,
    materialTail: material,
    terminalKind7: terminal,
  });
}

// Synchronous, CPU-only projection. The shared entry retains all generic
// finite/bind/array/index checks and packs owned buffers with the existing
// presentation policy. No marker, opaque byte or suffix is stripped/repaired.
export function assembleCasProfileGeometry(model) {
  const marker = model?.admissionProfile;
  if (typeof marker !== 'string' || !Object.hasOwn(casProfileGeometryProfiles, marker)) refuse();
  validate(model, casProfileGeometryProfiles[marker]);
  const geometry = assembleCasGeometryProfileData(model);
  return Object.freeze({
    ...geometry,
    admissionProfile: marker,
    presentationPolicy: casProfileGeometryPolicy,
    opaqueFields: retainedOpaque(model),
  });
}
