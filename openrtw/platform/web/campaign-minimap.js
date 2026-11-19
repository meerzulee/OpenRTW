// Camera/minimap presentation helpers. These project the browser camera and
// never query visibility or issue campaign orders. Native minimap rounding and
// its terrain-intersection algorithm remain separate reconstruction work.
const finite = Number.isFinite;
const dimension = (n) => Number.isInteger(n) && n > 0 && n <= 4096;

export function pickMinimapCell(px, py, view, width, height) {
  if (
    !finite(px) ||
    !finite(py) ||
    !dimension(width) ||
    !dimension(height) ||
    !view ||
    ![view.x, view.y, view.width, view.height].every(finite) ||
    view.width <= 0 ||
    view.height <= 0
  )
    throw TypeError('Invalid minimap coordinates');
  const x = (px - view.x) / view.width,
    y = (py - view.y) / view.height;
  if (x < 0 || y < 0 || x >= 1 || y >= 1) return null;
  return { x: Math.floor(x * width), y: height - 1 - Math.floor(y * height) };
}

export function groundFootprint(matrix, width, height, bottomFraction = 1) {
  if (
    !Array.isArray(matrix) ||
    matrix.length !== 16 ||
    !matrix.every((v) => finite(v) && Math.abs(v) <= 1e12) ||
    !dimension(width) ||
    !dimension(height) ||
    !finite(bottomFraction) ||
    bottomFraction <= 0 ||
    bottomFraction > 1
  )
    throw TypeError('Invalid minimap camera projection');
  const column = (i) => [matrix[i], matrix[i + 8], matrix[i + 12]],
    x = column(0),
    y = column(1),
    z = column(2),
    w = column(3),
    add = (a, b, k = 1) => a.map((v, i) => v + k * b[i]),
    planes = [
      w,
      add(w, x),
      add(w, x, -1),
      add(w, y, -1),
      add(y, w, 2 * bottomFraction - 1),
      z,
      add(w, z, -1),
    ];
  let points = [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ];
  // Intersect the finite map polygon with homogeneous D3D frustum planes.
  // This stays bounded when the camera horizon crosses the world plane.
  for (const plane of planes) {
    if (!points.length) break;
    const value = (p) => plane[0] * p.x + plane[1] * p.y + plane[2],
      next = [];
    let a = points.at(-1),
      av = value(a);
    for (const b of points) {
      const bv = value(b),
        ai = av >= 0,
        bi = bv >= 0;
      if (ai !== bi) {
        const t = av / (av - bv);
        next.push({ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) });
      }
      if (bi) next.push({ ...b });
      a = b;
      av = bv;
    }
    points = next.filter(
      (p, i) => !i || Math.hypot(p.x - next[i - 1].x, p.y - next[i - 1].y) > 1e-10
    );
    if (
      points.length > 1 &&
      Math.hypot(points[0].x - points.at(-1).x, points[0].y - points.at(-1).y) < 1e-10
    )
      points.pop();
  }
  return points;
}
