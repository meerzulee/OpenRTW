#include "campaign_fog_inputs.hpp"

#include "campaign.hpp"
#include "settlement_models.hpp"
#include "world_grid.hpp"

#include <algorithm>
#include <array>
#include <bit>
#include <charconv>
#include <limits>
#include <map>
#include <optional>
#include <set>
#include <stdexcept>

namespace openrtw {
namespace {
constexpr std::size_t maxDefinitions = 4096, maxLevels = 128;
constexpr std::string_view policy = "openrtw-source-fog-v1-qualified";

[[noreturn]] void fail(std::string message) {
    throw std::runtime_error("Campaign fog inputs: " + message);
}

std::vector<std::string_view> words(std::string_view text) {
    text = text.substr(0, text.find(';'));
    std::vector<std::string_view> result;
    for (std::size_t at = 0; at < text.size();) {
        if (text[at] == ' ' || text[at] == '\t' || text[at] == '\r' || text[at] == ',') {
            ++at;
            continue;
        }
        const auto end = text.find_first_of(" \t\r,", at);
        result.push_back(text.substr(at, end == std::string_view::npos ? end : end - at));
        if (end == std::string_view::npos)
            break;
        at = end;
    }
    return result;
}

std::int32_t integer(std::string_view text) {
    std::int32_t result = 0;
    const auto parsed = std::from_chars(text.data(), text.data() + text.size(), result);
    if (parsed.ec != std::errc{} || parsed.ptr != text.data() + text.size())
        fail("invalid integer " + std::string(text));
    return result;
}

template <class F> void source_lines(std::string_view text, F consume) {
    if (text.size() > campaign_max_input_bytes)
        fail("descriptor exceeds 8 MiB");
    for (const auto c : text)
        if (static_cast<unsigned char>(c) > 127 || (c < 32 && c != '\t' && c != '\r' && c != '\n'))
            fail("descriptor must be ASCII text");
    std::size_t line = 0;
    while (!text.empty()) {
        const auto end = text.find('\n');
        const auto raw = text.substr(0, end);
        if (++line > campaign_max_records || raw.size() > campaign_max_line_bytes)
            fail("descriptor line limit");
        const auto tokens = words(raw);
        if (!tokens.empty())
            consume(tokens);
        text = end == std::string_view::npos ? std::string_view{} : text.substr(end + 1);
    }
}

using TraitMap = std::map<std::string_view, const FogTrait*>;
TraitMap validate_traits(const FogTraits& traits) {
    if (traits.entries.size() > maxDefinitions)
        fail("too many trait definitions");
    TraitMap result;
    for (const auto& trait : traits.entries) {
        if (trait.name.empty() || !result.emplace(trait.name, &trait).second ||
            trait.levels.empty() || trait.levels.size() > maxLevels)
            fail("invalid or duplicate trait " + trait.name);
        std::set<std::string_view> names;
        for (std::size_t i = 0; i < trait.levels.size(); ++i) {
            const auto& level = trait.levels[i];
            if (level.name.empty() || !names.insert(level.name).second || level.threshold < 0 ||
                (i && trait.levels[i - 1].threshold >= level.threshold))
                fail("invalid level/threshold for " + trait.name);
        }
    }
    return result;
}

using AncillaryMap = std::map<std::string_view, std::int32_t>;
AncillaryMap validate_ancillaries(const FogAncillaries& ancillaries) {
    if (ancillaries.entries.size() > maxDefinitions)
        fail("too many ancillary definitions");
    AncillaryMap result;
    for (const auto& item : ancillaries.entries)
        if (item.name.empty() || !result.emplace(item.name, item.lineOfSight).second)
            fail("invalid or duplicate ancillary " + item.name);
    return result;
}

std::int32_t port_level(const Settlement& settlement, const BuildingModelLevels& buildings) {
    std::optional<std::string_view> selected;
    for (const auto& building : settlement.buildings)
        for (const auto& line : building.source) {
            const auto tokens = words(line.text);
            if (tokens.size() < 2 || tokens[0] != "type" || tokens[1] != "port_buildings")
                continue;
            if (tokens.size() != 3 || selected)
                fail("ambiguous port building in " + settlement.region);
            selected = tokens[2];
        }
    if (!selected)
        return 0;
    const auto at = std::find(buildings.ports.begin(), buildings.ports.end(), *selected);
    if (at == buildings.ports.end())
        fail("undeclared port building " + std::string(*selected));
    return std::min<std::int32_t>(static_cast<std::int32_t>(at - buildings.ports.begin()) + 1, 3);
}

bool admitted_port(const CategoryGrid& categories, std::uint32_t x, std::uint32_t y) {
    if (x == 0 && y == 0)
        return false;
    constexpr std::array<std::array<int, 2>, 4> offsets{{{0, 1}, {1, 0}, {0, -1}, {-1, 0}}};
    const auto sea = [&](int px, int py) {
        if (px < 0 || py < 0 || static_cast<std::uint32_t>(px) >= categories.width ||
            static_cast<std::uint32_t>(py) >= categories.height)
            return false;
        const auto category =
            categories.categories[std::size_t{static_cast<unsigned>(py)} * categories.width +
                                  static_cast<unsigned>(px)];
        return category >= 10 && category <= 12;
    };
    int selectedX = 0, selectedY = 0;
    unsigned best = 0, accumulated = 0;
    bool found = false;
    for (const auto& offset : offsets) {
        const auto px = static_cast<int>(x) + offset[0], py = static_cast<int>(y) + offset[1];
        if (!sea(px, py))
            continue;
        if (best == 0) {
            selectedX = px;
            selectedY = py;
            found = true;
        }
        for (const auto& step : offsets)
            accumulated += sea(px + step[0], py + step[1]);
        if (accumulated > best) {
            best = accumulated;
            accumulated = 0;
            selectedX = px;
            selectedY = py;
            found = true;
        }
    }
    return found && (selectedX != 0 || selectedY != 0);
}

// Two differently seeded FNV64 streams over unambiguous, length-framed LE data.
// This is a deterministic regression/source binding, not cryptographic hashing.
struct Fingerprint {
    std::uint64_t a = 14695981039346656037ull, b = 7809847782465536322ull;
    void byte(std::uint8_t value) {
        a = (a ^ value) * 1099511628211ull;
        b = (b ^ value) * 1099511628211ull;
    }
    void word(std::uint32_t value) {
        for (unsigned shift = 0; shift < 32; shift += 8)
            byte(static_cast<std::uint8_t>(value >> shift));
    }
    void text(std::string_view value) {
        word(static_cast<std::uint32_t>(value.size()));
        for (const auto c : value)
            byte(static_cast<std::uint8_t>(c));
    }
    std::string finish() const {
        constexpr char hex[] = "0123456789abcdef";
        std::string result = "fog-inputs-v1:";
        for (const auto value : {a, b})
            for (int shift = 60; shift >= 0; shift -= 4)
                result += hex[(value >> shift) & 15];
        return result;
    }
};

std::string fingerprint(const CampaignFogInputs& inputs) {
    Fingerprint hash;
    hash.text(inputs.policy);
    hash.word(static_cast<std::uint32_t>(inputs.limitations.size()));
    for (const auto& text : inputs.limitations)
        hash.text(text);
    hash.word(inputs.terrain.width);
    hash.word(inputs.terrain.height);
    for (const auto& cell : inputs.terrain.cells) {
        hash.word(std::bit_cast<std::uint32_t>(cell.height));
        hash.word(cell.category);
        hash.word(cell.flags);
    }
    hash.word(static_cast<std::uint32_t>(inputs.factionTables.size()));
    for (const auto table : inputs.factionTables)
        hash.word(table);
    hash.word(static_cast<std::uint32_t>(inputs.lineOfSight.size()));
    for (const auto effect : inputs.lineOfSight)
        hash.word(static_cast<std::uint32_t>(effect));
    hash.word(static_cast<std::uint32_t>(inputs.structures.size()));
    for (const auto& structure : inputs.structures) {
        hash.word(structure.faction);
        hash.word(static_cast<std::uint32_t>(structure.kind));
        hash.word(static_cast<std::uint32_t>(structure.x));
        hash.word(static_cast<std::uint32_t>(structure.y));
        hash.word(static_cast<std::uint32_t>(structure.level));
        hash.word(static_cast<std::uint32_t>(structure.regionCells.size()));
        for (const auto cell : structure.regionCells)
            hash.word(cell);
    }
    hash.word(static_cast<std::uint32_t>(inputs.landmarks.size()));
    for (const auto cell : inputs.landmarks)
        hash.word(cell);
    return hash.finish();
}
} // namespace

FogTraits load_campaign_fog_traits(std::string_view text) {
    FogTraits result;
    FogTrait* current = nullptr;
    FogTraitLevel* level = nullptr;
    bool thresholdSeen = false, effectSeen = false;
    const auto finishLevel = [&] {
        if (level && !thresholdSeen)
            fail("missing trait Threshold in " + current->name);
    };
    source_lines(text, [&](const auto& tokens) {
        if (tokens[0] == "Trait") {
            finishLevel();
            if (tokens.size() != 2 || result.entries.size() >= maxDefinitions)
                fail("invalid Trait declaration");
            result.entries.push_back({std::string(tokens[1]), {}});
            current = &result.entries.back();
            level = nullptr;
        } else if (tokens[0] == "Trigger") {
            finishLevel();
            level = nullptr;
            current = nullptr;
        } else if (current && tokens[0] == "Level") {
            finishLevel();
            if (tokens.size() != 2 || current->levels.size() >= maxLevels)
                fail("invalid trait Level");
            current->levels.push_back({std::string(tokens[1]), 0, 0});
            level = &current->levels.back();
            thresholdSeen = effectSeen = false;
        } else if (current && tokens[0] == "Threshold") {
            if (!level || tokens.size() != 2 || thresholdSeen)
                fail("invalid or duplicate trait Threshold");
            level->threshold = integer(tokens[1]);
            thresholdSeen = true;
        } else if (current && tokens.size() >= 2 && tokens[0] == "Effect" &&
                   tokens[1] == "LineOfSight") {
            if (!level || tokens.size() != 3 || effectSeen)
                fail("invalid or duplicate trait LineOfSight");
            level->lineOfSight = integer(tokens[2]);
            effectSeen = true;
        }
    });
    finishLevel();
    validate_traits(result);
    return result;
}

FogAncillaries load_campaign_fog_ancillaries(std::string_view text) {
    FogAncillaries result;
    FogAncillary* current = nullptr;
    bool effectSeen = false;
    source_lines(text, [&](const auto& tokens) {
        if (tokens[0] == "Ancillary") {
            if (tokens.size() != 2 || result.entries.size() >= maxDefinitions)
                fail("invalid Ancillary declaration");
            result.entries.push_back({std::string(tokens[1]), 0});
            current = &result.entries.back();
            effectSeen = false;
        } else if (tokens[0] == "Trigger") {
            current = nullptr;
        } else if (current && tokens.size() >= 2 && tokens[0] == "Effect" &&
                   tokens[1] == "LineOfSight") {
            if (tokens.size() != 3 || effectSeen)
                fail("invalid or duplicate ancillary LineOfSight");
            current->lineOfSight = integer(tokens[2]);
            effectSeen = true;
        }
    });
    validate_ancillaries(result);
    return result;
}

CampaignFogInputs build_campaign_fog_inputs(const Campaign& campaign, const Terrain& heights,
                                            const CategoryGrid& categories, const WorldGrid& world,
                                            const RegionDefinitions& regions,
                                            const BuildingModelLevels& buildings,
                                            const RgbImage& features, const FogTraits& traits,
                                            const FogAncillaries& ancillaries) {
    const auto traitMap = validate_traits(traits);
    const auto ancillaryMap = validate_ancillaries(ancillaries);
    const auto cellCount = std::uint64_t{categories.width} * categories.height;
    if (campaign.factions.empty() || campaign.factions.size() > 256 ||
        campaign.unsupported.size() > campaign_max_records || !cellCount ||
        cellCount > 16 * 1024 * 1024 || world.width != categories.width ||
        world.height != categories.height || features.width != world.width ||
        features.height != world.height || world.regionIndices.size() != cellCount ||
        categories.categories.size() != cellCount || features.rgb.size() != cellCount * 3 ||
        world.palette.size() > world_grid_max_regions ||
        world.markers.size() > world_grid_max_markers ||
        regions.definitions.size() > region_max_definitions || buildings.ports.size() > 256)
        fail("invalid source dimensions or resource bounds");
    std::vector<std::uint32_t> flags(static_cast<std::size_t>(cellCount));
    for (std::uint32_t y = 0; y < world.height; ++y)
        for (std::uint32_t x = 0; x < world.width; ++x) {
            const auto pixel = (std::size_t{world.height - 1 - y} * world.width + x) * 3;
            if (features.rgb[pixel] == 255 && features.rgb[pixel + 1] == 0 &&
                features.rgb[pixel + 2] == 0)
                flags[std::size_t{y} * world.width + x] = 0x800;
        }
    CampaignFogInputs result;
    result.terrain = build_campaign_fog_terrain(heights, categories, flags);
    result.policy = policy;
    result.limitations = {
        "Supported initial-source projection, not a captured native fog table.",
        "map_features red RGB(255,0,0) -> cell flag 0x800 is an explicit inference.",
        "Native cell flags 0x18000 (LOS +320) are unresolved and projected as zero.",
        "Initial ports use nonzero white marker plus native sea-neighbour admission; native "
        "region-adjacency byte+192 predicate is unresolved.",
        "Structure ownership follows the containing source faction; no capture or construction "
        "simulation is inferred.",
        "Only initial trait/ancillary effects are resolved; no trigger or trait evolution is "
        "simulated.",
        "Fog bytes preserve exploration, but remembered structure appearance needs separate "
        "last-seen snapshots."};

    std::map<std::string_view, std::uint32_t> factions;
    std::map<std::string, std::uint32_t> factionContexts;
    struct ActorSource {
        std::size_t id, line;
    };
    std::map<std::string, std::vector<ActorSource>> characterContexts;
    for (std::uint32_t f = 0; f < campaign.factions.size(); ++f) {
        const auto& faction = campaign.factions[f];
        if (faction.id.empty() || !factions.emplace(faction.id, f).second)
            fail("duplicate or empty faction ID");
        const auto context = "campaign/faction:" + faction.id;
        factionContexts.emplace(context, f);
        for (const auto& character : faction.characters) {
            if (result.lineOfSight.size() >= 65536)
                fail("too many fog characters");
            characterContexts[context + "/character:" + character.name].push_back(
                {result.lineOfSight.size(), character.line});
            result.lineOfSight.push_back(0);
        }
    }
    std::vector<bool> shared(campaign.factions.size()), superSeen(campaign.factions.size());
    std::vector<std::set<std::string>> seenTraits(result.lineOfSight.size()),
        seenAncillaries(result.lineOfSight.size());
    std::set<std::string> landmarkNames;
    const auto addEffect = [&](std::size_t id, std::int32_t effect) {
        const auto sum = std::int64_t{result.lineOfSight[id]} + effect;
        if (sum < std::numeric_limits<std::int32_t>::min() ||
            sum > std::numeric_limits<std::int32_t>::max())
            fail("LineOfSight effect sum overflow");
        result.lineOfSight[id] = static_cast<std::int32_t>(sum);
    };
    for (const auto& record : campaign.unsupported) {
        const auto tokens = words(record.text);
        if (tokens.empty())
            continue;
        const auto key = tokens[0];
        if (key == "superfaction") {
            const auto owner = factionContexts.find(record.context);
            const auto target = tokens.size() == 2 ? factions.find(tokens[1]) : factions.end();
            if (owner == factionContexts.end() || target == factions.end() ||
                superSeen[owner->second] || owner->second == target->second)
                fail("invalid superfaction at source line " + std::to_string(record.line));
            superSeen[owner->second] = true;
            shared[owner->second] = shared[target->second] = true;
        } else if (key == "landmark") {
            if (record.context != "campaign" || tokens.size() != 4 ||
                !landmarkNames.insert(std::string(tokens[1])).second)
                fail("invalid landmark at source line " + std::to_string(record.line));
            const auto x = integer(tokens[2]), y = integer(tokens[3]);
            if (x < 0 || y < 0 || static_cast<std::uint32_t>(x) >= world.width ||
                static_cast<std::uint32_t>(y) >= world.height)
                fail("landmark outside the map");
            result.landmarks.push_back(static_cast<std::uint32_t>(y) * world.width + x);
        } else if (key == "traits" || key == "ancillaries") {
            const auto found = characterContexts.find(record.context);
            std::optional<ActorSource> selected;
            if (found != characterContexts.end())
                for (const auto candidate : found->second) {
                    if (candidate.line >= record.line)
                        continue;
                    if (selected && candidate.line == selected->line)
                        fail("ambiguous character source context");
                    if (!selected || candidate.line > selected->line)
                        selected = candidate;
                }
            if (!selected || tokens.size() < 2)
                fail("unresolved character effects at source line " + std::to_string(record.line));
            const auto id = selected->id;
            if (key == "traits") {
                if (tokens.size() % 2 != 1)
                    fail("trait level missing at source line " + std::to_string(record.line));
                for (std::size_t i = 1; i < tokens.size(); i += 2) {
                    const auto trait = traitMap.find(tokens[i]);
                    if (trait == traitMap.end() ||
                        !seenTraits[id].insert(std::string(tokens[i])).second)
                        fail("unknown or duplicate character trait " + std::string(tokens[i]));
                    const auto sourceLevel = integer(tokens[i + 1]);
                    if (sourceLevel < 0)
                        fail("negative trait levels are outside supported projection");
                    // 446CF3 passes the declared LEVEL to 58F70E. That setter
                    // caps it at the trait's level count, then passes the
                    // selected level's Threshold to the point-adder 58F9D7.
                    // Level zero is the empty native level. Do not compare the
                    // source ordinal with point thresholds or sum earlier levels.
                    std::int32_t effect = 0;
                    if (sourceLevel != 0) {
                        const auto ordinal = std::min<std::size_t>(
                            static_cast<std::size_t>(sourceLevel), trait->second->levels.size());
                        const auto& level = trait->second->levels[ordinal - 1];
                        // 58F9D7 does nothing when its point argument is zero.
                        if (level.threshold != 0)
                            effect = level.lineOfSight;
                    }
                    addEffect(id, effect);
                }
            } else {
                for (std::size_t i = 1; i < tokens.size(); ++i) {
                    const auto ancillary = ancillaryMap.find(tokens[i]);
                    if (ancillary == ancillaryMap.end() ||
                        !seenAncillaries[id].insert(std::string(tokens[i])).second)
                        fail("unknown or duplicate character ancillary " + std::string(tokens[i]));
                    addEffect(id, ancillary->second);
                }
            }
        }
    }
    std::optional<std::uint32_t> sharedTable;
    std::uint32_t tableCount = 0;
    for (const bool isShared : shared) {
        if (isShared && sharedTable) {
            result.factionTables.push_back(*sharedTable);
        } else {
            if (isShared)
                sharedTable = tableCount;
            result.factionTables.push_back(tableCount++);
        }
    }

    std::map<Rgb, std::uint32_t> colors;
    for (std::uint32_t i = 0; i < world.palette.size(); ++i)
        if (!colors.emplace(world.palette[i], i).second)
            fail("duplicate world palette color");
    std::vector<std::vector<std::uint32_t>> regionCells(world.palette.size());
    for (std::uint32_t i = 0; i < world.regionIndices.size(); ++i) {
        const auto region = world.regionIndices[i];
        if (region >= regionCells.size())
            fail("world region index out of range");
        regionCells[region].push_back(i);
    }
    std::map<std::string_view, Rgb> regionColors;
    std::set<Rgb> definedColors;
    for (const auto& region : regions.definitions)
        if (!regionColors.emplace(region.id, region.rgb).second ||
            !definedColors.insert(region.rgb).second)
            fail("duplicate region definition");
    for (const auto& marker : world.markers)
        if (marker.worldX >= world.width || marker.worldY >= world.height ||
            marker.regionIndex >= world.palette.size() ||
            marker.selectedRgb != world.palette[marker.regionIndex])
            fail("inconsistent world marker");
    const auto markers = build_aerial_region_markers(regions, world);
    std::set<std::string_view> settledRegions;
    for (std::uint32_t f = 0; f < campaign.factions.size(); ++f)
        for (const auto& settlement : campaign.factions[f].settlements) {
            if (settledRegions.size() >= campaign_max_settlement_blocks ||
                !settledRegions.insert(settlement.region).second)
                fail("duplicate or excessive settlement regions");
            const auto* marker = markers.find(settlement.region);
            const auto definition = regionColors.find(settlement.region);
            const auto level = aerial_settlement_level_index(settlement.level);
            if (!marker || !marker->settlement || marker->blackMarkers != 1 ||
                marker->whiteMarkers > 1 || definition == regionColors.end() || !level)
                fail("unresolved/ambiguous settlement marker or level " + settlement.region);
            const auto color = colors.find(definition->second);
            if (color == colors.end())
                fail("settlement region absent from world grid");
            const auto [x, y] = *marker->settlement;
            result.structures.push_back({f, CampaignFogStructureKind::settlement,
                                         static_cast<std::int32_t>(x), static_cast<std::int32_t>(y),
                                         static_cast<std::int32_t>(*level),
                                         regionCells[color->second]});
            const auto portLevel = port_level(settlement, buildings);
            if (marker->port && admitted_port(categories, (*marker->port)[0], (*marker->port)[1])) {
                const auto [px, py] = *marker->port;
                result.structures.push_back({f,
                                             CampaignFogStructureKind::port,
                                             static_cast<std::int32_t>(px),
                                             static_cast<std::int32_t>(py),
                                             portLevel,
                                             {}});
            } else if (portLevel > 0) {
                fail("developed port has no admitted coastal marker " + settlement.region);
            }
        }
    result.identity = fingerprint(result);
    return result;
}
} // namespace openrtw
