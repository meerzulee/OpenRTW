// Guarded campaign static-shadow scene integration. This module owns only the
// per-frame admission of already-generated C++ side volumes: it never builds a
// silhouette, projects geometry onto terrain or invents caps. The porter
// (campaign-shadows.js) consumes the core wire; this layer derives the
// uncapped z-pass view guarantees from the actual camera and the admitted
// volume bounds, then submits exactly the rows the settlement owner drew.
import {
  campaignShadowBindings,
  campaignShadowSupport,
  createCampaignShadows,
} from '/campaign-shadows.js';

const receiverDepthCompare = 4;
const maxInstances = 4096;
const maxStatusBytes = 8192;
const maxReasonBytes = 256;
const maxStatusKeys = 16;
const maxStatusArray = 8;
const maxCoordinate = 1e6;
const finite = (value) =>
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= maxCoordinate;
const vector = (value) => Array.isArray(value) && value.length === 3 && value.every(finite);
const reasonText = (error) => {
  const text = String(error?.message ?? error);
  return text.length > maxReasonBytes ? text.slice(0, maxReasonBytes) : text;
};
function boundedValue(value, depth = 0) {
  if (typeof value === 'string')
    return value.length > maxReasonBytes ? value.slice(0, maxReasonBytes) : value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean' || value === null) return value;
  if (depth >= 2) return undefined;
  if (Array.isArray(value))
    return value
      .slice(0, maxStatusArray)
      .map((entry) => boundedValue(entry, depth + 1))
      .filter((entry) => entry !== undefined);
  if (typeof value !== 'object') return undefined;
  const result = {};
  let keys = 0;
  for (const [key, entry] of Object.entries(value)) {
    if (keys++ >= maxStatusKeys) break;
    const bounded = boundedValue(entry, depth + 1);
    if (bounded !== undefined) result[String(key).slice(0, 64)] = bounded;
  }
  return result;
}

/** Derives the uncapped z-pass guarantees for one presented frame.
 * Returns null when the frame cannot prove a perspective near plane or when
 * its eye does not agree with the supplied view. Missing/unproven views refuse.
 */
export function campaignShadowView(frame) {
  const view = frame?.view,
    projection = frame?.projection,
    eye = frame?.eye,
    width = frame?.width,
    height = frame?.height;
  if (
    !Array.isArray(view) ||
    view.length !== 16 ||
    !view.every(finite) ||
    !Array.isArray(projection) ||
    projection.length !== 16 ||
    !projection.every(finite) ||
    !vector(eye) ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 16384 ||
    height > 16384
  )
    return null;
  // D3D-style perspective: m[2][3]=1, m[3][3]=0, m[3][2]=-near*far/(far-near).
  if (
    Math.abs(projection[11] - 1) > 1e-5 ||
    Math.abs(projection[15]) > 1e-5 ||
    [2, 3, 6, 7].some((index) => Math.abs(projection[index]) > 1e-5) ||
    [3, 7, 11].some((index) => Math.abs(view[index]) > 1e-5) ||
    Math.abs(view[15] - 1) > 1e-5 ||
    !(projection[10] > 0)
  )
    return null;
  const near = -projection[14] / projection[10];
  if (!finite(near) || near <= 0 || near > maxCoordinate) return null;
  // Eye must map to the view-space origin; this rejects a stale or unrelated
  // camera without trying to recover one from an unproven matrix convention.
  const ex = eye[0] * view[0] + eye[1] * view[4] + eye[2] * view[8] + view[12],
    ey = eye[0] * view[1] + eye[1] * view[5] + eye[2] * view[9] + view[13],
    ez = eye[0] * view[2] + eye[1] * view[6] + eye[2] * view[10] + view[14],
    ew = eye[0] * view[3] + eye[1] * view[7] + eye[2] * view[11] + view[15];
  if (
    !finite(ex) ||
    !finite(ey) ||
    !finite(ez) ||
    !finite(ew) ||
    Math.abs(ex) > 1e-4 ||
    Math.abs(ey) > 1e-4 ||
    Math.abs(ez) > 1e-4 ||
    Math.abs(ew - 1) > 1e-4
  )
    return null;
  const forward = [view[2], view[6], view[10]],
    length = Math.hypot(...forward);
  // The near distance below is in world units only for an affine view with
  // unit forward axis. Decline scaled or oblique depth conventions.
  if (!finite(length) || Math.abs(length - 1) > 1e-4) return null;
  return {
    eye: [...eye],
    forward: forward.map((value) => value / length),
    near,
    // Conservative clip guard: a volume must start beyond the rasterized
    // near plane with a small margin rather than exactly touching it.
    margin: near * 0.01 + 0.01,
    width,
    height,
  };
}

