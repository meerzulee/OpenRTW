// Shared save metadata only. The owning game defines the opaque payload codec.
export const profileSaveEnvelopeSchema = 'openrtw-profile-save-v1';
const fields = Object.freeze([
  'gameId', 'profileId', 'hostApiVersion', 'rulesVersion', 'payloadSchema', 'contentFingerprint',
]);
const digestPattern = /^[a-f0-9]{64}$/;
const gameIdPattern = /^[a-z0-9][a-z0-9.-]*$/;
export const saveFingerprintLimits = Object.freeze({
  sources: 128,
  sourceBytes: 128 * 1024 * 1024,
  totalBytes: 256 * 1024 * 1024,
});

export function createSaveIdentity(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype)
    throw new TypeError('Save identity must be a plain object');
  const result = {};
  for (const field of fields) {
    const item = value[field];
    if (!Object.hasOwn(value, field) || typeof item !== 'string' ||
        !item.length || item.length > 128 || /[\x00-\x1f\x7f]/.test(item))
      throw new TypeError('Save identity has an invalid ' + field);
    result[field] = item;
  }
  if (!gameIdPattern.test(result.gameId) ||
      !result.profileId.startsWith(result.gameId + '/') ||
      !gameIdPattern.test(result.profileId.slice(result.gameId.length + 1)))
    throw new TypeError('Save profile must be namespaced under its game');
  if (!digestPattern.test(result.contentFingerprint))
    throw new TypeError('Save content fingerprint must be a SHA-256 hex digest');
  return Object.freeze(result);
}

export function profileSaveKey(identity) {
  const value = createSaveIdentity(identity);
  return JSON.stringify([profileSaveEnvelopeSchema, ...fields.map((field) => value[field])]);
}

export function assertSaveIdentity(actual, expected) {
  const left = createSaveIdentity(actual), right = createSaveIdentity(expected);
  if (fields.some((field) => left[field] !== right[field]))
    throw new Error('Stored save has incompatible game, profile, rules, schema or content identity');
  return left;
}

async function defaultDigest(bytes) {
  if (typeof globalThis.crypto?.subtle?.digest !== 'function')
    throw new Error('Save content fingerprint requires Web Crypto or an injected digest');
  const value = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function checkAbort(signal) {
  if (signal !== undefined && (signal === null || typeof signal.aborted !== 'boolean'))
    throw new TypeError('Save fingerprint signal must be an AbortSignal');
  if (signal?.aborted) throw signal.reason ?? new Error('Save fingerprint aborted');
}

export async function fingerprintSaveInputs(inputs, { digestSha256 = defaultDigest, signal } = {}) {
  checkAbort(signal);
  if (typeof digestSha256 !== 'function')
    throw new TypeError('Save fingerprint digest must be a function');
  if (!Array.isArray(inputs) || !inputs.length || inputs.length > saveFingerprintLimits.sources)
    throw new TypeError('Save fingerprint requires 1 to 128 named source buffers');
  const names = new Set();
  const validated = [];
  let total = 0;
  // Validate aggregate bounds before copying, then own every buffer before any
  // await. Buffer.slice() is deliberately avoided: Node Buffer would alias.
  for (const input of inputs) {
    const id = input?.id, bytes = input?.bytes;
    if (typeof id !== 'string' ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id) || names.has(id))
      throw new TypeError('Save fingerprint source IDs must be unique bounded tokens');
    names.add(id);
    if (!(bytes instanceof Uint8Array) && !(bytes instanceof ArrayBuffer))
      throw new TypeError('Save fingerprint source must be Uint8Array or ArrayBuffer');
    const buffer = bytes instanceof Uint8Array ? bytes.buffer : bytes;
    if (typeof SharedArrayBuffer === 'function' && buffer instanceof SharedArrayBuffer)
      throw new TypeError('Save fingerprint requires unshared source buffers');
    const length = bytes.byteLength;
    if (length > saveFingerprintLimits.sourceBytes)
      throw new Error('Save fingerprint source exceeds its byte bound');
    total += length;
    if (total > saveFingerprintLimits.totalBytes)
      throw new Error('Save fingerprint sources exceed the aggregate byte bound');
    validated.push({ id, bytes });
  }
  const owned = validated.map(({ id, bytes }) => ({
    id, bytes: new Uint8Array(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)),
  }));
  owned.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const manifest = [];
  for (const input of owned) {
    checkAbort(signal);
    const hash = await digestSha256(input.bytes);
    checkAbort(signal);
    if (typeof hash !== 'string' || !digestPattern.test(hash))
      throw new TypeError('Save fingerprint digest must return lowercase SHA-256 hex');
    manifest.push([input.id, input.bytes.length, hash]);
  }
  const encoded = new TextEncoder().encode(JSON.stringify(['openrtw-save-inputs-v1', manifest]));
  const fingerprint = await digestSha256(encoded);
  checkAbort(signal);
  if (typeof fingerprint !== 'string' || !digestPattern.test(fingerprint))
    throw new TypeError('Save fingerprint digest must return lowercase SHA-256 hex');
  return fingerprint;
}
