#pragma once

#include "aerial_ground_registry.hpp"
#include "aerial_mask_bank.hpp"
#include "aerial_normal_tile.hpp"
#include "aerial_tile_table.hpp"
#include "categories.hpp"
#include "climates.hpp"

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <span>
#include <stdexcept>
#include <vector>

namespace openrtw {

// OpenRTW atlas layout policy: pages of 32x32 cells, 32x32 texels per cell.
inline constexpr std::uint32_t aerial_tile_texels = 32;
inline constexpr std::uint32_t aerial_page_cells = 32;
inline constexpr std::uint32_t aerial_page_texels = aerial_page_cells * aerial_tile_texels;
inline constexpr std::size_t aerial_tile_bytes =
    std::size_t{aerial_tile_texels} * aerial_tile_texels * 4;
inline constexpr std::size_t aerial_page_bytes =
    std::size_t{aerial_page_texels} * aerial_page_texels * 4;

using AerialTileRgba = std::array<std::uint8_t, aerial_tile_bytes>;



struct AerialDecalImage {
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    std::vector<std::uint8_t> rgba;
};

inline constexpr std::uint32_t aerial_decal_max_side = 4096; // OpenRTW POLICY
inline constexpr std::uint32_t aerial_decal_owner_unspecified = UINT32_MAX;

struct AerialDecalRecord {
    std::int32_t imageX = 0; // [0]
    std::int32_t imageY = 0; // [1]
    std::int32_t startX = 0; // [2]
    std::int32_t startY = 0; // [3]
    std::uint32_t image = 0; // [4] decal image index
    // Source object's WORLD cell index x+layer.width*y, shared by EVERY spill
    // record. Default keeps legacy five-field aggregates ungated. Never use the
    // destination chunk cell as the owner's visibility location.
    std::uint32_t ownerCell = aerial_decal_owner_unspecified;
    friend bool operator==(const AerialDecalRecord&, const AerialDecalRecord&) = default;
};

// Decal records per cell plus the images they index, as consumed by the compositor.
struct AerialDecalLayer {
    std::uint32_t width = 0; // cells
    std::uint32_t height = 0;
    std::vector<AerialDecalImage> images; // by AerialDecalRecord::image
    // CSR: records of cell (x,y) are records[cellFirst[i] .. cellFirst[i+1]) with
    // i = x + width*y; size width*height+1 (or empty for an empty layer).
    std::vector<std::uint32_t> cellFirst;
    std::vector<AerialDecalRecord> records;