/** Conservative AABB test for the uncapped z-pass contract. A volume lies
 * inside its AABB, so an eye inside that box is unproven, and every corner
 * must be in front of the near plane. A rejected box is simply not submitted. */
export function campaignShadowBoundsSafe(bounds, view) {
  if (!bounds || !view) return false;
  const minimum = bounds.minimum,
    maximum = bounds.maximum;
  if (!vector(minimum) || !vector(maximum)) return false;
  for (let k = 0; k < 3; k++) if (minimum[k] > maximum[k]) return false;
  let inside = true;
  for (let k = 0; k < 3; k++)
    if (view.eye[k] < minimum[k] || view.eye[k] > maximum[k]) {
      inside = false;
      break;
    }
  if (inside) return false;
  let minimumDepth = Infinity;
  for (let corner = 0; corner < 8; corner++) {
    let depth = 0;
    for (let k = 0; k < 3; k++)
      depth += view.forward[k] * (((corner >> k) & 1 ? maximum[k] : minimum[k]) - view.eye[k]);
    if (depth < minimumDepth) minimumDepth = depth;
  }
  return Number.isFinite(minimumDepth) && minimumDepth >= view.near + view.margin;
}

/** Builds the optional campaign shadow pass for one settlement-model owner.
 * Unsupported renderers, absent inventories and refused models degrade to a
 * bounded diagnostic; only a state-scope/cleanup failure escapes. */
