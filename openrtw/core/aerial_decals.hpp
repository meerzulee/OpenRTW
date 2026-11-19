#pragma once

// Campaign ground decals ("underlays") and settlement terrain flattening.
//
//
// A native "chunk" is one map cell; its decal list is chunk+0 (20-byte records), the
// count chunk+600 (max 30) and the flattening flag byte chunk+604.
//

#include "aerial_campaign_compositor.hpp"
#include "faction_cultures.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace openrtw {

// Used by reference only (full definitions in campaign.hpp, world_grid.hpp; regions.hpp
// and terrain.hpp arrive with the compositor header).
struct Campaign;
struct WorldGrid;

// ---------------------------------------------------------------- descr_aerial_map_bases

struct AerialDecalBase {
    std::string type;     // record id, e.g. settlement_roman_level_1
    std::string filename;
    float range = 0.0f;   // cells; native record +16
};

struct AerialDecalBases {
    std::vector<AerialDecalBase> entries;

    std::int32_t find(std::string_view type) const;
};

inline constexpr std::size_t aerial_decal_max_bases = 100;

AerialDecalBases load_aerial_decal_bases(std::string_view text);

// ---------------------------------------------------------------- descr_cultures bindings

inline constexpr std::array<std::string_view, 6> aerial_settlement_levels{
    "village", "town", "large_town", "city", "large_city", "huge_city"};
// Settlement level name -> 0..5, nullopt for any other text.
std::optional<std::uint32_t> aerial_settlement_level_index(std::string_view level);

struct AerialDecalRef {
    std::string name;
    std::int32_t base = -1;
};

struct AerialCultureLevel {
    bool declared = false;
    AerialDecalRef normal;             // `normal <cas>, <decal>` (culture + 364 + 108*L + 104)
    std::vector<AerialDecalRef> walls; // `wall <cas>, <decal>` rows in order (+28 + 16*w)
};

struct AerialCultureBinding {
    std::string name;                         // `culture <name>`
    std::array<AerialCultureLevel, 6> levels; // village..huge_city
    AerialDecalRef fort;                      // culture + 44
    AerialDecalRef fishingVillage;            // culture + 80
    std::array<AerialDecalRef, 3> portLand;   // culture + 116 + 36*i
    AerialDecalRef watchtower;                // culture + 332
};

struct AerialCultureBindings {
    std::vector<AerialCultureBinding> cultures;
    std::vector<std::string> unresolved;

    // Exact culture-name lookup; -1 when absent.
    std::int32_t find(std::string_view culture) const;
};

AerialCultureBindings load_aerial_culture_bindings(std::string_view text,
                                                   const AerialDecalBases& bases);

// ---------------------------------------------------------------- decal images

// AerialDecalImage and aerial_decal_max_side: aerial_campaign_compositor.hpp.

// Uncompressed true-colour TGA (type 2), 32 bpp, 8 alpha bits, no colour map, any ID
// length, either orientation bit, optionally followed by a 26-byte TGA 2.0 footer
// ("TRUEVISION-XFILE.\0"). The payload length must be exact. Interleaved descriptors,
// other depths/types and sides outside 1..4096 refuse (OpenRTW POLICY; the vanilla
// files are 42..77 px squares with descriptor 0x08 and a footer). Throws runtime_error.
AerialDecalImage load_aerial_decal_tga(std::span<const std::uint8_t> bytes);

// ---------------------------------------------------------------- map objects

enum class AerialMapObjectType : std::uint8_t {
    settlement = 27,
    fort = 28,
    port = 29,
    watchtower = 30,
};

struct AerialMapObject {
    AerialMapObjectType type = AerialMapObjectType::settlement;
    std::uint32_t x = 0;       // cell, west->east
    std::uint32_t y = 0;       // cell, south->north (world rows, y = imageHeight-1-imageRow)
    std::uint32_t culture = 0; // AerialCultureBindings index
    // Settlement: level index 0..5 (field [109]). Port: port level (field [15]) 0..3,
    // 0 = fishing village. Ignored for forts and watchtowers.
    std::int32_t level = 0;
    // Settlement wall row index (5C4029, -1 = no walls). Ignored for other types.
    std::int32_t wall = -1;
    std::string region; // diagnostics: descr_strat region id
};

