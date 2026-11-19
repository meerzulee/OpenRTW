#pragma once
#include <array>
#include <cstddef>
#include <cstdint>
#include <span>
#include <vector>

namespace openrtw {
inline constexpr std::uint32_t aerial_texture_max_side = 1024;
inline constexpr std::size_t aerial_texture_max_input_bytes = 8 * 1024 * 1024;
struct AerialTexturePixels {
    std::uint32_t side = 0;
    // Numeric little-endian QWORD value; index x*side+y. Owns its storage.
    std::vector<std::uint64_t> words;
};
// 9E7D92 byte projection [0,src2,0,src1,0,src0,0,255] and transposition.
// The three caller row bytes have NO assigned color-channel/image-origin meaning.
// Explicit port policy: square power2 side1..1024, rowPitch>=3*side, exact
// rowPitch*side span<=8MiB. Native allocator/shift/clipping guards remain opaque;
// this value path matches when the native destination shift denotes this side.
// Inputs unchanged; complete owned output or runtime_error, no partial return.
AerialTexturePixels transpose_aerial_texture_pixels(std::span<const std::uint8_t> rows,
                                                    std::uint32_t side, std::size_t rowPitch);

// 9E5B9D's fixed32x32 x-major QWORD -> row-major4-byte destination:
// output bytes [word.byte5, word.byte3, word.byte1,255]. Other word bytes are
// ignored, including its alpha byte. No GPU/atlas/color-space/material semantics.
std::array<std::uint8_t, 4096> publish_aerial_texture32(std::span<const std::uint64_t> words);
} // namespace openrtw
