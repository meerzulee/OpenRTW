#pragma once

// Campaign-map model table of data/descr_cultures.txt: per culture the settlement
// buildings and wall models of each level, the fishing village, the port land/sea pairs,
// the fort and its wall, the watchtower, plus the header symbol/siege/blockade models.
//

#include <array>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace openrtw {

inline constexpr std::array<std::string_view, 6> culture_model_levels{
    "village", "town", "large_town", "city", "large_city", "huge_city"};
std::optional<std::uint32_t> culture_model_level_index(std::string_view level) noexcept;

inline constexpr std::size_t culture_models_max_input_bytes = 1024 * 1024;
inline constexpr std::size_t culture_models_max_cultures = 7;
inline constexpr std::size_t culture_models_max_walls = 5;
inline constexpr std::size_t culture_models_port_levels = 3;

struct CultureModelRow {
    std::string path;
    std::string decal;
    bool present() const noexcept { return !path.empty(); }
};

// Level block L (record+364+108L). The native leaves the model slots null when the level
// is not declared (barbarian has no large_city/huge_city).
struct CultureLevelModels {
    bool declared = false;
    CultureModelRow normal;             // +0 model, +4 path, +104 base: `normal` row
    std::vector<CultureModelRow> walls; // +16+16w: `wall` rows in order = wall_1..wall_5
    std::string card;
};

struct CultureAgentRow {
    std::string name, portrait, info, card;
    std::int32_t cost = 0, first = 0, second = 0;
};

struct CultureModels {
    std::string name;                         // +4: `culture` row
    std::string portraitMapping;              // `portrait_mapping` row (optional)
    std::int32_t rebelStandardIndex = -1;     // +360: `rebel_standard_index` row, -1 absent
    std::array<CultureLevelModels, 6> levels; // +364+108L
    std::uint32_t levelCount = 0;             // +1172: highest declared level + 1
    CultureModelRow fort;                     // +12 model, +20 path, +44 base
    std::string fortWall;                     // +28 path (+16 model), no decal
    std::int32_t fortCost = 0;                // +340
    CultureModelRow fishingVillage;           // +48 model, +56 path, +80 base (port level 0)
    std::array<CultureModelRow, 3> portLand;  // +84+36k, +92+36k, +116+36k (port level k+1)
    std::array<std::string, 3> portSea;       // +200+36k path (+192+36k model), no decal
    CultureModelRow watchtower;               // +300 model, +308 path, +332 base
    std::int32_t watchtowerCost = 0;          // +344
    std::vector<CultureAgentRow> agents;      // +1012
};

struct CultureModelTable {
    std::string symbol;
    std::string siege;
    std::string blockade;
    std::vector<CultureModels> cultures;
    std::int32_t find(std::string_view culture) const noexcept;
};

CultureModelTable load_culture_models(std::string_view text);

const CultureLevelModels* culture_level_models(const CultureModelTable& table, std::size_t culture,
                                               std::uint32_t level) noexcept;
const CultureModelRow* culture_wall_model(const CultureModelTable& table, std::size_t culture,
                                          std::uint32_t level, std::int32_t wall) noexcept;

struct CulturePortModels {
    const CultureModelRow* land = nullptr;
    const std::string* sea = nullptr;
};
CulturePortModels culture_port_models(const CultureModelTable& table, std::size_t culture,
                                      std::uint32_t portLevel) noexcept;

std::string strat_model_texture_path(std::string_view casPath, std::string_view materialName);

} // namespace openrtw
