import { movementTerrainReason } from './campaign-interactions.js';

// Matches the executable OpenRTW prototype, not original RTW movement costs,
// terrain pathfinding, diagonal edges, or native movement-area drawing.
export const campaignMovementRangePolicy = Object.freeze({
  id: 'openrtw-executable-cardinal-range-v1',
  path: 'core-occupancy-only-bfs;enqueue-east-north-west-south;immutable-first-parent',
  terrain: 'admit-only-completely-valid-core-parent-chains;origin-excluded',
  destinations: 'current-ap;explored;unoccupied;unsupported-structure-targets-excluded',
  transit: 'structures-and-fog-do-not-change-core-search',
  nativePathfindingParity: false,
});

const uint = (v) => Number.isInteger(v) && v >= 0 && v <= 0xffffffff;
const maxCells = 65536,
  maxActors = 4096,
  maxAp = 80;

/** One bounded search reproduces preview_route_impl's predecessor tree. Terrain
 * MUST NOT block enqueues: doing that would discover valid alternative routes
 * which the current core does not return and the UI therefore cannot execute.
 * Fog/structure filtering applies to destinations, preserving core transit.
 * The caller caches this owned result across renders and invalidates it on
 * selection, session/AP, terrain, command-target, or fog knowledge changes.
 * Treat the owned typed mask as read-only. Cells omit the no-op origin.
 */
export function buildCampaignMovementRange({
  width,
  height,
  actor = null,
  actors = [],
  controllable = false,
  categoryAt,
  terrainExplored,
  blockedTargets = [],
  revision = 0,
  expectedRevision = revision,
  generation = 0,
  expectedGeneration = generation,
  orderRevision = 0,
} = {}) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 4096 ||
    height > 4096 ||
    width * height > maxCells ||
    !Array.isArray(actors) ||
    actors.length > maxActors ||
    !Array.isArray(blockedTargets) ||
    blockedTargets.length > maxCells ||
    typeof controllable !== 'boolean' ||
    typeof categoryAt !== 'function' ||
    typeof terrainExplored !== 'function' ||
    ![revision, expectedRevision, generation, expectedGeneration, orderRevision].every(uint)
  )
    throw new TypeError('Invalid campaign movement range inputs');
  const inside = (p) =>
    p &&
    Number.isInteger(p.x) &&
    Number.isInteger(p.y) &&
    p.x >= 0 &&
    p.y >= 0 &&
    p.x < width &&
    p.y < height;
  const count = width * height,
    mask = new Uint8Array(count),
    cells = [];
  let visitedCells = 0;
  const finish = (status) =>
    Object.freeze({
      policy: campaignMovementRangePolicy,
      width,
      height,
      actorId: actor?.id ?? null,
      origin: actor && inside(actor) ? Object.freeze({ x: actor.x, y: actor.y }) : null,
      availableAp: actor?.actionPoints ?? 0,
      generation,
      revision,
      orderRevision,
      status,
      mask,
      cells: Object.freeze(cells),
      visitedCells,
    });
  if (generation !== expectedGeneration) return finish('stale_generation');
  if (revision !== expectedRevision) return finish('stale_revision');
  if (actor === null) return finish('no_selection');
  if (!uint(actor.id) || !inside(actor) || !uint(actor.actionPoints) || actor.actionPoints > maxAp)
    throw new TypeError('Invalid campaign movement range actor');
  if (!controllable) return finish('not_controllable');
  if (actor.actionPoints === 0) return finish('no_ap');
  if (movementTerrainReason(actor, actor.type === 'admiral' ? 10 : 0))
    return finish('unsupported_actor');
  const blocked = new Uint8Array(count),
    commandTargets = new Uint8Array(count),
    ids = new Set();
  let source = null;
  for (const other of actors) {
    if (!uint(other?.id) || !inside(other) || ids.has(other.id))
      throw new TypeError('Invalid campaign movement range occupancy');
    ids.add(other.id);
    if (other.id === actor.id) source = other;
    else blocked[other.x + other.y * width] = 1;
  }
  if (!source) return finish('invalid_actor');
  if (
    source.x !== actor.x ||
    source.y !== actor.y ||
    (source.actionPoints !== undefined && source.actionPoints !== actor.actionPoints) ||
    (source.type !== undefined && source.type !== actor.type)
  )
    return finish('stale_actor');
  for (const target of blockedTargets) {
    if (!inside(target)) throw new TypeError('Invalid campaign movement command target');
    commandTargets[target.x + target.y * width] = 1;
  }
  const distance = new Int32Array(count).fill(-1),
    admittedChain = new Uint8Array(count),
    queue = new Uint32Array(count),
    start = actor.x + actor.y * width,
    depthLimit = Math.min(actor.actionPoints, 0xffffffff - revision);
  let head = 0,
    tail = 1;
  distance[start] = 0;
  admittedChain[start] = 1; // The UI's route guard deliberately excludes origin.
  queue[0] = start; // Coincident actors may leave, as in the core.
  while (head < tail) {
    const current = queue[head++],
      x = current % width,
      y = Math.floor(current / width),
      steps = distance[current] + 1;
    if (steps > depthLimit) continue;
    const enqueue = (next) => {
      if (blocked[next] || distance[next] !== -1) return;
      distance[next] = steps; // Immutable first parent, including invalid terrain.
      queue[tail++] = next;
      const nx = next % width,
        ny = Math.floor(next / width);
      let legal = false;
      try {
        legal =
          Boolean(admittedChain[current]) &&
          movementTerrainReason(actor, categoryAt(nx, ny)) === null;
      } catch {
        // A missing terrain cell cannot become an optimistic movement promise.
      }
      admittedChain[next] = Number(legal);
      if (!legal || commandTargets[next]) return;
      let explored = false;
      try {
        explored = terrainExplored(nx, ny) === true;
      } catch {
        // Unavailable knowledge is not a presented destination.
      }
      if (!explored) return;
      mask[next] = 1;
      cells.push(Object.freeze({ x: nx, y: ny, steps }));
    };
    if (x + 1 < width) enqueue(current + 1);
    if (y + 1 < height) enqueue(current + width);
    if (x !== 0) enqueue(current - 1);
    if (y !== 0) enqueue(current - width);
  }
  visitedCells = tail;
  return finish('ok');
}
