#include "terrain.hpp"

#include <bit>
#include <limits>
#include <stdexcept>

namespace openrtw {
namespace {

static_assert(sizeof(float) == 4 && std::numeric_limits<float>::is_iec559,
              "OpenRTW terrain requires IEEE binary32 float");

std::uint32_t word(std::span<const std::uint8_t> bytes, std::size_t offset) {
    return std::uint32_t{bytes[offset]} | (std::uint32_t{bytes[offset + 1]} << 8) |
           (std::uint32_t{bytes[offset + 2]} << 16) | (std::uint32_t{bytes[offset + 3]} << 24);
}

bool finite(std::uint32_t bits) {
    return (bits & 0x7f800000u) != 0x7f800000u;
}

} // namespace

Terrain load_hgt(std::span<const std::uint8_t> bytes) {
    if (bytes.size() < 8)
        throw std::runtime_error("HGT: truncated dimensions");
    const auto width = word(bytes, 0);
    const auto height = word(bytes, 4);
    if (width == 0 || height == 0 || width % 2 == 0 || height % 2 == 0 ||
        width > max_terrain_dimension || height > max_terrain_dimension)
        throw std::runtime_error("HGT: unsupported dimensions");
    const std::uint64_t samples = std::uint64_t{width} * height;
    if (samples > max_terrain_samples)
        throw std::runtime_error("HGT: sample limit exceeded");
    const std::uint64_t size = 8 + samples * 4;
    if (size != bytes.size())
        throw std::runtime_error("HGT: payload length mismatch");
    // Validate first: malformed/nonfinite late words allocate no height bank.
    for (std::size_t offset = 8; offset < bytes.size(); offset += 4)
        if (!finite(word(bytes, offset)))
            throw std::runtime_error("HGT: nonfinite height is unsupported");
    Terrain terrain;
    terrain.width = width;
    terrain.height = height;
    terrain.heightBits.reserve(static_cast<std::size_t>(samples));
    for (std::size_t offset = 8; offset < bytes.size(); offset += 4)
        terrain.heightBits.push_back(word(bytes, offset));
    return terrain;
}

float Terrain::height_at(std::uint32_t x, std::uint32_t y) const {
    if (x >= width || y >= height)
        throw std::out_of_range("Terrain: coordinates outside height grid");
    const std::uint64_t samples = std::uint64_t{width} * height;
    if (samples != heightBits.size())
        throw std::runtime_error("Terrain: inconsistent height grid");
    const auto bits = heightBits[static_cast<std::size_t>(std::uint64_t{y} * width + x)];
    if (!finite(bits))
        throw std::runtime_error("Terrain: nonfinite height is unsupported");
    return std::bit_cast<float>(bits);
}

} // namespace openrtw