    bool empty() const noexcept { return records.empty(); }
    // Records of an in-map cell in native append order; empty span for an empty layer.
    std::span<const AerialDecalRecord> records_at(std::uint32_t x, std::uint32_t y) const noexcept {
        if (records.empty() || x >= width || y >= height)
            return {};
        const auto i = std::size_t{x} + std::size_t{width} * y;
        return std::span<const AerialDecalRecord>(records).subspan(cellFirst[i],
                                                                   cellFirst[i + 1] - cellFirst[i]);
    }
};

inline constexpr std::size_t aerial_decal_max_records_per_cell = 30;

// Validates a layer for AerialCampaignCompositor::set_decal_layer: extent, CSR shape,
// image sizes, record image indices of loaded images, start >= 0 and image offsets >= 0
// (the conditions under which blend_aerial_decals stays inside the tile and image).
// An empty layer (no records) is always accepted. Throws invalid_argument.
inline void validate_aerial_decal_layer(const AerialDecalLayer& layer, std::uint32_t width,
                                        std::uint32_t height) {
    if (layer.records.empty())
        return;
    if (layer.width != width || layer.height != height)
        throw std::invalid_argument("aerial decal layer: extent differs from the map");
    const auto cells = std::size_t{width} * height;
    if (layer.cellFirst.size() != cells + 1 || layer.cellFirst.front() != 0 ||
        layer.cellFirst.back() != layer.records.size())
        throw std::invalid_argument("aerial decal layer: malformed cell index");
    for (std::size_t i = 0; i < cells; ++i)
        if (layer.cellFirst[i] > layer.cellFirst[i + 1] ||
            layer.cellFirst[i + 1] - layer.cellFirst[i] > aerial_decal_max_records_per_cell)
            throw std::invalid_argument("aerial decal layer: malformed cell index");
    for (const auto& image : layer.images)
        if (image.width > aerial_decal_max_side || image.height > aerial_decal_max_side ||
            image.rgba.size() != std::size_t{image.width} * image.height * 4 ||
            (image.width == 0) != (image.height == 0))
            throw std::invalid_argument("aerial decal layer: malformed decal image");
    for (const auto& record : layer.records) {
        if (record.image >= layer.images.size() || !layer.images[record.image].width ||
            record.startX < 0 || record.startY < 0 || record.imageX < 0 || record.imageY < 0)
            throw std::invalid_argument("aerial decal layer: record outside the image domain");
        if (record.ownerCell != aerial_decal_owner_unspecified && record.ownerCell >= cells)
            throw std::invalid_argument("aerial decal layer: owner cell outside the map");
    }
}

inline void blend_aerial_decals(std::array<std::uint64_t, 1024>& words,
                                std::span<const AerialDecalRecord> records,
                                std::span<const AerialDecalImage> images,
                                std::span<const std::uint8_t> ownerVisibility = {}) noexcept {
    for (const auto& record : records) {
        if (!ownerVisibility.empty() && record.ownerCell != aerial_decal_owner_unspecified &&
            (record.ownerCell >= ownerVisibility.size() || ownerVisibility[record.ownerCell] == 0))
            continue;
        if (record.image >= images.size() || record.startX < 0 || record.startY < 0 ||
            record.imageX < 0 || record.imageY < 0)
            continue;
        const auto& image = images[record.image];
        const auto imageW = static_cast<std::int64_t>(image.width);
        const auto imageH = static_cast<std::int64_t>(image.height);
        if (!imageW || !imageH || image.rgba.size() != std::size_t(imageW * imageH * 4))
            continue;
        std::int64_t availX = 30 - record.startX, availY = 30 - record.startY;
        std::int64_t imageX = record.imageX, imageY = record.imageY;
        std::int64_t startX = record.startX, startY = record.startY;
        if (startX == 0 && imageX > 0) {
            --imageX;
            startX = -1;
            ++availX;
        }
        if (startY == 0 && imageY > 0) {
            --imageY;
            startY = -1;
            ++availY;
        }
        const auto w = std::min(std::max<std::int64_t>(availX + 1, 0), imageW - imageX);
        const auto h = std::min(std::max<std::int64_t>(availY + 1, 0), imageH - imageY);
        for (std::int64_t j = 0; j < h; ++j) {
            const auto* src =
                image.rgba.data() + 4 * ((imageH - 1 - (imageY + j)) * imageW + imageX);
            const auto row = 31 - (j + startY + 1);
            for (std::int64_t k = 0; k < w; ++k, src += 4) {
                auto& word = words[std::size_t(32 * (k + startX + 1) + row)];
                const std::uint32_t a = src[3], inv = 255 - a;
                const auto blend = [&](unsigned shift, std::uint32_t value) {
                    const auto dst = static_cast<std::uint32_t>((word >> shift) & 0xff);
                    const auto out = static_cast<std::uint16_t>(a * value + inv * dst) >> 8;
                    word = (word & ~(std::uint64_t{0xff} << shift)) |
                           (std::uint64_t{static_cast<std::uint8_t>(out)} << shift);
                };
                blend(8, src[0]);
                blend(24, src[1]);
                blend(40, src[2]);
            }
        }
    }
}

struct AerialDecalPage {
    std::uint32_t pageX = 0, pageY = 0;
    friend bool operator==(const AerialDecalPage&, const AerialDecalPage&) = default;
};

//
//
//
// Pages: tile (X,Y) at texel origin (32*(X%32), 32*(Y%32)) of page
// (X/32, Y/32); a 1024x1024 RGBA page row-major; slots beyond the map are
// (0,0,0,0). pagesX = ceil(W/32), pagesY = ceil(H/32).
//
//
//
//
// Copying is disabled (spans point into owned texture storage); moving keeps
// the heap buffers and therefore the spans valid.
class AerialCampaignCompositor {
public:
    // Validates every input before building: matching extents (points =
    // (2W+1)x(2H+1), climate map = points), categories 0..14, palette names,
    // order and winter rows equal to groundTypes.climates, a complete texture
    // set with one texture per registry name, 1..32767 patterns. Throws
    // invalid_argument/runtime_error. `textures` is moved from only after
    // everything else succeeded; on any refusal the caller keeps it intact.
    AerialCampaignCompositor(const CategoryGrid& cells, const CategoryPointGrid& points,
                             const ClimatePalette& palette, const RgbImage& climateMap,
                             const AerialGroundTypes& groundTypes,
                             AerialGroundTextureSet&& textures,
                             std::span<const AerialWeightPattern> patterns);
    AerialCampaignCompositor(const AerialCampaignCompositor&) = delete;
    AerialCampaignCompositor& operator=(const AerialCampaignCompositor&) = delete;
    AerialCampaignCompositor(AerialCampaignCompositor&&) noexcept = default;
    AerialCampaignCompositor& operator=(AerialCampaignCompositor&&) noexcept = default;

