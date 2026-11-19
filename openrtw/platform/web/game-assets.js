// Only the selected bootstrap inputs are addressable. Production local mode
// never requests hosted assets and never reads a whole audio bank or archive.
import { campaignBuildingFileSpecs } from './campaign-building-manifest.js';
const MiB = 1024 * 1024,
  maxFiles = 65536,
  maxPath = 4096;
const specs = Object.freeze({
  terrain: {
    path: 'data/world/maps/base/map_heights.hgt',
    route: '/assets/terrain.hgt',
    limit: 8 + 16 * MiB * 4,
  },
  campaign: {
    path: 'data/world/maps/campaign/imperial_campaign/descr_strat.txt',
    route: '/assets/campaign.txt',
    limit: 8 * MiB,
  },
  regions: {
    path: 'data/world/maps/base/descr_regions.txt',
    route: '/assets/regions.txt',
    limit: 8 * MiB,
  },
  regionMap: {
    path: 'data/world/maps/base/map_regions.tga',
    route: '/assets/regions.tga',
    limit: 18 + 16 * MiB * 3,
  },
  groundMap: {
    path: 'data/world/maps/base/map_ground_types.tga',
    route: '/assets/ground.tga',
    limit: 18 + 16 * MiB * 3,
  },
  climates: { path: 'data/descr_climates.txt', route: '/assets/climates.txt', limit: 8 * MiB },
  climateMap: {
    path: 'data/world/maps/base/map_climates.tga',
    route: '/assets/climates.tga',
    limit: 18 + 16 * MiB * 3,
  },
  pcm: {
    path: 'data/sounds/SFX.idx + data/sounds/SFX.dat (verified first member)',
    route: '/assets/marching.wav',
    limit: 29140,
  },
  unitDefinitions: {
    path: 'data/export_descr_unit.txt',
    route: '/assets/units.txt',
    limit: 2 * MiB,
  },
  battleModels: {
    path: 'data/descr_model_battle.txt',
    route: '/assets/battle-models.txt',
    limit: 2 * MiB,
  },
  hastati: {
    path: 'data/models_unit/unit_roman_hastati_lowest.CAS',
    route: '/assets/hastati.cas',
    limit: 41254,
  },
  campaignGeneral: {
    path: 'data/models_unit/officer_roman_general_high.CAS',
    route: '/assets/campaign-general.cas',
    limit: 52401,
  },
  campaignGeneralTexture: {
    path: 'data/models_strat/textures/officer_roman_general_julii.tga.dds',
    route: '/assets/campaign-general-texture.dds',
    limit: 21968,
  },
  romanLargeTown: {
    path: 'data/models_strat/residences/roman_large_town_buildings.CAS',
    route: '/assets/roman-large-town.cas',
    limit: 25434,
  },
  romanLargeTownTexture: {
    path: 'data/models_strat/residences/textures/set_rome_village.tga.dds',
    route: '/assets/roman-large-town-texture.dds',
    limit: 1520,
  },
  // path names the required carrier; limit bounds only the returned DDS member.
  hastatiTexture: {
    path: 'data/packs/models_unit_textures.pak',
    route: '/assets/hastati-texture.dds',
    limit: 87536,
  },
  terrainGrass: {
    path: 'data/terrain/aerial_map/ground_types/temperate_grassland.tga',
    route: '/assets/terrain-grass.tga',
    limit: 786476,
  },
  terrainHills: {
    path: 'data/terrain/aerial_map/ground_types/texture1_hilly.tga',
    route: '/assets/terrain-hills.tga',
    limit: 196652,
  },
  terrainWater: {
    path: 'data/terrain/aerial_map/water.TGA.dds',
    route: '/assets/terrain-water.dds',
    limit: 11064,
  },
  campaignHudLayout: {
    path: 'data/ui/strat3.rsd',
    route: '/assets/campaign-hud.rsd',
    limit: 84213,
  },
  campaignHudAtlas1: {
    path: 'data/ui/roman/interface/stratpage_01.tga',
    route: '/assets/campaign-hud-01.tga',
    limit: 1048620,
  },
  campaignHudAtlas2: {
    path: 'data/ui/roman/interface/stratpage_02.tga',
    route: '/assets/campaign-hud-02.tga',
    limit: 1048620,
  },
  campaignHudAtlas3: {
    path: 'data/ui/roman/interface/stratpage_03.tga',
    route: '/assets/campaign-hud-03.tga',
    limit: 243044,
  },
  campaignHudSharedLayout: {
    path: 'data/ui/shared2.rsd',
    route: '/assets/campaign-hud-shared.rsd',
    limit: 55161,
  },
  campaignHudSharedAtlas0: {
    path: 'data/ui/roman/interface/sharedpage_01.tga',
    route: '/assets/campaign-hud-shared-01.tga',
    limit: 1048620,
  },
  campaignHudSharedAtlas1: {
    path: 'data/ui/roman/interface/sharedpage_00.tga',
    route: '/assets/campaign-hud-shared-00.tga',
    limit: 377276,
  },
  unitCardJuliiGeneral: {
    path: 'data/ui/units/romans_julii/#roman_generals_guard_cavalry_early.tga',
    route: '/assets/unit-card-julii-general.tga',
    limit: 6881,
  },
  unitCardJuliiHastati: {
    path: 'data/ui/units/romans_julii/#roman_hastati.tga',
    route: '/assets/unit-card-julii-hastati.tga',
    limit: 7253,
  },
  unitCardJuliiTriarii: {
    path: 'data/ui/units/romans_julii/#roman_triarii.tga',
    route: '/assets/unit-card-julii-triarii.tga',
    limit: 8028,
  },
  unitCardJuliiArcher: {
    path: 'data/ui/units/romans_julii/#roman_archer.tga',
    route: '/assets/unit-card-julii-archer.tga',
    limit: 6752,
  },
});
// Optional native aerial decal images: every 32-bit underlay TGA under
// data/terrain/aerial_map/bases/ (path below bases/, exact bytes, SHA-256).
// descr_aerial_map_bases.txt names them relative to data/terrain/aerial_map/
// (9E8019 loads each registered "filename"); vanilla references 40 of the 52.
const aerialBaseImages = Object.freeze(
  [
    'forts/fort_barb_underlay.tga 19644 51d2a61ec49796b9d7e023ad96c84397ad22f5aacb79d9ad868dcd49b5d1e546',
    'forts/fort_eastern_underlay.tga 19644 9f9c437c9fba155c96e53f19394e5fbeb058de362af2d6cfdcd5835a65a9148e',
    'forts/fort_roman_underlay.tga 19644 9f9c437c9fba155c96e53f19394e5fbeb058de362af2d6cfdcd5835a65a9148e',
    'ports/set_barb_00_underlay.tga 7100 7abc714701190850998b0638f958f0dd6c31214965e715c9041185ff28f2541e',
    'ports/set_barb_01_underlay.tga 13500 962c2fe3950cc42f5933ed91797261418bfe70cbe98cfff08ea588ec04f8d50a',
    'ports/set_barb_02_underlay.tga 13500 962c2fe3950cc42f5933ed91797261418bfe70cbe98cfff08ea588ec04f8d50a',
    'ports/set_barb_03_underlay.tga 23760 f7ed11b355aa39820e40c5c04038c69ae6cdb3e2f998cf48cc8860246a87ef08',
    'ports/set_east_00_underlay.tga 7440 66ff46e458ec8aedbed8cd7b9777bea4f624aa9be446742cd63720b422abea44',
    'ports/set_east_01_underlay.tga 7440 66ff46e458ec8aedbed8cd7b9777bea4f624aa9be446742cd63720b422abea44',
    'ports/set_east_02_underlay.tga 12588 743fdc54770cc3c2cf1c975757bd90a97e8adc460c413d02a6760f04296d0e8a',
    'ports/set_east_03_underlay.tga 16428 c7b0e144e178209da2fbef9bd3dbff782610a7e7e34c72a25c34f417b80157db',
    'ports/set_rome_00_underlay.tga 7440 66ff46e458ec8aedbed8cd7b9777bea4f624aa9be446742cd63720b422abea44',
    'ports/set_rome_01_underlay.tga 7440 66ff46e458ec8aedbed8cd7b9777bea4f624aa9be446742cd63720b422abea44',
    'ports/set_rome_02_underlay.tga 12588 7da85f8aee36c6a315702bd2030709fa20c0abf90fc1118d3b1b98ab21964269',
    'ports/set_rome_03_underlay.tga 16428 feaac35c95e280d19b238c37e1d9a9135e5192047e0bc215f7e733bddf6842f0',
    'ports/underlay_default.tga 19644 f86050f48f20efa12db0f347944326beb4d04db3fcb8bc1d6fed6ec3cb85f21a',
    'ports/underlay_village.tga 12144 73751f35a32f3fcc40a0fa48ed54a2eceaa69d812abbd381d991f04b00319d42',
    'settlements/set_barb_00_underlay.tga 7100 1217c7bac278bc5d37f34526d8cb162dec91f2252286b716c961e34fc2f2ed27',
    'settlements/set_barb_00_wall_underlay.tga 7100 b15d5e345cd7fb36574f915551b898e216f061f894725106da877c6558e0fbae',
    'settlements/set_barb_01_underlay.tga 13500 55bf60ae765492877e15347d71004f890aadcf9b2e8a009e1b97ca9d7673d6f4',
    'settlements/set_barb_01_wall_underlay.tga 13500 e5ef8b6fcecb385013f539148d86c2ccff8d15336aa77234a80284178c1acfa2',
    'settlements/set_barb_02_underlay.tga 13500 962c2fe3950cc42f5933ed91797261418bfe70cbe98cfff08ea588ec04f8d50a',
    'settlements/set_barb_02_wall_underlay.tga 13500 272c24d9ce6e748c8c964eab4169182f3cc18c7502ac90bebcaed9455e184369',
    'settlements/set_barb_03_underlay.tga 23760 f7ed11b355aa39820e40c5c04038c69ae6cdb3e2f998cf48cc8860246a87ef08',
    'settlements/set_barb_03_wall_underlay.tga 23760 f357c78c58f024985cff91c2c612e191bab9caac2f219ac47f335374cef18b4d',
    'settlements/set_east_00_underlay.tga 7440 66ff46e458ec8aedbed8cd7b9777bea4f624aa9be446742cd63720b422abea44',
    'settlements/set_east_00_wall_underlay.tga 7440 66ff46e458ec8aedbed8cd7b9777bea4f624aa9be446742cd63720b422abea44',
    'settlements/set_east_01_underlay.tga 7440 66ff46e458ec8aedbed8cd7b9777bea4f624aa9be446742cd63720b422abea44',
    'settlements/set_east_01_wall_underlay.tga 7440 66ff46e458ec8aedbed8cd7b9777bea4f624aa9be446742cd63720b422abea44',
    'settlements/set_east_02_underlay.tga 12588 743fdc54770cc3c2cf1c975757bd90a97e8adc460c413d02a6760f04296d0e8a',
    'settlements/set_east_02_wall_underlay.tga 12588 743fdc54770cc3c2cf1c975757bd90a97e8adc460c413d02a6760f04296d0e8a',
    'settlements/set_east_03_underlay.tga 16428 c7b0e144e178209da2fbef9bd3dbff782610a7e7e34c72a25c34f417b80157db',
    'settlements/set_east_03_wall_underlay.tga 16428 c7b0e144e178209da2fbef9bd3dbff782610a7e7e34c72a25c34f417b80157db',
    'settlements/set_east_04_underlay.tga 19644 280bd218ec8536fe28da6735e7e16e7e9dfb6e18fe80cbe05bf97d132ed9c16f',
    'settlements/set_east_04_wall_underlay.tga 19644 280bd218ec8536fe28da6735e7e16e7e9dfb6e18fe80cbe05bf97d132ed9c16f',
    'settlements/set_east_05_underlay.tga 19644 280bd218ec8536fe28da6735e7e16e7e9dfb6e18fe80cbe05bf97d132ed9c16f',
    'settlements/set_east_05_wall_underlay.tga 19644 280bd218ec8536fe28da6735e7e16e7e9dfb6e18fe80cbe05bf97d132ed9c16f',
    'settlements/set_rome_00_underlay.tga 7440 66ff46e458ec8aedbed8cd7b9777bea4f624aa9be446742cd63720b422abea44',
    'settlements/set_rome_00_wall_underlay.tga 7440 66ff46e458ec8aedbed8cd7b9777bea4f624aa9be446742cd63720b422abea44',
    'settlements/set_rome_01_underlay.tga 7440 66ff46e458ec8aedbed8cd7b9777bea4f624aa9be446742cd63720b422abea44',
    'settlements/set_rome_01_wall_underlay.tga 7440 66ff46e458ec8aedbed8cd7b9777bea4f624aa9be446742cd63720b422abea44',
    'settlements/set_rome_02_underlay.tga 12588 7da85f8aee36c6a315702bd2030709fa20c0abf90fc1118d3b1b98ab21964269',
    'settlements/set_rome_02_wall_underlay.tga 12588 7da85f8aee36c6a315702bd2030709fa20c0abf90fc1118d3b1b98ab21964269',
    'settlements/set_rome_03_underlay.tga 16428 feaac35c95e280d19b238c37e1d9a9135e5192047e0bc215f7e733bddf6842f0',
    'settlements/set_rome_03_wall_underlay.tga 16428 feaac35c95e280d19b238c37e1d9a9135e5192047e0bc215f7e733bddf6842f0',
    'settlements/set_rome_04_underlay.tga 19644 ffdbc1167142df5d729142f94eb9f899a78728301abd13227dfd01dd318ee20e',
    'settlements/set_rome_04_wall_underlay.tga 19644 ffdbc1167142df5d729142f94eb9f899a78728301abd13227dfd01dd318ee20e',
    'settlements/set_rome_05_underlay.tga 19644 ffdbc1167142df5d729142f94eb9f899a78728301abd13227dfd01dd318ee20e',
    'settlements/set_rome_05_wall_underlay.tga 19644 ffdbc1167142df5d729142f94eb9f899a78728301abd13227dfd01dd318ee20e',
    'watchtowers/watchtower_barb_underlay.tga 7100 2d3cee1bf33757c877191727ed07ec55247639b82fa4d732ee3113d4ddca942e',
    'watchtowers/watchtower_eastern_underlay.tga 7100 2d3cee1bf33757c877191727ed07ec55247639b82fa4d732ee3113d4ddca942e',
    'watchtowers/watchtower_roman_underlay.tga 7100 2d3cee1bf33757c877191727ed07ec55247639b82fa4d732ee3113d4ddca942e',
  ].map((row) => {
    const [file, bytes, sha256] = row.split(' ');
    return Object.freeze([file, Number(bytes), sha256]);
  })
);
// Asset name of one image: aerialBase_<folder>_<file stem>.
const aerialBaseName = (file) => 'aerialBase_' + file.slice(0, -4).replace('/', '_');
const aerialBaseSpecs = Object.fromEntries(
  aerialBaseImages.map(([file, bytes]) => [
    aerialBaseName(file),
    {
      path: 'data/terrain/aerial_map/bases/' + file,
      route: '/assets/aerial/bases/' + file,
      limit: bytes,
    },
  ])
);
// Optional native aerial decal descriptors (bases table, culture bindings,
// faction cultures). Like the ground inputs they are only ever rejected, never
// a folder refusal; app.js drops decals (keeping the plain native ground) when
// a descriptor is missing and skips only the decal image that is missing.
const aerialDecalDescriptorSpecs = Object.freeze({
  aerialBases: {
    path: 'data/descr_aerial_map_bases.txt',
    route: '/assets/aerial/bases.txt',
    limit: 8226,
  },
  aerialCultures: {
    path: 'data/descr_cultures.txt',
    route: '/assets/aerial/cultures.txt',
    limit: 23933,
  },
  aerialFactionCultures: {
    path: 'data/descr_sm_factions.txt',
    route: '/assets/aerial/sm-factions.txt',
    limit: 17143,
  },
});
// Optional native aerial ground inputs (descriptor, 7 blend weights and the 17
// vanilla ground textures). They never block startup: app.js falls back to the
// grass/hills presentation when any of them is missing or refused. Two paths
// alias terrainGrass/terrainHills; both names then select the same file record.
const optionalSpecs = Object.freeze({
  ...Object.fromEntries(
    campaignBuildingFileSpecs.map(({ name, path, route, limit, bytes }) => [
      name,
      { path, route, limit: bytes ?? limit },
    ])
  ),
  campaignRadarMap1: {
    path: 'data/world/maps/campaign/imperial_campaign/radar_map1.tga',
    route: '/assets/radar-map1.tga',
    limit: 120120,
  },
  campaignRadarMap2: {
    path: 'data/world/maps/campaign/imperial_campaign/radar_map2.tga',
    route: '/assets/radar-map2.tga',
    limit: 477404,
  },
  campaignStandards: {
    path: 'data/descr_standards.txt',
    route: '/assets/banners/standards.txt',
    limit: 64 * 1024,
  },
  campaignBannerModel: {
    path: 'data/banners/strat_flag.cas',
    route: '/assets/banners/strat_flag.cas',
    limit: 4 * MiB,
  },
  campaignBannerTexture: {
    path: 'data/banners/strat_flag.tga.dds',
    route: '/assets/banners/strat_flag.dds',
    limit: 4 * MiB,
  },
  ...Object.fromEntries(
    Array.from({ length: 8 }, (_, i) => [
      `campaignBannerSymbols${i + 1}`,
      {
        path: `data/banners/symbols${i + 1}.tga.dds`,
        route: `/assets/banners/symbols${i + 1}.dds`,
        limit: 4 * MiB,
      },
    ])
  ),
  campaignWaterSurf: {
    path: 'data/terrain/aerial_map/sea/surf2b.tga.dds',
    route: '/assets/water-surf.dds',
    limit: 43856,
  },
  campaignCoastline: {
    path: 'data/terrain/aerial_map/sea/beach_strip.tga.dds',
    route: '/assets/coastline.dds',
    limit: 4 * MiB,
  },

  // Campaign visibility inputs. Their absence is reported independently of the
  // aerial terrain inputs; admission and source semantics belong to the core.
  campaignFogTraits: {
    path: 'data/export_descr_character_traits.txt',
    route: '/assets/fog-traits.txt',
    limit: 8 * MiB,
  },
  campaignFogAncillaries: {
    path: 'data/export_descr_ancillaries.txt',
    route: '/assets/fog-ancillaries.txt',
    limit: 8 * MiB,
  },
  campaignFogFeatures: {
    path: 'data/world/maps/base/map_features.tga',
    route: '/assets/fog-features.tga',
    limit: 18 + 16 * MiB * 3,
  },
  // Optional campaign calendar lettering. Descriptor selection and CUF format
  // admission belong to cuf-font.js; a missing font keeps the HUD text fallback.
  campaignFontDb: {
    path: 'data/descr_font_db.txt',
    route: '/assets/fonts/descr_font_db.txt',
    limit: 64 * 1024,
  },
  campaignCalendarFont: {
    path: 'data/fonts/sml_font_10.cuf',
    route: '/assets/fonts/sml_font_10.cuf',
    limit: 4 * MiB,
  },
  settlementBuildings: {
    path: 'data/export_descr_buildings.txt',
    route: '/assets/settlements/buildings.txt',
    limit: 8 * MiB,
  },
  settlementLighting: {
    path: 'data/descr_strategy_lighting.txt',
    route: '/assets/settlements/lighting.txt',
    limit: 64 * 1024,
  },
  aerialGroundTypes: {
    path: 'data/descr_aerial_map_ground_types.txt',
    route: '/assets/aerial/ground-types.txt',
    limit: 5221,
  },
  aerialWeight1: {
    path: 'data/terrain/aerial_map/template_weights/weights1.tga',
    route: '/assets/aerial/weights1.tga',
    limit: 719,
  },
  aerialWeight2: {
    path: 'data/terrain/aerial_map/template_weights/weights2.tga',
    route: '/assets/aerial/weights2.tga',
    limit: 719,
  },
  aerialWeight3: {
    path: 'data/terrain/aerial_map/template_weights/weights3.tga',
    route: '/assets/aerial/weights3.tga',
    limit: 719,
  },
  aerialWeight4: {
    path: 'data/terrain/aerial_map/template_weights/weights4.tga',
    route: '/assets/aerial/weights4.tga',
    limit: 719,
  },
  aerialWeight5: {
    path: 'data/terrain/aerial_map/template_weights/weights5.tga',
    route: '/assets/aerial/weights5.tga',
    limit: 719,
  },
  aerialWeight6: {
    path: 'data/terrain/aerial_map/template_weights/weights6.tga',
    route: '/assets/aerial/weights6.tga',
    limit: 719,
  },
  aerialWeight7: {
    path: 'data/terrain/aerial_map/template_weights/weights7.tga',
    route: '/assets/aerial/weights7.tga',
    limit: 719,
  },
  aerialTexture_temperate_grassland_farm: {
    path: 'data/terrain/aerial_map/ground_types/temperate_grassland_farm.tga',
    route: '/assets/aerial/ground/temperate_grassland_farm.tga',
    limit: 196652,
  },
  aerialTexture_arctic: {
    path: 'data/terrain/aerial_map/ground_types/arctic.tga',
    route: '/assets/aerial/ground/arctic.tga',
    limit: 786476,
  },
  aerialTexture_texture2: {
    path: 'data/terrain/aerial_map/ground_types/texture2.tga',
    route: '/assets/aerial/ground/texture2.tga',
    limit: 786476,
  },
  aerialTexture_temperate_grassland: {
    path: 'data/terrain/aerial_map/ground_types/temperate_grassland.tga',
    route: '/assets/aerial/ground/temperate_grassland.tga',
    limit: 786476,
  },
  aerialTexture_texture1: {
    path: 'data/terrain/aerial_map/ground_types/texture1.tga',
    route: '/assets/aerial/ground/texture1.tga',
    limit: 786476,
  },
  aerialTexture_texture1_hilly: {
    path: 'data/terrain/aerial_map/ground_types/texture1_hilly.tga',
    route: '/assets/aerial/ground/texture1_hilly.tga',
    limit: 196652,
  },
  aerialTexture_temperate_mountain_small: {
    path: 'data/terrain/aerial_map/ground_types/temperate_mountain_small.tga',
    route: '/assets/aerial/ground/temperate_mountain_small.tga',
    limit: 196652,
  },
  aerialTexture_temperate_hills_small: {
    path: 'data/terrain/aerial_map/ground_types/temperate_hills_small.tga',
    route: '/assets/aerial/ground/temperate_hills_small.tga',
    limit: 196652,
  },
  aerialTexture_swamp: {
    path: 'data/terrain/aerial_map/ground_types/swamp.tga',
    route: '/assets/aerial/ground/swamp.tga',
    limit: 196652,
  },
  aerialTexture_beach: {
    path: 'data/terrain/aerial_map/ground_types/beach.tga',
    route: '/assets/aerial/ground/beach.tga',
    limit: 196652,
  },
  aerialTexture_scorched: {
    path: 'data/terrain/aerial_map/ground_types/scorched.tga',
    route: '/assets/aerial/ground/scorched.tga',
    limit: 49196,
  },
  aerialTexture_alpine: {
    path: 'data/terrain/aerial_map/ground_types/alpine.tga',
    route: '/assets/aerial/ground/alpine.tga',
    limit: 786476,
  },
  aerialTexture_desert_rocky_low_fertility: {
    path: 'data/terrain/aerial_map/ground_types/desert_rocky_low_fertility.tga',
    route: '/assets/aerial/ground/desert_rocky_low_fertility.tga',
    limit: 786476,
  },
  aerialTexture_desert_rocky_medium_fertility: {
    path: 'data/terrain/aerial_map/ground_types/desert_rocky_medium_fertility.tga',
    route: '/assets/aerial/ground/desert_rocky_medium_fertility.tga',
    limit: 786476,
  },
  aerialTexture_desert_hills: {
    path: 'data/terrain/aerial_map/ground_types/desert_hills.tga',
    route: '/assets/aerial/ground/desert_hills.tga',
    limit: 786476,
  },
  aerialTexture_desert_mountains: {
    path: 'data/terrain/aerial_map/ground_types/desert_mountains.tga',
    route: '/assets/aerial/ground/desert_mountains.tga',
    limit: 786476,
  },
  aerialTexture_desert_sandy_medium_fertility: {
    path: 'data/terrain/aerial_map/ground_types/desert_sandy_medium_fertility.tga',
    route: '/assets/aerial/ground/desert_sandy_medium_fertility.tga',
    limit: 786476,
  },
  ...aerialDecalDescriptorSpecs,
  ...aerialBaseSpecs,
});
const allSpecs = Object.freeze({ ...specs, ...optionalSpecs });
const indexPath = 'data/sounds/sfx.idx',
  bankPath = 'data/sounds/sfx.dat';
