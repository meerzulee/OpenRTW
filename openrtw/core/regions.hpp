#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace openrtw {

using Rgb = std::array<std::uint8_t, 3>;

struct RegionSourceLine {
    std::size_t line = 0;
    std::string text;
};

struct RegionDefinition {
    std::string id;
    std::string field2;
    std::string field3;
    std::string field4;
    Rgb rgb{};
    std::vector<std::string> resources;
    std::int32_t numeric7 = 0;
    std::int32_t numeric8 = 0;
    // Eight original physical lines, including indentation, excluding CRLF/LF.
    // In particular raw numeric text remains available here.
    std::array<RegionSourceLine, 8> source;
};

struct RegionDefinitions {
    std::vector<RegionDefinition> definitions;
    std::vector<RegionSourceLine> ignoredLines;
};

// Explicit supported-domain/resource policy, not recovered native limits.
inline constexpr std::size_t region_max_input_bytes = 8 * 1024 * 1024;
inline constexpr std::size_t region_max_line_bytes = 65536;
inline constexpr std::size_t region_max_source_lines = 100000;
inline constexpr std::size_t region_max_definitions = 4096;
inline constexpr std::size_t region_max_resources_per_definition = 256;
inline constexpr std::size_t region_max_total_resources = 65536;
inline constexpr std::size_t region_max_owned_text_bytes = 16 * 1024 * 1024;

// Strict ASCII subset observed in the owned 103-record descr_regions file:
// one unindented identifier followed by seven tab-prefixed, nonempty fields.
// Comments/blank lines are retained outside records; inside a record they
// refuse rather than shift fields. Duplicate IDs/colors and incomplete blocks
// refuse. Strings own their source. Throws runtime_error; no partial return.
// Field2/3/4, resources and numeric7/8 remain literal data. No current owner,
// settlement/port/water semantics, campaign join or simulation is inferred.
RegionDefinitions load_regions(std::string_view input);

struct TgaHeader {
    std::array<std::uint8_t, 18> bytes{};
    std::uint8_t idLength = 0;
    std::uint8_t colorMapType = 0;
    std::uint8_t imageType = 0;
    std::uint16_t colorMapFirstEntry = 0;
    std::uint16_t colorMapLength = 0;
    std::uint8_t colorMapEntryBits = 0;
    std::uint16_t xOrigin = 0;
    std::uint16_t yOrigin = 0;
    std::uint16_t width = 0;
    std::uint16_t height = 0;
    std::uint8_t pixelDepth = 0;
    std::uint8_t descriptor = 0;
};

struct RgbImage {
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    TgaHeader header;
    // RGB bytes, row-major, top-left origin regardless of TGA bits4/5.
    std::vector<std::uint8_t> rgb;
    Rgb pixel_at(std::uint32_t x, std::uint32_t y) const;
};

inline constexpr std::uint32_t region_map_max_dimension = 16383;
inline constexpr std::uint64_t region_map_max_pixels = 16 * 1024 * 1024;

// Type2 uncompressed 24-bit BGR, no ID/palette/alpha/interleave/RLE/footer.
// Exact length required. Descriptor bits4/5 select horizontal/vertical source
// order and are normalized to top-left RGB; all other descriptor bits refuse.
// Origin fields remain raw facts, never a campaign coordinate translation.
// The owned asset has descriptor0; supporting the other three orientations is
// explicit decoder policy and synthetic tests, not original-game evidence.
RgbImage load_tga24(std::span<const std::uint8_t> bytes);

} // namespace openrtw
