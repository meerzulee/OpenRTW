#pragma once

#include <cstddef>
#include <cstdint>
#include <span>
#include <vector>

namespace openrtw {

// New OpenRTW admission budgets; these are not recovered original limits.
inline constexpr std::size_t dds_max_input_bytes = 16 * 1024 * 1024;
inline constexpr std::uint32_t dds_max_dimension = 8192;
inline constexpr std::uint32_t dds_max_mip_levels = 14;

enum class DdsCompression { Dxt1, Dxt3, Dxt5 };

struct DdsByteRange {
    std::uint32_t start = 0, endExclusive = 0;
    std::uint32_t bytes() const noexcept { return endExclusive - start; }
};

struct DdsMipLevel {
    std::uint32_t level = 0, width = 0, height = 0;
    std::uint32_t blocksX = 0, blocksY = 0;
    DdsByteRange range;
};

struct DdsTexture {
    // Exact owned header and compressed payload. No input pointer escapes.
    std::vector<std::uint8_t> sourceBytes;
    std::uint32_t width = 0, height = 0;
    DdsCompression compression = DdsCompression::Dxt1;
    std::uint32_t blockBytes = 0;
    std::uint32_t headerFlags = 0, pixelFormatFlags = 0, caps = 0;
    std::uint32_t pitchOrLinearSize = 0, declaredMipMapCount = 0;
    DdsByteRange headerRange, payloadRange;
    std::vector<DdsMipLevel> mips;
    // Records explicit opt-in admission, without normalizing header/source bits.
    bool legacyFlagsProfile = false;
};

// Bounded standard DDS envelope subset, not an original decoder or native
// renderer equivalence claim. Admits only the 128-byte legacy DDS header,
// power-of-two 2D dimensions, DXT1/3/5, one surface and a nonempty declared
// prefix of its mip chain. Required CAPS/HEIGHT/WIDTH/PIXELFORMAT flags;
// optional MIPMAPCOUNT/LINEARSIZE only. Pixel format permits FOURCC and
// optional ALPHAPIXELS only, with zero RGB masks/count. Volume/cube/DX10,
// unknown flags/caps, nonzero reserved fields, excess mips, size mismatch,
// truncation and trailing bytes refuse. Depth is 0 or 1. Mip dimensions
// halve to at least1; each compressed extent is ceil(W/4)*ceil(H/4)*blockBytes.
// Multi-level chains require COMPLEX/MIPMAP caps. Without MIPMAPCOUNT the
// raw count must be0 or1 and means one level. A flagged LINEARSIZE must equal
// the top-level extent; without it the field must be0. All validation and
// owned allocation complete before return; input stays unchanged. Unsupported
// input throws runtime_error; allocation failures propagate. No decompression,
// alpha interpretation, color space, UV/mip selection or material binding.
DdsTexture load_dds_texture(std::span<const std::uint8_t> input);

// Explicit legacy-writer compatibility: DDSD_CAPS may be absent, and a
// multi-level chain may omit COMPLEX and/or MIPMAP caps. All other strict
// checks above remain in force, including TEXTURE, count flags, reserved
// fields, exact extents and EOF. No automatic fallback or bit repair occurs.
DdsTexture load_dds_texture_legacy_flags(std::span<const std::uint8_t> input);

} // namespace openrtw
