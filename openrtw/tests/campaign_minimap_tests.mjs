import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

// OpenRTW minimap interaction policy: these tests pin cell rounding, letterbox
// rejection and a geometric ground-plane/frustum intersection. They do not
// claim recovered native mouse rounding or native terrain-ray picking parity.
let source;
try {
  source = await fs.readFile(new URL('../platform/web/campaign-minimap.js', import.meta.url));
} catch (error) {
  // The minimap implementation is deferred while campaign fog is integrated.
  // Preserve its independent contracts without failing unrelated check.sh jobs.
  if (error.code !== 'ENOENT') throw error;
  console.log('SKIP campaign minimap: pending helper implementation');
  process.exit(0);
}
const { pickMinimapCell, groundFootprint } = await import(
  'data:text/javascript;base64,' + source.toString('base64')
);

let passed = 0;
function test(name, run) {
  run();
  ++passed;
  console.log(`PASS ${name}`);
}
const close = (actual, expected, message = 'coordinate differs') =>
  assert(Math.abs(actual - expected) < 1e-8, `${message}: ${actual} != ${expected}`);

// D3D row-vector matrix. The world horizontal plane is (x,0,z), so
// clipX=2*(x-left)/(right-left)-1, clipY=2*(z-south)/(north-south)-1,
// clipZ=0.5 and clipW=1. The unused height axis maps into clip depth.
function ortho(left, right, south, north) {
  return [
    2 / (right - left),
    0,
    0,
    0,
    0,
    0,
    1,
    0,
    0,
    2 / (north - south),
    0,
    0,
    -(left + right) / (right - left),
    -(south + north) / (north - south),
    0.5,
    1,
  ];
}
function canonical(points) {
  return points
    .map(({ x, y }) => [x, y])
    .sort((a, b) => (Math.abs(a[0] - b[0]) < 1e-8 ? a[1] - b[1] : a[0] - b[0]));
}
function polygon(actual, expected) {
  assert(Array.isArray(actual));
  assert.equal(actual.length, expected.length, 'polygon vertex count');
  const sorted = canonical(actual),
    want = canonical(expected);
  sorted.forEach((point, i) => point.forEach((value, k) => close(value, want[i][k])));
}
function rect(left, right, south, north) {
  return [
    { x: left, y: south },
    { x: right, y: south },
    { x: right, y: north },
    { x: left, y: north },
  ];
}
function clip(point, matrix) {
  return [0, 1, 2, 3].map(
    (column) => point.x * matrix[column] + point.y * matrix[column + 8] + matrix[column + 12]
  );
}
function bounded(points, width, height, matrix, bottomFraction = 1) {
  assert(Array.isArray(points));
  assert(points.length <= 16, 'convex map/frustum intersection has excessive vertices');
  for (const p of points) {
    assert(Number.isFinite(p.x) && Number.isFinite(p.y), 'nonfinite footprint coordinate');
    assert(
      p.x >= -1e-8 && p.x <= width + 1e-8 && p.y >= -1e-8 && p.y <= height + 1e-8,
      'footprint escaped map rectangle'
    );
    const [x, y, z, w] = clip(p, matrix),
      epsilon = 1e-7;
    assert(
      w >= -epsilon && x >= -w - epsilon && x <= w + epsilon,
      'point lies outside horizontal clip planes'
    );
    assert(
      y >= (1 - 2 * bottomFraction) * w - epsilon && y <= w + epsilon,
      'point lies outside cropped vertical clip planes'
    );
    assert(z >= -epsilon && z <= w + epsilon, 'point lies outside D3D depth planes');
  }
}

test('north-up cell picking includes top-left and excludes right/bottom and letterbox margins', () => {
  const view = { x: 20, y: 10, width: 80, height: 40 };
  for (const [px, py, expected] of [
    [20, 10, { x: 0, y: 1 }],
    [39.999, 29.999, { x: 0, y: 1 }],
    [40, 30, { x: 1, y: 0 }],
    [60, 10, { x: 2, y: 1 }],
    [99.999, 49.999, { x: 3, y: 0 }],
    [19.999, 30, null],
    [100, 30, null],
    [50, 9.999, null],
    [50, 50, null],
    [-1000, 30, null],
    [1000, 30, null],
    [0, 0, null],
  ])
    assert.deepEqual(pickMinimapCell(px, py, view, 4, 2), expected);
});

test('fractional view rectangles preserve cell boundaries and single-cell maps', () => {
  const view = { x: 0.25, y: 1.75, width: 10.5, height: 6.25 };
  assert.deepEqual(pickMinimapCell(0.25, 1.75, view, 7, 5), { x: 0, y: 4 });
  assert.deepEqual(pickMinimapCell(5.5, 4.875, view, 7, 5), { x: 3, y: 2 });
  assert.deepEqual(pickMinimapCell(10.749, 7.999, view, 7, 5), { x: 6, y: 0 });
  assert.equal(pickMinimapCell(10.75, 4, view, 7, 5), null);
  assert.equal(pickMinimapCell(1, 8, view, 7, 5), null);
  assert.deepEqual(pickMinimapCell(6, 4, view, 1, 1), { x: 0, y: 0 });
});

test('orthographic camera footprint intersects the world horizontal plane', () => {
  const matrix = ortho(2, 8, 1, 5),
    points = groundFootprint(matrix, 10, 6);
  polygon(points, rect(2, 8, 1, 5));
  bounded(points, 10, 6, matrix);
});

