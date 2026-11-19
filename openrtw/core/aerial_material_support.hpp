#pragma once

#include <array>
#include <cstdint>

namespace openrtw {

using AerialMaterialRecord = std::array<std::uint8_t, 8>;

bool aerial_material_equal(const AerialMaterialRecord& left,
                           const AerialMaterialRecord& right) noexcept;

std::uint32_t aerial_mask_index_wrapped(const std::array<std::uint32_t, 4>& corners,
                                        std::uint32_t variant) noexcept;

// OpenRTW's explicit bounded convenience domain, not a native callee guard:
// each corner0..3, variant0..7, result0..2047; otherwise invalid_argument.
std::uint32_t aerial_mask_index_bounded(const std::array<std::uint32_t, 4>& corners,
                                        std::uint32_t variant);

std::uint32_t aerial_random_range_bits(std::uint32_t& state, std::uint32_t lower_bits,
                                       std::uint32_t upper_bits) noexcept;

} // namespace openrtw