const texturePackPath = 'data/packs/models_unit_textures.pak',
  texturePackBytes = 92289750;
const textureIndexBytes = 104614,
  textureMemberOffset = 81522822;
const textureIndexHash = '6c4c2c15d53909be58fe7cae904775d39254a6f4590b836382fc36b1c9a75dce';
const indexHex =
  '534e442e5041434b04000000a606000012040000f423170818000000d471000022560000100000000100000001000000646174612f736f756e64732f5346582f696e646976696475616c2f4d6f76656d656e742f4d61726368696e675f416d6269656e745f30322e77617600';
const bankHex = '534e442e5041434b04000000a606000012040000f4231708';
const fromHex = (text) => Uint8Array.from(text.match(/../g), (word) => parseInt(word, 16));
const indexPrefix = fromHex(indexHex),
  bankPrefix = fromHex(bankHex),
  memberOffset = 24,
  memberBytes = 29140;
const selectedHashes = Object.freeze({
  ...Object.fromEntries(campaignBuildingFileSpecs.map(({ name, sha256 }) => [name, sha256])),
  campaignRadarMap1: '1752a1f223c1559f4ba4c24b6a9cc1f2e0ec3351f786f20881217a50a1d0cf34',
  campaignRadarMap2: 'b67e168a3700ee1897045a1424e50fe09863b9ba6056bd4a46e827021409af4e',
  pcm: '5e5e8a2444d3262509217357edd4eae0fb8c2d33734d9dce19aa320f5e9dfd57',
  hastati: '61e9ad81bb33e9ec14a7b52473535e666ee0898498776f7ce2fa1d098fe2d27d',
  campaignGeneral: 'a85699cad84e0b5fa154f88efcf1d720dc10232612767f92937b4f788b1a3e0c',
  campaignGeneralTexture: '3768d9273e3ba4fc8005577b38f79714207260ca3f0160858fe02454f2116a8c',
  romanLargeTown: 'c7df731873dc764dc6cc98f6921f3339605f2db5ec6b4836215368afd9cb1997',
  romanLargeTownTexture: 'c06b1002d731b3a3040f324dcf138545acc6bd3bf4ce3bf1c8621197313d3724',
  hastatiTexture: '3ee5ad251dfb9a255fa103b1c4377b6ebf2b6d59d8e2583fffa0f2ec05338e1c',
  terrainGrass: 'a2ea50856b0f2f264d0bf7beaba099a372948fe4e84aa68791204d8bad8f8e4f',
  terrainHills: '3feaa43b3e8ba6bac9eb3b052acdf3e6c24323efc78a17b6811641d07ef067f4',
  terrainWater: '6874aa94fcfebec4121c60e0b9ce12a75213a847d0aa0a6ef4ca72c4aa29d3ac',
  campaignWaterSurf: 'be9a179b47a51630188d58f1382510a5f8ec1e10359fc2a6c0bc193bc9396710',
  campaignHudLayout: 'ca717e62c899a4d951ebe2c4aa15f8410f9a03f9efb22bf022d1a2651ea99dab',
  campaignHudAtlas1: '166b39b4686c7b8f0b83de844fbc60855faa8c542c6980332e6566538196b456',
  campaignHudAtlas2: 'ce659258e8a7dcd554eb93fec110d2863b6e2eec837eb3d6ea3d647c3e24d17e',
  campaignHudAtlas3: 'f80d66eba10963de9b9d44a914de3d4fd3e4a486b1ddf4c60238c746d50b608a',
  campaignHudSharedLayout: '0ce2f5d03b85cb67caa20c0f29cfd8b123d584d99e7b9d4bdd449cf80e1a8fd6',
  campaignHudSharedAtlas0: '0262dc1cac13b9bcdf2ea05c7e65942ffae8ec4e8f7bb10735fb9d552d041405',
  campaignHudSharedAtlas1: 'e2251c63fc279da6f41ee0112555d26f02bed88d968eea63d2f81fa7fa33c7cc',
  unitCardJuliiGeneral: 'f52c6a3c5914983c01aab34fef32a048a733189b27dfa07d1293a565cd688232',
  unitCardJuliiHastati: 'a911e7538af6a6c537718329a0f1a54251e67bf05447055639842504f8b3bcc4',
  unitCardJuliiTriarii: '158895488ef6eee6d4fbf285f42abb36eaac95476dfe766ad00d41cabd59ea5d',
  unitCardJuliiArcher: '7daaf1c23573d7e3a72e1796f3e029a0b572d4e12df4daee5610ed2721f14e66',
  aerialGroundTypes: '85584eb063c2cd260e9ba40b2694359c133e92abe24549e88747f06b7dece98f',
  aerialWeight1: '845f616c152cc19a3d2e2617e16a15c8300afe7fe40b8a1fa8a84a3404d2ac89',
  aerialWeight2: '654c4d54b1a86bd849fb4f7833f1314ff51d149ad320f32440074148efcea7f5',
  aerialWeight3: '489f03879e85566367845027d384d8a0279a98e206cabc31ce0a1b0498c3cb15',
  aerialWeight4: '28c9fe226048468b344dc2811ab4bbacc245ac9d6a903e00334787a218345794',
  aerialWeight5: 'be519e5bdb56f496d013bdc3a16734fcac644161002460d8cb47bb8792202026',
  aerialWeight6: 'b1e8d889c80d0c28fb81e44d02abb9c7b5220a9adffa4083cd3221eeefa1fe0a',
  aerialWeight7: '8489331f8b652d06a5745f8dcb850bff99ecae02d2e7d91d0d539c508af22cc7',
  aerialTexture_temperate_grassland_farm:
    '3e34f1a1cbf8c198259a04f64f6820ad75486a0ec195c42f7cc4e7158b96928b',
  aerialTexture_arctic: 'da1e66846158175be403cd140cfe8a74a3df054fb574bddd4456a3ab168f1804',
  aerialTexture_texture2: 'db177eefe8ebbbfe61353ab3d9230a409de293c9ec50cb9eaae09e944dfd9a05',
  aerialTexture_temperate_grassland:
    'a2ea50856b0f2f264d0bf7beaba099a372948fe4e84aa68791204d8bad8f8e4f',
  aerialTexture_texture1: '3c96ddf20b70369a60c1c8f33669ac0d0c5f389202d114954672fc452ce38d80',
  aerialTexture_texture1_hilly: '3feaa43b3e8ba6bac9eb3b052acdf3e6c24323efc78a17b6811641d07ef067f4',
  aerialTexture_temperate_mountain_small:
    'efa445ddcd6bfa225f46c1d4867a1f75639c0090ecace93939c350902d11198c',
  aerialTexture_temperate_hills_small:
    '38f3d7eda81f08ccc44fdbfb976b0e1f67c5b755434704e9c51057582107143e',
  aerialTexture_swamp: '26e33b02bf9d945fc2a825b18026b4df5abfbff1814793266a24aa86c9d041af',
  aerialTexture_beach: '2061cd09d0bd932f8d2a4f0d1ef2ecbd488f706cc4102164c2191e2138dae091',
  aerialTexture_scorched: '76ebfdcfb56a844ce53c20e3ddc29acebfc6f8cf8dc444df18d2f212fb140f8c',
  aerialTexture_alpine: '2b6cc7bd2ac0cab343112ccb6f6e03d37be60081238326d21e8dd736646592fb',
  aerialTexture_desert_rocky_low_fertility:
    '9226836ae5544b2fd66c175df4fb52e11e648da08d7569ac3c645a99541593db',
  aerialTexture_desert_rocky_medium_fertility:
    'e7640f88f9085b1c21cdac1706fa9ad4ee05eb38eb7db094369009ae41d79379',
  aerialTexture_desert_hills: '79b9e6a873946a438cf4e98f54e990fb74c9fc21b438cb2c0d791c7ceb0ae448',
  aerialTexture_desert_mountains:
    '77ee501a87430841d5752db9a5724cfbd851259bf90a6073bae9ab12cc59c08a',
  aerialTexture_desert_sandy_medium_fertility:
    '74a4ca51452a26a49dda6d62b77cf634f812d18e09ef0ca4f051d6f5835dcdb3',
  aerialBases: '8435229bfa7dc03636da63847f63b626ed33f7baeec5d6326bbe30889f915b9f',
  aerialCultures: '35856911e9452293ed264edc2bfd96a7417953b36480ec8e1b1258e5591861c8',
  aerialFactionCultures: '742d1dab51b4db14b187129ba261a58c4d6dd072ebbc7fdf7aaec31df46aa0d7',
  ...Object.fromEntries(aerialBaseImages.map(([file, , sha256]) => [aerialBaseName(file), sha256])),
});
const asciiLower = (text) => text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
const aerialDecalNames = new Set([
  ...Object.keys(aerialDecalDescriptorSpecs),
  ...Object.keys(aerialBaseSpecs),
]);
/** Paths of the optional native aerial GROUND inputs (descriptor, weights,
 * textures): the ground compositor needs every one of them. The decal inputs
 * below are excluded; their absence never disables the ground tiles. */
