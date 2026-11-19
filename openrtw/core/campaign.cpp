#include "campaign.hpp"

#include <charconv>
#include <limits>
#include <set>
#include <stdexcept>
#include <unordered_set>
#include <utility>

namespace openrtw {
namespace {

std::string_view trim(std::string_view value) {
    while (!value.empty() && (value.front() == ' ' || value.front() == '\t'))
        value.remove_prefix(1);
    while (!value.empty() && (value.back() == ' ' || value.back() == '\t'))
        value.remove_suffix(1);
    return value;
}

[[noreturn]] void refuse(std::size_t line, std::string_view reason) {
    throw std::runtime_error("descr_strat line " + std::to_string(line) + ": " +
                             std::string(reason));
}

std::vector<std::string_view> words(std::string_view value) {
    std::vector<std::string_view> result;
    while (!(value = trim(value)).empty()) {
        const auto end = value.find_first_of(" \t");
        result.push_back(value.substr(0, end));
        if (end == std::string_view::npos)
            break;
        value.remove_prefix(end);
    }
    return result;
}

std::vector<std::string_view> comma_fields(std::string_view value) {
    std::vector<std::string_view> result;
    for (;;) {
        const auto end = value.find(',');
        result.push_back(trim(value.substr(0, end)));
        if (end == std::string_view::npos)
            break;
        value.remove_prefix(end + 1);
    }
    return result;
}

std::size_t comment_position(std::string_view value, std::size_t line) {
    bool quoted = false, escaped = false;
    for (std::size_t index = 0; index < value.size(); ++index) {
        const char c = value[index];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (quoted && c == '\\') {
            escaped = true;
            continue;
        }
        if (c == '"') {
            quoted = !quoted;
            continue;
        }
        if (!quoted && c == ';')
            return index;
    }
    if (quoted)
        refuse(line, "unterminated quoted string on physical line");
    return std::string_view::npos;
}

bool identifier(std::string_view value) {
    if (value.empty())
        return false;
    const auto letter = [](char c) {
        return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_';
    };
    if (!letter(value.front()))
        return false;
    for (const char c : value)
        if (!letter(c) && !(c >= '0' && c <= '9'))
            return false;
    return true;
}

bool structural_brace(std::string_view value) {
    bool quoted = false, escaped = false;
    for (const char c : value) {
        if (escaped) {
            escaped = false;
            continue;
        }
        if (quoted && c == '\\') {
            escaped = true;
            continue;
        }
        if (c == '"') {
            quoted = !quoted;
            continue;
        }
        if (!quoted && (c == '{' || c == '}'))
            return true;
    }
    return false;
}

template <class Integer>
Integer decimal(std::string_view value, std::size_t line, std::string_view field) {
    if (value.empty())
        refuse(line, field);
    Integer result{};
    const auto parsed = std::from_chars(value.data(), value.data() + value.size(), result, 10);
    if (parsed.ec != std::errc{} || parsed.ptr != value.data() + value.size())
        refuse(line, field);
    return result;
}

class Parser {
public:
    Campaign run(std::string_view input) {
        if (input.size() > campaign_max_input_bytes)
            refuse(0, "input exceeds byte limit");
        for (std::size_t position = 0; position < input.size();) {
            const auto end = input.find('\n', position);
            auto raw = input.substr(
                position, end == std::string_view::npos ? input.size() - position : end - position);
            position = end == std::string_view::npos ? input.size() : end + 1;
            ++line_;
            if (line_ > campaign_max_records)
                refuse(line_, "physical record limit");
            if (!raw.empty() && raw.back() == '\r')
                raw.remove_suffix(1);
            if (raw.size() > campaign_max_line_bytes)
                refuse(line_, "line exceeds byte limit");
            for (const char rawChar : raw) {
                const auto c = static_cast<unsigned char>(rawChar);
                if ((c < 0x20 && c != '\t') || c == 0x7f)
                    refuse(line_, "embedded control byte");
            }
            process(raw);
        }
        if (depth_ || pendingSettlement_ || settlement_)
            refuse(line_, "unclosed opaque or settlement block");
        if (!list_.empty())
            refuse(line_, "unclosed faction list");
        finish_faction();
        if (!campaignSeen_ || !dateSeen_ || result_.factions.empty())
            refuse(line_, "missing campaign, start_date, or faction");
        return std::move(result_);
    }

private:
    Campaign result_;
    std::unordered_set<std::string> factionIds_;
    std::size_t line_ = 0;
    std::optional<std::size_t> faction_, character_;
    bool campaignSeen_ = false, dateSeen_ = false, moneySeen_ = false;
    bool armyActive_ = false, armySeen_ = false, pendingSettlement_ = false;
    bool pendingBuilding_ = false;
    std::size_t depth_ = 0;
    std::size_t retainedBytes_ = 0;
    std::size_t settlementBlocks_ = 0, totalBuildings_ = 0;
    std::optional<Settlement> settlement_;
    std::optional<SettlementBuilding> building_;
    std::uint8_t settlementFields_ = 0;
    // Views refer only to immutable caller input during this synchronous parse;
    // every value returned in Campaign owns its storage independently.
    std::set<std::string_view> settlementRegions_;
    std::string list_, blockContext_;

