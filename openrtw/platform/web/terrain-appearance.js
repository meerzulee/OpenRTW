// OpenRTW presentation coefficients, not recovered RTW lighting, terrain
// categories or material rules. Heights are the scene's final WORLD-space
// Float32 samples (the caller already applied its height scale); geometry is untouched.
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const smooth = (low, high, value) => {
  const t = clamp((value - low) / (high - low), 0, 1);
  return t * t * (3 - 2 * t);
};
const policy = Object.freeze({
  id: 'openrtw-terrain-appearance-v1',
  heightUnits: 'world-space;caller-applied-height-scale',
  normals: 'radius2-central-secants;transverse1:2:1;clamped-boundaries',
  sampleRadius: 2,
  ambient: 0.78,
  directional: 0.2,
  lightDirection: Object.freeze([-0.42, 0.88, -0.22]),
  macroVariation: 'continuous-world-sines;maximum-amplitude0.03;no-random-seed',
  hillSlopeRange: Object.freeze([0.18, 0.92]),
  elevationBias: Object.freeze({ maximum: 0.12, from: 0.6, to: 5 }),
  tint: 'restrained-warm-coast;near-neutral-highlands;original-texture-modulation',
  alpha: 'hill-blend-weight;grass-pass-must-ignore-diffuse-alpha',
  maxDimension: 1024,
  maxVertices: 262144,
  maxAbsoluteHeight: 1000,
  stepRange: Object.freeze([1e-6, 16]),
  nativeEquivalence: false,
});
const lightLength = Math.hypot(...policy.lightDirection);
const light = policy.lightDirection.map((value) => value / lightLength);

/** Compute owned appearance arrays without changing or retaining source heights.
 * Packed colors are unsigned AARRGGBB; alpha equals hillWeights exactly. The
 * caller draws opaque grass first and uses alpha only for the hills overlay.
 * Arrays remain caller-owned/mutable; their frozen container/metadata hold no
 * borrowed source view, renderer, texture, geometry or asynchronous work.
 */
export function createTerrainAppearance({ heights, width, height, step = 0.5 } = {}) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 2 ||
    height < 2 ||
    width > policy.maxDimension ||
    height > policy.maxDimension ||
    width * height > policy.maxVertices
  )
    throw new RangeError('Terrain appearance grid exceeds its bounds');
  if (
    !(heights instanceof Float32Array) ||
    heights.length !== width * height ||
    !(heights.buffer instanceof ArrayBuffer)
  )
    throw new TypeError('Terrain appearance needs an owned nonshared Float32 height grid');
  if (!Number.isFinite(step) || step < policy.stepRange[0] || step > policy.stepRange[1])
    throw new RangeError('Terrain appearance step exceeds its bounds');
  const source = heights.slice();
  for (const value of source)
    if (!Number.isFinite(value) || Math.abs(value) > policy.maxAbsoluteHeight)
      throw new RangeError('Terrain appearance height exceeds the finite world-space range');
  const colors = new Uint32Array(source.length),
    hillWeights = new Uint8Array(source.length);
  const lastX = width - 1,
    lastZ = height - 1;
  const sample = (x, z) => source[clamp(z, 0, lastZ) * width + clamp(x, 0, lastX)];
  let minimumChannel = 255,
    maximumChannel = 0,
    minimumHillWeight = 255,
    maximumHillWeight = 0;
  for (let z = 0; z < height; z++)
    for (let x = 0; x < width; x++) {
      const left = Math.max(0, x - 2),
        right = Math.min(lastX, x + 2);
      const south = Math.max(0, z - 2),
        north = Math.min(lastZ, z + 2);
      let dx = 0,
        dz = 0;
      // Average parallel secants as well as widening their span. Linear surfaces
      // retain their exact slope, including at one-sided outer-grid boundaries.
      for (let offset = -1; offset <= 1; offset++) {
        const weight = offset === 0 ? 2 : 1;
        dx += weight * (sample(right, z + offset) - sample(left, z + offset));
        dz += weight * (sample(x + offset, north) - sample(x + offset, south));
      }
      dx /= 4 * (right - left) * step;
      dz /= 4 * (north - south) * step;
      const normalLength = Math.hypot(dx, 1, dz);
      const lambert = Math.max(0, (-dx * light[0] + light[1] - dz * light[2]) / normalLength);
      const i = z * width + x,
        h = source[i],
        worldX = x * step,
        worldZ = z * step;
      const macro =
        1 +
        0.018 * Math.sin(worldX * 0.071 + worldZ * 0.037) +
        0.012 * Math.sin(worldX * 0.029 - worldZ * 0.061 + 1.7);
      const shade = (policy.ambient + policy.directional * lambert) * macro;
      const coast = 1 - smooth(0.15, 1.25, h),
        highland = smooth(1.2, 6, h);
      const red = clamp(Math.round(255 * shade * (1 + 0.012 * coast + 0.006 * highland)), 0, 255);
      const green = clamp(Math.round(255 * shade * (1 + 0.004 * coast)), 0, 255);
      const blue = clamp(
        Math.round(255 * shade * (0.985 - 0.012 * coast + 0.012 * highland)),
        0,
        255
      );
      const slope = Math.hypot(dx, dz),
        bias =
          policy.elevationBias.maximum *
          smooth(policy.elevationBias.from, policy.elevationBias.to, h);
      const hill = Math.round(
        255 * smooth(policy.hillSlopeRange[0], policy.hillSlopeRange[1], slope + bias)
      );
      hillWeights[i] = hill;
      colors[i] = ((hill << 24) | (red << 16) | (green << 8) | blue) >>> 0;
      minimumChannel = Math.min(minimumChannel, red, green, blue);
      maximumChannel = Math.max(maximumChannel, red, green, blue);
      minimumHillWeight = Math.min(minimumHillWeight, hill);
      maximumHillWeight = Math.max(maximumHillWeight, hill);
    }
  const metadata = Object.freeze({
    ...policy,
    width,
    height,
    step,
    vertices: source.length,
    channelRange: Object.freeze([minimumChannel, maximumChannel]),
    hillWeightRange: Object.freeze([minimumHillWeight, maximumHillWeight]),
  });
  return Object.freeze({ colors, hillWeights, metadata });
}