export const aerialGroundAssetPaths = Object.freeze(
  Object.keys(optionalSpecs)
    .filter((name) => name.startsWith('aerial') && !aerialDecalNames.has(name))
    .map((name) => optionalSpecs[name].path)
);
/** The optional decal inputs ({name, path, bytes, sha256}): the three
 * descriptors first, then the 52 bases/ images. Read them by name. */
export const aerialDecalAssets = Object.freeze(
  [...aerialDecalNames].map((name) =>
    Object.freeze({
      name,
      path: optionalSpecs[name].path,
      bytes: optionalSpecs[name].limit,
      sha256: selectedHashes[name],
    })
  )
);
const aerialBasePathNames = new Map(
  Object.keys(aerialBaseSpecs).map((name) => [optionalSpecs[name].path, name])
);
/** Asset name for a descr_aerial_map_bases.txt "filename" value (relative to
 * data/terrain/aerial_map/, matched ASCII case-insensitively with either path
 * separator), or null when it is none of the 52 pinned images. */
export function aerialBaseAssetName(filename) {
  if (typeof filename !== 'string' || filename.length === 0 || filename.length > 512) return null;
  const path = 'data/terrain/aerial_map/' + asciiLower(filename.replace(/\\/g, '/'));
  return aerialBasePathNames.get(path) ?? null;
}
function assetSpec(name) {
  if (typeof name !== 'string' || !Object.hasOwn(allSpecs, name))
    throw new Error(`Unknown game asset: ${String(name)}`);
  return allSpecs[name];
}
function aborted(signal) {
  if (signal?.aborted)
    throw signal.reason ?? new DOMException('Game asset read aborted', 'AbortError');
}
function checkSignal(signal) {
  if (
    signal !== undefined &&
    signal !== null &&
    (typeof signal.aborted !== 'boolean' ||
      typeof signal.addEventListener !== 'function' ||
      typeof signal.removeEventListener !== 'function')
  )
    throw new TypeError('Asset signal must be an AbortSignal');
  aborted(signal);
}
function equal(a, b) {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}
async function digest(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('');
}
async function verifySelected(name, bytes, signal) {
  aborted(signal);
  if (Object.hasOwn(selectedHashes, name)) {
    if (bytes.length !== allSpecs[name].limit)
      throw new Error(`Selected ${allSpecs[name].path} has an unexpected length`);
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
      b.toString(16).padStart(2, '0')
    ).join('');
    aborted(signal);
    if (hash !== selectedHashes[name])
      throw new Error(`Selected ${allSpecs[name].path} differs from the verified source`);
  }
  aborted(signal);
  return bytes;
}

