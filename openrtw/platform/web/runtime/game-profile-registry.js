export const profileProbeStatuses = Object.freeze({
  supported: 'supported',
  ambiguous: 'ambiguous',
  unsupported: 'unsupported',
});

const idPattern = /^[a-z0-9][a-z0-9.-]*$/;
const statusValues = new Set(Object.values(profileProbeStatuses));

function abortError() {
  return typeof DOMException === 'function'
    ? new DOMException('Game profile probe aborted', 'AbortError')
    : Object.assign(new Error('Game profile probe aborted'), { name: 'AbortError' });
}

function checkSignal(signal) {
  if (
    signal !== undefined &&
    signal !== null &&
    (typeof signal.aborted !== 'boolean' ||
      typeof signal.addEventListener !== 'function' ||
      typeof signal.removeEventListener !== 'function')
  )
    throw new TypeError('Profile probe signal must be an AbortSignal');
  if (signal?.aborted) throw signal.reason ?? abortError();
}

async function cancellable(value, signal) {
  // A probe may abort synchronously while creating its returned promise.
  // Observe that already-started work before cancellation can reject this wait.
  const pending = Promise.resolve(value);
  pending.catch(() => {});
  checkSignal(signal);
  if (!signal) return pending;
  let onAbort;
  const aborted = new Promise((resolve, reject) => {
    onAbort = () => reject(signal.reason ?? abortError());
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const result = await Promise.race([pending, aborted]);
    checkSignal(signal);
    return result;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function immutableJson(value, label) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    const copy = [];
    const length = value.length;
    for (let index = 0; index < length; index++) {
      if (!Object.hasOwn(value, index)) throw new TypeError(`${label} must be a dense JSON array`);
      copy.push(immutableJson(value[index], `${label}[${index}]`));
    }
    return Object.freeze(copy);
  }
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const copy = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor')
        throw new TypeError(`${label} contains a reserved key`);
      copy[key] = immutableJson(item, `${label}.${key}`);
    }
    return Object.freeze(copy);
  }
  throw new TypeError(`${label} must contain only JSON values`);
}

function requiredString(value, label, maxLength = 128) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength)
    throw new TypeError(`${label} must be a non-empty string of at most ${maxLength} characters`);
  return value;
}

export function validateGameProfile(profile) {
  if (profile === null || typeof profile !== 'object' || Array.isArray(profile))
    throw new TypeError('Game profile must be an object');
  const gameId = requiredString(profile.gameId, 'gameId');
  const profileId = requiredString(profile.profileId, 'profileId');
  if (!idPattern.test(gameId)) throw new TypeError('gameId must be a lowercase namespaced ID');
  if (!profileId.startsWith(`${gameId}/`) || !idPattern.test(profileId.slice(gameId.length + 1)))
    throw new TypeError('profileId must be namespaced as gameId/profile-name');
  const hostApiVersion = requiredString(profile.hostApiVersion, 'hostApiVersion');
  const rulesVersion = requiredString(profile.rulesVersion, 'rulesVersion');
  if (
    profile.capabilities === null ||
    typeof profile.capabilities !== 'object' ||
    Array.isArray(profile.capabilities) ||
    Object.getPrototypeOf(profile.capabilities) !== Object.prototype
  )
    throw new TypeError('capabilities must be a plain object');
  const capabilityEntries = Object.entries(profile.capabilities);
  if (capabilityEntries.length === 0) throw new TypeError('capabilities must not be empty');
  const capabilities = {};
  for (const [name, version] of capabilityEntries) {
    requiredString(name, 'capability name');
    if (name === '__proto__' || name === 'prototype' || name === 'constructor')
      throw new TypeError('capabilities contains a reserved key');
    capabilities[name] = requiredString(version, `capability ${name}`);
  }
  if (typeof profile.probe !== 'function') throw new TypeError('profile.probe must be a function');
  return Object.freeze({
    gameId,
    profileId,
    hostApiVersion,
    rulesVersion,
    capabilities: Object.freeze(capabilities),
    probe: profile.probe,
  });
}

function probeResult(profile, result) {
  if (result === null || typeof result !== 'object' || Array.isArray(result))
    throw new TypeError(`Probe for ${profile.profileId} must return an object`);
  const status = result.status;
  if (!statusValues.has(status))
    throw new TypeError(`Probe for ${profile.profileId} returned an invalid status`);
  const missingRequiredFiles = stringList(result.missingRequiredFiles, profile, 'missing paths', false);
  const diagnostics = stringList(result.diagnostics, profile, 'diagnostics', true);
  return Object.freeze({
    gameId: profile.gameId,
    profileId: profile.profileId,
    status,
    details: immutableJson(result.details ?? {}, `Probe details for ${profile.profileId}`),
    missingRequiredFiles,
    diagnostics,
  });
}

function stringList(value, profile, label, allowEmpty) {
  if (value === undefined) return Object.freeze([]);
  const invalid = () => new TypeError(`Probe for ${profile.profileId} returned invalid ${label}`);
  if (!Array.isArray(value)) throw invalid();
  const copy = [];
  const length = value.length;
  for (let index = 0; index < length; index++) {
    if (!Object.hasOwn(value, index)) throw invalid();
    const item = value[index];
    if (typeof item !== 'string' || (!allowEmpty && item.length === 0)) throw invalid();
    copy.push(item);
  }
  return Object.freeze(copy);
}

function selection(status, profile, results, diagnostics) {
  return Object.freeze({
    status,
    gameId: profile?.gameId ?? null,
    profileId: profile?.profileId ?? null,
    profile: profile ?? null,
    results: Object.freeze(results),
    missingRequiredFiles: Object.freeze([
      ...new Set(results.flatMap((result) => result.missingRequiredFiles)),
    ]),
    diagnostics: Object.freeze(diagnostics),
  });
}

export function createGameProfileRegistry(profiles = []) {
  if (!Array.isArray(profiles)) throw new TypeError('Registry profiles must be an array');
  const registered = new Map();
  const registry = Object.freeze({
    register(profile) {
      const descriptor = validateGameProfile(profile);
      if (registered.has(descriptor.profileId))
        throw new Error(`Duplicate game profile: ${descriptor.profileId}`);
      registered.set(descriptor.profileId, descriptor);
      return descriptor;
    },
    listProfiles() {
      return Object.freeze([...registered.values()]);
    },
    async probe(provider, { signal } = {}) {
      checkSignal(signal);
      // Registration during an asynchronous probe applies to its next run.
      const profiles = [...registered.values()];
      const results = [];
      for (const profile of profiles) {
        checkSignal(signal);
        const result = await cancellable(profile.probe(provider, { signal }), signal);
        results.push(probeResult(profile, result));
      }
      checkSignal(signal);
      const supported = results.filter((result) => result.status === 'supported');
      const ambiguous = results.filter((result) => result.status === 'ambiguous');
      if (supported.length === 1 && ambiguous.length === 0) {
        const match = supported[0];
        return selection('supported', registered.get(match.profileId), results, []);
      }
      if (supported.length + ambiguous.length > 0)
        return selection('ambiguous', null, results, [
          'Selection requires exactly one exact profile and no unresolved profile candidates.',
        ]);
      return selection('unsupported', null, results, [
        profiles.length === 0
          ? 'No game profiles are registered.'
          : 'No registered profile supports the selected local content.',
      ]);
    },
  });
  for (const profile of profiles) registry.register(profile);
  return registry;
}
