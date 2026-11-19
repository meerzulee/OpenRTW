// Geometry assembly for the admitted CAS3.05/3.12/3.16 static-candidate schema.
// Parent translations, centered scale and part colors are presentation policy;
// this is not a binary parser, native pose, animation or material-selection proof.
export const casGeometryLimits = Object.freeze({
  sourceBytes: 1024 * 1024,
  bones: 128,
  parts: 64,
  vertices: 16384,
  triangles: 32768,
});
const uint = (value) => Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
const text = (value) => typeof value === 'string' && /^[\x20-\x7e]{1,255}$/.test(value);
const refuse = () => {
  throw new Error('Invalid admitted CAS geometry');
};
function array(value, length, test) {
  if (!Array.isArray(value) || value.length !== length) refuse();
  for (let i = 0; i < length; i++) if (!Object.hasOwn(value, i) || !test(value[i], i)) refuse();
}
function floats(bits) {
  const bytes = new ArrayBuffer(bits.length * 4),
    view = new DataView(bytes);
  bits.forEach((word, i) => {
    if (!uint(word)) refuse();
    view.setUint32(i * 4, word, true);
  });
  return bits.map((_, i) => {
    const value = view.getFloat32(i * 4, true);
    if (!Number.isFinite(value)) refuse();
    return value;
  });
}
function range(value, sourceBytes, bytes = null, container = null) {
  if (
    !value ||
    !uint(value.start) ||
    !uint(value.endExclusive) ||
    value.start > value.endExclusive ||
    value.endExclusive > sourceBytes ||
    (bytes !== null && value.endExclusive - value.start !== bytes) ||
    (container && (value.start < container.start || value.endExclusive > container.endExclusive))
  )
    refuse();
}

const selectedProfiles = Object.freeze({
  'openrtw-cas316-terminal-kind7-v1': Object.freeze({
    version: 0x404a3d71,
    bones: 20,
    staticParts: 3,
    dynamicParts: 2,
    color: 1,
    opaquePart: 4,
  }),
  'openrtw-cas312-rider-repeated-count-v1': Object.freeze({
    version: 0x4047ae14,
    bones: 20,
    staticParts: 3,
    dynamicParts: 1,
    color: 1,
    opaquePart: null,
  }),
  'openrtw-cas305-empty-static-v1': Object.freeze({
    version: 0x40433333,
    bones: 21,
    staticParts: 0,
    dynamicParts: 1,
    color: 0,
    opaquePart: 0,
  }),
});

export function assembleCasGeometry(model) {
  // These publications require the named opt-in path, including rider data
  // whose mesh extras otherwise happen to match the older generic schema.
  if (
    typeof model?.admissionProfile === 'string' &&
    Object.hasOwn(selectedProfiles, model.admissionProfile)
  )
    refuse();
  return assembleCasGeometryImpl(model, null);
}

// Closed packing entry for cas-profile-geometry.js. It accepts no caller
// validation policy; the public adapter also validates the complete ranges
// and owns copies of the opaque publication fields.
export function assembleCasGeometryProfileData(model) {
  const marker = model?.admissionProfile;
  if (typeof marker !== 'string' || !Object.hasOwn(selectedProfiles, marker)) refuse();
  const policy = selectedProfiles[marker];
  if (
    model.versionBits !== policy.version ||
    !uint(model.sourceBytes) ||
    !model.sourceBytes ||
    model.sourceBytes > casGeometryLimits.sourceBytes
  )
    refuse();
  array(model.bones, policy.bones, () => true);
  array(
    model.meshes,
    policy.staticParts + policy.dynamicParts,
    (part, i) =>
      part &&
      part.chunkKind === (i < policy.staticParts ? 1 : 2) &&
      part.vertexColorFlag === policy.color
  );
  array(
    model.chunks,
    2,
    (chunk, i) =>
      chunk && chunk.kind === i + 1 && chunk.meshes === [policy.staticParts, policy.dynamicParts][i]
  );
  if (
    policy.version === 0x40433333 &&
    (model.rotationKeyCount !== 0 || model.translationKeyCount !== 0)
  )
    refuse();
  if (!model.material) refuse();
  range(model.material.range, model.sourceBytes);
  if (policy.version === 0x404a3d71) {
    array(model.terminalKind7Words, 3, (value, i) => value === [12, 7, 0][i]);
    range(model.terminalKind7Range, model.sourceBytes, 12);
    if (
      model.terminalKind7Range.start !== model.material.range.endExclusive ||
      model.terminalKind7Range.endExclusive !== model.sourceBytes
    )
      refuse();
  } else if (
    model.material.range.endExclusive !== model.sourceBytes ||
    Object.hasOwn(model, 'terminalKind7Range') ||
    Object.hasOwn(model, 'terminalKind7Words')
  )
    refuse();
  return assembleCasGeometryImpl(model, policy);
}

