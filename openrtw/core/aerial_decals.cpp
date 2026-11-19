#include "aerial_decals.hpp"

#include "campaign.hpp"
#include "world_grid.hpp"

#include <bit>
#include <charconv>
#include <cmath>
#include <cstring>
#include <stdexcept>
#include <utility>

namespace openrtw {
namespace {

// ------------------------------------------------------------ native script tokens

bool separator(char c) {
    return c == ' ' || c == '\t' || c == '\0' || c == '\r' || c == ',' || c == ':';
}

bool value_end(char c) {
    return c == ',' || c == '\t' || c == '\0' || c == '\r';
}

class ScriptLines {
public:
    explicit ScriptLines(std::string_view text) : rest_(text) {}
    bool next(std::string_view& line) {
        if (done_)
            return false;
        ++number_;
        const auto newline = rest_.find('\n');
        line = rest_.substr(0, newline);
        if (newline == std::string_view::npos)
            done_ = true;
        else
            rest_.remove_prefix(newline + 1);
        if (const auto comment = line.find(';'); comment != std::string_view::npos)
            line = line.substr(0, comment);
        return true;
    }
    std::size_t number() const { return number_; }

private:
    std::string_view rest_;
    std::size_t number_ = 0;
    bool done_ = false;
};

std::string_view next_word(std::string_view& line) {
    std::size_t begin = 0;
    while (begin < line.size() && separator(line[begin]))
        ++begin;
    auto end = begin;
    while (end < line.size() && !separator(line[end]))
        ++end;
    const auto word = line.substr(begin, end - begin);
    line.remove_prefix(end);
    return word;
}

std::string_view next_value(std::string_view& line) {
    std::size_t begin = 0;
    while (begin < line.size() && separator(line[begin]))
        ++begin;
    auto end = begin;
    while (end < line.size() && !value_end(line[end]))
        ++end;
    auto last = end;
    while (last > begin && separator(line[last - 1]))
        --last;
    const auto value = line.substr(begin, last - begin);
    line.remove_prefix(end);
    return value;
}

void check_ascii(std::string_view text, const char* what) {
    if (text.size() > 1024 * 1024)
        throw std::runtime_error(std::string(what) + ": input larger than 1 MiB");
    for (const char c : text)
        if (static_cast<unsigned char>(c) > 127)
            throw std::runtime_error(std::string(what) + ": non-ASCII input");
}

[[noreturn]] void refuse_line(const char* what, std::size_t line, const std::string& why) {
    throw std::runtime_error(std::string(what) + " line " + std::to_string(line) + ": " + why);
}

// ------------------------------------------------------------ TGA helpers

std::uint16_t le16(std::span<const std::uint8_t> b, std::size_t at) {
    return static_cast<std::uint16_t>(b[at] | (b[at + 1] << 8));
}

// TGA 2.0 footer: extension offset, developer offset, "TRUEVISION-XFILE.\0".
constexpr std::size_t tga_footer_bytes = 26;
bool has_tga_footer(std::span<const std::uint8_t> bytes) {
    static constexpr char signature[] = "TRUEVISION-XFILE.";
    if (bytes.size() < 18 + tga_footer_bytes)
        return false;
    return std::memcmp(bytes.data() + bytes.size() - 18, signature, 18) == 0;
}

// Index of descr_strat defenses levels (export_descr_buildings `levels` order, which
// is also the capability wall_level 0..4).
constexpr std::array<std::string_view, 5> defense_levels{
    "wooden_pallisade", "wooden_wall", "stone_wall", "large_stone_wall", "epic_stone_wall"};
// OpenRTW POLICY (see header): EDB port_buildings levels -> port level 1..3.
constexpr std::array<std::string_view, 3> port_levels{"port", "shipwright", "dockyard"};

// The `type <tree> <level>` row of an opaque descr_strat building block.
bool building_type(const SettlementBuilding& building, std::string_view& tree,
                   std::string_view& level) {
    for (const auto& source : building.source) {
        std::string_view line = source.text;
        if (const auto comment = line.find(';'); comment != std::string_view::npos)
            line = line.substr(0, comment);
        if (next_word(line) != "type")
            continue;
        tree = next_word(line);
        level = next_word(line);
        return !tree.empty();
    }
    return false;
}

std::int32_t index_of(std::span<const std::string_view> names, std::string_view name) {
    for (std::size_t i = 0; i < names.size(); ++i)
        if (names[i] == name)
            return static_cast<std::int32_t>(i);
    return -1;
}

} // namespace

// ------------------------------------------------------------ bases

std::int32_t AerialDecalBases::find(std::string_view type) const {
    for (std::size_t i = 0; i < entries.size(); ++i)
        if (entries[i].type == type)
            return static_cast<std::int32_t>(i);
    return -1;
}

AerialDecalBases load_aerial_decal_bases(std::string_view text) {
    static constexpr const char* what = "descr_aerial_map_bases";
    check_ascii(text, what);
    AerialDecalBases result;
    ScriptLines lines(text);
    std::string_view line;
    static constexpr std::array<std::string_view, 3> keywords{"type", "filename", "range"};
    std::size_t expected = 0;
    AerialDecalBase record;
    while (lines.next(line)) {
        const auto keyword = next_word(line);
        if (keyword.empty())
            continue; // blank or comment-only line
        if (keyword != keywords[expected])
            refuse_line(what, lines.number(),
                        "expecting `" + std::string(keywords[expected]) + "`");
        if (expected == 0) {
            const auto type = next_value(line);
            if (type.empty())
                refuse_line(what, lines.number(), "type row without an id");
            if (result.find(type) >= 0)
                refuse_line(what, lines.number(), "duplicate id " + std::string(type));
            if (result.entries.size() >= aerial_decal_max_bases)
                refuse_line(what, lines.number(), "more than 100 records");
            record = {};
            record.type = std::string(type);
        } else if (expected == 1) {
            const auto filename = next_value(line);
            if (filename.empty())
                refuse_line(what, lines.number(), "filename row without a path");
            record.filename = std::string(filename);
        } else {
            const auto number = next_word(line);
            float range = 0.0f;
            const auto parsed =
                std::from_chars(number.data(), number.data() + number.size(), range);
            if (number.empty() || parsed.ec != std::errc{} ||
                parsed.ptr != number.data() + number.size() || !std::isfinite(range) ||
                range < 0.0f)
                refuse_line(what, lines.number(), "range must be a finite number >= 0");
            record.range = range;
            result.entries.push_back(std::move(record));
        }
        expected = (expected + 1) % 3;
    }
    if (expected != 0)
        throw std::runtime_error("descr_aerial_map_bases: incomplete last record");
    return result;
}

// ------------------------------------------------------------ culture bindings

std::optional<std::uint32_t> aerial_settlement_level_index(std::string_view level) {
    for (std::uint32_t i = 0; i < aerial_settlement_levels.size(); ++i)
        if (aerial_settlement_levels[i] == level)
            return i;
    return std::nullopt;
}

std::int32_t AerialCultureBindings::find(std::string_view culture) const {
    for (std::size_t i = 0; i < cultures.size(); ++i)
        if (cultures[i].name == culture)
            return static_cast<std::int32_t>(i);
    return -1;
}

AerialCultureBindings load_aerial_culture_bindings(std::string_view text,
                                                   const AerialDecalBases& bases) {
    static constexpr const char* what = "descr_cultures";
    check_ascii(text, what);
    AerialCultureBindings result;
    constexpr std::size_t maxCultures = 7;
    std::vector<AerialCultureBinding> parsed;
    std::vector<std::size_t> portLandRows;
    const auto resolve = [&](std::string_view name) {
        AerialDecalRef ref;
        ref.name = std::string(name);
        if (name.empty())
            return ref;              // no decal name on the row: the native slot stays null
        ref.base = bases.find(name);
        if (ref.base < 0) {
            bool seen = false;
            for (const auto& u : result.unresolved)
                seen |= u == name;
            if (!seen)
                result.unresolved.push_back(ref.name);
        }
        return ref;
    };
    // `<keyword> <cas>, <decal>`: skip the CAS word, then the decal value.
    const auto decal_of = [&](std::string_view& line) {
        next_word(line);
        return resolve(next_value(line));
    };
    const auto finish_culture = [&](std::size_t lineNumber) {
        if (!parsed.empty() && portLandRows.back() != 3)
            refuse_line(what, lineNumber, "a culture needs exactly 3 port_land rows");
    };

    ScriptLines lines(text);
    std::string_view line;
    int depth = 0;
    std::optional<std::uint32_t> pendingLevel, currentLevel;
    while (lines.next(line)) {
        const auto keyword = next_word(line);
        if (keyword.empty())
            continue;
        const auto n = lines.number();
        if (keyword == "{") {
            if (depth == 0) {
                if (parsed.empty())
                    refuse_line(what, n, "level list before any culture");
            } else if (depth == 1) {
                if (!pendingLevel)
                    refuse_line(what, n, "level block without a level name");
                currentLevel = pendingLevel;
                pendingLevel.reset();
            } else {
                refuse_line(what, n, "unexpected `{`");
            }
            ++depth;
            continue;
        }
        if (keyword == "}") {
            if (depth == 0)
                refuse_line(what, n, "unbalanced `}`");
            if (depth == 1 && pendingLevel)
                refuse_line(what, n, "level name without a block");
            if (depth == 2) {
                if (!parsed.back().levels[*currentLevel].declared)
                    refuse_line(what, n, "level block without a `normal` row");
                currentLevel.reset();
            }
            --depth;
            continue;
        }
        if (depth == 1) {
            const auto level = aerial_settlement_level_index(keyword);
            if (!level || pendingLevel)
                refuse_line(what, n, "expected a settlement level, found " + std::string(keyword));
            if (parsed.back().levels[*level].declared)
                refuse_line(what, n, "duplicate settlement level " + std::string(keyword));
            pendingLevel = level;
            continue;
        }
        if (depth == 2) {
            auto& level = parsed.back().levels[*currentLevel];
            if (keyword == "normal") {
                if (level.declared)
                    refuse_line(what, n, "second `normal` row in one level");
                level.declared = true;
                level.normal = decal_of(line);
            } else if (keyword == "wall") {
                if (!level.declared)
                    refuse_line(what, n, "`wall` row before the `normal` row");
                if (level.walls.size() >= 5)
                    refuse_line(what, n, "more than five `wall` rows in one level");
                level.walls.push_back(decal_of(line));
            }
            continue; // card and anything else inside a level block
        }
        if (depth > 2)
            continue;
        // depth 0
        if (keyword == "culture") {
            finish_culture(n);
            const auto name = next_word(line);
            if (name.empty())
                refuse_line(what, n, "culture row without a name");
            for (const auto& c : parsed)
                if (c.name == name)
                    refuse_line(what, n, "duplicate culture " + std::string(name));
            parsed.emplace_back();
            parsed.back().name = std::string(name);
            portLandRows.push_back(0);
            continue;
        }
        if (parsed.empty())
            continue; // symbol / siege / blockade header rows
        auto& culture = parsed.back();
        if (keyword == "fort") {
            culture.fort = decal_of(line);
        } else if (keyword == "fishing_village") {
            culture.fishingVillage = decal_of(line);
        } else if (keyword == "port_land") {
            if (portLandRows.back() >= 3)
                refuse_line(what, n, "a culture needs exactly 3 port_land rows");
            culture.portLand[portLandRows.back()++] = decal_of(line);
        } else if (keyword == "watchtower") {
            culture.watchtower = decal_of(line);
        }
    }
    if (depth != 0)
        throw std::runtime_error("descr_cultures: unbalanced braces at end of input");
    finish_culture(lines.number());
    if (parsed.size() > maxCultures)
        parsed.resize(maxCultures);
    result.cultures = std::move(parsed);
    return result;
}

// ------------------------------------------------------------ images

AerialDecalImage load_aerial_decal_tga(std::span<const std::uint8_t> bytes) {
    if (bytes.size() < 18)
        throw std::runtime_error("decal TGA: truncated header");
    const auto idLength = bytes[0];
    const auto colorMapType = bytes[1];
    const auto imageType = bytes[2];
    const auto width = le16(bytes, 12), height = le16(bytes, 14);
    const auto depth = bytes[16], descriptor = bytes[17];
    if (colorMapType != 0 || imageType != 2 || depth != 32)
        throw std::runtime_error("decal TGA: only uncompressed 32-bit true-colour is supported");
    if ((descriptor & 0x0f) != 8 || (descriptor & 0xc0) != 0)
        throw std::runtime_error("decal TGA: descriptor must carry 8 alpha bits, no interleave");
    if (!width || !height || width > aerial_decal_max_side || height > aerial_decal_max_side)
        throw std::runtime_error("decal TGA: unsupported dimensions");
    const auto payload = std::size_t{width} * height * 4;
    const auto plain = 18 + std::size_t{idLength} + payload;
    if (bytes.size() != plain &&
        !(bytes.size() == plain + tga_footer_bytes && has_tga_footer(bytes)))
        throw std::runtime_error("decal TGA: length does not match the header");
    AerialDecalImage image;
    image.width = width;
    image.height = height;
    image.rgba.resize(payload);
    const auto* pixels = bytes.data() + 18 + idLength;
    const bool bottomUp = (descriptor & 0x20) == 0, rightToLeft = (descriptor & 0x10) != 0;
    for (std::uint32_t row = 0; row < height; ++row) {
        const auto fileRow = bottomUp ? height - 1 - row : row;
        for (std::uint32_t column = 0; column < width; ++column) {
            const auto fileColumn = rightToLeft ? width - 1 - column : column;
            const auto* src = pixels + (std::size_t{fileRow} * width + fileColumn) * 4;
            auto* dst = image.rgba.data() + (std::size_t{row} * width + column) * 4;
            dst[0] = src[2];
            dst[1] = src[1];
            dst[2] = src[0];
            dst[3] = src[3];
        }
    }
    return image;
}

// ------------------------------------------------------------ markers and objects

const AerialRegionMarker* AerialRegionMarkers::find(std::string_view region) const {
    for (const auto& r : regions)
        if (r.region == region)
            return &r;
    return nullptr;
}

AerialRegionMarkers build_aerial_region_markers(const RegionDefinitions& regions,
                                                const WorldGrid& grid) {
    AerialRegionMarkers result;
    result.regions.reserve(regions.definitions.size());
    for (const auto& definition : regions.definitions) {
        AerialRegionMarker marker;
        marker.region = definition.id;
        result.regions.push_back(std::move(marker));
    }
    for (const auto& m : grid.markers) {
        if (m.regionIndex >= grid.palette.size())
            throw std::invalid_argument("aerial markers: marker region outside the palette");
        for (std::size_t i = 0; i < regions.definitions.size(); ++i) {
            if (regions.definitions[i].rgb != m.selectedRgb)
                continue;
            auto& r = result.regions[i];
            const std::array<std::uint32_t, 2> cell{m.worldX, m.worldY};
            if (m.rawKind == WorldMarkerKind::Black) {
                if (!r.blackMarkers++)
                    r.settlement = cell;
            } else {
                if (!r.whiteMarkers++)
                    r.port = cell;
            }
            break;
        }
    }
    return result;
}

AerialMapObjects build_aerial_map_objects(const Campaign& campaign,
                                          std::span<const FactionCulture> factionCultures,
                                          const AerialCultureBindings& cultures,
                                          const AerialRegionMarkers& markers) {
    AerialMapObjects result;
    for (const auto& faction : campaign.factions)
        for (const auto& settlement : faction.settlements) {
            const auto label = "settlement " + settlement.region;
            const auto creator =
                settlement.factionCreator.empty() ? faction.id : settlement.factionCreator;
            std::string_view cultureName;
            for (const auto& f : factionCultures)
                if (f.faction == creator)
                    cultureName = f.culture;
            if (cultureName.empty()) {
                result.problems.push_back(label + ": faction " + creator +
                                          " has no descr_sm_factions culture");
                continue;
            }
            const auto culture = cultures.find(cultureName);
            if (culture < 0) {
                result.problems.push_back(label + ": culture " + std::string(cultureName) +
                                          " has no descr_cultures binding");
                continue;
            }
            const auto level = aerial_settlement_level_index(settlement.level);
            if (!level) {
                result.problems.push_back(label + ": unknown level " + settlement.level);
                continue;
            }
            const auto* marker = markers.find(settlement.region);
            if (!marker || !marker->settlement) {
                result.problems.push_back(label + ": region has no settlement marker");
                continue;
            }
            std::int32_t wall = -1, port = -1;
            for (const auto& building : settlement.buildings) {
                std::string_view tree, buildingLevel;
                if (!building_type(building, tree, buildingLevel))
                    continue;
                if (tree == "defenses") {
                    wall = index_of(defense_levels, buildingLevel);
                    if (wall < 0)
                        result.problems.push_back(label + ": unknown defenses level " +
                                                  std::string(buildingLevel));
                } else if (tree == "port_buildings") {
                    const auto index = index_of(port_levels, buildingLevel);
                    if (index < 0)
                        result.problems.push_back(label + ": unknown port level " +
                                                  std::string(buildingLevel));
                    else
                        port = index + 1;
                }
            }
            AerialMapObject object;
            object.type = AerialMapObjectType::settlement;
            object.x = (*marker->settlement)[0];
            object.y = (*marker->settlement)[1];
            object.culture = static_cast<std::uint32_t>(culture);
            object.level = static_cast<std::int32_t>(*level);
            object.wall = wall;
            object.region = settlement.region;
            if (select_aerial_decal_base(object, cultures) < 0)
                result.problems.push_back(label + ": culture " + std::string(cultureName) +
                                          " has no decal for level " + settlement.level +
                                          (wall >= 0 ? " wall " + std::to_string(wall) : ""));
            result.objects.push_back(object);
            if (port < 0)
                continue;
            if (!marker->port) {
                result.problems.push_back(label + ": port building but no port marker");
                continue;
            }
            object.type = AerialMapObjectType::port;
            object.x = (*marker->port)[0];
            object.y = (*marker->port)[1];
            object.level = port;
            object.wall = -1;
            if (select_aerial_decal_base(object, cultures) < 0)
                result.problems.push_back(label + ": culture " + std::string(cultureName) +
                                          " has no decal for port level " + std::to_string(port));
            result.objects.push_back(object);
        }
    return result;
}

// ------------------------------------------------------------ selection

std::int32_t select_aerial_decal_base(const AerialMapObject& object,
                                      const AerialCultureBindings& cultures) {
    if (object.culture >= cultures.cultures.size())
        throw std::out_of_range("aerial decals: object culture outside the bindings");
    const auto& culture = cultures.cultures[object.culture];
    switch (object.type) {
    case AerialMapObjectType::settlement: {
        const auto level = object.level >= 1 && object.level <= 5
                               ? static_cast<std::size_t>(object.level)
                               : std::size_t{0};
        const auto& block = culture.levels[level];
        if (object.wall > 4)
            throw std::invalid_argument("aerial decals: wall index outside the 5 wall slots");
        if (object.wall >= 0) // culture + 108*L + 364 + 16*w + 28
            return static_cast<std::size_t>(object.wall) < block.walls.size()
                       ? block.walls[static_cast<std::size_t>(object.wall)].base
                       : -1;
        return block.normal.base; // culture + 108*L + 468
    }
    case AerialMapObjectType::fort:
        return culture.fort.base; // culture + 44
    case AerialMapObjectType::port:
        // Port field [15]: 0 -> culture + 80; 1..3 -> culture + 116 + 36*(level-1);
        // other values leave the native index at 0.
        if (object.level == 0)
            return culture.fishingVillage.base;
        if (object.level >= 1 && object.level <= 3)
            return culture.portLand[static_cast<std::size_t>(object.level - 1)].base;
        return culture.portLand[0].base;
    case AerialMapObjectType::watchtower:
        return culture.watchtower.base; // culture + 332
    }
    throw std::invalid_argument("aerial decals: unknown map object type");
}

std::vector<AerialDecalSelection> select_aerial_decals(std::span<const AerialMapObject> objects,
                                                       const AerialCultureBindings& cultures,
                                                       const AerialDecalBases& bases) {
    std::vector<AerialDecalSelection> result;
    for (std::size_t i = 0; i < objects.size(); ++i) {
        const auto& object = objects[i];
        const auto base = select_aerial_decal_base(object, cultures);
        if (base < 0)
            continue;
        if (static_cast<std::size_t>(base) >= bases.entries.size())
            throw std::out_of_range("aerial decals: base record outside the database");
        AerialDecalSelection selection;
        selection.object = static_cast<std::uint32_t>(i);
        selection.x = object.x;
        selection.y = object.y;
        selection.base = static_cast<std::uint32_t>(base);
        selection.range = bases.entries[static_cast<std::size_t>(base)].range;
        selection.fixedHeight = object.type == AerialMapObjectType::port;
        selection.quarterOffset = object.type == AerialMapObjectType::watchtower;
        result.push_back(selection);
    }
    std::stable_sort(result.begin(), result.end(), [](const auto& a, const auto& b) {
        return a.y != b.y ? a.y < b.y : a.x < b.x;
    });
    return result;
}

// ------------------------------------------------------------ placement

AerialDecalAnchor aerial_decal_anchor(std::int32_t cellX, std::int32_t cellY,
                                      std::uint32_t imageWidth, std::uint32_t imageHeight,
                                      bool quarterOffset) {
    if (imageWidth > aerial_decal_max_side || imageHeight > aerial_decal_max_side)
        throw std::invalid_argument("aerial decals: image side outside 0..4096");
    const auto w = static_cast<std::int32_t>(imageWidth),
               h = static_cast<std::int32_t>(imageHeight);
    auto halfX = w >> 1, halfY = h >> 1;
    if (quarterOffset) {
        halfX += static_cast<std::int32_t>(std::nearbyint(-(-0.25f) * 30.0f));
        halfY += static_cast<std::int32_t>(std::nearbyint(-0.25f * 30.0f));
    }
    constexpr std::int32_t centre = 15;
    AerialDecalAnchor anchor{cellX, cellY, 0, 0};
    const auto rowsAbove = h - 1 - halfY;
    if (halfX <= centre) {
        anchor.startX = centre - halfX;
    } else {
        anchor.cellX -= (halfX - centre) / 30 + 1;
        anchor.startX = 30 - (halfX - centre) % 30;
    }
    if (rowsAbove <= centre) {
        anchor.startY = centre - rowsAbove;
    } else {
        anchor.cellY -= (rowsAbove - centre) / 30 + 1;
        anchor.startY = 30 - (rowsAbove - centre) % 30;
    }
    return anchor;
}

std::vector<AerialChunkDecalRecord> place_aerial_decal(const AerialDecalAnchor& anchor,
                                                       std::uint32_t imageWidth,
                                                       std::uint32_t imageHeight,
                                                       std::uint32_t image, std::uint32_t mapWidth,
                                                       std::uint32_t mapHeight) {
    if (imageWidth > aerial_decal_max_side || imageHeight > aerial_decal_max_side)
        throw std::invalid_argument("aerial decals: image side outside 0..4096");
    const auto w = static_cast<std::int64_t>(imageWidth),
               h = static_cast<std::int64_t>(imageHeight);
    const auto columns = (w - (30 - anchor.startX)) / 30 + 2;
    const auto rows = (h - (30 - anchor.startY)) / 30 + 2;
    std::vector<AerialChunkDecalRecord> result;
    std::int64_t imageY = 0, startY = anchor.startY;
    for (std::int64_t i = 0; i < rows; ++i) {
        std::int64_t imageX = 0, startX = anchor.startX;
        for (std::int64_t j = 0; j < columns; ++j) {
            const auto chunkX = std::int64_t{anchor.cellX} + j;
            const auto chunkY = std::int64_t{anchor.cellY} + i;
            if (chunkX >= 0 && chunkX < mapWidth && chunkY >= 0 && chunkY < mapHeight)
                result.push_back(
                    {static_cast<std::int32_t>(chunkX),
                     static_cast<std::int32_t>(chunkY),
                     {static_cast<std::int32_t>(imageX), static_cast<std::int32_t>(imageY),
                      static_cast<std::int32_t>(startX), static_cast<std::int32_t>(startY),
                      image}});
            imageX += 30 - startX;
            startX = 0;
        }
        imageY += 30 - startY;
        startY = 0;
    }
    return result;
}

AerialDecalLayer build_aerial_decal_layer(std::uint32_t width, std::uint32_t height,
                                          std::span<const AerialDecalSelection> selections,
                                          std::vector<AerialDecalImage> images) {
    if (!width || !height || width > max_terrain_dimension || height > max_terrain_dimension)
        throw std::invalid_argument("aerial decals: unsupported map extent");
    for (const auto& image : images)
        if (image.width > aerial_decal_max_side || image.height > aerial_decal_max_side ||
            image.rgba.size() != std::size_t{image.width} * image.height * 4 ||
            (!image.width != !image.height))
            throw std::invalid_argument("aerial decals: malformed decal image");
    const auto cells = std::size_t{width} * height;
    std::vector<std::vector<AerialDecalRecord>> perCell(cells);
    for (const auto& selection : selections) {
        if (selection.x >= width || selection.y >= height)
            throw std::invalid_argument("aerial decals: selection owner outside the map");
        if (selection.base >= images.size())
            throw std::invalid_argument("aerial decals: selection image outside the image list");
        const auto& image = images[selection.base];
        if (!image.width)
            continue;
        const auto anchor = aerial_decal_anchor(static_cast<std::int32_t>(selection.x),
                                                static_cast<std::int32_t>(selection.y), image.width,
                                                image.height, selection.quarterOffset);
        for (const auto& placed :
             place_aerial_decal(anchor, image.width, image.height, selection.base, width, height)) {
            auto& list = perCell[std::size_t(placed.chunkX) + std::size_t{width} * placed.chunkY];
            if (list.size() < aerial_decal_max_records_per_cell) {
                auto record = placed.record;
                record.ownerCell = selection.y * width + selection.x;
                list.push_back(record);
            }
        }
    }
    AerialDecalLayer layer;
    layer.width = width;
    layer.height = height;
    layer.images = std::move(images);
    std::size_t total = 0;
    for (const auto& list : perCell)
        total += list.size();
    if (!total)
        return layer;
    layer.cellFirst.reserve(cells + 1);
    layer.records.reserve(total);
    for (const auto& list : perCell) {
        layer.cellFirst.push_back(static_cast<std::uint32_t>(layer.records.size()));
        layer.records.insert(layer.records.end(), list.begin(), list.end());
    }
    layer.cellFirst.push_back(static_cast<std::uint32_t>(layer.records.size()));
    return layer;
}

// ------------------------------------------------------------ flattening

AerialFlattening build_aerial_flattening(const Terrain& terrain,
                                         std::span<const AerialDecalSelection> selections) {
    if (terrain.width < 3 || terrain.height < 3 || terrain.width % 2 == 0 ||
        terrain.height % 2 == 0 ||
        terrain.heightBits.size() != std::size_t{terrain.width} * terrain.height)
        throw std::invalid_argument("aerial flattening: terrain must have (2W+1)x(2H+1) points");
    const auto W = (terrain.width - 1) / 2, H = (terrain.height - 1) / 2;
    AerialFlattening result;
    result.width = W;
    result.height = H;
    result.chunkFlags.assign(std::size_t{W} * H, 0);
    std::vector<float> heights(terrain.heightBits.size());
    for (std::size_t i = 0; i < heights.size(); ++i)
        heights[i] = std::bit_cast<float>(terrain.heightBits[i]);
    std::vector<std::uint8_t> touched(heights.size(), 0);
    const auto point = [&](std::uint32_t px, std::uint32_t py) {
        return std::size_t{py} * terrain.width + px;
    };
    for (const auto& s : selections) {
        if (s.x >= W || s.y >= H)
            throw std::invalid_argument("aerial flattening: selection outside the map");
        float target = std::bit_cast<float>(terrain.heightBits[point(2 * s.x + 1, 2 * s.y + 1)]);
        if (target < 20.0f)
            target = 20.0f;
        if (s.fixedHeight)
            target = 20.0f;
        const float r2 = s.range * s.range;                                   // v117 (float)
        const float reachF = s.range + 1.0f;                                  // v60 (float)
        const auto reach = static_cast<std::int64_t>(std::nearbyint(reachF)); // rint
        const double centreX = 0.5 + double(s.x), centreY = 0.5 + double(s.y);
        for (auto cy = std::int64_t{s.y} - reach; cy <= std::int64_t{s.y} + reach; ++cy) {
            if (cy < 0 || cy >= H)
                continue;
            for (auto cx = std::int64_t{s.x} - reach; cx <= std::int64_t{s.x} + reach; ++cx) {
                if (cx < 0 || cx >= W)
                    continue;
                for (std::uint32_t n = 0; n < 3; ++n)
                    for (std::uint32_t i = 0; i < 3; ++i) {
                        // Point (cx + 0.5i, cy + 0.5n) in cells; exact in float/double.
                        const double dx = double(cx) + 0.5 * i - centreX;
                        const double dy = double(cy) + 0.5 * n - centreY;
                        if (!(dx * dx + dy * dy < double(r2)))
                            continue;
                        const auto p = point(static_cast<std::uint32_t>(2 * cx + i),
                                             static_cast<std::uint32_t>(2 * cy + n));
                        if (!(heights[p] > 0.0f))
                            continue;
                        heights[p] = target;
                        touched[p] = 1;
                        result.chunkFlags[std::size_t(cx) + std::size_t{W} * std::size_t(cy)] = 1;
                    }
            }
        }
    }
    for (std::uint32_t py = 0; py < terrain.height; ++py)
        for (std::uint32_t px = 0; px < terrain.width; ++px)
            if (touched[point(px, py)])
                result.points.push_back({px, py, heights[point(px, py)]});
    return result;
}

} // namespace openrtw
