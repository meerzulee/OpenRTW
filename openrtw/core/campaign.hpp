#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace openrtw {

enum class Season { summer, winter };

struct Unit {
    std::string name;
    std::optional<std::int32_t> count;
    std::optional<std::int32_t> experience;
    std::optional<std::int32_t> armour;
    std::optional<std::int32_t> weapon;
    std::size_t line = 0;
};

struct Character {
    std::string name;
    std::string type;
    std::optional<std::int32_t> age;
    std::int32_t x = 0;
    std::int32_t y = 0;
    std::vector<Unit> army;
    std::size_t line = 0;
    // Literal prefix present on some characters in the slave faction section.
    // This records syntax; it does not infer ownership or simulation behavior.
    std::optional<std::string> subFaction;
};

struct SettlementSourceLine {
    std::size_t line = 0;
    std::string text;
};

enum class SettlementField : std::size_t {
    level,
    region,
    yearFounded,
    population,
    planSet,
    factionCreator,
};

struct SettlementBuilding {
    std::size_t line = 0;
    // Entire opaque building block, including marker/braces, without physical
    // line terminators. No type/level effects or building mechanics inferred.
    std::vector<SettlementSourceLine> source;
};

struct Settlement {
    std::string level;
    std::string region;
    std::int32_t yearFounded = 0;
    std::int32_t population = 0;
    std::string planSet;
    std::string factionCreator;
    std::size_t line = 0;
    // Fixed order is SettlementField, not physical order in the input file.
    std::array<SettlementSourceLine, 6> source;
    std::vector<SettlementBuilding> buildings;
};

struct Faction {
    std::string id;
    std::int64_t denari = 0;
    std::vector<Character> characters;
    std::size_t line = 0;
    // Associated with this containing source section. Neither this section nor
    // literal factionCreator is promoted to a proved current-owner rule.
    std::vector<Settlement> settlements;
};

struct UnsupportedRecord {
    std::size_t line = 0;
    std::string text;
    std::string context;
};

struct Campaign {
    std::string id;
    std::int32_t startYear = 0;
    Season startSeason = Season::summer;
    std::vector<Faction> factions;
    std::vector<UnsupportedRecord> unsupported;
};

inline constexpr std::size_t campaign_max_input_bytes = 8 * 1024 * 1024;
inline constexpr std::size_t campaign_max_line_bytes = 65536;
inline constexpr std::size_t campaign_max_records = 100000;
inline constexpr std::size_t campaign_max_retained_bytes = 16 * 1024 * 1024;
inline constexpr std::size_t campaign_max_settlement_blocks = 4096;
inline constexpr std::size_t campaign_max_buildings_per_settlement = 256;
inline constexpr std::size_t campaign_max_total_settlement_buildings = 16384;
inline constexpr std::size_t campaign_max_settlement_depth = 16;

// Bounded, owned-data subset of descr_strat, with one-based source lines.
// Unsupported text is retained verbatim, excluding physical line terminators.
// Malformed supported records and structural ambiguity throw runtime_error;
// no partial Campaign escapes. Unit count remains absent when not specified.
// This is neither the original parser nor a campaign simulation.
// Settlement fields are literal, source-owning data. A block with no recognized
// settlement field keeps legacy opaque handling; once any of six fields is
// recognized, all six must appear once. Building bodies remain opaque. Every
// settlement/building line also remains in unsupported with its prior context.
// Duplicate region IDs and settlement nesting/resource limits refuse as new
// OpenRTW policy, not recovered original failure/ownership/transition semantics.
Campaign load_campaign(std::string_view input);

} // namespace openrtw
