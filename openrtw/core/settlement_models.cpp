#include "settlement_models.hpp"

#include "campaign_json.hpp"

#include <algorithm>
#include <bit>
#include <charconv>
#include <cmath>
#include <limits>
#include <map>
#include <set>
#include <stdexcept>

namespace openrtw {
namespace {

std::vector<std::string> words(std::string_view line) {
    line = line.substr(0, line.find(';'));
    std::vector<std::string> out;
    for (std::size_t i = 0; i < line.size();) {
        const auto c = line[i];
        if (c == ' ' || c == '\t' || c == '\r' || c == ',' || c == ':' || c == '\0') {
            ++i;
            continue;
        }
        if (c == '{' || c == '}') {
            out.emplace_back(1, c);
            ++i;
            continue;
        }
        auto end = i + 1;
        while (end < line.size() && line[end] != ' ' && line[end] != '\t' && line[end] != '\r' &&
               line[end] != ',' && line[end] != ':' && line[end] != '{' && line[end] != '}' &&
               line[end] != '\0')
            ++end;
        out.emplace_back(line.substr(i, end - i));
        i = end;
    }
    return out;
}

std::string model_path(std::string_view path) {
    std::string normalized(path);
    std::replace(normalized.begin(), normalized.end(), '\\', '/');
    if (normalized.starts_with("data/"))
        normalized.erase(0, 5);
    if (!normalized.starts_with("models_strat/") || normalized.find("//") != std::string::npos ||
        normalized.find(':') != std::string::npos)
        throw std::runtime_error("Settlement model path must be relative to data/models_strat");
    for (std::size_t pos = 0; pos < normalized.size();) {
        const auto end = normalized.find('/', pos);
        const auto part = normalized.substr(pos, end == std::string::npos ? end : end - pos);
        if (part == "." || part == "..")
            throw std::runtime_error("Settlement model path contains traversal");
        if (end == std::string::npos)
            break;
        pos = end + 1;
    }
    return "data/" + normalized;
}

std::array<float, 16> transform(float x, float y, float z, unsigned quarter = 0) {
    constexpr std::array<float, 4> c{1, 0, -1, 0}, s{0, 1, 0, -1};
    return {c[quarter], 0, -s[quarter], 0, 0, 1, 0, 0, s[quarter], 0, c[quarter], 0, x, y, z, 1};
}

struct PortFacing {
    std::uint32_t seaX = 0, seaY = 0;
    unsigned quarter = 2;
};

std::optional<PortFacing> port_facing(const CategoryGrid& categories, std::uint32_t x,
                                      std::uint32_t y) {
    if (x == 0 && y == 0)
        return std::nullopt;
    constexpr std::array<std::array<int, 2>, 4> offsets{{{0, 1}, {1, 0}, {0, -1}, {-1, 0}}};
    const auto sea = [&](int px, int py) {
        if (px < 0 || py < 0 || static_cast<std::uint32_t>(px) >= categories.width ||
            static_cast<std::uint32_t>(py) >= categories.height)
            return false;
        const auto category =
            categories.categories[static_cast<std::size_t>(py) * categories.width + px];
        return category >= 10 && category <= 12;
    };
    PortFacing result;
    unsigned best = 0, accumulated = 0;
    bool found = false;
    for (unsigned i = 0; i < offsets.size(); ++i) {
        const int px = static_cast<int>(x) + offsets[i][0];
        const int py = static_cast<int>(y) + offsets[i][1];
        if (!sea(px, py))
            continue;
        if (best == 0) {
            result.seaX = static_cast<std::uint32_t>(px);
            result.seaY = static_cast<std::uint32_t>(py);
            found = true;
        }
        for (const auto& step : offsets)
            accumulated += sea(px + step[0], py + step[1]);
        if (accumulated > best) {
            best = accumulated;
            accumulated = 0;
            result = {static_cast<std::uint32_t>(px), static_cast<std::uint32_t>(py), (2 + i) % 4};
            found = true;
        }
    }
    if (!found || (result.seaX == 0 && result.seaY == 0))
        return std::nullopt;
    return result;
}

std::optional<std::string> building_level(const Settlement& settlement, std::string_view type) {
    std::optional<std::string> result;
    for (const auto& building : settlement.buildings)
        for (const auto& line : building.source) {
            const auto tokens = words(line.text);
            if (tokens.size() < 2 || tokens[0] != "type" || tokens[1] != type)
                continue;
            if (tokens.size() != 3 || result)
                throw std::runtime_error("Ambiguous settlement building type " + std::string(type));
            result = tokens[2];
        }
    return result;
}

std::int32_t ordinal(const std::vector<std::string>& levels,
                     const std::optional<std::string>& selected) {
    if (!selected)
        return -1;
    const auto at = std::find(levels.begin(), levels.end(), *selected);
    if (at == levels.end())
        throw std::runtime_error("Settlement references undeclared building level " + *selected);
    return static_cast<std::int32_t>(at - levels.begin());
}

void float_json(detail::Json& out, float value) {
    if (!std::isfinite(value))
        throw std::runtime_error("Nonfinite settlement model matrix");
    std::array<char, 64> text{};
    const auto result =
        std::to_chars(text.data(), text.data() + text.size(), value, std::chars_format::general,
                      std::numeric_limits<float>::max_digits10);
    if (result.ec != std::errc{})
        throw std::runtime_error("Cannot encode settlement model float");
    out.append({text.data(), static_cast<std::size_t>(result.ptr - text.data())});
}

void strings_json(detail::Json& out, const std::vector<std::string>& strings) {
    out.append("[");
    for (std::size_t i = 0; i < strings.size(); ++i) {
        if (i)
            out.append(",");
        out.string(strings[i]);
    }
    out.append("]");
}

} // namespace

BuildingModelLevels load_building_model_levels(std::string_view text) {
    // POLICY limits and refusal semantics for this narrow descriptor projection.
    if (text.size() > 8 * 1024 * 1024)
        throw std::runtime_error("Building descriptor exceeds 8 MiB");
    for (const auto c : text)
        if (static_cast<unsigned char>(c) > 127)
            throw std::runtime_error("Building descriptor is not ASCII");
    BuildingModelLevels result;
    std::string current;
    std::set<std::string> seen;
    int depth = 0;
    while (!text.empty()) {
        const auto end = text.find('\n');
        const auto tokens = words(text.substr(0, end));
        text = end == std::string_view::npos ? std::string_view{} : text.substr(end + 1);
        if (depth == 0 && tokens.size() >= 2 && tokens[0] == "building") {
            current = tokens[1];
            if ((current == "defenses" || current == "port_buildings") &&
                !seen.insert(current).second)
                throw std::runtime_error("Duplicate building declaration " + current);
        }
        if (depth == 1 && !tokens.empty() && tokens[0] == "levels" &&
            (current == "defenses" || current == "port_buildings")) {
            auto& target = current == "defenses" ? result.defenses : result.ports;
            if (!target.empty() || tokens.size() < 2 || tokens.size() > 257)
                throw std::runtime_error("Invalid building level list " + current);
            std::set<std::string> unique;
            for (std::size_t i = 1; i < tokens.size(); ++i) {
                if (tokens[i] == "{" || tokens[i] == "}" || !unique.insert(tokens[i]).second)
                    throw std::runtime_error("Invalid or duplicate building level");
                target.push_back(tokens[i]);
            }
        }
        for (const auto& token : tokens) {
            if (token == "{" && ++depth > 64)
                throw std::runtime_error("Building descriptor nesting exceeds policy");
            if (token == "}" && --depth < 0)
                throw std::runtime_error("Unbalanced building descriptor");
        }
    }
    if (depth != 0 || result.defenses.empty() || result.ports.empty())
        throw std::runtime_error("Building descriptor needs defenses and port_buildings levels");
    return result;
}

SettlementModelScene
build_settlement_models(const Campaign& campaign, const RegionDefinitions& regions,
                        std::span<const FactionCulture> factions, const CultureModelTable& cultures,
                        const BuildingModelLevels& buildings, const AerialRegionMarkers& markers,
                        const Terrain& terrain, const CategoryGrid& categories,
                        const AerialFlattening* flattening, float bannerAnchorY,
                        std::span<const AerialMapObject> extraObjects) {
    if (categories.width == 0 || categories.height == 0 ||
        categories.width > max_terrain_dimension / 2 ||
        categories.height > max_terrain_dimension / 2 ||
        terrain.width != 2 * categories.width + 1 || terrain.height != 2 * categories.height + 1 ||
        terrain.heightBits.size() != static_cast<std::size_t>(terrain.width) * terrain.height ||
        categories.categories.size() !=
            static_cast<std::size_t>(categories.width) * categories.height ||
        !std::isfinite(bannerAnchorY))
        throw std::runtime_error("Invalid settlement model terrain/category dimensions or anchor");
    if (extraObjects.size() > campaign_max_settlement_blocks)
        throw std::runtime_error("Too many extra settlement objects");
    std::vector<float> heights;
    heights.reserve(terrain.heightBits.size());
    for (const auto bits : terrain.heightBits) {
        const auto value = std::bit_cast<float>(bits);
        if (!std::isfinite(value))
            throw std::runtime_error("Nonfinite settlement terrain height");
        heights.push_back(value);
    }
    if (flattening) {
        if (flattening->width != categories.width || flattening->height != categories.height)
            throw std::runtime_error("Settlement flattening dimensions differ from terrain");
        for (const auto& point : flattening->points) {
            if (point.px >= terrain.width || point.py >= terrain.height ||
                !std::isfinite(point.height))
                throw std::runtime_error("Invalid settlement flattening point");
            heights[static_cast<std::size_t>(point.py) * terrain.width + point.px] = point.height;
        }
    }
    const auto height = [&](float wx, float wz) {
        const float px = 2.0f * wx, py = 2.0f * wz;
        const auto ix = static_cast<std::uint32_t>(px), iy = static_cast<std::uint32_t>(py);
        const float fx = px - static_cast<float>(ix), fy = py - static_cast<float>(iy);
        const auto at = [&](std::uint32_t x, std::uint32_t y) {
            return heights[static_cast<std::size_t>(y) * terrain.width + x];
        };
        float h = (at(ix, iy) * (1 - fx) + at(ix + 1, iy) * fx) * (1 - fy) +
                  (at(ix, iy + 1) * (1 - fx) + at(ix + 1, iy + 1) * fx) * fy;
        if (!flattening && h > 0)
            h = std::max(h, 20.0f);
        return std::max(h, 0.0f) * 0.0003f;
    };
    const auto culture_index = [&](std::string_view faction) {
        const auto name = faction_culture(factions, faction);
        const auto index = cultures.find(name);
        if (index < 0)
            throw std::runtime_error("Unknown settlement faction/culture " + std::string(faction));
        return static_cast<std::size_t>(index);
    };
    const auto in_bounds = [&](std::uint32_t x, std::uint32_t y) {
        if (x >= categories.width || y >= categories.height)
            throw std::runtime_error("Settlement object outside terrain");
    };
    std::map<std::string_view, const RegionDefinition*> regionMap;
    for (const auto& region : regions.definitions)
        if (!regionMap.emplace(region.id, &region).second)
            throw std::runtime_error("Ambiguous settlement region");
    SettlementModelScene result;
    result.bannerAnchorY = bannerAnchorY;
    std::set<std::string> inventory, usedRegions;
    std::uint32_t nextObject = 0;
    const auto add = [&](SettlementModelInstance item, std::string_view role, std::string_view path,
                         std::size_t culture, const std::array<float, 16>& matrix) {
        if (path.empty())
            return;
        item.role = role;
        item.path = model_path(path);
        item.culture = cultures.cultures.at(culture).name;
        item.matrix = matrix;
        inventory.insert(item.path);
        result.models.push_back(std::move(item));
    };
    for (const auto& faction : campaign.factions) {
        const auto* owner = find_faction(factions, faction.id);
        if (!owner && !faction.settlements.empty())
            throw std::runtime_error("Unknown settlement owner " + faction.id);
        for (const auto& settlement : faction.settlements) {
            if (result.settlementCount >= campaign_max_settlement_blocks ||
                !usedRegions.insert(settlement.region).second)
                throw std::runtime_error("Duplicate or excessive settlements");
            const auto* marker = markers.find(settlement.region);
            const auto regionIt = regionMap.find(settlement.region);
            if (!marker || !marker->settlement || regionIt == regionMap.end())
                throw std::runtime_error("Settlement region has no unique map marker " +
                                         settlement.region);
            const auto [x, y] = *marker->settlement;
            in_bounds(x, y);
            const auto creator = !settlement.factionCreator.empty() ? settlement.factionCreator
                                 : owner->slave                     ? regionIt->second->field3
                                                                    : faction.id;
            const auto creatorCulture = culture_index(creator);
            const auto primaryCulture = creatorCulture;
            const auto level = culture_model_level_index(settlement.level);
            if (!level)
                throw std::runtime_error("Unknown settlement level " + settlement.level);
            const auto wall =
                std::min(ordinal(buildings.defenses, building_level(settlement, "defenses")), 4);
            SettlementModelInstance item;
            item.objectId = nextObject++;
            item.kind = "settlement";
            item.region = settlement.region;
            item.faction = faction.id;
            item.x = x;
            item.y = y;
            item.level = static_cast<std::int32_t>(*level);
            item.wall = wall;
            ++result.settlementCount;
            const auto wx = static_cast<float>(x) + 0.5f, wz = static_cast<float>(y) + 0.5f;
            const auto ground = height(wx, wz);
            const auto matrix = transform(wx, ground, wz);
            auto selectedCulture = primaryCulture;
            auto* selected = culture_level_models(cultures, selectedCulture, *level);
            if (!selected || !selected->normal.present()) {
                selectedCulture = creatorCulture;
                selected = culture_level_models(cultures, selectedCulture, *level);
            }
            if (!selected || !selected->normal.present())
                throw std::runtime_error("Settlement has no culture model " + settlement.region);
            add(item, "buildings", selected->normal.path, selectedCulture, matrix);
            if (wall >= 0) {
                auto wallCulture = primaryCulture;
                const auto* selectedWall = culture_wall_model(cultures, wallCulture, *level, wall);
                if (!selectedWall || !selectedWall->present()) {
                    wallCulture = creatorCulture;
                    selectedWall = culture_wall_model(cultures, wallCulture, *level, wall);
                }
                if (selectedWall && selectedWall->present())
                    add(item, "wall", selectedWall->path, wallCulture, matrix);
                else
                    result.problems.push_back(settlement.region +
                                              ": no wall model for declared defenses ordinal");
            }
            const bool garrison = std::any_of(
                faction.characters.begin(), faction.characters.end(), [&](const Character& c) {
                    return c.x == static_cast<std::int32_t>(x) &&
                           c.y == static_cast<std::int32_t>(y) && !c.army.empty();
                });
            if (garrison) {
                ++result.garrisonBannerCount;
            } else {
                const auto* bannerFaction = owner->slave ? find_faction(factions, creator) : owner;
                const auto& banner =
                    owner->slave ? bannerFaction->rebelSymbol : bannerFaction->symbol;
                if (!banner.empty()) {
                    add(item, "banner", banner, culture_index(bannerFaction->faction),
                        transform(wx, ground - 1.0f + bannerAnchorY, wz));
                    ++result.bannerCount;
                }
            }
            const auto portOrdinal =
                ordinal(buildings.ports, building_level(settlement, "port_buildings"));
            if (!marker->port) {
                if (portOrdinal >= 0)
                    result.problems.push_back(settlement.region +
                                              ": port building has no map marker");
                continue;
            }
            const auto [px, py] = *marker->port;
            if (px == 0 && py == 0)
                continue;
            in_bounds(px, py);
            const auto facing = port_facing(categories, px, py);
            if (!facing) {
                result.problems.push_back(settlement.region + ": port has no native sea neighbour");
                continue;
            }
            const auto portCulture = culture_index(owner->slave ? creator : faction.id);
            const auto portLevel = static_cast<std::uint32_t>(std::min(portOrdinal + 1, 3));
            const auto models = culture_port_models(cultures, portCulture, portLevel);
            item.objectId = nextObject++;
            item.kind = "port";
            item.x = px;
            item.y = py;
            item.level = static_cast<std::int32_t>(portLevel);
            item.wall = -1;
            ++result.portCount;
            if (portLevel == 0)
                ++result.fishingVillageCount;
            else
                ++result.developedPortCount;
            if (models.land)
                add(item, "land", models.land->path, portCulture,
                    transform(static_cast<float>(px) + 0.5f, 0, static_cast<float>(py) + 0.5f,
                              facing->quarter));
            if (models.sea)
                add(item, "sea", *models.sea, portCulture,
                    transform(static_cast<float>(facing->seaX) + 0.5f, 0,
                              static_cast<float>(facing->seaY) + 0.5f, facing->quarter));
        }
    }
    for (const auto& object : extraObjects) {
        if (object.type != AerialMapObjectType::fort &&
            object.type != AerialMapObjectType::watchtower)
            throw std::runtime_error("Extra settlement models accept only forts and watchtowers");
        in_bounds(object.x, object.y);
        if (object.culture >= cultures.cultures.size())
            throw std::runtime_error("Extra object culture outside table");
        const auto& culture = cultures.cultures[object.culture];
        const bool fort = object.type == AerialMapObjectType::fort;
        const float offset = fort ? 0.5f : 0.2f;
        const auto wx = static_cast<float>(object.x) + offset,
                   wz = static_cast<float>(object.y) + offset;
        const auto matrix = transform(wx, height(wx, wz), wz);
        SettlementModelInstance item;
        item.objectId = nextObject++;
        item.kind = fort ? "fort" : "watchtower";
        item.region = object.region;
        item.x = object.x;
        item.y = object.y;
        if (fort) {
            ++result.fortCount;
            add(item, "fort", culture.fort.path, object.culture, matrix);
            add(item, "fort_wall", culture.fortWall, object.culture, matrix);
            result.problems.push_back("fort: empty-fort banner identity not reconstructed");
        } else {
            ++result.watchtowerCount;
            add(item, "watchtower", culture.watchtower.path, object.culture, matrix);
        }
    }
    result.modelPaths.assign(inventory.begin(), inventory.end());
    return result;
}

std::string settlement_models_inventory_json(const SettlementModelScene& scene) {
    detail::Json out;
    out.append("{\"schema\":\"openrtw-settlement-model-inventory-v1\",\"models\":");
    strings_json(out, scene.modelPaths);
    out.append("}");
    return std::move(out).finish();
}

std::string settlement_models_json(const SettlementModelScene& scene) {
    detail::Json out;
    out.append("{\"schema\":\"openrtw-settlement-models-v1\",\"settlementCount\":");
    out.integer(scene.settlementCount);
    out.append(",\"portCount\":");
    out.integer(scene.portCount);
    out.append(",\"fishingVillageCount\":");
    out.integer(scene.fishingVillageCount);
    out.append(",\"developedPortCount\":");
    out.integer(scene.developedPortCount);
    out.append(",\"fortCount\":");
    out.integer(scene.fortCount);
    out.append(",\"watchtowerCount\":");
    out.integer(scene.watchtowerCount);
    out.append(",\"bannerCount\":");
    out.integer(scene.bannerCount);
    out.append(",\"garrisonBannerCount\":");
    out.integer(scene.garrisonBannerCount);
    out.append(",\"bannerAnchorY\":");
    float_json(out, scene.bannerAnchorY);
    out.append(",\"modelPaths\":");
    strings_json(out, scene.modelPaths);
    out.append(",\"problems\":");
    strings_json(out, scene.problems);
    out.append(",\"models\":[");
    bool first = true;
    for (const auto& item : scene.models) {
        if (!first)
            out.append(",");
        first = false;
        out.append("{\"objectId\":");
        out.integer(item.objectId);
        out.append(",\"kind\":");
        out.string(item.kind);
        out.append(",\"role\":");
        out.string(item.role);
        out.append(",\"region\":");
        out.string(item.region);
        out.append(",\"faction\":");
        out.string(item.faction);
        out.append(",\"culture\":");
        out.string(item.culture);
        out.append(",\"path\":");
        out.string(item.path);
        out.append(",\"x\":");
        out.integer(item.x);
        out.append(",\"y\":");
        out.integer(item.y);
        out.append(",\"cell\":[");
        out.integer(item.x);
        out.append(",");
        out.integer(item.y);
        out.append("]");
        out.append(",\"level\":");
        out.integer(item.level);
        out.append(",\"wall\":");
        out.integer(item.wall);
        out.append(",\"matrix\":[");
        for (std::size_t i = 0; i < item.matrix.size(); ++i) {
            if (i)
                out.append(",");
            float_json(out, item.matrix[i]);
        }
        out.append("]}");
    }
    out.append("]}");
    return std::move(out).finish();
}

} // namespace openrtw