async function boundedResponse(response, limit, signal) {
  const header = response.headers.get('Content-Length');
  let declared = null;
  if (header !== null) {
    if (!/^(0|[1-9][0-9]*)$/.test(header)) throw new Error('Invalid asset Content-Length');
    declared = Number(header);
    if (!Number.isSafeInteger(declared) || declared > limit)
      throw new Error('Asset Content-Length exceeds its input bound');
  }
  // Modern browser fetch exposes a stream. Refuse an unavailable stream rather
  // than allocate an unbounded arrayBuffer based only on a server's assertion.
  if (!response.body || typeof response.body.getReader !== 'function')
    throw new Error('Asset response has no bounded readable stream');
  const reader = response.body.getReader(),
    chunks = [];
  let total = 0,
    reads = 0,
    cancelTask = null;
  const cancel = (reason) =>
    (cancelTask ??= (async () => {
      try {
        await reader.cancel(reason);
      } catch {}
    })());
  const onAbort = () => {
    cancel(signal.reason);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    aborted(signal);
    for (;;) {
      const { done, value } = await reader.read();
      aborted(signal);
      if (done) break;
      if (++reads > 65536) throw new Error('Asset stream exceeds its chunk-count bound');
      if (!(value instanceof Uint8Array)) throw new Error('Asset stream returned non-byte data');
      if (
        value.byteLength > limit - total ||
        (declared !== null && value.byteLength > declared - total)
      )
        throw new Error('Asset stream exceeds its input bound');
      total += value.byteLength;
      chunks.push(new Uint8Array(value));
    }
    if (declared !== null && total !== declared)
      throw new Error('Asset response length disagrees with Content-Length');
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    aborted(signal);
    return bytes;
  } catch (error) {
    await cancel(error);
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (cancelTask) await cancelTask;
    reader.releaseLock();
  }
}

