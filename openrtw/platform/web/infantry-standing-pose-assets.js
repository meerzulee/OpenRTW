// Optional source-bound frame0 presentation candidate for three infantry models.
// The 54 PLAIN/CAS bind-triple differences remain diagnostic. Native animation
// basis/root/scale/timing/material behavior is unproved; mounted stays unavailable.
import {
  createDevelopmentInfantryStandingAssets,
  createLocalInfantryStandingAssets,
} from './infantry-standing-source-assets.js';
import { infantryStandingSkeletonDescriptors } from './infantry-standing-skeleton.js';
import {
  loadInfantryStandingLid21,
  loadInfantryStanding11,
} from './infantry-standing-animation.js';
import {
  assembleInfantryStandingPose,
  infantryStandingPosePolicy,
} from './infantry-standing-pose.js';

const counts = Object.freeze({
  roman_archer: Object.freeze({ vertices: 125, triangles: 166, parts: 4 }),
  roman_triarii: Object.freeze({ vertices: 171, triangles: 204, parts: 6 }),
  roman_velite: Object.freeze({ vertices: 141, triangles: 167, parts: 5 }),
});
const verifiedModels = new WeakSet(),
  stagedCandidates = new WeakSet();
function modelSpec(modelType) {
  if (typeof modelType !== 'string' || !Object.hasOwn(counts, modelType))
    throw new Error('Unknown selected infantry model');
  return infantryStandingSkeletonDescriptors[modelType];
}
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function signalCheck(signal) {
  if (
    signal !== undefined &&
    signal !== null &&
    (typeof signal.aborted !== 'boolean' ||
      typeof signal.addEventListener !== 'function' ||
      typeof signal.removeEventListener !== 'function')
  )
    throw new TypeError('Infantry pose signal must be an AbortSignal');
  if (signal?.aborted) {
    const reason = signal.reason;
    throw reason === undefined ? new DOMException('Infantry pose cancelled', 'AbortError') : reason;
  }
}
const digest = async (bytes) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('');

// Root-only model publication hook. Call immediately after the EXISTING closed
// CAS publication and validateModel source/raw guards, before the next await or
// mesh publication. Its inputs are bounded ordinary parsed CAPI JSON, not a
// public arbitrary-object deserializer. This snapshots all raw fields, including
// Velite's marker/opaque/suffix; no raw fields or source bits are rewritten.
// Hash success admits only this staged owned record. The pose consumer still
// authenticates its independent fixed raw-field fingerprint; a SHA label alone
// is not accepted as model identity.
export async function captureInfantryStandingModel(
  modelType,
  publication,
  { signal, isOpen = () => true } = {}
) {
  const spec = modelSpec(modelType);
  signalCheck(signal);
  if (typeof isOpen !== 'function' || !isOpen())
    throw new DOMException('Model snapshot owner closed', 'AbortError');
  if (
    !publication ||
    !(publication.source instanceof Uint8Array) ||
    publication.source.length !== spec.modelSourceBytes ||
    publication.value?.sourceBytes !== spec.modelSourceBytes ||
    publication.value?.versionBits !== spec.modelVersionBits
  )
    throw new Error('Selected model publication differs');
  // Both copies are synchronous, before the digest await. structuredClone keeps
  // binary64/sign-zero values; source uint32 words are never rounded/replaced.
  const source = publication.source.slice(),
    model = structuredClone(publication.value);
  const actual = await digest(source);
  signalCheck(signal);
  if (!isOpen()) throw new DOMException('Model snapshot owner closed', 'AbortError');
  if (actual !== spec.modelSourceSha256) throw new Error('Selected model publication SHA differs');
  const poseModel = freeze({ model, sourceSha256: actual });
  const snapshot = { modelType, poseModel, sourceSha256: actual, sourceBytesCount: source.length };
  Object.defineProperty(snapshot, 'sourceBytes', { enumerable: true, get: () => source.slice() });
  Object.freeze(snapshot);
  verifiedModels.add(snapshot);
  return snapshot;
}

