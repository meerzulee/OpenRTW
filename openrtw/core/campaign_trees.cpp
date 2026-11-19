#include "campaign_trees.hpp"

#include "aerial_material_support.hpp"
#include "campaign_json.hpp"
#include "rome_random.hpp"

#include <algorithm>
#include <array>
#include <bit>
#include <charconv>
#include <cmath>
#include <limits>
#include <set>
#include <stdexcept>

namespace openrtw {
namespace {
constexpr std::size_t max_cells = 1024 * 1024;
constexpr std::size_t max_instances = 1024 * 1024;
constexpr std::string_view model_prefix = "data/terrain/aerial_map/tree_models/";
constexpr std::array<std::string_view, 3> roles{"sparse_tree", "dense_tree", "canopy"};
struct Model {
    std::string path;
    std::int32_t sprite = 0;
};
using Lists = std::array<std::vector<Model>, 6>;

std::string path(std::string_view name) {
    if (name.empty() || name.size() > 128)
        throw std::invalid_argument("Campaign trees: invalid model name");
    std::string result;
    for (const auto c : name) {
        if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
              c == '_' || c == '-' || c == '.'))
            throw std::invalid_argument("Campaign trees: model must be a filename");
        result.push_back(c >= 'A' && c <= 'Z' ? static_cast<char>(c + ('a' - 'A')) : c);
    }
    if (!result.ends_with(".cas") || result.find("..") != std::string::npos)
        throw std::invalid_argument("Campaign trees: invalid model suffix");
    return std::string(model_prefix) + result;
}

std::vector<Lists> model_lists(const ClimatePalette& palette) {
    if (palette.definitions.empty() || palette.definitions.size() > 256)
        throw std::invalid_argument("Campaign trees: invalid climate palette");
    std::vector<Lists> result(palette.definitions.size());
    for (std::size_t c = 0; c < palette.definitions.size(); ++c)
        for (const auto& row : palette.definitions[c].opaqueRows) {
            const auto& t = row.tokens;
            if (t.empty() || t[0] != "strategy")
                continue;
            if (t.size() < 4 || (t[1] != "summer" && t[1] != "winter"))
                throw std::invalid_argument("Campaign trees: malformed strategy row");
            const auto role = std::find(roles.begin(), roles.end(), t[2]);
            if (role == roles.end())
                throw std::invalid_argument("Campaign trees: unknown strategy role");
            Model model{path(t[3]), 0};
            if (t.size() == 5) {
                const auto parsed =
                    std::from_chars(t[4].data(), t[4].data() + t[4].size(), model.sprite);
                if (parsed.ec != std::errc{} || parsed.ptr != t[4].data() + t[4].size())
                    throw std::invalid_argument("Campaign trees: invalid sprite index");
            }
            auto& list = result[c][(t[1] == "winter" ? 3 : 0) + (role - roles.begin())];
            if (list.size() >= 256)
                throw std::invalid_argument("Campaign trees: too many models in one role");
            list.push_back(std::move(model));
        }
    return result;
}

std::uint32_t sample(std::uint32_t& state) {
    return rome_original::random15(state);
}
double unit(std::uint32_t& state) {
    return static_cast<double>(sample(state)) * static_cast<double>(1.0f / 32767.0f);
}
void number(detail::Json& out, float value) {
    if (!std::isfinite(value))
        throw std::runtime_error("Campaign trees: nonfinite published coordinate");
    std::array<char, 64> text{};
    const auto encoded =
        std::to_chars(text.data(), text.data() + text.size(), value, std::chars_format::general,
                      std::numeric_limits<float>::max_digits10);
    if (encoded.ec != std::errc{})
        throw std::runtime_error("Campaign trees: cannot encode coordinate");
    out.append({text.data(), static_cast<std::size_t>(encoded.ptr - text.data())});
}
} // namespace

