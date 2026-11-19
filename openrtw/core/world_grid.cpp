#include "world_grid.hpp"

#include <array>
#include <map>
#include <stdexcept>

namespace openrtw {
namespace {

constexpr Rgb black{0, 0, 0};
constexpr Rgb white{255, 255, 255};

bool predicate(const Rgb& color) noexcept {
    return color[0] == 41 && color[1] == 140;
}

std::uint32_t color_key(const Rgb& color) noexcept {
    return (static_cast<std::uint32_t>(color[0]) << 16) |
           (static_cast<std::uint32_t>(color[1]) << 8) | static_cast<std::uint32_t>(color[2]);
}

std::uint64_t checked_pixels(std::uint32_t width, std::uint32_t height) {
    if (width == 0 || height == 0 || width > region_map_max_dimension ||
        height > region_map_max_dimension) {
        throw std::runtime_error("Unsupported world grid dimensions");
    }
    const auto pixels = static_cast<std::uint64_t>(width) * height;
    if (pixels > region_map_max_pixels) {
        throw std::runtime_error("World grid pixel limit exceeded");
    }
    return pixels;
}

Rgb raw_color(const RgbImage& image, std::uint32_t x, std::uint32_t y) {
    const auto offset = 3 * (static_cast<std::size_t>(y) * image.width + x);
    return Rgb{image.rgb[offset], image.rgb[offset + 1], image.rgb[offset + 2]};
}

struct Selection {
    Rgb color;
    bool fallback = false;
};

Selection select_marker(const RgbImage& image, std::uint32_t x, std::uint32_t y,
                        WorldMarkerKind kind) {
    // Unsigned coordinates are changed only after their boundary condition.
    std::array<Rgb, 4> neighbors{};
    std::size_t count = 0;
    if (y + 1 < image.height)
        neighbors[count++] = raw_color(image, x, y + 1);
    if (x + 1 < image.width)
        neighbors[count++] = raw_color(image, x + 1, y);
    if (y > 0)
        neighbors[count++] = raw_color(image, x, y - 1);
    if (x > 0)
        neighbors[count++] = raw_color(image, x - 1, y);

    if (kind == WorldMarkerKind::Black) {
        for (std::size_t i = 0; i < count; ++i) {
            const auto& color = neighbors[i];
            if (!predicate(color) && color != white) {
                // The original chooses black here if that is the first
                // qualifying raw neighbor. Refuse; do not skip it.
                if (color == black) {
                    throw std::runtime_error("Unsupported black marker selection");
                }
                return Selection{color, false};
            }
        }
        throw std::runtime_error("Black marker has no supported neighbor");
    }

    Rgb selected{};
    Rgb backup{};
    bool chosen = false;
    bool haveBackup = false;
    for (std::size_t i = 0; i < count; ++i) {
        const auto& color = neighbors[i];
        if (predicate(color)) {
            // Visit even after an ordinary choice, as the original does.
            backup = color;
            haveBackup = true;
        } else if (!chosen && color != black) {
            selected = color;
            chosen = true;
        }
    }
    if (chosen) {
        // An earlier white raw neighbor cannot be replaced by later land.
        if (selected == white) {
            throw std::runtime_error("Unsupported white marker selection");
        }
        return Selection{selected, false};
    }
    if (!haveBackup) {
        throw std::runtime_error("White marker has no supported neighbor");
    }
    return Selection{backup, true};
}

} // namespace

WorldGrid build_world_grid(const RgbImage& image) {
    const auto pixels = checked_pixels(image.width, image.height);
    if (image.rgb.size() != pixels * 3) {
        throw std::runtime_error("World grid RGB extent mismatch");
    }

    WorldGrid result;
    result.width = image.width;
    result.height = image.height;
    result.regionIndices.resize(static_cast<std::size_t>(pixels));
    // Sorted lookup bounds work per pixel even for adversarial RGB keys;
    // palette order still comes exclusively from explicit encounter appends.
    std::map<std::uint32_t, std::uint32_t> indices;

    for (std::uint32_t y = 0; y < image.height; ++y) {
        const auto worldY = image.height - 1 - y;
        for (std::uint32_t x = 0; x < image.width; ++x) {
            const auto original = raw_color(image, x, y);
            const bool isMarker = original == black || original == white;
            Selection selection{original, false};
            const auto kind = original == black ? WorldMarkerKind::Black : WorldMarkerKind::White;
            if (isMarker)
                selection = select_marker(image, x, y, kind);
            const auto key = color_key(selection.color);
            auto found = indices.find(key);
            if (isMarker && found == indices.end()) {
                // Native creation skips existing-object coordinate writes
                // and invokes metadata dependencies outside this slice.
                throw std::runtime_error("Marker introduces an unsupported region");
            }
            if (found == indices.end()) {
                if (result.palette.size() >= world_grid_max_regions) {
                    throw std::runtime_error("World grid region limit exceeded");
                }
                const auto index = static_cast<std::uint32_t>(result.palette.size());
                result.palette.push_back(selection.color);
                found = indices.emplace(key, index).first;
            }
            const auto region = found->second;
            const auto cell = static_cast<std::size_t>(worldY) * image.width + x;
            result.regionIndices[cell] = region;
            if (isMarker) {
                if (result.markers.size() >= world_grid_max_markers) {
                    throw std::runtime_error("World grid marker limit exceeded");
                }
                result.markers.push_back(WorldMarker{kind, x, y, x, worldY, selection.color, region,
                                                     !selection.fallback});
            }
        }
    }
    return result;
}

std::uint32_t WorldGrid::region_at(std::uint32_t x, std::uint32_t y) const {
    const auto pixels = checked_pixels(width, height);
    if (x >= width || y >= height) {
        throw std::out_of_range("World grid coordinate outside bounds");
    }
    if (regionIndices.size() != pixels || palette.empty() ||
        palette.size() > world_grid_max_regions) {
        throw std::runtime_error("World grid storage inconsistent");
    }
    const auto index = regionIndices[static_cast<std::size_t>(y) * width + x];
    if (index >= palette.size()) {
        throw std::runtime_error("World grid region index outside palette");
    }
    return index;
}

Rgb WorldGrid::rgb_at(std::uint32_t x, std::uint32_t y) const {
    return palette[region_at(x, y)];
}

} // namespace openrtw