function capability(core, modelType) {
  const loader =
    modelType === 'roman_archer'
      ? '_openrtw_load_cas_animation'
      : '_openrtw_load_cas_animation_standing11';
  for (const name of [
    loader,
    '_malloc',
    '_free',
    '_openrtw_cas_animation_json',
    '_openrtw_cas_animation_source_bytes',
    '_openrtw_cas_animation_source_size',
    '_openrtw_select_cas_animation_frame',
    '_openrtw_cas_animation_frame_json',
    '_openrtw_error',
  ])
    if (typeof core?.[name] !== 'function')
      throw new Error('Required explicit infantry animation export is unavailable');
}

// The core and model snapshots are borrowed from Root and are NEVER reset,
// disposed or closed here. Root must serialize this operation with every other
// user of the same animation publication. Only one stage runs per adapter.
function adapter(core, sourceAssets, ownsSourceAssets, isOpen) {
  if (!sourceAssets || typeof sourceAssets.load !== 'function' || typeof isOpen !== 'function')
    throw new TypeError('Invalid infantry pose owner');
  let closed = false,
    busy = false,
    closeReason;
  const active = new Set();
  const check = (signal) => {
    signalCheck(signal);
    if (closed) throw closeReason;
    if (!isOpen()) throw new DOMException('Infantry pose owner changed', 'AbortError');
  };
  return Object.freeze({
    // Inputs are at most three OWNED source-verified capture records. A result
    // escapes only when the entire requested set passes; Root publishes it once.
    async stage(modelSnapshots, { signal } = {}) {
      check(signal);
      if (busy) throw new Error('Infantry pose core operation already pending');
      if (!modelSnapshots || typeof modelSnapshots !== 'object' || Array.isArray(modelSnapshots))
        throw new TypeError('Invalid selected model snapshots');
      const keys = Object.keys(modelSnapshots);
      if (keys.length < 1 || keys.length > 3)
        throw new Error('Expected one to three selected models');
      const inputs = [];
      for (const modelType of keys) {
        modelSpec(modelType);
        capability(core, modelType);
        const snapshot = modelSnapshots[modelType];
        if (!verifiedModels.has(snapshot) || snapshot.modelType !== modelType)
          throw new Error('Model requires an owned verified publication snapshot');
        inputs.push([modelType, snapshot.poseModel]);
      }
      // No asset read, native allocation or clip fallback occurs before preflight.
      const controller = new AbortController(),
        relay = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', relay, { once: true });
      if (signal?.aborted) relay();
      active.add(controller);
      busy = true;
      const current = () => {
        signalCheck(controller.signal);
        return !closed && isOpen();
      };
      let failed = false,
        failure,
        completed;
      try {
        check(controller.signal);
        const staged = Object.create(null);
        for (const [modelType, model] of inputs) {
          check(controller.signal);
          const loaded = await sourceAssets.load(modelType, { signal: controller.signal });
          check(controller.signal);
          const loadClip =
            modelType === 'roman_archer' ? loadInfantryStandingLid21 : loadInfantryStanding11;
          const clip = await loadClip(core, loaded.clipBytes, { isOpen: current });
          check(controller.signal);
          // clip.frame(0) is owned JS data. No C pointer/native selected-frame state
          // is retained while the next model replaces LID/LIS on the shared core.
          const frame = clip.frame(0),
            skeleton = loaded.skeletonBinding;
          const candidate = await assembleInfantryStandingPose({
            modelType,
            frame,
            model,
            skeleton,
            policy: infantryStandingPosePolicy,
            signal: controller.signal,
          });
          check(controller.signal);
          stagedCandidates.add(candidate);
          staged[modelType] = candidate;
        }
        check(controller.signal);
        completed = Object.freeze(staged);
      } catch (error) {
        failed = true;
        failure = error;
      } finally {
        try {
          signal?.removeEventListener('abort', relay);
        } catch (error) {
          if (!failed) {
            failed = true;
            failure = error;
          }
        } finally {
          active.delete(controller);
          busy = false;
        }
      }
      if (failed) throw failure;
      return completed;
    },
    close(reason) {
      if (closed) return;
      closed = true;
      closeReason =
        reason === undefined
          ? new DOMException('Infantry pose adapter closed', 'AbortError')
          : reason;
      for (const controller of active) controller.abort(closeReason);
      if (ownsSourceAssets) sourceAssets.close(closeReason);
      // Borrowed Root source providers/core/renderer/textures remain Root-owned.
    },
  });
}
export function createDevelopmentInfantryStandingPoseAssets(
  core,
  { fetchImpl = fetch, isOpen = () => true } = {}
) {
  return adapter(core, createDevelopmentInfantryStandingAssets({ fetchImpl }), true, isOpen);
}
export function createLocalInfantryStandingPoseAssets(core, files, { isOpen = () => true } = {}) {
  return adapter(core, createLocalInfantryStandingAssets(files), true, isOpen);
}
export function createBorrowedInfantryStandingPoseAssets(
  core,
  sourceAssets,
  { isOpen = () => true } = {}
) {
  return adapter(core, sourceAssets, false, isOpen);
}

