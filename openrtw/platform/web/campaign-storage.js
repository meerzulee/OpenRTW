// Rome save-envelope and legacy-candidate policy over the shared storage host.
import { createIndexedDBStore } from './runtime/indexeddb-store.js';
import {
  createSaveIdentity,
  profileSaveKey,
  assertSaveIdentity,
  profileSaveEnvelopeSchema,
} from './runtime/save-envelope.js';

export const campaignSaveMaxBytes = 1024 * 1024;
const schema = 'openrtw-campaign-slot-v1', legacySlot = 'slot-1';
function copyBytes(bytes) {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength ||
      bytes.byteLength > campaignSaveMaxBytes ||
      (typeof SharedArrayBuffer === 'function' && bytes.buffer instanceof SharedArrayBuffer))
    throw new Error('Campaign save must contain 1 to 1048576 unshared bytes');
  return new Uint8Array(bytes);
}

export function createCampaignStorage({
  indexedDB = globalThis.indexedDB,
  onFailure = () => {},
  identity = null,
  allowLegacyCandidate = false,
} = {}) {
  const saveIdentity = identity === null ? null : createSaveIdentity(identity),
    slot = saveIdentity ? profileSaveKey(saveIdentity) : legacySlot;
  if (typeof allowLegacyCandidate !== 'boolean' ||
      (allowLegacyCandidate && saveIdentity?.gameId !== 'rome-original'))
    throw new Error('Legacy campaign candidates require an explicit Rome profile');
  const storage = createIndexedDBStore({
    indexedDB, onFailure,
    databaseName: 'openrtw-campaign-saves-v1', databaseVersion: 1, storeName: 'saves',
    encode(bytes) {
      const owned = copyBytes(bytes);
      return saveIdentity
        ? { schema: profileSaveEnvelopeSchema, identity: saveIdentity, bytes: owned.buffer }
        : { schema, bytes: owned.buffer };
    },
    decode(record, key) {
      if (record === undefined) return null;
      const isProfile = saveIdentity !== null && key === slot;
      if (!record || record.schema !== (isProfile ? profileSaveEnvelopeSchema : schema) ||
          !(record.bytes instanceof ArrayBuffer))
        throw new Error(key === legacySlot && saveIdentity
          ? 'Legacy campaign save has an invalid envelope'
          : 'Stored campaign save has an invalid envelope');
      if (isProfile) assertSaveIdentity(record.identity, saveIdentity);
      return copyBytes(new Uint8Array(record.bytes));
    },
  });
  return Object.freeze({
    save: (bytes) => storage.save(slot, bytes),
    load: () => storage.load(slot),
    loadLegacyCandidate() {
      if (!allowLegacyCandidate)
        return Promise.reject(new Error('Legacy campaign candidate reads are not enabled'));
      return storage.load(legacySlot);
    },
    flush: storage.flush,
    close: storage.close,
  });
}
