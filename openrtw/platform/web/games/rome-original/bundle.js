import {
  openrtwWebHostApiVersion,
  trustedGameBundleSchema,
  trustedGameSessionInterface,
  TrustedGameBundleError,
  validateTrustedGameBundle,
} from '../../runtime/trusted-game-bundle.js';
import { createRomeCoreSessionFactory } from './core-session.js';
import { romeOriginalProfile, romeOriginalRulesVersion } from './profile.js';

export const romeOriginalBundle = validateTrustedGameBundle({
  schema: trustedGameBundleSchema,
  bundleId: 'rome-original/core-wasm-v1',
  gameId: romeOriginalProfile.gameId,
  profileIds: [
    romeOriginalProfile.profileId,
    'rome-original/local-asset-preview',
    'rome-original/development-preview',
  ],
  hostApiVersion: openrtwWebHostApiVersion,
  rulesVersion: romeOriginalRulesVersion,
  loaderId: 'rome-original/emscripten-core-v1',
  interfaces: {
    session: trustedGameSessionInterface,
    commandSchema: 'rome-original.commands/partial-v1',
    snapshotSchema: 'rome-original.snapshots/partial-v1',
    coreContract: 'openrtw-core-contract-v1',
  },
  build: {
    target: 'wasm',
    module: 'core/openrtw-core.mjs',
    wasm: 'core/openrtw-core.wasm',
  },
});

export function createRomeOriginalBundleLoader({ createCore } = {}) {
  const createSession = createRomeCoreSessionFactory({ createCore });
  return async (identity, context, manifest = romeOriginalBundle) => {
    const declared = validateTrustedGameBundle(manifest);
    // These identify this adapter's supported partial Rome interfaces. They
    // are title policy; the generic host only interprets its session interface.
    for (const [field, version] of Object.entries(romeOriginalBundle.interfaces)) {
      if (declared.interfaces[field] !== version)
        throw new TrustedGameBundleError('unsupported-interface',
          'Rome bundle does not implement the declared ' + field,
          { field: 'interfaces.' + field });
    }
    const owner = await createSession(identity, context);
    if (owner.contract.schema !== declared.interfaces.coreContract) {
      const error = new TrustedGameBundleError('incompatible-core-contract',
        'Compiled Rome contract does not match the selected bundle');
      try { owner.dispose(); }
      catch (cleanupError) {
        throw new AggregateError([error, cleanupError],
          'Rome bundle contract refused and reset failed', { cause: error });
      }
      throw error;
    }
    return owner;
  };
}
