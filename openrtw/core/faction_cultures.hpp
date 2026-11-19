#pragma once

// Faction -> culture names and banner models from data/descr_sm_factions.txt.
//

#include <cstdint>
#include <span>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace openrtw {

struct FactionCulture {
    FactionCulture() = default;
    // The symbol rows and the slave flag default so that `{faction, culture}`
    // initialisations in other units (aerial_decals_tests.cpp, api.cpp) stay valid.
    FactionCulture(std::string faction, std::string culture, std::string symbol = {},
                   std::string rebelSymbol = {}, bool slave = false)
        : faction(std::move(faction)), culture(std::move(culture)), symbol(std::move(symbol)),
          rebelSymbol(std::move(rebelSymbol)), slave(slave) {}

    std::string faction; // e.g. romans_julii
    std::string culture; // e.g. roman (a descr_cultures.txt culture name)
    // `symbol` row: the faction banner CAS (models_strat/symbol_julii.CAS); empty when
    // the row is absent (the native leaves the model slot null).
    std::string symbol;
    // `rebel_symbol` row: the banner over rebel settlements whose faction_creator is this
    // faction (symbol_slaves.CAS for julii..senate and slave, symbol_<culture>_rebel.CAS
    // otherwise in vanilla); empty when absent.
    std::string rebelSymbol;
    bool slave = false;
};

// Bounds (OpenRTW POLICY): ASCII input up to 1 MiB, at most 256 factions.
inline constexpr std::size_t faction_cultures_max_input_bytes = 1024 * 1024;
inline constexpr std::size_t faction_cultures_max_factions = 256;

// Factions in file order. Refuses (runtime_error, no partial result) a `culture`,
// `symbol` or `rebel_symbol` row before any `faction` row, a second such row for one
// faction, a faction without a culture row, a duplicate faction id and rows without a
// value. `symbol` and `rebel_symbol` are optional (vanilla has both for all 21 factions).
std::vector<FactionCulture> load_faction_cultures(std::string_view text);

// Culture of `faction`, or an empty view when absent.
std::string_view faction_culture(std::span<const FactionCulture> factions,
                                 std::string_view faction) noexcept;

// The faction row, or nullptr when absent.
const FactionCulture* find_faction(std::span<const FactionCulture> factions,
                                   std::string_view faction) noexcept;

} // namespace openrtw
