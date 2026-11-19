import { openrtwWebHostApiVersion } from '../../runtime/trusted-game-bundle.js';

export const romeOriginalExecutableSha256 =
  'c6641dc091c7a7073b27d83076970b826ee2b45937a38684e9802327b75bbc7b';

// Title-owned compatibility labels. The compiled core must agree with the
// rules version; the app checks its publication profile before using state.
export const romeOriginalRulesVersion = 'rome-original-1.5-partial-v2';
export const romeOriginalCampaignRuleProfile = 'openrtw-cardinal-prototype-v2';
export const romeOriginalSavePayloadSchema = 'openrtw.campaign-journey-save/v2';

const executablePath = 'RomeTW.exe';
const executableMaxBytes = 64 * 1024 * 1024;
const requiredAssets = Object.freeze([
  Object.freeze({
    path: 'data/world/maps/campaign/imperial_campaign/descr_strat.txt',
    maxBytes: 8 * 1024 * 1024,
  }),
  Object.freeze({
    path: 'data/world/maps/base/descr_regions.txt',
    maxBytes: 8 * 1024 * 1024,
  }),
  Object.freeze({ path: 'data/export_descr_unit.txt', maxBytes: 2 * 1024 * 1024 }),
]);

function abortError() {
  return typeof DOMException === 'function'
    ? new DOMException('Rome profile probe aborted', 'AbortError')
    : Object.assign(new Error('Rome profile probe aborted'), { name: 'AbortError' });
}

function checkSignal(signal) {
  if (signal?.aborted) throw signal.reason ?? abortError();
}

async function cancellable(value, signal) {
  // Providers/digests can cancel inside their call before returning a rejected
  // promise. Keep its failure observed even when this wait is already cancelled.
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

function bytesFrom(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new TypeError('Local profile provider must return Uint8Array, ArrayBuffer, or null');
}

async function readLocal(provider, path, maxBytes, signal) {
  if (provider === null || typeof provider?.readFile !== 'function')
    throw new TypeError('Rome profile probe requires an injected local readFile provider');
  const value = await cancellable(provider.readFile(path, { maxBytes, signal }), signal);
  if (value === null) return Object.freeze({ state: 'missing' });
  const bytes = bytesFrom(value);
  if (bytes.byteLength === 0) return Object.freeze({ state: 'empty' });
  if (bytes.byteLength > maxBytes)
    return Object.freeze({ state: 'oversized', byteLength: bytes.byteLength });
  return Object.freeze({ state: 'found', bytes });
}

async function defaultSha256(bytes) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('SHA-256 requires Web Crypto or an injected digestSha256 function');
  const digest = await subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function freezeDetails(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeDetails));
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) freezeDetails(item);
    return Object.freeze(value);
  }
  return value;
}

function outcome(status, details, missingRequiredFiles = [], diagnostics = []) {
  return Object.freeze({
    status,
    details: freezeDetails(details),
    missingRequiredFiles: Object.freeze(missingRequiredFiles),
    diagnostics: Object.freeze(diagnostics),
  });
}

export function createRomeOriginalProfile({ digestSha256 = defaultSha256 } = {}) {
  if (typeof digestSha256 !== 'function') throw new TypeError('digestSha256 must be a function');
  return Object.freeze({
    gameId: 'rome-original',
    profileId: 'rome-original/gog-1.5',
    hostApiVersion: openrtwWebHostApiVersion,
    rulesVersion: romeOriginalRulesVersion,
    capabilities: Object.freeze({
      'assets.local': 'probe-v1',
      'campaign.imperial': 'partial-v1',
      'battle.realtime': 'partial-v1',
    }),
    async probe(provider, { signal } = {}) {
      checkSignal(signal);
      const executable = await readLocal(provider, executablePath, executableMaxBytes, signal);
      const assets = [];
      for (const spec of requiredAssets)
        assets.push({ spec, result: await readLocal(provider, spec.path, spec.maxBytes, signal) });

      const missingRequiredFiles = [
        ...(executable.state === 'missing' ? [executablePath] : []),
        ...assets.filter(({ result }) => result.state === 'missing').map(({ spec }) => spec.path),
      ];
      const oversized = [
        ...(executable.state === 'oversized'
          ? [{ path: executablePath, maxBytes: executableMaxBytes }]
          : []),
        ...assets
          .filter(({ result }) => result.state === 'oversized')
          .map(({ spec }) => ({ path: spec.path, maxBytes: spec.maxBytes })),
      ];
      const diagnostics = oversized.map(
        ({ path, maxBytes }) => `${path} exceeds the ${maxBytes}-byte local probe bound`
      );
      for (const { spec, result } of assets)
        if (result.state === 'empty') diagnostics.push(`${spec.path} is empty`);
      if (executable.state === 'empty') diagnostics.push('RomeTW.exe is empty');
      const assetsPresent = assets.every(({ result }) => result.state === 'found');
      let executableSha256 = null;
      if (executable.state === 'found') {
        executableSha256 = await cancellable(digestSha256(executable.bytes), signal);
        if (typeof executableSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(executableSha256))
          throw new TypeError('digestSha256 must return a lowercase SHA-256 hexadecimal digest');
      }

      const edition = {
        title: 'Rome: Total War',
        distribution: 'GOG',
        patch: '1.5',
        executablePath,
        executableSha256,
        assetVerification: 'required-path-presence-only',
      };
      if (
        executableSha256 === romeOriginalExecutableSha256 &&
        assetsPresent &&
        oversized.length === 0
      )
        return outcome('supported', { match: 'exact-verified-profile', edition });

      if (executable.state === 'missing' && assetsPresent && oversized.length === 0)
        return outcome(
          'ambiguous',
          { match: 'asset-family-candidate', edition },
          missingRequiredFiles,
          [
            'Rome-family assets are present, but RomeTW.exe is missing; the exact edition is not verified.',
          ]
        );

      if (executableSha256 !== null && executableSha256 !== romeOriginalExecutableSha256)
        diagnostics.push('RomeTW.exe does not match the retained GOG 1.5 executable fingerprint');
      return outcome(
        'unsupported',
        { match: 'no-exact-profile', edition },
        missingRequiredFiles,
        diagnostics
      );
    },
  });
}

export const romeOriginalProfile = createRomeOriginalProfile();
