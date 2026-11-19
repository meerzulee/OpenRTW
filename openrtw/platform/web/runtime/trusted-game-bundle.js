// Trusted, statically registered game bundles. Manifest artifact names describe
// the build; they are never used as loader URLs. Player content has no path to
// register code or alter these owned descriptors.

export const openrtwWebHostApiVersion = 'openrtw.web.host/v1';
export const trustedGameBundleSchema = 'openrtw.trusted-game-bundle/v1';
export const trustedGameSessionInterface = 'openrtw.session/v1';

const manifestFields = Object.freeze([
  'schema', 'bundleId', 'gameId', 'profileIds', 'hostApiVersion', 'rulesVersion',
  'loaderId', 'interfaces', 'build',
]);
const identityFields = Object.freeze(['gameId', 'profileId', 'hostApiVersion', 'rulesVersion']);
const interfaceFields = Object.freeze(['session', 'commandSchema', 'snapshotSchema', 'coreContract']);
const buildFields = Object.freeze(['target', 'module', 'wasm']);
const idPattern = /^[a-z0-9][a-z0-9./-]{0,127}$/;
const gameIdPattern = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const versionPattern = /^[\x21-\x7e]{1,128}$/;

export class TrustedGameBundleError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'TrustedGameBundleError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function refuse(code, message, field) {
  throw new TrustedGameBundleError(code, message, field === undefined ? undefined : { field });
}

function object(value, code, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype)
    refuse(code, label + ' must be a plain object');
  return value;
}

function exactFields(value, fields, code, label) {
  const actual = Object.keys(value);
  if (actual.length !== fields.length || fields.some((field) => !Object.hasOwn(value, field)))
    refuse(code, label + ' must contain exactly: ' + fields.join(', '));
}

function text(value, code, field, pattern = versionPattern) {
  if (typeof value !== 'string' || !pattern.test(value))
    refuse(code, 'Invalid trusted bundle field: ' + field, field);
  return value;
}

function artifactPath(value, field, extension) {
  const path = text(value, 'invalid-manifest', field, /^[a-z0-9][a-z0-9._/-]{0,255}$/);
  if (path.startsWith('/') || path.endsWith('/') || path.includes('//') ||
      path.split('/').some((part) => part === '.' || part === '..') || !path.endsWith(extension))
    refuse('invalid-manifest', 'Invalid trusted bundle artifact: ' + field, field);
  return path;
}

export function validateTrustedGameBundle(manifest) {
  object(manifest, 'invalid-manifest', 'Trusted game bundle');
  exactFields(manifest, manifestFields, 'invalid-manifest', 'Trusted game bundle');
  if (manifest.schema !== trustedGameBundleSchema)
    refuse('unsupported-manifest-schema', 'Unsupported trusted game bundle schema', 'schema');
  const gameId = text(manifest.gameId, 'invalid-manifest', 'gameId', gameIdPattern);
  const declaredProfiles = manifest.profileIds;
  const profileCount = Array.isArray(declaredProfiles) ? declaredProfiles.length : 0;
  if (!Number.isInteger(profileCount) || profileCount < 1 || profileCount > 16)
    refuse('invalid-manifest', 'Trusted bundle profileIds must contain 1 to 16 entries', 'profileIds');
  const profileIds = [];
  for (let index = 0; index < profileCount; index++) {
    if (!Object.hasOwn(declaredProfiles, index))
      refuse('invalid-manifest', 'Trusted bundle profileIds must be dense', 'profileIds');
    const profileId = declaredProfiles[index];
    text(profileId, 'invalid-manifest', 'profileIds', idPattern);
    if (!profileId.startsWith(gameId + '/'))
      refuse('invalid-manifest', 'Trusted bundle profiles must be namespaced by gameId', 'profileIds');
    profileIds.push(profileId);
  }
  if (new Set(profileIds).size !== profileIds.length)
    refuse('invalid-manifest', 'Trusted bundle profileIds must be unique', 'profileIds');
  const declaredInterfaces = manifest.interfaces;
  object(declaredInterfaces, 'invalid-manifest', 'Trusted bundle interfaces');
  exactFields(declaredInterfaces, interfaceFields, 'invalid-manifest', 'Trusted bundle interfaces');
  const interfaces = {};
  for (const field of interfaceFields)
    interfaces[field] = text(declaredInterfaces[field], 'invalid-manifest', 'interfaces.' + field);
  const declaredBuild = manifest.build;
  object(declaredBuild, 'invalid-manifest', 'Trusted bundle build');
  exactFields(declaredBuild, buildFields, 'invalid-manifest', 'Trusted bundle build');
  if (declaredBuild.target !== 'wasm')
    refuse('unsupported-build-target', 'Trusted game bundles require a WASM build target', 'build.target');
  return Object.freeze({
    schema: trustedGameBundleSchema,
    bundleId: text(manifest.bundleId, 'invalid-manifest', 'bundleId', idPattern),
    gameId,
    profileIds: Object.freeze(profileIds),
    hostApiVersion: text(manifest.hostApiVersion, 'invalid-manifest', 'hostApiVersion'),
    rulesVersion: text(manifest.rulesVersion, 'invalid-manifest', 'rulesVersion'),
    loaderId: text(manifest.loaderId, 'invalid-manifest', 'loaderId', idPattern),
    interfaces: Object.freeze(interfaces),
    build: Object.freeze({
      target: 'wasm',
      module: artifactPath(declaredBuild.module, 'build.module', '.mjs'),
      wasm: artifactPath(declaredBuild.wasm, 'build.wasm', '.wasm'),
    }),
  });
}

