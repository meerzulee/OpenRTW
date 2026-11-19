#include "campaign_production.hpp"
#include <algorithm>
#include <bit>
#include <charconv>
#include <limits>
#include <stdexcept>
#include <sstream>

namespace openrtw {
namespace {
[[noreturn]] void refuse(std::string message) {
    throw std::runtime_error("Production: " + message);
}
std::uint32_t number(std::string_view s) {
    std::uint32_t n = 0;
    auto [p, e] = std::from_chars(s.data(), s.data() + s.size(), n);
    if (e != std::errc{} || p != s.data() + s.size() || n > 100000000)
        refuse("invalid amount");
    return n;
}
std::vector<ProductionToken> lex(std::string_view text) {
    if (text.size() > 2 * 1024 * 1024)
        refuse("descriptor exceeds 2 MiB");
    std::vector<ProductionToken> out;
    std::vector<std::size_t> stack;
    std::size_t line = 1;
    for (std::size_t i = 0; i < text.size();) {
        unsigned char c = text[i];
        if (c == '\n') {
            ++line;
            ++i;
            continue;
        }
        if (c == ' ' || c == '\t' || c == '\r') {
            ++i;
            continue;
        }
        if (c == ';') {
            while (i < text.size() && text[i] != '\n')
                ++i;
            continue;
        }
        if (c < 32 || c == 127)
            refuse("invalid descriptor character");
        std::string word;
        if (c == '"') {
            ++i;
            while (i < text.size() && text[i] != '"') {
                if (text[i] == '\n' || text[i] == '\\')
                    refuse("unsupported quoted escape");
                word += text[i++];
            }
            if (i == text.size())
                refuse("unterminated quote");
            ++i;
        } else if (c == '{' || c == '}' || c == ',') {
            word += text[i++];
        } else {
            while (i < text.size() &&
                   std::string_view(" \t\r\n{},;\"").find(text[i]) == std::string_view::npos)
                word += text[i++];
        }
        if (word.size() > 4096 || out.size() >= 100000)
            refuse("token bound exceeded");
        ProductionToken token{word, line, 0, static_cast<int>(stack.size())};
        if (word == "}") {
            if (stack.empty())
                refuse("unbalanced braces");
            --token.depth;
            out[stack.back()].close = out.size();
            stack.pop_back();
        }
        out.push_back(std::move(token));
        if (word == "{") {
            if (stack.size() >= 16)
                refuse("brace depth exceeded");
            stack.push_back(out.size() - 1);
        }
    }
    if (!stack.empty())
        refuse("unclosed braces");
    return out;
}
std::vector<std::string> words(const std::vector<ProductionToken>& t, std::size_t a,
                               std::size_t b) {
    std::vector<std::string> out;
    for (; a < b; ++a)
        out.push_back(t[a].text);
    return out;
}
int city_rank(std::string_view level) {
    constexpr std::string_view levels[] = {"village", "town",       "large_town",
                                           "city",    "large_city", "huge_city"};
    for (int i = 0; i < 6; ++i)
        if (level == levels[i])
            return i;
    return -1;
}
constexpr std::uint32_t population_threshold[] = {0, 400, 2000, 6000, 12000, 24000};
std::vector<std::string> csv(std::string value) {
    std::replace(value.begin(), value.end(), ',', ' ');
    std::istringstream in(value);
    std::vector<std::string> out;
    std::string s;
    while (in >> s)
        out.push_back(s);
    return out;
}
struct Writer {
    std::vector<std::uint8_t> bytes;
    void u(std::uint64_t n) {
        for (int i = 0; i < 8; ++i)
            bytes.push_back(static_cast<std::uint8_t>(n >> (i * 8)));
        if (bytes.size() > 1024 * 1024)
            refuse("save exceeds 1 MiB");
    }
    void s(std::string_view s) {
        u(s.size());
        bytes.insert(bytes.end(), s.begin(), s.end());
        if (bytes.size() > 1024 * 1024)
            refuse("save exceeds 1 MiB");
    }
};
struct Reader {
    std::span<const std::uint8_t> bytes;
    std::size_t at = 0;
    std::uint64_t u() {
        if (bytes.size() - at < 8)
            refuse("truncated production save");
        std::uint64_t n = 0;
        for (int i = 0; i < 8; ++i)
            n |= std::uint64_t{bytes[at++]} << (8 * i);
        return n;
    }
    std::size_t count(std::size_t max) {
        auto n = u();
        if (n > max)
            refuse("production save bound");
        return static_cast<std::size_t>(n);
    }
    std::string s() {
        auto n = count(1024 * 1024);
        if (n > bytes.size() - at)
            refuse("truncated saved string");
        std::string s(reinterpret_cast<const char*>(bytes.data() + at), n);
        at += n;
        return s;
    }
};
} // namespace
const ProductionBuilding* ProductionCatalog::building(std::string_view chain,
                                                      std::string_view level) const {
    for (auto& b : buildings)
        if (b.chain == chain && b.level == level)
            return &b;
    return nullptr;
}
const ProductionUnit* ProductionCatalog::unit(std::string_view name) const {
    for (auto& u : units)
        if (u.name == name)
            return &u;
    return nullptr;
}
std::shared_ptr<ProductionCatalog> load_production_catalog(std::string_view input,
                                                           const UnitDefinitions& definitions) {
    auto result = std::make_shared<ProductionCatalog>();
    result->identity = std::string(input) + "\nUNIT-SOURCE\n" + definitions.sourceBytes;
    auto t = lex(input);
    for (std::size_t i = 0; i < t.size(); ++i) {
        if (t[i].depth != 0 || t[i].text != "building")
            continue;
        if (i + 2 >= t.size() || t[i + 2].text != "{")
            refuse("invalid building header");
        auto chain = t[i + 1].text;
        auto end = t[i + 2].close;
        std::size_t at = i + 3;
        if (at >= end || t[at].text != "levels")
            refuse("missing levels");
        ++at;
        std::vector<std::string> levels;
        while (at < end && t[at].text != "{")
            levels.push_back(t[at++].text);
        if (levels.empty() || at >= end)
            refuse("empty levels");
        auto levelsEnd = t[at].close;
        ++at;
        std::set<std::string> seen;
        while (at < levelsEnd) {
            ProductionBuilding b;
            b.chain = chain;
            b.level = t[at++].text;
            if (std::find(levels.begin(), levels.end(), b.level) == levels.end() ||
                !seen.insert(b.level).second)
                refuse("invalid/duplicate level");
            auto reqStart = at;
            if (at < levelsEnd && t[at].text == "requires")
                ++reqStart;
            while (at < levelsEnd) {
                if (t[at].text == "{" && at > 0 && t[at - 1].text == "factions") {
                    at = t[at].close + 1;
                    continue;
                }
                if (t[at].text == "{")
                    break;
                ++at;
            }
            if (at >= levelsEnd)
                refuse("missing level body");
            if (reqStart < at)
                b.requirements = words(t, reqStart, at);
            auto bodyEnd = t[at].close;
            int depth = t[at].depth + 1;
            ++at;
            bool cost = false, time = false;
            for (; at < bodyEnd; ++at) {
                auto key = t[at].text;
                if (t[at].depth != depth)
                    continue;
                if (key == "cost" || key == "construction" || key == "settlement_min") {
                    if (at + 1 >= bodyEnd)
                        refuse("missing level property");
                    auto value = t[++at].text;
                    if (key == "cost") {
                        if (cost)
                            refuse("duplicate cost");
                        b.cost = number(value);
                        cost = true;
                    } else if (key == "construction") {
                        if (time)
                            refuse("duplicate duration");
                        b.turns = number(value);
                        time = true;
                    } else {
                        if (!b.settlementMin.empty())
                            refuse("duplicate settlement_min");
                        b.settlementMin = value;
                    }
                } else if (key == "upgrades" || key == "capability") {
                    if (at + 1 >= bodyEnd || t[at + 1].text != "{")
                        refuse("invalid level block");
                    auto block = t[++at];
                    for (std::size_t row = at + 1; row < block.close;) {
                        auto finish = row + 1;
                        while (finish < block.close &&
                               (t[finish].line == t[row].line || t[finish].depth > depth + 1 ||
                                t[finish].text == "}"))
                            ++finish;
                        if (key == "upgrades") {
                            for (auto j = row; j < finish; ++j)
                                if (t[j].text != ",")
                                    b.upgrades.push_back(t[j].text);
                        } else if (t[row].text == "recruit") {
                            if (row + 3 > finish)
                                refuse("invalid recruit capability");
                            ProductionRecruit recruit{
                                t[row + 1].text, static_cast<int>(number(t[row + 2].text)), {}};
                            if (recruit.experience > 100)
                                refuse("recruit experience bound exceeded");
                            auto start = row + 3;
                            if (start < finish) {
                                if (t[start++].text != "requires")
                                    refuse("invalid recruit condition");
                                recruit.requirements = words(t, start, finish);
                            }
                            b.recruits.push_back(std::move(recruit));
                        } else {
                            std::string effect;
                            for (auto j = row; j < finish; ++j) {
                                if (!effect.empty())
                                    effect += ' ';
                                effect += t[j].text;
                            }
                            b.effects.push_back(std::move(effect));
                        }
                        row = finish;
                    }
                    at = block.close;
                } else if (key == "{")
                    at = t[at].close;
            }
            if (!cost || !time || !b.turns || b.turns > 1000 || city_rank(b.settlementMin) < 0)
                refuse("incomplete building cost/time/city level");
            if (result->building(b.chain, b.level) || result->buildings.size() >= 2048)
                refuse("duplicate building or catalog bound");
            result->buildings.push_back(std::move(b));
            at = bodyEnd + 1;
        }
        if (seen.size() != levels.size())
            refuse("incomplete chain");
        i = end;
    }
    if (result->buildings.empty())
        refuse("no building tree");
    for (auto& b : result->buildings)
        for (auto& upgrade : b.upgrades)
            if (!result->building(b.chain, upgrade))
                refuse("dangling upgrade " + upgrade);
    // Linear graph visitation: shared upgrade descendants are checked once.
    std::map<std::string, int> colors;
    auto visit = [&](auto&& self, const ProductionBuilding& node, std::size_t depth) -> void {
        if (depth > 64)
            refuse("building upgrade depth exceeded");
        auto& color = colors[node.chain + ":" + node.level];
        if (color == 1)
            refuse("cyclic building upgrades");
        if (color == 2)
            return;
        color = 1;
        for (const auto& level : node.upgrades)
            self(self, *result->building(node.chain, level), depth + 1);
        color = 2;
    };
    for (const auto& node : result->buildings)
        visit(visit, node, 0);
    for (auto& definition : definitions.records) {
        ProductionUnit u;
        u.name = definition.type;
        u.category = definition.category;
        u.soldiers = definition.sourceSoldierCount;
        bool cost = false;
        for (auto& f : definition.fields) {
            if (f.key == "stat_cost") {
                if (cost)
                    refuse("duplicate unit cost");
                auto values = csv(f.value);
                if (values.size() < 3)
                    refuse("invalid stat_cost");
                u.turns = number(values[0]);
                u.cost = number(values[1]);
                cost = true;
            }
            if (f.key == "ownership")
                u.ownership = csv(f.value);
        }
        if (cost && u.turns && u.turns <= 1000 && u.soldiers && u.soldiers <= 10000) {
            if (result->unit(u.name))
                refuse("duplicate unit " + u.name);
            result->units.push_back(std::move(u));
        }
    }
    return result;
}
CampaignProduction CampaignProduction::create(const Campaign& source,
                                              std::shared_ptr<const ProductionCatalog> catalog) {
    CampaignProduction state;
    state.catalog = std::move(catalog);
    if (!state.catalog)
        refuse("catalog required");
    for (std::size_t fi = 0; fi < source.factions.size(); ++fi) {
        auto& f = source.factions[fi];
        state.factions.push_back(f.id);
        state.treasury.push_back(f.denari);
        state.additions.resize(state.additions.size() + f.characters.size());
        for (auto& s : f.settlements) {
            if (s.population < 0 || city_rank(s.level) < 0)
                refuse("invalid initial city");
            ProductionCity c;
            c.faction = fi;
            c.population = s.population;
            c.region = s.region;
            c.level = s.level;
            for (auto& b : s.buildings)
                for (auto& line : b.source) {
                    std::istringstream in(line.text);
                    std::string type, chain, level;
                    in >> type;
                    if (type == "type") {
                        if (!(in >> chain >> level) || !state.catalog->building(chain, level) ||
                            !c.buildings.emplace(chain, level).second)
                            refuse("unresolved initial building " + chain + ":" + level);
                    }
                }
            state.cities.push_back(std::move(c));
        }
    }
    return state;
}
std::string CampaignProduction::requirement_reason(const ProductionCity& city,
                                                   const std::vector<std::string>& t) const {
    if (t.empty())
        return {};
    std::size_t at = 0;
    bool unknown = false;
    auto atom = [&]() {
        bool inverse = false;
        if (at < t.size() && t[at] == "not") {
            inverse = true;
            ++at;
        }
        if (at >= t.size()) {
            unknown = true;
            return false;
        }
        auto key = t[at++];
        bool value = false;
        if (key == "factions") {
            if (at >= t.size() || t[at++] != "{") {
                unknown = true;
                return false;
            }
            auto faction = factions.at(city.faction);
            auto culture = catalog->cultures.find(faction);
            while (at < t.size() && t[at] != "}") {
                auto name = t[at++];
                if (name == faction ||
                    (culture != catalog->cultures.end() && name == culture->second))
                    value = true;
            }
            if (at >= t.size()) {
                unknown = true;
                return false;
            }
            ++at;
        } else if (key == "resource" || key == "hidden_resource") {
            if (at >= t.size()) {
                unknown = true;
                return false;
            }
            auto name = t[at++];
            auto resources = catalog->resources.find(city.region);
            value = resources != catalog->resources.end() &&
                    std::find(resources->second.begin(), resources->second.end(), name) !=
                        resources->second.end();
            if (key == "hidden_resource" || resources == catalog->resources.end())
                unknown = true;
        } else if (key == "building_present_min_level") {
            if (at + 2 > t.size()) {
                unknown = true;
                return false;
            }
            auto chain = t[at++], level = t[at++];
            auto current = city.buildings.find(chain);
            if (!catalog->building(chain, level))
                unknown = true;
            // Upgrade reachability, not lexical order or source declaration index.
            if (current != city.buildings.end()) {
                std::set<std::string> seen;
                std::vector<std::string> todo{level};
                while (!todo.empty()) {
                    auto next = todo.back();
                    todo.pop_back();
                    if (!seen.insert(next).second)
                        continue;
                    if (current->second == next)
                        value = true;
                    if (auto b = catalog->building(chain, next))
                        todo.insert(todo.end(), b->upgrades.begin(), b->upgrades.end());
                }
            }
        } else if (key == "marian_reforms")
            value = marianReforms;
        else
            unknown = true;
        return inverse ? !value : value;
    };
    bool term = atom(), result = false;
    while (at < t.size()) {
        auto op = t[at++];
        bool value = atom();
        if (op == "and")
            term = term && value;
        else if (op == "or") {
            result = result || term;
            term = value;
        } else
            unknown = true;
    }
    if (unknown)
        return "Unsupported prerequisite expression";
    return (result || term) ? "" : "Prerequisites not met";
}
std::string CampaignProduction::building_reason(std::size_t id, std::size_t definition,
                                                bool projected) const {
    if (id >= cities.size() || definition >= catalog->buildings.size())
        return "Unknown settlement or building";
    auto c = cities[id];
    auto& b = catalog->buildings[definition];
    if (projected)
        for (auto& job : c.construction) {
            auto& prior = catalog->buildings.at(job.definition);
            c.buildings[prior.chain] = prior.level;
            if (prior.chain == "core_building")
                c.level = prior.settlementMin;
        }
    auto existing = c.buildings.find(b.chain);
    if (existing != c.buildings.end()) {
        if (existing->second == b.level)
            return "Already built or queued";
        auto prior = catalog->building(b.chain, existing->second);
        if (!prior || std::find(prior->upgrades.begin(), prior->upgrades.end(), b.level) ==
                          prior->upgrades.end())
            return "Previous building level required";
    } else {
        for (auto& prior : catalog->buildings)
            if (prior.chain == b.chain && std::find(prior.upgrades.begin(), prior.upgrades.end(),
                                                    b.level) != prior.upgrades.end())
                return "Previous building level required";
    }
    const int minimum = city_rank(b.settlementMin), current = city_rank(c.level);
    if (b.chain == "core_building") {
        if (c.population < population_threshold[minimum])
            return "Population too low for city upgrade";
    } else if (current < minimum)
        return "Settlement level too low";
    if (auto reason = requirement_reason(c, b.requirements); !reason.empty())
        return reason;
    // Temple chains are mutually exclusive under the explicit playable policy.
    if (b.chain.starts_with("temple_"))
        for (auto& [chain, level] : c.buildings)
            if (chain.starts_with("temple_") && chain != b.chain)
                return "Another temple chain is present";
    return {};
}
std::string CampaignProduction::recruit_reason(std::size_t id, std::size_t definition) const {
    if (id >= cities.size() || definition >= catalog->units.size())
        return "Unknown settlement or unit";
    auto& c = cities[id];
    auto& u = catalog->units[definition];
    if (u.category == "ship")
        return "Fleet recruitment is not available";
    const auto& faction = factions.at(c.faction);
    const auto culture = catalog->cultures.find(faction);
    const bool ownedByFaction =
        std::find(u.ownership.begin(), u.ownership.end(), faction) != u.ownership.end();
    const bool ownedByCulture =
        culture != catalog->cultures.end() &&
        std::find(u.ownership.begin(), u.ownership.end(), culture->second) != u.ownership.end();
    if (!ownedByFaction && !ownedByCulture)
        return "Unit belongs to another faction";
    for (auto& [chain, level] : c.buildings)
        if (auto b = catalog->building(chain, level))
            for (auto& r : b->recruits)
                if (r.unit == u.name && requirement_reason(c, r.requirements).empty())
                    return {};
    return "Required recruitment building or reform is missing";
}
void CampaignProduction::enqueue(std::size_t id, std::size_t definition, bool recruitment) {
    auto& city = cities.at(id);
    auto& queue = recruitment ? city.recruitment : city.construction;
    auto reason =
        recruitment ? recruit_reason(id, definition) : building_reason(id, definition, true);
    if (!reason.empty())
        refuse(reason);
    if (queue.size() >= 9)
        refuse("queue is full");
    ProductionJob job;
    job.definition = definition;
    if (recruitment) {
        auto& u = catalog->units.at(definition);
        job.paid = u.cost;
        job.remaining = job.total = u.turns;
        for (auto& [chain, level] : city.buildings)
            if (auto b = catalog->building(chain, level))
                for (auto& r : b->recruits)
                    if (r.unit == u.name && requirement_reason(city, r.requirements).empty())
                        job.experience = std::max(job.experience, r.experience);
    } else {
        auto& b = catalog->buildings.at(definition);
        job.paid = b.cost;
        job.remaining = job.total = b.turns;
    }
    auto& funds = treasury.at(city.faction);
    if (funds < job.paid)
        refuse("insufficient funds");
    queue.push_back(job);
    funds -= job.paid;
}
void CampaignProduction::cancel(std::size_t id, std::size_t position, bool recruitment) {
    auto& c = cities.at(id);
    auto& q = recruitment ? c.recruitment : c.construction;
    if (position >= q.size())
        refuse("unknown queue entry");
    auto& funds = treasury.at(c.faction);
    if (funds > std::numeric_limits<std::int64_t>::max() - q[position].paid)
        refuse("refund overflow");
    funds += q[position].paid;
    q.erase(q.begin() + position);
}
void CampaignProduction::reorder(std::size_t id, std::size_t from, std::size_t to,
                                 bool recruitment) {
    auto& c = cities.at(id);
    auto& q = recruitment ? c.recruitment : c.construction;
    if (from >= q.size() || to >= q.size() || from == to)
        refuse("invalid queue reorder");
    auto job = q[from];
    q.erase(q.begin() + from);
    q.insert(q.begin() + to, job);
}
void CampaignProduction::advance() {
    for (std::size_t id = 0; id < cities.size(); ++id) {
        auto& c = cities[id];
        // Recruitment sees buildings completed on earlier turns; both heads receive one turn.
        if (!c.recruitment.empty()) {
            auto& job = c.recruitment.front();
            auto& u = catalog->units.at(job.definition);
            if (recruit_reason(id, job.definition).empty() && c.population > u.soldiers &&
                c.garrison.size() < 20) {
                if (--job.remaining == 0) {
                    c.garrison.push_back(Unit{u.name, static_cast<std::int32_t>(u.soldiers),
                                              job.experience, 0, 0, 0});
                    c.population -= u.soldiers;
                    c.recruitment.erase(c.recruitment.begin());
                }
            }
        }
        if (!c.construction.empty()) {
            auto& job = c.construction.front();
            auto& b = catalog->buildings.at(job.definition);
            if (building_reason(id, job.definition).empty() && --job.remaining == 0) {
                c.buildings[b.chain] = b.level;
                if (b.chain == "core_building")
                    c.level = b.settlementMin;
                c.construction.erase(c.construction.begin());
            }
        }
    }
}
void CampaignProduction::transfer(std::size_t city, std::size_t row, std::size_t actor,
                                  std::size_t initial) {
    auto& c = cities.at(city);
    auto& army = additions.at(actor);
    if (row >= c.garrison.size() || initial >= 20 || army.size() >= 20 - initial)
        refuse("invalid garrison transfer or full army");
    army.push_back(c.garrison[row]);
    c.garrison.erase(c.garrison.begin() + row);
}
std::vector<std::uint8_t> CampaignProduction::encode() const {
    Writer w;
    w.s("openrtw-production-v1");
    w.s(catalog->identity);
    w.u(marianReforms);
    w.u(treasury.size());
    for (auto funds : treasury)
        w.u(static_cast<std::uint64_t>(funds));
    auto units = [&](auto& rows) {
        w.u(rows.size());
        for (auto& u : rows) {
            w.s(u.name);
            w.u(u.count.value_or(0));
            w.u(u.experience.value_or(0));
        }
    };
    auto jobs = [&](auto& rows) {
        w.u(rows.size());
        for (auto& j : rows) {
            w.u(j.definition);
            w.u(j.remaining);
            w.u(j.total);
            w.u(j.paid);
            w.u(j.experience);
        }
    };
    w.u(cities.size());
    for (auto& c : cities) {
        w.u(c.population);
        w.s(c.level);
        w.u(c.buildings.size());
        for (auto& [a, b] : c.buildings) {
            w.s(a);
            w.s(b);
        }
        jobs(c.construction);
        jobs(c.recruitment);
        units(c.garrison);
    }
    w.u(additions.size());
    for (auto& a : additions)
        units(a);
    return w.bytes;
}
CampaignProduction CampaignProduction::decode(const Campaign& source,
                                              std::shared_ptr<const ProductionCatalog> catalog,
                                              std::span<const std::uint8_t> bytes) {
    if (bytes.size() > 1024 * 1024)
        refuse("production save too large");
    auto state = create(source, std::move(catalog));
    Reader r{bytes};
    if (r.s() != "openrtw-production-v1" || r.s() != state.catalog->identity)
        refuse("production catalog changed");
    state.marianReforms = r.count(1);
    if (r.u() != state.treasury.size())
        refuse("saved faction count");
    for (auto& funds : state.treasury) {
        auto v = r.u();
        funds = std::bit_cast<std::int64_t>(v);
    }
    auto units = [&](auto& rows) {
        auto count = r.count(20);
        rows.clear();
        for (std::size_t i = 0; i < count; ++i) {
            auto name = r.s();
            auto u = state.catalog->unit(name);
            auto soldiers = r.count(10000), exp = r.count(100);
            if (!u || soldiers != u->soldiers)
                refuse("invalid saved unit");
            rows.push_back(Unit{name, static_cast<std::int32_t>(soldiers),
                                static_cast<std::int32_t>(exp), 0, 0, 0});
        }
    };
    auto jobs = [&](auto& rows, bool recruitment) {
        auto count = r.count(9);
        rows.clear();
        for (std::size_t i = 0; i < count; ++i) {
            ProductionJob j;
            j.definition = r.count(recruitment ? state.catalog->units.size()
                                               : state.catalog->buildings.size());
            if (j.definition >=
                (recruitment ? state.catalog->units.size() : state.catalog->buildings.size()))
                refuse("saved definition index");
            j.remaining = r.count(1000);
            j.total = r.count(1000);
            j.paid = r.count(100000000);
            j.experience = r.count(100);
            auto cost = recruitment ? state.catalog->units[j.definition].cost
                                    : state.catalog->buildings[j.definition].cost;
            auto turns = recruitment ? state.catalog->units[j.definition].turns
                                     : state.catalog->buildings[j.definition].turns;
            if (!j.remaining || j.remaining > j.total || j.total != turns || j.paid != cost)
                refuse("invalid saved queue progress");
            rows.push_back(j);
        }
    };
    if (r.u() != state.cities.size())
        refuse("saved city count");
    for (auto& c : state.cities) {
        c.population = r.count(std::numeric_limits<std::int32_t>::max());
        c.level = r.s();
        if (city_rank(c.level) < 0)
            refuse("saved city level");
        auto count = r.count(2048);
        c.buildings.clear();
        for (std::size_t i = 0; i < count; ++i) {
            auto chain = r.s(), level = r.s();
            if (!state.catalog->building(chain, level) || !c.buildings.emplace(chain, level).second)
                refuse("saved building");
        }
        jobs(c.construction, false);
        jobs(c.recruitment, true);
        units(c.garrison);
    }
    if (r.u() != state.additions.size())
        refuse("saved actor count");
    std::size_t actorIndex = 0;
    for (const auto& faction : source.factions)
        for (const auto& character : faction.characters) {
            auto& army = state.additions.at(actorIndex++);
            units(army);
            if (!army.empty() && character.army.size() + army.size() > 20)
                refuse("saved army exceeds capacity");
        }
    if (r.at != bytes.size())
        refuse("trailing save bytes");
    return state;
}
} // namespace openrtw
