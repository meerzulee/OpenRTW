#pragma once

#include "campaign.hpp"

#include <array>
#include <charconv>
#include <cstddef>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>

// Shared exact parsed-campaign identity used by OpenRTW save1. Source-byte
// escaping, field order, bounds and errors retain the existing web contract.
namespace openrtw {
namespace detail {
inline constexpr std::size_t max_json_bytes = 32 * 1024 * 1024;
class Json {
public:
    void append(std::string_view value) {
        if (value.size() > max_json_bytes - value_.size())
            throw std::runtime_error("Campaign JSON exceeds API byte limit");
        value_.append(value);
    }

    template <class Integer> void integer(Integer value) {
        std::array<char, 32> text{};
        const auto result = std::to_chars(text.data(), text.data() + text.size(), value);
        if (result.ec != std::errc{})
            throw std::runtime_error("Cannot encode campaign integer");
        append({text.data(), static_cast<std::size_t>(result.ptr - text.data())});
    }

    void string(std::string_view bytes) {
        // Strings are owned source bytes. No source encoding was recovered:
        // encode non-ASCII bytes as U+00xx rather than emit invalid UTF-8 or
        // silently infer an encoding. This is a documented byte-safe wire view.
        constexpr char hex[] = "0123456789abcdef";
        append("\"");
        for (const char raw : bytes) {
            const auto c = static_cast<unsigned char>(raw);
            if (c == '"')
                append("\\\"");
            else if (c == '\\')
                append("\\\\");
            else if (c < 0x20 || c >= 0x7f) {
                const std::array<char, 6> escaped{'\\', 'u', '0', '0', hex[c >> 4], hex[c & 15]};
                append({escaped.data(), escaped.size()});
            } else {
                const char character = static_cast<char>(c);
                append({&character, 1});
            }
        }
        append("\"");
    }

    std::string finish() && { return std::move(value_); }

private:
    std::string value_;
};

} // namespace detail

inline std::string campaign_snapshot(const Campaign& value) {
    detail::Json out;
    std::size_t characters = 0, units = 0, sub_factions = 0, settlements = 0, buildings = 0;
    out.append("{\"id\":");
    out.string(value.id);
    out.append(",\"startYear\":");
    out.integer(value.startYear);
    out.append(",\"startSeason\":");
    out.string(value.startSeason == openrtw::Season::summer ? "summer" : "winter");
    out.append(",\"factions\":[");
    bool first_faction = true;
    for (const auto& faction : value.factions) {
        if (!first_faction)
            out.append(",");
        first_faction = false;
        out.append("{\"id\":");
        out.string(faction.id);
        // A decimal string preserves the full int64 domain through JSON.parse.
        out.append(",\"denari\":\"");
        out.integer(faction.denari);
        out.append("\"");
        out.append(",\"line\":");
        out.integer(faction.line);
        out.append(",\"characters\":[");
        bool first_character = true;
        for (const auto& character : faction.characters) {
            if (!first_character)
                out.append(",");
            first_character = false;
            ++characters;
            units += character.army.size();
            sub_factions += character.subFaction.has_value() ? 1u : 0u;
            out.append("{\"name\":");
            out.string(character.name);
            out.append(",\"type\":");
            out.string(character.type);
            out.append(",\"x\":");
            out.integer(character.x);
            out.append(",\"y\":");
            out.integer(character.y);
            out.append(",\"line\":");
            out.integer(character.line);
            out.append(",\"subFaction\":");
            if (character.subFaction)
                out.string(*character.subFaction);
            else
                out.append("null");
            out.append(",\"armyRecords\":");
            out.integer(character.army.size());
            out.append("}");
        }
        out.append("],\"settlements\":[");
        bool first_settlement = true;
        for (const auto& settlement : faction.settlements) {
            if (!first_settlement)
                out.append(",");
            first_settlement = false;
            ++settlements;
            buildings += settlement.buildings.size();
            out.append("{\"region\":");
            out.string(settlement.region);
            out.append(",\"level\":");
            out.string(settlement.level);
            out.append(",\"yearFounded\":");
            out.integer(settlement.yearFounded);
            out.append(",\"population\":");
            out.integer(settlement.population);
            out.append(",\"planSet\":");
            out.string(settlement.planSet);
            out.append(",\"factionCreator\":");
            out.string(settlement.factionCreator);
            out.append(",\"line\":");
            out.integer(settlement.line);
            out.append(",\"buildingRecords\":");
            out.integer(settlement.buildings.size());
            out.append(",\"fieldLines\":[");
            for (std::size_t i = 0; i < settlement.source.size(); ++i) {
                if (i)
                    out.append(",");
                out.integer(settlement.source[i].line);
            }
            out.append("]}");
        }
        out.append("]}");
    }
    out.append("],\"counts\":{\"factions\":");
    out.integer(value.factions.size());
    out.append(",\"characters\":");
    out.integer(characters);
    out.append(",\"unitRecords\":");
    out.integer(units);
    out.append(",\"subFactionCharacters\":");
    out.integer(sub_factions);
    out.append(",\"opaqueRecords\":");
    out.integer(value.unsupported.size());
    out.append(",\"settlements\":");
    out.integer(settlements);
    out.append(",\"buildingRecords\":");
    out.integer(buildings);
    out.append("}}");
    // Full opaque records stay owned in the core. The bootstrap wire exports
    // their count, not their unsupported semantics or repeated source context.
    return std::move(out).finish();
}

} // namespace openrtw
