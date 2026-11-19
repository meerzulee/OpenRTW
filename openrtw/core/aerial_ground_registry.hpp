#pragma once

#include "aerial_texture_pixels.hpp"
#include "climates.hpp"
#include "regions.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace openrtw {

inline constexpr std::size_t aerial_ground_slot_count = 14;
// OpenRTW resource policy, not recovered native limits.
inline constexpr std::size_t aerial_ground_max_input_bytes = 1024 * 1024;
inline constexpr std::size_t aerial_ground_max_line_bytes = 4096;
inline constexpr std::size_t aerial_ground_max_blocks = climate_max_definitions + 1;
inline constexpr std::size_t aerial_ground_max_block_name_bytes = climate_max_name_bytes;
inline constexpr std::size_t aerial_ground_max_texture_name_bytes = 255;

inline constexpr std::array<std::string_view, aerial_ground_slot_count> aerial_ground_slot_names{
    "cultivated_low", "cultivated_medium", "cultivated_high",
    "fertility_low",  "fertility_medium",  "fertility_high",
    "forest_dense",   "forest_sparse",     "hills",
    "mountains_high", "mountains_low",     "swamp",
    "beach",          "scorched"};

struct AerialGroundClimate {
    // ClimatePalette definition name at this index (native climate index).
    std::string climateName;
    // Descriptor block actually used: climateName when declared, else "default".
    std::string blockName;
    bool winter = false;
    // [slot][column] registry indices; column 0 = summer, 1 = winter texture.
    std::array<std::array<std::uint32_t, 2>, aerial_ground_slot_count> slots{};
    bool operator==(const AerialGroundClimate&) const = default;
};

struct AerialGroundTypes {
    std::vector<std::string> textureNames;
    // One entry per ClimatePalette definition, in declaration order.
    std::vector<AerialGroundClimate> climates;
    bool operator==(const AerialGroundTypes&) const = default;
};

// True when the climate definition retains a standalone `winter` row.
bool aerial_climate_has_winter(const ClimateDefinition& climate) noexcept;

AerialGroundTypes load_aerial_ground_types(std::string_view input, const ClimatePalette& palette);

RgbImage decode_aerial_tga24(std::span<const std::uint8_t> bytes);

AerialTexturePixels aerial_ground_texture_pixels(const RgbImage& image);

struct AerialGroundTextureSet {
    // Index = registry index. side==0/empty words means "not loaded yet".
    std::vector<AerialTexturePixels> textures;
};

// One empty slot per registry name.
AerialGroundTextureSet make_aerial_ground_texture_set(const AerialGroundTypes& types);
// Decodes (decode_aerial_tga24 + aerial_ground_texture_pixels) and replaces the
// slot only after complete success; index outside the set -> invalid_argument.
void load_aerial_ground_texture(AerialGroundTextureSet& set, std::uint32_t index,
                                std::span<const std::uint8_t> tgaBytes);
// Every slot holds a square power-of-two texture with side*side words.
bool aerial_ground_texture_set_complete(const AerialGroundTextureSet& set) noexcept;

inline constexpr std::size_t aerial_weight_pattern_side = 15;
using AerialWeightPattern = std::array<std::uint8_t, 225>;

AerialWeightPattern aerial_weight_pattern(const RgbImage& image);

} // namespace openrtw