struct AerialRegionMarker {
    std::string region; // descr_regions id
    std::uint32_t blackMarkers = 0;
    std::uint32_t whiteMarkers = 0;
    // First black (settlement) / white (port) marker of the region in image scan order,
    // as world cells (worldX, worldY).
    std::optional<std::array<std::uint32_t, 2>> settlement;
    std::optional<std::array<std::uint32_t, 2>> port;
};

struct AerialRegionMarkers {
    // Same order as RegionDefinitions::definitions.
    std::vector<AerialRegionMarker> regions;
    const AerialRegionMarker* find(std::string_view region) const;
};

// Settlement (black) and port (white) markers per descr_regions definition, from the
// one-pass region map projection of build_world_grid (0x47E14D). A marker belongs to
// the region whose colour its neighbour rule selected (WorldMarker::selectedRgb),
// matched against RegionDefinition::rgb exactly; markers of colours without a
// definition are ignored. OpenRTW POLICY: when a region has several markers of one
// kind the first in image scan order is used (vanilla has exactly one black marker per
// land region). Throws invalid_argument when a marker's regionIndex is outside
// grid.palette (an inconsistent grid).
AerialRegionMarkers build_aerial_region_markers(const RegionDefinitions& regions,
                                                const WorldGrid& grid);

struct AerialMapObjects {
    std::vector<AerialMapObject> objects;
    // One line per settlement or port that produced no object, and per object whose
    // culture row has no decal for its level/wall/port level (diagnostics, not errors).
    std::vector<std::string> problems;
};

AerialMapObjects build_aerial_map_objects(const Campaign& campaign,
                                          std::span<const FactionCulture> factionCultures,
                                          const AerialCultureBindings& cultures,
                                          const AerialRegionMarkers& markers);


std::int32_t select_aerial_decal_base(const AerialMapObject& object,
                                      const AerialCultureBindings& cultures);

struct AerialDecalSelection {
    std::uint32_t object = 0; // index into the object span
    std::uint32_t x = 0;      // object cell
    std::uint32_t y = 0;
    std::uint32_t base = 0;     // AerialDecalBases index == decal image index (+20)
    float range = 0.0f;         // +16, cells
    bool fixedHeight = false;   // port: flatten to 20.0 instead of the centre height
    bool quarterOffset = false;
};

std::vector<AerialDecalSelection> select_aerial_decals(std::span<const AerialMapObject> objects,
                                                       const AerialCultureBindings& cultures,
                                                       const AerialDecalBases& bases);

// ---------------------------------------------------------------- placement


struct AerialDecalAnchor {
    std::int32_t cellX = 0; // first (south-west) chunk the image touches
    std::int32_t cellY = 0;
    std::int32_t startX = 0;
    std::int32_t startY = 0;
};

AerialDecalAnchor aerial_decal_anchor(std::int32_t cellX, std::int32_t cellY,
                                      std::uint32_t imageWidth, std::uint32_t imageHeight,
                                      bool quarterOffset);

struct AerialChunkDecalRecord {
    std::int32_t chunkX = 0;
    std::int32_t chunkY = 0;
    AerialDecalRecord record;
};

std::vector<AerialChunkDecalRecord> place_aerial_decal(const AerialDecalAnchor& anchor,
                                                       std::uint32_t imageWidth,
                                                       std::uint32_t imageHeight,
                                                       std::uint32_t image, std::uint32_t mapWidth,
                                                       std::uint32_t mapHeight);

AerialDecalLayer build_aerial_decal_layer(std::uint32_t width, std::uint32_t height,
                                          std::span<const AerialDecalSelection> selections,
                                          std::vector<AerialDecalImage> images);


struct AerialHeightOverride {
    std::uint32_t px = 0; // HGT point column (0..2W)
    std::uint32_t py = 0; // HGT point row (0..2H), py grows north; index py*(2W+1)+px
    float height = 0.0f;  // HGT units, same as Terrain::height_at
    friend bool operator==(const AerialHeightOverride&, const AerialHeightOverride&) = default;
};

struct AerialFlattening {
    std::uint32_t width = 0; // cells
    std::uint32_t height = 0;
    std::vector<AerialHeightOverride> points;
    std::vector<std::uint8_t> chunkFlags;
};

AerialFlattening build_aerial_flattening(const Terrain& terrain,
                                         std::span<const AerialDecalSelection> selections);

} // namespace openrtw
