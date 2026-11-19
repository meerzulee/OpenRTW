#pragma once

#include "battle_encounter.hpp"

#include <cstddef>
#include <cstdint>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace openrtw {

// New deterministic OpenRTW policy, not recovered RTW combat, scale, speed,
// deployment, hostility, troop scaling, collision or casualty persistence.
inline constexpr std::string_view battle_session_policy = "openrtw-battle-prototype-v1";
inline constexpr std::uint32_t battle_session_width = 64, battle_session_height = 48;
inline constexpr std::uint32_t battle_session_cell_metres = 5, battle_session_tick_ms = 100;
inline constexpr std::uint32_t battle_session_max_step_ticks = 20;
inline constexpr std::uint32_t battle_session_max_ticks = 36000;
enum class BattleTeam { Player, Opponent };
enum class BattleOrderKind { Hold, Move, Attack };
enum class BattleOutcome { Active, PlayerVictory, OpponentVictory, Draw, Retreated };
enum class BattleCommandStatus {
    Applied,
    StaleRevision,
    InvalidUnit,
    NotPlayerUnit,
    OutOfBounds,
    Occupied,
    InvalidTarget,
    NoOp,
    InvalidTicks,
    Finished,
    RevisionOverflow,
};

struct BattleUnit {
    // Stable player rows followed by opponent rows, including repeated rows
    // and eliminated formations. A source faction index is provenance only.
    std::uint32_t id = 0;
    BattleTeam team = BattleTeam::Player;
    BattleMovementKind movementKind = BattleMovementKind::Infantry;
    std::uint32_t sourceActorId = 0, sourceFactionIndex = 0, sourceCharacterIndex = 0;
    std::size_t sourceArmyIndex = 0, sourceLine = 0;
    Unit sourceUnit;
    BattleUnitProfile profile;
    // Positive explicit campaign count takes precedence; otherwise the literal
    // unscaled definition count is chosen. No experience/equipment modifiers.
    bool usesExplicitSourceCount = false;
    std::uint32_t initialSoldiers = 0;
    std::uint64_t maxHitPoints = 0, hitPoints = 0;
    std::int32_t x = 0, y = 0;
    BattleOrderKind order = BattleOrderKind::Hold;
    std::optional<BattlePoint> destination;
    std::optional<std::uint32_t> targetId;
    // Ammo counts formation discharges, not individual projectile objects.
    std::uint32_t ammunition = 0, cooldownTicks = 0, movementTicks = 0;
    std::uint32_t living_soldiers() const noexcept;
};

struct BattleCommandResult {
    BattleCommandStatus status = BattleCommandStatus::Applied;
    std::uint32_t revision = 0, ticksAdvanced = 0;
    bool accepted() const noexcept { return status == BattleCommandStatus::Applied; }
};

class BattleSession {
public:
    // Validates and copies an owned encounter; no campaign/session/catalog
    // object is required. Rome's selection and catalog joins live in its
    // encounter adapter. The existing prototype combat policy is unchanged.
    static BattleSession create(const BattleEncounter&);

    const std::vector<BattleUnit>& units() const noexcept { return units_; }
    const BattleOrigin& origin() const noexcept { return origin_; }
    std::uint32_t revision() const noexcept { return revision_; }
    std::uint32_t ticks() const noexcept { return ticks_; }
    BattleOutcome outcome() const noexcept { return outcome_; }
    static constexpr std::uint32_t width() noexcept { return battle_session_width; }
    static constexpr std::uint32_t height() noexcept { return battle_session_height; }

    BattleCommandResult move(std::uint32_t unitId, std::int32_t x, std::int32_t y,
                             std::uint32_t expectedRevision);
    BattleCommandResult attack(std::uint32_t unitId, std::uint32_t targetId,
                               std::uint32_t expectedRevision);
    BattleCommandResult hold(std::uint32_t unitId, std::uint32_t expectedRevision);
    // Tick phases: elapsed cooldown/credit and nearest-opponent AI, stable-ID
    // dynamic-occupancy BFS moves (E,S,W,N), simultaneous scratch attacks, then
    // casualties/outcome. Manhattan range; minimum one-cell melee/ranged range.
    // Delay tenths are ticks with a minimum of one. Movement credit caps at one
    // cell and resets on a successful step. Arrivals can attack that same tick.
    // Terminal outcomes stop a batch early; no wall clock or random state.
    BattleCommandResult step(std::uint32_t ticks, std::uint32_t expectedRevision);
    BattleCommandResult retreat(std::uint32_t expectedRevision);

    // Prototype v1 wire format, bound to exact immutable encounter metadata.
    // This is not a native RTW save. Decode stages a new owned session and
    // never changes a live one on failure. Browser clock/pause remain host state.
    static constexpr std::size_t save_max_bytes = 32 * 1024 * 1024;
    std::vector<std::uint8_t> encode_save(std::string_view identity,
                                          std::uint32_t expectedRevision) const;
    static BattleSession decode_save(const BattleEncounter& expectedEncounter,
                                      std::string_view identity,
                                      std::span<const std::uint8_t> bytes);

    static std::string_view status_name(BattleCommandStatus) noexcept;
    static std::string_view outcome_name(BattleOutcome) noexcept;
    static std::string_view order_name(BattleOrderKind) noexcept;
    static std::string_view movement_name(BattleMovementKind) noexcept;

private:
    BattleSession() = default;
    BattleOrigin origin_;
    std::vector<BattleUnit> units_;
    std::uint32_t revision_ = 0, ticks_ = 0;
    BattleOutcome outcome_ = BattleOutcome::Active;
    BattleCommandStatus guard(std::uint32_t expectedRevision) const noexcept;
    BattleCommandStatus player_guard(std::uint32_t unitId) const noexcept;
    BattleCommandResult result(BattleCommandStatus, std::uint32_t advanced = 0) const noexcept;
    void tick();
};

} // namespace openrtw
