// OpenRTW UI policy for the commands currently exposed by the prototype.
// This is neither the native contextual-action selector nor native pathfinding.
export const campaignInteractionPolicy = Object.freeze({
  id: 'openrtw-campaign-context-guards-v1',
  water: 'native4710FC-category10-through12',
  land: 'source-admitted-land-actors-on-known-nonwater-categories0-through9-and13',
  unknownTerrain: 'blocked',
  pathfinding: 'not-implemented-here;validate-the-supplied-planned-segment',
  unsupported: 'combat;merging;garrison;embarkation;agent-missions',
});

const landTypes = new Set(['named character', 'general', 'spy', 'diplomat']);
const coordinate = (n) => Number.isSafeInteger(n) && n >= 0 && n < 4096;
const cell = (value) => value && coordinate(value.x) && coordinate(value.y);
const id = (n) => Number.isInteger(n) && n >= 0 && n <= 0xffffffff;
const text = (value, fallback = '') => {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string' || value.length > 512 || /[\x00-\x1f\x7f]/.test(value))
    throw TypeError('Invalid campaign interaction text');
  return value;
};
const result = (cursor, action, message = '') => Object.freeze({ cursor, action, message });

/** A conservative web guard only. 4710FC proves the water category group;
 * category13 is known nonwater and14 is the unknown-palette sentinel. Current
 * campaign.cpp admits four land classes plus admiral. Height, terrain cost,
 * mountains/forests, embarkation, ports and native edge rules are not inferred.
 */
export function movementTerrainReason(actor, category) {
  if (!actor || (!landTypes.has(actor.type) && actor.type !== 'admiral'))
    return 'Movement for this character type is not supported.';
  if (!Number.isInteger(category) || category < 0 || category > 13)
    return 'This terrain category is not supported for movement.';
  const water = category >= 10 && category <= 12;
  if (actor.type === 'admiral') return water ? null : 'Fleets can move only on water.';
  return water ? 'Land characters cannot move onto water. Embarkation is not implemented.' : null;
}

/** Check the final target even for a partial journey, and every planned point
 * after its bound origin. A legal destination cannot excuse crossing water or
 * land in the middle of the segment. Returns null only for an admitted segment.
 */
export function routeTerrainReason(actor, route, categoryAt) {
  if (
    !cell(actor) ||
    !route ||
    route.status !== 'ok' ||
    !cell(route.target) ||
    !Array.isArray(route.points) ||
    route.points.length < 2 ||
    route.points.length > 65536 ||
    typeof categoryAt !== 'function'
  )
    return 'Route terrain could not be checked.';
  if (!cell(route.points[0]) || route.points[0].x !== actor.x || route.points[0].y !== actor.y)
    return 'The route no longer starts at the selected character.';
  const check = (point) => {
    if (!cell(point)) return 'Route terrain could not be checked.';
    try {
      return movementTerrainReason(actor, categoryAt(point.x, point.y));
    } catch {
      return 'Route terrain could not be checked.';
    }
  };
  const targetReason = check(route.target);
  if (targetReason) return targetReason;
  for (let i = 1; i < route.points.length; i++) {
    const reason = check(route.points[i]);
    if (reason) return reason;
  }
  return null;
}

/** Resolve RIGHT-click context; left-click selection/inspection stays with the
 * app. Inputs must already be filtered for player visibility. This helper never
 * creates a route, changes selection, or mutates simulation state.
 */
export function resolveCampaignInteraction({
  selected = null,
  controllable = false,
  target = null,
  route = null,
  routeReason = '',
  terrainReason = '',
} = {}) {
  if (typeof controllable !== 'boolean' || (selected !== null && !id(selected.id)))
    throw TypeError('Invalid campaign interaction selection');
  routeReason = text(routeReason);
  terrainReason = text(terrainReason);
  if (target === null) return result('select', 'none');
  if (!['character', 'settlement', 'port', 'ground'].includes(target.kind))
    throw TypeError('Invalid campaign interaction target');
  const ownSelection = selected !== null && controllable;
  if (target.kind === 'character') {
    const actor = target.actor;
    if (!actor || !id(actor.id) || typeof target.owned !== 'boolean')
      throw TypeError('Invalid campaign interaction character');
    const name = text(actor.name, 'this character');
    if (!ownSelection)
      return target.owned
        ? result('selectable', 'select', `Right-click to select ${name}.`)
        : result('selectable', 'inspect', `Right-click to inspect ${name}.`);
    if (actor.id === selected.id || target.owned)
      return result('selectable', 'select', `Right-click to select ${name}.`);
    return result(
      'attack-unavailable',
      'blocked',
      'Attacks and agent missions against other factions are not implemented. Left-click to inspect.'
    );
  }
  if (target.kind === 'settlement' || target.kind === 'port') {
    if (!id(target.id) || typeof target.owned !== 'boolean')
      throw TypeError('Invalid campaign interaction structure');
    const name = text(target.name, `this ${target.kind}`);
    if (!ownSelection) return result('selectable', 'inspect', `Right-click to inspect ${name}.`);
    return result(
      'blocked',
      'blocked',
      target.owned
        ? `Entering ${target.kind === 'port' ? 'ports' : 'settlements'} is not implemented. Left-click to inspect ${name}.`
        : `Attacking ${target.kind === 'port' ? 'ports' : 'settlements'} is not implemented. Left-click to inspect ${name}.`
    );
  }
  if (!cell(target)) throw TypeError('Invalid campaign interaction ground cell');
  if (!ownSelection) return result('select', 'none', 'Select one of your characters to move.');
  if (terrainReason) return result('blocked', 'blocked', terrainReason);
  if (route === null) return result('select', 'none', 'Checking route.');
  if (route.status === 'no_op') return result('select', 'none', 'Already at this location.');
  if (route.status !== 'ok')
    return result('blocked', 'blocked', routeReason || 'Movement is unavailable.');
  if (
    !Number.isInteger(route.plannedSteps) ||
    route.plannedSteps < 1 ||
    route.plannedSteps > 65535 ||
    (route.partial !== undefined && typeof route.partial !== 'boolean')
  )
    throw TypeError('Invalid campaign interaction route');
  return result(
    'move',
    'move',
    `Right-click to move · ${route.plannedSteps} AP.${
      route.partial ? ' End turn to refill action points, then continue the journey.' : ''
    }`
  );
}