// Inventory-driven reads stay inside the player's strat-model directory. Metadata
// is indexed at folder selection; bytes are read only when the core names a model
// or its parsed material names a texture. No game files are part of the export.
export function campaignModelPath(path, kind = 'model') {
  const clean = normalizedPath(path).join('/');
  if (
    !(
      clean.startsWith('data/models_strat/') ||
      clean.startsWith('data/terrain/aerial_map/tree_models/')
    ) ||
    clean.length > 512 ||
    !/^[a-z0-9_#./ -]+$/.test(clean) ||
    !(kind === 'model' ? clean.endsWith('.cas') : kind === 'texture' && clean.endsWith('.tga.dds'))
  )
    throw new Error('Invalid campaign model asset path');
  return clean;
}
const modelLimit = (kind) => (kind === 'model' ? 8 : 16) * MiB;

export function createDevelopmentAssets({ fetchImpl = fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('Development assets require fetch');
  return {
    mode: 'development',
    async readModel(path, { signal, kind = 'model' } = {}) {
      const clean = campaignModelPath(path, kind);
      checkSignal(signal);
      const tree = clean.startsWith('data/terrain/aerial_map/tree_models/');
      const route =
        (tree ? '/assets/trees/' : '/assets/strat/') +
        clean
          .slice((tree ? 'data/terrain/aerial_map/tree_models/' : 'data/models_strat/').length)
          .split('/')
          .map(encodeURIComponent)
          .join('/');
      let response;
      try {
        response = await fetchImpl(route, { signal });
        aborted(signal);
        if (!response?.ok)
          throw new Error(`Cannot load ${clean}: HTTP ${response?.status ?? 'unknown'}`);
        return await boundedResponse(response, modelLimit(kind), signal);
      } catch (error) {
        if (response?.body && !response.body.locked)
          try {
            await response.body.cancel(error);
          } catch {}
        throw error;
      }
    },
    describe: () => ({
      mode: 'development',
      availableNames: Object.keys(specs),
      missingPaths: [],
      optionalNames: Object.keys(optionalSpecs),
      optionalMissingPaths: [],
      optionalRejected: [],
    }),
    async read(name, { signal } = {}) {
      const spec = assetSpec(name);
      checkSignal(signal);
      let response;
      try {
        response = await fetchImpl(spec.route, { signal });
        aborted(signal);
        if (!response?.ok)
          throw new Error(`Cannot load ${name}: HTTP ${response?.status ?? 'unknown'}`);
        const bytes = await boundedResponse(response, spec.limit, signal);
        const verified = await verifySelected(name, bytes, signal);
        aborted(signal);
        return verified;
      } catch (error) {
        if (response?.body && !response.body.locked)
          try {
            await response.body.cancel(error);
          } catch {}
        throw error;
      }
    },
  };
}

function normalizedPath(path) {
  if (
    typeof path !== 'string' ||
    path.length === 0 ||
    path.length > maxPath ||
    /[\x00-\x1f\x7f]/.test(path)
  )
    throw new Error('Selected file has an invalid relative path');
  const clean = path.replace(/\\/g, '/');
  if (clean.startsWith('/') || /^[a-zA-Z]:/.test(clean))
    throw new Error('Selected paths must be relative to the chosen folder');
  const parts = clean.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..'))
    throw new Error('Selected paths cannot contain empty or traversal components');
  return parts.map(asciiLower);
}
function rawPath(file) {
  return file.webkitRelativePath || file.name;
}
function inspectFile(file) {
  if (!file || typeof file.name !== 'string' || typeof file.slice !== 'function')
    throw new TypeError('Select browser File objects from your game folder');
  const path = rawPath(file),
    parts = normalizedPath(path);
  if (!Number.isSafeInteger(file.size) || file.size < 0 || !Number.isSafeInteger(file.lastModified))
    throw new Error(`Invalid selected file metadata: ${path}`);
  return { file, path, size: file.size, lastModified: file.lastModified, parts };
}
function stable(record) {
  if (
    record.file.size !== record.size ||
    record.file.lastModified !== record.lastModified ||
    rawPath(record.file) !== record.path
  )
    throw new Error(`Selected file changed during asset read: ${record.path}`);
}
// Blob I/O cannot be stopped, but cancellation must retire its caller promptly.
// Keep handlers on the underlying promise so late rejection remains observed.
function localBuffer(blob, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () => {
      try { aborted(signal); } catch (error) { finish(reject, error); }
    };
    try {
      signal?.addEventListener('abort', onAbort, { once: true });
      aborted(signal);
      Promise.resolve(blob.arrayBuffer()).then(
        (value) => finish(resolve, value),
        (error) => finish(reject, error)
      );
    } catch (error) { finish(reject, error); }
  });
}
async function fileSlice(record, start, length, signal) {
  aborted(signal);
  stable(record);
  if (start > record.size || length > record.size - start)
    throw new Error(`Selected file is incomplete: ${record.path}`);
  const blob = record.file.slice(start, start + length);
  if (!blob || blob.size !== length || typeof blob.arrayBuffer !== 'function')
    throw new Error(`Selected file slice is incomplete: ${record.path}`);
  const buffer = await localBuffer(blob, signal);
  aborted(signal);
  stable(record);
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== length)
    throw new Error(`Selected file read is incomplete: ${record.path}`);
  return new Uint8Array(buffer).slice();
}

