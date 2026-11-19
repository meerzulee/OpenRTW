#pragma once

#include <cstdint>
#include <span>
#include <vector>

namespace openrtw {

// Resource bounds chosen for this portable loader, not recovered Rome limits.
inline constexpr std::uint32_t max_terrain_dimension = 16383;
inline constexpr std::uint64_t max_terrain_samples = 16 * 1024 * 1024;

struct Terrain {
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    // Original HGT order: y * width + x. Own exact IEEE binary32 payloads,
    // including either zero sign; never convert heights while parsing.
    std::vector<std::uint32_t> heightBits;

    float height_at(std::uint32_t x, std::uint32_t y) const;
};

Terrain load_hgt(std::span<const std::uint8_t> bytes);

} // namespace openrtw
