#pragma once

#include <cstdint>

namespace openrtw::rome_original {

constexpr std::uint32_t random15(std::uint32_t& state) noexcept {
    state = state * 214013u + 2531011u;
    return (state >> 16) & 0x7fffu;
}

// Original F3ABB0 integer result bits, including wrapped/reversed ranges.
// The caller owns legality policy. Even a singleton/full-wrap range draws once.
constexpr std::uint32_t random_range_bits(std::uint32_t& state, std::uint32_t lower,
                                          std::uint32_t upper) noexcept {
    const std::uint32_t numerator = (upper - lower + 1u) * random15(state) - 1u;
    const std::int64_t signedNumerator =
        numerator < 0x80000000u ? std::int64_t(numerator) : std::int64_t(numerator) - 4294967296LL;
    // Native signed multiply-high sequence is truncating division by 32767.
    return lower + static_cast<std::uint32_t>(signedNumerator / 32767);
}

// F3AB60's argument is an inclusive upper value, not an exclusive count.
constexpr std::uint32_t random_upper_bits(std::uint32_t& state, std::uint32_t upper) noexcept {
    return random_range_bits(state, 0, upper);
}

} // namespace openrtw::rome_original