export function createCampaignShadowScene({
  renderer,
  townOwner,
  volumes,
  assetStatus = null,
  withState = null,
}) {
  let unavailable = null;
  let shadow = null,
    scopeIntegrityFailed = false,
    scopeIntegrityError;
  const instances = [];
  const bounds = new Map();
  let disposed = false,
    frames = 0,
    drawnFrames = 0,
    drawCalls = 0,
    refusals = 0,
    failures = 0,
    lastFrame = null,
    lastError = null,
    skippedRows = 0,
    state = 'active',
    reason = '';
  const deny = (nextState, message) => {
    state = nextState;
    reason = reasonText(message);
    return true;
  };
  const rows = townOwner?.bindings;
  if (!Array.isArray(rows)) unavailable = deny('unavailable', 'No source-bound model owner');
  else if (!(volumes instanceof Map) || !volumes.size)
    unavailable = deny('unavailable', 'No admitted static campaign shadow volumes');
  if (unavailable === null) {
    const wanted = rows.filter(
      (row) =>
        row?.role !== 'banner' &&
        typeof row?.path === 'string' &&
        row.path.length > 0 &&
        volumes.has(row.path)
    );
    skippedRows = rows.length - wanted.length;
    for (const row of wanted) {
      if (instances.length >= maxInstances) {
        skippedRows++;
        continue;
      }
      try {
        instances.push(...campaignShadowBindings({ models: [row] }));
      } catch (error) {
        skippedRows++;
        if (!lastError) lastError = reasonText(error);
      }
    }
    if (!instances.length)
      unavailable = deny(
        'unavailable',
        skippedRows ? `No supported static shadow rows (${skippedRows} skipped)` : 'No shadow rows'
      );
  }
  if (unavailable === null) {
    let support;
    try {
      support = campaignShadowSupport(renderer);
    } catch (error) {
      unavailable = deny('unsupported', reasonText(error));
    }
    if (unavailable === null) {
      if (!support.supported) unavailable = deny('unsupported', support.reason);
      else {
        const scope =
          typeof withState === 'function'
            ? withState
            : typeof renderer?.withDrawState === 'function'
              ? (run) => renderer.withDrawState(run)
              : null;
        if (scope === null)
          unavailable = deny(
            'unsupported',
            'Renderer does not expose a draw-state restoration scope'
          );
        else {
          try {
            shadow = createCampaignShadows({
              renderer,
              volumes,
              instances,
              withState: (run) => {
                let callbackFailed = false,
                  callbackError;
                try {
                  return scope(() => {
                    try {
                      return run();
                    } catch (error) {
                      callbackFailed = true;
                      callbackError = error;
                      throw error;
                    }
                  });
                } catch (error) {
                  // A lone pop/restore failure is an ordinary Error in the
                  // bridge. Only the identical callback error proves that the
                  // scope restored state and the optional draw alone failed.
                  if (!callbackFailed || error !== callbackError) {
                    scopeIntegrityFailed = true;
                    scopeIntegrityError = error;
                  }
                  throw error;
                }
              },
            });
          } catch (error) {
            if (error instanceof AggregateError) throw error;
            unavailable = deny('unavailable', reasonText(error));
          }
        }
      }
    }
  }
  if (unavailable === null) {
    for (const instance of instances) {
      const publication = volumes.get(instance.key)?.[instance.variant];
      if (!publication || !vector(publication.minimum) || !vector(publication.maximum)) continue;
      const minimum = publication.minimum.map((value, k) => value + instance.translation[k]),
        maximum = publication.maximum.map((value, k) => value + instance.translation[k]),
        triangles = Array.isArray(publication.indices) ? publication.indices.length / 3 : 0;
      bounds.set(instance, { minimum, maximum, triangles });
    }
  }
  const api = Object.freeze({
    /** Draws the static pass after the model receiver depth and before HUD.
     * `frame` is the scene's presented camera frame. Returns whether any
     * volume pass ran. A runtime shadow failure disables the optional pass but
     * never invalidates the ordinary campaign frame; the state scope restores
     * GPU state even when the backend throws. */
    draw(frame) {
      if (disposed) throw new Error('Campaign shadows are disposed');
      if (scopeIntegrityFailed) throw scopeIntegrityError;
      frames++;
      if (!shadow || state === 'failed') return false;
      const view = campaignShadowView(frame);
      if (!view) {
        refusals++;
        lastFrame = { refused: 'view-unproven' };
        return false;
      }
      const visible = townOwner?.lastVisibleBindings;
      if (!Array.isArray(visible)) {
        refusals++;
        lastFrame = { refused: 'town-visibility-unavailable' };
        return false;
      }
      const visibleSet = new Set(visible),
        safe = new Set();
      let visibleCount = 0,
        unsafe = 0,
        empty = 0;
      for (const instance of instances) {
        if (!visibleSet.has(instance.source)) continue;
        const box = bounds.get(instance);
        if (!box || box.triangles <= 0) {
          empty++;
          continue;
        }
        visibleCount++;
        if (campaignShadowBoundsSafe(box, view)) safe.add(instance.source);
        else unsafe++;
      }
      lastFrame = { visible: visibleCount, safe: safe.size, unsafe, empty };
      if (!safe.size) {
        if (visibleCount) lastFrame.refused = 'camera-or-near-plane-unproven';
        return false;
      }
      // Every submitted row is in `safe`; the adapter's active filter therefore
      // sees only volumes for which the guarantees below were derived. Hidden
      // and unproven rows are not submitted at all.
      try {
        const calls = shadow.draw({
          width: view.width,
          height: view.height,
          visible: (source) => safe.has(source),
          receiverDepthReady: true,
          cameraOutsideVolumes: true,
          nearPlaneClearOfVolumes: true,
          depthCompare: receiverDepthCompare,
        });
        drawnFrames++;
        drawCalls += calls;
        return calls > 0;
      } catch (error) {
        // A pop/restore failure is a real state-integrity error. Other backend
        // errors leave the scope restored; the optional pass then stays off so
        // the ordinary campaign continues with an explicit diagnostic.
        if (scopeIntegrityFailed || error instanceof AggregateError) throw error;
        failures++;
        lastError = reasonText(error);
        state = 'failed';
        reason = lastError;
        return false;
      }
    },
    status() {
      const wire = {
        schema: 'openrtw-campaign-shadow-scene-v1',
        state,
        reason,
        inventory: {
          volumes: volumes instanceof Map ? volumes.size : 0,
          bindings: instances.length,
          skippedRows,
          status: boundedValue(assetStatus),
        },
        frames,
        drawnFrames,
        drawCalls,
        refusals,
        failures,
        lastFrame,
        lastError: lastError ? lastError.slice(0, maxReasonBytes) : null,
      };
      if (JSON.stringify(wire).length <= maxStatusBytes) return wire;
      return {
        schema: 'openrtw-campaign-shadow-scene-v1',
        state,
        reason,
        inventory: { volumes: wire.inventory.volumes, bindings: instances.length, skippedRows },
        frames,
        drawnFrames,
        drawCalls,
        refusals,
        failures,
        truncated: true,
      };
    },
    statusWire() {
      return JSON.stringify(api.status());
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      const current = shadow;
      shadow = null;
      if (current) current.dispose();
    },
  });
  return api;
}
