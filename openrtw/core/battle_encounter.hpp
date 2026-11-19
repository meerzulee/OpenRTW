#pragma once

#include "battle_profile.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace openrtw {

// Owned input for the existing Rome-format OpenRTW battle prototype. This is
// not a universal battle schema or recovered native encounter/aftermath model.
inline constexpr std::size_t battle_session_max_team_units = 20;
inline constexpr std::uint32_t battle_session_max_soldiers = 2000;
inline constexpr std::size_t battle_session_max_owned_bytes = 16 * 1024 * 1024;

struct BattlePoint {
    std::int32_t x = 0, y = 0;
};
enum class BattleMovementKind { Infantry, Cavalry, Siege };

struct BattleSourceActor {
    // Opaque source provenance, owned by the encounter producer. No live
    // campaign object, campaign AP default, reference or callback is retained.
    std::uint32_t id = 0, sourceFactionIndex = 0, sourceCharacterIndex = 0;
    std::size_t sourceLine = 0;
    std::int32_t initialX = 0, initialY = 0, currentX = 0, currentY = 0;
    std::uint32_t ap = 0, maxAp = 0;
    std::optional<BattlePoint> destination;
};
struct BattleOriginActor {
    BattleSourceActor actor;
    std::string name, type, sourceFaction;
};
struct BattleOrigin {
    std::string campaignId;
    std::uint32_t revision = 0, orderRevision = 0;
    std::uint64_t turn = 0;
    std::int32_t year = 0;
    Season season = Season::summer;
    BattleOriginActor player, opponent;
};
struct BattleEncounterFormation {
    Unit sourceUnit;
    BattleUnitProfile profile;
};
struct BattleEncounter {
    BattleOrigin origin;
    // Player rows, then opponent rows; row position is source army provenance.
    std::array<std::vector<BattleEncounterFormation>, 2> armies;
};
struct BattleFormationAdmission {
    BattleMovementKind movementKind;
    std::uint32_t soldiers;
    bool explicitSourceCount;
};

// Shared admission logic for the title adapter and independent battle entry.
// The budget check also accepts partially assembled inputs; it is not proof
// of a complete encounter. Full validation requires both nonempty armies.
BattleFormationAdmission inspect_battle_formation(const BattleEncounterFormation&);
void validate_battle_encounter_budget(const BattleEncounter&);
void validate_battle_encounter(const BattleEncounter&);

} // namespace openrtw
