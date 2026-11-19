// Original RTW getter words from one selected native frame. Camera position,
// terrain scaling and navigation are qualified reconstructions, not native 1:1.
const captureSha256 = '87c8040aec251150a6a390966bcb22ed97eae22390c681d6eccef7b6f822396e';
const targetEditionSha256 = 'c6641dc091c7a7073b27d83076970b826ee2b45937a38684e9802327b75bbc7b';
const viewWords = Object.freeze([
  0x3f800000, 0x00000000, 0x00000000, 0x00000000, 0x00000000, 0x3f19999b, 0xbf4ccccc, 0x00000000,
  0x80000000, 0x3f4ccccc, 0x3f19999b, 0x00000000, 0xc2b70000, 0xc280cccc, 0xc124ccd4, 0x3f800000,
]);
const projectionWords = Object.freeze([
  0x3fe7c3b5, 0x00000000, 0x00000000, 0x00000000, 0x00000000, 0x401a8279, 0x00000000, 0x00000000,
  0x00000000, 0x00000000, 0x3f8e38e4, 0x3f800000, 0xb9cc6666, 0xb9ff8000, 0xc131c71d, 0x00000000,
]);
const schema = 'openrtw-original-initial-campaign-view-v1';
const profileId = 'rtw-c664-initial-campaign-view361-projection2-v1';
const heightScaleBits = 0x399d4952;

export const originalInitialCampaignView = Object.freeze({
  schema,
  profileId,
  profileVersion: 1,
  source: Object.freeze({
    captureSha256,
    captureBytes: 930242,
    targetEditionSha256,
    viewValueId: 361,
    projectionValueId: 2,
    viewportValueId: 362,
    viewObservedCalls: 567,
    projectionObservedCalls: 566,
    viewportObservedCalls: 600,
    matrixConvention: 'D3D8-row-vector;raw-row-major-word-order;no-transpose',
    scope: 'one-selected-device-Present-to-Present-frame;getter-instrumented',
    captureRunStrictPassed: false,
    qualification:
      'Complete selected-frame log; UI deadline and private-prefix cleanup retained. Flavius selection, zoom and pixel-identical screenshot linkage unproved.',
  }),
  referenceViewport: Object.freeze({
    x: 0,
    y: 0,
    width: 1280,
    height: 1024,
    minZBits: 0,
    maxZBits: 0x3f800000,
  }),
  world: Object.freeze({ width: 255, height: 156, hgtWidth: 511, hgtHeight: 313 }),
  viewWords,
  projectionWords,
  inferredCamera: Object.freeze({
    focus: Object.freeze([91.5, 0, 80.5]),
    eye: Object.freeze([91.5, 30.4, 57.7]),
    distance: 38,
    pitchRadians: Math.asin(0.8),
    yawRadians: 0,
    verticalFovDegrees: 45.00000240668388,
    projectionAspect: 1.3333333772249858,
    qualification:
      'Conventional sea-plane focus/eye and perspective interpretation of the observed matrices; native camera and navigation semantics unproved.',
  }),
  terrainHeight: Object.freeze({
    scaleBits: heightScaleBits,
    qualification:
      'inferred from selected static world-height/HGT correspondences; whole terrain VB not captured',
    nativeWholeTerrainScaleProved: false,
  }),
  projectionPolicy:
    'Preserve all words, including small m30/m31 offsets, at the reference viewport. Other viewport sizes and navigation require an explicitly separate responsive candidate.',
  nativeOneToOneProved: false,
});

function decodeMatrix(words, expected, name) {
  if (!Array.isArray(words) || words.length !== 16)
    throw new TypeError(`Invalid ${name} matrix word count`);
  const values = new Float32Array(16),
    bits = new DataView(values.buffer);
  for (let i = 0; i < 16; i++) {
    const word = words[i];
    if (!Number.isInteger(word) || word < 0 || word > 0xffffffff)
      throw new TypeError(`Invalid ${name} matrix word`);
    bits.setUint32(i * 4, word, true);
    if (!Number.isFinite(bits.getFloat32(i * 4, true)))
      throw new TypeError(`Nonfinite ${name} matrix word`);
    if (word !== expected[i]) throw new TypeError(`Unbound ${name} matrix word`);
    // Store through the typed view as well, so returned numeric values do not
    // depend on host byte order. Signed zero is preserved.
    values[i] = bits.getFloat32(i * 4, true);
  }
  return values;
}

/** Decode this exact source-bound profile into fresh caller-owned matrices.
 * No projection normalization, jitter removal, camera fit or viewport resizing.
 */
export function decodeCampaignCameraReference(profile = originalInitialCampaignView) {
  const source = profile?.source,
    viewport = profile?.referenceViewport,
    world = profile?.world;
  if (
    profile?.schema !== schema ||
    profile.profileId !== profileId ||
    profile.profileVersion !== 1 ||
    source?.captureSha256 !== captureSha256 ||
    source.captureBytes !== 930242 ||
    source.targetEditionSha256 !== targetEditionSha256 ||
    source.viewValueId !== 361 ||
    source.projectionValueId !== 2 ||
    source.viewportValueId !== 362 ||
    viewport?.x !== 0 ||
    viewport.y !== 0 ||
    viewport.width !== 1280 ||
    viewport.height !== 1024 ||
    viewport.minZBits !== 0 ||
    viewport.maxZBits !== 0x3f800000 ||
    world?.width !== 255 ||
    world.height !== 156 ||
    world.hgtWidth !== 511 ||
    world.hgtHeight !== 313 ||
    profile.terrainHeight?.scaleBits !== heightScaleBits
  )
    throw new TypeError('Unbound original campaign camera reference');
  const view = decodeMatrix(profile.viewWords, viewWords, 'view');
  const projection = decodeMatrix(profile.projectionWords, projectionWords, 'projection');
  const scalar = new DataView(new ArrayBuffer(4));
  scalar.setUint32(0, heightScaleBits, true);
  return {
    view,
    projection,
    viewport: { x: 0, y: 0, width: 1280, height: 1024, minZ: 0, maxZ: 1 },
    heightScale: scalar.getFloat32(0, true),
  };
}
