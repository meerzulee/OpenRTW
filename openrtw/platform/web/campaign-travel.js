// Presentation only. The core's checked cardinal route, occupancy, AP and fog
// remain authoritative. Curves stay inside the cells of that supplied route.
const uint = (n) => Number.isInteger(n) && n >= 0 && n <= 0xffffffff;
const finite = Number.isFinite;
const point = (p) =>
  p &&
  Number.isInteger(p.x) &&
  Number.isInteger(p.y) &&
  p.x >= 0 &&
  p.y >= 0 &&
  p.x < 4096 &&
  p.y < 4096;
const freezePoint = (p) => Object.freeze(p);
const lerp = (a, b, t) => a + (b - a) * t;

export function smoothCampaignPath(points, { spacing = 0.1, cornerRadius = 0.28 } = {}) {
  if (
    !Array.isArray(points) ||
    points.length < 2 ||
    points.length > 81 ||
    !finite(spacing) ||
    spacing < 0.025 ||
    spacing > 0.25 ||
    !finite(cornerRadius) ||
    cornerRadius < 0 ||
    cornerRadius > 0.4
  )
    throw TypeError('Invalid campaign presentation path');
  const seen = new Set();
  for (let i = 0; i < points.length; i++) {
    const p = points[i],
      key = `${p?.x},${p?.y}`;
    if (
      !point(p) ||
      seen.has(key) ||
      (i && Math.abs(p.x - points[i - 1].x) + Math.abs(p.y - points[i - 1].y) !== 1)
    )
      throw TypeError('Invalid checked cardinal path');
    seen.add(key);
  }
  const samples = [{ x: points[0].x, y: points[0].y }];
  const push = (p) => {
    const last = samples.at(-1);
    if (Math.hypot(p.x - last.x, p.y - last.y) > 1e-10) samples.push(p);
  };
  const line = (to) => {
    const from = samples.at(-1),
      count = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / spacing));
    for (let i = 1; i <= count; i++)
      push({ x: lerp(from.x, to.x, i / count), y: lerp(from.y, to.y, i / count) });
  };
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1],
      p = points[i],
      b = points[i + 1],
      dx = p.x - a.x,
      dy = p.y - a.y,
      nx = b.x - p.x,
      ny = b.y - p.y;
    if (!cornerRadius || (dx === nx && dy === ny)) {
      line(p);
      continue;
    }
    const before = { x: p.x - dx * cornerRadius, y: p.y - dy * cornerRadius },
      after = { x: p.x + nx * cornerRadius, y: p.y + ny * cornerRadius };
    line(before);
    // All three Bezier controls lie inside p's own cell: its convex hull cannot
    // clip the blocked diagonal cell on the outside of a cardinal corner.
    const count = Math.max(4, Math.ceil((cornerRadius * 2) / spacing));
    for (let j = 1; j <= count; j++) {
      const t = j / count,
        s = 1 - t;
      push({
        x: s * s * before.x + 2 * s * t * p.x + t * t * after.x,
        y: s * s * before.y + 2 * s * t * p.y + t * t * after.y,
      });
    }
  }
  line(points.at(-1));
  let distance = 0;
  return Object.freeze(
    samples.map((p, i) => {
      if (i) distance += Math.hypot(p.x - samples[i - 1].x, p.y - samples[i - 1].y);
      const a = samples[Math.max(0, i - 1)],
        b = samples[Math.min(samples.length - 1, i + 1)];
      return freezePoint({ ...p, distance, heading: Math.atan2(b.x - a.x, b.y - a.y) });
    })
  );
}

/** No RAF, wall clock or campaign references are retained. nowSeconds is the
 * caller's monotonic animation clock. Completed headings persist until cancel.
 * start accepts multiple actor IDs for a committed faction journey batch.
 */
export function createCampaignTravel({ secondsPerCell = 0.16 } = {}) {
  if (!finite(secondsPerCell) || secondsPerCell < 0.02 || secondsPerCell > 2)
    throw TypeError('Invalid campaign travel speed');
  const tracks = new Map();
  let lastTime = 0,
    disposed = false;
  const alive = () => {
    if (disposed) throw Error('Campaign travel is disposed');
  };
  return Object.freeze({
    get active() {
      return !disposed && [...tracks.values()].some((t) => !t.finished);
    },
    start({ actorId, points, generation, revision, nowSeconds = lastTime }) {
      alive();
      if (
        ![actorId, generation, revision].every(uint) ||
        !finite(nowSeconds) ||
        nowSeconds < 0 ||
        nowSeconds > 1e12 ||
        (!tracks.has(actorId) && tracks.size >= 4096)
      )
        throw TypeError('Invalid campaign travel admission');
      const path = smoothCampaignPath(points);
      const start = Math.max(lastTime, nowSeconds),
        duration = path.at(-1).distance * secondsPerCell;
      tracks.set(actorId, {
        actorId,
        generation,
        revision,
        path,
        start,
        duration,
        finished: false,
      });
      return Object.freeze({ actorId, generation, revision, duration, points: path.length });
    },
    sample(nowSeconds) {
      alive();
      if (!finite(nowSeconds) || nowSeconds < 0 || nowSeconds > 1e12)
        throw TypeError('Invalid campaign travel time');
      lastTime = Math.max(lastTime, nowSeconds);
      return Object.freeze(
        [...tracks.values()].map((track) => {
          const { path } = track,
            progress =
              lastTime - track.start + 1e-10 >= track.duration
                ? 1
                : Math.min(1, Math.max(0, (lastTime - track.start) / track.duration)),
            distance = path.at(-1).distance * progress;
          track.finished = progress === 1;
          let lo = 0,
            hi = path.length - 1;
          while (hi - lo > 1) {
            const mid = (lo + hi) >> 1;
            if (path[mid].distance <= distance) lo = mid;
            else hi = mid;
          }
          const a = path[lo],
            b = path[hi],
            t = Math.min(1, Math.max(0, (distance - a.distance) / (b.distance - a.distance))),
            angle = Math.atan2(Math.sin(b.heading - a.heading), Math.cos(b.heading - a.heading));
          return freezePoint({
            actorId: track.actorId,
            generation: track.generation,
            revision: track.revision,
            x: progress === 1 ? b.x : lerp(a.x, b.x, t),
            y: progress === 1 ? b.y : lerp(a.y, b.y, t),
            heading: a.heading + angle * t,
            moving: !track.finished,
            progress,
            distance,
          });
        })
      );
    },
    cancel(actorId) {
      if (disposed) return;
      if (actorId === undefined) tracks.clear();
      else {
        if (!uint(actorId)) throw TypeError('Invalid campaign travel actor');
        tracks.delete(actorId);
      }
    },
    dispose() {
      if (disposed) return;
      tracks.clear();
      disposed = true;
    },
  });
}

