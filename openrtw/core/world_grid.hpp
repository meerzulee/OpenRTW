#pragma once

#include "regions.hpp"

#include <cstddef>
#include <cstdint>
#include <vector>

namespace openrtw {

enum class WorldMarkerKind : std::uint8_t {
    Black,
    White,
};

struct WorldMarker {
    WorldMarkerKind rawKind = WorldMarkerKind::Black;
    std::uint32_t imageX = 0;
    std::uint32_t imageY = 0;
    std::uint32_t worldX = 0;
    std::uint32_t worldY = 0;
    Rgb selectedRgb{};
    std::uint32_t regionIndex = 0;
    // Whether the supported original existing-object branch writes a marker
    // coordinate at this step. White predicate fallback assigns a cell/color
    // but takes the predicate-flag branch instead of that coordinate write.
    // The marker's raw image/world coordinates above remain source facts.
    bool coordinateWritten = false;
};

struct WorldGrid {
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    // World row-major: x + width*y; y=height-1-canonicalImageY.
    std::vector<std::uint32_t> regionIndices;
    // Selected RGB first encountered in image top-to-bottom/left-to-right
    // order. This order is independent of descr_regions definition order.
    std::vector<Rgb> palette;
    // Raw markers in image scan order, without city/port/gameplay labels.
    std::vector<WorldMarker> markers;

    std::uint32_t region_at(std::uint32_t x, std::uint32_t y) const;
    Rgb rgb_at(std::uint32_t x, std::uint32_t y) const;
};

// Bounded OpenRTW policy, not recovered native capacities/failure behavior.
inline constexpr std::size_t world_grid_max_regions = 4096;
inline constexpr std::size_t world_grid_max_markers = 100000;

// Reconstructs the supported cell/index/marker projection of original mapper
// 0x47E14D with its observed black/white triples and alternative-prep flag0.
// Input is canonical TOPLEFT RGB. Predicate 0x47A559 is R==41 && G==140,
// irrespective of B; 0x48E4EC compares exactly three bytes. Marker neighbors
// are image down/right/up/left, clipped at boundaries. They read raw pixels,
// never replacements already assigned to other cells.
//
// White takes the first non-predicate/non-black neighbor, else the last
// predicate neighbor. Black takes the first non-predicate/non-white neighbor.
// The original bodies can select another marker color. Such outcomes, no
// qualifying neighbor, and marker-selected colors not previously encountered
// are explicit unsupported-policy refusals; no substitute search is invented.
// White predicate fallback is supported for an already encountered color,
// with coordinateWritten=false. All outputs own their memory; input is never
// changed. Throws runtime_error and publishes no partial return on refusal.
//
// This does not construct original 472-byte world objects, interpret names,
// current owners, terrain/water traversal, settlements/ports, movement, turns,
// saves, or the unqueried nonzero alternative preparation path.
WorldGrid build_world_grid(const RgbImage& image);

} // namespace openrtw