function candidateGeometry(modelType, candidate) {
  modelSpec(modelType);
  const expected = counts[modelType],
    geometry = candidate?.geometry;
  if (
    !stagedCandidates.has(candidate) ||
    !(geometry?.vertices instanceof Uint8Array) ||
    geometry.vertices.length !== expected.vertices * 24 ||
    !(geometry.indexBytes instanceof Uint8Array) ||
    geometry.indexBytes.length !== expected.triangles * 6 ||
    !Array.isArray(geometry.parts) ||
    geometry.parts.length !== expected.parts
  )
    throw new Error('Expected an admitted aggregate pose from this adapter');
  return geometry;
}

// Primary current Root contract: ONE aggregate unit drawpart per available foot
// model/faction entry. Replace its geometry only. Texture/source/faction/group
// bindings and owner lifetimes stay the original Root objects. No GPU work.
// Domain: the existing bounded closed Root asset map, not arbitrary objects.
export function mergeInfantryStandingBattleAssets(currentAssets, posedByModel) {
  const keys = Object.keys(currentAssets);
  if (keys.length > 64) throw new Error('Battle asset map exceeds its closed bound');
  const staged = Object.create(null);
  for (const key of keys) {
    const entry = currentAssets[key];
    if (entry?.status !== 'available' || !Object.hasOwn(posedByModel, entry.modelType)) {
      staged[key] = entry;
      continue;
    }
    const spec = modelSpec(entry.modelType),
      candidate = posedByModel[entry.modelType];
    if (
      !['romans_julii', 'romans_brutii'].includes(entry.sourceFaction) ||
      key !== entry.sourceFaction + ':' + entry.modelType ||
      !Array.isArray(entry.parts) ||
      entry.parts.length !== 1 ||
      entry.parts[0]?.role !== 'unit' ||
      entry.parts[0].sourceSha256 !== spec.modelSourceSha256
    )
      throw new Error('Existing exact aggregate unit draw binding differs');
    const geometry = candidateGeometry(entry.modelType, candidate),
      part = entry.parts[0];
    const standingPose = Object.freeze({
      schema: 'openrtw-infantry-standing-pose-binding-v1',
      modelType: entry.modelType,
      frameIndex: candidate.pose.frameIndex,
      nativeAnimation: false,
      sourceSha256: Object.freeze({ ...candidate.pose.sourceSha256 }),
      presentationPolicyId: candidate.presentationPolicy.id,
    });
    staged[key] = Object.freeze({
      ...entry,
      parts: Object.freeze([Object.freeze({ ...part, geometry })]),
      standingPose,
    });
  }
  return Object.freeze(staged);
}
