#pragma once

#include <array>
#include <cstdint>

namespace openrtw::aerial_word_math {

std::uint64_t normal_single(std::uint64_t source, std::uint8_t byte5) noexcept;

std::uint64_t normal_mixed4(const std::array<std::uint64_t, 4>& samples,
                            const std::array<std::uint64_t, 4>& weights) noexcept;

} // namespace openrtw::aerial_word_math
