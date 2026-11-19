// Build-time inspection of trusted reconstructed engine code. No player
// assets or executable are opened; the registered title bundle validates its
// launch declaration, bounded native metadata and reset ownership.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createTrustedGameBundleRegistry } from '../platform/web/runtime/trusted-game-bundle.js';
import {
  createRomeOriginalBundleLoader,
  romeOriginalBundle,
} from '../platform/web/games/rome-original/bundle.js';
import { romeOriginalProfile } from '../platform/web/games/rome-original/profile.js';

let owner;
try {
  if (process.argv.length !== 3) throw new Error('Expected one trusted core build directory');
  const directory = path.resolve(process.argv[2]);
  const { default: createCore } = await import(pathToFileURL(path.join(directory, 'openrtw-core.mjs')));
  const registry = createTrustedGameBundleRegistry();
  registry.register(romeOriginalBundle, createRomeOriginalBundleLoader({
    createCore: () => createCore({
      locateFile: (name) => path.join(directory, name),
      print: () => {},
      printErr: () => {},
    }),
  }));
  owner = await registry.createSession({
    bundleId: romeOriginalBundle.bundleId,
    identity: {
      gameId: romeOriginalProfile.gameId,
      profileId: romeOriginalProfile.profileId,
      hostApiVersion: romeOriginalProfile.hostApiVersion,
      rulesVersion: romeOriginalProfile.rulesVersion,
    },
  }, {
    token: Object.freeze({ throwIfCancelled() {} }),
  });
  const contract = owner.contract;
  owner.dispose();
  owner = null;
  process.stdout.write(JSON.stringify({
    schema: 'openrtw-core-build-compatibility-v1',
    bundle: romeOriginalBundle,
    contract,
  }) + '\n');
} catch (error) {
  try { owner?.dispose(); } catch { /* The first reset failure is already the primary error. */ }
  process.stderr.write((error instanceof Error ? error.message : String(error)).slice(0, 2048) + '\n');
  process.exitCode = 1;
}
