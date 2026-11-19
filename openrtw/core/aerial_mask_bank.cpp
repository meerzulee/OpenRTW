#include "aerial_mask_bank.hpp"
#include "aerial_material_support.hpp"
#include <stdexcept>

namespace openrtw {
AerialMaskBank build_aerial_mask_bank(std::span<const std::span<const std::uint8_t>> patterns,
                                      AerialMaskNumericPolicy policy) {
    if (policy != AerialMaskNumericPolicy::Extended64NearestEven || patterns.empty() ||
        patterns.size() > 32767)
        throw std::invalid_argument("Aerial bank: explicit policy and1..32767 patterns required");
    for (const auto pattern : patterns)
        if (pattern.size() != aerial_mask_samples || !pattern.data())
            throw std::invalid_argument("Aerial bank: each pattern must have225 bytes");
    AerialMaskBank out;
    out.blocks.reserve(2048);
    out.selectedPatterns.reserve(2048);
    std::uint32_t seed = 0x6394;
    for (std::uint32_t c0 = 0; c0 < 4; ++c0)
        for (std::uint32_t c1 = 0; c1 < 4; ++c1)
            for (std::uint32_t c2 = 0; c2 < 4; ++c2)
                for (std::uint32_t c3 = 0; c3 < 4; ++c3)
                    for (std::uint32_t variant = 0; variant < 8; ++variant) {
                        const std::array<std::uint32_t, 4> labels{c0, c1, c2, c3};
                        if (aerial_mask_index_bounded(labels, variant) != out.blocks.size())
                            throw std::logic_error("Aerial bank: internal block order");
                        std::array<std::uint32_t, 4> selected{};
                        std::array<std::span<const std::uint8_t>, 4> inputs{};
                        for (unsigned corner = 0; corner < 4; ++corner) {
                            selected[corner] = aerial_random_range_bits(
                                seed, 0, static_cast<std::uint32_t>(patterns.size() - 1));
                            inputs[corner] = patterns[selected[corner]];
                        }
                        out.blocks.push_back(build_aerial_mask_weights(inputs, labels, policy));
                        out.selectedPatterns.push_back(selected);
                    }
    out.finalSeed = seed;
    return out;
}
} // namespace openrtw
