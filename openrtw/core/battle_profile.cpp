#include "battle_profile.hpp"

#include <array>
#include <charconv>
#include <limits>
#include <stdexcept>
#include <string_view>
#include <utility>

namespace openrtw {
namespace {

std::string_view trim(std::string_view value) noexcept {
    while (!value.empty() && (value.front() == ' ' || value.front() == '\t'))
        value.remove_prefix(1);
    while (!value.empty() && (value.back() == ' ' || value.back() == '\t'))
        value.remove_suffix(1);
    return value;
}

[[noreturn]] void refuse(std::size_t line, std::string_view reason) {
    throw std::runtime_error("Battle profile line " + std::to_string(line) + ": " +
                             std::string(reason));
}

void text(std::string_view value, std::size_t line) {
    if (value.size() > battle_profile_max_field_bytes)
        refuse(line, "field byte budget exceeded");
    for (const char raw : value) {
        const auto c = static_cast<unsigned char>(raw);
        if ((c < 0x20 && c != '\t') || c == 0x7f)
            refuse(line, "control byte in field");
    }
}

bool identifier(std::string_view value) noexcept {
    const auto letter = [](char c) {
        return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_';
    };
    if (value.empty() || !letter(value.front()))
        return false;
    for (const char c : value)
        if (!letter(c) && !(c >= '0' && c <= '9'))
            return false;
    return true;
}

void token(std::string_view value, std::size_t line) {
    if (value.empty() || value.find_first_of(" \t,") != std::string_view::npos)
        refuse(line, "expected one nonempty token");
}

class Owner {
public:
    std::string copy(std::string_view value, std::size_t line) {
        text(value, line);
        if (value.size() > battle_profile_max_owned_bytes - bytes_)
            refuse(line, "owned text budget exceeded");
        bytes_ += value.size();
        return std::string(value);
    }

private:
    std::size_t bytes_ = 0;
};

std::uint32_t number(std::string_view value, std::size_t line) {
    if (value.empty())
        refuse(line, "empty unsigned integer");
    for (const char c : value)
        if (c < '0' || c > '9')
            refuse(line, "expected unsigned decimal integer");
    std::uint32_t result = 0;
    const auto parsed = std::from_chars(value.data(), value.data() + value.size(), result);
    if (parsed.ec != std::errc{} || parsed.ptr != value.data() + value.size())
        refuse(line, "unsigned integer overflow");
    return result;
}

std::uint32_t millimetres(std::string_view value, std::size_t line) {
    const auto dot = value.find('.');
    const auto whole = number(value.substr(0, dot), line);
    std::uint32_t fraction = 0;
    if (dot != std::string_view::npos) {
        const auto digits = value.substr(dot + 1);
        if (digits.empty() || digits.size() > 3)
            refuse(line, "spacing requires 1..3 fractional digits");
        fraction = number(digits, line);
        for (std::size_t i = digits.size(); i < 3; ++i)
            fraction *= 10;
    }
    const auto result = static_cast<std::uint64_t>(whole) * 1000 + fraction;
    if (result > std::numeric_limits<std::uint32_t>::max())
        refuse(line, "millimetre spacing overflow");
    return static_cast<std::uint32_t>(result);
}

struct Csv {
    std::array<std::string_view, 11> values{};
    std::size_t count = 0;
};

Csv csv(std::string_view value, std::size_t minimum, std::size_t maximum, std::size_t line) {
    Csv result;
    for (;;) {
        if (result.count == maximum)
            refuse(line, "too many CSV components");
        const auto comma = value.find(',');
        const auto part = trim(value.substr(0, comma));
        if (part.empty())
            refuse(line, "empty CSV component");
        result.values[result.count++] = part;
        if (comma == std::string_view::npos)
            break;
        value.remove_prefix(comma + 1);
    }
    if (result.count < minimum)
        refuse(line, "too few CSV components");
    return result;
}

BattleWeapon weapon(const BattleSourceField& field, Owner& owner) {
    const auto parts = csv(field.value, 11, 11, field.line).values;
    BattleWeapon result;
    result.attack = number(parts[0], field.line);
    result.charge = number(parts[1], field.line);
    result.rangeMeters = number(parts[3], field.line);
    result.ammunition = number(parts[4], field.line);
    result.delayTenths = number(parts[9], field.line);
    for (const auto index : {2U, 5U, 6U, 7U, 8U})
        token(parts[index], field.line);
    result.missileType = owner.copy(parts[2], field.line);
    result.weaponType = owner.copy(parts[5], field.line);
    result.technology = owner.copy(parts[6], field.line);
    result.damageType = owner.copy(parts[7], field.line);
    result.sound = owner.copy(parts[8], field.line);
    result.opaqueTail = owner.copy(parts[10], field.line);
    result.sourceLine = field.line;
    return result;
}

constexpr std::array<std::string_view, 9> singletons{"dictionary", "category",  "class",
                                                     "soldier",    "formation", "stat_health",
                                                     "stat_pri",   "stat_sec",  "stat_pri_armour"};

} // namespace

BattleUnitProfile load_battle_unit_profile(const UnitDefinition& definition) {
    if (definition.fields.size() > battle_profile_max_fields)
        refuse(definition.line, "field record budget exceeded");
    for (const auto* value : {&definition.type, &definition.soldierModel, &definition.category,
                              &definition.unitClass, &definition.dictionary})
        text(*value, definition.line);
    if (definition.type.empty() || trim(definition.type) != definition.type ||
        definition.type.find(',') != std::string::npos || !identifier(definition.soldierModel) ||
        definition.sourceSoldierCount < 0)
        refuse(definition.line, "invalid supplied unit identity/count");
    token(definition.category, definition.line);
    token(definition.unitClass, definition.line);
    Owner owner;
    BattleUnitProfile result;
    result.type = owner.copy(definition.type, definition.line);
    result.model = owner.copy(definition.soldierModel, definition.line);
    result.category = owner.copy(definition.category, definition.line);
    result.unitClass = owner.copy(definition.unitClass, definition.line);
    result.sourceSoldierCount = static_cast<std::uint32_t>(definition.sourceSoldierCount);
    result.sourceLine = definition.line;
    std::array<const BattleSourceField*, singletons.size()> found{};
    for (const auto& field : definition.fields) {
        text(field.key, field.line);
        text(field.value, field.line);
        text(field.source, field.line);
        if (!identifier(field.key) || trim(field.value) != field.value)
            refuse(field.line, "invalid field key/value framing");
        const auto physical =
            trim(std::string_view(field.source).substr(0, field.source.find(';')));
        const auto split = physical.find_first_of(" \t");
        const auto rawKey = physical.substr(0, split);
        const auto rawValue =
            split == std::string_view::npos ? std::string_view{} : trim(physical.substr(split));
        if (rawKey != field.key || rawValue != field.value)
            refuse(field.line, "field source/value disagreement");
        for (std::size_t i = 0; i < singletons.size(); ++i) {
            if (field.key != singletons[i])
                continue;
            if (found[i])
                refuse(field.line, "duplicate required singleton");
            found[i] = &field;
        }
        result.fields.push_back({field.line, owner.copy(field.key, field.line),
                                 owner.copy(field.value, field.line),
                                 owner.copy(field.source, field.line)});
    }
    for (const auto* field : found)
        if (!field)
            refuse(definition.line, "missing required singleton");
    token(found[0]->value, found[0]->line);
    if (found[0]->value != definition.dictionary || found[1]->value != definition.category ||
        found[2]->value != definition.unitClass)
        refuse(definition.line, "typed singleton/source disagreement");
    const auto soldier = csv(found[3]->value, 4, 4, found[3]->line).values;
    const auto count = number(soldier[1], found[3]->line);
    if (soldier[0] != definition.soldierModel || count != result.sourceSoldierCount)
        refuse(found[3]->line, "typed soldier/source disagreement");

    const auto formation = csv(found[4]->value, 6, 7, found[4]->line);
    for (std::size_t i = 0; i < result.spacingMillimetres.size(); ++i)
        result.spacingMillimetres[i] = millimetres(formation.values[i], found[4]->line);
    result.formationRanks = number(formation.values[4], found[4]->line);
    for (std::size_t i = 5; i < formation.count; ++i) {
        token(formation.values[i], found[4]->line);
        result.formations.push_back(owner.copy(formation.values[i], found[4]->line));
    }
    const auto health = csv(found[5]->value, 2, 2, found[5]->line).values;
    result.manHitPoints = number(health[0], found[5]->line);
    result.mountHitPoints = number(health[1], found[5]->line);
    result.primary = weapon(*found[6], owner);
    result.secondary = weapon(*found[7], owner);
    const auto armour = csv(found[8]->value, 4, 4, found[8]->line).values;
    result.armour = number(armour[0], found[8]->line);
    result.defenceSkill = number(armour[1], found[8]->line);
    result.shield = number(armour[2], found[8]->line);
    token(armour[3], found[8]->line);
    return result;
}

} // namespace openrtw
