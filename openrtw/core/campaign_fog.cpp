#include "campaign_fog.hpp"

#include "campaign.hpp"
#include "categories.hpp"

#include <algorithm>
#include <bit>
#include <cfenv>
#include <cmath>
#include <limits>
#include <stdexcept>
#include <string_view>

namespace openrtw {
namespace {
static_assert(sizeof(float) == 4 && std::numeric_limits<float>::is_iec559);
static_assert(sizeof(double) == 8 && std::numeric_limits<double>::is_iec559);
// Portable admission limits, not native game limits. Float inputs are bounded
// so the x87 expression's additions can be evaluated in binary64 then stored
// at the observed binary32 spill. No fast-math/reassociation is supported.
constexpr float maxMagnitude = 16777216.0f;
constexpr std::uint64_t maxCells = 16 * 1024 * 1024;
constexpr std::uint64_t maxTableBytes = 64 * 1024 * 1024;
constexpr std::uint64_t maxFootprintEntries = 16 * 1024 * 1024;
constexpr std::uint32_t maxObservers = 65536;

[[noreturn]] void fail(const char* reason) {
    throw std::runtime_error(reason);
}
bool valid_float(float x) noexcept {
    // This lattice bounds the full height/eye/bonus sum to <48 significant
    // bits. Both binary64 and x87 53/64-bit intermediates are then exact,
    // including cancellation; only the recovered final float spill rounds.
    const double scaled = static_cast<double>(x) * 1048576.0;
    return std::isfinite(x) && std::abs(x) <= maxMagnitude && scaled == std::trunc(scaled);
}
std::size_t cell_count(const CampaignFogTerrain& terrain) {
    const auto count = std::uint64_t{terrain.width} * terrain.height;
    if (!terrain.width || !terrain.height || terrain.width > 8191 || terrain.height > 8191 ||
        count > maxCells || count != terrain.cells.size())
        fail("Invalid campaign fog terrain extent");
    for (const auto& cell : terrain.cells)
        if (!valid_float(cell.height) || cell.category > 14)
            fail("Invalid campaign fog terrain cell");
    return static_cast<std::size_t>(count);
}
std::uint32_t distance2(const CampaignFogObserver& observer, std::int32_t x,
                        std::int32_t y) noexcept {
    const auto dx = x - observer.x, dy = y - observer.y;
    return static_cast<std::uint32_t>(dx * dx + dy * dy);
}
CampaignFogCharacter character_type(std::string_view name) {
    if (name == "spy")
        return CampaignFogCharacter::spy;
    if (name == "assassin")
        return CampaignFogCharacter::assassin;
    if (name == "diplomat")
        return CampaignFogCharacter::diplomat;
    if (name == "admiral")
        return CampaignFogCharacter::admiral;
    if (name == "general")
        return CampaignFogCharacter::general;
    if (name == "named character" || name == "family")
        return CampaignFogCharacter::namedCharacter;
    fail("Unknown campaign fog character type");
}
void accepted(CampaignFogStatus status) {
    if (status != CampaignFogStatus::Ok)
        fail("Initial campaign fog observer/exploration refused");
}
} // namespace

CampaignFogTerrain build_campaign_fog_terrain(const Terrain& heights,
                                              const CategoryGrid& categories,
                                              std::span<const std::uint32_t> flags) {
    const auto count = std::uint64_t{categories.width} * categories.height;
    if (!categories.width || !categories.height || categories.width > 8191 ||
        categories.height > 8191 || count > maxCells || count != categories.categories.size() ||
        count != flags.size() || heights.width != 2 * categories.width + 1 ||
        heights.height != 2 * categories.height + 1 ||
        heights.heightBits.size() != std::uint64_t{heights.width} * heights.height)
        fail("Campaign fog height/category/flag extents disagree");
    CampaignFogTerrain result{categories.width, categories.height, {}};
    result.cells.resize(static_cast<std::size_t>(count));
    for (std::uint32_t y = 0; y < result.height; ++y)
        for (std::uint32_t x = 0; x < result.width; ++x) {
            const auto i = std::size_t{y} * result.width + x;
            result.cells[i] = {
                std::bit_cast<float>(
                    heights.heightBits[std::size_t{2 * y + 1} * heights.width + 2 * x + 1]),
                categories.categories[i], flags[i]};
        }
    cell_count(result);
    return result;
}

std::uint32_t campaign_fog_character_radius(CampaignFogCharacter type,
                                            std::int32_t lineOfSight) noexcept {
    std::uint32_t base = 3;
    if (type == CampaignFogCharacter::spy)
        base = 11;
    else if (type == CampaignFogCharacter::admiral)
        base = 7;
    else if (type == CampaignFogCharacter::general || type == CampaignFogCharacter::namedCharacter)
        base = 6;
    return std::clamp(base + static_cast<std::uint32_t>(lineOfSight), 2u, 10u);
}

CampaignFog CampaignFog::create(const CampaignFogTerrain& terrain,
                                std::span<const std::uint32_t> factionTables,
                                std::uint32_t observerCapacity, std::uint32_t maxRadius) {
    const auto count = cell_count(terrain);
    if (factionTables.empty() || factionTables.size() > 256 ||
        maxRadius > campaign_fog_max_radius || observerCapacity > maxObservers)
        fail("Campaign fog configuration exceeds supported limits");
    std::uint32_t tableCount = 0;
    for (const auto table : factionTables) {
        if (table >= factionTables.size())
            fail("Invalid campaign fog table alias");
        tableCount = std::max(tableCount, table + 1);
    }
    for (std::uint32_t t = 0; t < tableCount; ++t)
        if (std::find(factionTables.begin(), factionTables.end(), t) == factionTables.end())
            fail("Campaign fog table aliases must be dense");
    const auto stride = std::size_t{2 * maxRadius + 1} * (2 * maxRadius + 1);
    if (std::uint64_t{tableCount} * count > maxTableBytes ||
        std::uint64_t{observerCapacity} * stride > maxFootprintEntries)
        fail("Campaign fog storage budget exceeded");
    CampaignFog result;
    result.terrain_ = terrain;
    result.factionTables_.assign(factionTables.begin(), factionTables.end());
    result.cells_.resize(tableCount * count);
    result.slots_.resize(observerCapacity);
    result.footprints_.resize(observerCapacity * stride);
    result.targets_.resize(stride);
    result.traced_.resize(stride);
    result.marks_.resize(count);
    result.changes_.resize(2 * stride);
    result.stride_ = stride;
    result.maxRadius_ = maxRadius;
    return result;
}

std::span<const std::uint8_t> CampaignFog::table(std::uint32_t faction) const noexcept {
    if (faction >= factionTables_.size())
        return {};
    return {cells_.data() + factionTables_[faction] * terrain_.cells.size(), terrain_.cells.size()};
}
std::uint8_t CampaignFog::at(std::uint32_t faction, std::int32_t x, std::int32_t y) const noexcept {
    if (x < 0 || y < 0 || static_cast<std::uint32_t>(x) >= width() ||
        static_cast<std::uint32_t>(y) >= height() || faction >= factionTables_.size())
        return 0;
    return table(faction)[std::size_t{static_cast<std::uint32_t>(y)} * width() + x];
}
std::span<const std::uint32_t> CampaignFog::footprint(std::uint32_t id) const noexcept {
    if (id >= slots_.size() || !slots_[id].active)
        return {};
    return {footprints_.data() + id * stride_, slots_[id].count};
}
const CampaignFogObserver* CampaignFog::observer(std::uint32_t id) const noexcept {
    return id < slots_.size() && slots_[id].active ? &slots_[id].observer : nullptr;
}
std::span<const CampaignFogChange> CampaignFog::changes() const noexcept {
    return {changes_.data(), changeCount_};
}

CampaignFogStatus CampaignFog::validate(std::uint32_t id, std::uint32_t faction,
                                        const CampaignFogObserver& o) const noexcept {
    if (id >= slots_.size())
        return CampaignFogStatus::InvalidObserver;
    if (faction >= factionTables_.size())
        return CampaignFogStatus::InvalidFaction;
    if (o.x < 0 || o.y < 0 || static_cast<std::uint32_t>(o.x) >= width() ||
        static_cast<std::uint32_t>(o.y) >= height())
        return CampaignFogStatus::InvalidPosition;
    if (o.radius > maxRadius_)
        return CampaignFogStatus::InvalidRadius;
    if (!valid_float(o.eye))
        return CampaignFogStatus::InvalidEye;
    if (std::fegetround() != FE_TONEAREST)
        return CampaignFogStatus::UnsupportedRounding;
    return CampaignFogStatus::Ok;
}

bool CampaignFog::step(const CampaignFogObserver& o, std::int32_t x, std::int32_t y) noexcept {
    // The recovered loops bound the major axis. This extra guard admits no
    // out-of-map memory access even if a future floating profile differs.
    if (x < 0 || y < 0 || static_cast<std::uint32_t>(x) >= width() ||
        static_cast<std::uint32_t>(y) >= height())
        return false;
    const auto d2 = distance2(o, x, y);
    if (d2 > o.radius * o.radius)
        return false;
    const auto i = static_cast<std::uint32_t>(y) * width() + x;
    if (!marks_[i]) {
        marks_[i] = 1;
        traced_[tracedCount_++] = i;
    }
    if (!d2 || o.eye == -1.0f)
        return true;
    const auto& target = terrain_.cells[i];
    const auto source = terrain_.cells[static_cast<std::uint32_t>(o.y) * width() + o.x].height;
    // 495ED4..495EE9: ONE float store after the complete x87 expression.
    // The admitted height/eye lattice makes every addition exact in binary64.
    const auto delta = static_cast<float>(
        static_cast<double>(target.height) - o.eye + (target.category == 8 ? 390.0 : 0.0) +
        (target.category == 7 ? 470.0 : 0.0) + ((target.flags & 0x800) ? 700.0 : 0.0) +
        ((target.flags & 0x18000) ? 320.0 : 0.0) - source);
    return delta <= 600.0f;
}

void CampaignFog::cast(const CampaignFogObserver& o, std::size_t targetCount) noexcept {
    for (std::size_t t = 0; t < targetCount; ++t) {
        const auto tx = static_cast<std::int32_t>(targets_[t] % width());
        const auto ty = static_cast<std::int32_t>(targets_[t] / width());
        const auto dx = tx - o.x, dy = ty - o.y;
        if (!dx && !dy)
            return; // Return from this entire cast, not continue.
        const float slope = !dy   ? 0.0f
                            : !dx ? 1.0f
                                  : static_cast<float>(static_cast<double>(dy) / dx);
        if (std::abs(slope) >= 1.0f) {
            float xf = static_cast<float>(o.x);
            const auto direction = dy <= 0 ? -1 : 1;
            for (auto y = o.y; direction < 0 ? y >= ty : y <= ty; y += direction) {
                // All four native conversions set CW |= 0xC00 before FRNDINT:
                // truncate toward zero. Hex-Rays' printed rint is misleading.
                if (!step(o, static_cast<std::int32_t>(xf), y))
                    break;
                if (dx)
                    xf = static_cast<float>(static_cast<double>(xf) +
                                            direction / static_cast<double>(slope));
            }
        } else {
            float yf = static_cast<float>(o.y);
            const auto direction = dx <= 0 ? -1 : 1;
            for (auto x = o.x; direction < 0 ? x >= tx : x <= tx; x += direction) {
                if (!step(o, x, static_cast<std::int32_t>(yf)))
                    break;
                yf = static_cast<float>(static_cast<double>(yf) +
                                        direction * static_cast<double>(slope));
            }
        }
    }
}

void CampaignFog::trace(const CampaignFogObserver& o) noexcept {
    tracedCount_ = 0;
    const auto r = static_cast<std::int32_t>(o.radius);
    const auto side = 2 * r + 1;
    const auto x0 = std::clamp(o.x - r, 0, static_cast<std::int32_t>(width()) - 1);
    const auto y0 = std::clamp(o.y + r, 0, static_cast<std::int32_t>(height()) - 1);
    // Build/filter each complete target list BEFORE casting it. Filtering
    // interior cells dynamically while casting would change early-return order.
    for (int pass = 0; pass < 2; ++pass) {
        std::size_t count = 0;
        for (int i = 0; i < side; ++i)
            for (int j = 0; j < side; ++j) {
                const bool perimeter = i == 0 || j == 0 || i == side - 1 || j == side - 1;
                if (perimeter != (pass == 0))
                    continue;
                const auto x = std::min(x0 + i, static_cast<std::int32_t>(width()) - 1);
                const auto y = std::max(y0 - j, 0);
                const auto cell = static_cast<std::uint32_t>(y) * width() + x;
                if (pass == 1 && distance2(o, x, y) <= o.radius * o.radius && marks_[cell])
                    continue;
                targets_[count++] = cell;
            }
        cast(o, count);
    }
    std::sort(traced_.begin(), traced_.begin() + tracedCount_);
}
void CampaignFog::clear_marks() noexcept {
    for (std::size_t i = 0; i < tracedCount_; ++i)
        marks_[traced_[i]] = 0;
    tracedCount_ = 0;
}

CampaignFogStatus CampaignFog::set_observer(std::uint32_t id, std::uint32_t faction,
                                            CampaignFogObserver o) noexcept {
    changeCount_ = 0;
    const auto status = validate(id, faction, o);
    if (status != CampaignFogStatus::Ok)
        return status;
    auto& slot = slots_[id];
    if (slot.active && slot.faction == faction && slot.observer == o)
        return CampaignFogStatus::Ok;
    trace(o);
    const auto old = footprint(id);
    const auto tableId = factionTables_[faction];
    const auto sameTable = slot.active && factionTables_[slot.faction] == tableId;
    const auto base = tableId * terrain_.cells.size();
    // Preflight ALL additions, accounting for a removed overlapping contribution.
    for (std::size_t i = 0; i < tracedCount_; ++i) {
        const auto cell = traced_[i];
        if (cells_[base + cell] == campaign_fog_max_cell &&
            !(sameTable && std::binary_search(old.begin(), old.end(), cell))) {
            clear_marks();
            return CampaignFogStatus::CounterOverflow;
        }
    }
    const auto change = [&](std::uint32_t table, std::uint32_t cell, bool add) {
        auto& b = cells_[table * terrain_.cells.size() + cell];
        const auto after = static_cast<std::uint8_t>(add ? (b < 2 ? 2 : b + 1) : b - 1);
        changes_[changeCount_++] = {table, cell, b, after};
        b = after;
    };
    // The marks still describe the new footprint; omit overlapping cells so
    // consumers never see a fictitious visibility loss during an atomic update.
    if (slot.active)
        for (auto cell : old)
            if (!sameTable || !marks_[cell])
                change(factionTables_[slot.faction], cell, false);
    for (std::size_t i = 0; i < tracedCount_; ++i)
        if (!sameTable || !std::binary_search(old.begin(), old.end(), traced_[i]))
            change(tableId, traced_[i], true);
    slot = {o, faction, static_cast<std::uint32_t>(tracedCount_), true};
    std::copy_n(traced_.begin(), tracedCount_, footprints_.begin() + id * stride_);
    clear_marks();
    return CampaignFogStatus::Ok;
}

CampaignFogStatus CampaignFog::remove_observer(std::uint32_t id) noexcept {
    changeCount_ = 0;
    if (id >= slots_.size())
        return CampaignFogStatus::InvalidObserver;
    if (!slots_[id].active)
        return CampaignFogStatus::MissingObserver;
    const auto tableId = factionTables_[slots_[id].faction];
    for (const auto cell : footprint(id)) {
        auto& value = cells_[tableId * terrain_.cells.size() + cell];
        changes_[changeCount_++] = {tableId, cell, value, static_cast<std::uint8_t>(value - 1)};
        --value;
    }
    slots_[id] = {};
    return CampaignFogStatus::Ok;
}

CampaignFogStatus CampaignFog::explore(std::uint32_t faction,
                                       std::span<const std::uint32_t> cells) noexcept {
    changeCount_ = 0;
    if (faction >= factionTables_.size())
        return CampaignFogStatus::InvalidFaction;
    for (const auto cell : cells)
        if (cell >= terrain_.cells.size())
            return CampaignFogStatus::InvalidCell;
    const auto base = factionTables_[faction] * terrain_.cells.size();
    for (const auto cell : cells)
        cells_[base + cell] = std::max<std::uint8_t>(cells_[base + cell], 1);
    return CampaignFogStatus::Ok;
}
CampaignFogSnapshot CampaignFog::snapshot() const {
    CampaignFogSnapshot result{width(),        height(), maxRadius_, observer_capacity(),
                               factionTables_, cells_,   {}};
    for (std::uint32_t id = 0; id < slots_.size(); ++id)
        if (slots_[id].active) {
            const auto fp = footprint(id);
            result.observers.push_back(
                {id, slots_[id].faction, slots_[id].observer, {fp.begin(), fp.end()}});
        }
    return result;
}
CampaignFog CampaignFog::restore(const CampaignFogTerrain& terrain,
                                 std::span<const std::uint32_t> expectedFactionTables,
                                 const CampaignFogSnapshot& saved) {
    if (saved.width != terrain.width || saved.height != terrain.height ||
        !std::equal(saved.factionTables.begin(), saved.factionTables.end(),
                    expectedFactionTables.begin(), expectedFactionTables.end()) ||
        saved.observers.size() > saved.observerCapacity)
        fail("Campaign fog snapshot binding mismatch");
    auto result = create(terrain, expectedFactionTables, saved.observerCapacity, saved.maxRadius);
    if (saved.cells.size() != result.cells_.size())
        fail("Invalid campaign fog snapshot table length");
    for (const auto& item : saved.observers) {
        if (result.observer(item.id))
            fail("Duplicate campaign fog snapshot observer");
        accepted(result.set_observer(item.id, item.faction, item.observer));
        const auto fp = result.footprint(item.id);
        if (!std::equal(fp.begin(), fp.end(), item.footprint.begin(), item.footprint.end()))
            fail("Campaign fog snapshot footprint does not match terrain/observer");
    }
    for (std::size_t i = 0; i < saved.cells.size(); ++i)
        if (result.cells_[i] >= 2 ? saved.cells[i] != result.cells_[i] : saved.cells[i] > 1)
            fail("Campaign fog snapshot counters do not match observers");
    result.cells_ = saved.cells;
    result.changeCount_ = 0;
    return result;
}

CampaignFog project_initial_campaign_fog(const Campaign& campaign,
                                         const CampaignFogTerrain& terrain,
                                         std::span<const std::uint32_t> factionTables,
                                         std::span<const std::int32_t> lineOfSight,
                                         std::span<const CampaignFogInitialStructure> structures,
                                         std::span<const std::uint32_t> landmarkCells,
                                         std::uint32_t extraObserverSlots) {
    std::uint64_t characterCount = 0;
    for (const auto& faction : campaign.factions)
        characterCount += faction.characters.size();
    const auto capacity = characterCount + structures.size() + extraObserverSlots;
    if (characterCount != lineOfSight.size() || factionTables.size() != campaign.factions.size() ||
        capacity > maxObservers)
        fail("Initial campaign fog input/slot count mismatch");
    auto result = CampaignFog::create(terrain, factionTables, static_cast<std::uint32_t>(capacity));
    std::uint32_t id = 0;
    for (std::uint32_t f = 0; f < campaign.factions.size(); ++f)
        for (const auto& character : campaign.factions[f].characters) {
            const auto radius =
                campaign_fog_character_radius(character_type(character.type), lineOfSight[id]);
            accepted(result.set_observer(id++, f, {character.x, character.y, radius, 0}));
        }
    for (const auto& structure : structures) {
        CampaignFogObserver observer{structure.x, structure.y, 0, 0};
        switch (structure.kind) {
        case CampaignFogStructureKind::settlement:
            if (structure.level < 0 || structure.level > 5)
                fail("Invalid fog settlement level");
            observer.radius = 4 + structure.level;
            observer.eye = -1;
            break;
        case CampaignFogStructureKind::fort:
            observer.radius = 2;
            break;
        case CampaignFogStructureKind::port:
            if (structure.level < 0 || structure.level > 3)
                fail("Invalid fog port level");
            observer.radius = 2 * structure.level + 3;
            break;
        case CampaignFogStructureKind::watchtower:
            observer.radius = 10;
            observer.eye = 480;
            break;
        default:
            fail("Invalid campaign fog structure kind");
        }
        if (structure.kind != CampaignFogStructureKind::settlement &&
            !structure.regionCells.empty())
            fail("Only fog settlements explore a region");
        accepted(result.set_observer(id++, structure.faction, observer));
        accepted(result.explore(structure.faction, structure.regionCells));
    }
    for (std::uint32_t faction = 0; faction < factionTables.size(); ++faction)
        accepted(result.explore(faction, landmarkCells));
    return result;
}
} // namespace openrtw
