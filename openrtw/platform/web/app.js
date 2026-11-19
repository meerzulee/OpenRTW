import { describeFailure } from '/runtime/failure.js';
import { attachSound } from '/audio.js';
import { createCampaignStorage, campaignSaveMaxBytes } from '/campaign-storage.js';
import { createUnitPreview, geometry as createUnitGeometry } from '/unit-preview.js';
import { loadCampaignGeneral } from '/campaign-model.js';
import { loadTownAssets } from '/town-assets.js';
import { createCampaignScene } from '/campaign-scene.js';
import { createCampaignFog } from '/campaign-fog.js';
import { createCampaignCameraKeys } from '/campaign-camera-keys.js';
import { createCampaignTravel } from '/campaign-travel.js';
import { groundFootprint } from '/campaign-minimap.js';
import { buildCampaignMovementRange } from '/campaign-movement-range.js';
import {
  resolveCampaignInteraction,
  movementTerrainReason,
  routeTerrainReason,
} from '/campaign-interactions.js';
import { createCampaignFogTexture, extendCampaignFogVertices } from '/campaign-fog-renderer.js';
import { createAerialTerrain, feedAerialDecals } from '/aerial-terrain-pages.js';
import { originalInitialCampaignView } from '/campaign-camera-reference.js';
import { buildSettlementLabelBindings, createSettlementLabels } from '/settlement-labels.js';
import { createBattleView } from '/battle-view.js';
import { loadUnitTexture, hastatiTextureSha256, createTerrainTexture } from '/unit-texture.js';
import { loadWaterTexture, waterTextureSha256 } from '/water-texture.js';
import { decodeTgaTexture } from '/texture-image.js';
import { createCampaignHud, originalCampaignHudReference } from '/campaign-hud.js';
import {
  createDevelopmentAssets,
  createLocalGameAssets,
  aerialGroundAssetPaths,
  aerialDecalAssets,
  aerialBaseAssetName,
} from '/game-assets.js';
import { resolveRomeLaunchProfile } from '/games/rome-original/launch-profile.js';
import { createProductionSettlementRefresh } from '/games/rome-original/production-settlement-refresh.js';
import { fingerprintSaveInputs, createSaveIdentity } from '/runtime/save-envelope.js';
import { createSessionRuntime } from '/runtime/session-runtime.js';
import { createAssetReadScope } from '/runtime/asset-read-scope.js';
import {
  createTrustedGameBundleRegistry,
  createTrustedGameBundleSessionFactory,
} from '/runtime/trusted-game-bundle.js';
import { romeOriginalBundle } from '/games/rome-original/bundle.js';
import { loadRomeOriginalBundle } from '/games/rome-original/bundle-loader.js';
import {
  romeOriginalCampaignRuleProfile,
  romeOriginalSavePayloadSchema,
} from '/games/rome-original/profile.js';
import createRenderer from '/renderer/renderer.mjs';
import {
  createRendererBridge,
  TextureFormat,
  Primitive,
  Fvf,
  Transform,
  RenderState,
  StageState,
  TextureOp,
  TextureArg,
  Address,
  Filter,
} from '/reference/renderer-bridge.js';

// Pure source join, kept separate from DOM/startup work for focused validation.
// These two initial source records do not establish current settlement owners.
export function buildTownBindings(campaign, regionData, world, worldIndices) {
  const refuse = () => {
    throw new Error('Initial town source/region/black-marker binding differs');
  };
  const integer = (v, max) => Number.isInteger(v) && v >= 0 && v <= max;
  const rgb = (value) =>
    Array.isArray(value) && value.length === 3 && value.every((v) => integer(v, 255));
  const sameRgb = (a, b) => a.every((v, i) => v === b[i]);
  if (
    !Array.isArray(campaign?.factions) ||
    campaign.factions.length > 4096 ||
    !Array.isArray(regionData?.definitions) ||
    regionData.definitions.length > 4096 ||
    !Array.isArray(world?.palette) ||
    world.palette.length > 4096 ||
    !world.palette.every(rgb) ||
    !Array.isArray(world.markers) ||
    world.markers.length > 100000 ||
    !integer(world.width, 4096) ||
    !integer(world.height, 4096) ||
    !world.width ||
    !world.height ||
    !Array.isArray(worldIndices) ||
    worldIndices.length !== world.width * world.height
  )
    refuse();
  const selected = [
    { region: 'Etruria', sourceLine: 454, x: 91, y: 80 },
    { region: 'Umbria', sourceLine: 489, x: 96, y: 82 },
  ];
  let total = 0;
  const records = [];
  for (const faction of campaign.factions) {
    if (
      typeof faction?.id !== 'string' ||
      !Array.isArray(faction.settlements) ||
      faction.settlements.length > 4096 - total
    )
      refuse();
    total += faction.settlements.length;
    for (const settlement of faction.settlements)
      if (selected.some((row) => row.region === settlement?.region))
        records.push({ faction, settlement });
  }
  return Object.freeze(
    selected.map((expected) => {
      const sources = records.filter((row) => row.settlement.region === expected.region);
      if (sources.length !== 1) refuse();
      const { faction, settlement } = sources[0];
      if (
        faction.id !== 'romans_julii' ||
        settlement.factionCreator !== 'romans_julii' ||
        settlement.level !== 'large_town' ||
        settlement.line !== expected.sourceLine
      )
        refuse();
      const definitions = regionData.definitions.filter((row) => row?.id === settlement.region);
      if (definitions.length !== 1 || !rgb(definitions[0].rgb)) refuse();
      const color = definitions[0].rgb;
      if (
        regionData.definitions.filter((row) => rgb(row?.rgb) && sameRgb(row.rgb, color)).length !==
        1
      )
        refuse();
      const palette = world.palette.flatMap((value, i) => (sameRgb(value, color) ? [i] : []));
      if (palette.length !== 1) refuse();
      const regionIndex = palette[0];
      const markers = world.markers.filter(
        (row) => row?.rawKind === 'black' && row.regionIndex === regionIndex
      );
      if (markers.length !== 1) refuse();
      const marker = markers[0];
      if (
        marker.coordinateWritten !== true ||
        !integer(marker.imageX, world.width - 1) ||
        !integer(marker.imageY, world.height - 1) ||
        marker.worldX !== marker.imageX ||
        marker.worldY !== world.height - 1 - marker.imageY ||
        marker.worldX !== expected.x ||
        marker.worldY !== expected.y ||
        worldIndices[marker.worldY * world.width + marker.worldX] !== regionIndex
      )
        refuse();
      return Object.freeze({
        region: settlement.region,
        x: marker.worldX,
        y: marker.worldY,
        sourceLine: settlement.line,
        sourceSection: faction.id,
        level: settlement.level,
      });
    })
  );
}
// End pure town-source join.

const canvas = document.querySelector('#terrain'),
  status = document.querySelector('#status'),
  errorBox = document.querySelector('#error');
const factionSelect = document.querySelector('#faction'),
  reset = document.querySelector('#reset'),
  details = document.querySelector('#details');
const layer = document.querySelector('#layer'),
  detailTitle = document.querySelector('#detail-title');
const assetSetup = document.querySelector('#asset-setup'),
  assetStatus = document.querySelector('#asset-status'),
  gameFolder = document.querySelector('#game-folder'),
  gameLaunchMode = document.querySelector('#game-launch-mode'),
  assetNotice = document.querySelector('#asset-notice'),
  campaignShell = document.querySelector('#campaign-shell');
const isCampaignLayer = () => layer.value === 'world' || layer.value === '3d';
const characterSelect = document.querySelector('#character'),
  moveButton = document.querySelector('#move-here'),
  endTurnButton = document.querySelector('#end-turn');
const centerButton = document.querySelector('#center-character');
const battleOpponent = document.querySelector('#battle-opponent'),
  battleButton = document.querySelector('#begin-battle'),
  battleStatus = document.querySelector('#battle-status');
const settlementSelect = document.querySelector('#settlement'),
  clearSettlement = document.querySelector('#clear-settlement'),
  settlementInfo = document.querySelector('#settlement-inspection'),
  settlementBuildings = document.querySelector('#settlement-buildings');
const cancelButton = document.querySelector('#cancel-journey');
const factionJourneyButton = document.querySelector('#continue-faction-journeys'),
  factionJourneyStatus = document.querySelector('#faction-journey-status'),
  factionJourneyResults = document.querySelector('#faction-journey-results');
const targetStatus = document.querySelector('#target-status'),
  commandStatus = document.querySelector('#command-status');
const routeStatus = document.querySelector('#route-status');
const armyPanel = document.querySelector('#army-panel'),
  armyTitle = document.querySelector('#army-title'),
  armyList = document.querySelector('#army-list');
const saveButton = document.querySelector('#save-campaign'),
  loadButton = document.querySelector('#load-campaign'),
  stopButton = document.querySelector('#stop-campaign'),
  saveStatus = document.querySelector('#save-status'),
  compoundSaveButton = document.querySelector('#save-campaign-battle'),
  compoundLoadButton = document.querySelector('#load-campaign-battle'),
  compoundSaveStatus = document.querySelector('#campaign-battle-save-status');
const inputPins = {
  terrain: 'c5cb5538d0e693d9488db7157c2dd2caf866b45ce6a1f724f868175e5377907f',
  campaign: '165677c3d9c122b6076fbeb9036850aeefba723b0526564c5c39a987fe3ba985',
  regions: 'c049699059fe1013e36ea124031f2092b5fea028feda9b5ea1583b507771bb64',
  regionMap: 'c5e92e635c7d840b4c3bf3ce483b1d36e2e3d6a847db09286928ad3be2621feb',
  groundMap: 'ae24ea8f185ba1d21828a44f350e1c5e38ce2ededc85cab0387298af48dc4db0',
  climates: '3a21c82f911a410a88c0d3fcb34cc7a5ba712b2fcfcad3aca45136911602e4e6',
  climateMap: 'dac53551c9f581fcf76d5b6392a5115fad67e52acc4f3ee415dd498ba5328a7c',
  pcm: '5e5e8a2444d3262509217357edd4eae0fb8c2d33734d9dce19aa320f5e9dfd57',
};
inputPins.unitDefinitions = '2285f2049bdf00dc227f5d91add58a97a89f2c33af3d077e06608566a83e534e';
inputPins.battleModels = 'f432e6265f38ade7c467dd69b596dc1088c2b5e5a664a5f4001ef47640227ae6';
inputPins.hastati = '61e9ad81bb33e9ec14a7b52473535e666ee0898498776f7ce2fa1d098fe2d27d';
inputPins.hastatiTexture = hastatiTextureSha256;
inputPins.campaignGeneral = 'a85699cad84e0b5fa154f88efcf1d720dc10232612767f92937b4f788b1a3e0c';
inputPins.campaignGeneralTexture =
  '3768d9273e3ba4fc8005577b38f79714207260ca3f0160858fe02454f2116a8c';
inputPins.romanLargeTown = 'c7df731873dc764dc6cc98f6921f3339605f2db5ec6b4836215368afd9cb1997';
inputPins.romanLargeTownTexture =
  'c06b1002d731b3a3040f324dcf138545acc6bd3bf4ce3bf1c8621197313d3724';
inputPins.terrainGrass = 'a2ea50856b0f2f264d0bf7beaba099a372948fe4e84aa68791204d8bad8f8e4f';
inputPins.terrainHills = '3feaa43b3e8ba6bac9eb3b052acdf3e6c24323efc78a17b6811641d07ef067f4';
inputPins.terrainWater = waterTextureSha256;
inputPins.campaignHudLayout = 'ca717e62c899a4d951ebe2c4aa15f8410f9a03f9efb22bf022d1a2651ea99dab';
inputPins.campaignHudAtlas1 = '166b39b4686c7b8f0b83de844fbc60855faa8c542c6980332e6566538196b456';
inputPins.campaignHudAtlas2 = 'ce659258e8a7dcd554eb93fec110d2863b6e2eec837eb3d6ea3d647c3e24d17e';
inputPins.campaignHudAtlas3 = 'f80d66eba10963de9b9d44a914de3d4fd3e4a486b1ddf4c60238c746d50b608a';
inputPins.campaignHudSharedLayout =
  '0ce2f5d03b85cb67caa20c0f29cfd8b123d584d99e7b9d4bdd449cf80e1a8fd6';
inputPins.campaignHudSharedAtlas0 =
  '0262dc1cac13b9bcdf2ea05c7e65942ffae8ec4e8f7bb10735fb9d552d041405';
inputPins.campaignHudSharedAtlas1 =
  'e2251c63fc279da6f41ee0112555d26f02bed88d968eea63d2f81fa7fa33c7cc';
inputPins.unitCardJuliiGeneral = 'f52c6a3c5914983c01aab34fef32a048a733189b27dfa07d1293a565cd688232';
inputPins.unitCardJuliiHastati = 'a911e7538af6a6c537718329a0f1a54251e67bf05447055639842504f8b3bcc4';
inputPins.unitCardJuliiTriarii = '158895488ef6eee6d4fbf285f42abb36eaac95476dfe766ad00d41cabd59ea5d';
inputPins.unitCardJuliiArcher = '7daaf1c23573d7e3a72e1796f3e029a0b572d4e12df4daee5610ed2721f14e66';
// Optional native aerial ground inputs: descriptor, 7 blend weights, 17 textures.
inputPins.aerialGroundTypes = '85584eb063c2cd260e9ba40b2694359c133e92abe24549e88747f06b7dece98f';
inputPins.aerialWeight1 = '845f616c152cc19a3d2e2617e16a15c8300afe7fe40b8a1fa8a84a3404d2ac89';
inputPins.aerialWeight2 = '654c4d54b1a86bd849fb4f7833f1314ff51d149ad320f32440074148efcea7f5';
inputPins.aerialWeight3 = '489f03879e85566367845027d384d8a0279a98e206cabc31ce0a1b0498c3cb15';
inputPins.aerialWeight4 = '28c9fe226048468b344dc2811ab4bbacc245ac9d6a903e00334787a218345794';
inputPins.aerialWeight5 = 'be519e5bdb56f496d013bdc3a16734fcac644161002460d8cb47bb8792202026';
inputPins.aerialWeight6 = 'b1e8d889c80d0c28fb81e44d02abb9c7b5220a9adffa4083cd3221eeefa1fe0a';
inputPins.aerialWeight7 = '8489331f8b652d06a5745f8dcb850bff99ecae02d2e7d91d0d539c508af22cc7';
inputPins.aerialTexture_temperate_grassland_farm =
  '3e34f1a1cbf8c198259a04f64f6820ad75486a0ec195c42f7cc4e7158b96928b';
inputPins.aerialTexture_arctic = 'da1e66846158175be403cd140cfe8a74a3df054fb574bddd4456a3ab168f1804';
inputPins.aerialTexture_texture2 =
  'db177eefe8ebbbfe61353ab3d9230a409de293c9ec50cb9eaae09e944dfd9a05';
inputPins.aerialTexture_temperate_grassland =
  'a2ea50856b0f2f264d0bf7beaba099a372948fe4e84aa68791204d8bad8f8e4f';
inputPins.aerialTexture_texture1 =
  '3c96ddf20b70369a60c1c8f33669ac0d0c5f389202d114954672fc452ce38d80';
inputPins.aerialTexture_texture1_hilly =
  '3feaa43b3e8ba6bac9eb3b052acdf3e6c24323efc78a17b6811641d07ef067f4';
inputPins.aerialTexture_temperate_mountain_small =
  'efa445ddcd6bfa225f46c1d4867a1f75639c0090ecace93939c350902d11198c';
inputPins.aerialTexture_temperate_hills_small =
  '38f3d7eda81f08ccc44fdbfb976b0e1f67c5b755434704e9c51057582107143e';
inputPins.aerialTexture_swamp = '26e33b02bf9d945fc2a825b18026b4df5abfbff1814793266a24aa86c9d041af';
inputPins.aerialTexture_beach = '2061cd09d0bd932f8d2a4f0d1ef2ecbd488f706cc4102164c2191e2138dae091';
inputPins.aerialTexture_scorched =
  '76ebfdcfb56a844ce53c20e3ddc29acebfc6f8cf8dc444df18d2f212fb140f8c';
inputPins.aerialTexture_alpine = '2b6cc7bd2ac0cab343112ccb6f6e03d37be60081238326d21e8dd736646592fb';
inputPins.aerialTexture_desert_rocky_low_fertility =
  '9226836ae5544b2fd66c175df4fb52e11e648da08d7569ac3c645a99541593db';
inputPins.aerialTexture_desert_rocky_medium_fertility =
  'e7640f88f9085b1c21cdac1706fa9ad4ee05eb38eb7db094369009ae41d79379';
inputPins.aerialTexture_desert_hills =
  '79b9e6a873946a438cf4e98f54e990fb74c9fc21b438cb2c0d791c7ceb0ae448';
inputPins.aerialTexture_desert_mountains =
  '77ee501a87430841d5752db9a5724cfbd851259bf90a6073bae9ab12cc59c08a';
inputPins.aerialTexture_desert_sandy_medium_fertility =
  '74a4ca51452a26a49dda6d62b77cf634f812d18e09ef0ca4f051d6f5835dcdb3';
