#pragma once

#include "aerial_decals.hpp"
#include "categories.hpp"
#include "climates.hpp"
#include "terrain.hpp"

#include <cstdint>
#include <span>
#include <string>
#include <vector>

namespace openrtw {

struct CampaignTreeInstance {
    std::string path;
    std::string role; // sparse_tree, dense_tree, canopy
    std::uint32_t cellX = 0, cellY = 0, climate = 0;
    float x = 0, y = 0, z = 0;    // native cell units; unscaled source CAS geometry
    std::uint32_t swayGroup = 0;  // 0..19; no random rotation or scaling
    std::int32_t spriteIndex = 0; // descriptor value, for the native no-VS fallback
};

struct CampaignTreeScene {
    std::uint32_t width = 0, height = 0;
    bool winter = false, noTreeFlagsProvided = false, tileIdsProvided = false;
    std::uint32_t sparseCount = 0, denseCount = 0, canopyCount = 0;
    std::vector<CampaignTreeInstance> models;
    std::vector<std::string> modelPaths;
};

CampaignTreeScene build_campaign_trees(const ClimatePalette& palette,
                                       const ClimateCoefficientGrid& climates,
                                       const CategoryGrid& categories, const Terrain& terrain,
                                       bool winter, const AerialFlattening* flattening = nullptr,
                                       std::span<const std::uint8_t> noTrees = {},
                                       std::span<const std::uint16_t> tileIds = {});

// Stable JSON for the browser owner; models have the fields above, modelPaths
// is a deduplicated full path inventory under data/terrain/aerial_map/tree_models/.
std::string campaign_trees_json(const CampaignTreeScene& scene);

} // namespace openrtw