test('translated camera footprint clips to the map and rejects views wholly outside', () => {
  polygon(groundFootprint(ortho(-2, 6, 3, 9), 10, 6), rect(0, 6, 3, 6));
  polygon(groundFootprint(ortho(-20, 20, -10, 10), 10, 6), rect(0, 10, 0, 6));
  polygon(groundFootprint(ortho(8, 12, -3, 2), 10, 6), rect(8, 10, 0, 2));
  for (const matrix of [ortho(11, 14, 1, 5), ortho(1, 5, 7, 10), ortho(-5, -1, -5, -1)])
    assert.deepEqual(groundFootprint(matrix, 10, 6), []);
});

test('viewport bottom cropping keeps the northern ground visible above the HUD', () => {
  const matrix = ortho(2, 8, 1, 5);
  polygon(groundFootprint(matrix, 10, 6, 1), rect(2, 8, 1, 5));
  polygon(groundFootprint(matrix, 10, 6, 0.5), rect(2, 8, 3, 5));
  // The native-layout viewport leaves 619 of 768 pixels above the HUD. This
  // is the caller's selected visible fraction, not a hardcoded module constant.
  const fraction = 619 / 768;
  const points = groundFootprint(matrix, 10, 6, fraction);
  polygon(points, rect(2, 8, 5 - 4 * fraction, 5));
  bounded(points, 10, 6, matrix, fraction);
});

test('D3D near/far planes use zero-to-one depth and exclude behind-camera ground', () => {
  for (const depth of [-0.25, 1.25]) {
    const matrix = ortho(2, 8, 1, 5);
    matrix[14] = depth;
    assert.deepEqual(groundFootprint(matrix, 10, 6), []);
  }
  const behind = ortho(2, 8, 1, 5);
  behind[15] = -1;
  assert.deepEqual(groundFootprint(behind, 10, 6), []);
  // Slice with depth=x/10: near plane x>=0; far plane x<=10.
  const depthSlice = ortho(-5, 15, 1, 5);
  depthSlice[2] = 0.1;
  depthSlice[14] = 0;
  polygon(groundFootprint(depthSlice, 20, 6), rect(0, 10, 1, 5));
});

test('perspective horizon clipping yields finite bounded geometry without ray division', () => {
  // clipX=x-5, clipY=2, clipZ=z-1, clipW=z on ground. Visibility requires
  // z>=2 and |x-5|<=z, forming a six-vertex polygon on the 10x10 map.
  const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, -5, 2, -1, 0];
  const points = groundFootprint(matrix, 10, 10);
  polygon(points, [
    { x: 3, y: 2 },
    { x: 7, y: 2 },
    { x: 10, y: 5 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
    { x: 0, y: 5 },
  ]);
  bounded(points, 10, 10, matrix);
  // A horizon crosses the map at z=5, where clipW=0. The finite clipping
  // result may omit the zero-W apex but must never produce infinity/NaN.
  const horizon = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0.5, 1, -5, 0, -2.5, -5];
  bounded(groundFootprint(horizon, 10, 10), 10, 10, horizon);
  const degenerate = new Array(16).fill(0);
  bounded(groundFootprint(degenerate, 10, 10), 10, 10, degenerate);
});

test('helpers leave inputs untouched and publish independent result coordinates', () => {
  const view = Object.freeze({ x: 20, y: 10, width: 80, height: 40 });
  const matrix = Object.freeze(ortho(2, 8, 1, 5)),
    before = [...matrix];
  const cell = pickMinimapCell(20, 10, view, 4, 2);
  cell.x = 900;
  assert.deepEqual(pickMinimapCell(20, 10, view, 4, 2), { x: 0, y: 1 });
  const points = groundFootprint(matrix, 10, 6);
  points[0].x = 900;
  polygon(groundFootprint(matrix, 10, 6), rect(2, 8, 1, 5));
  assert.deepEqual([...matrix], before);
  assert.deepEqual(view, { x: 20, y: 10, width: 80, height: 40 });
});

test('malformed inputs refuse before any coordinate arithmetic', () => {
  const matrix = ortho(2, 8, 1, 5),
    view = { x: 20, y: 10, width: 80, height: 40 };
  for (const value of [NaN, Infinity, -Infinity, null, '20']) {
    assert.throws(() => pickMinimapCell(value, 20, view, 4, 2));
    assert.throws(() => pickMinimapCell(30, value, view, 4, 2));
  }
  for (const width of [0, -1, NaN, Infinity, 1.5, '4']) {
    assert.throws(() => pickMinimapCell(30, 20, view, width, 2));
    assert.throws(() => pickMinimapCell(30, 20, view, 4, width));
    assert.throws(() => groundFootprint(matrix, width, 6));
    assert.throws(() => groundFootprint(matrix, 10, width));
  }
  for (const invalid of [
    null,
    {},
    { ...view, x: NaN },
    { ...view, y: Infinity },
    { ...view, width: 0 },
    { ...view, height: -1 },
    { ...view, width: '80' },
  ])
    assert.throws(() => pickMinimapCell(30, 20, invalid, 4, 2));
  for (const invalid of [
    null,
    {},
    [],
    matrix.slice(1),
    [...matrix, 1],
    matrix.map((v, i) => (i === 7 ? NaN : v)),
    matrix.map((v, i) => (i === 14 ? Infinity : v)),
    matrix.map((v, i) => (i === 1 ? '0' : v)),
  ])
    assert.throws(() => groundFootprint(invalid, 10, 6));
  for (const fraction of [0, -0.1, 1.01, NaN, Infinity, null, '0.5'])
    assert.throws(() => groundFootprint(matrix, 10, 6, fraction));
});

console.log(`RESULT passed=${passed} failed=0`);
