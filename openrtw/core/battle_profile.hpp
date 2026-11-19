#pragma once

#include "battle_catalog.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace openrtw {

// OpenRTW conversion budgets, not original game parser capacities.
inline constexpr std::size_t battle_profile_max_field_bytes = 65536;
inline constexpr std::size_t battle_profile_max_fields = 4096;
inline constexpr std::size_t battle_profile_max_owned_bytes = 8 * 1024 * 1024;

struct BattleWeapon {
    std::uint32_t attack = 0, charge = 0, rangeMeters = 0, ammunition = 0, delayTenths = 0;
    std::string missileType, weaponType, technology, damageType, sound;
    // The source has eleven CSV components; its comments explain only ten.
    // This final component remains exact trimmed text with no numeric meaning.
    std::string opaqueTail;
    std::size_t sourceLine = 0;
};

struct BattleUnitProfile {
    std::string type, model, category, unitClass;
    // Literal ordinary soldier count from the definition, not effective or
    // current campaign/battle strength, size scaling, officers or extras.
    std::uint32_t sourceSoldierCount = 0;
    std::uint32_t manHitPoints = 0, mountHitPoints = 0;
    std::uint32_t armour = 0, defenceSkill = 0, shield = 0, formationRanks = 0;
    // Close side/front-back, then loose side/front-back spacing. Decimal
    // source metres convert exactly to millimetres, without float rounding.
    std::array<std::uint32_t, 4> spacingMillimetres{};
    std::vector<std::string> formations;
    BattleWeapon primary, secondary;
    std::size_t sourceLine = 0;
    // Complete owned source order, including comments, lexical numeric forms,
    // armour sound, repeated officers and all otherwise uninterpreted fields.
    std::vector<BattleSourceField> fields;
};

// Required singletons: dictionary/category/class/soldier/formation/stat_health/
// stat_pri/stat_sec/stat_pri_armour. Repeats, missing values, malformed arities,
// controls, invalid unsigned integers, nonexact millimetre decimals, mismatched
// supplied UnitDefinition typed fields and budget excess throw runtime_error.
// Weapon CSV has exactly11 fields, formation6/7, health2 and primary armour4.
// Numeric unsigned fields accept decimal digits only; spacing accepts digits
// with an optional decimal point and 1..3 fractional digits. No signs, exponent,
// nonfinite spelling, rounding, inferred defaults, speed or combat formula.
// All input strings/fields are copied into a staged result; no borrow or partial
// publication escapes. Unknown fields remain ordered/raw, without new meanings.
BattleUnitProfile load_battle_unit_profile(const UnitDefinition& definition);

} // namespace openrtw