// Optional native aerial decal inputs (3 descriptors, 52 bases/ images): one pin
// table in game-assets.js, which also checks length and digest in both modes.
for (const { name, sha256 } of aerialDecalAssets) inputPins[name] = sha256;
const digest = async (bytes) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('');
async function asset(name, _path, options = {}) {
  if (!gameAssets) throw new Error('Choose your RTW game files first.');
  const bytes = await gameAssets.read(name, options);
  if ((await digest(bytes)) !== inputPins[name])
    throw new Error(`This RTW ${name} file is not supported by this prototype build.`);
  return bytes;
}
async function chooseGameAssets() {
  const response = await fetch('/config.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('Cannot load the engine configuration.');
  const text = await response.text();
  if (text.length > 1024) throw new Error('Engine configuration is too large.');
  const config = JSON.parse(text);
  if (
    typeof config.developmentAssets !== 'boolean' ||
    (config.standingPosePreview !== undefined && typeof config.standingPosePreview !== 'boolean') ||
    (config.battleAssetsPreview !== undefined && typeof config.battleAssetsPreview !== 'boolean') ||
    (config.infantryStandingPosePreview !== undefined &&
      typeof config.infantryStandingPosePreview !== 'boolean')
  )
    throw new Error('Engine configuration is invalid.');
  standingPosePreview = config.standingPosePreview !== false;
  battleAssetsPreview = config.battleAssetsPreview === true;
  infantryStandingPosePreview = config.infantryStandingPosePreview === true;
  if (infantryStandingPosePreview && !battleAssetsPreview)
    throw new Error('Infantry poses require the selected battle assets.');
  const standingModule = standingPosePreview ? await import('/standing-source-assets.js') : null;
  requireOpen();
  let battleModule = null;
  if (battleAssetsPreview) {
    battleModule = await import('/battle-source-assets.js');
    requireOpen();
  }
  let infantryModule = null;
  if (infantryStandingPosePreview) {
    infantryModule = await import('/infantry-standing-source-assets.js');
    requireOpen();
  }
  if (config.developmentAssets) {
    if (standingModule) standingAssets = standingModule.createDevelopmentStandingAssets();
    if (battleModule)
      battleAssets = battleModule.createDevelopmentBattleAssets({ isOpen: () => !closing });
    if (infantryModule)
      infantryStandingAssets = infantryModule.createDevelopmentInfantryStandingAssets();
    assetSetup.hidden = true;
    campaignShell.hidden = false;
    assetNotice.textContent =
      'Using your local development game files.' +
      (standingPosePreview ? ' Original standing-pose preview.' : '');
    const source = createDevelopmentAssets();
    gameLaunchProfile = await resolveRomeLaunchProfile(source);
    requireOpen();
    return source;
  }
  assetSetup.hidden = false;
  campaignShell.hidden = true;
  gameFolder.disabled = false;
  gameLaunchMode.disabled = false;
  const selectionPrompt = () => gameLaunchMode.value === 'asset-preview'
    ? 'Choose your Data folder for an unverified preview. Files stay on this device.'
    : 'Choose the full RTW installation including RomeTW.exe to verify its edition. Files stay on this device.';
  assetStatus.textContent = selectionPrompt();
  return await new Promise((resolve, reject) => {
    let finished = false,
      selectionRevision = 0,
      selectionAbort = null;
    const finish = (source, error) => {
      if (finished) return;
      finished = true;
      selectionRevision++;
      selectionAbort?.abort();
      gameFolder.removeEventListener('change', changed);
      gameLaunchMode.removeEventListener('change', modeChanged);
      window.removeEventListener('pagehide', closed);
      gameFolder.disabled = true;
      gameLaunchMode.disabled = true;
      if (error) reject(error);
      else {
        assetSetup.hidden = true;
        campaignShell.hidden = false;
        assetNotice.textContent = gameLaunchProfile.verification === 'unverified-local-asset-preview'
          ? 'Unverified Data preview · selected files stay on this device.'
          : 'Rome executable verified · selected files stay on this device.';
        resolve(source);
      }
    };
    const closed = () => finish(null, new Error('Game selection closed.'));
    const changed = async () => {
      if (finished || closing) return;
      const revision = ++selectionRevision;
      selectionAbort?.abort();
      const controller = new AbortController();
      selectionAbort = controller;
      let candidateInfantry = null,
        accepted = false;
      try {
        const mode = gameLaunchMode.value;
        if (!['verified-install', 'asset-preview'].includes(mode))
          throw new Error('Choose Verify installation or Unverified Data preview.');
        const allowAssetPreview = mode === 'asset-preview';
        const selectedFiles = gameFolder.files;
        if (
          !selectedFiles ||
          !Number.isSafeInteger(selectedFiles.length) ||
          selectedFiles.length < 0 ||
          selectedFiles.length > 65536
        )
          throw new Error('Selected game folder has too many files.');
        const files = Array.from(selectedFiles),
          source = createLocalGameAssets(files),
          standing = standingModule?.createOptionalLocalStandingAssets(files),
          battle = battleModule?.createLocalBattleAssets(files, { isOpen: () => !closing }),
          infantry = infantryModule?.createLocalInfantryStandingAssets(files);
        candidateInfantry = infantry;
        const missing = [
          ...new Set([
            ...source.describe().missingPaths,
            ...(battle?.describe().missingPaths ?? []),
            ...(infantry?.describe().missingPaths ?? []),
          ]),
        ];
        if (missing.length) {
          assetStatus.textContent = 'Missing game files: ' + missing.join(', ');
          return;
        }
        assetStatus.textContent = 'Checking selected game files…';
        const launch = await resolveRomeLaunchProfile(source, { signal: controller.signal, allowAssetPreview });
        if (finished || closing || revision !== selectionRevision) return;
        gameLaunchProfile = launch;
        standingAssets = standing;
        battleAssets = battle;
        infantryStandingAssets = infantry;
        accepted = true;
        finish(source);
      } catch (error) {
        if (!finished && !closing && revision === selectionRevision)
          assetStatus.textContent = describeFailure(error);
      } finally {
        if (!accepted)
          try {
            candidateInfantry?.close();
          } catch (error) {
            if (!finished && !closing && revision === selectionRevision)
              assetStatus.textContent = describeFailure(error);
          }
      }
    };
    const modeChanged = () => {
      if (finished || closing) return;
      if (gameFolder.files?.length) return changed();
      selectionRevision++;
      selectionAbort?.abort();
      assetStatus.textContent = selectionPrompt();
    };
    gameFolder.addEventListener('change', changed);
    gameLaunchMode.addEventListener('change', modeChanged);
    window.addEventListener('pagehide', closed, { once: true });
  });
}
function load(core, bytes, fn) {
  const pointer = core._malloc(Math.max(1, bytes.length));
  if (!pointer) throw new Error('Core input allocation failed');
  try {
    core.HEAPU8.set(bytes, pointer);
    if (core[fn](pointer, bytes.length) !== 1)
      throw new Error(core.UTF8ToString(core._openrtw_error()));
  } finally {
    core._free(pointer);
  }
}
function loadAt(core, index, bytes, fn) {
  const pointer = core._malloc(Math.max(1, bytes.length));
  if (!pointer) throw new Error('Core input allocation failed');
  try {
    core.HEAPU8.set(bytes, pointer);
    if (core[fn](index, pointer, bytes.length) !== 1)
      throw new Error(core.UTF8ToString(core._openrtw_error()));
  } finally {
    core._free(pointer);
  }
}
function color(height) {
  if (height < 0) {
    const d = Math.min(1, -height / 1400);
    return [Math.trunc(30 - 15 * d), Math.trunc(100 - 55 * d), Math.trunc(155 - 50 * d), 255];
  }
  const t = Math.min(1, height / 6500);
  return [Math.trunc(76 + 165 * t), Math.trunc(143 + 80 * t), Math.trunc(70 + 155 * t), 255];
}
function vertices(points) {
  const bytes = new Uint8Array(points.length * 28),
    view = new DataView(bytes.buffer);
  points.forEach(([x, y, u, v, color = 0xffffffff], i) => {
    const p = i * 28;
    [x, y, 0, 1].forEach((value, j) => view.setFloat32(p + j * 4, value, true));
    view.setUint32(p + 16, color >>> 0, true);
    view.setFloat32(p + 20, u, true);
    view.setFloat32(p + 24, v, true);
  });
  return bytes;
}
const pageAssetAbort = new AbortController();
const pageInputAbort = new AbortController();
const pageInputOptions = { signal: pageInputAbort.signal };
const coreCleanupErrors = [], terminalCleanupErrors = [];
const coreBundles = createTrustedGameBundleRegistry();
coreBundles.register(romeOriginalBundle, loadRomeOriginalBundle);
const createRomeCoreSession = createTrustedGameBundleSessionFactory({
  registry: coreBundles,
  bundleId: romeOriginalBundle.bundleId,
});
const coreRuntime = createSessionRuntime({
  createSession: createRomeCoreSession,
  // Also retain failures from rejected factories: their records are already
  // retired by the time page cleanup requests its final stop report.
  onError: (error) => { coreCleanupErrors.push(error); },
});
let core,
  renderer,
  campaignScene,
  mapFogTexture,
  campaignLabels,
  campaignHud,
  campaignBuildingAssets,
  closeViewport,
  gameAssets,
  gameLaunchProfile,
  closing = false,
  closeSound,
  campaignStore,
  campaignBattleStore,
  campaignBattleActions,
  checkpointCodec = null,
  createCheckpointActions = null,
  storageCloseTask,
  cleanupTask,
  initializationTask,
  activeWork = null,
  stopTask = null,
  battleDisposeTask = null,
  unitPreview,
  battleView,
  syncCampaignAnimation;
let standingAssets,
  standingPosePreview = false,
  battleAssets,
  battleAssetsPreview = false,
  battleModelAssets = null,
  battleAssetWire = null;
let campaignProductionView;
let settlementRefresh;
let settlementWebModules = null;
let infantryStandingAssets,
  infantryPoseAssets,
  infantryStandingPosePreview = false;
let phase = 'initializing',
  storeFailed = false,
  compoundStoreFailed = false,
  persistenceUnknown = false,
  lastSaved = null,
  refreshControls = () => {},
  refreshCampaignPointer = () => {},
  clearPreview = () => {};
const soundButton = document.querySelector('#play-sound'),
  soundStatus = document.querySelector('#sound-status');
function setPhase(value) {
  phase = value;
  status.dataset.lifecycle = value;
  if (['loading', 'stopping', 'failed', 'closed'].includes(value)) clearPreview();
  refreshControls();
}
function requireOpen() {
  if (closing || pageAssetAbort.signal.aborted)
    throw new Error('OpenRTW page closed during initialization');
}
function disposeBattleForTerminal(view) {
  if (!view) return Promise.resolve();
  if (battleDisposeTask?.view === view) return battleDisposeTask.task;
  let resolve, reject;
  const task = new Promise((yes, no) => { resolve = yes; reject = no; });
  battleDisposeTask = { view, task };
  task.catch(() => {});
  try {
    const disposal = Promise.resolve(view.dispose());
    disposal.then(resolve, reject);
    disposal.catch(() => {});
  } catch (error) { reject(error); }
  return task;
}
function cleanup() {
  if (cleanupTask) return cleanupTask;
  const sound = closeSound,
    oldRenderer = renderer,
    oldPreview = unitPreview,
    oldBattle = battleView,
    oldScene = campaignScene,
    oldHud = campaignHud,
    oldProduction = campaignProductionView,
    oldBuildingAssets = campaignBuildingAssets,
    oldViewport = closeViewport,
    oldInfantryPose = infantryPoseAssets,
    oldInfantrySource = infantryStandingAssets,
    oldLabels = campaignLabels,
    oldMapFog = mapFogTexture;
  let oldBattleDisposal = oldBattle && battleDisposeTask?.view === oldBattle
    ? battleDisposeTask.task : null;
  closeSound =
    renderer =
    core =
    unitPreview =
    battleView =
    campaignScene =
    mapFogTexture =
    campaignLabels =
    campaignHud =
    campaignProductionView =
    campaignBuildingAssets =
    closeViewport =
    infantryPoseAssets =
    infantryStandingAssets =
      undefined;
  // Install the barrier before abort listeners or owner hooks can reenter.
  // Startup owns late renderer/HUD results; drain it before resetting the core.
  cleanupTask = Promise.resolve().then(async () => {
    const failures = [];
    // Hard-stop live settlement refresh before any core/GPU owner is retired.
    // An in-flight asset read keeps its own lease and can no longer publish.
    if (settlementRefresh) {
      try { settlementRefresh.dispose(); } catch (error) { failures.push(describeFailure(error)); }
      settlementRefresh = undefined;
    }
    try {
      await initializationTask;
    } catch (error) {
      failures.push(describeFailure(error));
    }
    try {
      await closeStorage();
    } catch (error) {
      failures.push(describeFailure(error));
    }
    campaignStore = campaignBattleStore = campaignBattleActions = undefined;
    if (oldProduction) try { oldProduction.dispose(); } catch (error) { failures.push(describeFailure(error)); }
    if (oldMapFog)
      try {
        oldMapFog.dispose();
      } catch (error) {
        failures.push(describeFailure(error));
      }
    if (oldLabels) {
      try {
        oldLabels.dispose();
      } catch (error) {
        failures.push(describeFailure(error));
      }
    }
    for (const owner of [oldInfantryPose, oldInfantrySource])
      if (owner) {
        try {
          owner.close();
        } catch (error) {
          failures.push(describeFailure(error));
        }
      }
    if (oldViewport) {
      try {
        oldViewport();
      } catch (error) {
        failures.push(describeFailure(error));
      }
    }
    if (oldHud) {
      try {
        oldHud.dispose();
      } catch (error) {
        failures.push(describeFailure(error));
      }
    }
    if (oldBuildingAssets) {
      try {
        oldBuildingAssets.dispose();
      } catch (error) {
        failures.push(describeFailure(error));
      }
    }
    if (oldBattle) {
      try {
        await (oldBattleDisposal ?? oldBattle.dispose());
      } catch (error) {
        failures.push(describeFailure(error));
      }
    }
    if (oldPreview) {
      try {
        await oldPreview.dispose();
      } catch (error) {
        failures.push(describeFailure(error));
      }
    }
    if (oldScene) {
      try {
        oldScene.dispose();
      } catch (error) {
        failures.push(describeFailure(error));
      }
    }
    if (sound) {
      try {
        await sound();
      } catch (error) {
        failures.push(describeFailure(error));
      }
    }
    if (oldRenderer) {
      try {
        oldRenderer.dispose();
      } catch (error) {
        failures.push(describeFailure(error));
      }
    }
    // Retire all presentation callbacks first; then invalidate/drain core
    // factories and reset the module exactly once through its title adapter.
    // This also owns a WASM result that arrives after pagehide/failed startup.
    try {
      const report = await coreRuntime.dispose();
      for (const error of new Set([...coreCleanupErrors, ...report.errors]))
        failures.push(describeFailure(error));
    } catch (error) {
      failures.push(describeFailure(error));
    }
    gameAssets = standingAssets = battleAssets = undefined;
    gameLaunchProfile = undefined;
    delete status.dataset.gameProfile;
    delete status.dataset.saveProfile;
    delete status.dataset.campaignBattleSaveProfile;
    delete status.dataset.coreSession;
    battleModelAssets = battleAssetWire = null;
    delete canvas.dataset.standingPose;
    delete canvas.dataset.battleAssets;
    return [...terminalCleanupErrors, ...failures];
  });
  pageInputAbort.abort();
  pageAssetAbort.abort(new DOMException('OpenRTW asset session closed', 'AbortError'));
  refreshControls = refreshCampaignPointer = clearPreview = () => {};
  syncCampaignAnimation = undefined;
  if (!oldBattleDisposal && oldBattle?.active)
    oldBattleDisposal = disposeBattleForTerminal(oldBattle);
  return cleanupTask;
}
function disableControls() {
  for (const control of [
    reset,
    factionSelect,
    layer,
    characterSelect,
    centerButton,
    cancelButton,
    moveButton,
    factionJourneyButton,
    endTurnButton,
    soundButton,
    saveButton,
    loadButton,
    compoundSaveButton,
    compoundLoadButton,
    stopButton,
    battleOpponent,
    battleButton,
    settlementSelect,
    clearSettlement,
  ])
    control.disabled = true;
}
function storageFailure(error) {
  storeFailed = true;
  saveStatus.textContent = `Campaign storage failed: ${describeFailure(error)}`;
  saveStatus.dataset.state = 'error';
  refreshControls();
}
function compoundStorageFailure(error) {
  compoundStoreFailed = true;
  compoundSaveStatus.textContent = `Campaign and battle checkpoint storage failed: ${describeFailure(error)}`;
  compoundSaveStatus.dataset.state = 'error';
  refreshControls();
}
function closeStorage() {
  const stores = [campaignStore, campaignBattleStore].filter(Boolean);
  if (!stores.length) return storageCloseTask ?? Promise.resolve();
  if (!storageCloseTask) {
    storageCloseTask = Promise.resolve().then(async () => {
      const pending = stores.map((store) => {
        try { return Promise.resolve(store.close()); }
        catch (error) { return Promise.reject(error); }
      });
      for (const task of pending) task.catch(() => {});
      const failures = (await Promise.allSettled(pending))
        .filter((result) => result.status === 'rejected')
        .map((result) => result.reason);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1)
        throw new AggregateError(failures, 'Campaign storage close failed');
    });
  }
  return storageCloseTask;
}
function terminalUpdate(publish) {
  try { publish(); return true; }
  catch (error) { terminalCleanupErrors.push(describeFailure(error)); return false; }
}
function fail(error) {
  if (closing) return; // A terminal close/failure already owns the page.
  closing = true;
  terminalUpdate(() => setPhase('failed'));
  terminalUpdate(() => { status.dataset.ready = 'false'; });
  terminalUpdate(disableControls);
  terminalUpdate(() => { campaignShell.hidden = false; });
  if (!terminalUpdate(() => { errorBox.textContent = describeFailure(error); }))
    terminalCleanupErrors.push(describeFailure(error));
  terminalUpdate(() => { status.textContent = 'OpenRTW could not continue this campaign prototype.'; });
  cleanup().then((failures) => {
    if (failures.length) terminalUpdate(() => { errorBox.textContent += '\n' + failures.join('\n'); });
  });
}
window.addEventListener(
  'pagehide',
  () => {
    closing = true;
    terminalUpdate(() => setPhase('closed'));
    terminalUpdate(() => { status.dataset.ready = 'false'; });
    terminalUpdate(disableControls);
    cleanup().then((failures) => {
      if (failures.length) terminalUpdate(() => { errorBox.textContent += '\n' + failures.join('\n'); });
    });
  },
  { once: true, signal: pageInputAbort.signal }
);
window.addEventListener('pageshow', (event) => {
  if (event.persisted) location.reload();
});
// The audio module owns its own async button state; this admission guard also
// applies if it finishes playback while a campaign operation is pending.
soundButton.addEventListener(
  'click',
  (event) => {
    if (phase !== 'running' || closing || battleView?.active) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  },
  { capture: true, signal: pageInputAbort.signal }
);

