import { campaignVegetationSources } from '/vegetation-assets.js';

export const campaignVegetationPlacementPolicy = Object.freeze({
  id: 'openrtw-sparse-olive-grid-candidate-v1',
  selection:
    'exact-literal-season/sparse_tree/olive_a.cas climate row plus caller-selected neutral category IDs',
  distribution: 'row-major integer cell stride, one original mesh at the selected cell centre',
  anchor: 'positive-original-HGT-cell-centre-times-0.001;world-X-east-Z-north',
  defaultSpacing: 2,
  defaultMaxInstances: 256,
  defaultEligibleCategories: Object.freeze([]),
  exclusions: 'caller-supplied cell circles;no inferred settlement radius',
  nativePlacementEquivalent: false,
  unknown:
    'Original campaign density, numeric strategy variant meaning, jitter, scale, LOD, clipping and winter fallback.',
});
export const campaignVegetationClimateSourceSha256 =
  '3a21c82f911a410a88c0d3fcb34cc7a5ba712b2fcfcad3aca45136911602e4e6';
// The existing climate API publishes names and an opaque-row count. Preserve
// only these two exact active declarations from the pinned config; the nearby
// commented-out mediterranean row is deliberately absent. Variant10 is opaque.
export const campaignVegetationClimateBindings = Object.freeze([
  Object.freeze({
    climateName: 'test_climate',
    season: 'summer',
    role: 'sparse_tree',
    model: 'olive_a.cas',
    sourceLine: 32,
    sourceVariant: 10,
  }),
  Object.freeze({
    climateName: 'semi_arid',
    season: 'summer',
    role: 'sparse_tree',
    model: 'olive_a.cas',
    sourceLine: 318,
    sourceVariant: 10,
  }),
]);
const uint = (value) => Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
const refuse = (message) => {
  throw new TypeError('Vegetation placement: ' + message);
};
function values(input, count, test) {
  if ((!Array.isArray(input) && !ArrayBuffer.isView(input)) || input.length !== count)
    refuse('invalid grid extent');
  const copy = Array.from(input);
  if (copy.some((value) => !test(value))) refuse('invalid grid value');
  return copy;
}
function binding(definition, season) {
  if (!definition || typeof definition.name !== 'string' || !/^[a-z_]{1,64}$/.test(definition.name))
    refuse('invalid climate definition');
  return (
    campaignVegetationClimateBindings.find(
      (row) => row.climateName === definition.name && row.season === season
    ) ?? null
  );
}

// Pure, opt-in presentation data. It neither changes movement/passability nor
// labels neutral category IDs as native forests. Empty categories mean no trees.
export function buildCampaignVegetationPlacements(
  {
    worldWidth,
    worldHeight,
    categoryIds,
    climateIds,
    climateDefinitions,
    climateSourceSha256,
    terrainWidth,
    terrainHeight,
    heightAt,
  },
  {
    eligibleCategories = [],
    season = 'summer',
    spacing = 2,
    maxInstances = 256,
    exclusions = [],
  } = {}
) {
  if (
    !uint(worldWidth) ||
    worldWidth < 1 ||
    worldWidth > 255 ||
    !uint(worldHeight) ||
    worldHeight < 1 ||
    worldHeight > 156 ||
    terrainWidth !== worldWidth * 2 + 1 ||
    terrainHeight !== worldHeight * 2 + 1 ||
    typeof heightAt !== 'function'
  )
    refuse('invalid world dimensions');
  if (
    !['summer', 'winter'].includes(season) ||
    !uint(spacing) ||
    spacing < 1 ||
    spacing > 32 ||
    !uint(maxInstances) ||
    maxInstances > 4096
  )
    refuse('invalid candidate policy');
  if (
    !Array.isArray(eligibleCategories) ||
    eligibleCategories.length > 15 ||
    Array.from(eligibleCategories).some((value) => !uint(value) || value > 14) ||
    new Set(eligibleCategories).size !== eligibleCategories.length
  )
    refuse('invalid eligible categories');
  if (
    climateSourceSha256 !== campaignVegetationClimateSourceSha256 ||
    !Array.isArray(climateDefinitions) ||
    !climateDefinitions.length ||
    climateDefinitions.length > 256 ||
    new Set(climateDefinitions.map((v) => v?.name)).size !== climateDefinitions.length
  )
    refuse('invalid climates or source identity');
  if (
    !Array.isArray(exclusions) ||
    exclusions.length > 256 ||
    Array.from(exclusions).some(
      (v) =>
        !v ||
        !uint(v.x) ||
        v.x >= worldWidth ||
        !uint(v.y) ||
        v.y >= worldHeight ||
        !Number.isFinite(v.radius) ||
        v.radius < 0 ||
        v.radius > 32
    )
  )
    refuse('invalid exclusion');
  const count = worldWidth * worldHeight,
    categories = values(categoryIds, count, (value) => uint(value) && value <= 14),
    climates = values(
      climateIds,
      count,
      (value) => uint(value) && value < climateDefinitions.length
    ),
    bindings = Array.from(climateDefinitions, (value) => binding(value, season));
  const allowed = new Set(eligibleCategories),
    clips = exclusions.map((v) => ({ ...v })),
    instances = [];
  let candidateCount = 0;
  // Validate the complete input before the safe empty fallback; no height reads.
  if (allowed.size && maxInstances)
    for (let y = 0; y < worldHeight; y += spacing)
      for (let x = 0; x < worldWidth; x += spacing) {
        const id = y * worldWidth + x,
          b = bindings[climates[id]];
        if (
          !b ||
          !allowed.has(categories[id]) ||
          clips.some((v) => (x - v.x) ** 2 + (y - v.y) ** 2 <= v.radius ** 2)
        )
          continue;
        const sourceHeight = heightAt(x * 2 + 1, y * 2 + 1);
        if (!Number.isFinite(sourceHeight) || Math.abs(sourceHeight) > 1e6)
          refuse('nonfinite or out-of-range HGT sample');
        if (sourceHeight <= 0) continue;
        candidateCount++;
        if (instances.length < maxInstances)
          instances.push(
            Object.freeze({
              id,
              cellX: x,
              cellY: y,
              x: x + 0.5,
              y: Math.fround(sourceHeight * 0.001),
              z: y + 0.5,
              categoryId: categories[id],
              climateId: climates[id],
              ...b,
            })
          );
      }
  return Object.freeze({
    sourcePath: campaignVegetationSources.model.path,
    sourceSha256: campaignVegetationSources.model.sha256,
    presentationPolicy: campaignVegetationPlacementPolicy,
    season,
    spacing,
    maxInstances,
    eligibleCategories: Object.freeze([...eligibleCategories]),
    instances: Object.freeze(instances),
    candidateCount,
    omittedCandidateCount: candidateCount - instances.length,
  });
}
