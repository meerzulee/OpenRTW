#include "aerial_tile_table.hpp"
#include "rome_random.hpp"

#include "aerial_material_role.hpp"
#include "terrain.hpp"

#include <stdexcept>

namespace openrtw {
namespace {

constexpr std::uint32_t max_cells_per_axis = (max_terrain_dimension - 1) / 2;
constexpr std::uint32_t forest_dense_category = 7;

void validate_cell_extent(std::uint32_t width, std::uint32_t height) {
    if (!width || !height || width > max_cells_per_axis || height > max_cells_per_axis ||
        (std::uint64_t{2} * width + 1) * (std::uint64_t{2} * height + 1) > max_terrain_samples)
        throw std::runtime_error("Aerial tile table: unsupported cell extent");
}

} // namespace

std::uint8_t AerialPointClimateGrid::index_at(std::uint32_t px, std::uint32_t py) const {
    if (px >= width || py >= height)
        throw std::out_of_range("Aerial point climates: coordinates outside grid");
    if (indices.size() != std::uint64_t{width} * height)
        throw std::runtime_error("Aerial point climates: inconsistent grid extent");
    const auto value = indices[static_cast<std::size_t>(std::uint64_t{py} * width + px)];
    if (value >= definitionCount)
        throw std::runtime_error("Aerial point climates: invalid climate index");
    return value;
}

AerialPointClimateGrid build_aerial_point_climate_grid(const ClimatePalette& palette,
                                                       const RgbImage& climateMap) {
    if (palette.definitions.empty() || palette.definitions.size() > climate_max_definitions)
        throw std::runtime_error("Aerial point climates: palette needs 1..256 definitions");
    if (climateMap.width <= 1 || climateMap.height <= 1 || climateMap.width % 2 == 0 ||
        climateMap.height % 2 == 0 || climateMap.width > max_terrain_dimension ||
        climateMap.height > max_terrain_dimension ||
        std::uint64_t{climateMap.width} * climateMap.height > max_terrain_samples ||
        climateMap.rgb.size() != std::uint64_t{climateMap.width} * climateMap.height * 3)
        throw std::runtime_error("Aerial point climates: unsupported climate map extent");
    AerialPointClimateGrid grid;
    grid.width = climateMap.width;
    grid.height = climateMap.height;
    grid.definitionCount = static_cast<std::uint32_t>(palette.definitions.size());
    grid.indices.resize(static_cast<std::size_t>(std::uint64_t{grid.width} * grid.height));
    for (std::uint32_t py = 0; py < grid.height; ++py) {
        const auto topY = grid.height - 1 - py;
        for (std::uint32_t px = 0; px < grid.width; ++px) {
            const auto at = static_cast<std::size_t>(3 * (std::uint64_t{topY} * grid.width + px));
            const Rgb colour{climateMap.rgb[at], climateMap.rgb[at + 1], climateMap.rgb[at + 2]};
            std::uint8_t selected = 0;
            for (std::size_t c = 0; c < palette.definitions.size(); ++c)
                if (palette.definitions[c].colour == colour)
                    selected = static_cast<std::uint8_t>(c);
            grid.indices[static_cast<std::size_t>(std::uint64_t{py} * grid.width + px)] = selected;
        }
    }
    return grid;
}

std::uint16_t AerialSeedGrid::seed_at(std::uint32_t x, std::uint32_t y) const {
    if (x >= width || y >= height)
        throw std::out_of_range("Aerial seeds: coordinates outside grid");
    if (seeds.size() != std::uint64_t{width} * height)
        throw std::runtime_error("Aerial seeds: inconsistent grid extent");
    return seeds[static_cast<std::size_t>(std::uint64_t{y} * width + x)];
}

AerialSeedGrid build_aerial_seed_grid(std::uint32_t cellWidth, std::uint32_t cellHeight) {
    validate_cell_extent(cellWidth, cellHeight);
    AerialSeedGrid grid;
    grid.width = cellWidth;
    grid.height = cellHeight;
    grid.seeds.resize(static_cast<std::size_t>(std::uint64_t{cellWidth} * cellHeight));
    const std::size_t rowWords = std::size_t{2} * cellWidth;
    // Two word rows (2Y, 2Y+1) at a time: the full 2W x 2H bank is never stored.
    std::vector<std::uint32_t> south(rowWords), north(rowWords);
    std::uint32_t state = 0x6394;
    const auto fill = [&](std::vector<std::uint32_t>& row) {
        for (auto& word : row) {
            word = rome_original::random15(state);
        }
    };
    for (std::uint32_t y = 0; y < cellHeight; ++y) {
        fill(south); // row r = 2Y
        fill(north); // row r = 2Y + 1
        for (std::uint32_t x = 0; x < cellWidth; ++x) {
            const auto sum = south[2 * std::size_t{x}] + south[2 * std::size_t{x} + 1] +
                             north[2 * std::size_t{x}] + north[2 * std::size_t{x} + 1];
            grid.seeds[static_cast<std::size_t>(std::uint64_t{y} * cellWidth + x)] =
                static_cast<std::uint16_t>(sum & 0xffffu);
        }
    }
    return grid;
}

AerialTileTable build_aerial_tile_table(const CategoryGrid& cells, const CategoryPointGrid& points,
                                        const AerialPointClimateGrid& climates,
                                        const AerialGroundTypes& groundTypes,
                                        const AerialSeedGrid& seeds, std::uint32_t x,
                                        std::uint32_t y, bool winter) {
    validate_cell_extent(cells.width, cells.height);
    const auto pointWidth = 2 * cells.width + 1, pointHeight = 2 * cells.height + 1;
    if (points.width != pointWidth || points.height != pointHeight ||
        climates.width != pointWidth || climates.height != pointHeight ||
        seeds.width != cells.width || seeds.height != cells.height)
        throw std::runtime_error("Aerial tile table: grid extents disagree");
    if (climates.definitionCount != groundTypes.climates.size() || groundTypes.climates.empty() ||
        groundTypes.textureNames.empty())
        throw std::runtime_error("Aerial tile table: climate grid and ground types disagree");
    if (x >= cells.width || y >= cells.height)
        throw std::out_of_range("Aerial tile table: cell outside the map");

    const auto class3 = [&](std::int64_t cx, std::int64_t cy) {
        return cx >= 0 && cy >= 0 && cx < cells.width && cy < cells.height &&
               cells.category_at(static_cast<std::uint32_t>(cx), static_cast<std::uint32_t>(cy)) ==
                   forest_dense_category;
    };
    const std::int64_t cx = x, cy = y;
    const bool cur = class3(cx, cy);
    const bool pY = class3(cx, cy + 1), mY = class3(cx, cy - 1);
    const bool pX = class3(cx + 1, cy), mX = class3(cx - 1, cy);
    const auto dark = [&](unsigned k, unsigned i) {
        if (!cur)
            return false;
        if (k == 2 && i == 2)
            return true;
        if (k == 2)
            return i >= 2 ? pY : mY;
        if (i == 2)
            return k >= 2 ? pX : mX;
        if (k >= 2)
            return (i >= 2 ? pY : mY) && pX;
        return (i >= 2 ? pY : mY) && mX;
    };
    const auto clamp_offset = [](unsigned v) { return v == 0 ? 0u : v > 3 ? 2u : v - 1; };
    const auto outside_map = [&](unsigned k, unsigned i) {
        return (k == 0 && x == 0) || (k == 4 && x + 1 >= cells.width) ||
               (i == 0 && k >= 1 && k <= 3 && y == 0) || (i == 4 && y + 1 >= cells.height);
    };

    AerialTileTable table;
    for (unsigned k = 0; k < 5; ++k) {
        for (unsigned i = 0; i < 5; ++i) {
            const auto dx = clamp_offset(k);
            // Recovered south-corner quirk: (0,0) and (4,0) read y-point 2.
            const auto dy = (i == 0 && (k == 0 || k == 4)) ? 2u : clamp_offset(i);
            const auto px = 2 * x + dx, py = 2 * y + dy;
            const bool outside = outside_map(k, i);
            const std::uint8_t climate = outside ? std::uint8_t{0} : climates.index_at(px, py);
            const std::int32_t category = outside ? 0 : points.category_at(px, py);
            const auto& ground = groundTypes.climates[climate];
            const auto role = select_aerial_material_role(category, 0, 0);
            std::uint32_t index = aerial_pseudo_texture_index;
            if (role) {
                index =
                    ground.slots[static_cast<std::size_t>(*role)][winter && ground.winter ? 1 : 0];
                if (index >= groundTypes.textureNames.size())
                    throw std::runtime_error(
                        "Aerial tile table: slot outside the texture registry");
            } else {
                table.pseudo = true;
            }
            auto& record = table.records[5 * k + i];
            record = {static_cast<std::uint8_t>(index),
                      static_cast<std::uint8_t>(index >> 8),
                      static_cast<std::uint8_t>(index >> 16),
                      static_cast<std::uint8_t>(index >> 24),
                      0,
                      static_cast<std::uint8_t>(dark(k, i) ? 1 : 0),
                      0,
                      0};
        }
    }
    table.offsetA = 30u * x - 1u;
    table.offsetB = 30u * (cells.height - y) - 1u;
    table.seed = seeds.seed_at(x, y);
    return table;
}

} // namespace openrtw
