function failureText(error) {
  try { return String(error); } catch { return 'Unprintable failure cause'; }
}

export function createCampaignBattleActions({
  codec,
  store,
  core,
  getView,
  readSession,
  publishSession,
  resetCampaign,
  protocolError = (message) => Object.assign(new Error(message), { campaignProtocol: true }),
} = {}) {
  if (codec?.campaignBattleSavePayloadSchema !== 'rome-original.campaign-battle-checkpoint/v1' ||
      typeof codec.copyCampaignBattleCheckpoint !== 'function' ||
      !store || !core || typeof getView !== 'function' || typeof readSession !== 'function' ||
      typeof publishSession !== 'function' || typeof resetCampaign !== 'function' ||
      typeof protocolError !== 'function')
    throw TypeError('Campaign/battle action contract is incomplete');

  function readBattle() {
    const pointer = core._openrtw_battle_json();
    if (pointer === 0) return null;
    if (!Number.isInteger(pointer) || pointer < 0)
      throw protocolError('Core battle publication is unavailable');
    const wire = core.UTF8ToString(pointer);
    return { value: JSON.parse(wire), wire };
  }

  function current(context, lease) {
    return context.isCurrent() && (!lease || lease.isCurrent);
  }

  function terminal(error) {
    if (error?.campaignProtocol) return error;
    const failure = protocolError(
      'The checkpoint was accepted by the core, but the restored battle view could not be attached: ' +
        failureText(error)
    );
    try { failure.cause = error; } catch {}
    return failure;
  }

  async function save(context) {
    const lease = getView()?.holdPersistence();
    if (!lease) throw new Error('Open a ready battle before saving a campaign and battle checkpoint.');
    try {
      const checkpoint = codec.copyCampaignBattleCheckpoint(lease.captureCheckpoint());
      await store.save(checkpoint);
      await store.flush();
      context.ioFinished();
      if (!current(context, lease)) return null;
      return {
        campaignBytes: checkpoint.campaignBytes.length,
        battleBytes: checkpoint.battle.coreBytes.length,
      };
    } finally {
      if (context.isCurrent() && lease.isCurrent) lease.release();
    }
  }

  async function load(context) {
    const view = getView(), lease = view?.active ? view.holdPersistence() : null;
    let committed = false;
    try {
      const beforeCampaign = readSession(), beforeBattle = readBattle();
      const expected = {
        campaignGeneration: beforeCampaign.value.generation,
        campaignRevision: beforeCampaign.value.revision,
        campaignOrderRevision: beforeCampaign.value.orderRevision,
        battleGeneration: beforeBattle?.value.generation ?? 0,
        battleRevision: beforeBattle?.value.revision ?? 0,
      };
      let loaded;
      try {
        loaded = await store.load();
      } finally {
        context.ioFinished();
      }
      if (!current(context, lease)) return null;
      if (loaded === null) throw new Error('No campaign and battle checkpoint exists for this game profile.');
      const checkpoint = codec.copyCampaignBattleCheckpoint(loaded);
      if (!current(context, lease)) return null;

      const campaignBytes = checkpoint.campaignBytes, battleBytes = checkpoint.battle.coreBytes;
      const campaignPointer = core._malloc(campaignBytes.length);
      if (!Number.isInteger(campaignPointer) || campaignPointer <= 0)
        throw new Error('Campaign checkpoint allocation failed');
      let battlePointer;
      try {
        battlePointer = core._malloc(battleBytes.length);
      } catch (error) {
        core._free(campaignPointer);
        throw error;
      }
      if (!Number.isInteger(battlePointer) || battlePointer <= 0) {
        core._free(campaignPointer);
        throw new Error('Battle checkpoint allocation failed');
      }
      let result;
      try {
        const heap = core.HEAPU8;
        if (!(heap instanceof Uint8Array) ||
            campaignPointer > heap.length - campaignBytes.length ||
            battlePointer > heap.length - battleBytes.length)
          throw protocolError('Checkpoint allocations are outside current core memory');
        heap.set(campaignBytes, campaignPointer);
        heap.set(battleBytes, battlePointer);
        if (!current(context, lease)) return null;
        result = core._openrtw_import_campaign_battle_save(
          campaignPointer, campaignBytes.length, battlePointer, battleBytes.length,
          checkpoint.playerId, checkpoint.enemyId,
          expected.campaignGeneration, expected.campaignRevision, expected.campaignOrderRevision,
          expected.battleGeneration, expected.battleRevision
        );
      } finally {
        core._free(battlePointer);
        core._free(campaignPointer);
      }
      if (result !== 0 && result !== 1)
        throw protocolError('Core campaign/battle import returned an invalid status');
      if (result === 0) {
        const afterCampaign = readSession(), afterBattle = readBattle();
        if (afterCampaign.wire !== beforeCampaign.wire ||
            afterBattle?.wire !== beforeBattle?.wire)
          throw protocolError('Refused campaign/battle import changed a core publication');
        throw new Error(core.UTF8ToString(core._openrtw_error()) ||
          'The core refused this campaign and battle checkpoint.');
      }
      committed = true;

      const nextCampaign = readSession(), nextBattle = readBattle();
      if (!nextBattle || nextCampaign.value.generation === expected.campaignGeneration ||
          nextBattle.value.generation === expected.battleGeneration ||
          nextBattle.value.campaignGeneration !== nextCampaign.value.generation ||
          nextBattle.value.playerActorId !== checkpoint.playerId ||
          nextBattle.value.enemyActorId !== checkpoint.enemyId)
        throw protocolError('Restored campaign/battle publications are inconsistent');

      publishSession(nextCampaign);
      resetCampaign();
      if (lease) {
        await lease.detachReplaced({
          campaignGeneration: nextCampaign.value.generation,
          battleGeneration: nextBattle.value.generation,
        });
        if (!context.isCurrent()) return null;
      }
      if (!context.isCurrent()) return null;
      const adopted = await getView()?.adopt({
        playerId: checkpoint.playerId,
        enemyId: checkpoint.enemyId,
        campaignGeneration: nextCampaign.value.generation,
        campaignRevision: nextCampaign.value.revision,
        campaignOrderRevision: nextCampaign.value.orderRevision,
      }, checkpoint);
      if (!context.isCurrent()) return null;
      if (adopted !== true)
        throw protocolError('The restored battle controller did not become ready');
      return {
        campaignBytes: campaignBytes.length,
        battleBytes: battleBytes.length,
        outcome: nextBattle.value.outcome,
      };
    } catch (error) {
      if (committed) throw terminal(error);
      throw error;
    } finally {
      if (!committed && context.isCurrent() && lease?.isCurrent) lease.release();
    }
  }

  return Object.freeze({
    save,
    load,
    canSave() {
      const view = getView();
      return Boolean(view?.active && ['paused', 'running'].includes(view.state));
    },
    canLoad() {
      const view = getView();
      return !view?.active || ['paused', 'running'].includes(view.state);
    },
  });
}