    std::string context() const {
        std::string value = "campaign";
        if (faction_) {
            const auto& faction = result_.factions[*faction_];
            value += "/faction:" + faction.id;
            if (character_)
                value += "/character:" + faction.characters[*character_].name;
        }
        return value;
    }

    void charge(std::size_t bytes) {
        if (bytes > campaign_max_retained_bytes - retainedBytes_)
            refuse(line_, "retained text and context byte limit");
        retainedBytes_ += bytes;
    }

    std::string owned(std::string_view value) {
        charge(value.size());
        return std::string(value);
    }

    SettlementSourceLine source_line(std::string_view raw) { return {line_, owned(raw)}; }

    void retain(std::string_view raw, std::string where) {
        charge(raw.size());
        charge(where.size());
        result_.unsupported.push_back({line_, std::string(raw), std::move(where)});
    }

    void clear_character() {
        character_.reset();
        armyActive_ = armySeen_ = false;
    }

    void finish_faction() const {
        if (faction_ && !moneySeen_)
            refuse(line_, "faction requires one explicit denari record");
    }

    void braces(std::string_view syntax, std::size_t minimum = 0,
                std::size_t maximum = std::numeric_limits<std::size_t>::max()) {
        // Opaque text is never parsed as typed records. This bounded iterative
        // scan tracks braces outside quoted strings, without recursive blocks.
        bool quoted = false, escaped = false, closed = false;
        for (const char c : syntax) {
            if (closed) {
                if (c != ' ' && c != '\t')
                    refuse(line_, "trailing syntax after building close");
                continue;
            }
            if (escaped) {
                escaped = false;
                continue;
            }
            if (quoted && c == '\\') {
                escaped = true;
                continue;
            }
            if (c == '"') {
                quoted = !quoted;
                continue;
            }
            if (quoted)
                continue;
            if (c == '{') {
                if (depth_ >= maximum)
                    refuse(line_, "settlement nesting limit");
                ++depth_;
            }
            if (c == '}') {
                if (depth_ <= minimum)
                    refuse(line_, "unmatched closing brace");
                --depth_;
                if (minimum && depth_ == minimum)
                    closed = true;
            }
        }
    }

    static bool empty_braces(std::string_view value) {
        if (value.empty() || value.front() != '{')
            return false;
        value.remove_prefix(1);
        return trim(value) == "}";
    }

    void finish_building() {
        settlement_->buildings.push_back(std::move(*building_));
        building_.reset();
        pendingBuilding_ = false;
    }

    void finish_settlement() {
        // Preserve the old reader's purely opaque settlement blocks. A partial
        // supported record is distinct: it cannot silently become typed data.
        if (settlementFields_ && settlementFields_ != 0x3f)
            refuse(line_, "settlement requires all six literal fields");
        if (settlementFields_)
            result_.factions[*faction_].settlements.push_back(std::move(*settlement_));
        settlement_.reset();
        pendingSettlement_ = false;
        depth_ = 0;
    }

