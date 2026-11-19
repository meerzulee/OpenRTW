import { createGameProfileRegistry } from '../../runtime/game-profile-registry.js';
import { romeOriginalProfile } from './profile.js';

// A verified installation is the default. A caller must explicitly request the
// separate Data-only preview; it never selects an exact edition in the registry.
export async function resolveRomeLaunchProfile(assets, { signal, allowAssetPreview = false } = {}) {
  if (signal !== undefined && signal !== null &&
      (typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function' ||
       typeof signal.removeEventListener !== 'function'))
    throw new TypeError('Rome launch signal must be an AbortSignal');
  if (signal?.aborted) throw signal.reason ?? Object.assign(
    new Error('Rome launch aborted'), { name: 'AbortError' });
  if (typeof allowAssetPreview !== 'boolean')
    throw new TypeError('Rome launch allowAssetPreview must be a boolean');
  if (!assets || !['local', 'development'].includes(assets.mode))
    throw new TypeError('Rome launch requires a local or development asset provider');
  if (assets.mode === 'development')
    return Object.freeze({
      identity: Object.freeze({
        gameId: romeOriginalProfile.gameId,
        profileId: 'rome-original/development-preview',
        hostApiVersion: romeOriginalProfile.hostApiVersion,
        rulesVersion: romeOriginalProfile.rulesVersion,
      }),
      verification: 'unverified-development-preview',
      selection: null,
    });
  const selection = await createGameProfileRegistry([romeOriginalProfile]).probe(assets, { signal });
  const candidate =
    selection.status === 'ambiguous' &&
    selection.results.length === 1 &&
    selection.results[0].profileId === romeOriginalProfile.profileId &&
    selection.results[0].details.match === 'asset-family-candidate';
  if (candidate && !allowAssetPreview)
    throw new Error('Rome edition could not be verified. Select the full installation including RomeTW.exe, or choose Unverified Data preview.');
  if (selection.status !== 'supported' && !candidate) {
    const reasons = selection.results.flatMap((result) => [
      ...result.diagnostics,
      ...result.missingRequiredFiles.map((path) => 'Missing ' + path),
    ]);
    throw new Error('Unsupported Rome installation: ' + (reasons.join('; ') || selection.status));
  }
  return Object.freeze({
    identity: Object.freeze({
      gameId: romeOriginalProfile.gameId,
      profileId: candidate ? 'rome-original/local-asset-preview' : selection.profileId,
      hostApiVersion: romeOriginalProfile.hostApiVersion,
      rulesVersion: romeOriginalProfile.rulesVersion,
    }),
    verification: candidate ? 'unverified-local-asset-preview' : 'executable-verified-assets-presence-only',
    selection,
  });
}