    std::uint32_t width() const noexcept { return cells_.width; }
    std::uint32_t height() const noexcept { return cells_.height; }
    std::uint32_t pages_x() const noexcept {
        return (cells_.width + aerial_page_cells - 1) / aerial_page_cells;
    }
    std::uint32_t pages_y() const noexcept {
        return (cells_.height + aerial_page_cells - 1) / aerial_page_cells;
    }
    const AerialGroundTypes& ground_types() const noexcept { return groundTypes_; }
    const AerialPointClimateGrid& point_climates() const noexcept { return climates_; }
    const AerialSeedGrid& seeds() const noexcept { return seeds_; }
    std::span<const AerialNormalTexture> registry() const noexcept { return registry_; }
    std::span<const AerialMaskWeights> masks() const noexcept { return bank_.blocks; }

    // Cell (x,y) table/words; out_of_range outside the map.
    AerialTileTable tile_table(std::uint32_t x, std::uint32_t y, bool winter) const;
    // True when some cell of the page has a season-dependent table, i.e.
    // compose_page(summer) and compose_page(winter) can differ: some point of
    // the page's point window (2X0..2X1+2, 2Y0..2Y1+2) selects a winter
    // climate whose slot has distinct columns, or the page touches the map
    // boundary and climate 0's fertility_low does (out-of-map border entries).
    // Exactly equivalent to comparing tile_table(x,y,false/true).records for
    // every cell of the page (the tests assert it). out_of_range outside.
    bool page_seasonal(std::uint32_t pageX, std::uint32_t pageY) const;
    AerialTileRgba compose_tile(std::uint32_t x, std::uint32_t y, bool winter) const;
    // out must be exactly aerial_page_bytes; page indices must be < pages_x/y.
    // Composes into private staging first: on refusal `out` is untouched.
    void compose_page(std::uint32_t pageX, std::uint32_t pageY, bool winter,
                      std::span<std::uint8_t> out) const;

    // Replaces the decal layer (records per cell + images, build_aerial_decal_layer).
    // An empty layer restores the plain ground. Throws invalid_argument (and keeps the
    // previous layer) when validate_aerial_decal_layer refuses it for this map.
    void set_decal_layer(AerialDecalLayer layer);
    const AerialDecalLayer& decal_layer() const noexcept { return decals_; }

    std::span<const AerialDecalPage> set_decal_visibility(std::span<const std::uint8_t> worldTable);
    std::span<const AerialDecalPage> clear_decal_visibility();
    std::span<const std::uint8_t> decal_visibility() const noexcept { return decalVisibility_; }
    std::span<const AerialDecalPage> decal_dirty_pages() const noexcept { return decalDirtyPages_; }

private:
    void compose_tile_into(std::uint32_t x, std::uint32_t y, bool winter, std::uint8_t* origin,
                           std::size_t rowStride) const;
    std::vector<AerialDecalPage>
    changed_decal_pages(std::span<const std::uint8_t> nextVisibility) const;

    CategoryGrid cells_;
    CategoryPointGrid points_;
    AerialPointClimateGrid climates_;
    AerialSeedGrid seeds_;
    AerialGroundTypes groundTypes_;
    std::vector<AerialTexturePixels> textures_;
    std::vector<AerialNormalTexture> registry_;
    AerialMaskBank bank_;
    AerialDecalLayer decals_;
    std::vector<std::uint8_t> decalVisibility_;
    std::vector<AerialDecalPage> decalDirtyPages_;
};

} // namespace openrtw
