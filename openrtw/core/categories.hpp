#pragma once

#include "regions.hpp"
#include "terrain.hpp"

#include <cstdint>
#include <vector>

namespace openrtw {

struct CategoryGrid {
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    // Neutral category IDs 0..14 in world order: x + width * y.
    // These own their storage; they are not original 52-byte cell records.
    std::vector<std::uint32_t> categories;

    std::uint32_t category_at(std::uint32_t x, std::uint32_t y) const;
};

// Recovered value path: 46E008 defines 14 BGR triples, projected here to RGB;
// 4737FE classifies a height point, and 4714C6/4710B1 select/remap its center
// for 47518D's DWORD cell+0x10 store. HGT row order joins canonical TOPLEFT
// ground RGB through pointY = pointHeight - 1 - topY. All 39780 categories
// of one owned BASE dataset match a retained stopped-AOT test projection.
//
// Inputs must have matching odd point dimensions >1, exact vector extents,
// finite raw height words and the existing parser resource bounds. These are
// portable API policies, not recovered native refusal limits. RgbImage pixels
// are already canonical; raw header origins/descriptors do not translate them.
// Only integer sign/zero classification is used: no original FP/CPU effects,
// cache-path selection, category names, coefficient/flags or movement parity
// are asserted. Returns complete owned data or throws std::runtime_error;
// inputs are never mutated and no captured grid is a runtime input.
CategoryGrid build_category_grid(const Terrain& heights, const RgbImage& ground);

struct CategoryPointGrid {
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    // One neutral ID0..14 for EVERY HGT point, x + width*y in HGT row order.
    std::vector<std::uint8_t> categories;

    std::uint8_t category_at(std::uint32_t x, std::uint32_t y) const;
};

// Recovered 4737FE point-bank byte+5 value path only: exact palette lookup,
// then ONE finite height-sign remap. Canonical TOPLEFT ground pixels join
// pointY = height-1-topY. This does not select cell centers or apply their
// second remap. Validation/resource policy is shared with build_category_grid.
// No complete native point-grid oracle, terrain materials/UV/render parity,
// flags, visibility or climate binding is claimed. Owns output; inputs unchanged.
CategoryPointGrid build_category_point_grid(const Terrain& heights, const RgbImage& ground);

} // namespace openrtw
