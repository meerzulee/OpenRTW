#include "aerial_material_support.hpp"
#include "rome_random.hpp"

#include <stdexcept>

namespace openrtw {
namespace {

std::uint32_t index_word(const AerialMaterialRecord& record) noexcept {
    return std::uint32_t(record[0]) | (std::uint32_t(record[1]) << 8) |
           (std::uint32_t(record[2]) << 16) | (std::uint32_t(record[3]) << 24);
}

} // namespace

bool aerial_material_equal(const AerialMaterialRecord& left,
                           const AerialMaterialRecord& right) noexcept {
    return index_word(left) == index_word(right) && left[4] == right[4] && left[5] == right[5];
}

std::uint32_t aerial_mask_index_wrapped(const std::array<std::uint32_t, 4>& corners,
                                        std::uint32_t variant) noexcept {
    const std::uint32_t eax = corners[0] << 6;
    std::uint32_t ecx = corners[1] << 4;
    ecx += corners[3];
    ecx += eax;
    const std::uint32_t packed = ecx + corners[2] * 4u;
    return variant + packed * 8u;
}

std::uint32_t aerial_mask_index_bounded(const std::array<std::uint32_t, 4>& corners,
                                        std::uint32_t variant) {
    for (const auto corner : corners) {
        if (corner > 3u)
            throw std::invalid_argument("Aerial corner must be 0..3");
    }
    if (variant > 7u)
        throw std::invalid_argument("Aerial variant must be 0..7");
    return aerial_mask_index_wrapped(corners, variant);
}

std::uint32_t aerial_random_range_bits(std::uint32_t& state, std::uint32_t lower_bits,
                                       std::uint32_t upper_bits) noexcept {
    return rome_original::random_range_bits(state, lower_bits, upper_bits);
}

} // namespace openrtw