    void start_settlement(std::string_view value, std::string_view raw) {
        if (!faction_)
            refuse(line_, "settlement outside faction section");
        if (settlementBlocks_ >= campaign_max_settlement_blocks)
            refuse(line_, "settlement block limit");
        ++settlementBlocks_;
        clear_character();
        blockContext_ = context() + "/settlement";
        retain(raw, blockContext_);
        settlement_.emplace();
        settlement_->line = line_;
        settlementFields_ = 0;
        if (value.empty())
            pendingSettlement_ = true;
        else if (value == "{")
            depth_ = 1;
        else if (empty_braces(value))
            finish_settlement();
        else
            refuse(line_, "unsupported settlement opening syntax");
    }

    void start_building(std::string_view value, std::string_view raw) {
        if (settlement_->buildings.size() >= campaign_max_buildings_per_settlement ||
            totalBuildings_ >= campaign_max_total_settlement_buildings)
            refuse(line_, "settlement building limit");
        ++totalBuildings_;
        building_.emplace();
        building_->line = line_;
        building_->source.push_back(source_line(raw));
        if (value.empty())
            pendingBuilding_ = true;
        else if (value == "{")
            depth_ = 2;
        else if (empty_braces(value))
            finish_building();
        else
            refuse(line_, "unsupported building opening syntax");
    }

    void settlement_line(std::string_view raw, std::string_view syntax) {
        // All rows remain in the legacy unsupported collection, with exactly
        // its prior context. Typed copies share the same aggregate text budget.
        retain(raw, blockContext_);
        if (pendingSettlement_) {
            if (syntax.empty())
                return;
            pendingSettlement_ = false;
            if (syntax == "{")
                depth_ = 1;
            else if (empty_braces(syntax))
                finish_settlement();
            else
                refuse(line_, "settlement requires opening brace");
            return;
        }
        if (building_) {
            building_->source.push_back(source_line(raw));
            if (pendingBuilding_) {
                if (syntax.empty())
                    return;
                pendingBuilding_ = false;
                if (syntax == "{")
                    depth_ = 2;
                else if (empty_braces(syntax))
                    finish_building();
                else
                    refuse(line_, "building requires opening brace");
            } else {
                braces(syntax, 1, campaign_max_settlement_depth);
                if (depth_ == 1)
                    finish_building();
            }
            return;
        }
        if (syntax.empty())
            return;
        if (syntax == "}") {
            finish_settlement();
            return;
        }
        const auto separator = syntax.find_first_of(" \t");
        const auto key = syntax.substr(0, separator);
        const auto value = separator == std::string_view::npos ? std::string_view{}
                                                               : trim(syntax.substr(separator));
        if (key == "building") {
            start_building(value, raw);
            return;
        }
        if (key == "settlement")
            refuse(line_, "nested settlement is unsupported");
        // Unknown top-level records stay opaque, but cannot hide more blocks.
        if (structural_brace(syntax))
            refuse(line_, "unsupported nested settlement block");

        std::optional<SettlementField> field;
        if (key == "level")
            field = SettlementField::level;
        else if (key == "region")
            field = SettlementField::region;
        else if (key == "year_founded")
            field = SettlementField::yearFounded;
        else if (key == "population")
            field = SettlementField::population;
        else if (key == "plan_set")
            field = SettlementField::planSet;
        else if (key == "faction_creator")
            field = SettlementField::factionCreator;
        else
            return;
        const auto index = static_cast<std::size_t>(*field);
        const auto bit = static_cast<std::uint8_t>(1u << index);
        if (settlementFields_ & bit)
            refuse(line_, "duplicate settlement field");
        switch (*field) {
        case SettlementField::level:
            if (!identifier(value))
                refuse(line_, "invalid settlement level literal");
            settlement_->level = owned(value);
            break;
        case SettlementField::region:
            if (!identifier(value) || !settlementRegions_.insert(value).second)
                refuse(line_, "invalid or duplicate settlement region literal");
            settlement_->region = owned(value);
            break;
        case SettlementField::yearFounded:
            settlement_->yearFounded =
                decimal<std::int32_t>(value, line_, "invalid settlement year_founded integer");
            break;
        case SettlementField::population:
            settlement_->population =
                decimal<std::int32_t>(value, line_, "invalid settlement population integer");
            break;
        case SettlementField::planSet:
            if (!identifier(value))
                refuse(line_, "invalid settlement plan_set literal");
            settlement_->planSet = owned(value);
            break;
        case SettlementField::factionCreator:
            if (!identifier(value))
                refuse(line_, "invalid settlement faction_creator literal");
            settlement_->factionCreator = owned(value);
            break;
        }
        settlement_->source[index] = source_line(raw);
        settlementFields_ |= bit;
    }

