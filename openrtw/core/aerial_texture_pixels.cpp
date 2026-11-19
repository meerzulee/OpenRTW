#include "aerial_texture_pixels.hpp"
#include <stdexcept>

namespace openrtw {
AerialTexturePixels transpose_aerial_texture_pixels(std::span<const std::uint8_t> rows,
                                                    std::uint32_t side, std::size_t rowPitch) {
    if (!side || side > aerial_texture_max_side || (side & (side - 1)) ||
        rowPitch < std::size_t{side} * 3 || rowPitch > aerial_texture_max_input_bytes / side ||
        rows.size() != rowPitch * side || !rows.data())
        throw std::runtime_error(
            "Aerial pixels: need bounded square power2 rows and exact pitch extent");
    AerialTexturePixels out;
    out.side = side;
    out.words.resize(std::size_t{side} * side);
    for (std::uint32_t y = 0; y < side; ++y)
        for (std::uint32_t x = 0; x < side; ++x) {
            const auto at = std::size_t{y} * rowPitch + 3 * std::size_t{x};
            out.words[std::size_t{x} * side + y] =
                (std::uint64_t{255} << 56) | (std::uint64_t{rows[at]} << 40) |
                (std::uint64_t{rows[at + 1]} << 24) | (std::uint64_t{rows[at + 2]} << 8);
        }
    return out;
}
std::array<std::uint8_t, 4096> publish_aerial_texture32(std::span<const std::uint64_t> words) {
    if (words.size() != 1024 || !words.data())
        throw std::runtime_error("Aerial pixels: publication needs exactly1024 QWORDs");
    std::array<std::uint8_t, 4096> out{};
    for (unsigned x = 0; x < 32; ++x)
        for (unsigned y = 0; y < 32; ++y) {
            const auto word = words[x * 32 + y];
            const auto at = 4 * (y * 32 + x);
            out[at] = static_cast<std::uint8_t>(word >> 40);
            out[at + 1] = static_cast<std::uint8_t>(word >> 24);
            out[at + 2] = static_cast<std::uint8_t>(word >> 8);
            out[at + 3] = 255;
        }
    return out;
}
} // namespace openrtw