CampaignTreeScene build_campaign_trees(const ClimatePalette& palette,
                                       const ClimateCoefficientGrid& climates,
                                       const CategoryGrid& categories, const Terrain& terrain,
                                       bool winter, const AerialFlattening* flattening,
                                       std::span<const std::uint8_t> noTrees,
                                       std::span<const std::uint16_t> tileIds) {
    const auto width = categories.width, height = categories.height;
    const auto count = static_cast<std::uint64_t>(width) * height;
    if (!width || !height || width > 4096 || height > 4096 || count > max_cells ||
        categories.categories.size() != count || climates.width != width ||
        climates.height != height || climates.sourceIndices.size() != count ||
        climates.definitionCount != palette.definitions.size() || terrain.width != 2 * width + 1 ||
        terrain.height != 2 * height + 1 ||
        terrain.heightBits.size() != static_cast<std::uint64_t>(terrain.width) * terrain.height ||
        (!noTrees.empty() && noTrees.size() != count) ||
        (!tileIds.empty() && tileIds.size() != count))
        throw std::invalid_argument("Campaign trees: inconsistent input dimensions");
    const auto lists = model_lists(palette);
    for (std::size_t i = 0; i < count; ++i)
        if (categories.categories[i] > 14 || climates.sourceIndices[i] >= lists.size() ||
            (!noTrees.empty() && noTrees[i] > 1))
            throw std::invalid_argument(
                "Campaign trees: invalid category, climate or clearing flag");
    std::vector<float> heights;
    heights.reserve(terrain.heightBits.size());
    for (const auto bits : terrain.heightBits) {
        const auto h = std::bit_cast<float>(bits);
        if (!std::isfinite(h) || std::abs(h) > 1e6f)
            throw std::invalid_argument("Campaign trees: invalid terrain height");
        heights.push_back(h);
    }
    if (flattening) {
        if (flattening->width != width || flattening->height != height ||
            (!flattening->chunkFlags.empty() && flattening->chunkFlags.size() != count))
            throw std::invalid_argument("Campaign trees: invalid flattening dimensions");
        for (const auto flag : flattening->chunkFlags)
            if (flag > 1)
                throw std::invalid_argument("Campaign trees: invalid flattening flag");
        for (const auto& p : flattening->points) {
            if (p.px >= terrain.width || p.py >= terrain.height || !std::isfinite(p.height) ||
                std::abs(p.height) > 1e6f)
                throw std::invalid_argument("Campaign trees: invalid flattened point");
            heights[static_cast<std::size_t>(p.py) * terrain.width + p.px] = p.height;
        }
        if (!tileIds.empty() && flattening->chunkFlags.empty())
            throw std::invalid_argument("Campaign trees: tile height boost needs flattening flags");
    }
    const auto role_at = [&](std::int64_t x, std::int64_t y) {
        if (x < 0 || y < 0 || x >= width || y >= height)
            return 0;
        const auto at = static_cast<std::size_t>(y) * width + static_cast<std::size_t>(x);
        if (!noTrees.empty() && noTrees[at])
            return 0;
        return categories.categories[at] == 7 ? 3 : categories.categories[at] == 8 ? 1 : 0;
    };
    const auto ground = [&](float x, float z) {
        // A rounded boundary coordinate may equal W/H. Keep its final sample
        // on the existing edge; no wrap or neighbor-outside-map read.
        const double px = std::clamp(2.0 * x, 0.0, static_cast<double>(2 * width));
        const double pz = std::clamp(2.0 * z, 0.0, static_cast<double>(2 * height));
        const auto ix = std::min(static_cast<std::uint32_t>(px), 2 * width - 1);
        const auto iz = std::min(static_cast<std::uint32_t>(pz), 2 * height - 1);
        const double fx = px - ix, fz = pz - iz;
        const auto at = [&](std::uint32_t a, std::uint32_t b) {
            return static_cast<double>(heights[static_cast<std::size_t>(b) * terrain.width + a]);
        };
        double h = ((1 - fx) * fz * at(ix, iz + 1) + fx * fz * at(ix + 1, iz + 1) +
                    (1 - fx) * (1 - fz) * at(ix, iz) + fx * (1 - fz) * at(ix + 1, iz)) *
                   static_cast<double>(0.0003f);
        const auto cellX = std::min(static_cast<std::uint32_t>(px / 2), width - 1);
        const auto cellY = std::min(static_cast<std::uint32_t>(pz / 2), height - 1);
        const auto cell = static_cast<std::size_t>(cellY) * width + cellX;
        if (!tileIds.empty() && tileIds[cell] >= 297 && tileIds[cell] <= 336 &&
            (!flattening || !flattening->chunkFlags[cell]))
            h += 0.1f;
        return static_cast<float>(std::max(h, 0.0));
    };
    CampaignTreeScene scene;
    scene.width = width;
    scene.height = height;
    scene.winter = winter;
    scene.noTreeFlagsProvided = !noTrees.empty();
    scene.tileIdsProvided = !tileIds.empty();
    std::set<std::string> inventory;
    constexpr std::array<std::string_view, 8> trunks{"EFKLIH", "EFGAHIJD", "EFKCD", "EFGA",
                                                     "ABLIH",  "HIJD",     "ABCD",  ""};
    constexpr std::array<std::array<double, 2>, 12> offsets{{{0.125, 0.125},
                                                             {0.375, 0.125},
                                                             {0.625, 0.125},
                                                             {0.875, 0.125},
                                                             {0.125, 0.875},
                                                             {0.125, 0.625},
                                                             {0.125, 0.375},
                                                             {0.875, 0.875},
                                                             {0.875, 0.625},
                                                             {0.875, 0.375},
                                                             {0.25, 0.25},
                                                             {0.75, 0.25}}};
    std::uint32_t seedState = 0x6394;
    for (std::uint32_t row = 0; row < 2 * height; ++row)
        for (std::uint32_t column = 0; column < 2 * width; ++column) {
            const auto seed = sample(seedState);
            if ((row & 1) || (column & 1))
                continue;
            const auto x = column / 2, y = row / 2;
            const auto role = role_at(x, y);
            if (!role)
                continue;
            const auto climate = climates.sourceIndices[static_cast<std::size_t>(y) * width + x];
            const auto& climateLists = lists[climate];
            const auto selected = [&](unsigned r) -> const std::vector<Model>& {
                return winter && !climateLists[r + 3].empty() ? climateLists[r + 3]
                                                              : climateLists[r];
            };
            std::uint32_t state = seed;
            const auto add = [&](unsigned r, double ox, double oz, double scatter) {
                const auto& models = selected(r);
                const float wx = static_cast<float>(unit(state) * scatter + (x + ox) - scatter / 2);
                const float wz = static_cast<float>(unit(state) * scatter + (y + oz) - scatter / 2);
                float h = ground(wx, wz);
                if (r == 2)
                    h = static_cast<float>(h + unit(state) * 0.1 - 0.05);
                const auto group = aerial_random_range_bits(state, 0, 19);
                const auto chosen = aerial_random_range_bits(
                    state, 0, static_cast<std::uint32_t>(models.size() - 1));
                if (chosen >= models.size() || group > 19 || scene.models.size() >= max_instances)
                    throw std::runtime_error("Campaign trees: instance limit or RNG domain");
                const auto& model = models[chosen];
                scene.models.push_back({model.path, std::string(roles[r]), x, y, climate, wx, h, wz,
                                        group, model.sprite});
                inventory.insert(model.path);
                if (r == 0)
                    ++scene.sparseCount;
                else if (r == 1)
                    ++scene.denseCount;
                else
                    ++scene.canopyCount;
            };
            if (role == 1) {
                if (!selected(0).empty())
                    for (unsigned i = 0; i < 3; ++i)
                        add(0, 0.5, 0.5, 1.0);
                continue;
            }
            const bool north = role_at(x, std::int64_t{y} + 1) == 3;
            const bool south = role_at(x, std::int64_t{y} - 1) == 3;
            const bool west = role_at(std::int64_t{x} - 1, y) == 3;
            const bool east = role_at(std::int64_t{x} + 1, y) == 3;
            if (!selected(1).empty())
                for (const auto letter : trunks[south + 2 * east + 4 * west]) {
                    const auto& o = offsets[static_cast<unsigned>(letter - 'A')];
                    add(1, o[0], o[1], 0.2);
                }
            if (selected(2).empty())
                continue;
            std::vector<std::array<double, 2>> points{{0.5, 0.5}};
            if (north) {
                points.push_back({0.5, 1.0});
                if (east)
                    points.push_back({1.0, 1.0});
            }
            if (east) {
                points.push_back({1.0, 0.5});
                if (south)
                    points.push_back({1.0, 0.0});
            }
            std::array<double, 2> tl{0.25, 0.75}, tr{0.75, 0.75}, bl{0.25, 0.25}, br{0.75, 0.25};
            if (!north) {
                tl[1] -= 0.125;
                tr[1] -= 0.125;
                if (!west)
                    tl[0] += 0.125;
                if (!east)
                    tr[0] -= 0.125;
            }
            if (!south) {
                bl[1] += 0.125;
                br[1] += 0.125;
                if (!west)
                    bl[0] += 0.125;
                if (!east)
                    br[0] -= 0.125;
            }
            if (!west) {
                tl[0] += 0.125;
                bl[0] += 0.125;
            }
            // Native quirk: EAST open moves the two LEFT points.
            if (!east) {
                tl[0] -= 0.125;
                bl[0] -= 0.125;
            }
            for (const auto& p : {tl, tr, bl, br})
                points.push_back(p);
            for (const auto& p : points)
                add(2, p[0], p[1], 0.1);
        }
    scene.modelPaths.assign(inventory.begin(), inventory.end());
    return scene;
}

