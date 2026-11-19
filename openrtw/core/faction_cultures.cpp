#include "faction_cultures.hpp"

#include <stdexcept>

namespace openrtw {
namespace {

bool separator(char c) {
    return c == ' ' || c == '\t' || c == '\0' || c == '\r' || c == ',' || c == ':';
}

std::string_view next_token(std::string_view& line) {
    std::size_t begin = 0;
    while (begin < line.size() && separator(line[begin]))
        ++begin;
    auto end = begin;
    while (end < line.size() && !separator(line[end]))
        ++end;
    const auto token = line.substr(begin, end - begin);
    line.remove_prefix(end);
    return token;
}

[[noreturn]] void refuse(std::size_t line, const char* why) {
    throw std::runtime_error("descr_sm_factions line " + std::to_string(line) + ": " + why);
}

} // namespace

std::vector<FactionCulture> load_faction_cultures(std::string_view text) {
    if (text.size() > faction_cultures_max_input_bytes)
        throw std::runtime_error("descr_sm_factions: input too large");
    for (const char c : text)
        if (static_cast<unsigned char>(c) > 127)
            throw std::runtime_error("descr_sm_factions: non-ASCII input");
    std::vector<FactionCulture> factions;
    bool cultureSeen = true;
    std::size_t lineNumber = 0, factionLine = 0;
    // `<row> <value>` for one of the optional single rows of the current faction.
    const auto single_row = [&](std::string_view& line, std::string FactionCulture::* slot,
                                const char* what) {
        if (factions.empty())
            refuse(lineNumber, what);
        auto& stored = factions.back().*slot;
        if (!stored.empty())
            refuse(lineNumber, "second row of one kind for one faction");
        const auto value = next_token(line);
        if (value.empty())
            refuse(lineNumber, "row without a value");
        stored = std::string(value);
    };
    while (!text.empty()) {
        ++lineNumber;
        const auto newline = text.find('\n');
        auto line = text.substr(0, newline);
        text.remove_prefix(newline == std::string_view::npos ? text.size() : newline + 1);
        if (const auto comment = line.find(';'); comment != std::string_view::npos)
            line = line.substr(0, comment);
        const auto keyword = next_token(line);
        if (keyword == "faction") {
            if (!cultureSeen)
                refuse(factionLine, "faction without a culture row");
            const auto id = next_token(line);
            if (id.empty())
                refuse(lineNumber, "faction row without an id");
            for (const auto& f : factions)
                if (f.faction == id)
                    refuse(lineNumber, "duplicate faction id");
            if (factions.size() >= faction_cultures_max_factions)
                refuse(lineNumber, "too many factions");
            factions.push_back({std::string(id), {}, {}, {}, id == "slave"});
            cultureSeen = false;
            factionLine = lineNumber;
        } else if (keyword == "culture") {
            if (factions.empty())
                refuse(lineNumber, "culture row before any faction");
            if (cultureSeen)
                refuse(lineNumber, "second culture row for one faction");
            const auto culture = next_token(line);
            if (culture.empty())
                refuse(lineNumber, "culture row without a name");
            factions.back().culture = std::string(culture);
            cultureSeen = true;
        } else if (keyword == "symbol") {
            single_row(line, &FactionCulture::symbol, "symbol row before any faction");
        } else if (keyword == "rebel_symbol") {
            single_row(line, &FactionCulture::rebelSymbol, "rebel_symbol row before any faction");
        }
    }
    if (!cultureSeen)
        refuse(factionLine, "faction without a culture row");
    return factions;
}

std::string_view faction_culture(std::span<const FactionCulture> factions,
                                 std::string_view faction) noexcept {
    const auto* f = find_faction(factions, faction);
    return f ? std::string_view(f->culture) : std::string_view{};
}

const FactionCulture* find_faction(std::span<const FactionCulture> factions,
                                   std::string_view faction) noexcept {
    for (const auto& f : factions)
        if (f.faction == faction)
            return &f;
    return nullptr;
}

} // namespace openrtw
