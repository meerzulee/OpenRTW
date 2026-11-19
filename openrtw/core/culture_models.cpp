#include "culture_models.hpp"

#include <charconv>
#include <stdexcept>

namespace openrtw {
namespace {


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

[[noreturn]] void refuse_line(std::size_t line, const std::string& why) {
    throw std::runtime_error("descr_cultures line " + std::to_string(line) + ": " + why);
}

} // namespace

std::optional<std::uint32_t> culture_model_level_index(std::string_view level) noexcept {
    for (std::uint32_t i = 0; i < culture_model_levels.size(); ++i)
        if (culture_model_levels[i] == level)
            return i;
    return std::nullopt;
}

std::int32_t CultureModelTable::find(std::string_view culture) const noexcept {
    for (std::size_t i = 0; i < cultures.size(); ++i)
        if (cultures[i].name == culture)
            return static_cast<std::int32_t>(i);
    return -1;
}

CultureModelTable load_culture_models(std::string_view text) {
    if (text.size() > culture_models_max_input_bytes)
        throw std::runtime_error("descr_cultures: input larger than 1 MiB");
    for (const char c : text)
        if (static_cast<unsigned char>(c) > 127)
            throw std::runtime_error("descr_cultures: non-ASCII input");

    CultureModelTable result;
    std::vector<CultureModels> parsed;
    std::vector<std::size_t> portPairs; // per culture: completed port_land/port_sea pairs
    std::vector<bool> awaitingSea;      // per culture: a port_land waits for its port_sea
    bool symbolSeen = false, siegeSeen = false, blockadeSeen = false;
    bool fortCostSeen = false, watchtowerCostSeen = false;

    const auto model_row = [&](std::string_view& line, std::size_t n) {
        CultureModelRow row;
        row.path = std::string(next_word(line));
        if (row.path.empty())
            refuse_line(n, "model row without a CAS path");
        row.decal = std::string(next_value(line));
        return row;
    };
    const auto path_row = [&](std::string_view& line, std::size_t n) {
        const auto path = next_word(line);
        if (path.empty())
            refuse_line(n, "row without a path");
        return std::string(path);
    };
    const auto int_row = [&](std::string_view& line, std::size_t n) {
        const auto token = next_word(line);
        std::int32_t value = 0;
        const auto [end, error] = std::from_chars(token.data(), token.data() + token.size(), value);
        if (token.empty() || error != std::errc{} || end != token.data() + token.size())
            refuse_line(n, "row without an integer value");
        return value;
    };
    const auto finish_culture = [&](std::size_t n) {
        if (parsed.empty())
            return;
        if (awaitingSea.back())
            refuse_line(n, "port_land without its port_sea");
        if (portPairs.back() != culture_models_port_levels)
            refuse_line(n, "a culture needs exactly 3 port_land and port_sea pairs");
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
        if (!awaitingSea.empty() && awaitingSea.back() && keyword != "port_sea")
            refuse_line(n, "port_land must be followed by port_sea");
        if (keyword == "{") {
            if (depth == 0) {
                if (parsed.empty())
                    refuse_line(n, "level list before any culture");
            } else if (depth == 1) {
                if (!pendingLevel)
                    refuse_line(n, "level block without a level name");
                currentLevel = pendingLevel;
                pendingLevel.reset();
            } else {
                refuse_line(n, "unexpected `{`");
            }
            ++depth;
            continue;
        }
        if (keyword == "}") {
            if (depth == 0)
                refuse_line(n, "unbalanced `}`");
            if (depth == 1 && pendingLevel)
                refuse_line(n, "level name without a block");
            if (depth == 2) {
                const auto& level = parsed.back().levels[*currentLevel];
                if (!level.declared)
                    refuse_line(n, "level block without a `normal` row");
                if (level.card.empty())
                    refuse_line(n, "level block without a `card` row");
                currentLevel.reset();
            }
            --depth;
            continue;
        }
        if (depth == 1) {
            const auto level = culture_model_level_index(keyword);
            if (!level || pendingLevel)
                refuse_line(n, "expected a settlement level, found " + std::string(keyword));
            if (parsed.back().levels[*level].declared)
                refuse_line(n, "duplicate settlement level " + std::string(keyword));
            pendingLevel = level;
            continue;
        }
        if (depth == 2) {
            auto& level = parsed.back().levels[*currentLevel];
            if (keyword == "normal") {
                if (level.declared)
                    refuse_line(n, "second `normal` row in one level");
                level.declared = true;
                level.normal = model_row(line, n);
            } else if (keyword == "wall") {
                if (!level.declared)
                    refuse_line(n, "`wall` row before the `normal` row");
                if (!level.card.empty())
                    refuse_line(n, "`wall` row after the `card` row");
                if (level.walls.size() >= culture_models_max_walls)
                    refuse_line(n, "more than five `wall` rows in one level");
                level.walls.push_back(model_row(line, n));
            } else if (keyword == "card") {
                if (!level.declared)
                    refuse_line(n, "`card` row before the `normal` row");
                if (!level.card.empty())
                    refuse_line(n, "second `card` row in one level");
                level.card = std::string(next_value(line));
                if (level.card.empty())
                    refuse_line(n, "`card` row without a path");
            } else {
                refuse_line(n, "unknown row in a level block: " + std::string(keyword));
            }
            continue;
        }
        // depth 0: header rows, then culture rows.
        if (keyword == "symbol" || keyword == "siege" || keyword == "blockade") {
            if (!parsed.empty())
                refuse_line(n, "header row after the first culture");
            auto& seen = keyword == "symbol"  ? symbolSeen
                         : keyword == "siege" ? siegeSeen
                                              : blockadeSeen;
            if (seen)
                refuse_line(n, "duplicate header row " + std::string(keyword));
            seen = true;
            (keyword == "symbol"  ? result.symbol
             : keyword == "siege" ? result.siege
                                  : result.blockade) = path_row(line, n);
            continue;
        }
        if (keyword == "culture") {
            if (!symbolSeen || !siegeSeen)
                refuse_line(n, "`culture` before the `symbol` and `siege` rows");
            finish_culture(n);
            const auto name = next_value(line);
            if (name.empty())
                refuse_line(n, "culture row without a name");
            for (const auto& c : parsed)
                if (c.name == name)
                    refuse_line(n, "duplicate culture " + std::string(name));
            parsed.emplace_back();
            parsed.back().name = std::string(name);
            portPairs.push_back(0);
            awaitingSea.push_back(false);
            fortCostSeen = false;
            watchtowerCostSeen = false;
            continue;
        }
        if (parsed.empty())
            refuse_line(n, "row before any culture: " + std::string(keyword));
        auto& culture = parsed.back();
        if (keyword == "portrait_mapping") {
            if (!culture.portraitMapping.empty())
                refuse_line(n, "duplicate portrait_mapping row");
            culture.portraitMapping = std::string(next_value(line));
            if (culture.portraitMapping.empty())
                refuse_line(n, "portrait_mapping row without a name");
        } else if (keyword == "rebel_standard_index") {
            if (culture.rebelStandardIndex != -1)
                refuse_line(n, "duplicate rebel_standard_index row");
            culture.rebelStandardIndex = int_row(line, n);
            if (culture.rebelStandardIndex < 0)
                refuse_line(n, "negative rebel_standard_index");
        } else if (keyword == "fort") {
            if (culture.fort.present())
                refuse_line(n, "duplicate fort row");
            culture.fort = model_row(line, n);
        } else if (keyword == "fort_cost") {
            if (fortCostSeen)
                refuse_line(n, "duplicate fort_cost row");
            culture.fortCost = int_row(line, n);
            fortCostSeen = true;
        } else if (keyword == "fort_wall") {
            if (!culture.fortWall.empty())
                refuse_line(n, "duplicate fort_wall row");
            culture.fortWall = path_row(line, n);
        } else if (keyword == "fishing_village") {
            if (culture.fishingVillage.present())
                refuse_line(n, "duplicate fishing_village row");
            culture.fishingVillage = model_row(line, n);
        } else if (keyword == "port_land") {
            if (awaitingSea.back())
                refuse_line(n, "port_land without its port_sea");
            if (portPairs.back() >= culture_models_port_levels)
                refuse_line(n, "more than three port_land rows");
            culture.portLand[portPairs.back()] = model_row(line, n);
            awaitingSea.back() = true;
        } else if (keyword == "port_sea") {
            if (!awaitingSea.back())
                refuse_line(n, "port_sea without a port_land");
            culture.portSea[portPairs.back()] = path_row(line, n);
            ++portPairs.back();
            awaitingSea.back() = false;
        } else if (keyword == "watchtower") {
            if (culture.watchtower.present())
                refuse_line(n, "duplicate watchtower row");
            culture.watchtower = model_row(line, n);
        } else if (keyword == "watchtower_cost") {
            if (watchtowerCostSeen)
                refuse_line(n, "duplicate watchtower_cost row");
            culture.watchtowerCost = int_row(line, n);
            watchtowerCostSeen = true;
        } else if (keyword == "spy" || keyword == "assassin" || keyword == "diplomat" ||
                   keyword == "admiral") {
            for (const auto& a : culture.agents)
                if (a.name == keyword)
                    refuse_line(n, "duplicate agent row " + std::string(keyword));
            CultureAgentRow agent;
            agent.name = std::string(keyword);
            agent.portrait = std::string(next_word(line));
            agent.info = std::string(next_word(line));
            agent.card = std::string(next_word(line));
            if (agent.portrait.empty() || agent.info.empty() || agent.card.empty())
                refuse_line(n, "agent row without its three image names");
            agent.cost = int_row(line, n);
            agent.first = int_row(line, n);
            agent.second = int_row(line, n);
            culture.agents.push_back(std::move(agent));
        } else {
            refuse_line(n, "unknown row: " + std::string(keyword));
        }
    }
    if (depth != 0)
        throw std::runtime_error("descr_cultures: unbalanced braces at end of input");
    if (!symbolSeen || !siegeSeen)
        throw std::runtime_error("descr_cultures: missing `symbol` or `siege` header row");
    finish_culture(lines.number());
    if (parsed.size() > culture_models_max_cultures)
        parsed.resize(culture_models_max_cultures);
    for (auto& culture : parsed)
        for (std::uint32_t level = 0; level < culture.levels.size(); ++level)
            if (culture.levels[level].declared)
                culture.levelCount = level + 1;
    result.cultures = std::move(parsed);
    return result;
}

const CultureLevelModels* culture_level_models(const CultureModelTable& table, std::size_t culture,
                                               std::uint32_t level) noexcept {
    if (culture >= table.cultures.size() || level >= culture_model_levels.size())
        return nullptr;
    const auto& entry = table.cultures[culture].levels[level];
    return entry.declared ? &entry : nullptr;
}

const CultureModelRow* culture_wall_model(const CultureModelTable& table, std::size_t culture,
                                          std::uint32_t level, std::int32_t wall) noexcept {
    if (wall < 0)
        return nullptr;
    const auto* entry = culture_level_models(table, culture, level);
    if (!entry || static_cast<std::size_t>(wall) >= entry->walls.size())
        return nullptr;
    return &entry->walls[static_cast<std::size_t>(wall)];
}

CulturePortModels culture_port_models(const CultureModelTable& table, std::size_t culture,
                                      std::uint32_t portLevel) noexcept {
    CulturePortModels models;
    if (culture >= table.cultures.size())
        return models;
    const auto& c = table.cultures[culture];
    if (portLevel == 0) {
        models.land = &c.fishingVillage;
        return models;
    }
    const auto k =
        (portLevel > culture_models_port_levels ? culture_models_port_levels : portLevel) - 1;
    models.land = &c.portLand[k];
    models.sea = &c.portSea[k];
    return models;
}

std::string strat_model_texture_path(std::string_view casPath, std::string_view materialName) {
    const auto directoryEnd = casPath.find_last_of("/\\");
    std::string path(directoryEnd == std::string_view::npos ? std::string_view{}
                                                            : casPath.substr(0, directoryEnd + 1));
    path += "textures/";
    const auto baseStart = materialName.find_last_of("/\\");
    path += materialName.substr(baseStart == std::string_view::npos ? 0 : baseStart + 1);
    path += ".dds";
    for (auto& c : path)
        if (c == '\\')
            c = '/';
    return path;
}

} // namespace openrtw
