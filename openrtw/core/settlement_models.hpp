#pragma once

#include "aerial_decals.hpp"
#include "categories.hpp"
#include "culture_models.hpp"

#include <array>
#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace openrtw {

struct BuildingModelLevels {
    std::vector<std::string> defenses;
    std::vector<std::string> ports;
};
// Bounded OpenRTW subset: only the top-level building declarations and their
// depth-one `levels` lines are interpreted; capability bodies stay opaque.
BuildingModelLevels load_building_model_levels(std::string_view text);

struct SettlementModelInstance {
    std::uint32_t objectId = 0;
    std::string kind, role, region, faction, culture, path;
    std::uint32_t x = 0, y = 0;
    std::int32_t level = 0, wall = -1;
    std::array<float, 16> matrix{};
};

struct SettlementModelScene {
    std::vector<SettlementModelInstance> models;
    std::vector<std::string> modelPaths;
    std::vector<std::string> problems;
    std::uint32_t settlementCount = 0, portCount = 0, fortCount = 0, watchtowerCount = 0;
    // portCount includes level-zero fishing villages; developedPortCount is
    // the subset backed by port_buildings (ten in the vanilla initial map).
    std::uint32_t fishingVillageCount = 0, developedPortCount = 0;
    std::uint32_t bannerCount = 0, garrisonBannerCount = 0;
    float bannerAnchorY = 0;
};

SettlementModelScene
build_settlement_models(const Campaign& campaign, const RegionDefinitions& regions,
                        std::span<const FactionCulture> factions, const CultureModelTable& cultures,
                        const BuildingModelLevels& buildings, const AerialRegionMarkers& markers,
                        const Terrain& terrain, const CategoryGrid& categories,
                        const AerialFlattening* flattening = nullptr,
                        float bannerAnchorY = 1.7109863758087158f,
                        std::span<const AerialMapObject> extraObjects = {});

// Stable wire shape shared by native tests and WASM. Flat models permit shared
// geometry/texture owners and grouping draws by material on the web side.
std::string settlement_models_json(const SettlementModelScene& scene);
std::string settlement_models_inventory_json(const SettlementModelScene& scene);

} // namespace openrtw
