#pragma once
#include "aerial_mask_weights.hpp"
#include <vector>

namespace openrtw {
struct AerialMaskBank {
    std::vector<AerialMaskWeights> blocks;
    std::vector<std::array<std::uint32_t, 4>> selectedPatterns;
    std::uint32_t finalSeed = 0;
};
AerialMaskBank
build_aerial_mask_bank(std::span<const std::span<const std::uint8_t>> orderedPatterns,
                       AerialMaskNumericPolicy policy);
} // namespace openrtw
