#include "aerial_campaign_compositor.hpp"

#include "aerial_material_role.hpp"

#include <algorithm>
#include <stdexcept>
#include <utility>

namespace openrtw {
namespace {

void validate_categories(std::uint32_t width, std::uint32_t height, std::size_t size,
                         std::span<const std::uint8_t> bytes,
                         std::span<const std::uint32_t> words) {
    if (size != std::uint64_t{width} * height)
        throw std::invalid_argument("Aerial compositor: inconsistent category extent");
    for (const auto value : bytes)
        if (value > 14)
            throw std::invalid_argument("Aerial compositor: invalid point category");
    for (const auto value : words)
        if (value > 14)
            throw std::invalid_argument("Aerial compositor: invalid cell category");
}

} // namespace

AerialCampaignCompositor::AerialCampaignCompositor(
    const CategoryGrid& cells, const CategoryPointGrid& points, const ClimatePalette& palette,
    const RgbImage& climateMap, const AerialGroundTypes& groundTypes,
    AerialGroundTextureSet&& textures, std::span<const AerialWeightPattern> patterns)
    : cells_(cells), points_(points), groundTypes_(groundTypes) {
    if (!cells_.width || !cells_.height || cells_.width > (max_terrain_dimension - 1) / 2 ||
        cells_.height > (max_terrain_dimension - 1) / 2)
        throw std::invalid_argument("Aerial compositor: unsupported cell extent");
    if (points_.width != 2 * cells_.width + 1 || points_.height != 2 * cells_.height + 1 ||
        climateMap.width != points_.width || climateMap.height != points_.height)
        throw std::invalid_argument(
            "Aerial compositor: point/climate map extents must be (2W+1)x(2H+1)");
    validate_categories(cells_.width, cells_.height, cells_.categories.size(), {},
                        cells_.categories);
    validate_categories(points_.width, points_.height, points_.categories.size(),
                        points_.categories, {});
    if (palette.definitions.size() != groundTypes_.climates.size() || palette.definitions.empty())
        throw std::invalid_argument("Aerial compositor: climate palette and ground types disagree");
    for (std::size_t c = 0; c < palette.definitions.size(); ++c)
        if (palette.definitions[c].name != groundTypes_.climates[c].climateName ||
            aerial_climate_has_winter(palette.definitions[c]) != groundTypes_.climates[c].winter)
            throw std::invalid_argument(
                "Aerial compositor: climate palette and ground types disagree");
    const auto registrySize = groundTypes_.textureNames.size();
    if (!registrySize || registrySize > 65536)
        throw std::invalid_argument("Aerial compositor: texture registry needs 1..65536 names");
    for (const auto& climate : groundTypes_.climates)
        for (const auto& slot : climate.slots)
            for (const auto index : slot)
                if (index >= registrySize)
                    throw std::invalid_argument(
                        "Aerial compositor: slot outside the texture registry");
    if (textures.textures.size() != registrySize || !aerial_ground_texture_set_complete(textures))
        throw std::invalid_argument("Aerial compositor: every registry texture must be loaded");
    if (patterns.empty() || patterns.size() > 32767)
        throw std::invalid_argument("Aerial compositor: 1..32767 weight patterns required");

    // Build everything that can still refuse before taking the textures.
    auto climates = build_aerial_point_climate_grid(palette, climateMap);
    auto seeds = build_aerial_seed_grid(cells_.width, cells_.height);
    std::vector<std::span<const std::uint8_t>> spans;
    spans.reserve(patterns.size());
    for (const auto& pattern : patterns)
        spans.emplace_back(pattern);
    auto bank = build_aerial_mask_bank(spans, AerialMaskNumericPolicy::Extended64NearestEven);
    if (bank.blocks.size() != 2048)
        throw std::logic_error("Aerial compositor: mask bank extent");
    std::vector<AerialNormalTexture> registry;
    registry.reserve(registrySize);

    climates_ = std::move(climates);
    seeds_ = std::move(seeds);
    bank_ = std::move(bank);
    textures_ = std::move(textures.textures);
    textures.textures.clear();
    // Spans into the owned word vectors: built once, valid for the lifetime of
    // this object (vector moves keep their heap buffers).
    for (const auto& texture : textures_)
        registry.push_back({texture.side, texture.words});
    registry_ = std::move(registry);
}

AerialTileTable AerialCampaignCompositor::tile_table(std::uint32_t x, std::uint32_t y,
                                                     bool winter) const {
    return build_aerial_tile_table(cells_, points_, climates_, groundTypes_, seeds_, x, y, winter);
}

bool AerialCampaignCompositor::page_seasonal(std::uint32_t pageX, std::uint32_t pageY) const {
    if (pageX >= pages_x() || pageY >= pages_y())
        throw std::out_of_range("Aerial compositor: page outside the map");
    // A record's index is the only season term of a table (dark flags,
    // offsets and seed never depend on it), so an entry is seasonal iff its
    // climate has a winter row and the selected slot's two columns differ.
    const auto seasonal_entry = [&](std::uint8_t climate, std::int32_t category) {
        const auto role = select_aerial_material_role(category, 0, 0);
        if (!role)
            return false; // pseudo index in both seasons
        const auto& ground = groundTypes_.climates[climate];
        const auto& slot = ground.slots[static_cast<std::size_t>(*role)];
        return ground.winter && slot[0] != slot[1];
    };
    const auto firstX = pageX * aerial_page_cells, firstY = pageY * aerial_page_cells;
    const auto lastX = std::min(cells_.width, firstX + aerial_page_cells);
    const auto lastY = std::min(cells_.height, firstY + aerial_page_cells);
    // Out-of-map border entries of the outer-ring cells (build_aerial_tile_table).
    if ((firstX == 0 || lastX == cells_.width || firstY == 0 || lastY == cells_.height) &&
        seasonal_entry(0, 0))
        return true;
    // Every point of the window is read by at least one in-map entry of some
    // cell of the page (entries k=1/i=1 read offset 0, k=3/i=3 offset 2).
    for (auto py = 2 * firstY; py <= 2 * lastY; ++py)
        for (auto px = 2 * firstX; px <= 2 * lastX; ++px)
            if (seasonal_entry(climates_.index_at(px, py), points_.category_at(px, py)))
                return true;
    return false;
}

void AerialCampaignCompositor::compose_tile_into(std::uint32_t x, std::uint32_t y, bool winter,
                                                 std::uint8_t* origin,
                                                 std::size_t rowStride) const {
    const auto table = tile_table(x, y, winter);
    if (table.pseudo) {
        // OpenRTW policy (see header): whole tile magenta.
        for (std::uint32_t row = 0; row < aerial_tile_texels; ++row) {
            auto* pixel = origin + row * rowStride;
            for (std::uint32_t column = 0; column < aerial_tile_texels; ++column, pixel += 4) {
                pixel[0] = 255;
                pixel[1] = 0;
                pixel[2] = 255;
                pixel[3] = 255;
            }
        }
        return;
    }
    auto tile = build_aerial_normal_tile(table.records, registry_, bank_.blocks, table.offsetA,
                                         table.offsetB, table.seed, 0);
    if (const auto records = decals_.records_at(x, y); !records.empty())
        blend_aerial_decals(tile.words, records, decals_.images, decalVisibility_);
    for (std::uint32_t row = 0; row < aerial_tile_texels; ++row) {
        auto* pixel = origin + row * rowStride;
        for (std::uint32_t column = 0; column < aerial_tile_texels; ++column, pixel += 4) {
            const auto word = tile.words[aerial_tile_texels * column + row];
            pixel[0] = static_cast<std::uint8_t>(word >> 8);
            pixel[1] = static_cast<std::uint8_t>(word >> 24);
            pixel[2] = static_cast<std::uint8_t>(word >> 40);
            pixel[3] = 255;
        }
    }
}

void AerialCampaignCompositor::set_decal_layer(AerialDecalLayer layer) {
    validate_aerial_decal_layer(layer, cells_.width, cells_.height);
    decals_ = std::move(layer);
}

std::vector<AerialDecalPage>
AerialCampaignCompositor::changed_decal_pages(std::span<const std::uint8_t> nextVisibility) const {
    std::vector<AerialDecalPage> changed;
    if (decals_.empty())
        return changed;
    std::vector<std::uint8_t> pages(std::size_t{pages_x()} * pages_y(), 0);
    const auto admitted = [](std::span<const std::uint8_t> visibility, std::uint32_t owner) {
        return visibility.empty() || visibility[owner] != 0;
    };
    // CSR destinations identify every page touched by an owner's spill records.
    // The layer has already validated owner/image domains. O(cells+records),
    // bounded by the compositor extent and native30-record per-cell cap.
    for (std::uint32_t y = 0; y < cells_.height; ++y)
        for (std::uint32_t x = 0; x < cells_.width; ++x) {
            const auto page =
                std::size_t{y / aerial_page_cells} * pages_x() + x / aerial_page_cells;
            if (pages[page])
                continue;
            for (const auto& record : decals_.records_at(x, y)) {
                if (record.ownerCell == aerial_decal_owner_unspecified ||
                    admitted(decalVisibility_, record.ownerCell) ==
                        admitted(nextVisibility, record.ownerCell))
                    continue;
                // Placement can append a final chunk record with no covered
                // texels. It cannot change page pixels and needs no invalidation.
                const auto& image = decals_.images[record.image];
                std::int64_t imageX = record.imageX, imageY = record.imageY;
                std::int64_t startX = record.startX, startY = record.startY;
                if (startX == 0 && imageX > 0) {
                    --imageX;
                    --startX;
                }
                if (startY == 0 && imageY > 0) {
                    --imageY;
                    --startY;
                }
                if (std::min<std::int64_t>(31 - startX, std::int64_t{image.width} - imageX) <= 0 ||
                    std::min<std::int64_t>(31 - startY, std::int64_t{image.height} - imageY) <= 0)
                    continue;
                pages[page] = 1;
                break;
            }
        }
    for (std::uint32_t py = 0; py < pages_y(); ++py)
        for (std::uint32_t px = 0; px < pages_x(); ++px)
            if (pages[std::size_t{py} * pages_x() + px])
                changed.push_back({px, py});
    return changed;
}

std::span<const AerialDecalPage>
AerialCampaignCompositor::set_decal_visibility(std::span<const std::uint8_t> worldTable) {
    if (worldTable.size() != std::size_t{cells_.width} * cells_.height)
        throw std::invalid_argument("aerial decal visibility: table extent differs from the map");
    for (const auto value : worldTable)
        if (value > 99)
            throw std::invalid_argument("aerial decal visibility: cell value outside 0..99");
    std::vector<std::uint8_t> next(worldTable.begin(), worldTable.end());
    auto changed = changed_decal_pages(next);
    decalVisibility_.swap(next);
    decalDirtyPages_.swap(changed);
    return decalDirtyPages_;
}

std::span<const AerialDecalPage> AerialCampaignCompositor::clear_decal_visibility() {
    auto changed = changed_decal_pages({});
    std::vector<std::uint8_t>{}.swap(decalVisibility_);
    decalDirtyPages_.swap(changed);
    return decalDirtyPages_;
}

AerialTileRgba AerialCampaignCompositor::compose_tile(std::uint32_t x, std::uint32_t y,
                                                      bool winter) const {
    AerialTileRgba out{};
    compose_tile_into(x, y, winter, out.data(), std::size_t{aerial_tile_texels} * 4);
    return out;
}

void AerialCampaignCompositor::compose_page(std::uint32_t pageX, std::uint32_t pageY, bool winter,
                                            std::span<std::uint8_t> out) const {
    if (pageX >= pages_x() || pageY >= pages_y())
        throw std::out_of_range("Aerial compositor: page outside the map");
    if (out.size() != aerial_page_bytes || !out.data())
        throw std::invalid_argument("Aerial compositor: page output must be exactly 4194304 bytes");
    constexpr std::size_t rowStride = std::size_t{aerial_page_texels} * 4;
    // Private staging: a refusal while composing never publishes a partial page.
    std::vector<std::uint8_t> staging(aerial_page_bytes, 0);
    const auto firstX = pageX * aerial_page_cells, firstY = pageY * aerial_page_cells;
    const auto lastX = std::min(cells_.width, firstX + aerial_page_cells);
    const auto lastY = std::min(cells_.height, firstY + aerial_page_cells);
    for (auto y = firstY; y < lastY; ++y)
        for (auto x = firstX; x < lastX; ++x) {
            const auto originX = std::size_t{aerial_tile_texels} * (x - firstX);
            const auto originY = std::size_t{aerial_tile_texels} * (y - firstY);
            compose_tile_into(x, y, winter, staging.data() + originY * rowStride + originX * 4,
                              rowStride);
        }
    std::copy(staging.begin(), staging.end(), out.begin());
}

} // namespace openrtw