    void character(std::string_view value, std::string_view raw, bool comment) {
        if (!faction_)
            refuse(line_, "character outside faction");
        const auto fields = comma_fields(value);
        std::size_t first = 0;
        Character parsed;
        const auto prefix = words(fields.front());
        if (!prefix.empty() && prefix.front() == "sub_faction") {
            if (prefix.size() != 2 || !identifier(prefix[1]))
                refuse(line_, "invalid sub_faction prefix");
            parsed.subFaction = std::string(prefix[1]);
            first = 1;
        }
        if (fields.size() < first + 2 || fields[first].empty())
            refuse(line_, "missing character name or type");
        parsed.name = std::string(fields[first]);
        parsed.type = std::string(fields[first + 1]);
        if (parsed.type != "named character" && parsed.type != "general" &&
            parsed.type != "admiral" && parsed.type != "spy" && parsed.type != "diplomat")
            refuse(line_, "unsupported character type");
        bool xSeen = false, ySeen = false, opaque = comment;
        for (std::size_t index = first + 2; index < fields.size(); ++index) {
            if (fields[index].empty())
                continue; // Empty comma padding in the owned corpus.
            const auto parts = words(fields[index]);
            if (parts.front() == "age" || parts.front() == "x" || parts.front() == "y") {
                if (parts.size() != 2)
                    refuse(line_, "invalid character numeric field");
                const auto number =
                    decimal<std::int32_t>(parts[1], line_, "invalid character integer");
                if (parts.front() == "age") {
                    if (parsed.age)
                        refuse(line_, "duplicate character age");
                    parsed.age = number;
                } else if (parts.front() == "x") {
                    if (xSeen)
                        refuse(line_, "duplicate character x");
                    parsed.x = number;
                    xSeen = true;
                } else {
                    if (ySeen)
                        refuse(line_, "duplicate character y");
                    parsed.y = number;
                    ySeen = true;
                }
            } else
                opaque = true; // Including leader/heir: retained, never simulated.
        }
        if (!xSeen || !ySeen)
            refuse(line_, "character requires x and y");
        parsed.line = line_;
        auto& characters = result_.factions[*faction_].characters;
        characters.push_back(std::move(parsed));
        character_ = characters.size() - 1;
        armyActive_ = armySeen_ = false;
        if (opaque)
            retain(raw, context() + "/metadata");
    }

    Unit unit(std::string_view value) const {
        const auto parts = words(value);
        std::size_t boundary = 0;
        while (boundary < parts.size() && parts[boundary] != "exp" && parts[boundary] != "armour" &&
               parts[boundary] != "weapon_lvl")
            ++boundary;
        // The measured corpus uses this complete ordered suffix for every unit.
        // No count/default strength or broader unit-parameter grammar is inferred.
        if (!boundary || parts.size() - boundary != 6 || parts[boundary] != "exp" ||
            parts[boundary + 2] != "armour" || parts[boundary + 4] != "weapon_lvl")
            refuse(line_, "unsupported or malformed unit fields");
        Unit parsed;
        const auto nameEnd = static_cast<std::size_t>(parts[boundary].data() - value.data());
        parsed.name = std::string(trim(value.substr(0, nameEnd)));
        if (parsed.name.empty())
            refuse(line_, "missing unit name");
        parsed.experience =
            decimal<std::int32_t>(parts[boundary + 1], line_, "invalid unit experience");
        parsed.armour = decimal<std::int32_t>(parts[boundary + 3], line_, "invalid unit armour");
        parsed.weapon =
            decimal<std::int32_t>(parts[boundary + 5], line_, "invalid unit weapon_lvl");
        parsed.line = line_;
        return parsed;
    }

