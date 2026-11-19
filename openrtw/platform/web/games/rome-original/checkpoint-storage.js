// Rome checkpoint codec and namespace policy over the generic transaction host.
import { createIndexedDBStore } from '../../runtime/indexeddb-store.js';
import { createFixedStepClock } from '../../runtime/fixed-step-clock.js';
import {
  createSaveIdentity, assertSaveIdentity, profileSaveKey, profileSaveEnvelopeSchema,
} from '../../runtime/save-envelope.js';

export const campaignBattleSavePayloadSchema = 'rome-original.campaign-battle-checkpoint/v1';
export const campaignBattleSaveLimits = Object.freeze({
  campaignBytes: 1024 * 1024, battleBytes: 32 * 1024 * 1024,
});
const controllerSchema = 'rome-original.battle-controller-save/v1';
const identityFields = Object.freeze([
  'gameId', 'profileId', 'hostApiVersion', 'rulesVersion', 'payloadSchema', 'contentFingerprint',
]);
const uint = (value) => Number.isInteger(value) && value >= 0 && value <= 0xffffffff;

function fields(value, names, label) {
  if (!value || typeof value !== 'object' ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    throw TypeError(label + ' must be a plain data record');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== names.length ||
      names.some((name) => !descriptors[name] || !('value' in descriptors[name])))
    throw TypeError(label + ' has unsupported fields');
  return Object.fromEntries(names.map((name) => [name, descriptors[name].value]));
}
function byteView(value, maximum, label) {
  if (!(value instanceof Uint8Array) || !(value.buffer instanceof ArrayBuffer) ||
      !value.byteLength || value.byteLength > maximum)
    throw TypeError(label + ' exceeds its unshared byte bound');
  return value;
}

// Snapshot all metadata and validate both spans before copying either. Core
// formats, CRCs, encounter/source matching and native admission stay in C++.
export function copyCampaignBattleCheckpoint(input) {
  const value = fields(input, ['schema', 'playerId', 'enemyId', 'campaignBytes', 'battle'], 'Checkpoint');
  const battle = fields(value.battle,
    ['schema', 'coreBytes', 'running', 'speed', 'selectedId', 'clock'], 'Battle checkpoint');
  if (value.schema !== campaignBattleSavePayloadSchema ||
      !uint(value.playerId) || !uint(value.enemyId) || value.playerId === value.enemyId ||
      battle.schema !== controllerSchema || typeof battle.running !== 'boolean' ||
      ![1, 4].includes(battle.speed) ||
      (battle.selectedId !== null && (!uint(battle.selectedId) || battle.selectedId >= 40)))
    throw TypeError('Invalid campaign/battle checkpoint metadata');
  const campaignBytes = byteView(value.campaignBytes, campaignBattleSaveLimits.campaignBytes, 'Campaign checkpoint'),
    battleBytes = byteView(battle.coreBytes, campaignBattleSaveLimits.battleBytes, 'Battle checkpoint'),
    clock = createFixedStepClock({ tickMilliseconds: 100, maxTicksPerAdvance: 20 });
  clock.restore(battle.clock);
  if (clock.getState().rate !== battle.speed)
    throw TypeError('Checkpoint speed differs from its clock');
  return Object.freeze({
    schema: campaignBattleSavePayloadSchema,
    playerId: value.playerId, enemyId: value.enemyId,
    campaignBytes: new Uint8Array(campaignBytes),
    battle: Object.freeze({
      schema: controllerSchema, coreBytes: new Uint8Array(battleBytes),
      running: battle.running, speed: battle.speed, selectedId: battle.selectedId,
      clock: clock.snapshot(),
    }),
  });
}

export function createCampaignBattleStorage({
  identity, indexedDB = globalThis.indexedDB, onFailure = () => {},
} = {}) {
  const saveIdentity = createSaveIdentity(fields(identity, identityFields, 'Checkpoint identity'));
  if (saveIdentity.gameId !== 'rome-original' ||
      saveIdentity.payloadSchema !== campaignBattleSavePayloadSchema)
    throw TypeError('Campaign/battle storage requires its Rome profile and payload schema');
  const key = profileSaveKey(saveIdentity);
  const store = createIndexedDBStore({
    indexedDB, onFailure,
    databaseName: 'openrtw-rome-campaign-battle-saves-v1', databaseVersion: 1, storeName: 'saves',
    encode(input) {
      const checkpoint = copyCampaignBattleCheckpoint(input);
      // Each buffer is the exact owned view region, including Node Buffer
      // subviews. The generic host then owns its own structured clone.
      return {
        schema: profileSaveEnvelopeSchema, identity: saveIdentity,
        checkpoint: {
          ...checkpoint, campaignBytes: checkpoint.campaignBytes.buffer,
          battle: {...checkpoint.battle, coreBytes: checkpoint.battle.coreBytes.buffer},
        },
      };
    },
    decode(record) {
      if (record === undefined) return null;
      const envelope = fields(record, ['schema', 'identity', 'checkpoint'], 'Stored checkpoint envelope');
      if (envelope.schema !== profileSaveEnvelopeSchema)
        throw TypeError('Unsupported stored checkpoint envelope');
      assertSaveIdentity(fields(envelope.identity, identityFields, 'Stored checkpoint identity'), saveIdentity);
      const value = fields(envelope.checkpoint,
        ['schema', 'playerId', 'enemyId', 'campaignBytes', 'battle'], 'Stored checkpoint');
      const battle = fields(value.battle,
        ['schema', 'coreBytes', 'running', 'speed', 'selectedId', 'clock'], 'Stored battle checkpoint');
      if (!(value.campaignBytes instanceof ArrayBuffer) || !(battle.coreBytes instanceof ArrayBuffer))
        throw TypeError('Stored checkpoint spans must be unshared ArrayBuffers');
      return copyCampaignBattleCheckpoint({
        ...value, campaignBytes: new Uint8Array(value.campaignBytes),
        battle: {...battle, coreBytes: new Uint8Array(battle.coreBytes)},
      });
    },
  });
  return Object.freeze({
    save: (checkpoint) => store.save(key, checkpoint),
    load: () => store.load(key),
    flush: store.flush,
    close: store.close,
  });
}
