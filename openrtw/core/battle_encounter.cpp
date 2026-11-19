#include "battle_encounter.hpp"
#include "battle_session.hpp"

#include <stdexcept>
#include <string_view>

namespace openrtw {
namespace {
void add_bytes(std::size_t& total, std::size_t size) {
    if (size > battle_session_max_owned_bytes - total)
        throw std::runtime_error("battle: owned source budget exceeded");
    total += size;
}
void count_profile(std::size_t& total, const BattleUnitProfile& profile) {
    if (profile.fields.size() > battle_profile_max_fields ||
        profile.formations.size() > battle_profile_max_fields)
        throw std::runtime_error("battle: profile metadata count exceeded");
    const auto field = [&total](const std::string& value) {
        if (value.size() > battle_profile_max_field_bytes)
            throw std::runtime_error("battle: profile field budget exceeded");
        add_bytes(total, value.size());
    };
    for (const auto* text : {&profile.type, &profile.model, &profile.category, &profile.unitClass})
        field(*text);
    for (const auto& text : profile.formations)
        field(text);
    for (const auto& row : profile.fields) {
        add_bytes(total, sizeof(BattleSourceField));
        field(row.key);
        field(row.value);
        field(row.source);
    }
    for (const auto* weapon : {&profile.primary, &profile.secondary})
        for (const auto* text : {&weapon->missileType, &weapon->weaponType, &weapon->technology,
                                &weapon->damageType, &weapon->sound, &weapon->opaqueTail})
            field(*text);
}
} // namespace

BattleFormationAdmission inspect_battle_formation(const BattleEncounterFormation& row) {
    const auto& profile = row.profile;
    BattleMovementKind movement;
    if (profile.category == "cavalry")
        movement = BattleMovementKind::Cavalry;
    else if (profile.category == "siege")
        movement = BattleMovementKind::Siege;
    else if (profile.category == "infantry" || profile.category == "handler" ||
             profile.category == "non_combatant")
        movement = BattleMovementKind::Infantry;
    else
        throw std::runtime_error("battle: unsupported land category (ships are not admitted)");
    if (profile.manHitPoints == 0)
        throw std::runtime_error("battle: positive man hit points required");
    if (row.sourceUnit.count && *row.sourceUnit.count <= 0)
        throw std::runtime_error("battle: explicit source count must be positive");
    const auto count = row.sourceUnit.count ? static_cast<std::uint32_t>(*row.sourceUnit.count)
                                           : profile.sourceSoldierCount;
    if (count == 0 || count > battle_session_max_soldiers)
        throw std::runtime_error("battle: effective soldier count outside1..2000");
    if (profile.type.empty() || profile.model.empty() || row.sourceUnit.name != profile.type)
        throw std::runtime_error("battle: encounter source/profile type mismatch");
    return {movement, count, row.sourceUnit.count.has_value()};
}

void validate_battle_encounter_budget(const BattleEncounter& encounter) {
    // Keep the existing counted runtime budget, including BattleUnit's runtime
    // fields even though the input is smaller. This is not a process-heap cap.
    std::size_t owned = sizeof(BattleOrigin);
    add_bytes(owned, encounter.origin.campaignId.size());
    for (const auto* actor : {&encounter.origin.player, &encounter.origin.opponent})
        for (const auto* text : {&actor->name, &actor->type, &actor->sourceFaction})
            add_bytes(owned, text->size());
    for (const auto& army : encounter.armies) {
        if (army.size() > battle_session_max_team_units)
            throw std::runtime_error("battle: selected army must have 1..20 formations");
        for (const auto& row : army) {
            add_bytes(owned, sizeof(BattleUnit));
            add_bytes(owned, row.sourceUnit.name.size());
            count_profile(owned, row.profile);
        }
    }
}

void validate_battle_encounter(const BattleEncounter& encounter) {
    if (encounter.origin.player.actor.id == encounter.origin.opponent.actor.id)
        throw std::runtime_error("battle: two distinct actors required");
    if (encounter.origin.season != Season::summer && encounter.origin.season != Season::winter)
        throw std::runtime_error("battle: invalid source season");
    for (const auto* origin : {&encounter.origin.player, &encounter.origin.opponent})
        if (origin->actor.ap > origin->actor.maxAp)
            throw std::runtime_error("battle: invalid source AP snapshot");
    for (const auto& army : encounter.armies)
        if (army.empty() || army.size() > battle_session_max_team_units)
            throw std::runtime_error("battle: selected army must have 1..20 formations");
    validate_battle_encounter_budget(encounter);
    for (const auto& army : encounter.armies)
        for (const auto& row : army)
            (void)inspect_battle_formation(row);
}

} // namespace openrtw