std::string campaign_trees_json(const CampaignTreeScene& scene) {
    detail::Json out;
    out.append("{\"schema\":\"openrtw-campaign-trees-v1\",\"width\":");
    out.integer(scene.width);
    out.append(",\"height\":");
    out.integer(scene.height);
    out.append(",\"season\":");
    out.string(scene.winter ? "winter" : "summer");
    out.append(",\"noTreeFlagsProvided\":");
    out.append(scene.noTreeFlagsProvided ? "true" : "false");
    out.append(",\"tileIdsProvided\":");
    out.append(scene.tileIdsProvided ? "true" : "false");
    out.append(",\"sparseCount\":");
    out.integer(scene.sparseCount);
    out.append(",\"denseCount\":");
    out.integer(scene.denseCount);
    out.append(",\"canopyCount\":");
    out.integer(scene.canopyCount);
    out.append(",\"modelPaths\":[");
    for (std::size_t i = 0; i < scene.modelPaths.size(); ++i) {
        if (i)
            out.append(",");
        out.string(scene.modelPaths[i]);
    }
    out.append("],\"models\":[");
    bool first = true;
    for (const auto& m : scene.models) {
        if (!first)
            out.append(",");
        first = false;
        out.append("{\"path\":");
        out.string(m.path);
        out.append(",\"role\":");
        out.string(m.role);
        out.append(",\"cellX\":");
        out.integer(m.cellX);
        out.append(",\"cellY\":");
        out.integer(m.cellY);
        out.append(",\"climate\":");
        out.integer(m.climate);
        out.append(",\"x\":");
        number(out, m.x);
        out.append(",\"y\":");
        number(out, m.y);
        out.append(",\"z\":");
        number(out, m.z);
        out.append(",\"swayGroup\":");
        out.integer(m.swayGroup);
        out.append(",\"spriteIndex\":");
        out.integer(m.spriteIndex);
        out.append("}");
    }
    out.append("]}");
    return std::move(out).finish();
}
} // namespace openrtw