    void process(std::string_view raw) {
        const auto commentAt = comment_position(raw, line_);
        const auto syntax = trim(raw.substr(0, commentAt));
        if (settlement_) {
            settlement_line(raw, syntax);
            return;
        }
        if (depth_) {
            retain(raw, blockContext_);
            braces(syntax);
            return;
        }
        if (!list_.empty()) {
            retain(raw, "campaign/" + list_);
            if (syntax == "end")
                list_.clear();
            return;
        }
        if (syntax.empty()) {
            retain(raw, context());
            return;
        }
        const auto separator = syntax.find_first_of(" \t");
        const auto key = syntax.substr(0, separator);
        const auto value = separator == std::string_view::npos ? std::string_view{}
                                                               : trim(syntax.substr(separator));
        const bool comment = commentAt != std::string_view::npos;
        bool retained = false;

        if (key == "playable" || key == "unlockable" || key == "nonplayable") {
            if (!value.empty())
                refuse(line_, "invalid faction list marker");
            clear_character();
            list_ = std::string(key);
            retain(raw, "campaign/" + list_);
            return;
        }
        if (key == "settlement") {
            start_settlement(value, raw);
            return;
        }
        const bool supported = key == "campaign" || key == "start_date" || key == "faction" ||
                               key == "denari" || key == "character" || key == "army" ||
                               key == "unit";
        if (supported && syntax.find('"') != std::string_view::npos)
            refuse(line_, "quoted syntax in supported record");
        if (supported && syntax.find_first_of("{}") != std::string_view::npos)
            refuse(line_, "brace in supported record");

        if (key == "campaign") {
            if (campaignSeen_ || faction_ || !identifier(value))
                refuse(line_, "invalid or duplicate campaign header");
            result_.id = std::string(value);
            campaignSeen_ = true;
        } else if (key == "start_date") {
            const auto parts = words(value);
            if (dateSeen_ || faction_ || parts.size() != 2)
                refuse(line_, "invalid or duplicate start_date");
            result_.startYear = decimal<std::int32_t>(parts[0], line_, "invalid start_date year");
            if (parts[1] == "summer")
                result_.startSeason = Season::summer;
            else if (parts[1] == "winter")
                result_.startSeason = Season::winter;
            else
                refuse(line_, "invalid start_date season");
            dateSeen_ = true;
        } else if (key == "faction") {
            if (!campaignSeen_ || !dateSeen_)
                refuse(line_, "faction before campaign and start_date");
            finish_faction();
            clear_character();
            const auto comma = value.find(',');
            const auto id = trim(value.substr(0, comma));
            if (!identifier(id) || !factionIds_.insert(std::string(id)).second)
                refuse(line_, "invalid or duplicate faction id");
            if (comma != std::string_view::npos && trim(value.substr(comma + 1)).empty())
                refuse(line_, "empty faction metadata");
            Faction parsed;
            parsed.id = std::string(id);
            parsed.line = line_;
            result_.factions.push_back(std::move(parsed));
            faction_ = result_.factions.size() - 1;
            moneySeen_ = false;
            if (comma != std::string_view::npos) {
                retain(raw, context() + "/header-metadata");
                retained = true;
            }
        } else if (key == "denari") {
            if (!faction_ || moneySeen_)
                refuse(line_, "denari outside faction or duplicated");
            result_.factions[*faction_].denari =
                decimal<std::int64_t>(value, line_, "invalid denari");
            moneySeen_ = true;
        } else if (key == "character") {
            character(value, raw, comment);
            return;
        } else if (key == "army") {
            if (!value.empty() || !faction_ || !character_ || armySeen_)
                refuse(line_, "orphan or duplicate army marker");
            armyActive_ = armySeen_ = true;
        } else if (key == "unit") {
            if (!armyActive_ || !faction_ || !character_)
                refuse(line_, "unit outside explicit army");
            result_.factions[*faction_].characters[*character_].army.push_back(unit(value));
        } else {
            if (key == "core_attitudes" || key == "faction_relationships") {
                finish_faction();
                clear_character();
                faction_.reset();
            }
            const auto where = context();
            if (syntax.find_first_of("{}") != std::string_view::npos) {
                clear_character();
                blockContext_ = context() + "/opaque-block";
                retain(raw, blockContext_);
                braces(syntax);
            } else {
                retain(raw, where);
                if (key != "traits" && key != "ancillaries")
                    clear_character();
                else
                    armyActive_ = false;
            }
            return;
        }
        if (comment && !retained)
            retain(raw, context() + "/comment");
    }
};

} // namespace

Campaign load_campaign(std::string_view input) {
    return Parser{}.run(input);
}

} // namespace openrtw
