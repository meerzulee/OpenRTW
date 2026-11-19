#pragma once

#include "aerial_ground_registry.hpp"
#include "aerial_material_support.hpp"
#include "categories.hpp"
#include "climates.hpp"

#include <array>
#include <cstdint>
#include <vector>

namespace openrtw {

struct AerialPointClimateGrid {
    // HGT point dimensions (2W+1) x (2H+1); py grows north (HGT row order).
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    std::uint32_t definitionCount = 0;
    // ClimatePalette definition index per point, px + width*py.
    std::vector<std::uint8_t> indices;

    std::uint8_t index_at(std::uint32_t px, std::uint32_t py) const;
};

AerialPointClimateGrid build_aerial_point_climate_grid(const ClimatePalette& palette,
                                                       const RgbImage& climateMap);

struct AerialSeedGrid {
    std::uint32_t width = 0;  // cells W
    std::uint32_t height = 0; // cells H
    // seed(X,Y) per cell, X + width*Y (zero-extended 16-bit value).
    std::vector<std::uint16_t> seeds;

    std::uint16_t seed_at(std::uint32_t x, std::uint32_t y) const;
};

AerialSeedGrid build_aerial_seed_grid(std::uint32_t cellWidth, std::uint32_t cellHeight);

inline constexpr std::uint32_t aerial_pseudo_texture_index = 0xffffffffu;

struct AerialTileTable {
    // table[5*k + i]: k = x index 0..4 (west->east), i = y index 0..4 (south->north).
    std::array<AerialMaterialRecord, 25> records{};
    std::uint32_t offsetA = 0; // 30*X - 1 (mod 2^32)
    std::uint32_t offsetB = 0; // 30*(H - Y) - 1 (mod 2^32)
    std::uint32_t seed = 0;    // AerialSeedGrid::seed_at(X,Y)
    // At least one record carries aerial_pseudo_texture_index.
    bool pseudo = false;
};

AerialTileTable build_aerial_tile_table(const CategoryGrid& cells, const CategoryPointGrid& points,
                                        const AerialPointClimateGrid& climates,
                                        const AerialGroundTypes& groundTypes,
                                        const AerialSeedGrid& seeds, std::uint32_t x,
                                        std::uint32_t y, bool winter);

} // namespace openrtw