function validateIdentity(identity) {
  object(identity, 'invalid-launch', 'Bundle launch identity');
  exactFields(identity, identityFields, 'invalid-launch', 'Bundle launch identity');
  const result = {};
  for (const field of identityFields)
    result[field] = text(identity[field], 'invalid-launch', 'identity.' + field);
  if (!gameIdPattern.test(result.gameId) || !idPattern.test(result.profileId) ||
      !result.profileId.startsWith(result.gameId + '/'))
    refuse('invalid-launch', 'Bundle launch profile must be namespaced by gameId', 'identity.profileId');
  return Object.freeze(result);
}

export function createTrustedGameBundleRegistry({ hostApiVersion = openrtwWebHostApiVersion } = {}) {
  text(hostApiVersion, 'invalid-runtime-config', 'hostApiVersion');
  const entries = new Map();

  function register(manifest, loader) {
    const owned = validateTrustedGameBundle(manifest);
    if (typeof loader !== 'function')
      refuse('invalid-loader', 'Trusted bundle registration requires a loader function', 'loader');
    if (owned.hostApiVersion !== hostApiVersion)
      refuse('unsupported-host', 'Trusted bundle host API is not supported by this runtime', 'hostApiVersion');
    if (owned.interfaces.session !== trustedGameSessionInterface)
      refuse('unsupported-interface', 'Trusted bundle session interface is not supported', 'interfaces.session');
    if (entries.has(owned.bundleId))
      refuse('duplicate-bundle', 'Trusted bundle ID is already registered: ' + owned.bundleId, 'bundleId');
    entries.set(owned.bundleId, Object.freeze({ manifest: owned, loader }));
    return owned;
  }

  function resolve(selection) {
    object(selection, 'invalid-launch', 'Bundle selection');
    exactFields(selection, ['bundleId', 'identity'], 'invalid-launch', 'Bundle selection');
    const bundleId = text(selection.bundleId, 'invalid-launch', 'bundleId', idPattern);
    const identity = validateIdentity(selection.identity);
    const entry = entries.get(bundleId);
    if (!entry) refuse('unknown-bundle', 'Unknown trusted game bundle: ' + bundleId, 'bundleId');
    const manifest = entry.manifest;
    if (identity.gameId !== manifest.gameId)
      refuse('incompatible-title', 'Selected bundle does not implement the requested game', 'identity.gameId');
    if (!manifest.profileIds.includes(identity.profileId))
      refuse('incompatible-profile', 'Selected bundle does not support the requested profile', 'identity.profileId');
    if (identity.hostApiVersion !== hostApiVersion || identity.hostApiVersion !== manifest.hostApiVersion)
      refuse('incompatible-host', 'Selected bundle and identity require a different host API', 'identity.hostApiVersion');
    if (identity.rulesVersion !== manifest.rulesVersion)
      refuse('incompatible-rules', 'Selected bundle and identity require different rules', 'identity.rulesVersion');
    return Object.freeze({ bundleId, identity, manifest });
  }

  async function createSession(selection, context) {
    const resolved = resolve(selection);
    if (typeof context?.token?.throwIfCancelled !== 'function')
      refuse('invalid-context', 'Trusted bundle loading requires a session cancellation token');
    context.token.throwIfCancelled();
    const entry = entries.get(resolved.bundleId);
    // A late result is returned, not discarded: SessionRuntime retains and
    // disposes it after cancellation or replacement.
    const owner = await entry.loader(resolved.identity, context, resolved.manifest);
    const cleanupErrors = [];
    if (owner !== null && (typeof owner === 'object' || typeof owner === 'function')) {
      for (const name of ['dispose', 'close', 'destroy']) {
        try {
          if (typeof owner[name] === 'function') return owner;
        } catch (error) { cleanupErrors.push(error); }
      }
    }
    throw new TrustedGameBundleError('invalid-session-owner',
      'Trusted bundle loader must return an owner with dispose(), close() or destroy()', { cleanupErrors });
  }

  return Object.freeze({
    register,
    resolve,
    createSession,
    listBundles: () => Object.freeze([...entries.values()].map((entry) => entry.manifest)),
  });
}

export function createTrustedGameBundleSessionFactory({ registry, bundleId } = {}) {
  if (typeof registry?.createSession !== 'function')
    refuse('invalid-runtime-config', 'A trusted game bundle registry is required');
  text(bundleId, 'invalid-runtime-config', 'bundleId', idPattern);
  return (identity, context) => registry.createSession({ bundleId, identity }, context);
}
