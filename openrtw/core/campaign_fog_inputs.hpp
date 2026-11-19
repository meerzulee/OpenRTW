#pragma once

#include "campaign_fog.hpp"

#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace openrtw {

struct WorldGrid;
struct RegionDefinitions;
struct BuildingModelLevels;
struct RgbImage;

struct FogTraitLevel {
    std::string name;
    std::int32_t threshold = 0;
    std::int32_t lineOfSight = 0;
};
struct FogTrait {
    std::string name;
    std::vector<FogTraitLevel> levels;
};
struct FogTraits {
    std::vector<FogTrait> entries;
};
struct FogAncillary {
    std::string name;
    std::int32_t lineOfSight = 0;
};
struct FogAncillaries {
    std::vector<FogAncillary> entries;
};

// Owned, bounded ASCII subsets of export_descr_character_traits.txt and
// export_descr_ancillaries.txt. Read all named definitions, trait Thresholds,
// and Effect LineOfSight values. Other effects/metadata and Trigger bodies are
// outside this projection. Duplicate definitions, missing/nonascending trait
// thresholds, malformed/duplicate LOS effects, and resource excess refuse.
// An explicitly declared definition without LOS contributes zero. Unknown
// names referenced by campaign characters NEVER silently contribute zero.
// All allocations/validation complete before return; inputs are unchanged.
FogTraits load_campaign_fog_traits(std::string_view text);
FogAncillaries load_campaign_fog_ancillaries(std::string_view text);

struct CampaignFogInputs {
    CampaignFogTerrain terrain;
    std::vector<std::uint32_t> factionTables;
    // Flattened faction/character order, matching CampaignSession actor IDs.
    std::vector<std::int32_t> lineOfSight;
    // One record per admitted object, never one per CAS draw instance.
    std::vector<CampaignFogInitialStructure> structures;
    std::vector<std::uint32_t> landmarks;
    std::vector<std::string> limitations;
    std::string policy;
    // Versioned dual-FNV64 (32 hex digits), canonical little-endian resolved
    // inputs and policy. Compact noncryptographic regression binding, NOT an
    // authenticity/security digest. Session save separately binds Campaign.
    std::string identity;
};

// Explicit supported initial-source projection. Reads retained campaign
// traits/ancillaries/superfaction/landmark lines with their owning context.
// Initial Traits integers are one-based LEVELS (446CF3 -> 58F70E), capped at
// the last declared level. Zero has no effect; negative input is refused as
// bounded input policy. Add only that level's LOS and active ancillary LOS,
// not all earlier levels. A selected zero Threshold is a native no-op. All
// superfaction members AND the named host participate in one shared table,
// matching the native 4584F1 predicate used by 4C1674.
// Settlement region cells follow WorldGrid selected colors; ports use EDB
// ordinal+1 (clamped to 3), or level0 with no building. Admission uses the city
// core's nonzero marker plus native sea-neighbour supported projection.
// Features use canonical TOPLEFT rows and map red to 0x800 as an EXPLICIT
// INFERENCE; unknown bits15..16 are zero. These limitations are always emitted.
// No source views survive. Refusal throws and publishes no partial result.
CampaignFogInputs build_campaign_fog_inputs(const Campaign& campaign, const Terrain& heights,
                                            const CategoryGrid& categories, const WorldGrid& world,
                                            const RegionDefinitions& regions,
                                            const BuildingModelLevels& buildings,
                                            const RgbImage& features, const FogTraits& traits,
                                            const FogAncillaries& ancillaries);

} // namespace openrtw