function assembleCasGeometryImpl(model, policy) {
  const version316 = model?.versionBits === 0x404a3d71,
    version312 = model?.versionBits === 0x4047ae14;
  if (
    !model ||
    model.schema !== 'openrtw-cas-static-candidate-v1' ||
    (!version316 && !version312 && model.versionBits !== 0x40433333) ||
    model.headerLength !== 38 ||
    !uint(model.sourceBytes) ||
    model.sourceBytes === 0 ||
    model.sourceBytes > casGeometryLimits.sourceBytes ||
    !uint(model.totalVertices) ||
    !model.totalVertices ||
    model.totalVertices > casGeometryLimits.vertices ||
    !uint(model.totalTriangles) ||
    !model.totalTriangles ||
    model.totalTriangles > casGeometryLimits.triangles ||
    !Array.isArray(model.bones) ||
    !model.bones.length ||
    model.bones.length > casGeometryLimits.bones ||
    !Array.isArray(model.meshes) ||
    !model.meshes.length ||
    model.meshes.length > casGeometryLimits.parts
  )
    refuse();
  const sourceBytes = model.sourceBytes,
    material = model.material;
  if (!material || !text(material.textureName) || material.lastByte !== 1) refuse();
  range(material.range, sourceBytes);
  range(material.nameRange, sourceBytes, material.textureName.length + 1, material.range);
  array(material.rawBits, 7, uint);
  floats(material.rawBits);
  if (version316 || version312 || policy) {
    array(material.opaqueTailBytes, 28, (v) => uint(v) && v <= 255);
    range(material.opaqueTailRange, sourceBytes, 28, material.range);
    if (
      material.opaqueTailRange.start !== material.nameRange.endExclusive + 28 ||
      material.opaqueTailRange.endExclusive + 1 !== material.range.endExclusive
    )
      refuse();
  }
  let declaredVertices = 0,
    declaredTriangles = 0;
  for (const part of model.meshes) {
    if (
      !part ||
      !uint(part.vertices) ||
      !part.vertices ||
      part.vertices > casGeometryLimits.vertices - declaredVertices ||
      !uint(part.triangles) ||
      !part.triangles ||
      part.triangles > casGeometryLimits.triangles - declaredTriangles
    )
      refuse();
    declaredVertices += part.vertices;
    declaredTriangles += part.triangles;
  }
  if (declaredVertices !== model.totalVertices || declaredTriangles !== model.totalTriangles)
    refuse();
  for (const [i, bone] of model.bones.entries()) {
    if (
      !bone ||
      bone.id !== i ||
      !uint(bone.parent) ||
      (i === 0 ? bone.parent !== 0 : bone.parent >= i) ||
      !text(bone.name)
    )
      refuse();
    range(bone.headerRange, sourceBytes);
    array(bone.bindLocalBits, 3, uint);
    array(bone.candidateBindWorld, 3, Number.isFinite);
    if (version316) {
      if (!Array.isArray(bone.extra316Bytes) || bone.extra316Bytes.length > 256) refuse();
      array(bone.extra316Bytes, bone.extra316Bytes.length, (v) => uint(v) && v <= 255);
      range(bone.extra316Range, sourceBytes, 4 + bone.extra316Bytes.length, bone.headerRange);
      if (bone.extra316Range.endExclusive !== bone.headerRange.endExclusive) refuse();
    }
    if (version312) {
      const bytesPresent = Object.hasOwn(bone, 'extra316Bytes'),
        rangePresent = Object.hasOwn(bone, 'extra316Range');
      if (bytesPresent !== rangePresent) refuse();
      if (bytesPresent) {
        array(bone.extra316Bytes, 0, uint);
        range(bone.extra316Range, sourceBytes, 0);
        if (bone.extra316Range.start !== 0) refuse();
      }
    }
    const local = floats(bone.bindLocalBits),
      parent = i ? model.bones[bone.parent].candidateBindWorld : [0, 0, 0];
    if (local.some((v, k) => v + parent[k] !== bone.candidateBindWorld[k])) refuse();
  }
  const points = [],
    indices = [],
    parts = [],
    bounds = [
      [Infinity, Infinity, Infinity],
      [-Infinity, -Infinity, -Infinity],
    ];
  const colors = [0xffffcb6b, 0xff80d4ed, 0xff8dd6ab, 0xffc7a0df, 0xffe1e7ed, 0xffe9a1a5];
  for (const [partIndex, part] of model.meshes.entries()) {
    if (
      !text(part.name) ||
      ![1, 2].includes(part.chunkKind) ||
      part.textureIndex !== 0 ||
      (part.chunkKind === 1
        ? !uint(part.attachedBone) || part.attachedBone >= model.bones.length
        : part.attachedBone !== null)
    )
      refuse();
    array(part.positionBits, part.vertices * 3, uint);
    array(part.normalBits, part.vertices * 3, uint);
    array(part.uvBits, part.vertices * 2, uint);
    array(
      part.boneIndices,
      part.vertices,
      (v) => uint(v) && v < model.bones.length && (part.chunkKind !== 1 || part.attachedBone === v)
    );
    array(part.candidateBindPositions, part.vertices * 3, Number.isFinite);
    array(
      part.indices,
      part.triangles * 3,
      (v) => Number.isInteger(v) && v >= 0 && v < part.vertices && v <= 0xffff
    );
    array(part.metadataBits, 7, uint);
    floats(part.metadataBits);
    const opaqueExtra = policy && partIndex === policy.opaquePart;
    array(
      part.extra1,
      opaqueExtra ? 31 : 1,
      opaqueExtra ? (v) => uint(v) && v <= 255 : (v) => v === 0
    );
    array(part.extra2, part.chunkKind === 1 ? 1 : 0, (v) => v === 0);
    range(part.recordRange, sourceBytes);
    range(
      part.assignmentRange,
      sourceBytes,
      part.chunkKind === 1 ? 0 : part.vertices * 4,
      part.recordRange
    );
    for (const [name, bytes] of [
      ['positionRange', part.vertices * 12],
      ['normalRange', part.vertices * 12],
      ['indexRange', part.triangles * 6],
      ['uvRange', part.vertices * 8],
    ])
      range(part[name], sourceBytes, bytes, part.recordRange);
    if (
      part.assignmentRange.endExclusive !== part.positionRange.start ||
      part.positionRange.endExclusive !== part.normalRange.start ||
      part.normalRange.endExclusive !== part.indexRange.start ||
      part.indexRange.endExclusive + 4 !== part.uvRange.start
    )
      refuse();
    if (version316 || version312 || policy) {
      if (part.vertexColorFlag !== 0 && part.vertexColorFlag !== 1) refuse();
      const colorBytes = part.vertexColorFlag * part.vertices * 4;
      array(part.vertexColorBytes, colorBytes, (v) => uint(v) && v <= 255);
      range(part.colorRange, sourceBytes, colorBytes, part.recordRange);
      if (
        part.colorRange.start !== part.uvRange.endExclusive ||
        part.colorRange.endExclusive + 1 !== part.recordRange.endExclusive
      )
        refuse();
      // Source colors are retained/checked, with no shader interpretation added.
    } else if (part.uvRange.endExclusive + 1 !== part.recordRange.endExclusive) refuse();
    const position = floats(part.positionBits),
      normals = floats(part.normalBits),
      uv = floats(part.uvBits),
      base = points.length;
    for (let i = 0; i < part.vertices; i++) {
      const bone = part.boneIndices[i],
        world = part.candidateBindPositions.slice(i * 3, i * 3 + 3);
      if (world.some((v, k) => position[i * 3 + k] + model.bones[bone].candidateBindWorld[k] !== v))
        refuse();
      world.forEach((v, k) => {
        bounds[0][k] = Math.min(bounds[0][k], v);
        bounds[1][k] = Math.max(bounds[1][k], v);
      });
      // First six colors preserve Hastati bytes; extra generic parts cycle them.
      points.push({
        world,
        normal: normals.slice(i * 3, i * 3 + 3),
        uv: uv.slice(i * 2, i * 2 + 2),
        color: colors[partIndex % colors.length],
      });
    }
    for (const index of part.indices) {
      const rebased = base + index;
      if (rebased >= model.totalVertices || rebased > 0xffff) refuse();
      indices.push(rebased);
    }
    parts.push({ name: part.name, vertices: part.vertices, triangles: part.triangles });
  }
  const center = bounds[0].map((v, k) => (v + bounds[1][k]) / 2),
    extent = Math.max(...bounds[0].map((v, k) => bounds[1][k] - v));
  if (!center.every(Number.isFinite) || !Number.isFinite(extent) || extent <= 0) refuse();
  const vertices = new Uint8Array(points.length * 24),
    view = new DataView(vertices.buffer);
  for (const [i, p] of points.entries()) {
    const offset = i * 24;
    p.world.forEach((v, k) => {
      view.setFloat32(offset + k * 4, ((v - center[k]) * 2.1) / extent, true);
      if (!Number.isFinite(view.getFloat32(offset + k * 4, true))) refuse();
    });
    const length = Math.hypot(...p.normal),
      shade = length
        ? 0.55 +
          0.45 * Math.max(0, (p.normal[0] * 0.3 + p.normal[1] * 0.7 + p.normal[2] * 0.6) / length)
        : 0.75;
    const color =
      0xff000000 |
      (Math.round(((p.color >>> 16) & 255) * shade) << 16) |
      (Math.round(((p.color >>> 8) & 255) * shade) << 8) |
      Math.round((p.color & 255) * shade);
    view.setUint32(offset + 12, color >>> 0, true);
    view.setFloat32(offset + 16, p.uv[0], true);
    view.setFloat32(offset + 20, p.uv[1], true);
  }
  const indexBytes = new Uint8Array(indices.length * 2),
    indexView = new DataView(indexBytes.buffer);
  indices.forEach((value, i) => indexView.setUint16(i * 2, value, true));
  return { vertices, indexBytes, parts, bounds };
}