export function createLocalGameAssets(files) {
  if (files === null || typeof files !== 'object')
    throw new TypeError('Select a game folder using the file picker');
  if (
    files.length !== undefined &&
    (!Number.isSafeInteger(files.length) || files.length < 0 || files.length > maxFiles)
  )
    throw new Error(`Selected folder exceeds ${maxFiles} file metadata entries`);
  const required = new Map(
    Object.entries(specs)
      .filter(([name]) => name !== 'pcm' && name !== 'hastatiTexture')
      .map(([name, spec]) => [asciiLower(spec.path), { name, limit: spec.limit, min: 1 }])
  );
  required.set(indexPath, {
    name: 'SFX.idx',
    limit: Number.MAX_SAFE_INTEGER,
    min: indexPrefix.length,
  });
  required.set(bankPath, {
    name: 'SFX.dat',
    limit: Number.MAX_SAFE_INTEGER,
    min: memberOffset + memberBytes,
  });
  required.set(texturePackPath, {
    name: 'hastatiTexture carrier',
    min: texturePackBytes,
    limit: texturePackBytes,
  });
  // Optional native aerial paths are recognized separately from the strict
  // required map: a wrong-sized, empty, duplicated or foreign-root optional file
  // is REJECTED (recorded in describe().optionalRejected and reported missing)
  // instead of refusing the whole folder, so app.js falls back to grass/hills.
  // A path that aliases a required entry (terrainGrass/terrainHills) stays
  // strict; aliased paths must agree on their exact byte bound.
  const optional = new Map();
  for (const [name, spec] of Object.entries(optionalSpecs)) {
    const key = asciiLower(spec.path),
      known = required.get(key);
    if (known && known.limit !== spec.limit)
      throw new Error(`Conflicting selected bounds for ${spec.path}`);
    if (!known) optional.set(key, { name, limit: spec.limit, min: 1 });
  }
  const selected = new Map(),
    rejected = new Map(),
    optionalRoots = new Map();
  let profileExecutable = null;
  let count = 0,
    selectedRoot = null;
  const add = (file) => {
    if (++count > maxFiles)
      throw new Error(`Selected folder exceeds ${maxFiles} file metadata entries`);
    const record = inspectFile(file),
      parts = record.parts;
    if (
      parts.length <= 2 &&
      parts[parts.length - 1] === 'rometw.exe'
    ) {
      if (profileExecutable) throw new Error('Duplicate selected executable path');
      profileExecutable = record;
      return;
    }
    // Match only Data/... or one selected game-folder/Data/... prefix. A game
    // folder itself named Data is handled by checking both permitted positions.
    let dataAt = -1,
      key,
      spec,
      isOptional = false;
    for (const at of [0, 1])
      if (parts[at] === 'data') {
        const candidate = parts.slice(at).join('/');
        if (required.has(candidate)) {
          dataAt = at;
          key = candidate;
          spec = required.get(candidate);
          break;
        }
        if (
          !optional.has(candidate) &&
          (candidate.startsWith('data/models_strat/') ||
            candidate.startsWith('data/terrain/aerial_map/tree_models/'))
        ) {
          const kind = candidate.endsWith('.cas') ? 'model' : 'texture';
          try {
            campaignModelPath(candidate, kind);
            optional.set(candidate, { name: candidate, min: 1, limit: modelLimit(kind) });
          } catch {
            /* Unrelated files in models_strat are not selected. */
          }
        }
        if (optional.has(candidate)) {
          dataAt = at;
          key = candidate;
          spec = optional.get(candidate);
          isOptional = true;
          break;
        }
      }
    if (dataAt < 0) return;
    const root = parts.slice(0, dataAt + 1).join('/');
    if (isOptional) {
      const reject = (reason) => {
        selected.delete(key);
        rejected.set(key, reason);
      };
      if (selected.has(key) || rejected.has(key)) return reject('duplicate selected path');
      if (selectedRoot !== null && selectedRoot !== root)
        return reject('outside the selected game folder');
      if (record.size < spec.min || record.size > spec.limit)
        return reject(`unsupported input size ${record.size} (expected ${spec.limit} bytes)`);
      selected.set(key, record);
      optionalRoots.set(key, root);
      return;
    }
    if (selected.has(key)) throw new Error(`Duplicate selected required path: ${key}`);
    if (selectedRoot !== null && selectedRoot !== root)
      throw new Error('Choose one game folder or its Data folder, not mixed roots');
    selectedRoot = root;
    if (record.size < spec.min || record.size > spec.limit)
      throw new Error(`Selected ${key} exceeds its supported input size or is incomplete`);
    selected.set(key, record);
  };
  if (typeof files[Symbol.iterator] === 'function') {
    for (const file of files) add(file);
  } else {
    if (files.length === undefined)
      throw new TypeError('Selected files must be iterable or a FileList-like array');
    for (let i = 0; i < files.length; i++) add(files[i]);
  }
  // Optional files selected before the first required file fixed the root.
  if (selectedRoot !== null)
    for (const [key, root] of optionalRoots)
      if (root !== selectedRoot && selected.has(key)) {
        selected.delete(key);
        rejected.set(key, 'outside the selected game folder');
      }
  if (
    profileExecutable &&
    selectedRoot !== null &&
    profileExecutable.parts.slice(0, -1).join('/') !==
      selectedRoot.split('/').slice(0, -1).join('/')
  )
    throw new Error('Choose an executable and Data folder from one game folder');
  const need = (path) => {
    const record = selected.get(asciiLower(path));
    if (!record) throw new Error(`Missing required game file: ${path}`);
    return record;
  };
  const needOptional = (path) => {
    const key = asciiLower(path),
      record = selected.get(key);
    if (record) return record;
    throw new Error(
      rejected.has(key)
        ? `Rejected optional game file (${rejected.get(key)}): ${path}`
        : `Missing optional game file: ${path}`
    );
  };
  const has = (name) =>
    name === 'pcm'
      ? selected.has(indexPath) && selected.has(bankPath)
      : selected.has(asciiLower(allSpecs[name].path));
  const optionalOnly = (name) => Object.hasOwn(optionalSpecs, name) && !Object.hasOwn(specs, name);
  return {
    mode: 'local',
    // Local compatibility probes use logical paths, never hosted routes. Keep
    // the existing selected-file bounds and metadata stability checks.
    async readFile(path, { maxBytes, signal } = {}) {
      checkSignal(signal);
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * MiB)
        throw new Error('Local profile read requires a positive bound up to 64 MiB');
      const clean = normalizedPath(path).join('/');
      const record = clean === 'rometw.exe' ? profileExecutable : selected.get(clean);
      if (!record) return null;
      if (record.size > maxBytes) throw new Error(`Profile input exceeds its bound: ${clean}`);
      return fileSlice(record, 0, record.size, signal);
    },
    async readModel(path, { signal, kind = 'model' } = {}) {
      const clean = campaignModelPath(path, kind);
      checkSignal(signal);
      const file = needOptional(clean);
      if (file.size > modelLimit(kind))
        throw new Error('Campaign model asset exceeds its input bound');
      return fileSlice(file, 0, file.size, signal);
    },
    describe: () => ({
      mode: 'local',
      selectedFileCount: count,
      availableNames: Object.keys(specs).filter(has),
      missingPaths: Object.keys(specs)
        .filter((name) => !has(name))
        .map((name) => specs[name].path),
      optionalNames: Object.keys(optionalSpecs).filter(has),
      optionalMissingPaths: Object.keys(optionalSpecs)
        .filter((name) => !has(name))
        .map((name) => optionalSpecs[name].path),
      optionalRejected: Object.keys(optionalSpecs)
        .filter((name) => rejected.has(asciiLower(optionalSpecs[name].path)))
        .map((name) => ({
          path: optionalSpecs[name].path,
          reason: rejected.get(asciiLower(optionalSpecs[name].path)),
        })),
    }),
    async read(name, { signal } = {}) {
      const spec = assetSpec(name);
      checkSignal(signal);
      let bytes;
      if (name === 'pcm') {
        const index = need('data/sounds/SFX.idx'),
          bank = need('data/sounds/SFX.dat');
        if (!equal(await fileSlice(index, 0, indexPrefix.length, signal), indexPrefix))
          throw new Error(
            'Selected data/sounds/SFX.idx prefix differs from the verified first member'
          );
        if (!equal(await fileSlice(bank, 0, bankPrefix.length, signal), bankPrefix))
          throw new Error('Selected data/sounds/SFX.dat prefix differs from the verified bank');
        bytes = await fileSlice(bank, memberOffset, memberBytes, signal);
        stable(index);
        stable(bank);
      } else if (name === 'hastatiTexture') {
        const pack = need(texturePackPath);
        // The exact admitted820-END index digest binds this one range. This is not
        // a generic PAK parser, a whole-pack hash, or a loose TGA substitution.
        const indexHash = await digest(await fileSlice(pack, 0, textureIndexBytes, signal));
        aborted(signal);
        stable(pack);
        if (indexHash !== textureIndexHash)
          throw new Error('Selected texture PAK index differs from the verified source');
        bytes = await fileSlice(pack, textureMemberOffset, spec.limit, signal);
      } else {
        const file = optionalOnly(name) ? needOptional(spec.path) : need(spec.path);
        bytes = await fileSlice(file, 0, file.size, signal);
      }
      bytes = await verifySelected(name, bytes, signal);
      // No source bytes are cached or returned by reference to a mutable input.
      // Recheck selected metadata after asynchronous digest verification as well.
      if (name === 'pcm') {
        stable(need('data/sounds/SFX.idx'));
        stable(need('data/sounds/SFX.dat'));
      } else stable(optionalOnly(name) ? needOptional(spec.path) : need(spec.path));
      aborted(signal);
      return bytes;
    },
  };
}
