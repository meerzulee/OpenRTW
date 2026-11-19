#pragma once

#include "regions.hpp"

#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace openrtw {

inline constexpr std::size_t climate_max_input_bytes = 8 * 1024 * 1024;
inline constexpr std::size_t climate_max_line_bytes = 65536;
inline constexpr std::size_t climate_max_source_lines = 65536;
inline constexpr std::size_t climate_max_definitions = 256;
inline constexpr std::size_t climate_max_name_bytes = 64;
inline constexpr std::size_t climate_max_tokens_per_row = 16;
inline constexpr std::size_t climate_max_token_bytes = 1024;
inline constexpr std::size_t climate_max_owned_text_bytes = 24 * 1024 * 1024;

struct ClimateSourceRow {
    std::size_t line = 0;
    // Original indentation and comments, excluding CRLF/LF.
    std::string text;
    std::vector<std::string> tokens;
    bool operator==(const ClimateSourceRow&) const = default;
};

struct ClimateDefinition {
    std::string name;
    Rgb colour{255, 255, 255};
    // Literal signed integer from the source key "heat", used as a selector.
    // No temperature units or weather behavior are inferred.
    std::int32_t heat = 1;
    std::size_t declarationLine = 0;
    std::size_t definitionLine = 0;
    std::size_t colourLine = 0;
    std::size_t heatLine = 0;
    // Includes battle headers and their two following rows individually.
    std::vector<ClimateSourceRow> opaqueRows;
    bool operator==(const ClimateDefinition&) const = default;
};

struct ClimatePalette {
    std::string sourceBytes;
    // Unique literal names in declaration order; these own their storage.
    std::vector<ClimateDefinition> definitions;
    bool operator==(const ClimatePalette&) const = default;
};

// Declared portable subset: ASCII, semicolon comments, standalone braces,
// one ordered "climates" block followed by one "climate NAME" definition
// per unique lowercase ASCII/underscore name. Exactly one three-component
// colour and one signed heat integer per definition, colour 0..255, heat 0..4.
// Recognized opaque property shapes are retained, including the explicit
// battle-next-two rows. No auxiliary resource is opened or emulated.
// Resource limits above and refusals are new API policy, not native limits.
// Returns complete owned data or throws runtime_error; no partial return.
ClimatePalette load_climates(std::string_view input);

struct ClimateCoefficientGrid {
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    std::uint32_t definitionCount = 0;
    // Exact binary32 payloads and neutral definition IDs in x + width*y order.
    std::vector<std::uint32_t> coefficientBits;
    std::vector<std::uint8_t> sourceIndices;

    std::uint32_t coefficient_bits_at(std::uint32_t x, std::uint32_t y) const;
    std::uint8_t source_index_at(std::uint32_t x, std::uint32_t y) const;
    bool operator==(const ClimateCoefficientGrid&) const = default;
};

// RgbImage is already canonical TOPLEFT RGB. Matching scans every definition:
// last colour match wins; an unmatched point uses definition 0. Cell (x,y)
// reads image (2*x+1, image.height-2*y-2). Positive odd point dimensions >1,
// exact image storage, palette bounds and selector domain are validated.
// Selectors 0/4 produce 3F800000, 1/3 produce 3F666666, 2 produces 3F4CCCCD.
// Uses integers only and returns complete owned data without mutating inputs.
// One owned BASE source grid matches all 39780 retained coefficient words.
// Original parser/decoder/path/cache/container/allocator/CPU execution is not
// reproduced. Original triplet copies require DF=0, valid stable pointers and
// normal helper returns. No auxiliary effects, ownership, movement legality,
// actor binding or turn behavior are asserted by this value-only component.
ClimateCoefficientGrid build_climate_coefficient_grid(const ClimatePalette& palette,
                                                      const RgbImage& image);

} // namespace openrtw