/** Trace the union, inset it and round its connected boundaries. The origin is
 * visual area, although it is deliberately absent from executable destinations.
 * All output points stay in that union, including near holes and diagonal ties.
 */
export function campaignMovementBoundary({ width, height, cells, origin = null }) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > 65536 ||
    !Array.isArray(cells) ||
    cells.length > width * height
  )
    throw TypeError('Invalid campaign area shape');
  const mask = new Uint8Array(width * height),
    insideCell = (x, y) =>
      x >= 0 && y >= 0 && x < width && y < height && Boolean(mask[x + y * width]);
  for (const p of origin === null ? cells : [...cells, origin]) {
    if (!point(p) || p.x >= width || p.y >= height) throw TypeError('Invalid campaign area cell');
    mask[p.x + p.y * width] = 1;
  }
  const edges = [],
    starts = new Map();
  function edge(x, y, bx, by, direction) {
    const e = { x, y, bx, by, direction, used: false },
      key = `${x},${y}`;
    edges.push(e);
    if (!starts.has(key)) starts.set(key, []);
    starts.get(key).push(e);
  }
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (insideCell(x, y)) {
        if (!insideCell(x, y - 1)) edge(x, y, x + 1, y, 0);
        if (!insideCell(x + 1, y)) edge(x + 1, y, x + 1, y + 1, 1);
        if (!insideCell(x, y + 1)) edge(x + 1, y + 1, x, y + 1, 2);
        if (!insideCell(x - 1, y)) edge(x, y + 1, x, y, 3);
      }
  const contained = (x, y) => insideCell(Math.floor(x), Math.floor(y));
  const loops = [],
    rank = [1, 0, 3, 2];
  for (const seed of edges) {
    if (seed.used) continue;
    const raw = [];
    let e = seed;
    do {
      e.used = true;
      raw.push({ x: e.x, y: e.y });
      if (e.bx === seed.x && e.by === seed.y) break;
      const next = (starts.get(`${e.bx},${e.by}`) ?? [])
        .filter((n) => !n.used)
        .sort(
          (a, b) =>
            rank[(a.direction - e.direction + 4) % 4] - rank[(b.direction - e.direction + 4) % 4]
        );
      if (!next.length) throw Error('Campaign area boundary is open');
      e = next[0];
    } while (raw.length <= edges.length);
    const vertices = raw.filter((p, i) => {
      const a = raw[(i + raw.length - 1) % raw.length],
        b = raw[(i + 1) % raw.length];
      return (p.x - a.x) * (b.y - p.y) !== (p.y - a.y) * (b.x - p.x);
    });
    const result = [],
      inset = 0.085;
    for (let i = 0; i < vertices.length; i++) {
      const p = vertices[i],
        a = vertices[(i + vertices.length - 1) % vertices.length],
        b = vertices[(i + 1) % vertices.length],
        al = Math.hypot(p.x - a.x, p.y - a.y),
        bl = Math.hypot(b.x - p.x, b.y - p.y),
        dx = (p.x - a.x) / al,
        dy = (p.y - a.y) / al,
        nx = (b.x - p.x) / bl,
        ny = (b.y - p.y) / bl,
        center = { x: p.x - (dy + ny) * inset, y: p.y + (dx + nx) * inset };
      // Concave turns need clearance for the stroke too, not just its centre.
      let radius = Math.min(dx * ny - dy * nx < 0 ? 0.2 : 0.32, al * 0.3, bl * 0.3),
        curve;
      for (let attempt = 0; attempt < 8; attempt++, radius *= 0.5) {
        const from = { x: center.x - dx * radius, y: center.y - dy * radius },
          to = { x: center.x + nx * radius, y: center.y + ny * radius };
        curve = Array.from({ length: 9 }, (_, k) => {
          const t = k / 8,
            s = 1 - t;
          return {
            x: s * s * from.x + 2 * s * t * center.x + t * t * to.x,
            y: s * s * from.y + 2 * s * t * center.y + t * t * to.y,
          };
        });
        if (curve.every((q) => contained(q.x, q.y))) break;
      }
      if (!curve.every((q) => contained(q.x, q.y)))
        throw Error('Campaign area smoothing left admitted cells');
      result.push(...curve.map(freezePoint));
    }
    if (result.length) loops.push(Object.freeze(result));
  }
  return Object.freeze({
    mask,
    loops: Object.freeze(loops),
    cellCount: mask.reduce((a, b) => a + b, 0),
  });
}
