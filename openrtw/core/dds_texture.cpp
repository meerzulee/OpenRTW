#include "dds_texture.hpp"

#include <algorithm>
#include <stdexcept>

namespace openrtw {
namespace {

[[noreturn]] void refuse() {
    throw std::runtime_error("Unsupported or malformed DDS texture envelope");
}

std::uint32_t word(std::span<const std::uint8_t> input, std::size_t at) {
    if (at > input.size() || input.size() - at < 4)
        refuse();
    std::uint32_t value = 0;
    for (unsigned i = 0; i < 4; ++i)
        value |= std::uint32_t{input[at + i]} << (8u * i);
    return value;
}

bool power_of_two(std::uint32_t value) noexcept {
    return value != 0 && (value & (value - 1)) == 0;
}

DdsTexture load_dds_texture_impl(std::span<const std::uint8_t> input, bool legacy_flags) {
    if (input.size() < 128 || input.size() > dds_max_input_bytes)
        refuse();
    if (word(input, 0) != 0x20534444u || word(input, 4) != 124 || word(input, 76) != 32)
        refuse();

    DdsTexture result;
    result.legacyFlagsProfile = legacy_flags;
    result.headerFlags = word(input, 8);
    const std::uint32_t required_flags = legacy_flags ? 0x1006u : 0x1007u;
    constexpr std::uint32_t allowed_flags = 0xa1007;
    if ((result.headerFlags & required_flags) != required_flags ||
        (result.headerFlags & ~allowed_flags) != 0)
        refuse();
    result.width = word(input, 16);
    result.height = word(input, 12);
    if (!power_of_two(result.width) || !power_of_two(result.height) ||
        result.width > dds_max_dimension || result.height > dds_max_dimension)
        refuse();
    if (word(input, 24) > 1 || word(input, 112) != 0 || word(input, 116) != 0 ||
        word(input, 120) != 0 || word(input, 124) != 0)
        refuse();
    for (std::size_t at = 32; at < 76; at += 4)
        if (word(input, at) != 0)
            refuse();

    result.pixelFormatFlags = word(input, 80);
    if ((result.pixelFormatFlags & 4u) == 0 || (result.pixelFormatFlags & ~5u) != 0)
        refuse();
    for (std::size_t at = 88; at <= 104; at += 4)
        if (word(input, at) != 0)
            refuse();
    switch (word(input, 84)) {
    case 0x31545844u:
        result.compression = DdsCompression::Dxt1;
        result.blockBytes = 8;
        break;
    case 0x33545844u:
        result.compression = DdsCompression::Dxt3;
        result.blockBytes = 16;
        break;
    case 0x35545844u:
        result.compression = DdsCompression::Dxt5;
        result.blockBytes = 16;
        break;
    default:
        refuse();
    }
    result.caps = word(input, 108);
    if ((result.caps & 0x1000u) == 0 || (result.caps & ~(0x1000u | 0x8u | 0x400000u)) != 0)
        refuse();

    result.declaredMipMapCount = word(input, 28);
    const bool mip_count_flag = (result.headerFlags & 0x20000u) != 0;
    if ((mip_count_flag && result.declaredMipMapCount == 0) ||
        (!mip_count_flag && result.declaredMipMapCount > 1))
        refuse();
    const auto levels = mip_count_flag ? result.declaredMipMapCount : 1u;
    std::uint32_t possible_levels = 1;
    for (auto edge = std::max(result.width, result.height); edge > 1; edge /= 2)
        ++possible_levels;
    if (levels > possible_levels || levels > dds_max_mip_levels)
        refuse();
    if (!legacy_flags && levels > 1 && (result.caps & 0x400008u) != 0x400008u)
        refuse();

    result.mips.reserve(levels);
    std::uint32_t width = result.width, height = result.height, offset = 128;
    for (std::uint32_t level = 0; level < levels; ++level) {
        const auto blocks_x = (std::uint64_t{width} + 3) / 4;
        const auto blocks_y = (std::uint64_t{height} + 3) / 4;
        const auto bytes = blocks_x * blocks_y * result.blockBytes;
        // Dimensions cap products at 67,108,864 bytes, below U32; compare the
        // widened product with remaining input before any narrowing/addition.
        if (bytes > input.size() - offset)
            refuse();
        const auto end = offset + static_cast<std::uint32_t>(bytes);
        result.mips.push_back({level,
                               width,
                               height,
                               static_cast<std::uint32_t>(blocks_x),
                               static_cast<std::uint32_t>(blocks_y),
                               {offset, end}});
        offset = end;
        width = std::max(1u, width / 2);
        height = std::max(1u, height / 2);
    }
    if (offset != input.size())
        refuse();
    result.pitchOrLinearSize = word(input, 20);
    if ((result.headerFlags & 0x80000u) != 0) {
        if (result.pitchOrLinearSize != result.mips.front().range.bytes())
            refuse();
    } else if (result.pitchOrLinearSize != 0)
        refuse();

    result.headerRange = {0, 128};
    result.payloadRange = {128, offset};
    result.sourceBytes.assign(input.begin(), input.end());
    return result;
}

} // namespace

DdsTexture load_dds_texture(std::span<const std::uint8_t> input) {
    return load_dds_texture_impl(input, false);
}

DdsTexture load_dds_texture_legacy_flags(std::span<const std::uint8_t> input) {
    return load_dds_texture_impl(input, true);
}

} // namespace openrtw