// Schedule only after the startup barrier is published, including synchronous
// host callbacks during selection. Failure handlers never await their own drain.
initializationTask = Promise.resolve().then(async () => {
try {
  let chosenAssets = await chooseGameAssets();
  try {
    requireOpen();
    gameAssets = createAssetReadScope(chosenAssets, { signal: pageAssetAbort.signal });
  } finally { chosenAssets = null; }
  status.dataset.gameProfile = JSON.stringify({
    ...gameLaunchProfile.identity,
    verification: gameLaunchProfile.verification,
  });
  const openedSession = await coreRuntime.create(gameLaunchProfile.identity);
  if (closing || !openedSession.isActive()) {
    await coreRuntime.dispose();
    throw new Error('OpenRTW page closed before core initialization completed');
  }
  core = openedSession.module.core;
  status.dataset.coreSession = JSON.stringify({
    generation: openedSession.generation,
    bundleId: romeOriginalBundle.bundleId,
    ...openedSession.identity,
    contract: openedSession.module.contract,
  });
  const [
    terrainBytes,
    campaignBytes,
    definitionBytes,
    mapBytes,
    groundBytes,
    climateDefinitionBytes,
    climateMapBytes,
    pcmBytes,
  ] = await Promise.all([
    asset('terrain', '/assets/terrain.hgt'),
    asset('campaign', '/assets/campaign.txt'),
    asset('regions', '/assets/regions.txt'),
    asset('regionMap', '/assets/regions.tga'),
    asset('groundMap', '/assets/ground.tga'),
    asset('climates', '/assets/climates.txt'),
    asset('climateMap', '/assets/climates.tga'),
    asset('pcm', '/assets/marching.wav'),
  ]);
  const [unitDefinitionBytes, battleModelBytes] = await Promise.all([
    asset('unitDefinitions', '/assets/units.txt'),
    asset('battleModels', '/assets/battle-models.txt'),
  ]);
  requireOpen();
  load(core, pcmBytes, '_openrtw_load_pcm');
  closeSound = attachSound(core, soundButton, soundStatus);
  load(core, terrainBytes, '_openrtw_load_terrain');
  load(core, campaignBytes, '_openrtw_load_campaign');
  load(core, unitDefinitionBytes, '_openrtw_load_unit_definitions');
  load(core, battleModelBytes, '_openrtw_load_battle_models');
  const catalog = JSON.parse(core.UTF8ToString(core._openrtw_battle_catalog_json()));
  if (catalog.unitDefinitions !== 265 || catalog.modelDefinitions !== 211)
    throw new Error('Unit catalog disagrees with the loaded source corpus');
  load(core, definitionBytes, '_openrtw_load_regions');
  load(core, mapBytes, '_openrtw_load_region_map');
  load(core, groundBytes, '_openrtw_load_ground_map');
  load(core, climateDefinitionBytes, '_openrtw_load_climates');
  load(core, climateMapBytes, '_openrtw_load_climate_map');
  if (core._openrtw_build_climate_coefficients() !== 1)
    throw new Error(core.UTF8ToString(core._openrtw_error()));
  if (core._openrtw_build_categories() !== 1)
    throw new Error(core.UTF8ToString(core._openrtw_error()));
  if (core._openrtw_build_point_categories() !== 1)
    throw new Error(core.UTF8ToString(core._openrtw_error()));
  if (core._openrtw_build_world_grid() !== 1)
    throw new Error(core.UTF8ToString(core._openrtw_error()));
  const width = core._openrtw_terrain_width(),
    height = core._openrtw_terrain_height(),
    count = core._openrtw_terrain_count();
  if (count !== width * height) throw new Error('Core terrain dimensions disagree');
  const pointer = core._openrtw_terrain_bits();
  const words = core.HEAPU8.slice(pointer, pointer + count * 4),
    heights = new DataView(words.buffer);
  const campaign = JSON.parse(core.UTF8ToString(core._openrtw_campaign_json()));
  const settlementRows = campaign.factions.flatMap((f, fi) =>
    f.settlements.map((s, si) => ({
      ...s,
      sourceFaction: f.id,
      sourceFactionIndex: fi,
      sourceSettlementIndex: si,
      sourceFactionLine: f.line,
    }))
  );
  settlementRows.forEach((s, id) => {
    const option = document.createElement('option');
    option.value = String(id);
    option.textContent = `${s.region} · ${s.sourceFaction}`;
    settlementSelect.append(option);
  });
  const settlementsByRegion = new Map(
    campaign.factions.flatMap((f) =>
      f.settlements.map((s) => [s.region, { ...s, sourceSection: f.id }])
    )
  );
  const settlementVisible = (region) => {
    const anchor = settlementLabels.find((row) => row.region === region);
    return Boolean(anchor && fog.labelVisible(anchor.x, anchor.y));
  };
  const settlementDetails = (region) => {
    const s = settlementsByRegion.get(region);
    return s && settlementVisible(region)
      ? `\n\nInitial settlement record\n${s.level} · population ${s.population}\nFounded ${s.yearFounded} · plan ${s.planSet}\nFaction section ${s.sourceSection}\nCreator field ${s.factionCreator}\n${s.buildingRecords} building records · source line ${s.line}`
      : '';
  };
  const regionWidth = core._openrtw_region_map_width(),
    regionHeight = core._openrtw_region_map_height(),
    regionBytes = core._openrtw_region_map_bytes(),
    regionPointer = core._openrtw_region_map_rgb();
  if (
    regionBytes !== regionWidth * regionHeight * 3 ||
    width !== 2 * regionWidth + 1 ||
    height !== 2 * regionHeight + 1
  )
    throw new Error('Region and terrain grids disagree with the retained bootstrap layout');
  const regionRgb = core.HEAPU8.slice(regionPointer, regionPointer + regionBytes),
    regionData = JSON.parse(core.UTF8ToString(core._openrtw_regions_json()));
  const world = JSON.parse(core.UTF8ToString(core._openrtw_world_grid_json())),
    worldCount = core._openrtw_world_grid_count(),
    worldPointer = core._openrtw_world_grid_indices();
  if (
    world.width !== regionWidth ||
    world.height !== regionHeight ||
    worldCount !== regionWidth * regionHeight
  )
    throw new Error('Derived world grid dimensions disagree');
  const worldBytes = core.HEAPU8.slice(worldPointer, worldPointer + worldCount * 4),
    worldView = new DataView(worldBytes.buffer);
  const worldIndices = Array.from({ length: worldCount }, (_, i) =>
    worldView.getUint32(i * 4, true)
  );
  if (worldIndices.some((i) => i >= world.palette.length))
    throw new Error('World cell references an invalid palette entry');
  const settlements = buildTownBindings(campaign, regionData, world, worldIndices);
  const settlementLabels = buildSettlementLabelBindings(campaign, regionData, world, worldIndices);
  const categoryCount = core._openrtw_category_count(),
    categoryPointer = core._openrtw_category_ids();
  if (
    core._openrtw_category_width() !== regionWidth ||
    core._openrtw_category_height() !== regionHeight ||
    categoryCount !== worldCount
  )
    throw new Error('Ground categories disagree with the world dimensions');
  const categoryBytes = core.HEAPU8.slice(categoryPointer, categoryPointer + categoryCount * 4),
    categoryView = new DataView(categoryBytes.buffer);
  const categoryIds = Array.from({ length: categoryCount }, (_, i) =>
    categoryView.getUint32(i * 4, true)
  );
  if (categoryIds.some((i) => i > 14)) throw new Error('Invalid ground category ID');
  const climateData = JSON.parse(core.UTF8ToString(core._openrtw_climates_json())),
    climateCount = core._openrtw_climate_count();
  if (
    core._openrtw_climate_width() !== regionWidth ||
    core._openrtw_climate_height() !== regionHeight ||
    climateCount !== worldCount
  )
    throw new Error('Climate coefficients disagree with the world dimensions');
  const climatePointer = core._openrtw_climate_coefficient_bits(),
    climateIdPointer = core._openrtw_climate_source_ids();
  const climateBytes = core.HEAPU8.slice(climatePointer, climatePointer + climateCount * 4),
    climateView = new DataView(climateBytes.buffer);
  const climateIds = core.HEAPU8.slice(climateIdPointer, climateIdPointer + climateCount);
  if (climateIds.some((id) => id >= climateData.definitions.length))
    throw new Error('Invalid climate definition ID');
  const climateDetails = (x, y) => {
    const i = y * regionWidth + x,
      d = climateData.definitions[climateIds[i]];
    return `\nClimate ${d.name}\nSource heat selector ${d.heat} · coefficient ${climateView.getFloat32(i * 4, true).toFixed(1)}\nClimate source line ${d.definitionLine}`;
  };
  const key = (rgb) => (rgb[0] << 16) | (rgb[1] << 8) | rgb[2],
    regionsByColor = new Map(regionData.definitions.map((r) => [key(r.rgb), r]));
  const rgba = new Uint8Array(count * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      rgba.set(
        color(heights.getFloat32((y * width + x) * 4, true)),
        ((height - 1 - y) * width + x) * 4
      );
  const openedRenderer = await createRendererBridge({
    moduleFactory: createRenderer,
    canvas,
    width: canvas.width,
    height: canvas.height,
  });
  if (closing) {
    openedRenderer.dispose();
    throw new Error('OpenRTW page closed before renderer initialization completed');
  }
  renderer = openedRenderer;
  function fitViewport() {
    if (closing || !renderer) return;
    const stage = document.querySelector('#campaign-stage'),
      w = Math.max(1, Math.min(4096, Math.round(stage.clientWidth))),
      h = Math.max(1, Math.min(4096, Math.round(stage.clientHeight)));
    if (canvas.width !== w || canvas.height !== h) {
      renderer.setRenderTarget(0, { depth: 'primary', resetViewport: true });
      renderer.resize(w, h);
    }
  }
  fitViewport();
  const texture = renderer.createTexture({ width, height, levels: 1, format: TextureFormat.RGBA8 });
  renderer.uploadTexture(texture, 0, rgba, { rowPitch: width * 4 });
  const regionRgba = new Uint8Array(regionWidth * regionHeight * 4);
  for (let i = 0; i < regionWidth * regionHeight; i++)
    regionRgba.set([...regionRgb.subarray(i * 3, i * 3 + 3), 255], i * 4);
  const regionTexture = renderer.createTexture({
    width: regionWidth,
    height: regionHeight,
    levels: 1,
    format: TextureFormat.RGBA8,
  });
  renderer.uploadTexture(regionTexture, 0, regionRgba, { rowPitch: regionWidth * 4 });
  const worldRgba = new Uint8Array(regionWidth * regionHeight * 4);
  for (let y = 0; y < regionHeight; y++)
    for (let x = 0; x < regionWidth; x++)
      worldRgba.set(
        [...world.palette[worldIndices[(regionHeight - 1 - y) * regionWidth + x]], 255],
        4 * (y * regionWidth + x)
      );
  const worldTexture = renderer.createTexture({
    width: regionWidth,
    height: regionHeight,
    levels: 1,
    format: TextureFormat.RGBA8,
  });
  renderer.uploadTexture(worldTexture, 0, worldRgba, { rowPitch: regionWidth * 4 });
  renderer.setFvf(Fvf.XYZRHW | Fvf.DIFFUSE | Fvf.TEX1);
  renderer.setMaterialLighting({ enabled: false });
  renderer.setDirectionalLighting({ enabled: false });
  for (const state of [
    RenderState.ZENABLE,
    RenderState.ZWRITEENABLE,
    RenderState.ALPHATESTENABLE,
    RenderState.ALPHABLENDENABLE,
    RenderState.FOGENABLE,
    RenderState.SPECULARENABLE,
  ])
    renderer.setRenderState(state, 0);
  renderer.setRenderState(RenderState.CULLMODE, 1);
  renderer.setStageState(1, StageState.COLOROP, TextureOp.DISABLE);
  renderer.setStageState(0, StageState.ALPHAOP, TextureOp.SELECTARG1);
  renderer.setStageState(0, StageState.ALPHAARG1, TextureArg.TEXTURE);
  for (const state of [StageState.ADDRESSU, StageState.ADDRESSV])
    renderer.setStageState(0, state, Address.CLAMP);
  for (const state of [StageState.MAGFILTER, StageState.MINFILTER])
    renderer.setStageState(0, state, Filter.POINT);
  renderer.setStageState(0, StageState.MIPFILTER, Filter.NONE);
  const meshBytes = await asset('hastati', '/assets/hastati.cas');
  requireOpen();
  load(core, meshBytes, '_openrtw_load_cas_mesh');
  const meshPointer = core._openrtw_cas_mesh_json();
  if (!meshPointer) throw new Error('Original unit model is unavailable.');
  const unitGeometry = createUnitGeometry(JSON.parse(core.UTF8ToString(meshPointer, 1024 * 1024)));
  const unitTextureBytes = await asset('hastatiTexture', '/assets/hastati-texture.dds');
  requireOpen();
  const unitTexture = await loadUnitTexture(core, unitTextureBytes, { isOpen: () => !closing });
  requireOpen();
  const [generalBytes, generalTextureBytes] = await Promise.all([
    asset('campaignGeneral', '/assets/campaign-general.cas'),
    asset('campaignGeneralTexture', '/assets/campaign-general-texture.dds'),
  ]);
  requireOpen();
  let generalModel = await loadCampaignGeneral(core, generalBytes, generalTextureBytes, {
    isOpen: () => !closing,
  });
  requireOpen();
  let standingPose = null;
  if (standingPosePreview) {
    const { loadCampaignIdlePose } = await import('/campaign-idle-pose.js');
    requireOpen();
    const posed = await loadCampaignIdlePose(core, generalModel, standingAssets, {
      isOpen: () => !closing,
      signal: pageAssetAbort.signal,
    });
    requireOpen();
    generalModel = posed.model;
    standingPose = posed.status;
  }
  if (standingPosePreview) {
    const { loadCampaignWalkingPose } = await import('/campaign-walking-pose.js');
    requireOpen();
    const walking = await loadCampaignWalkingPose(core, generalModel, standingAssets, {
      isOpen: () => !closing,
      signal: pageAssetAbort.signal,
    });
    requireOpen();
    generalModel = walking.model;
    status.dataset.walkingPose = JSON.stringify(walking.status);
  }
  const [townBytes, townTextureBytes] = await Promise.all([
    asset('romanLargeTown', '/assets/roman-large-town.cas'),
    asset('romanLargeTownTexture', '/assets/roman-large-town-texture.dds'),
  ]);
  requireOpen();
  const townAssets = await loadTownAssets(core, townBytes, townTextureBytes, {
    isOpen: () => !closing,
  });
  requireOpen();
  if (battleAssetsPreview) {
    const { loadBattleAssets } = await import('/battle-assets.js');
    requireOpen();
    if (!battleAssets)
      throw new Error('Battle model preview requires the selected original battle sources.');
    if (infantryStandingPosePreview) {
      const { createBorrowedInfantryStandingPoseAssets } = await import(
        '/infantry-standing-pose-assets.js'
      );
      requireOpen();
      if (!infantryStandingAssets)
        throw new Error('Infantry poses require the selected original animations and skeletons.');
      infantryPoseAssets = createBorrowedInfantryStandingPoseAssets(core, infantryStandingAssets, {
        isOpen: () => !closing && Boolean(core),
      });
    }
    const keys = [
      'romans_julii:roman_archer',
      'romans_brutii:roman_archer',
      'romans_julii:roman_triarii',
      'romans_brutii:roman_triarii',
      'romans_julii:roman_velite',
      'romans_brutii:roman_velite',
    ];
    const loaded = await loadBattleAssets(
      core,
      (name, options) => battleAssets.read(name, options),
      {
        keys,
        isOpen: () => !closing,
        poseAssets: infantryPoseAssets ?? null,
        signal: pageAssetAbort.signal,
      }
    );
    requireOpen();
    const wire = JSON.stringify({
      schema: 'openrtw-battle-assets-preview-v1',
      meaning: infantryStandingPosePreview
        ? 'source-bound-frame-zero-presentation;native-binding-unproved'
        : 'source-bound-static-presentation;native-binding-unproved',
      requestedKeys: keys,
      bindings: keys.map((key) => {
        const entry = loaded[key];
        return {
          key,
          status: entry.status,
          ...(entry.status === 'available'
            ? {
                parts: entry.parts.map((part) => ({
                  role: part.role,
                  sourceSha256: part.sourceSha256,
                  textureSourceSha256: part.textureSourceSha256,
                  vertices: part.geometry.vertices.length / 24,
                  triangles: part.geometry.indexBytes.length / 6,
                  ...(entry.standingPose ? { standingPose: entry.standingPose } : {}),
                })),
              }
            : { reason: entry.reason }),
        };
      }),
    });
    if (wire.length > 8192) throw new Error('Battle model preview diagnostics exceed their bound.');
    battleModelAssets = loaded;
    battleAssetWire = wire;
  }
  const [grassBytes, hillsBytes] = await Promise.all([
    asset('terrainGrass', '/assets/terrain-grass.tga'),
    asset('terrainHills', '/assets/terrain-hills.tga'),
  ]);
  requireOpen();
  const terrainTextures = {
    grass: createTerrainTexture(decodeTgaTexture(grassBytes), {
      sourceSha256: inputPins.terrainGrass,
      label: 'grass',
    }),
    hills: createTerrainTexture(decodeTgaTexture(hillsBytes), {
      sourceSha256: inputPins.terrainHills,
      label: 'hills',
    }),
  };
  const waterBytes = await asset('terrainWater', '/assets/terrain-water.dds');
  requireOpen();
  let surfInput = null;
  try {
    surfInput = await gameAssets.read('campaignWaterSurf');
  } catch (error) {
    requireOpen();
    if (error?.name === 'AbortError') throw error;
  }
  const waterTexture = await loadWaterTexture(core, waterBytes, {
    isOpen: () => !closing,
    surfInput,
  });
  requireOpen();
  status.dataset.waterSurf = JSON.stringify(waterTexture.surf ?? { state: 'unavailable' });
  // Native aerial ground compositor (optional). Any missing/refused input logs
  // its reason and keeps the grass/hills presentation; closing still aborts.
  function readAerialGround() {
    const pointer = core._openrtw_aerial_ground_json();
    if (!pointer)
      throw new Error(
        core.UTF8ToString(core._openrtw_error()) || 'Core aerial ground report is unavailable'
      );
    const limit = 64 * 1024,
      wire = core.UTF8ToString(pointer, limit + 1);
    if (wire.length > limit) throw new Error('Core aerial ground report exceeds its bound');
    const value = JSON.parse(wire);
    if (
      value?.schema !== 'openrtw-aerial-ground-v1' ||
      !Array.isArray(value.textures) ||
      !Array.isArray(value.climates) ||
      value.climates.length !== climateData.definitions.length ||
      !Number.isInteger(value.patterns) ||
      value.patterns < 0 ||
      value.patterns > 7 ||
      typeof value.ready !== 'boolean' ||
      value.pageCells !== 32 ||
      value.pageTexels !== 1024 ||
      !Number.isInteger(value.pagesX) ||
      !Number.isInteger(value.pagesY) ||
      !Array.isArray(value.seasonalPages) ||
      value.seasonalPages.some((flag) => typeof flag !== 'boolean') ||
      value.seasonalPages.length !== (value.ready ? value.pagesX * value.pagesY : 0)
    )
      throw new Error('Core aerial ground report is invalid');
    value.textures.forEach((t, i) => {
      if (
        t?.index !== i ||
        typeof t.name !== 'string' ||
        !Number.isInteger(t.side) ||
        t.side < 0 ||
        t.side > 4096
      )
        throw new Error('Core aerial texture registry is invalid');
    });
    value.climates.forEach((c, i) => {
      if (
        c?.index !== i ||
        c.name !== climateData.definitions[i].name ||
        typeof c.block !== 'string' ||
        typeof c.winter !== 'boolean'
      )
        throw new Error('Core aerial climate binding is invalid');
    });
    return value;
  }
  // Optional native aerial decals (settlement/fort/port/watchtower underlays and
  // the flattened HGT points around them), fed to the core before the
  // compositor is built. Any missing/refused input logs its reason and keeps
  // the plain ground and the raw heights; closing still aborts.
  async function loadAerialDecals(images) {
    try {
      return await feedAerialDecals({
        core,
        readAsset: (name) => asset(name, null),
        assetName: aerialBaseAssetName,
        terrainWidth: width,
        terrainHeight: height,
        images,
        requireOpen,
      });
    } catch (error) {
      if (closing || error?.name === 'AbortError') throw error;
      const reason = String(error?.message ?? error);
      console.warn('OpenRTW aerial decals skipped:', reason);
      return {
        records: 0,
        flattened: null,
        wire: {
          schema: 'openrtw-aerial-decals-status-v1',
          state: 'fallback',
          fallback: 'no-decals-raw-heights',
          reason,
        },
      };
    }
  }
  async function loadAerialTerrain() {
    let decals = null;
    try {
      const exports = [
        '_openrtw_load_aerial_ground_types',
        '_openrtw_aerial_ground_json',
        '_openrtw_load_aerial_ground_texture',
        '_openrtw_load_aerial_weight_pattern',
        '_openrtw_build_aerial_compositor',
        '_openrtw_compose_aerial_page',
        '_openrtw_aerial_page_pixels',
        '_openrtw_aerial_page_bytes',
        '_openrtw_compose_aerial_tile',
        '_openrtw_aerial_tile_pixels',
      ].filter((name) => typeof core[name] !== 'function');
      if (exports.length)
        throw new Error(
          'This core build lacks the aerial compositor exports: ' + exports.join(', ')
        );
      // Only the ground inputs gate the compositor; decal inputs degrade on their own.
      const described = gameAssets.describe(),
        groundPaths = new Set(aerialGroundAssetPaths),
        missing = (described.optionalMissingPaths ?? []).filter((path) => groundPaths.has(path)),
        rejected = (described.optionalRejected ?? []).filter((entry) =>
          groundPaths.has(entry?.path)
        );
      if (missing.length)
        throw new Error(
          'Missing aerial ground files: ' +
            missing.join(', ') +
            (rejected.length
              ? '; rejected: ' + rejected.map((r) => `${r.path} (${r.reason})`).join(', ')
              : '')
        );
      const descriptorBytes = await asset('aerialGroundTypes', '/assets/aerial/ground-types.txt');
      requireOpen();
      load(core, descriptorBytes, '_openrtw_load_aerial_ground_types');
      const registry = readAerialGround();
      // The pinned descriptor yields the 17-name vanilla registry; every name
      // must be one of the pinned ground textures (lower-case .tga basenames).
      if (registry.textures.length !== 17)
        throw new Error(
          `Aerial texture registry has ${registry.textures.length} names, expected the 17 pinned textures`
        );
      const textureAssets = registry.textures.map(({ name }) => {
        const lower = name.toLowerCase(),
          key = /^[a-z0-9_]+\.tga$/.test(lower) ? 'aerialTexture_' + lower.slice(0, -4) : null;
        if (!key || !Object.hasOwn(inputPins, key))
          throw new Error(
            `Aerial ground texture "${name}" is not one of the 17 pinned ground textures`
          );
        return key;
      });
      const [textureBytes, weightBytes] = await Promise.all([
        Promise.all(textureAssets.map((name) => asset(name, null))),
        Promise.all(Array.from({ length: 7 }, (_, i) => asset(`aerialWeight${i + 1}`, null))),
      ]);
      requireOpen();
      textureBytes.forEach((bytes, index) =>
        loadAt(core, index, bytes, '_openrtw_load_aerial_ground_texture')
      );
      weightBytes.forEach((bytes, slot) =>
        loadAt(core, slot, bytes, '_openrtw_load_aerial_weight_pattern')
      );
      // The compositor takes the decal records that exist when it is built.
      decals = await loadAerialDecals(true);
      requireOpen();
      if (core._openrtw_build_aerial_compositor() !== 1)
        throw new Error(
          core.UTF8ToString(core._openrtw_error()) || 'Core refused the aerial compositor'
        );
      const ready = readAerialGround(),
        pagesX = Math.ceil(regionWidth / 32),
        pagesY = Math.ceil(regionHeight / 32);
      if (
        !ready.ready ||
        ready.patterns !== 7 ||
        ready.textures.length !== 17 ||
        ready.textures.some((t) => !t.side) ||
        ready.pagesX !== pagesX ||
        ready.pagesY !== pagesY
      )
        throw new Error('Core aerial compositor report disagrees with the loaded inputs');
      // One composed tile proves the call path before the scene relies on it.
      const tx = Math.min(89, regionWidth - 1),
        ty = Math.min(82, regionHeight - 1);
      if (core._openrtw_compose_aerial_tile(tx, ty, 0) !== 1)
        throw new Error(core.UTF8ToString(core._openrtw_error()) || 'Core refused an aerial tile');
      const tilePointer = core._openrtw_aerial_tile_pixels() >>> 0,
        tileHeap = core.HEAPU8;
      if (!tilePointer || tilePointer > tileHeap.length - 4096)
        throw new Error('Core aerial tile span is invalid');
      const tile = tileHeap.slice(tilePointer, tilePointer + 4096);
      if (!tile.every((value, i) => i % 4 !== 3 || value === 255))
        throw new Error('Core aerial tile is not opaque');
      const composePage = (pageX, pageY, winter) => {
        const owner = core;
        if (closing || !owner) throw new Error('Aerial compositor is closed');
        if (owner._openrtw_compose_aerial_page(pageX, pageY, winter ? 1 : 0) !== 1)
          throw new Error(
            owner.UTF8ToString(owner._openrtw_error()) || 'Core refused an aerial page'
          );
        const pointer = owner._openrtw_aerial_page_pixels() >>> 0,
          bytes = owner._openrtw_aerial_page_bytes() >>> 0,
          heap = owner.HEAPU8;
        if (!pointer || bytes !== 1024 * 1024 * 4 || pointer > heap.length - bytes)
          throw new Error('Core aerial page span is invalid');
        return heap.slice(pointer, pointer + bytes); // Owned copy before any later core call.
      };
      // seasonalPages: pages whose summer/winter bytes differ; the scene keeps
      // the other pages' textures across a season change.
      return {
        terrain: createAerialTerrain({
          pageCells: 32,
          pageTexels: 1024,
          pagesX,
          pagesY,
          composePage,
          season: 'summer',
          seasonalPages: ready.seasonalPages,
        }),
        wire: {
          schema: 'openrtw-aerial-terrain-status-v1',
          state: 'active',
          policy: 'openrtw-native-aerial-tiles-v1',
          textures: ready.textures.length,
          patterns: ready.patterns,
          pagesX,
          pagesY,
          seasonalPages: ready.seasonalPages.filter(Boolean).length,
          winterClimates: ready.climates.filter((c) => c.winter).length,
          defaultBlocks: ready.climates.filter((c) => c.block === 'default').length,
          descriptorSha256: inputPins.aerialGroundTypes,
          decals: decals.wire,
        },
        heightOverrides: decals.flattened,
      };
    } catch (error) {
      if (closing || error?.name === 'AbortError') throw error;
      const reason = String(error?.message ?? error);
      console.warn('OpenRTW aerial terrain fallback:', reason);
      // Flattening is a terrain rule, not a texture: it still shapes the
      // grass/hills presentation (no decal images are read for it).
      decals ??= await loadAerialDecals(false);
      return {
        terrain: null,
        wire: {
          schema: 'openrtw-aerial-terrain-status-v1',
          state: 'fallback',
          fallback: 'grass-hills-presentation',
          reason,
          decals: decals.wire,
        },
        heightOverrides: decals.flattened,
      };
    }
  }
  const aerialState = await loadAerialTerrain();
  requireOpen();
  let settlementModels = null;
  try {
    const [settlementAssetsModule, settlementModelsModule, shadowSceneModule] = await Promise.all([
      import('/settlement-model-assets.js'),
      import('/campaign-settlement-models.js'),
      import('/campaign-shadow-scene.js'),
    ]);
    const { loadSettlementModelAssets, refreshSettlementModelAssets } = settlementAssetsModule;
    const { createCampaignSettlementModels } = settlementModelsModule;
    const { createCampaignShadowScene } = shadowSceneModule;
    settlementWebModules = {
      refreshSettlementModelAssets,
      createCampaignSettlementModels,
      createCampaignShadowScene,
    };
    requireOpen();
    // Shadow volumes are optional inventory: an immutable core without the
    // exports records them as unavailable and keeps the campaign rendering.
    const assets = await loadSettlementModelAssets(core, gameAssets, {
      isOpen: () => !closing,
      collectShadows: true,
    });
    requireOpen();
    settlementModels = {
      ...assets,
      create: (renderer) => createCampaignSettlementModels({ renderer, assets }),
      createShadows: (renderer, townOwner) =>
        createCampaignShadowScene({
          renderer,
          townOwner,
          volumes: assets.shadowVolumes,
          assetStatus: assets.shadowStatus,
        }),
      onFailure: (reason) => {
        status.dataset.settlementModels = JSON.stringify({ state: 'fallback', reason });
      },
    };
    status.dataset.settlementModels = JSON.stringify({
      state: 'active',
      settlements: assets.placement.settlementCount,
      ports: assets.placement.portCount,
      developedPorts: assets.placement.developedPortCount,
      fishingVillages: assets.placement.fishingVillageCount,
      banners: assets.placement.bannerCount,
      garrisonBannersPending: assets.placement.garrisonBannerCount,
      models: assets.models.size,
      textures: assets.textures.size,
      shadows: {
        state: assets.shadowStatus.state,
        models: assets.shadowStatus.models,
        variants: assets.shadowStatus.variants,
        skipped: assets.shadowStatus.skippedCount,
      },
      problems: assets.placement.problems,
    });
  } catch (error) {
    requireOpen();
    // Optional model files retain the previous source-bound two-town preview.
    status.dataset.settlementModels = JSON.stringify({
      state: 'fallback',
      reason: String(error.message || error),
    });
  }
  let coastline = null,
    campaignTrees = null,
    campaignBanners = null;
  try {
    const [
      { loadCoastlineTexture },
      { createCampaignCoastline, campaignCoastlineLighting, parseCampaignCoastlineFeatures },
      { settlementLighting },
    ] = await Promise.all([
      import('/coastline-texture.js'),
      import('/campaign-coastline.js'),
      import('/settlement-model-assets.js'),
    ]);
    requireOpen();
    const [bytes, lightingBytes, featureBytes] = await Promise.all([
      gameAssets.read('campaignCoastline'),
      gameAssets.read('settlementLighting'),
      gameAssets.read('campaignFogFeatures'),
    ]);
    requireOpen();
    const lighting = campaignCoastlineLighting(settlementLighting(lightingBytes)),
      features = parseCampaignCoastlineFeatures(featureBytes, regionWidth, regionHeight);
    const texture = await loadCoastlineTexture(core, bytes, { isOpen: () => !closing, lighting });
    requireOpen();
    coastline = {
      ...texture,
      buildGeometry: (inputs) =>
        createCampaignCoastline({ ...inputs, lighting, alphaAt: features.alphaAt }),
    };
    status.dataset.coastline = JSON.stringify({
      state: 'active',
      sourceSha256: texture.sourceSha256,
      lighting: lighting.metadata,
      features: features.metadata,
    });
  } catch (error) {
    if (closing || error?.name === 'AbortError') throw error;
    status.dataset.coastline = JSON.stringify({
      state: 'fallback',
      reason: String(error.message || error),
    });
  }
  try {
    const [{ loadCampaignTreeAssets }, { createCampaignTrees }] = await Promise.all([
      import('/campaign-tree-assets.js'),
      import('/campaign-trees.js'),
    ]);
    requireOpen();
    const assets = await loadCampaignTreeAssets(core, gameAssets, { isOpen: () => !closing });
    requireOpen();
    campaignTrees = {
      create: ({ renderer, fog }) => createCampaignTrees({ renderer, assets, fog }),
    };
    status.dataset.trees = JSON.stringify({
      state: 'active',
      models: assets.models.size,
      summer: assets.scenes.summer.models.length,
      winter: assets.scenes.winter.models.length,
    });
  } catch (error) {
    if (closing || error?.name === 'AbortError') throw error;
    status.dataset.trees = JSON.stringify({
      state: 'fallback',
      reason: String(error.message || error),
    });
  }
  try {
    const [{ loadCampaignBannerAssets }, { createCampaignBanners }] = await Promise.all([
      import('/campaign-banner-assets.js'),
      import('/campaign-banners.js'),
    ]);
    requireOpen();
    const assets = await loadCampaignBannerAssets(core, gameAssets, { isOpen: () => !closing });
    requireOpen();
    campaignBanners = { create: ({ renderer }) => createCampaignBanners({ renderer, assets }) };
    status.dataset.banners = JSON.stringify({ state: 'active', ...assets.metadata });
  } catch (error) {
    if (closing || error?.name === 'AbortError') throw error;
    status.dataset.banners = JSON.stringify({
      state: 'fallback',
      reason: String(error.message || error),
    });
  }
  let productionUiModule = null, productionFactionBytes = null;
  // Fog is campaign state: its sources are admitted even without optional CAS files.
  // Read from the user's selected assets; the core validates each source.
  const fogInputs = [
    [
      'campaignFogTraits',
      '_openrtw_load_campaign_fog_traits',
      'data/export_descr_character_traits.txt',
    ],
    [
      'campaignFogAncillaries',
      '_openrtw_load_campaign_fog_ancillaries',
      'data/export_descr_ancillaries.txt',
    ],
    [
      'campaignFogFeatures',
      '_openrtw_load_campaign_fog_features',
      'data/world/maps/base/map_features.tga',
    ],
    [
      'settlementBuildings',
      '_openrtw_load_settlement_buildings',
      'data/export_descr_buildings.txt',
    ],
  ];
  const fogInputBytes = await Promise.all(
    fogInputs.map(async ([name, , path]) => {
      try {
        return await gameAssets.read(name);
      } catch (error) {
        if (closing || error?.name === 'AbortError') throw error;
        throw new Error(
          `Fog of war needs ${path}. Check that your selected game folder contains this file. ${error.message ?? error}`
        );
      }
    })
  );
  requireOpen();
  if (typeof core._openrtw_load_production_catalog === 'function') {
    productionUiModule = await import('/games/rome-original/production-view.js');
    requireOpen();
    fogInputBytes[3] = productionUiModule.applyBuildingTreeOverrides(fogInputBytes[3]);
    productionFactionBytes = await gameAssets.read('aerialFactionCultures');
    requireOpen();
    load(core, productionFactionBytes, '_openrtw_load_faction_cultures');
  }
  fogInputs.forEach(([, method], i) => load(core, fogInputBytes[i], method));
  try {
    const { createCampaignBuildingAssets } = await import('/campaign-building-assets.js');
    requireOpen();
    const [localizationBytes, uiVariantsBytes, factionBytes] = await Promise.all(
      ['campaignBuildingLocalization', 'campaignBuildingUiVariants', 'aerialFactionCultures'].map(
        (name) => gameAssets.read(name)
      )
    );
    requireOpen();
    campaignBuildingAssets = createCampaignBuildingAssets({
      descriptorBytes: fogInputBytes[3],
      localizationBytes,
      uiVariantsBytes,
      factionBytes,
      readAsset: (name, options) => gameAssets.read(name, options),
      isOpen: () => !closing,
    });
    status.dataset.buildingAssets = JSON.stringify(campaignBuildingAssets.status);
  } catch (error) {
    if (closing || error?.name === 'AbortError') throw error;
    status.dataset.buildingAssets = JSON.stringify({
      state: 'fallback',
      reason: String(error.message || error),
    });
  }
  const { loadCampaignRadarMap } = await import('/campaign-radar-map.js');
  requireOpen();
  const radarMap = await loadCampaignRadarMap((name, options) => gameAssets.read(name, options), {
    isOpen: () => !closing,
  });
  requireOpen();
  status.dataset.radarMap = JSON.stringify(radarMap.status);
  const playerFaction = 'romans_julii';
  const playerFactionIndex = campaign.factions.findIndex((f) => f.id === playerFaction);
  if (playerFactionIndex < 0) throw new Error('The campaign player faction is unavailable');
  const fog = createCampaignFog({ width: regionWidth, height: regionHeight });
  // No frame is drawn until the session has supplied its first validated table.
  fog.adopt({
    bytes: new Uint8Array(regionWidth * regionHeight),
    playerFaction,
    generation: 0,
    revision: 0,
    enabled: false,
  });
  status.dataset.aerialTerrain = JSON.stringify(aerialState.wire);
  campaignScene = createCampaignScene({
    renderer,
    canvas,
    worldWidth: regionWidth,
    worldHeight: regionHeight,
    terrainWidth: width,
    terrainHeight: height,
    heightAt: (x, y) => heights.getFloat32((y * width + x) * 4, true),
    unitGeometry,
    unitTexture,
    terrainTextures,
    generalModel,
    waterTexture,
    coastline,
    trees: campaignTrees,
    banners: campaignBanners,
    townAssets,
    settlementModels,
    settlements,
    cameraReference: originalInitialCampaignView,
    aerialTerrain: aerialState.terrain,
    heightOverrides: aerialState.heightOverrides,
    fog: {
      visibility: fog,
      create: (renderer) => createCampaignFogTexture({ renderer, fog }),
      extendVertices: (bytes) => extendCampaignFogVertices(bytes, regionWidth, regionHeight),
    },
  });
  mapFogTexture = createCampaignFogTexture({ renderer, fog });
  campaignLabels = createSettlementLabels({ canvas, bindings: settlementLabels });
  if (standingPose) canvas.dataset.standingPose = JSON.stringify(standingPose);
  if (battleAssetWire !== null) canvas.dataset.battleAssets = battleAssetWire;
  const hastatiActors = new Set(),
    initialBannerStrength = new Map();
  let session,
    sessionWire,
    characters = [],
    selectedId = null,
    target = null,
    route = null,
    routeError = '',
    pointerRoute = null,
    factionReport = null,
    selectedSettlementId = null,
    selectedSettlement = null,
    movementRangeCache = null,
    cameraKeys = null,
    // Web presentation speed: approximately one source walking cycle per
    // displayed stride. Native campaign timing/clip selection is unproved.
    travel = createCampaignTravel({ secondsPerCell: 0.7 }),
    lastInteractionReady = false;
  const sourceIds = new Map();
  campaign.factions.forEach((faction, fi) =>
    faction.characters.forEach((_, ci) => sourceIds.set(`${fi}:${ci}`, sourceIds.size))
  );
  const unsigned = (value) => Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
  const signed = (value) => Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff;
  function sessionText() {
    const pointer = core._openrtw_campaign_session_json();
    if (!pointer) throw new Error('Core campaign session is unavailable');
    return core.UTF8ToString(pointer);
  }
  function readSession() {
    const wire = sessionText(),
      next = JSON.parse(wire);
    if (
      next.ruleProfile !== romeOriginalCampaignRuleProfile ||
      next.width !== regionWidth ||
      next.height !== regionHeight ||
      !unsigned(next.generation) ||
      next.generation === 0 ||
      !unsigned(next.revision) ||
      !unsigned(next.orderRevision) ||
      !Number.isSafeInteger(next.turn) ||
      next.turn < 1 ||
      next.turn > 0x100000000 ||
      !signed(next.year) ||
      !['summer', 'winter'].includes(next.season) ||
      !Array.isArray(next.characters) ||
      next.characters.length !== campaign.counts.characters
    )
      throw new Error('Core campaign session header disagrees with the loaded campaign');
    const ids = new Set(),
      sources = new Set();
    const actors = next.characters.map((c) => {
      if (
        !unsigned(c.id) ||
        ids.has(c.id) ||
        !unsigned(c.sourceFactionIndex) ||
        !unsigned(c.sourceCharacterIndex)
      )
        throw new Error('Core campaign character identity is invalid');
      const faction = campaign.factions[c.sourceFactionIndex],
        source = faction?.characters[c.sourceCharacterIndex],
        sourceKey = `${c.sourceFactionIndex}:${c.sourceCharacterIndex}`;
      if (
        !source ||
        sources.has(sourceKey) ||
        c.id !== sourceIds.get(sourceKey) ||
        c.faction !== faction.id ||
        c.name !== source.name ||
        c.type !== source.type ||
        c.line !== source.line
      )
        throw new Error('Core campaign character differs from its source record');
      if (
        !signed(c.x) ||
        !signed(c.y) ||
        c.x < 0 ||
        c.y < 0 ||
        c.x >= regionWidth ||
        c.y >= regionHeight ||
        !unsigned(c.actionPoints) ||
        c.maxActionPoints !== 80 ||
        c.actionPoints > c.maxActionPoints
      )
        throw new Error('Core campaign character state is invalid');
      if (
        c.destination !== null &&
        (!c.destination ||
          !signed(c.destination.x) ||
          !signed(c.destination.y) ||
          c.destination.x < 0 ||
          c.destination.y < 0 ||
          c.destination.x >= regionWidth ||
          c.destination.y >= regionHeight ||
          (c.destination.x === c.x && c.destination.y === c.y))
      )
        throw new Error('Core journey destination is invalid');
      if (next.productionEnabled && (!unsigned(c.armyRecords) || c.armyRecords < source.armyRecords || c.armyRecords > source.armyRecords + 20))
        throw protocolError('Invalid produced army size');
      ids.add(c.id);
      sources.add(sourceKey);
      return {
        ...c,
        armyRecords: next.productionEnabled ? c.armyRecords : source.armyRecords,
        subFaction: source.subFaction,
        color: (0xff000000 | ((0x5a73c7 + 0x254f31 * c.sourceFactionIndex) & 0xffffff)) >>> 0,
      };
    });
    return { wire, value: { ...next, characters: actors } };
  }
  function clearRoute() {
    route = null;
    routeError = '';
    for (const key of [
      'state',
      'generation',
      'revision',
      'orderRevision',
      'actorId',
      'targetX',
      'targetY',
      'availableAp',
      'requiredAp',
      'plannedSteps',
      'partial',
      'points',
    ])
      delete routeStatus.dataset[key];
    routeStatus.textContent = 'Choose a World grid destination to plan a journey.';
  }
  function clearFactionReport() {
    factionReport = null;
    factionJourneyResults.replaceChildren();
    for (const key of Object.keys(factionJourneyStatus.dataset))
      delete factionJourneyStatus.dataset[key];
    factionJourneyStatus.textContent =
      'Select a character or faction to continue its planned journeys.';
  }
  clearPreview = () => {
    travel.cancel();
    target = null;
    clearRoute();
    clearFactionReport();
  };
  function publishFog(next) {
    const generation = next.generation;
    const pointer = core._openrtw_campaign_fog_json(playerFactionIndex, generation);
    if (!pointer) throw protocolError('Campaign fog metadata is unavailable');
    const metadata = JSON.parse(core.UTF8ToString(pointer));
    if (
      metadata.schema !== 'openrtw-campaign-fog-v1' ||
      metadata.available !== true ||
      metadata.generation !== generation ||
      metadata.factionIndex !== playerFactionIndex ||
      metadata.width !== regionWidth ||
      metadata.height !== regionHeight ||
      metadata.revision !== next.revision
    )
      throw protocolError(
        `Campaign fog is unavailable: ${metadata.reason ?? 'invalid table metadata'}`
      );
    const size = core._openrtw_campaign_fog_size(playerFactionIndex, generation) >>> 0;
    const data = core._openrtw_campaign_fog_data(playerFactionIndex, generation) >>> 0;
    const heap = core.HEAPU8;
    if (size !== regionWidth * regionHeight || !data || data > heap.length - size)
      throw protocolError('Campaign fog byte span is invalid');
    fog.adopt({
      bytes: heap.slice(data, data + size),
      playerFaction,
      generation,
      revision: next.revision,
    });
    if (aerialState.terrain) {
      const count = core._openrtw_sync_aerial_decal_fog(playerFactionIndex, generation);
      if (!Number.isInteger(count) || count < 0 || count > 4096)
        throw protocolError(
          core.UTF8ToString(core._openrtw_error()) || 'Ground decal visibility refused'
        );
      if (count) {
        const pointer = core._openrtw_aerial_decal_dirty_pages() >>> 0,
          heap = core.HEAPU8;
        if (!pointer || pointer > heap.length - count * 8)
          throw protocolError('Ground decal dirty pages are invalid');
        const copy = heap.slice(pointer, pointer + count * 8),
          view = new DataView(copy.buffer);
        const pages = Array.from({ length: count }, (_, i) => ({
          pageX: view.getUint32(i * 8, true),
          pageY: view.getUint32(i * 8 + 4, true),
        }));
        // A load can forget discoveries. Discard affected textures before the next
        // frame, so an old city base cannot survive the new player knowledge.
        campaignScene.invalidateAerialPages(pages, { discard: true });
      }
      status.dataset.aerialFogPages = String(count);
    }
    status.dataset.campaignFog = JSON.stringify({ ...metadata, playerFaction, ...fog.counts });
    if (
      selectedSettlementId !== null &&
      !fog.labelVisible(
        settlementLabels[selectedSettlementId].x,
        settlementLabels[selectedSettlementId].y
      )
    ) {
      selectedSettlementId = null;
      selectedSettlement = null;
      settlementSelect.value = '';
      settlementInfo.textContent = 'This settlement is outside current sight.';
      settlementBuildings.replaceChildren();
      delete settlementInfo.dataset.inspection;
      delete settlementInfo.dataset.presentation;
    }
    for (let i = 0; i < settlementRows.length; i++) {
      const anchor = settlementLabels[i];
      const option = Array.from(settlementSelect.options).find((row) => row.value === String(i));
      if (option) option.hidden = option.disabled = !fog.labelVisible(anchor.x, anchor.y);
    }
  }
  let checkpointPresentationPending = false;
  function publishSession(next, { deferPresentation = false } = {}) {
    travel.cancel();
    pointerRoute = null;
    if (!deferPresentation) {
      publishFog(next.value);
      campaignScene?.setSeason(next.value.season);
    }
    if (session?.generation !== next.value.generation) {
      selectedSettlementId = null;
      selectedSettlement = null;
      settlementSelect.value = '';
      settlementInfo.textContent = 'Choose a source settlement to inspect.';
      settlementBuildings.replaceChildren();
      delete settlementInfo.dataset.inspection;
      delete settlementInfo.dataset.presentation;
    }
    session = next.value;
    sessionWire = next.wire;
    characters = session.characters;
    movementRangeCache = null;
    clearRoute();
    clearFactionReport();
    status.dataset.generation = String(session.generation);
    status.dataset.revision = String(session.revision);
    status.dataset.orderRevision = String(session.orderRevision);
    status.dataset.turn = String(session.turn);
    status.dataset.ruleProfile = session.ruleProfile;
    // Coalesced: core commands never wait for asset IO or owner construction.
    settlementRefresh?.schedule('session');
  }
  function publishCheckpointSession(next) {
    publishSession(next, { deferPresentation: true });
    checkpointPresentationPending = true;
  }
  function resetCheckpointCampaign() {
    selectedId = null;
    target = null;
  }
  function refreshCheckpointCampaign() {
    // A compound restore publishes the campaign while the battle owns the
    // core; the coordinator kept that request pending. Return/leave is the
    // first point at which campaign core queries and scene publication resume.
    settlementRefresh?.resume();
    if (!checkpointPresentationPending) return;
    // Fog metadata and decal synchronization are campaign-only core queries.
    // The restored battle owns the core until Return has completed its leave.
    publishFog(session);
    campaignScene?.setSeason(session.season);
    chooseList();
    showStatus();
    showSelected();
    paint();
    checkpointPresentationPending = false;
  }
  if (core._openrtw_begin_campaign_session() !== 1)
    throw new Error(core.UTF8ToString(core._openrtw_error()));
  if (productionUiModule) load(core, fogInputBytes[3], '_openrtw_load_production_catalog');
  publishSession(readSession());
  for (const c of characters) {
    const rosterPointer = core._openrtw_campaign_army_json(c.id, session.generation);
    if (!rosterPointer) throw new Error('Campaign army definitions are unavailable.');
    const roster = JSON.parse(core.UTF8ToString(rosterPointer, 4 * 1024 * 1024));
    if (
      roster.actorId !== c.id ||
      roster.generation !== session.generation ||
      !Array.isArray(roster.rows) ||
      roster.rows.length !== c.armyRecords
    )
      throw new Error('Campaign army definitions disagree with the selected character.');
    if (
      roster.rows.some(
        (row) => row.status === 'matched' && row.modelDefinition?.type === 'roman_hastati'
      )
    )
      hastatiActors.add(c.id);
    // Initial source projection at factor 1. Native live counts also include
    // bodyguard bonuses, per-unit caps and rounding, which this view lacks.
    // Fleets use a separate native capacity and remain emblem placeholders.
    if (
      c.type !== 'admiral' &&
      roster.rows.length &&
      roster.rows.every(
        (row) =>
          Number.isInteger(row.unitDefinition?.sourceSoldierCount) &&
          row.unitDefinition.sourceSoldierCount >= 0 &&
          row.unitDefinition.sourceSoldierCount <= 10000
      )
    )
      initialBannerStrength.set(
        c.id,
        Object.freeze({
          count: roster.rows.reduce((sum, row) => sum + row.unitDefinition.sourceSoldierCount, 0),
          capacity: 700,
          policy: 'approximate-initial-source-factor-1;bodyguard-bonuses-not-applied',
        })
      );
  }
  for (const faction of campaign.factions) {
    const option = document.createElement('option');
    option.value = faction.id;
    option.textContent = `${faction.id} (${faction.characters.length})`;
    factionSelect.append(option);
  }
  const campaignSummary = `${width} × ${height} terrain · ${count.toLocaleString()} heights\n${campaign.factions.length} factions · ${characters.length} characters\n${campaign.counts.unitRecords} unit records · ${campaign.counts.opaqueRecords} preserved rows\n${regionData.definitions.length} region definitions · ${regionWidth} × ${regionHeight} cells\n${world.palette.length} world regions · ${world.markers.length} resolved markers · ${categoryCount.toLocaleString()} ground categories\n${climateData.definitions.length} climate definitions · ${climateCount.toLocaleString()} coefficients\n${campaign.counts.settlements} settlements · ${campaign.counts.buildingRecords} building records\n${aerialState.terrain ? `Native aerial ground tiles · ${aerialState.wire.textures} textures · ${aerialState.wire.pagesX * aerialState.wire.pagesY} pages` : `Aerial ground fallback (grass/hills): ${aerialState.wire.reason}`}\n${aerialState.wire.decals.state === 'active' ? `Aerial decals · ${aerialState.wire.decals.records} records · ${aerialState.wire.decals.flattenedPoints} flattened points` : `No aerial decals: ${aerialState.wire.decals.reason}`}`;
  function showStatus() {
    status.textContent = `Turn ${session.turn} · ${session.season} ${Math.abs(session.year)} ${session.year < 0 ? 'BC' : 'AD'}\nFog of war · Julii (shared Roman sight)\n${campaignSummary}`;
  }
  const selected = () => characters.find((c) => c.id === selectedId && fog.actorVisible(c.x, c.y));
  const controllable = (actor) => actor?.sourceFactionIndex === playerFactionIndex;
  // Completed production can change which cells carry a rendered structure.
  // Keep the movement/route blocking set derived from the currently published
  // placement instead of the startup snapshot.
  let structureCommandTargets = [],
    structureCommandCells = new Set();
  function rebuildStructureCommandTargets() {
    structureCommandTargets = [
      ...settlementLabels,
      ...(settlementModels?.placement.models ?? []),
    ];
    structureCommandCells = new Set(
      structureCommandTargets.map(({ x, y }) => `${x},${y}`)
    );
  }
  rebuildStructureCommandTargets();
  function structureDestinationReason(destination) {
    if (!destination || !structureCommandCells.has(`${destination.x},${destination.y}`)) return '';
    return fog.labelVisible(destination.x, destination.y)
      ? 'Entering settlements and ports is not implemented. Select the building to inspect it.'
      : 'This destination is unavailable.';
  }
  function movementRangeForSelection() {
    const actor = selected();
    if (!actor || !controllable(actor) || !isCampaignLayer() || !canInteract()) return null;
    const key = [
      session.generation,
      session.revision,
      session.orderRevision,
      actor.id,
      actor.actionPoints,
      fog.version,
    ].join(':');
    if (movementRangeCache?.key !== key) {
      movementRangeCache = {
        key,
        value: buildCampaignMovementRange({
          width: regionWidth,
          height: regionHeight,
          actor,
          actors: characters,
          controllable: true,
          categoryAt: (x, y) => categoryIds[y * regionWidth + x],
          terrainExplored: (x, y) => fog.terrainExplored(x, y),
          blockedTargets: structureCommandTargets,
          generation: session.generation,
          revision: session.revision,
          orderRevision: session.orderRevision,
        }),
      };
    }
    return movementRangeCache.value;
  }
  function journeyFaction() {
    const faction = factionSelect.value || selected()?.faction;
    return faction === playerFaction ? playerFactionIndex : null;
  }
  function restoreDestination() {
    const destination = selected()?.destination;
    target = destination ? { ...destination } : null;
    clearRoute();
  }
  function showSelection() {
    if (selectedId !== null && selectedSettlementId !== null) inspectSettlement(null);
    pointerRoute = null;
    restoreDestination();
    showSelected();
    updateControls();
    if (target && isCampaignLayer()) previewRoute();
    else paint();
  }
  function chooseList() {
    characterSelect.replaceChildren();
    const prompt = document.createElement('option');
    prompt.value = '';
    prompt.textContent = 'Choose a character';
    characterSelect.append(prompt);
    const visible = characters.filter(
      (c) =>
        fog.actorVisible(c.x, c.y) && (!factionSelect.value || c.faction === factionSelect.value)
    );
    if (!visible.some((c) => c.id === selectedId)) {
      selectedId = null;
      target = null;
      clearRoute();
    }
    for (const c of visible) {
      const option = document.createElement('option');
      option.value = String(c.id);
      option.textContent = `#${c.id} ${c.name} · ${c.faction} · ${c.x}, ${c.y} · AP ${c.actionPoints}${c.destination ? ` → ${c.destination.x}, ${c.destination.y}` : ''}`;
      option.dataset.destination = JSON.stringify(c.destination);
      characterSelect.append(option);
    }
    characterSelect.value = selectedId === null ? '' : String(selectedId);
  }
  function showSelected() {
    const c = selected();
    details.dataset.characterId = c ? String(c.id) : '';
    details.dataset.x = c ? String(c.x) : '';
    details.dataset.y = c ? String(c.y) : '';
    details.dataset.actionPoints = c ? String(c.actionPoints) : '';
    const opponentId = battleOpponent.value;
    battleOpponent.replaceChildren();
    const prompt = document.createElement('option');
    prompt.value = '';
    prompt.textContent = 'Choose an opposing army';
    battleOpponent.append(prompt);
    for (const actor of characters.filter(
      (a) => a.id !== c?.id && a.armyRecords > 0 && fog.actorVisible(a.x, a.y)
    )) {
      const option = document.createElement('option');
      option.value = String(actor.id);
      option.textContent = `#${actor.id} ${actor.name} · ${actor.faction}`;
      battleOpponent.append(option);
    }
    battleOpponent.value = opponentId;
    if (!battleOpponent.value) battleOpponent.value = '';
    showArmy(c);
    if (layer.value === 'regions') return;
    detailTitle.textContent = 'Character';
    if (!c) {
      details.textContent = 'Choose a character from the list or click a marker.';
      return;
    }
    details.textContent = `${c.name}\n${c.type} · ${c.faction}\nPosition ${c.x}, ${c.y}\nAction points ${c.actionPoints} / ${c.maxActionPoints}\n${c.armyRecords} unit records · source line ${c.line}${c.subFaction ? '\nLiteral sub_faction: ' + c.subFaction : ''}`;
    if (c.destination) details.textContent += `\nJourney to ${c.destination.x}, ${c.destination.y}`;
    const index = worldIndices[c.y * regionWidth + c.x],
      definition = regionsByColor.get(key(world.palette[index]));
    details.textContent += `\nWorld region ${index}${definition ? ' · ' + definition.id : ''}\nGround category ${categoryIds[c.y * regionWidth + c.x]}${climateDetails(c.x, c.y)}`;
  }
  function showArmy(c) {
    armyPanel.hidden = !c || layer.value === 'regions';
    armyList.replaceChildren();
    delete armyPanel.dataset.roster;
    if (armyPanel.hidden) return;
    try {
      const pointer = core._openrtw_campaign_army_json(c.id, session.generation);
      if (!Number.isInteger(pointer) || pointer <= 0 || pointer >= core.HEAPU8.length)
        throw protocolError('Core army roster is unavailable');
      const limit = 4 * 1024 * 1024,
        wire = core.UTF8ToString(pointer, Math.min(limit + 1, core.HEAPU8.length - pointer));
      if (wire.length > limit) throw protocolError('Core army roster exceeds the view limit');
      const report = JSON.parse(wire),
        optional = (value) => value === null || signed(value),
        text = (value) => typeof value === 'string' && value.length > 0;
      if (
        report.generation !== session.generation ||
        report.actorId !== c.id ||
        report.sourceFactionIndex !== c.sourceFactionIndex ||
        report.sourceCharacterIndex !== c.sourceCharacterIndex ||
        !Array.isArray(report.rows) ||
        report.rows.length !== c.armyRecords
      )
        throw protocolError('Core army roster differs from the selected source character');
      report.rows.forEach((row, i) => {
        if (
          row.sourceArmyIndex !== i ||
          !text(row.name) ||
          !unsigned(row.line) ||
          (row.line === 0 && !(session.productionEnabled && row.created === true)) ||
          !['count', 'experience', 'armour', 'weapon'].every((key) => optional(row[key])) ||
          !['matched', 'missing_unit_definition', 'missing_model_definition'].includes(row.status)
        )
          throw protocolError('Core army source row is invalid');
        const unit = row.unitDefinition,
          model = row.modelDefinition;
        if (
          row.status === 'missing_unit_definition'
            ? unit !== null || model !== null
            : !unit ||
              unit.type !== row.name ||
              !text(unit.dictionary) ||
              !text(unit.category) ||
              !text(unit.unitClass) ||
              !text(unit.soldierModel) ||
              !signed(unit.sourceSoldierCount) ||
              unit.sourceSoldierCount < 0 ||
              !unsigned(unit.line) ||
              unit.line === 0
        )
          throw protocolError('Core unit definition join is invalid');
        if (
          row.status === 'matched'
            ? !model ||
              model.type !== unit.soldierModel ||
              !unsigned(model.line) ||
              model.line === 0 ||
              !Array.isArray(model.fields) ||
              model.fields.length > 4096 ||
              model.fields.some(
                (f) =>
                  !text(f.key) ||
                  typeof f.value !== 'string' ||
                  typeof f.source !== 'string' ||
                  !unsigned(f.line) ||
                  f.line === 0
              )
            : model !== null
        )
          throw protocolError('Core battle model join is invalid');
        const item = document.createElement('li'),
          name = document.createElement('strong'),
          info = document.createElement('span');
        name.textContent = row.name;
        info.className = 'muted';
        info.textContent = unit
          ? `${unit.unitClass} ${unit.category} · base soldiers ${unit.sourceSoldierCount}${row.experience === null ? '' : ` · experience ${row.experience}`}${row.status === 'missing_model_definition' ? ' · Model definition unavailable' : ''}`
          : 'Unit definition unavailable';
        item.append(name, info);
        armyList.append(item);
        if (
          row.status === 'matched' &&
          model.type === 'roman_hastati' &&
          model.fields.some(
            (f) =>
              f.key === 'model_flexi' &&
              f.value === 'data/models_unit/unit_roman_hastati_lowest.cas, max'
          )
        ) {
          const view = document.createElement('button');
          view.className = 'unit-model-button';
          view.textContent = 'View Hastati model';
          view.disabled = !canInteract() || Boolean(unitPreview?.busy);
          view.addEventListener('click', () => {
            if (canInteract() && !view.disabled) unitPreview?.open();
          }, pageInputOptions);
          item.append(view);
        }
      });
      armyTitle.textContent = `Army · ${report.rows.length} unit${report.rows.length === 1 ? '' : 's'}`;
      if (!report.rows.length) {
        const item = document.createElement('li');
        item.textContent = 'This character has no army.';
        armyList.append(item);
      }
      armyPanel.dataset.roster = wire;
    } catch (error) {
      fail(error);
    }
  }
  function updateControls() {
    const alive = status.dataset.ready === 'true' && !closing && Boolean(core) && Boolean(renderer),
      ready =
        alive &&
        phase === 'running' &&
        !unitPreview?.isOpen &&
        !unitPreview?.busy &&
        !battleView?.active &&
        !travel.active,
      c = selected(),
      matched = routeMatchesCurrent(c);
    reset.disabled = !ready;
    factionSelect.disabled = !ready || layer.value === 'regions';
    layer.disabled = !ready;
    soundButton.disabled = !ready || soundStatus.dataset.state === 'playing';
    characterSelect.disabled = !ready || layer.value === 'regions';
    endTurnButton.disabled = !ready;
    centerButton.disabled = !ready || !isCampaignLayer() || !(c || selectedSettlement);
    cancelButton.disabled = !ready || !controllable(c) || !c?.destination;
    const group = journeyFaction(),
      planned = characters.filter((a) => a.sourceFactionIndex === group && a.destination).length;
    factionJourneyButton.disabled = !ready || group === null || planned === 0;
    factionJourneyButton.textContent =
      group === null
        ? 'Continue faction journeys'
        : `Continue ${campaign.factions[group].id} journeys (${planned})`;
    if (factionReport && factionReport.sourceFactionIndex !== group) clearFactionReport();
    if (!factionReport)
      factionJourneyStatus.textContent =
        group === null
          ? 'Select a character or faction to continue its planned journeys.'
          : planned
            ? `${planned} planned journey${planned === 1 ? '' : 's'} in ${campaign.factions[group].id}. Continue them once in character order.`
            : `No planned journeys in ${campaign.factions[group].id}.`;
    moveButton.disabled =
      !ready ||
      !controllable(c) ||
      !isCampaignLayer() ||
      !matched ||
      route.status !== 'ok' ||
      Boolean(routeAdmission(c, route));
    moveButton.textContent =
      matched && route.status === 'ok' ? `Continue · ${route.plannedSteps} AP` : 'Continue journey';
    saveButton.disabled = loadButton.disabled = !ready || storeFailed;
    const compoundReady = alive && phase === 'running' && !activeWork && !compoundStoreFailed &&
      !unitPreview?.isOpen && !unitPreview?.busy && !travel.active;
    compoundSaveButton.disabled = !compoundReady || !campaignBattleActions?.canSave();
    compoundLoadButton.disabled = !compoundReady || !campaignBattleActions?.canLoad();
    stopButton.disabled = !alive || phase === 'stopping';
    const opponent =
      battleOpponent.value === ''
        ? null
        : characters.find((a) => a.id === Number(battleOpponent.value));
    battleOpponent.disabled = !ready || !c?.armyRecords;
    battleButton.disabled =
      !ready || !c?.armyRecords || !opponent?.armyRecords || opponent.id === c.id;
    settlementSelect.disabled = !ready;
    clearSettlement.disabled = !ready || selectedSettlementId === null;
    for (const button of armyList.querySelectorAll('.unit-model-button'))
      button.disabled = !ready || Boolean(unitPreview?.busy);
    targetStatus.dataset.x = target ? String(target.x) : '';
    targetStatus.dataset.y = target ? String(target.y) : '';
    targetStatus.textContent = !c
      ? 'Select a character first.'
      : !isCampaignLayer()
        ? 'Use 3D campaign or World grid to choose a destination.'
        : !target
          ? 'Right-click to move. Shift + right-click plans a journey.'
          : `Destination ${target.x}, ${target.y}`;
    if (!matched) {
      routeStatus.textContent =
        routeError ||
        (!c
          ? 'Select a character to preview a route.'
          : !isCampaignLayer()
            ? 'Use 3D campaign or World grid to preview a route.'
            : 'Choose a destination to preview a route.');
    }
    campaignProductionView?.refresh(productionViewCityId());
    updateHud();
    refreshCampaignPointer();
    if (ready !== lastInteractionReady) {
      lastInteractionReady = ready;
      if (alive && phase === 'running' && renderer && campaignScene) paint();
    }
    syncCampaignAnimation?.();
  }
  refreshControls = updateControls;
  const campaignPresentationAvailable = () =>
    !closing &&
    Boolean(core) &&
    Boolean(renderer) &&
    status.dataset.ready === 'true' &&
    !unitPreview?.isOpen &&
    !unitPreview?.busy;
  const campaignAvailable = () => phase === 'running' && campaignPresentationAvailable();
  const battleAttachmentAvailable = () =>
    ['running', 'checkpoint-loading'].includes(phase) && campaignPresentationAvailable();
  const canNavigate = () => campaignAvailable() && !battleView?.active;
  const canInteract = () => canNavigate() && !travel.active;
  unitPreview = createUnitPreview({
    dialog: document.querySelector('#unit-preview'),
    canOpen: canInteract,
    onState: () => updateControls(),
    readAsset: (name, options) => asset(name, null, options),
    createCoreSession: createRomeCoreSession,
    sessionIdentity: gameLaunchProfile.identity,
  });
  if (typeof core._openrtw_export_campaign_battle_save === 'function' &&
      typeof core._openrtw_import_campaign_battle_save === 'function') {
    checkpointCodec = await import('/games/rome-original/checkpoint-storage.js');
    requireOpen();
    ({ createCampaignBattleActions: createCheckpointActions } =
      await import('/games/rome-original/checkpoint-actions.js'));
    requireOpen();
  }
  battleView = createBattleView({
    dialog: document.querySelector('#battle-view'),
    core,
    unitGeometry,
    unitTexture,
    terrainTexture: terrainTextures.grass,
    modelAssets: battleModelAssets,
    canOpen: battleAttachmentAvailable,
    checkpointCodec,
    onSaveCheckpoint: () => saveCampaignBattle(),
    onLoadCheckpoint: () => loadCampaignBattle(),
    canSaveCheckpoint: () => Boolean(campaignBattleActions?.canSave() && !activeWork &&
      !compoundStoreFailed && phase === 'running'),
    canLoadCheckpoint: () => Boolean(campaignBattleActions?.canLoad() && !activeWork &&
      !compoundStoreFailed && phase === 'running' && !travel.active && !unitPreview?.isOpen &&
      !unitPreview?.busy),
    onState: () => {
      if (!closing && phase === 'running' && battleView?.state === 'closed') {
        try { refreshCheckpointCampaign(); }
        catch (error) { fail(error); return; }
      }
      updateControls();
      if (!closing && phase === 'running' && battleView?.state === 'closed')
        battleStatus.textContent = 'Returned to campaign. Battle results were not applied.';
    },
    onFailure: (error) => {
      if (!closing && phase === 'running') battleStatus.textContent = describeFailure(error);
    },
  });
  function settlementOwnerDescriptor(assets) {
    const modules = settlementWebModules;
    if (!modules) throw new Error('Settlement asset modules are unavailable');
    return {
      create: (sceneRenderer) =>
        modules.createCampaignSettlementModels({ renderer: sceneRenderer, assets }),
      createShadows: (sceneRenderer, townOwner) =>
        modules.createCampaignShadowScene({
          renderer: sceneRenderer,
          townOwner,
          volumes: assets.shadowVolumes,
          assetStatus: assets.shadowStatus,
        }),
      wire: (townOwner) =>
        JSON.stringify({
          schema: 'openrtw-campaign-settlement-bindings-v2',
          meaning:
            'native-current-selection-and-transforms;frustum-and-known-fog-cells;static-side-wall-shadow-volumes-only-when-admitted-and-view-proven',
          settlementCount: assets.placement.settlementCount,
          portCount: assets.placement.portCount,
          bannerCount: assets.placement.bannerCount,
          garrisonBannerCount: assets.placement.garrisonBannerCount,
          problems: assets.placement.problems,
          models: townOwner.bindings,
        }),
    };
  }
  settlementRefresh = createProductionSettlementRefresh({
    load: ({ prior, isCurrent }) => {
      if (!settlementWebModules || !prior)
        return Promise.reject(new Error('Settlement refresh inputs are unavailable'));
      return settlementWebModules.refreshSettlementModelAssets(core, gameAssets, prior, {
        isCurrent,
        collectShadows: true,
      });
    },
    getPrior: () => settlementModels,
    getScene: () => campaignScene,
    isCampaignActive: () =>
      !closing &&
      !battleView?.active &&
      status.dataset.ready !== 'false' &&
      (phase === 'initializing' || phase === 'running'),
    readIdentity: () => ({
      generation: session.generation,
      revision: session.revision,
      orderRevision: session.orderRevision,
    }),
    buildOwners: settlementOwnerDescriptor,
    apply: (assets, { changed }) => {
      if (settlementWebModules && settlementModels)
        settlementModels = {
          ...assets,
          create: (sceneRenderer) =>
            settlementWebModules.createCampaignSettlementModels({ renderer: sceneRenderer, assets }),
          createShadows: (sceneRenderer, townOwner) =>
            settlementWebModules.createCampaignShadowScene({
              renderer: sceneRenderer,
              townOwner,
              volumes: assets.shadowVolumes,
              assetStatus: assets.shadowStatus,
            }),
          onFailure: settlementModels.onFailure,
        };
      if (!changed) return;
      rebuildStructureCommandTargets();
      movementRangeCache = null;
      paint();
    },
    inspect: () => refreshSelectedSettlementInspection(),
    onState: (state) => {
      status.dataset.settlementRefresh = JSON.stringify(state);
    },
    onFailure: (error, { phase: failedPhase }) => {
      if (closing) return;
      // A malformed core publication is a contract break. A clean optional
      // asset/scene-construction refusal keeps the current owners and stays
      // retryable on the next accepted change.
      if (
        error?.campaignProtocol ||
        (error instanceof AggregateError && failedPhase !== 'load')
      )
        fail(error);
    },
  });
  const routeReasons = {
    ok: 'Route ready.',
    stale_revision: 'Campaign changed. Choose a destination again.',
    stale_order_revision: 'Journey changed. Select the character again.',
    no_destination: 'Choose a journey destination.',
    invalid_actor: 'This character is unavailable.',
    out_of_bounds: 'Choose a cell inside the world grid.',
    no_op: 'The character is already at this cell.',
    world_too_large: 'This world exceeds the prototype route search limit.',
    occupied: 'This destination is unavailable.',
    unreachable: 'No cardinal route reaches this destination.',
    insufficient_ap: 'Not enough action points for this route.',
    revision_overflow: 'This route would exceed the campaign command limit.',
    fog_refused: 'Visibility could not be updated. The character stayed in place.',
  };
  function routeAdmission(c, report) {
    if (!c || report?.status !== 'ok') return '';
    return (
      structureDestinationReason(report.target) ||
      routeTerrainReason(c, report, (x, y) => categoryIds[y * regionWidth + x]) ||
      ''
    );
  }
  function routeMatchesCurrent(c) {
    return Boolean(
      route &&
        c &&
        target &&
        route.ruleProfile === session.ruleProfile &&
        route.generation === session.generation &&
        route.revision === session.revision &&
        route.orderRevision === session.orderRevision &&
        route.actorId === c.id &&
        route.target.x === target.x &&
        route.target.y === target.y &&
        route.availableAp === c.actionPoints
    );
  }
  function validateRoute(next, c, destination) {
    if (
      !next ||
      next.ruleProfile !== session.ruleProfile ||
      next.generation !== session.generation ||
      next.revision !== session.revision ||
      next.orderRevision !== session.orderRevision ||
      next.actorId !== c.id ||
      !next.target ||
      next.target.x !== destination.x ||
      next.target.y !== destination.y ||
      typeof next.status !== 'string' ||
      !Object.hasOwn(routeReasons, next.status) ||
      !unsigned(next.availableAp) ||
      next.availableAp !== c.actionPoints ||
      !unsigned(next.requiredAp) ||
      !unsigned(next.plannedSteps) ||
      typeof next.partial !== 'boolean' ||
      !Array.isArray(next.points)
    )
      throw protocolError('Core advance report disagrees with the current campaign request');
    const knownCost = ['ok', 'insufficient_ap', 'revision_overflow'].includes(next.status);
    if (knownCost) {
      if (next.requiredAp < 1 || next.requiredAp > Math.min(65535, regionWidth * regionHeight - 1))
        throw protocolError('Core route cost exceeds its bounded search domain');
    } else if (next.requiredAp !== 0) throw protocolError('Refused route has an unexpected cost');
    const affordable = Math.min(next.requiredAp, next.availableAp);
    if (next.status === 'insufficient_ap' && next.availableAp !== 0)
      throw protocolError('Core insufficient-AP report is inconsistent');
    if (
      next.status === 'revision_overflow' &&
      (affordable === 0 || affordable <= 0xffffffff - session.revision)
    )
      throw protocolError('Core route revision-overflow report is inconsistent');
    if (next.status !== 'ok') {
      if (next.points.length !== 0 || next.plannedSteps !== 0 || next.partial)
        throw protocolError('Refused advance unexpectedly contains a plan');
      return next;
    }
    if (
      next.plannedSteps !== affordable ||
      next.plannedSteps < 1 ||
      next.plannedSteps > 80 ||
      next.plannedSteps > 0xffffffff - session.revision ||
      next.partial !== next.plannedSteps < next.requiredAp ||
      next.points.length !== next.plannedSteps + 1 ||
      next.points.length > 81
    )
      throw protocolError('Core advance length or action-point cost is invalid');
    const seen = new Set(),
      occupied = new Set(characters.filter((a) => a.id !== c.id).map((a) => `${a.x},${a.y}`));
    next.points.forEach((point, i) => {
      if (
        !point ||
        !signed(point.x) ||
        !signed(point.y) ||
        point.x < 0 ||
        point.y < 0 ||
        point.x >= regionWidth ||
        point.y >= regionHeight
      )
        throw protocolError('Core route point lies outside the world grid');
      const key = `${point.x},${point.y}`;
      if (seen.has(key) || (i > 0 && occupied.has(key)))
        throw protocolError('Core route repeats or enters a blocked cell');
      seen.add(key);
      if (i > 0) {
        const previous = next.points[i - 1];
        if (Math.abs(point.x - previous.x) + Math.abs(point.y - previous.y) !== 1)
          throw protocolError('Core route contains a non-cardinal step');
      }
    });
    const first = next.points[0],
      last = next.points.at(-1),
      arrived = last.x === destination.x && last.y === destination.y;
    if (first.x !== c.x || first.y !== c.y || (next.partial ? arrived : !arrived))
      throw protocolError(
        'Core advance endpoints disagree with the selected character and destination'
      );
    return next;
  }
  function showRoute() {
    Object.assign(routeStatus.dataset, {
      state: route.status,
      generation: String(route.generation),
      revision: String(route.revision),
      orderRevision: String(route.orderRevision),
      actorId: String(route.actorId),
      targetX: String(route.target.x),
      targetY: String(route.target.y),
      availableAp: String(route.availableAp),
      requiredAp: String(route.requiredAp),
      plannedSteps: String(route.plannedSteps),
      partial: String(route.partial),
      points: JSON.stringify(route.points),
    });
    const blocked = routeAdmission(selected(), route);
    routeStatus.dataset.movementBlocked = blocked;
    if (blocked) {
      routeStatus.textContent = blocked;
      return;
    }
    if (route.status === 'ok') {
      const last = route.points.at(-1);
      routeStatus.textContent = `${route.plannedSteps} steps this advance · ${route.plannedSteps} AP (${route.availableAp} available)\n${route.requiredAp} steps to destination ${route.target.x}, ${route.target.y}\nPath shown: ${route.points[0].x}, ${route.points[0].y} → ${last.x}, ${last.y}${route.partial ? '\nJourney remembered. End turn to refill, then choose Continue.' : ''}`;
    } else
      routeStatus.textContent =
        route.status === 'insufficient_ap'
          ? `No action points left. Destination ${route.target.x}, ${route.target.y} is ${route.requiredAp} steps away. End turn to refill and preview the next advance.`
          : routeReasons[route.status];
  }
  function previewRoute() {
    clearRoute();
    if (!canInteract() || !isCampaignLayer() || !selected() || !target) return;
    try {
      const c = selected(),
        destination = { ...target },
        before = sessionWire,
        result = core._openrtw_preview_campaign_advance(
          c.id,
          destination.x,
          destination.y,
          session.generation,
          session.revision
        );
      if (result !== 0 && result !== 1)
        throw protocolError('Core route preview returned an invalid status');
      if (result !== 1) {
        routeError =
          core.UTF8ToString(core._openrtw_error()) || 'The core could not preview this route.';
        if (sessionText() !== before)
          throw protocolError('Refused preview changed the campaign snapshot');
        routeStatus.dataset.state = 'refused';
        updateControls();
        paint();
        return;
      }
      // Return0 retains the previous C++ report; only return1 may read this getter.
      const pointer = core._openrtw_campaign_advance_json();
      if (!Number.isInteger(pointer) || pointer <= 0 || pointer >= core.HEAPU8.length)
        throw protocolError('Core advance report is unavailable');
      const wire = core.UTF8ToString(pointer, Math.min(8193, core.HEAPU8.length - pointer));
      if (wire.length > 8192) throw protocolError('Core route report exceeds the UI bound');
      const next = validateRoute(JSON.parse(wire), c, destination);
      if (sessionText() !== before)
        throw protocolError('Route preview changed the campaign snapshot');
      route = next;
      showRoute();
      updateControls();
      paint();
    } catch (error) {
      fail(error);
    }
  }
  function validateFactionReport(report, before, next, group) {
    const fields = [
      'sourceFactionIndex',
      'entryRevision',
      'revision',
      'orderRevision',
      'plannedCount',
      'appliedCount',
      'blockedCount',
      'totalSteps',
    ];
    if (
      !report ||
      report.ruleProfile !== before.ruleProfile ||
      report.generation !== before.generation ||
      !fields.every((key) => unsigned(report[key])) ||
      report.sourceFactionIndex !== group ||
      report.entryRevision !== before.revision ||
      report.revision !== next.revision ||
      report.orderRevision !== before.orderRevision ||
      next.generation !== before.generation ||
      next.orderRevision !== before.orderRevision ||
      next.turn !== before.turn ||
      next.year !== before.year ||
      next.season !== before.season ||
      !Array.isArray(report.rows) ||
      report.rows.length > 256
    )
      throw protocolError('Faction journey report disagrees with the campaign');
    const planned = before.characters.filter(
        (c) => c.sourceFactionIndex === group && c.destination
      ),
      updates = new Map();
    if (report.rows.length !== planned.length || report.plannedCount !== planned.length)
      throw protocolError('Faction journey report omits a planned character');
    const samePoint = (a, b) =>
      a === null ? b === null : Boolean(a && b && a.x === b.x && a.y === b.y);
    let applied = 0,
      steps = 0;
    report.rows.forEach((row, i) => {
      const old = planned[i],
        current = next.characters.find((c) => c.id === old.id);
      if (
        !row ||
        row.actorId !== old.id ||
        !samePoint(row.target, old.destination) ||
        !row.before ||
        !row.after ||
        row.before.x !== old.x ||
        row.before.y !== old.y ||
        row.before.actionPoints !== old.actionPoints ||
        row.after.x !== current.x ||
        row.after.y !== current.y ||
        row.after.actionPoints !== current.actionPoints ||
        !samePoint(row.destination, current.destination) ||
        !unsigned(row.stepsTaken) ||
        !Object.hasOwn(routeReasons, row.status)
      )
        throw protocolError('Faction journey row disagrees with its character');
      if (row.status === 'ok') {
        const distance = Math.abs(current.x - old.x) + Math.abs(current.y - old.y),
          arrived = samePoint(current, old.destination);
        if (
          row.stepsTaken < 1 ||
          row.stepsTaken > old.actionPoints ||
          current.actionPoints !== old.actionPoints - row.stepsTaken ||
          distance > row.stepsTaken ||
          (row.stepsTaken - distance) % 2 !== 0 ||
          !samePoint(row.destination, arrived ? null : old.destination)
        )
          throw protocolError('Faction journey movement is inconsistent');
        applied++;
        steps += row.stepsTaken;
      } else if (
        row.stepsTaken !== 0 ||
        current.x !== old.x ||
        current.y !== old.y ||
        current.actionPoints !== old.actionPoints ||
        !samePoint(current.destination, old.destination)
      )
        throw protocolError('Blocked faction journey changed its character');
      updates.set(old.id, {
        ...old,
        x: current.x,
        y: current.y,
        actionPoints: current.actionPoints,
        destination: current.destination,
      });
    });
    if (
      report.appliedCount !== applied ||
      report.blockedCount !== planned.length - applied ||
      report.totalSteps !== steps ||
      steps > 0xffffffff - before.revision ||
      next.revision !== before.revision + steps
    )
      throw protocolError('Faction journey totals disagree');
    next.characters.forEach((c, i) => {
      if (JSON.stringify(c) !== JSON.stringify(updates.get(c.id) ?? before.characters[i]))
        throw protocolError('Faction journey changed an unrelated campaign field');
    });
    return report;
  }
  function showFactionReport(report, wire) {
    factionReport = report;
    factionJourneyResults.replaceChildren();
    factionJourneyStatus.dataset.state = 'complete';
    factionJourneyStatus.dataset.report = wire;
    factionJourneyStatus.textContent = `${campaign.factions[report.sourceFactionIndex].id}: ${report.appliedCount} moved · ${report.blockedCount} blocked · ${report.totalSteps} AP spent`;
    for (const row of report.rows) {
      const c = characters.find((c) => c.id === row.actorId),
        item = document.createElement('li');
      item.textContent =
        row.status === 'ok'
          ? `${c.name}: ${row.before.x}, ${row.before.y} → ${row.after.x}, ${row.after.y} · ${row.stepsTaken} AP${row.destination ? ' · Journey continues' : ' · Arrived'}`
          : `${c.name}: ${row.reason || routeReasons[row.status]}`;
      factionJourneyResults.append(item);
    }
  }
  function presentCommittedTravel(plans) {
    if (!plans.length || !canNavigate() || layer.value !== '3d') return;
    for (const plan of plans)
      travel.start({
        actorId: plan.actorId,
        points: plan.points,
        generation: session.generation,
        revision: session.revision,
        nowSeconds: visualElapsedSeconds,
      });
    pointerRoute = null;
    updateControls();
    paint();
    syncCampaignAnimation?.();
  }
  function continueFactionJourneys() {
    const group = journeyFaction();
    if (!canInteract() || factionJourneyButton.disabled || group === null) return;
    try {
      const before = session;
      const planned = before.characters.filter(
        (c) => c.sourceFactionIndex === group && c.destination
      );
      if (planned.length > 256 || planned.length * regionWidth * regionHeight > 2 ** 24) {
        refusedInteraction(
          'These journeys exceed the bounded route search. Continue them individually.'
        );
        return;
      }
      const rows = [],
        travelPlans = [];
      // Re-preview each actor after its predecessors move. A batch preflight
      // cannot validate the new paths produced by changing occupancy.
      for (const old of planned) {
        const c = characters.find((c) => c.id === old.id),
          preview = readAdvance(c, c.destination);
        const terrainReason = routeAdmission(c, preview);
        let state = preview?.status ?? 'unreachable';
        let reason = terrainReason || (!preview ? 'Route preview is unavailable.' : '');
        if (terrainReason) state = 'unreachable';
        if (state === 'ok') {
          const applied = command(() =>
            core._openrtw_continue_campaign_journey(
              c.id,
              session.generation,
              session.revision,
              session.orderRevision
            )
          );
          if (!canInteract()) return;
          if (applied) travelPlans.push({ actorId: c.id, points: preview.points });
          if (!applied) {
            state = 'unreachable';
            reason = commandStatus.textContent;
          }
        }
        const after = characters.find((c) => c.id === old.id);
        rows.push({
          actorId: old.id,
          target: old.destination,
          before: { x: old.x, y: old.y, actionPoints: old.actionPoints },
          after: { x: after.x, y: after.y, actionPoints: after.actionPoints },
          destination: after.destination,
          stepsTaken: old.actionPoints - after.actionPoints,
          status: state,
          reason,
        });
      }
      const appliedCount = rows.filter((row) => row.status === 'ok').length;
      const report = validateFactionReport(
        {
          policy: 'openrtw-ui-terrain-checked-sequential-v1',
          ruleProfile: before.ruleProfile,
          generation: before.generation,
          sourceFactionIndex: group,
          entryRevision: before.revision,
          revision: session.revision,
          orderRevision: session.orderRevision,
          plannedCount: planned.length,
          appliedCount,
          blockedCount: planned.length - appliedCount,
          totalSteps: rows.reduce((n, row) => n + row.stepsTaken, 0),
          rows,
        },
        before,
        session,
        group
      );
      showFactionReport(report, JSON.stringify(report));
      commandStatus.textContent =
        'Faction journeys processed. Blocked journeys stay planned; End turn refills action points.';
      commandStatus.dataset.state = 'complete';
      updateControls();
      presentCommittedTravel(travelPlans);
    } catch (error) {
      fail(error);
    }
  }
  function currentIsSaved() {
    return (
      lastSaved?.generation === session.generation &&
      lastSaved?.revision === session.revision &&
      lastSaved?.orderRevision === session.orderRevision
    );
  }
  function showSaveState() {
    saveStatus.dataset.savedGeneration = lastSaved ? String(lastSaved.generation) : '';
    saveStatus.dataset.savedRevision = lastSaved ? String(lastSaved.revision) : '';
    saveStatus.dataset.currentSaved = String(currentIsSaved());
    saveStatus.dataset.savedOrderRevision = lastSaved ? String(lastSaved.orderRevision) : '';
    if (phase !== 'running' || storeFailed) return;
    saveStatus.dataset.state = currentIsSaved() ? 'saved' : 'unsaved';
    saveStatus.textContent = currentIsSaved()
      ? 'Current campaign saved in this browser.'
      : 'Current campaign has unsaved changes. Save before Stop to keep them.';
  }
  function protocolError(message) {
    const error = new Error(message);
    error.campaignProtocol = true;
    return error;
  }
  function watchPersistence(label, output = saveStatus) {
    return setTimeout(() => {
      persistenceUnknown = true;
      if (!closing && phase !== 'stopped' && phase !== 'failed') {
        if (phase !== 'stopping') setPhase('blocked');
        output.dataset.state = 'error';
        output.textContent = `${label} is still waiting after 10 seconds. Storage completion is unconfirmed; campaign commands remain locked.`;
      }
    }, 10000);
  }
  function persistenceOperation(kind, work, completed) {
    if (!canInteract() || storeFailed || activeWork) return;
    setPhase(kind);
    delete saveStatus.dataset.legacyCandidate;
    saveStatus.dataset.state = kind;
    saveStatus.textContent =
      kind === 'saving'
        ? 'Saving campaign; commands are paused…'
        : 'Loading saved campaign; commands are paused…';
    const timer = watchPersistence(kind === 'saving' ? 'Save' : 'Load');
    // An async work function starts now, so export and the owned byte copy occur
    // synchronously before its first await. Stop waits this raw promise only.
    let operation;
    try {
      operation = work();
    } catch (error) {
      operation = Promise.reject(error);
    }
    activeWork = operation;
    operation
      .then(
        (result) => {
          if (closing || phase !== kind) return;
          setPhase('running');
          showSaveState();
          completed(result);
          updateControls();
        },
        (error) => {
          if (error?.campaignProtocol) {
            fail(error);
            return;
          }
          if (closing || phase !== kind) return;
          setPhase('running');
          showSaveState();
          saveStatus.dataset.state = 'refused';
          saveStatus.textContent = describeFailure(error);
          showSelection();
        }
      )
      .finally(() => {
        clearTimeout(timer);
        if (activeWork === operation) {
          activeWork = null;
          if (!closing && phase === 'running') {
            updateControls();
            battleView?.refreshControls();
            settlementRefresh?.resume();
          }
        }
      })
      .catch(fail);
  }
  function saveCampaign() {
    persistenceOperation(
      'saving',
      async () => {
        const generation = session.generation,
          revision = session.revision,
          orderRevision = session.orderRevision,
          result = core._openrtw_export_campaign_journey_save(generation, revision, orderRevision);
        if (result !== 0 && result !== 1)
          throw protocolError('Core campaign export returned an invalid status');
        if (result !== 1)
          throw new Error(
            core.UTF8ToString(core._openrtw_error()) || 'The core refused campaign export.'
          );
        const pointer = core._openrtw_campaign_save_bytes(),
          size = core._openrtw_campaign_save_size(),
          heap = core.HEAPU8;
        if (
          !Number.isInteger(pointer) ||
          pointer <= 0 ||
          !Number.isInteger(size) ||
          size < 1 ||
          size > campaignSaveMaxBytes ||
          pointer > heap.length ||
          size > heap.length - pointer
        )
          throw protocolError('Core campaign save span is invalid');
        const bytes = heap.slice(pointer, pointer + size); // Copy immediately after the span getters, before any await or mutation.
        await campaignStore.save(bytes);
        await campaignStore.flush();
        lastSaved = { generation, revision, orderRevision };
        return size;
      },
      (size) => {
        saveStatus.dataset.bytes = String(size);
        saveStatus.textContent = `Saved ${size.toLocaleString()} bytes in this browser. Current campaign is saved.`;
        saveStatus.dataset.state = 'saved';
      }
    );
  }
  function loadCampaign() {
    persistenceOperation(
      'loading',
      async () => {
        const generation = session.generation,
          revision = session.revision,
          orderRevision = session.orderRevision,
          before = sessionWire;
        let bytes = await campaignStore.load(),
          legacyCandidate = false;
        if (closing || phase !== 'loading') return null;
        if (!bytes) {
          bytes = await campaignStore.loadLegacyCandidate();
          legacyCandidate = bytes !== null;
        }
        if (closing || phase !== 'loading') return null; // Stop cancels publication after a pending read.
        if (!bytes) throw new Error('No saved campaign exists in this browser yet.');
        const importingCore = core,
          pointer = importingCore._malloc(bytes.length);
        if (!pointer) throw new Error('Campaign import allocation failed');
        try {
          core.HEAPU8.set(bytes, pointer);
          const result = core._openrtw_import_campaign_journey_save(
            pointer,
            bytes.length,
            generation,
            revision,
            orderRevision
          );
          const refusal = result === 1 ? '' : core.UTF8ToString(core._openrtw_error());
          if (result !== 0 && result !== 1)
            throw protocolError('Core campaign import returned an invalid status');
          if (result !== 1) {
            if (sessionText() !== before)
              throw protocolError('Refused campaign import changed the core snapshot');
            throw new Error(refusal || 'The core refused the saved campaign.');
          }
          let next;
          try {
            next = readSession();
          } catch (error) {
            error.campaignProtocol = true;
            throw error;
          }
          if (next.value.generation === generation)
            throw protocolError('Loaded campaign did not receive a fresh generation');
          publishSession(next);
          selectedId = null;
          target = null;
          chooseList();
          showStatus();
          showSelected();
          paint();
          lastSaved = {
            generation: session.generation,
            revision: session.revision,
            orderRevision: session.orderRevision,
          };
          return { size: bytes.length, legacyCandidate };
        } finally {
          importingCore._free(pointer);
        }
      },
      (result) => {
        if (result === null) return;
        const { size, legacyCandidate } = result;
        saveStatus.dataset.bytes = String(size);
        saveStatus.dataset.state = 'loaded';
        saveStatus.dataset.legacyCandidate = String(legacyCandidate);
        saveStatus.textContent = legacyCandidate
          ? 'Loaded an earlier campaign. Save to keep a separate copy for this game profile.'
          : `Loaded ${size.toLocaleString()} saved bytes. Choose a character to continue.`;
        commandStatus.textContent = 'Saved campaign loaded by the C++ core.';
        commandStatus.dataset.state = 'complete';
      }
    );
  }
  function compoundPersistenceOperation(kind, work, completed) {
    const allowed = kind === 'checkpoint-saving'
      ? campaignBattleActions?.canSave()
      : campaignBattleActions?.canLoad();
    if (!allowed || compoundStoreFailed || activeWork || closing || phase !== 'running' ||
        travel.active || unitPreview?.isOpen || unitPreview?.busy) return;
    setPhase(kind);
    compoundSaveStatus.dataset.state = kind;
    compoundSaveStatus.textContent = kind === 'checkpoint-saving'
      ? 'Saving the campaign and battle checkpoint; simulation is held…'
      : 'Loading the campaign and battle checkpoint; commands are paused…';
    const timer = watchPersistence(kind === 'checkpoint-saving' ? 'Checkpoint save' : 'Checkpoint load',
      compoundSaveStatus);
    let operation;
    const context = {
      isCurrent: () => !closing && phase === kind &&
        (operation === undefined ? activeWork === null : activeWork === operation),
      ioFinished: () => clearTimeout(timer),
    };
    try { operation = work(context); }
    catch (error) { operation = Promise.reject(error); }
    activeWork = operation;
    operation.then(
      (result) => {
        if (closing || phase !== kind) return;
        setPhase('running');
        if (result === null) {
          compoundSaveStatus.dataset.state = 'cancelled';
          compoundSaveStatus.textContent = 'Checkpoint action cancelled; no new checkpoint was applied.';
        } else completed(result);
        updateControls();
      },
      (error) => {
        if (error?.campaignProtocol) { fail(error); return; }
        if (closing || phase !== kind) return;
        setPhase('running');
        compoundSaveStatus.dataset.state = compoundStoreFailed ? 'error' : 'refused';
        compoundSaveStatus.textContent = describeFailure(error);
        showSelection();
      }
    ).finally(() => {
      clearTimeout(timer);
      if (activeWork === operation) {
        activeWork = null;
        if (!closing && phase === 'running') {
          updateControls();
          battleView?.refreshControls();
          settlementRefresh?.resume();
        }
      }
    }).catch(fail);
  }
  function saveCampaignBattle() {
    compoundPersistenceOperation('checkpoint-saving',
      (context) => campaignBattleActions.save(context),
      ({ campaignBytes, battleBytes }) => {
        compoundSaveStatus.dataset.campaignBytes = String(campaignBytes);
        compoundSaveStatus.dataset.battleBytes = String(battleBytes);
        compoundSaveStatus.dataset.state = 'saved';
        compoundSaveStatus.textContent = 'Campaign and battle checkpoint saved in this browser. Later campaign or battle changes are not included.';
      });
  }
  function loadCampaignBattle() {
    compoundPersistenceOperation('checkpoint-loading',
      (context) => campaignBattleActions.load(context),
      ({ campaignBytes, battleBytes, outcome }) => {
        compoundSaveStatus.dataset.campaignBytes = String(campaignBytes);
        compoundSaveStatus.dataset.battleBytes = String(battleBytes);
        compoundSaveStatus.dataset.state = 'loaded';
        compoundSaveStatus.textContent = outcome === 'ongoing'
          ? 'Campaign and battle checkpoint loaded. The restored battle is ready to continue.'
          : 'Campaign and battle checkpoint loaded. The restored terminal battle remains paused.';
        commandStatus.textContent = 'Campaign journeys and the prototype battle were restored together.';
        commandStatus.dataset.state = 'complete';
      });
  }
  function stopCampaign() {
    if (stopTask || closing || !core) return;
    const admitted = activeWork;
    let timer;
    // Publish before UI hooks can reenter Stop or fail during notification.
    stopTask = Promise.resolve().then(async () => {
      const failures = [];
      if (admitted) {
        try {
          await admitted;
        } catch (error) {
          failures.push(describeFailure(error));
        }
      }
      failures.push(...(await cleanup()));
      if (closing) {
        // pagehide or an earlier failure may have won while storage/cleanup
        // was pending. Stop must not replace that terminal lifecycle.
        clearTimeout(timer);
        return;
      }
      closing = true;
      const reportedTerminalFailures = terminalCleanupErrors.length;
      terminalUpdate(() => { status.dataset.ready = 'false'; });
      terminalUpdate(() => setPhase('stopped'));
      terminalUpdate(disableControls);
      clearTimeout(timer);
      const saved = currentIsSaved();
      terminalUpdate(showSaveState);
      failures.push(...terminalCleanupErrors.slice(reportedTerminalFailures));
      if (failures.length || persistenceUnknown) {
        terminalUpdate(() => { saveStatus.dataset.state = 'error'; });
        terminalUpdate(() => { saveStatus.textContent = `Campaign closed with an unconfirmed or failed save operation.\n${failures.join('\n')}`; });
      } else {
        terminalUpdate(() => { saveStatus.dataset.state = 'stopped'; });
        terminalUpdate(() => { saveStatus.textContent = saved
          ? 'Stopped. The current saved campaign is closed; reload this page and Load to continue.'
          : 'Stopped. Unsaved changes were not written; the previous completed save remains available.'; });
      }
      terminalUpdate(() => { status.textContent = 'OpenRTW campaign stopped.'; });
    }).catch((error) => {
      clearTimeout(timer);
      fail(error);
    });
    terminalUpdate(() => setPhase('stopping'));
    terminalUpdate(disableControls);
    terminalUpdate(() => { saveStatus.dataset.state = 'stopping'; });
    terminalUpdate(() => { saveStatus.textContent =
      'Stopping: waiting for admitted storage work, then closing the campaign…'; });
    if (battleView?.active) disposeBattleForTerminal(battleView);
    timer = watchPersistence('Stop');
  }
  function command(action) {
    if (!canInteract()) return false;
    try {
      const before = sessionWire,
        result = action();
      if (result !== 0 && result !== 1)
        throw new Error('Core campaign command returned an invalid status');
      if (result !== 1) {
        if (sessionText() !== before)
          throw new Error('Refused command changed the core campaign snapshot');
        commandStatus.textContent =
          core.UTF8ToString(core._openrtw_error()) || 'The core refused this command.';
        commandStatus.dataset.state = 'refused';
        return;
      }
      publishSession(readSession());
      restoreDestination();
      chooseList();
      showStatus();
      showSelected();
      showSaveState();
      updateControls();
      paint();
      if (status.dataset.ready !== 'true') return;
      if (target) previewRoute();
      if (status.dataset.ready !== 'true') return;
      const c = selected();
      commandStatus.textContent = c
        ? `Turn ${session.turn} · ${c.name}: ${c.x}, ${c.y} · AP ${c.actionPoints} / ${c.maxActionPoints}`
        : `Turn ${session.turn} · ${session.season} ${Math.abs(session.year)} ${session.year < 0 ? 'BC' : 'AD'}`;
      commandStatus.dataset.state = 'complete';
      return true;
    } catch (error) {
      fail(error);
    }
    return false;
  }
  let zoom = 1,
    panX = 0,
    panY = 0,
    drag = null,
    dragOrigin = null,
    moved = false,
    dragOrbit = false;
  let projected = [],
    view;
  let visualElapsedSeconds = 0,
    animationFrame = 0,
    lastAnimationWall = null,
    lastAnimationDraw = -Infinity;
  function animationPauseReason() {
    if (closing || !renderer || !campaignScene) return 'closed';
    if (phase !== 'running' || status.dataset.ready !== 'true') return phase;
    if (document.hidden) return 'hidden';
    if (layer.value !== '3d' && !(layer.value === 'world' && cameraKeys?.active))
      return 'map-layer';
    if (unitPreview?.isOpen || unitPreview?.busy || battleView?.active) return 'modal';
    if (!canvas.dataset.waterTexture && !cameraKeys?.active && !travel.active) return 'no-water';
    return null;
  }
  function publishWaterPlayback() {
    if (!canvas.dataset.waterAnimation) return;
    const state = JSON.parse(canvas.dataset.waterAnimation),
      reason = animationPauseReason();
    canvas.dataset.waterAnimation = JSON.stringify({
      ...state,
      running: animationFrame !== 0 && reason === null,
      pauseReason: reason,
    });
  }
  function animateCampaign(now) {
    animationFrame = 0;
    if (animationPauseReason() !== null) {
      lastAnimationWall = null;
      publishWaterPlayback();
      return;
    }
    const elapsed =
      lastAnimationWall === null
        ? 0
        : Math.max(0, Math.min(0.25, (now - lastAnimationWall) / 1000));
    visualElapsedSeconds += elapsed;
    lastAnimationWall = now;
    cameraKeys?.step(elapsed);
    const wasTravelling = travel.active;
    travel.sample(visualElapsedSeconds);
    if (wasTravelling && !travel.active) {
      updateControls();
      showSelection();
    }
    if (now - lastAnimationDraw >= 1000 / 30) {
      lastAnimationDraw = now;
      try {
        draw();
        refreshCampaignPointer();
      } catch (error) {
        fail(error);
        return;
      }
    }
    animationFrame = requestAnimationFrame(animateCampaign);
    publishWaterPlayback();
  }
  function syncWaterAnimation() {
    if (animationPauseReason() !== null) {
      if (animationFrame) cancelAnimationFrame(animationFrame);
      animationFrame = 0;
      lastAnimationWall = null;
      lastAnimationDraw = -Infinity;
    } else if (!animationFrame) animationFrame = requestAnimationFrame(animateCampaign);
    publishWaterPlayback();
  }
  // Pages compose at most two per animation frame (the scene owns that budget;
  // failed pages wait out their back-off and are not pending). While visible
  // pages are pending and no water-animation frame will draw anyway, request
  // one more paint.
  let aerialFrame = 0;
  function scheduleAerialCompose() {
    if (aerialFrame || animationFrame || !campaignScene?.aerialStatus()?.pending) return;
    aerialFrame = requestAnimationFrame(() => {
      aerialFrame = 0;
      const reason = animationPauseReason();
      if (animationFrame || (reason !== null && reason !== 'no-water')) return;
      paint();
    });
  }
  function draw() {
    canvas.dataset.travelPlayback = JSON.stringify({
      active: travel.active,
      poses: travel.sample(visualElapsedSeconds),
    });
    if (layer.value === '3d') {
      campaignScene.draw({
        characters: characters.map((c) => ({
          ...c,
          hasHastati: hastatiActors.has(c.id),
          strength: initialBannerStrength.get(c.id) ?? null,
          modelKey:
            c.faction === 'romans_julii' && c.type === 'named character' && c.subFaction === null
              ? 'roman-general-julii'
              : hastatiActors.has(c.id)
                ? 'hastati-candidate'
                : null,
        })),
        selectedId,
        travelPoses: travel.sample(visualElapsedSeconds),
        movementRange: movementRangeForSelection(),
        target: pointerRoute?.target ?? target,
        route:
          pointerRoute ??
          (routeMatchesCurrent(selected()) &&
          route.status === 'ok' &&
          !routeAdmission(selected(), route)
            ? route
            : null),
        faction: factionSelect.value,
        timeSeconds: visualElapsedSeconds % 86400,
      });
      campaignLabels.update(campaignScene, fog);
      publishWaterPlayback();
      scheduleAerialCompose();
      return;
    }
    campaignLabels.hide();
    canvas.dataset.scene = layer.value;
    delete canvas.dataset.trees;
    delete canvas.dataset.banners;
    delete canvas.dataset.coastline;
    delete canvas.dataset.fogRendering;
    delete canvas.dataset.fogVisibility;
    delete canvas.dataset.camera;
    delete canvas.dataset.projectedMarkers;
    delete canvas.dataset.unitTexture;
    delete canvas.dataset.terrainTextures;
    delete canvas.dataset.waterTexture;
    delete canvas.dataset.modelBindings;
    delete canvas.dataset.settlementBindings;
    delete canvas.dataset.movementRange;
    delete canvas.dataset.pickCandidates;
    renderer.setFvf(Fvf.XYZRHW | Fvf.DIFFUSE | Fvf.TEX1);
    renderer.setMaterialLighting({ enabled: false });
    renderer.setDirectionalLighting({ enabled: false });
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    for (const kind of [Transform.WORLD, Transform.VIEW, Transform.PROJECTION])
      renderer.setTransform(kind, identity);
    for (const state of [
      RenderState.ZENABLE,
      RenderState.ZWRITEENABLE,
      RenderState.ALPHATESTENABLE,
      RenderState.ALPHABLENDENABLE,
      RenderState.FOGENABLE,
      RenderState.SPECULARENABLE,
    ])
      renderer.setRenderState(state, 0);
    renderer.setRenderState(RenderState.CULLMODE, 1);
    renderer.setStageState(1, StageState.COLOROP, TextureOp.DISABLE);
    renderer.setStageState(0, StageState.ALPHAOP, TextureOp.SELECTARG1);
    renderer.setStageState(0, StageState.ALPHAARG1, TextureArg.TEXTURE);
    for (const state of [StageState.ADDRESSU, StageState.ADDRESSV])
      renderer.setStageState(0, state, Address.CLAMP);
    for (const state of [StageState.MAGFILTER, StageState.MINFILTER])
      renderer.setStageState(0, state, Filter.POINT);
    renderer.setStageState(0, StageState.MIPFILTER, Filter.NONE);
    const showRegions = layer.value === 'regions',
      showWorld = layer.value === 'world',
      mapWidth = showRegions || showWorld ? regionWidth : width,
      mapHeight = showRegions || showWorld ? regionHeight : height;
    const scale = Math.min(canvas.width / mapWidth, canvas.height / mapHeight) * zoom,
      w = mapWidth * scale,
      h = mapHeight * scale,
      left = (canvas.width - w) / 2 + panX,
      top = (canvas.height - h) / 2 + panY;
    view = { scale, left, top };
    renderer.clear({ color: 0xff0e1217 });
    renderer.setTexture(0, showWorld ? worldTexture : showRegions ? regionTexture : texture);
    renderer.setStageState(0, StageState.COLOROP, TextureOp.SELECTARG1);
    renderer.setStageState(0, StageState.COLORARG1, TextureArg.TEXTURE);
    const mapQuad = vertices([
      [left, top, 0, 0],
      [left + w, top, 1, 0],
      [left, top + h, 0, 1],
      [left + w, top + h, 1, 1],
    ]);
    const fogQuad = new Uint8Array(4 * 36),
      fogQuadView = new DataView(fogQuad.buffer);
    const mapQuadView = new DataView(mapQuad.buffer);
    for (let i = 0; i < 4; i++) {
      fogQuad.set(mapQuad.subarray(i * 28, (i + 1) * 28), i * 36);
      fogQuadView.setFloat32(i * 36 + 28, mapQuadView.getFloat32(i * 28 + 20, true), true);
      fogQuadView.setFloat32(i * 36 + 32, 1 - mapQuadView.getFloat32(i * 28 + 24, true), true);
    }
    mapFogTexture.update();
    mapFogTexture.bind();
    renderer.setFvf(Fvf.XYZRHW | Fvf.DIFFUSE | Fvf.TEX2);
    renderer.drawUP({
      vertices: fogQuad,
      vertexStride: 36,
      primitive: Primitive.TRIANGLESTRIP,
      primitiveCount: 2,
    });
    mapFogTexture.unbind();
    renderer.setFvf(Fvf.XYZRHW | Fvf.DIFFUSE | Fvf.TEX1);
    projected = (showRegions ? [] : characters)
      .filter(
        (c) =>
          fog.actorVisible(c.x, c.y) && (!factionSelect.value || c.faction === factionSelect.value)
      )
      .map((c) => ({
        ...c,
        px: left + (showWorld ? c.x + 0.5 : 2 * c.x + 1) * scale,
        py: top + (showWorld ? regionHeight - 1 - c.y + 0.5 : height - 1 - (2 * c.y + 1)) * scale,
      }))
      .filter((c) => c.px >= left && c.py >= top && c.px < left + w && c.py < top + h);
    const rectangle = (x0, y0, x1, y1, k) => [
      [x0, y0, 0, 0, k],
      [x1, y0, 0, 0, k],
      [x0, y1, 0, 0, k],
      [x1, y0, 0, 0, k],
      [x1, y1, 0, 0, k],
      [x0, y1, 0, 0, k],
    ];
    const markers = [];
    if (showWorld && routeMatchesCurrent(selected()) && route.status === 'ok') {
      const screen = (p) => [
          left + (p.x + 0.5) * scale,
          top + (regionHeight - 1 - p.y + 0.5) * scale,
        ],
        r = Math.max(0.5, Math.min(1.5, scale / 5));
      for (let i = 1; i < route.points.length; i++) {
        const a = screen(route.points[i - 1]),
          b = screen(route.points[i]);
        markers.push(
          ...rectangle(
            Math.min(a[0], b[0]) - r,
            Math.min(a[1], b[1]) - r,
            Math.max(a[0], b[0]) + r,
            Math.max(a[1], b[1]) + r,
            0xffffd57a
          )
        );
      }
    }
    markers.push(
      ...projected.flatMap((c) => rectangle(c.px - 2, c.py - 2, c.px + 3, c.py + 3, c.color))
    );
    const highlighted = projected.find((c) => c.id === selectedId);
    if (highlighted) {
      const { px: x, py: y, color: k } = highlighted;
      markers.push(
        ...rectangle(x - 6, y - 6, x + 6, y + 6, 0xffffd57a),
        ...rectangle(x - 3, y - 3, x + 3, y + 3, k)
      );
    }
    if (showWorld && target) {
      const x = left + (target.x + 0.5) * scale,
        y = top + (regionHeight - 1 - target.y + 0.5) * scale,
        r = Math.max(4, scale / 2),
        k = 0xff62e7da;
      markers.push(
        ...rectangle(x - r, y - r, x + r, y - r + 1, k),
        ...rectangle(x - r, y + r - 1, x + r, y + r, k),
        ...rectangle(x - r, y - r, x - r + 1, y + r, k),
        ...rectangle(x + r - 1, y - r, x + r, y + r, k)
      );
    }
    renderer.setTexture(0, 0);
    renderer.setStageState(0, StageState.COLORARG1, TextureArg.DIFFUSE);
    renderer.setStageState(0, StageState.ALPHAARG1, TextureArg.DIFFUSE);
    if (markers.length)
      renderer.drawUP({
        vertices: vertices(markers),
        vertexStride: 28,
        primitive: Primitive.TRIANGLELIST,
        primitiveCount: markers.length / 3,
      });
    renderer.setStageState(0, StageState.ALPHAARG1, TextureArg.TEXTURE);
    renderer.present();
    canvas.dataset.fogRendering = JSON.stringify(mapFogTexture.policy);
    canvas.dataset.fogVisibility = JSON.stringify({
      playerFaction,
      characters: projected.length,
      structureDraws: 0,
    });
  }
  function updateHud() {
    if (!campaignHud) return;
    let cameraFootprint = [];
    if (layer.value === '3d') {
      const frame = campaignScene.cameraFrame(),
        viewport = canvas.getBoundingClientRect(),
        hud = document.querySelector('#original-hud .hud-middle').getBoundingClientRect(),
        bottom = Math.max(0.001, Math.min(1, (hud.top - viewport.top) / viewport.height));
      cameraFootprint = groundFootprint(frame.combined, regionWidth, regionHeight, bottom);
    } else if (isCampaignLayer() && view?.scale > 0) {
      const left = Math.max(0, -view.left / view.scale),
        right = Math.min(regionWidth, (canvas.width - view.left) / view.scale),
        north = Math.min(regionHeight, regionHeight + view.top / view.scale),
        south = Math.max(0, regionHeight - (canvas.height - view.top) / view.scale);
      if (left < right && south < north)
        cameraFootprint = [
          { x: left, y: south },
          { x: right, y: south },
          { x: right, y: north },
          { x: left, y: north },
        ];
    }
    let army =
      armyPanel.hidden || !armyPanel.dataset.roster ? null : JSON.parse(armyPanel.dataset.roster);
    if (army) {
      const owner = selected();
      if (
        !owner ||
        army.actorId !== owner.id ||
        army.sourceFactionIndex !== owner.sourceFactionIndex ||
        army.sourceCharacterIndex !== owner.sourceCharacterIndex ||
        army.generation !== session.generation
      )
        throw protocolError('HUD army faction binding differs from the selected source actor');
      army = { ...army, faction: owner.faction };
    }
    campaignHud.update({
      characters,
      selectedId,
      selectedSettlement: settlementForHud(),
      army,
      calendar: status.textContent.split('\n')[0],
      initialTreasury: session.treasuries?.[playerFactionIndex] ?? campaign.factions[playerFactionIndex].denari,
      canContinue: !moveButton.disabled,
      canEndTurn: !endTurnButton.disabled,
      canSelect: !characterSelect.disabled,
      canMenu: canNavigate(),
      canNavigate: canNavigate(),
      cameraFootprint,
      canCenter: !centerButton.disabled,
      worldWidth: regionWidth,
      worldHeight: regionHeight,
      minimap: radarMap.rgba ? radarMap : { width, height, rgba },
      fog,
    });
  }
  const paint = () => {
    if (!renderer) return;
    try {
      draw();
      updateHud();
      refreshCampaignPointer();
    } catch (error) {
      fail(error);
    }
  };
  const position = (event) => {
    const r = canvas.getBoundingClientRect();
    if (layer.value !== '3d')
      return [
        ((event.clientX - r.left) * canvas.width) / r.width,
        ((event.clientY - r.top) * canvas.height) / r.height,
      ];
    const style = getComputedStyle(canvas),
      left = parseFloat(style.borderLeftWidth) || 0,
      right = parseFloat(style.borderRightWidth) || 0,
      top = parseFloat(style.borderTopWidth) || 0,
      bottom = parseFloat(style.borderBottomWidth) || 0;
    return [
      ((event.clientX - r.left - left) * canvas.width) / (r.width - left - right),
      ((event.clientY - r.top - top) * canvas.height) / (r.height - top - bottom),
    ];
  };
  // Hover is a read-only view. It never changes selection, orders, AP or fog.
  const tooltip = document.createElement('div');
  tooltip.id = 'campaign-hover';
  tooltip.setAttribute('role', 'tooltip');
  tooltip.hidden = true;
  const hoverTitle = document.createElement('div'),
    hoverCopy = document.createElement('div');
  tooltip.append(hoverTitle, hoverCopy);
  document.body.append(tooltip);
  let tooltipTitleFont = null,
    tooltipCopyFont = null,
    hoverPointer = null,
    pointerFrame = 0,
    hoverCache = null,
    pointerClosed = false,
    capturedPointerId = null;
  const inputOptions = pageInputOptions;
  const previousTabIndex = canvas.getAttribute('tabindex');
  function releaseCampaignCapture() {
    const id = capturedPointerId;
    capturedPointerId = null;
    if (id !== null && canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
  }
  function closePointer() {
    if (pointerClosed) return;
    pointerClosed = true;
    pageInputAbort.abort();
    const failures = [];
    const release = (run) => {
      try { run(); } catch (error) { failures.push(error); }
    };
    drag = dragOrigin = null;
    release(releaseCampaignCapture);
    release(clearPointer);
    release(() => tooltipTitleFont?.dispose());
    release(() => tooltipCopyFont?.dispose());
    tooltipTitleFont = tooltipCopyFont = null;
    release(() => tooltip.remove());
    release(() => cameraKeys?.dispose());
    cameraKeys = null;
    release(() => travel.dispose());
    delete canvas.dataset.travelPlayback;
    movementRangeCache = null;
    selectedSettlement = null;
    if (canvas.getAttribute('tabindex') === '0') {
      if (previousTabIndex === null) canvas.removeAttribute('tabindex');
      else canvas.setAttribute('tabindex', previousTabIndex);
    }
    refreshCampaignPointer = () => {};
    if (failures.length) throw new AggregateError(failures, 'Campaign pointer cleanup failed');
  }
  // Adopt the owner before the awaited HUD loads, including failure/close paths.
  closeViewport = closePointer;
  cameraKeys = createCampaignCameraKeys({
    document,
    view: window,
    canNavigate: () => canNavigate() && isCampaignLayer(),
    onActivity: () => syncCampaignAnimation?.(),
    onPan: (dx, dy) => {
      const bounds = canvas.getBoundingClientRect();
      dx *= canvas.width / bounds.width;
      dy *= canvas.height / bounds.height;
      if (layer.value === '3d') campaignScene.pan(dx, dy);
      else {
        panX += dx;
        panY += dy;
      }
    },
  });
  const categoryAt = (x, y) => categoryIds[y * regionWidth + x];
  const factionName = (value) => String(value ?? '').replaceAll('_', ' ');
  function groundTarget(p) {
    const cell =
      layer.value === '3d'
        ? campaignScene.pickCell(...p)
        : {
            x: Math.floor((p[0] - view.left) / view.scale),
            y: regionHeight - 1 - Math.floor((p[1] - view.top) / view.scale),
          };
    return cell && cell.x >= 0 && cell.y >= 0 && cell.x < regionWidth && cell.y < regionHeight
      ? { kind: 'ground', ...cell }
      : null;
  }
  function pointerTarget(event) {
    const p = position(event);
    // Labels are deliberately pointer-transparent; use their visible rectangles
    // without making an invisible overlay intercept camera dragging.
    if (layer.value === '3d') {
      for (const label of document.querySelectorAll('.openrtw-settlement-labels > span')) {
        if (label.hidden || label.style.display === 'none') continue;
        const r = label.getBoundingClientRect();
        if (
          event.clientX >= r.left &&
          event.clientX <= r.right &&
          event.clientY >= r.top &&
          event.clientY <= r.bottom
        ) {
          const id = settlementLabels.findIndex((row) => row.region === label.dataset.region);
          const source = settlementLabels[id];
          if (source && fog.labelVisible(source.x, source.y))
            return {
              kind: 'settlement',
              ...source,
              id,
              owned: source.sourceSection === playerFaction,
            };
        }
      }
    }
    let hit = layer.value === '3d' ? campaignScene.pickTarget(...p) : groundTarget(p);
    if (!hit) return null;
    // In the diagnostic world view objects occupy cells; 3D requires an actual
    // rendered-object hit so a terrain intersection cannot bypass occlusion.
    if (hit.kind === 'ground' && layer.value === 'world') {
      const actor = characters.find(
        (c) =>
          c.x === hit.x &&
          c.y === hit.y &&
          fog.actorVisible(c.x, c.y) &&
          (!factionSelect.value || c.faction === factionSelect.value)
      );
      if (actor) hit = { kind: 'character', actorId: actor.id, x: actor.x, y: actor.y };
      else {
        const id = settlementLabels.findIndex(
          (row) => row.x === hit.x && row.y === hit.y && fog.labelVisible(row.x, row.y)
        );
        if (id >= 0) hit = { kind: 'settlement', ...settlementLabels[id] };
      }
    }
    if (hit.kind === 'character') {
      const actor = characters.find((c) => c.id === hit.actorId && fog.actorVisible(c.x, c.y));
      return actor ? { ...hit, actor, owned: controllable(actor) } : null;
    }
    if (hit.kind === 'settlement' || hit.kind === 'port') {
      // Model object IDs include ports. Inspection IDs use settlement order.
      const id = settlementLabels.findIndex((row) => row.region === hit.region);
      const source = settlementLabels[id];
      return source && fog.labelVisible(hit.x, hit.y) && fog.labelVisible(source.x, source.y)
        ? { ...hit, id, name: source.name, owned: source.sourceSection === playerFaction }
        : null;
    }
    return hit;
  }
  function readAdvance(c, destination) {
    const before = sessionWire;
    const result = core._openrtw_preview_campaign_advance(
      c.id,
      destination.x,
      destination.y,
      session.generation,
      session.revision
    );
    if (result !== 0 && result !== 1) throw protocolError('Invalid hover route result');
    if (sessionText() !== before) throw protocolError('Hover preview changed the campaign');
    if (result === 0) return null;
    const address = core._openrtw_campaign_advance_json();
    if (!Number.isInteger(address) || address <= 0 || address >= core.HEAPU8.length)
      throw protocolError('Hover route unavailable');
    const wire = core.UTF8ToString(address, Math.min(8193, core.HEAPU8.length - address));
    if (wire.length > 8192) throw protocolError('Hover route exceeds bound');
    return validateRoute(JSON.parse(wire), c, destination);
  }
  function contextAt(event) {
    const hit = pointerTarget(event),
      c = selected();
    let preview = null,
      terrainReason = '';
    if (controllable(c) && hit?.kind === 'ground') {
      terrainReason =
        structureDestinationReason(hit) || movementTerrainReason(c, categoryAt(hit.x, hit.y));
      if (!terrainReason) {
        const key = [
          session.generation,
          session.revision,
          session.orderRevision,
          c.id,
          hit.x,
          hit.y,
        ].join(':');
        if (hoverCache?.key !== key) hoverCache = { key, route: readAdvance(c, hit) };
        preview = hoverCache.route;
        if (!preview) terrainReason = 'This route is unavailable.';
        if (preview?.status === 'ok') terrainReason = routeTerrainReason(c, preview, categoryAt);
      }
    }
    return {
      hit,
      preview,
      ...resolveCampaignInteraction({
        selected: c,
        controllable: controllable(c),
        target: hit,
        route: preview,
        routeReason: preview ? routeReasons[preview.status] : 'This route is unavailable.',
        terrainReason,
      }),
    };
  }
  function clearPointer(repaint = false) {
    if (pointerFrame) cancelAnimationFrame(pointerFrame);
    pointerFrame = 0;
    tooltip.hidden = true;
    delete canvas.dataset.hover;
    campaignHud?.setCursor('select');
    const hadRoute = Boolean(pointerRoute);
    pointerRoute = null;
    if (repaint && hadRoute && canInteract()) paint();
  }
  function updatePointer() {
    pointerFrame = 0;
    if (pointerClosed || !hoverPointer || !canInteract() || !isCampaignLayer() || document.hidden) {
      clearPointer();
      return;
    }
    if (drag && moved) {
      clearPointer();
      campaignHud?.setCursor('drag');
      return;
    }
    try {
      const context = contextAt(hoverPointer),
        { hit } = context;
      campaignHud?.setCursor(context.cursor);
      canvas.dataset.hover = JSON.stringify({
        kind: hit?.kind ?? null,
        hitPart: hit?.hitPart ?? null,
        actorId: hit?.actor?.id ?? null,
        settlementId: ['settlement', 'port'].includes(hit?.kind) ? hit.id : null,
        x: hit?.x ?? null,
        y: hit?.y ?? null,
        cursor: context.cursor,
        action: context.action,
        message: context.message,
        generation: session.generation,
        revision: session.revision,
        orderRevision: session.orderRevision,
      });
      const title =
        hit?.kind === 'character'
          ? `${hit.actor.name} · ${factionName(hit.actor.faction)}`
          : hit?.kind === 'settlement' || hit?.kind === 'port'
            ? `${hit.name}${hit.kind === 'port' ? ' · Port' : ''}`
            : '';
      const copy = context.message || '';
      if (tooltipTitleFont) tooltipTitleFont.set(title);
      else hoverTitle.textContent = title;
      if (tooltipCopyFont) tooltipCopyFont.set(copy);
      else hoverCopy.textContent = copy;
      hoverTitle.hidden = !title;
      tooltip.hidden = !hit || !(title || copy);
      if (!tooltip.hidden) {
        const rect = canvas.getBoundingClientRect();
        tooltip.style.left = `${Math.max(rect.left + 8, Math.min(hoverPointer.clientX + 22, rect.right - tooltip.offsetWidth - 8))}px`;
        tooltip.style.top = `${Math.max(rect.top + 8, Math.min(hoverPointer.clientY + 24, Math.min(rect.bottom, innerHeight) - tooltip.offsetHeight - 8))}px`;
      }
      const next = context.action === 'move' ? context.preview : null;
      if (next !== pointerRoute) {
        pointerRoute = next;
        paint();
      }
    } catch (error) {
      clearPointer();
      fail(error);
    }
  }
  refreshCampaignPointer = () => {
    if (pointerClosed) return;
    if (!canInteract() || !isCampaignLayer()) {
      clearPointer();
      return;
    }
    if (hoverPointer && !pointerFrame) pointerFrame = requestAnimationFrame(updatePointer);
  };
  function rememberPointer(event) {
    hoverPointer = { clientX: event.clientX, clientY: event.clientY };
    refreshCampaignPointer();
  }
  function selectHit(hit) {
    if (hit?.kind === 'character') {
      selectedId = hit.actor.id;
      characterSelect.value = String(selectedId);
      if (selectedSettlementId !== null) inspectSettlement(null);
      showSelection();
    } else if (hit?.kind === 'settlement' || hit?.kind === 'port') {
      selectedId = null;
      characterSelect.value = '';
      showSelection();
      inspectSettlement(hit.id);
    } else {
      selectedId = null;
      characterSelect.value = '';
      if (selectedSettlementId !== null) inspectSettlement(null);
      showSelection();
    }
  }
  function refusedInteraction(message) {
    commandStatus.textContent = message;
    commandStatus.dataset.state = 'refused';
    refreshCampaignPointer();
  }
  canvas.tabIndex = 0;
  canvas.addEventListener(
    'pointerdown',
    (event) => {
      rememberPointer(event);
      if (event.button !== 0 || !canNavigate() || drag) return;
      canvas.focus({ preventScroll: true });
      drag = position(event);
      dragOrigin = drag;
      moved = false;
      dragOrbit = event.altKey;
      capturedPointerId = event.pointerId;
      canvas.setPointerCapture(event.pointerId);
    },
    inputOptions
  );
  canvas.addEventListener(
    'pointermove',
    (event) => {
      if (drag && event.pointerId !== capturedPointerId) return;
      rememberPointer(event);
      if (!drag || !canNavigate()) return;
      const p = position(event);
      if (!moved && Math.hypot(p[0] - dragOrigin[0], p[1] - dragOrigin[1]) <= 3) return;
      moved = true;
      const dx = p[0] - drag[0],
        dy = p[1] - drag[1];
      if (layer.value === '3d') {
        if (dragOrbit) campaignScene.orbit(dx, dy);
        else campaignScene.pan(dx, dy);
      } else {
        panX += dx;
        panY += dy;
      }
      drag = p;
      clearPointer();
      campaignHud?.setCursor('drag');
      paint();
    },
    inputOptions
  );
  canvas.addEventListener(
    'pointerup',
    (event) => {
      if (event.button !== 0 || !drag || event.pointerId !== capturedPointerId) return;
      const wasDrag = moved;
      drag = dragOrigin = null;
      moved = false;
      releaseCampaignCapture();
      rememberPointer(event);
      if (wasDrag || !canInteract()) return;
      if (isCampaignLayer()) {
        selectHit(pointerTarget(event));
        return;
      }
      inspectDiagnosticView(position(event));
    },
    inputOptions
  );
  canvas.addEventListener(
    'contextmenu',
    (event) => {
      // The campaign owns its canvas context menu, including empty/blocked clicks.
      event.preventDefault();
      if (!canInteract() || !isCampaignLayer() || drag) return;
      rememberPointer(event);
      try {
        const context = contextAt(event);
        if (context.action === 'select' || context.action === 'inspect') {
          selectHit(context.hit);
          return;
        }
        if (context.action !== 'move') {
          if (context.message) refusedInteraction(context.message);
          return;
        }
        const c = selected(),
          { x, y } = context.hit;
        const sameDestination = c.destination?.x === x && c.destination?.y === y;
        const planned =
          sameDestination ||
          command(() =>
            core._openrtw_set_campaign_destination(
              c.id,
              x,
              y,
              session.generation,
              session.revision,
              session.orderRevision
            )
          );
        if (sameDestination) previewRoute();
        if (planned && !event.shiftKey) moveButton.click();
        refreshCampaignPointer();
      } catch (error) {
        fail(error);
      }
    },
    inputOptions
  );
  const cancelPointer = () => {
    drag = dragOrigin = null;
    releaseCampaignCapture();
    moved = false;
    hoverPointer = null;
    cameraKeys?.clear();
    clearPointer(true);
  };
  canvas.addEventListener('pointercancel', cancelPointer, inputOptions);
  canvas.addEventListener(
    'lostpointercapture',
    () => {
      if (drag) cancelPointer();
    },
    inputOptions
  );
  canvas.addEventListener(
    'pointerleave',
    () => {
      if (!drag) {
        hoverPointer = null;
        clearPointer(true);
      }
    },
    inputOptions
  );
  window.addEventListener('blur', cancelPointer, inputOptions);
  document.addEventListener(
    'visibilitychange',
    () => {
      if (document.hidden) cancelPointer();
    },
    inputOptions
  );
  canvas.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Escape' && canInteract()) {
        event.preventDefault();
        cancelPointer();
        selectHit(null);
      }
    },
    inputOptions
  );
  function inspectDiagnosticView(p) {
    if (layer.value === 'regions') {
      const x = Math.floor((p[0] - view.left) / view.scale),
        y = Math.floor((p[1] - view.top) / view.scale);
      if (x < 0 || y < 0 || x >= regionWidth || y >= regionHeight) return;
      if (!fog.terrainExplored(x, regionHeight - 1 - y)) {
        details.textContent = 'Unexplored region.';
        return;
      }
      const rgb = Array.from(
          regionRgb.subarray(3 * (y * regionWidth + x), 3 * (y * regionWidth + x) + 3)
        ),
        definition = regionsByColor.get(key(rgb));
      details.textContent = definition
        ? `${definition.id}\n${settlementVisible(definition.id) ? definition.field2 : 'Settlement outside current sight'}\nSource resources: ${definition.resources.join(', ')}\nRGB ${rgb.join(', ')} · image cell ${x}, ${y}\nSource line ${definition.line}`
        : `RGB ${rgb.join(', ')}\nImage cell ${x}, ${y}\nNo matching definition. Color meaning is still being reconstructed.`;
      return;
    }
    if (layer.value === 'world') {
      const x = Math.floor((p[0] - view.left) / view.scale),
        imageY = Math.floor((p[1] - view.top) / view.scale),
        y = regionHeight - 1 - imageY;
      if (x < 0 || y < 0 || x >= regionWidth || y >= regionHeight) return;
      const hit = projected.find((c) => c.x === x && c.y === y);
      if (hit) {
        selectedId = hit.id;
        characterSelect.value = String(selectedId);
        showSelection();
        return;
      }
      if (!fog.terrainExplored(x, y)) {
        detailTitle.textContent = 'World cell';
        details.textContent = 'Unexplored region.';
        return;
      }
      const index = worldIndices[y * regionWidth + x],
        rgb = world.palette[index],
        definition = regionsByColor.get(key(rgb));
      detailTitle.textContent = 'World cell';
      details.textContent = `World cell ${x}, ${y}\nRegion ${index}${definition ? ' · ' + definition.id : ''}\nGround category ${categoryIds[y * regionWidth + x]}${climateDetails(x, y)}\nRGB ${rgb.join(', ')}${definition && settlementVisible(definition.id) ? '\n' + definition.field2 : ''}${definition ? settlementDetails(definition.id) : ''}`;
      return;
    }
    const nearest = projected
      .map((c) => ({ ...c, d: Math.hypot(c.px - p[0], c.py - p[1]) }))
      .sort((a, b) => a.d - b.d)[0];
    if (nearest?.d <= 12) {
      selectedId = nearest.id;
      characterSelect.value = String(selectedId);
      showSelection();
      return;
    }
  }
  canvas.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      if (!canNavigate()) return;
      if (layer.value === '3d') campaignScene.zoom(Math.exp(event.deltaY * 0.001));
      else zoom = Math.max(0.25, Math.min(8, zoom * Math.exp(-event.deltaY * 0.001)));
      paint();
    },
    { passive: false, signal: pageInputAbort.signal }
  );
  centerButton.addEventListener('click', () => {
    const c = selected() ?? selectedSettlement;
    if (!canInteract() || centerButton.disabled || !isCampaignLayer() || !c) return;
    if (layer.value === '3d') {
      campaignScene.center(c.x, c.y);
      paint();
      return;
    }
    const scale = Math.min(canvas.width / regionWidth, canvas.height / regionHeight) * zoom;
    panX = (regionWidth / 2 - (c.x + 0.5)) * scale;
    panY = (regionHeight / 2 - (regionHeight - 1 - c.y + 0.5)) * scale;
    paint();
  }, pageInputOptions);
  reset.addEventListener('click', () => {
    if (!canInteract()) return;
    zoom = 1;
    panX = panY = 0;
    if (layer.value === '3d') campaignScene.reset();
    showSelection();
  }, pageInputOptions);
  factionSelect.addEventListener('change', () => {
    if (!canInteract()) return;
    chooseList();
    showSelection();
  }, pageInputOptions);
  characterSelect.addEventListener('change', () => {
    if (!canInteract()) return;
    selectedId = characterSelect.value === '' ? null : Number(characterSelect.value);
    showSelection();
  }, pageInputOptions);
  moveButton.addEventListener('click', () => {
    const c = selected();
    if (
      !canInteract() ||
      !c ||
      !target ||
      moveButton.disabled ||
      !routeMatchesCurrent(c) ||
      route.status !== 'ok'
    )
      return;
    const blocked = routeAdmission(c, route);
    if (blocked) {
      refusedInteraction(blocked);
      return;
    }
    const travelPlan = { actorId: c.id, points: route.points };
    const applied = command(() =>
      core._openrtw_continue_campaign_journey(
        c.id,
        session.generation,
        session.revision,
        session.orderRevision
      )
    );
    if (applied) presentCommittedTravel([travelPlan]);
  }, pageInputOptions);
  cancelButton.addEventListener('click', () => {
    const c = selected();
    if (!canInteract() || cancelButton.disabled || !c?.destination) return;
    command(() =>
      core._openrtw_cancel_campaign_destination(
        c.id,
        session.generation,
        session.revision,
        session.orderRevision
      )
    );
  }, pageInputOptions);
  factionJourneyButton.addEventListener('click', continueFactionJourneys, pageInputOptions);
  endTurnButton.addEventListener('click', () => {
    if (!canInteract() || endTurnButton.disabled) return;
    command(() => core._openrtw_end_turn(session.generation, session.revision));
  }, pageInputOptions);
  battleOpponent.addEventListener('change', updateControls, pageInputOptions);
  battleButton.addEventListener('click', async () => {
    if (!canInteract() || battleButton.disabled) return;
    const openedBattle = battleView;
    try {
      const player = selected(),
        enemyId = Number(battleOpponent.value);
      battleStatus.textContent = 'Opening battle…';
      await openedBattle.open({
        playerId: player.id,
        enemyId,
        campaignGeneration: session.generation,
        campaignRevision: session.revision,
        campaignOrderRevision: session.orderRevision,
      });
      if (!closing && phase === 'running' && battleView === openedBattle)
        battleStatus.textContent = openedBattle.active
          ? 'Battle open. Return to continue this campaign.'
          : document.querySelector('[data-battle-status]').textContent;
    } catch (error) {
      if (!closing && phase === 'running' && battleView === openedBattle)
        battleStatus.textContent = describeFailure(error);
    } finally {
      if (!closing && battleView === openedBattle) updateControls();
    }
  }, pageInputOptions);
  // Validates the additive completed-production presentation against the
  // selected source identity and the live production city. The legacy fields
  // (level, buildings, fieldSource) remain untouched source provenance.
  function presentationForSettlement(s, id, expected) {
    const presentation = s.presentation;
    if (!session.productionEnabled) {
      if (presentation !== undefined)
        throw protocolError('Settlement inspection leaked a production presentation');
      return null;
    }
    if (
      !presentation ||
      presentation.schema !== 'openrtw-settlement-presentation-v1' ||
      presentation.source !== 'completed-production' ||
      !unsigned(presentation.generation) ||
      presentation.generation !== session.generation ||
      !unsigned(presentation.revision) ||
      presentation.revision !== session.revision ||
      !unsigned(presentation.orderRevision) ||
      presentation.orderRevision !== session.orderRevision ||
      !unsigned(presentation.cityId) ||
      typeof presentation.level !== 'string' ||
      !presentation.level ||
      presentation.level.length > 128 ||
      !Array.isArray(presentation.buildings) ||
      presentation.buildings.length > 256 ||
      !Array.isArray(presentation.queued) ||
      presentation.queued.length > 64
    )
      throw protocolError('Settlement presentation disagrees with the current production session');
    const completed = new Set();
    for (const building of presentation.buildings) {
      if (
        !building ||
        typeof building.chain !== 'string' ||
        !building.chain ||
        building.chain.length > 128 ||
        typeof building.level !== 'string' ||
        !building.level ||
        building.level.length > 128 ||
        completed.has(`${building.chain}:${building.level}`)
      )
        throw protocolError('Settlement presentation completed building is invalid');
      completed.add(`${building.chain}:${building.level}`);
    }
    for (const job of presentation.queued)
      if (
        !job ||
        typeof job.chain !== 'string' ||
        !job.chain ||
        job.chain.length > 128 ||
        typeof job.level !== 'string' ||
        !job.level ||
        job.level.length > 128 ||
        !unsigned(job.remaining) ||
        !unsigned(job.total) ||
        job.total < 1 ||
        job.remaining > job.total
      )
        throw protocolError('Settlement presentation queued job is invalid');
    if (typeof core._openrtw_production_json !== 'function')
      throw protocolError('Production city inspection is unavailable');
    const pointer = core._openrtw_production_json(presentation.cityId, session.generation);
    if (!pointer)
      throw protocolError(
        core.UTF8ToString(core._openrtw_error()) || 'Production city is unavailable'
      );
    const city = JSON.parse(core.UTF8ToString(pointer, 4 * 1024 * 1024));
    if (
      city.schema !== 'openrtw-production-v1' ||
      city.cityId !== presentation.cityId ||
      city.generation !== session.generation ||
      city.region !== expected.region ||
      city.level !== presentation.level ||
      !Array.isArray(city.buildings) ||
      !Array.isArray(city.construction) ||
      city.construction.length !== presentation.queued.length
    )
      throw protocolError('Production city mapping differs from the inspected settlement');
    for (const building of presentation.buildings)
      if (
        !city.buildings.some(
          (row) =>
            row?.chain === building.chain &&
            row.level === building.level &&
            row.built === true
        )
      )
        throw protocolError('Settlement presentation completed building is not built');
    const matched = new Set();
    for (const job of presentation.queued) {
      const index = city.construction.findIndex((row, i) => {
        const definition = city.buildings[row?.definition];
        return (
          !matched.has(i) &&
          definition?.chain === job.chain &&
          definition.level === job.level &&
          row.remaining === job.remaining &&
          row.total === job.total
        );
      });
      if (index < 0) throw protocolError('Settlement presentation queued job is not queued');
      matched.add(index);
    }
    return presentation;
  }
  // HUD and building cards accept the existing level/building.source contract.
  // Completed production rows are normalized here; queued work is never built.
  function settlementForHud() {
    const s = selectedSettlement,
      p = s?.presentation;
    if (!p) return s;
    // Accepted movement/order edits advance revision/orderRevision before the
    // asynchronous reselect completes. Never hand stale completed tokens to
    // the HUD; the legacy source projection is the honest interim display.
    if (
      p.generation !== session.generation ||
      p.revision !== session.revision ||
      p.orderRevision !== session.orderRevision
    )
      return s;
    return {
      ...s,
      level: p.level,
      buildings: p.buildings.map((building) => ({
        chain: building.chain,
        level: building.level,
        built: true,
        source: [{ line: s.line, text: `type ${building.chain} ${building.level}` }],
        provenance: 'completed-production',
      })),
    };
  }
  function refreshSelectedSettlementInspection() {
    if (selectedSettlementId === null) return;
    inspectSettlement(selectedSettlementId, { refresh: true });
  }
  // The HUD passes a settlement id; production commands address a production
  // city id. They are not assumed equal: the validated presentation supplies
  // the city and its region must match the selected source settlement.
  function productionCityIdForSelection(settlementId = selectedSettlementId) {
    if (!session.productionEnabled) return null;
    const s = selectedSettlement;
    if (settlementId !== selectedSettlementId || !s) return null;
    const presentation = s.presentation;
    if (!presentation || !unsigned(presentation.cityId))
      throw protocolError('Selected settlement has no production city');
    if (typeof core._openrtw_production_json !== 'function')
      throw protocolError('Production city inspection is unavailable');
    const pointer = core._openrtw_production_json(presentation.cityId, session.generation);
    if (!pointer)
      throw protocolError(
        core.UTF8ToString(core._openrtw_error()) || 'Production city is unavailable'
      );
    const city = JSON.parse(core.UTF8ToString(pointer, 4 * 1024 * 1024));
    if (
      city.schema !== 'openrtw-production-v1' ||
      city.cityId !== presentation.cityId ||
      city.generation !== session.generation ||
      city.region !== s.region
    )
      throw protocolError('Production city mapping differs from the selected settlement');
    return presentation.cityId;
  }
  function openProductionForSettlement(settlementId) {
    if (!canInteract() || settlementId !== selectedSettlementId) return;
    const city = productionCityIdForSelection(settlementId);
    if (city === null) return;
    document.body.classList.remove('tools-collapsed');
    campaignProductionView?.refresh(city);
    document.querySelector('#campaign-production')?.scrollIntoView({ block: 'start' });
  }
  // The production panel is also refreshed from ordinary control updates. It
  // must use the same validated city mapping, and hide rather than open a
  // stale/disabled selection. A successful mapping is cached per inspection
  // object so frequent control updates do not repeat the core JSON query.
  let productionViewMapping = { source: null, value: null };
  function productionViewCityId() {
    if (!session.productionEnabled || selectedSettlementId === null) return null;
    const source = selectedSettlement;
    if (productionViewMapping.source === source && productionViewMapping.value !== null)
      return productionViewMapping.value;
    let value = null;
    try {
      value = productionCityIdForSelection(selectedSettlementId);
    } catch {
      value = null;
    }
    if (value !== null) productionViewMapping = { source, value };
    return value;
  }
  function inspectSettlement(id, { refresh = false } = {}) {
    if (!refresh && !canInteract()) return;
    if (
      id !== null &&
      (!settlementLabels[id] || !fog.labelVisible(settlementLabels[id].x, settlementLabels[id].y))
    )
      return;
    try {
      const before = sessionText(),
        result =
          id === null
            ? core._openrtw_clear_settlement(session.generation)
            : core._openrtw_select_settlement(id, session.generation);
      if (sessionText() !== before)
        throw protocolError('Settlement inspection changed the campaign');
      if (result !== 0 && result !== 1) throw protocolError('Invalid settlement inspection result');
      if (result !== 1) {
        if (refresh) throw protocolError('Settlement inspection was refused');
        settlementSelect.value = selectedSettlementId === null ? '' : String(selectedSettlementId);
        settlementInfo.textContent = core.UTF8ToString(core._openrtw_error());
        return;
      }
      const pointer = core._openrtw_settlement_inspection_json();
      if (!pointer) throw protocolError('Settlement inspection is unavailable');
      const wire = core.UTF8ToString(pointer, 4 * 1024 * 1024),
        report = JSON.parse(wire),
        s = report.selected,
        expected = id === null ? null : settlementRows[id];
      if (
        report.schema !== 'openrtw-settlement-inspection-v1' ||
        report.campaignGeneration !== session.generation ||
        (id === null
          ? s !== null
          : !s ||
            s.id !== id ||
            !expected ||
            [
              'region',
              'level',
              'population',
              'yearFounded',
              'planSet',
              'factionCreator',
              'line',
              'sourceFaction',
              'sourceFactionIndex',
              'sourceSettlementIndex',
              'sourceFactionLine',
            ].some((k) => s[k] !== expected[k]) ||
            !Array.isArray(s.fieldSource) ||
            s.fieldSource.length !== 6 ||
            s.fieldSource.some(
              (r, i) => r.line !== expected.fieldLines[i] || typeof r.text !== 'string'
            ) ||
            !Array.isArray(s.buildings) ||
            s.buildings.length !== expected.buildingRecords ||
            s.buildings.some(
              (b) =>
                !unsigned(b.line) ||
                b.line === 0 ||
                !Array.isArray(b.source) ||
                b.source.some(
                  (r) => !unsigned(r.line) || r.line === 0 || typeof r.text !== 'string'
                )
            ))
      )
        throw protocolError('Settlement inspection differs from the source record');
      const presentation = s ? presentationForSettlement(s, id, expected) : null;
      selectedSettlementId = id;
      selectedSettlement = s
        ? {
            ...s,
            name: settlementLabels[id].name,
            x: settlementLabels[id].x,
            y: settlementLabels[id].y,
          }
        : null;
      if (s && !refresh) {
        selectedId = null;
        characterSelect.value = '';
        pointerRoute = null;
        restoreDestination();
        showSelected();
      }
      settlementSelect.value = id === null ? '' : String(id);
      settlementBuildings.replaceChildren();
      settlementInfo.dataset.inspection = wire;
      if (presentation) settlementInfo.dataset.presentation = JSON.stringify(presentation);
      else delete settlementInfo.dataset.presentation;
      if (!s) {
        settlementInfo.textContent = 'Choose a source settlement to inspect.';
      } else if (presentation) {
        settlementInfo.textContent = `${s.region}\n${presentation.level} · population ${s.population} · completed production\nSource faction section: ${s.sourceFaction}\nCreator field: ${s.factionCreator}\nFounded ${s.yearFounded} · plan ${s.planSet}\n${presentation.buildings.length} completed buildings${presentation.queued.length ? ` · ${presentation.queued.length} queued` : ''} · source line ${s.line}`;
        for (const building of presentation.buildings) {
          const item = document.createElement('li'),
            raw = document.createElement('pre');
          item.dataset.built = 'true';
          item.dataset.chain = building.chain;
          raw.textContent = `type ${building.chain} ${building.level}`;
          item.append(raw);
          settlementBuildings.append(item);
        }
        for (const job of presentation.queued) {
          const item = document.createElement('li'),
            raw = document.createElement('pre');
          item.dataset.queued = 'true';
          raw.textContent = `Queued (not built): ${job.chain} ${job.level} · ${job.remaining}/${job.total} turns`;
          item.append(raw);
          settlementBuildings.append(item);
        }
      } else {
        settlementInfo.textContent = `${s.region}\n${s.level} · population ${s.population}\nSource faction section: ${s.sourceFaction}\nCreator field: ${s.factionCreator}\nFounded ${s.yearFounded} · plan ${s.planSet}\n${s.buildings.length} building records · source line ${s.line}`;
        for (const building of s.buildings) {
          const item = document.createElement('li'),
            raw = document.createElement('pre');
          raw.textContent = building.source.map((row) => row.text).join('\n');
          item.append(raw);
          settlementBuildings.append(item);
        }
      }
      updateControls();
      paint();
    } catch (error) {
      if (refresh) throw error;
      fail(error);
    }
  }
  settlementSelect.addEventListener('change', () =>
    inspectSettlement(settlementSelect.value === '' ? null : Number(settlementSelect.value)),
    pageInputOptions
  );
  clearSettlement.addEventListener('click', () => inspectSettlement(null), pageInputOptions);
  layer.addEventListener('change', () => {
    if (!canInteract()) return;
    detailTitle.textContent = layer.value === 'regions' ? 'Region' : 'Character';
    if (layer.value === 'regions') details.textContent = 'Select a region color on the map.';
    showSelection();
    syncCampaignAnimation?.();
  }, pageInputOptions);
  saveButton.addEventListener('click', saveCampaign, pageInputOptions);
  loadButton.addEventListener('click', loadCampaign, pageInputOptions);
  if (typeof compoundSaveButton !== 'undefined' && typeof saveCampaignBattle === 'function') {
    compoundSaveButton.addEventListener('click', saveCampaignBattle, pageInputOptions);
    compoundLoadButton.addEventListener('click', loadCampaignBattle, pageInputOptions);
  }
  stopButton.addEventListener('click', stopCampaign, pageInputOptions);
  chooseList();
  showStatus();
  showSelected();
  draw();
  const openedHud = await createCampaignHud({
    mount: document.querySelector('#original-hud'),
    // The optional CUF path validates the descriptor and complete binary tables.
    // Existing sprite assets keep their exact admitted-source checks.
    readAsset: (name, options) =>
      name === 'campaignFontDb' || name === 'campaignCalendarFont'
        ? gameAssets.read(name, options)
        : asset(name, null, options),
    isOpen: () => !closing,
    cursorTarget: canvas,
    referenceLayout: originalCampaignHudReference,
    buildingAssets: campaignBuildingAssets ?? null,
    onProduction: productionUiModule ? openProductionForSettlement : null,
    onSelect: (id) => {
      const actor = characters.find((c) => c.id === id);
      if (!canInteract() || !actor) return;
      if (factionSelect.value && factionSelect.value !== actor.faction) factionSelect.value = '';
      selectedId = id;
      chooseList();
      showSelection();
    },
    onContinue: () => moveButton.click(),
    onEndTurn: () => endTurnButton.click(),
    onCenter: () => centerButton.click(),
    onMapNavigate: ({ x, y }) => {
      if (
        !canNavigate() ||
        !isCampaignLayer() ||
        !Number.isInteger(x) ||
        !Number.isInteger(y) ||
        x < 0 ||
        y < 0 ||
        x >= regionWidth ||
        y >= regionHeight
      )
        return;
      hoverPointer = hoverCache = null;
      clearPointer();
      if (layer.value === '3d') campaignScene.center(x, y);
      else {
        const scale = Math.min(canvas.width / regionWidth, canvas.height / regionHeight) * zoom;
        panX = (regionWidth / 2 - (x + 0.5)) * scale;
        panY = (y + 0.5 - regionHeight / 2) * scale;
      }
      paint();
    },
    onMenu: () => {
      document.body.classList.toggle('tools-collapsed');
    },
  });
  if (closing) {
    openedHud.dispose();
    throw new Error('OpenRTW page closed before HUD initialization completed');
  }
  campaignHud = openedHud;
  tooltipTitleFont = openedHud.createTextLabel?.(hoverTitle, 340, [255, 228, 151]) ?? null;
  tooltipCopyFont = openedHud.createTextLabel?.(hoverCopy, 520, [246, 239, 216]) ?? null;
  let resizeFrame = 0;
  const resizeObserver = new ResizeObserver(() => {
    if (closing || resizeFrame) return;
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0;
      if (closing || !renderer) return;
      try {
        fitViewport();
        paint();
      } catch (error) {
        fail(error);
      }
    });
  });
  closeViewport = () => {
    const failures = [];
    const release = (run) => {
      try { run(); } catch (error) { failures.push(error); }
    };
    release(closePointer);
    release(() => resizeObserver.disconnect());
    if (resizeFrame) release(() => cancelAnimationFrame(resizeFrame));
    resizeFrame = 0;
    if (aerialFrame) release(() => cancelAnimationFrame(aerialFrame));
    aerialFrame = 0;
    if (animationFrame) release(() => cancelAnimationFrame(animationFrame));
    animationFrame = 0;
    lastAnimationWall = null;
    document.removeEventListener('visibilitychange', syncWaterAnimation);
    syncCampaignAnimation = undefined;
    publishWaterPlayback();
    if (failures.length) throw new AggregateError(failures, 'Campaign viewport cleanup failed');
  };
  resizeObserver.observe(document.querySelector('#campaign-stage'));
  syncCampaignAnimation = syncWaterAnimation;
  document.addEventListener('visibilitychange', syncWaterAnimation, pageInputOptions);
  if (productionUiModule) {
    const mount = document.createElement('section');
    mount.id = 'campaign-production';
    settlementBuildings.closest('details').after(mount);
    campaignProductionView = productionUiModule.createProductionView({
      mount, core, getSession: () => session, canInteract, execute: command, playerFactionIndex,
    });
  }
  try {
    const contentFingerprint = await fingerprintSaveInputs([
      { id: 'terrain', bytes: terrainBytes },
      { id: 'campaign', bytes: campaignBytes },
      { id: 'regions', bytes: definitionBytes },
      { id: 'regionMap', bytes: mapBytes },
      { id: 'groundMap', bytes: groundBytes },
      { id: 'climates', bytes: climateDefinitionBytes },
      { id: 'climateMap', bytes: climateMapBytes },
      { id: 'unitDefinitions', bytes: unitDefinitionBytes },
      { id: 'battleModels', bytes: battleModelBytes },
      ...fogInputs.map(([id], index) => ({ id, bytes: fogInputBytes[index] })),
      ...(productionFactionBytes ? [{ id: 'productionFactionCultures', bytes: productionFactionBytes }] : []),
    ], { digestSha256: digest });
    requireOpen();
    const identity = createSaveIdentity({
      ...gameLaunchProfile.identity,
      payloadSchema: romeOriginalSavePayloadSchema,
      contentFingerprint,
    });
    try {
      campaignStore = createCampaignStorage({
        identity, allowLegacyCandidate: true, onFailure: storageFailure,
      });
      status.dataset.saveProfile = JSON.stringify(identity);
    } catch (error) { storageFailure(error); }
    if (checkpointCodec && createCheckpointActions) {
      try {
        const checkpointIdentity = createSaveIdentity({
          ...gameLaunchProfile.identity,
          payloadSchema: checkpointCodec.campaignBattleSavePayloadSchema,
          contentFingerprint,
        });
        campaignBattleStore = checkpointCodec.createCampaignBattleStorage({
          identity: checkpointIdentity, onFailure: compoundStorageFailure,
        });
        campaignBattleActions = createCheckpointActions({
          codec: checkpointCodec,
          store: campaignBattleStore,
          core,
          getView: () => battleView,
          readSession,
          publishSession: publishCheckpointSession,
          resetCampaign: resetCheckpointCampaign,
          protocolError,
        });
        status.dataset.campaignBattleSaveProfile = JSON.stringify(checkpointIdentity);
        compoundSaveStatus.textContent = 'Save or load this campaign together with its active prototype battle. Campaign-only saves stay separate.';
        compoundSaveStatus.dataset.state = 'ready';
      } catch (error) { compoundStorageFailure(error); }
    }
  } catch (error) {
    if (closing) throw error;
    storageFailure(error);
    if (checkpointCodec) compoundStorageFailure(error);
  }
  // Production is enabled after the first scene owner was admitted. Rebuild the
  // completed placement and stage validated owners before announcing ready; the
  // rebuild is still lease-bound and is skipped when no settlement inputs exist.
  if (settlementRefresh) {
    settlementRefresh.schedule('startup');
    await settlementRefresh.settled();
  }
  requireOpen();
  status.dataset.ready = 'true';
  status.dataset.terrainSha256 = inputPins.terrain;
  status.dataset.campaignSha256 = inputPins.campaign;
  status.dataset.groundSha256 = inputPins.groundMap;
  status.dataset.climatesSha256 = inputPins.climates;
  status.dataset.climateMapSha256 = inputPins.climateMap;
  setPhase('running');
  showSaveState();
  updateControls();
} catch (error) {
  // A cancelled startup belongs to the terminal close/failure already in
  // progress; its late rejection must not publish another lifecycle state.
  if (!closing) fail(error);
}
});
await initializationTask;
