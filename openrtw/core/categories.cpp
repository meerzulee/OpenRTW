#include "categories.hpp"

#include <array>
#include <cstddef>
#include <stdexcept>

namespace openrtw {
namespace {

// Original 46E008's 42 fixed byte writes, BGR -> canonical RGB once.
// These are code constants, not values copied from a saved world grid.
constexpr std::array<Rgb, 14> palette{{{0, 128, 128},
                                       {96, 160, 64},
                                       {101, 124, 0},
                                       {0, 0, 0},
                                       {196, 128, 128},
                                       {98, 65, 65},
                                       {128, 128, 64},
                                       {0, 64, 0},
                                       {0, 128, 0},
                                       {0, 255, 128},
                                       {64, 0, 0},
                                       {128, 0, 0},
                                       {196, 0, 0},
                                       {255, 255, 255}}};

bool finite(std::uint32_t bits) {
    return (bits & 0x7f800000u) != 0x7f800000u;
}

bool positive(std::uint32_t bits) {
    return (bits & 0x80000000u) == 0 && (bits & 0x7fffffffu) != 0;
}

std::uint32_t palette_index(Rgb color) {
    for (std::uint32_t i = 0; i < palette.size(); ++i)
        if (palette[i] == color)
            return i;
    return 14;
}

std::uint32_t remap(std::uint32_t category, bool isPositive) {
    const bool inGroup = category >= 10 && category <= 12;
    if (isPositive)
        return inGroup ? 0 : category;
    return inGroup ? category : 11;
}

void validate(const Terrain& heights, const RgbImage& ground) {
    if (heights.width <= 1 || heights.height <= 1 || heights.width % 2 == 0 ||
        heights.height % 2 == 0 || heights.width > max_terrain_dimension ||
        heights.height > max_terrain_dimension || ground.width > region_map_max_dimension ||
        ground.height > region_map_max_dimension || heights.width != ground.width ||
        heights.height != ground.height)
        throw std::runtime_error("Categories: unsupported or mismatched point dimensions");
    const auto count = std::uint64_t{heights.width} * heights.height;
    if (count > max_terrain_samples || count > region_map_max_pixels)
        throw std::runtime_error("Categories: point limit exceeded");
    if (heights.heightBits.size() != count || ground.rgb.size() != count * 3)
        throw std::runtime_error("Categories: inconsistent point extent");
    for (const auto bits : heights.heightBits)
        if (!finite(bits))
            throw std::runtime_error("Categories: nonfinite height is unsupported");
}

} // namespace

CategoryGrid build_category_grid(const Terrain& heights, const RgbImage& ground) {
    validate(heights, ground);
    CategoryGrid result;
    result.width = (heights.width - 1) / 2;
    result.height = (heights.height - 1) / 2;
    result.categories.resize(static_cast<std::size_t>(std::uint64_t{result.width} * result.height));
    for (std::uint32_t y = 0; y < result.height; ++y) {
        const auto centerY = 2 * y + 1;
        const auto topY = heights.height - 1 - centerY;
        for (std::uint32_t x = 0; x < result.width; ++x) {
            const auto centerX = 2 * x + 1;
            const auto heightOffset =
                static_cast<std::size_t>(std::uint64_t{centerY} * heights.width + centerX);
            const auto rgbOffset =
                static_cast<std::size_t>(3 * (std::uint64_t{topY} * ground.width + centerX));
            const Rgb color{ground.rgb[rgbOffset], ground.rgb[rgbOffset + 1],
                            ground.rgb[rgbOffset + 2]};
            const auto isPositive = positive(heights.heightBits[heightOffset]);
            // Point projection, then the center getter's identical finite remap.
            auto category = remap(palette_index(color), isPositive);
            category = remap(category, isPositive);
            const auto output = static_cast<std::size_t>(std::uint64_t{y} * result.width + x);
            result.categories[output] = category;
        }
    }
    return result;
}

CategoryPointGrid build_category_point_grid(const Terrain& heights, const RgbImage& ground) {
    validate(heights, ground);
    CategoryPointGrid result;
    result.width = heights.width;
    result.height = heights.height;
    result.categories.resize(heights.heightBits.size());
    for (std::uint32_t y = 0; y < result.height; ++y) {
        const auto topY = result.height - 1 - y;
        for (std::uint32_t x = 0; x < result.width; ++x) {
            const auto point = static_cast<std::size_t>(std::uint64_t{y} * result.width + x);
            const auto rgb = static_cast<std::size_t>(3 * (std::uint64_t{topY} * ground.width + x));
            const Rgb color{ground.rgb[rgb], ground.rgb[rgb + 1], ground.rgb[rgb + 2]};
            result.categories[point] = static_cast<std::uint8_t>(
                remap(palette_index(color), positive(heights.heightBits[point])));
        }
    }
    return result;
}

std::uint8_t CategoryPointGrid::category_at(std::uint32_t x, std::uint32_t y) const {
    if (x >= width || y >= height)
        throw std::out_of_range("Point categories: coordinates outside grid");
    if (categories.size() != std::uint64_t{width} * height)
        throw std::runtime_error("Point categories: inconsistent grid extent");
    const auto value = categories[static_cast<std::size_t>(std::uint64_t{y} * width + x)];
    if (value > 14)
        throw std::runtime_error("Point categories: invalid category ID");
    return value;
}

std::uint32_t CategoryGrid::category_at(std::uint32_t x, std::uint32_t y) const {
    if (x >= width || y >= height)
        throw std::out_of_range("Categories: coordinates outside grid");
    if (categories.size() != std::uint64_t{width} * height)
        throw std::runtime_error("Categories: inconsistent grid extent");
    const auto value = categories[static_cast<std::size_t>(std::uint64_t{y} * width + x)];
    if (value > 14)
        throw std::runtime_error("Categories: invalid category ID");
    return value;
}

} // namespace openrtw
