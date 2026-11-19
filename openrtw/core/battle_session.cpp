#include "battle_session.hpp"

#include <algorithm>
#include <array>
#include <bit>
#include <cstdlib>
#include <limits>
#include <stdexcept>
#include <type_traits>
#include <utility>

namespace openrtw {
static_assert(std::is_nothrow_move_assignable_v<BattleSession>,
              "battle publication must not allocate or throw");
namespace {
constexpr std::size_t cells = battle_session_width * battle_session_height;
constexpr std::array<BattlePoint, 4> neighbours{{{1, 0}, {0, 1}, {-1, 0}, {0, -1}}};

bool same(BattlePoint a, BattlePoint b) noexcept {
    return a.x == b.x && a.y == b.y;
}
bool inside(BattlePoint p) noexcept {
    return p.x >= 0 && p.y >= 0 && p.x < std::int32_t{battle_session_width} &&
           p.y < std::int32_t{battle_session_height};
}
std::uint32_t distance(BattlePoint a, BattlePoint b) noexcept {
    return static_cast<std::uint32_t>(std::abs(a.x - b.x) + std::abs(a.y - b.y));
}
BattlePoint point(const BattleUnit& unit) noexcept {
    return {unit.x, unit.y};
}
std::size_t index(BattlePoint p) noexcept {
    return static_cast<std::size_t>(p.y) * battle_session_width + static_cast<std::size_t>(p.x);
}
BattlePoint cell_point(std::size_t i) noexcept {
    return {static_cast<std::int32_t>(i % battle_session_width),
            static_cast<std::int32_t>(i / battle_session_width)};
}
bool ranged(const BattleWeapon& weapon) noexcept {
    return weapon.weaponType == "missile" || weapon.weaponType == "thrown" ||
           weapon.weaponType == "siege_missile";
}
const BattleWeapon& weapon(const BattleUnit& unit) noexcept {
    if (!ranged(unit.profile.primary) || unit.ammunition != 0)
        return unit.profile.primary;
    return unit.profile.secondary;
}
std::uint32_t range(const BattleUnit& unit) noexcept {
    if (ranged(unit.profile.primary) && unit.ammunition != 0) {
        const auto metres = std::uint64_t{unit.profile.primary.rangeMeters};
        return static_cast<std::uint32_t>(std::max<std::uint64_t>(1, (metres + 4) / 5));
    }
    return 1;
}
std::uint32_t movement_interval(BattleMovementKind kind) noexcept {
    if (kind == BattleMovementKind::Cavalry)
        return 5;
    if (kind == BattleMovementKind::Siege)
        return 20;
    return 10;
}
// Fixed grid/queue storage: at most3072 visited cells per formation per tick.
// Earlier stable-ID moves occupy their new cells; swaps/overlap are refused.
std::optional<BattlePoint> next_cell(const std::vector<BattleUnit>& units, const BattleUnit& actor,
                                     BattlePoint goal, std::uint32_t stopRange) {
    std::array<bool, cells> occupied{};
    for (const auto& unit : units)
        if (unit.hitPoints != 0 && unit.id != actor.id)
            occupied[index(point(unit))] = true;
    std::array<std::int32_t, cells> parent;
    parent.fill(-1);
    std::array<std::size_t, cells> queue{};
    const auto start = index(point(actor));
    parent[start] = static_cast<std::int32_t>(start);
    queue[0] = start;
    std::size_t head = 0, tail = 1;
    while (head != tail) {
        const auto current = queue[head++];
        const auto p = cell_point(current);
        if (distance(p, goal) <= stopRange) {
            auto found = current;
            if (found == start)
                return std::nullopt;
            while (parent[found] != static_cast<std::int32_t>(start))
                found = static_cast<std::size_t>(parent[found]);
            return cell_point(found);
        }
        for (const auto delta : neighbours) {
            const BattlePoint next{p.x + delta.x, p.y + delta.y};
            if (!inside(next))
                continue;
            const auto n = index(next);
            if (parent[n] != -1 || occupied[n])
                continue;
            parent[n] = static_cast<std::int32_t>(current);
            queue[tail++] = n;
        }
    }
    return std::nullopt;
}

std::optional<std::uint32_t>
nearest(const std::vector<BattleUnit>& units, const BattleUnit& actor,
        std::uint32_t maxRange = std::numeric_limits<std::uint32_t>::max()) {
    std::optional<std::uint32_t> selected;
    auto best = std::numeric_limits<std::uint32_t>::max();
    for (const auto& other : units) {
        if (other.team == actor.team || other.hitPoints == 0)
            continue;
        const auto d = distance(point(actor), point(other));
        if (d <= maxRange && (!selected || d < best)) {
            selected = other.id;
            best = d;
        }
    }
    return selected; // Equal distances keep the first stable ID.
}

} // namespace

std::uint32_t BattleUnit::living_soldiers() const noexcept {
    if (hitPoints == 0 || profile.manHitPoints == 0)
        return 0;
    return static_cast<std::uint32_t>(1 + (hitPoints - 1) / profile.manHitPoints);
}

BattleSession BattleSession::create(const BattleEncounter& encounter) {
    validate_battle_encounter(encounter);
    BattleSession result;
    result.origin_ = encounter.origin;
    result.units_.reserve(2 * battle_session_max_team_units);
    for (std::size_t side = 0; side < encounter.armies.size(); ++side) {
        const auto& origin = side == 0 ? encounter.origin.player : encounter.origin.opponent;
        const auto& actor = origin.actor;
        const auto& army = encounter.armies[side];
        for (std::size_t i = 0; i < army.size(); ++i) {
            const auto& row = army[i];
            const auto admitted = inspect_battle_formation(row);
            BattleUnit unit;
            unit.profile = row.profile;
            unit.movementKind = admitted.movementKind;
            unit.usesExplicitSourceCount = admitted.explicitSourceCount;
            unit.id = static_cast<std::uint32_t>(result.units_.size());
            unit.team = side == 0 ? BattleTeam::Player : BattleTeam::Opponent;
            unit.sourceActorId = actor.id;
            unit.sourceFactionIndex = actor.sourceFactionIndex;
            unit.sourceCharacterIndex = actor.sourceCharacterIndex;
            unit.sourceArmyIndex = i;
            unit.sourceLine = row.sourceUnit.line;
            unit.sourceUnit = row.sourceUnit;
            unit.initialSoldiers = admitted.soldiers;
            unit.maxHitPoints = std::uint64_t{admitted.soldiers} * unit.profile.manHitPoints;
            unit.hitPoints = unit.maxHitPoints;
            unit.x = side == 0 ? 6 : 57;
            unit.y = army.size() == 1
                         ? 23
                         : 1 + static_cast<std::int32_t>(i * 45 / (army.size() - 1));
            unit.ammunition = ranged(unit.profile.primary) ? unit.profile.primary.ammunition : 0;
            result.units_.push_back(std::move(unit));
        }
    }
    return result;
}

BattleCommandStatus BattleSession::guard(std::uint32_t expected) const noexcept {
    if (expected != revision_)
        return BattleCommandStatus::StaleRevision;
    if (outcome_ != BattleOutcome::Active)
        return BattleCommandStatus::Finished;
    if (revision_ == std::numeric_limits<std::uint32_t>::max())
        return BattleCommandStatus::RevisionOverflow;
    return BattleCommandStatus::Applied;
}
BattleCommandStatus BattleSession::player_guard(std::uint32_t id) const noexcept {
    if (id >= units_.size() || units_[id].hitPoints == 0)
        return BattleCommandStatus::InvalidUnit;
    if (units_[id].team != BattleTeam::Player)
        return BattleCommandStatus::NotPlayerUnit;
    return BattleCommandStatus::Applied;
}
BattleCommandResult BattleSession::result(BattleCommandStatus status,
                                          std::uint32_t advanced) const noexcept {
    return {status, revision_, advanced};
}

BattleCommandResult BattleSession::move(std::uint32_t id, std::int32_t x, std::int32_t y,
                                        std::uint32_t expected) {
    auto status = guard(expected);
    if (status == BattleCommandStatus::Applied)
        status = player_guard(id);
    if (status != BattleCommandStatus::Applied)
        return result(status);
    const BattlePoint target{x, y};
    if (!inside(target))
        return result(BattleCommandStatus::OutOfBounds);
    const auto& unit = units_[id];
    if (same(target, point(unit)) || (unit.order == BattleOrderKind::Move && unit.destination &&
                                      same(*unit.destination, target)))
        return result(BattleCommandStatus::NoOp);
    for (const auto& other : units_)
        if (other.id != id && other.hitPoints && same(point(other), target))
            return result(BattleCommandStatus::Occupied);
    auto staged = *this;
    auto& changed = staged.units_[id];
    changed.order = BattleOrderKind::Move;
    changed.destination = target;
    changed.targetId.reset();
    ++staged.revision_;
    *this = std::move(staged);
    return result(BattleCommandStatus::Applied);
}
BattleCommandResult BattleSession::attack(std::uint32_t id, std::uint32_t target,
                                          std::uint32_t expected) {
    auto status = guard(expected);
    if (status == BattleCommandStatus::Applied)
        status = player_guard(id);
    if (status != BattleCommandStatus::Applied)
        return result(status);
    if (target >= units_.size() || units_[target].hitPoints == 0 ||
        units_[target].team == units_[id].team)
        return result(BattleCommandStatus::InvalidTarget);
    if (units_[id].order == BattleOrderKind::Attack && units_[id].targetId == target)
        return result(BattleCommandStatus::NoOp);
    auto staged = *this;
    staged.units_[id].order = BattleOrderKind::Attack;
    staged.units_[id].targetId = target;
    staged.units_[id].destination.reset();
    ++staged.revision_;
    *this = std::move(staged);
    return result(BattleCommandStatus::Applied);
}
BattleCommandResult BattleSession::hold(std::uint32_t id, std::uint32_t expected) {
    auto status = guard(expected);
    if (status == BattleCommandStatus::Applied)
        status = player_guard(id);
    if (status != BattleCommandStatus::Applied)
        return result(status);
    if (units_[id].order == BattleOrderKind::Hold)
        return result(BattleCommandStatus::NoOp);
    auto staged = *this;
    auto& unit = staged.units_[id];
    unit.order = BattleOrderKind::Hold;
    unit.destination.reset();
    unit.targetId.reset();
    ++staged.revision_;
    *this = std::move(staged);
    return result(BattleCommandStatus::Applied);
}

void BattleSession::tick() {
    // Phase1: elapsed cooldown/movement credit and opponent targeting from the
    // same pre-movement state. Idle/blocked movement credit caps at one step.
    for (auto& unit : units_) {
        if (!unit.hitPoints)
            continue;
        if (unit.cooldownTicks)
            --unit.cooldownTicks;
        unit.movementTicks = std::min(unit.movementTicks + 1, movement_interval(unit.movementKind));
        if (unit.team == BattleTeam::Opponent) {
            unit.targetId = nearest(units_, unit);
            unit.destination.reset();
            unit.order = unit.targetId ? BattleOrderKind::Attack : BattleOrderKind::Hold;
        } else if (unit.order == BattleOrderKind::Attack &&
                   (!unit.targetId || !units_[*unit.targetId].hitPoints)) {
            unit.targetId.reset();
            unit.order = BattleOrderKind::Hold;
        }
    }
    // Phase2: stable-ID cardinal moves, with occupancy updated after each.
    for (auto& unit : units_) {
        if (!unit.hitPoints || unit.movementTicks < movement_interval(unit.movementKind))
            continue;
        std::optional<BattlePoint> goal;
        std::uint32_t stopRange = 0;
        if (unit.order == BattleOrderKind::Move)
            goal = unit.destination;
        else if (unit.order == BattleOrderKind::Attack && unit.targetId) {
            goal = point(units_[*unit.targetId]);
            stopRange = range(unit);
        }
        if (!goal)
            continue;
        if (const auto next = next_cell(units_, unit, *goal, stopRange)) {
            unit.x = next->x;
            unit.y = next->y;
            unit.movementTicks = 0;
        }
        if (unit.order == BattleOrderKind::Move && same(point(unit), *goal)) {
            unit.order = BattleOrderKind::Hold;
            unit.destination.reset();
        }
    }
    // Phase3: all currently living formations plan damage before any casualty
    // is applied. One discharge consumes one ammo, even if damage is lethal.
    std::array<std::uint64_t, 2 * battle_session_max_team_units> damage{};
    for (auto& unit : units_) {
        if (!unit.hitPoints || unit.cooldownTicks || unit.order == BattleOrderKind::Move)
            continue;
        const auto target = unit.order == BattleOrderKind::Hold ? nearest(units_, unit, range(unit))
                                                                : unit.targetId;
        if (!target || !units_[*target].hitPoints ||
            distance(point(unit), point(units_[*target])) > range(unit))
            continue;
        const auto& defender = units_[*target];
        const auto& w = weapon(unit);
        const auto denominator = std::uint64_t{defender.profile.armour} +
                                 defender.profile.defenceSkill + defender.profile.shield + 10;
        const auto numerator = (std::uint64_t{w.attack} + 1) * unit.living_soldiers();
        const auto amount = std::max<std::uint64_t>(1, numerator / denominator);
        damage[*target] += amount;
        unit.cooldownTicks = std::max<std::uint32_t>(1, w.delayTenths);
        if (ranged(unit.profile.primary) && unit.ammunition)
            --unit.ammunition;
    }
    bool player = false, opponent = false;
    for (auto& unit : units_) {
        unit.hitPoints -= std::min(unit.hitPoints, damage[unit.id]);
        if (!unit.hitPoints) {
            unit.order = BattleOrderKind::Hold;
            unit.destination.reset();
            unit.targetId.reset();
            unit.cooldownTicks = 0;
            unit.movementTicks = 0;
        } else if (unit.team == BattleTeam::Player)
            player = true;
        else
            opponent = true;
    }
    ++ticks_;
    ++revision_;
    if (!player && !opponent)
        outcome_ = BattleOutcome::Draw;
    else if (!player)
        outcome_ = BattleOutcome::OpponentVictory;
    else if (!opponent)
        outcome_ = BattleOutcome::PlayerVictory;
    else if (ticks_ == battle_session_max_ticks)
        outcome_ = BattleOutcome::Draw;
}

BattleCommandResult BattleSession::step(std::uint32_t count, std::uint32_t expected) {
    const auto status = guard(expected);
    if (status != BattleCommandStatus::Applied)
        return result(status);
    if (count == 0 || count > battle_session_max_step_ticks)
        return result(BattleCommandStatus::InvalidTicks);
    const auto admitted = std::min(count, battle_session_max_ticks - ticks_);
    if (admitted > std::numeric_limits<std::uint32_t>::max() - revision_)
        return result(BattleCommandStatus::RevisionOverflow);
    auto staged = *this;
    std::uint32_t advanced = 0;
    while (advanced != admitted && staged.outcome_ == BattleOutcome::Active) {
        staged.tick();
        ++advanced;
    }
    *this = std::move(staged);
    return result(BattleCommandStatus::Applied, advanced);
}
BattleCommandResult BattleSession::retreat(std::uint32_t expected) {
    const auto status = guard(expected);
    if (status != BattleCommandStatus::Applied)
        return result(status);
    auto staged = *this;
    staged.outcome_ = BattleOutcome::Retreated;
    ++staged.revision_;
    *this = std::move(staged);
    return result(BattleCommandStatus::Applied);
}

std::string_view BattleSession::status_name(BattleCommandStatus value) noexcept {
    switch (value) {
    case BattleCommandStatus::Applied:
        return "applied";
    case BattleCommandStatus::StaleRevision:
        return "stale_revision";
    case BattleCommandStatus::InvalidUnit:
        return "invalid_unit";
    case BattleCommandStatus::NotPlayerUnit:
        return "not_player_unit";
    case BattleCommandStatus::OutOfBounds:
        return "out_of_bounds";
    case BattleCommandStatus::Occupied:
        return "occupied";
    case BattleCommandStatus::InvalidTarget:
        return "invalid_target";
    case BattleCommandStatus::NoOp:
        return "no_op";
    case BattleCommandStatus::InvalidTicks:
        return "invalid_ticks";
    case BattleCommandStatus::Finished:
        return "finished";
    case BattleCommandStatus::RevisionOverflow:
        return "revision_overflow";
    }
    return "unknown";
}
std::string_view BattleSession::outcome_name(BattleOutcome value) noexcept {
    switch (value) {
    case BattleOutcome::Active:
        return "active";
    case BattleOutcome::PlayerVictory:
        return "player_victory";
    case BattleOutcome::OpponentVictory:
        return "opponent_victory";
    case BattleOutcome::Draw:
        return "draw";
    case BattleOutcome::Retreated:
        return "retreated";
    }
    return "unknown";
}
std::string_view BattleSession::order_name(BattleOrderKind value) noexcept {
    switch (value) {
    case BattleOrderKind::Hold:
        return "hold";
    case BattleOrderKind::Move:
        return "move";
    case BattleOrderKind::Attack:
        return "attack";
    }
    return "unknown";
}
std::string_view BattleSession::movement_name(BattleMovementKind value) noexcept {
    switch (value) {
    case BattleMovementKind::Infantry:
        return "infantry";
    case BattleMovementKind::Cavalry:
        return "cavalry";
    case BattleMovementKind::Siege:
        return "siege";
    }
    return "unknown";
}
namespace {
[[noreturn]] void battle_save_error() {
    throw std::runtime_error("Invalid or incompatible battle save");
}
void save_identity(std::string_view identity) {
    if (identity.empty() || identity.size() > 4096 ||
        std::any_of(identity.begin(), identity.end(),
                    [](unsigned char c) { return c < 32 || c == 127; }))
        battle_save_error();
}
struct BattleSaveWriter {
    std::vector<std::uint8_t> bytes;
    void raw(std::span<const std::uint8_t> value) {
        if (value.size() > BattleSession::save_max_bytes - bytes.size())
            battle_save_error();
        bytes.insert(bytes.end(), value.begin(), value.end());
    }
    void u32(std::uint32_t value) {
        std::array<std::uint8_t, 4> b{};
        for (unsigned i = 0; i < 4; ++i)
            b[i] = static_cast<std::uint8_t>(value >> (8 * i));
        raw(b);
    }
    void u64(std::uint64_t value) {
        u32(static_cast<std::uint32_t>(value));
        u32(static_cast<std::uint32_t>(value >> 32));
    }
    void text(std::string_view value) {
        if (value.size() > std::numeric_limits<std::uint32_t>::max())
            battle_save_error();
        u32(static_cast<std::uint32_t>(value.size()));
        raw({reinterpret_cast<const std::uint8_t*>(value.data()), value.size()});
    }
    void optional(std::optional<std::int32_t> value) {
        u32(value.has_value());
        if (value)
            u32(std::bit_cast<std::uint32_t>(*value));
    }
    void point(std::optional<BattlePoint> value) {
        u32(value.has_value());
        if (value) {
            u32(std::bit_cast<std::uint32_t>(value->x));
            u32(std::bit_cast<std::uint32_t>(value->y));
        }
    }
};
struct BattleSaveReader {
    std::span<const std::uint8_t> bytes;
    std::size_t at = 0;
    std::span<const std::uint8_t> raw(std::size_t n) {
        if (n > bytes.size() - at)
            battle_save_error();
        auto result = bytes.subspan(at, n);
        at += n;
        return result;
    }
    std::uint32_t u32() {
        auto b = raw(4);
        std::uint32_t result = 0;
        for (unsigned i = 0; i < 4; ++i)
            result |= std::uint32_t{b[i]} << (8 * i);
        return result;
    }
    std::uint64_t u64() {
        auto low = u32();
        return std::uint64_t{low} | (std::uint64_t{u32()} << 32);
    }
    bool flag() {
        auto n = u32();
        if (n > 1)
            battle_save_error();
        return n != 0;
    }
    void text(std::string_view expected) {
        if (u32() != expected.size())
            battle_save_error();
        auto b = raw(expected.size());
        if (!std::equal(b.begin(), b.end(), reinterpret_cast<const std::uint8_t*>(expected.data())))
            battle_save_error();
    }
    std::optional<BattlePoint> point() {
        if (!flag())
            return {};
        auto x = std::bit_cast<std::int32_t>(u32()), y = std::bit_cast<std::int32_t>(u32());
        return BattlePoint{x, y};
    }
};
std::uint32_t battle_save_crc(std::span<const std::uint8_t> bytes) {
    std::uint32_t crc = 0xffffffffu;
    for (auto b : bytes) {
        crc ^= b;
        for (unsigned j = 0; j < 8; ++j)
            crc = (crc >> 1) ^ (0xedb88320u & (0u - (crc & 1)));
    }
    return ~crc;
}
void save_actor(BattleSaveWriter& w, const BattleOriginActor& origin) {
    const auto& a = origin.actor;
    w.u32(a.id);
    w.u32(a.sourceFactionIndex);
    w.u32(a.sourceCharacterIndex);
    w.u64(a.sourceLine);
    for (auto v : {a.initialX, a.initialY, a.currentX, a.currentY})
        w.u32(std::bit_cast<std::uint32_t>(v));
    w.u32(a.ap);
    w.u32(a.maxAp);
    w.point(a.destination);
    w.text(origin.name);
    w.text(origin.type);
    w.text(origin.sourceFaction);
}
void save_weapon(BattleSaveWriter& w, const BattleWeapon& p) {
    for (auto v : {p.attack, p.charge, p.rangeMeters, p.ammunition, p.delayTenths})
        w.u32(v);
    for (auto* v :
         {&p.missileType, &p.weaponType, &p.technology, &p.damageType, &p.sound, &p.opaqueTail})
        w.text(*v);
    w.u64(p.sourceLine);
}
BattleSaveWriter save_context(const BattleOrigin& origin, const std::vector<BattleUnit>& units) {
    BattleSaveWriter w;
    for (auto v : {battle_session_width, battle_session_height, battle_session_cell_metres,
                   battle_session_tick_ms, battle_session_max_step_ticks, battle_session_max_ticks})
        w.u32(v);
    w.text(origin.campaignId);
    w.u32(origin.revision);
    w.u32(origin.orderRevision);
    w.u64(origin.turn);
    w.u32(std::bit_cast<std::uint32_t>(origin.year));
    w.u32(static_cast<std::uint32_t>(origin.season));
    save_actor(w, origin.player);
    save_actor(w, origin.opponent);
    w.u32(static_cast<std::uint32_t>(units.size()));
    for (const auto& u : units) {
        w.u32(u.id);
        w.u32(static_cast<std::uint32_t>(u.team));
        w.u32(static_cast<std::uint32_t>(u.movementKind));
        w.u32(u.sourceActorId);
        w.u32(u.sourceFactionIndex);
        w.u32(u.sourceCharacterIndex);
        w.u64(u.sourceArmyIndex);
        w.u64(u.sourceLine);
        w.u32(u.usesExplicitSourceCount);
        w.u32(u.initialSoldiers);
        w.u64(u.maxHitPoints);
        w.text(u.sourceUnit.name);
        w.optional(u.sourceUnit.count);
        w.optional(u.sourceUnit.experience);
        w.optional(u.sourceUnit.armour);
        w.optional(u.sourceUnit.weapon);
        w.u64(u.sourceUnit.line);
        const auto& p = u.profile;
        for (auto* v : {&p.type, &p.model, &p.category, &p.unitClass})
            w.text(*v);
        for (auto v : {p.sourceSoldierCount, p.manHitPoints, p.mountHitPoints, p.armour,
                       p.defenceSkill, p.shield, p.formationRanks})
            w.u32(v);
        for (auto v : p.spacingMillimetres)
            w.u32(v);
        w.u32(static_cast<std::uint32_t>(p.formations.size()));
        for (const auto& v : p.formations)
            w.text(v);
        save_weapon(w, p.primary);
        save_weapon(w, p.secondary);
        w.u64(p.sourceLine);
        w.u32(static_cast<std::uint32_t>(p.fields.size()));
        for (const auto& f : p.fields) {
            w.u64(f.line);
            w.text(f.key);
            w.text(f.value);
            w.text(f.source);
        }
    }
    return w;
}
void validate_saved_battle(const std::vector<BattleUnit>& units, std::uint32_t revision,
                           std::uint32_t ticks, BattleOutcome outcome) {
    if (ticks > battle_session_max_ticks || revision < ticks ||
        static_cast<unsigned>(outcome) > static_cast<unsigned>(BattleOutcome::Retreated))
        battle_save_error();
    std::array<bool, cells> occupied{};
    bool player = false, opponent = false;
    for (const auto& u : units) {
        if (!inside(point(u)) || u.hitPoints > u.maxHitPoints ||
            u.ammunition > (ranged(u.profile.primary) ? u.profile.primary.ammunition : 0) ||
            u.cooldownTicks >
                std::max({1u, u.profile.primary.delayTenths, u.profile.secondary.delayTenths}) ||
            u.movementTicks > movement_interval(u.movementKind) ||
            static_cast<unsigned>(u.order) > static_cast<unsigned>(BattleOrderKind::Attack))
            battle_save_error();
        if (u.destination && !inside(*u.destination))
            battle_save_error();
        if (u.targetId && (*u.targetId >= units.size() || units[*u.targetId].team == u.team))
            battle_save_error();
        if ((u.order == BattleOrderKind::Hold && (u.destination || u.targetId)) ||
            (u.order == BattleOrderKind::Move && (!u.destination || u.targetId)) ||
            (u.order == BattleOrderKind::Attack && (u.destination || !u.targetId)))
            battle_save_error();
        if (!u.hitPoints) {
            if (u.order != BattleOrderKind::Hold || u.cooldownTicks || u.movementTicks)
                battle_save_error();
        } else {
            if (occupied[index(point(u))])
                battle_save_error();
            occupied[index(point(u))] = true;
            (u.team == BattleTeam::Player ? player : opponent) = true;
        }
        if (!ticks &&
            (u.hitPoints != u.maxHitPoints || u.cooldownTicks || u.movementTicks ||
             u.ammunition != (ranged(u.profile.primary) ? u.profile.primary.ammunition : 0)))
            battle_save_error();
    }
    switch (outcome) {
    case BattleOutcome::Active:
        if (!player || !opponent || ticks == battle_session_max_ticks)
            battle_save_error();
        break;
    case BattleOutcome::PlayerVictory:
        if (!player || opponent || !ticks)
            battle_save_error();
        break;
    case BattleOutcome::OpponentVictory:
        if (player || !opponent || !ticks)
            battle_save_error();
        break;
    case BattleOutcome::Draw:
        if (!ticks ||
            !((!player && !opponent) || (player && opponent && ticks == battle_session_max_ticks)))
            battle_save_error();
        break;
    case BattleOutcome::Retreated:
        if (!player || !opponent || ticks == battle_session_max_ticks || revision <= ticks)
            battle_save_error();
        break;
    }
}
} // namespace

std::vector<std::uint8_t> BattleSession::encode_save(std::string_view identity,
                                                     std::uint32_t expected) const {
    save_identity(identity);
    if (expected != revision_)
        throw std::runtime_error("Stale battle save revision");
    validate_saved_battle(units_, revision_, ticks_, outcome_);
    auto context = save_context(origin_, units_);
    BattleSaveWriter w;
    w.u32(0x5342524fu);
    w.u32(1);
    w.u32(0);
    w.text(battle_session_policy);
    w.text(identity);
    w.u32(static_cast<std::uint32_t>(context.bytes.size()));
    w.raw(context.bytes);
    w.u32(revision_);
    w.u32(ticks_);
    w.u32(static_cast<std::uint32_t>(outcome_));
    w.u32(static_cast<std::uint32_t>(units_.size()));
    for (const auto& u : units_) {
        w.u32(u.id);
        w.u64(u.hitPoints);
        w.u32(std::bit_cast<std::uint32_t>(u.x));
        w.u32(std::bit_cast<std::uint32_t>(u.y));
        w.u32(static_cast<std::uint32_t>(u.order));
        w.point(u.destination);
        w.u32(u.targetId.has_value());
        if (u.targetId)
            w.u32(*u.targetId);
        w.u32(u.ammunition);
        w.u32(u.cooldownTicks);
        w.u32(u.movementTicks);
    }
    w.u32(battle_save_crc(w.bytes));
    return std::move(w.bytes);
}
BattleSession BattleSession::decode_save(const BattleEncounter& encounter,
                                         std::string_view identity,
                                         std::span<const std::uint8_t> bytes) {
    save_identity(identity);
    if (bytes.size() < 4 || bytes.size() > save_max_bytes)
        battle_save_error();
    BattleSaveReader footer{bytes.last(4)};
    if (footer.u32() != battle_save_crc(bytes.first(bytes.size() - 4)))
        battle_save_error();
    BattleSaveReader r{bytes.first(bytes.size() - 4)};
    if (r.u32() != 0x5342524fu || r.u32() != 1 || r.u32() != 0)
        battle_save_error();
    r.text(battle_session_policy);
    r.text(identity);
    auto suppliedContext = r.raw(r.u32());
    auto next = create(encounter);
    auto expectedContext = save_context(next.origin_, next.units_);
    if (!std::equal(suppliedContext.begin(), suppliedContext.end(), expectedContext.bytes.begin(),
                    expectedContext.bytes.end()))
        battle_save_error();
    next.revision_ = r.u32();
    next.ticks_ = r.u32();
    const auto outcome = r.u32();
    if (outcome > static_cast<unsigned>(BattleOutcome::Retreated))
        battle_save_error();
    next.outcome_ = static_cast<BattleOutcome>(outcome);
    if (r.u32() != next.units_.size())
        battle_save_error();
    for (auto& u : next.units_) {
        if (r.u32() != u.id)
            battle_save_error();
        u.hitPoints = r.u64();
        u.x = std::bit_cast<std::int32_t>(r.u32());
        u.y = std::bit_cast<std::int32_t>(r.u32());
        const auto order = r.u32();
        if (order > static_cast<unsigned>(BattleOrderKind::Attack))
            battle_save_error();
        u.order = static_cast<BattleOrderKind>(order);
        u.destination = r.point();
        u.targetId.reset();
        if (r.flag())
            u.targetId = r.u32();
        u.ammunition = r.u32();
        u.cooldownTicks = r.u32();
        u.movementTicks = r.u32();
    }
    if (r.at != r.bytes.size())
        battle_save_error();
    validate_saved_battle(next.units_, next.revision_, next.ticks_, next.outcome_);
    return next;
}

} // namespace openrtw
