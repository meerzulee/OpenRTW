import { assembleCasGeometry } from '/cas-geometry.js';

export const vegetationAdmissionProfile = 'openrtw-cas312-repeated-static-count-v1';
export const vegetationGeometryPolicy = Object.freeze({
  id: 'openrtw-original-olive-geometry-candidate-v1',
  admission: 'explicit-repeated-static-count312-only',
  pose: 'source-f32-plus-parent-translation-candidate',
  axes: 'unchanged-source-y-up-candidate',
  normalization: 'shared-centered-uniform-2.1-extent',
  uv: 'unchanged-source-uv',
  indices: 'unchanged-source-u16-winding',
  nativePoseEquivalent: false,
  nativeScaleEquivalent: false,
});
const range = (value, start, end) => value?.start === start && value.endExclusive === end;
const zero3 = (value) => Array.isArray(value) && value.length === 3 && value.every((v) => v === 0);
const refuse = () => {
  throw new Error('Vegetation CAS projection differs from selected source profile');
};

// This consumes an owned C API projection, not raw CAS bytes. The caller must
// independently join the exact source bytes/hash; only the selected original
// olive shape is supported here. The generic geometry helper still validates
// every admitted position, normal, UV, index, assignment and internal range.
export function assembleVegetationGeometry(model) {
  if (
    model?.schema !== 'openrtw-cas-static-candidate-v1' ||
    model.admissionProfile !== vegetationAdmissionProfile ||
    model.sourceBytes !== 2735 ||
    model.versionBits !== 0x4047ae14 ||
    model.headerLength !== 38 ||
    model.frameCount !== 68 ||
    model.rotationKeyCount !== 0 ||
    model.translationKeyCount !== 0 ||
    model.totalVertices !== 54 ||
    model.totalTriangles !== 29 ||
    !Array.isArray(model.bones) ||
    model.bones.length !== 1 ||
    !Array.isArray(model.meshes) ||
    model.meshes.length !== 1 ||
    !range(model.headerRange, 0, 42) ||
    !range(model.animationRange, 42, 379) ||
    !range(model.parentsRange, 52, 56) ||
    !range(model.frameTimeRange, 60, 332) ||
    !range(model.boneHeadersRange, 332, 367) ||
    !range(model.rotationRange, 367, 367) ||
    !range(model.translationRange, 367, 367) ||
    !range(model.bindRange, 367, 379)
  )
    refuse();
  const bone = model.bones[0],
    part = model.meshes[0];
  if (
    bone.id !== 0 ||
    bone.parent !== 0 ||
    bone.name !== 'Scene Root' ||
    bone.rotationKeys !== 0 ||
    bone.translationKeys !== 0 ||
    bone.rotationOffset !== 0 ||
    bone.translationOffset !== 0 ||
    !zero3(bone.bindLocalBits) ||
    !zero3(bone.candidateBindWorld) ||
    !range(bone.headerRange, 332, 367) ||
    part.name !== 'olive' ||
    part.chunkKind !== 1 ||
    part.attachedBone !== 0 ||
    part.vertices !== 54 ||
    part.triangles !== 29 ||
    part.vertexColorFlag !== 1 ||
    !range(part.recordRange, 391, 2572) ||
    !range(part.assignmentRange, 449, 449) ||
    !range(part.positionRange, 449, 1097) ||
    !range(part.normalRange, 1097, 1745) ||
    !range(part.indexRange, 1745, 1919) ||
    !range(part.uvRange, 1923, 2355) ||
    !range(part.colorRange, 2355, 2571)
  )
    refuse();
  if (
    !Array.isArray(model.chunks) ||
    model.chunks.length !== 2 ||
    model.chunks[0]?.kind !== 1 ||
    model.chunks[0].meshes !== 1 ||
    !range(model.chunks[0].range, 379, 2578) ||
    model.chunks[1]?.kind !== 2 ||
    model.chunks[1].meshes !== 0 ||
    !range(model.chunks[1].range, 2578, 2594) ||
    !Array.isArray(model.opaqueChunks) ||
    model.opaqueChunks.length !== 3 ||
    Array.from(model.opaqueChunks).some(
      (chunk, i) =>
        chunk?.kind !== [3, 8, 10][i] ||
        chunk.meshes !== 0 ||
        !range(chunk.range, 2594 + i * 16, 2610 + i * 16)
    ) ||
    model.material?.textureName !== 'textures\\olive.tga' ||
    !range(model.material.range, 2642, 2735) ||
    !range(model.material.nameRange, 2659, 2678) ||
    !range(model.material.opaqueTailRange, 2706, 2734)
  )
    refuse();
  return Object.freeze({
    ...assembleCasGeometry(model),
    admissionProfile: vegetationAdmissionProfile,
    presentationPolicy: vegetationGeometryPolicy,
  });
}
