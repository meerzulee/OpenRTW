#include "aerial_word_math.hpp"

namespace openrtw::aerial_word_math {

std::uint64_t normal_single(std::uint64_t source, std::uint8_t byte5) noexcept {
    return byte5 == 0 ? source : source >> 2;
}

std::uint64_t normal_mixed4(const std::array<std::uint64_t, 4>& samples,
                            const std::array<std::uint64_t, 4>& weights) noexcept {
    std::array<std::uint16_t, 4> accumulated{};
    for (unsigned contribution = 0; contribution < 4; ++contribution) {
        const std::uint64_t shifted = samples[contribution] >> 8;
        for (unsigned lane = 0; lane < 4; ++lane) {
            const unsigned offset = lane * 16;
            const std::uint32_t sample_lane =
                static_cast<std::uint32_t>((shifted >> offset) & 0xffffu);
            const std::uint32_t weight_lane =
                static_cast<std::uint32_t>((weights[contribution] >> offset) & 0xffffu);
            // Both factors fit16bits, so the full product fits unsigned32.
            const std::uint32_t product = sample_lane * weight_lane;
            const std::uint32_t sum = accumulated[lane] + (product & 0xffffu);
            accumulated[lane] = static_cast<std::uint16_t>(sum);
        }
    }
    std::uint64_t result = 0;
    for (unsigned lane = 0; lane < 4; ++lane)
        result |= std::uint64_t{accumulated[lane]} << (lane * 16);
    return result;
}

} // namespace openrtw::aerial_word_math
