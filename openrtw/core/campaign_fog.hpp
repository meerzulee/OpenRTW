#pragma once

#include <cstddef>
#include <cstdint>
#include <span>
#include <vector>

namespace openrtw {

struct Campaign;
struct Terrain;
struct CategoryGrid;

// Native cell+16/category, cell+28/flags and the UNFLATTENED centre height
// at (2*x+1,2*y+1). All coordinates below are world rows, y northwards.
// Portable arithmetic domain: finite heights/eyes, |value|<=2^24, integral
// multiples of 2^-20 (all owned GOG HGT samples satisfy this). This makes the
// complete LOS sum exact before its recovered float store. Smaller fractions
// explicitly refuse rather than silently approximate x87 cancellation. Requires
// IEEE binary32/binary64, normal nearest/even FP environment, no fast-math.
struct CampaignFogCell {
    float height = 0;
    std::uint32_t category = 0;
    std::uint32_t flags = 0;
};
struct CampaignFogTerrain {
    std::uint32_t width = 0, height = 0;
    std::vector<CampaignFogCell> cells;
};

// Flags must be supplied for EVERY cell. In particular 0x800 and 0x18000
// affect LOS. This helper does not guess their writers from map colours.
// No borrowed input survives the call; no renderer flattening is applied.
CampaignFogTerrain build_campaign_fog_terrain(const Terrain& heights,
                                              const CategoryGrid& categories,
                                              std::span<const std::uint32_t> flags);

enum class CampaignFogCharacter : std::uint8_t {
    spy,
    assassin,
    diplomat,
    admiral,
    general,
    namedCharacter
};
// 580B5D uses unsigned addition/comparisons: negative base+effect wraps and
// selects radius 10, NOT 2. Effect is the caller's resolved LineOfSight sum.
std::uint32_t campaign_fog_character_radius(CampaignFogCharacter type,
                                            std::int32_t lineOfSight) noexcept;

struct CampaignFogObserver {
    std::int32_t x = 0, y = 0;
    std::uint32_t radius = 0;
    float eye = 0;
    friend bool operator==(const CampaignFogObserver&, const CampaignFogObserver&) = default;
};

enum class CampaignFogStatus {
    Ok,
    InvalidObserver,
    InvalidFaction,
    InvalidPosition,
    InvalidRadius,
    InvalidEye,
    InvalidCell,
    MissingObserver,
    CounterOverflow,
    UnsupportedRounding
};

// Values retain native meanings: 0 unseen, 1 remembered, 2..99 visible with
// value-1 contributors. 99 is this component's conservative admission limit,
// avoiding the original +100 temporary-mark namespace. No byte wraps.
inline constexpr std::uint8_t campaign_fog_max_cell = 99;
inline constexpr std::uint32_t campaign_fog_max_radius = 64;

struct CampaignFogChange {
    std::uint32_t table = 0, cell = 0;
    std::uint8_t before = 0, after = 0;
};
struct CampaignFogSavedObserver {
    std::uint32_t id = 0, faction = 0;
    CampaignFogObserver observer;
    // Sorted unique indices, retained so saves bind counters to contributions.
    std::vector<std::uint32_t> footprint;
    friend bool operator==(const CampaignFogSavedObserver&,
                           const CampaignFogSavedObserver&) = default;
};
struct CampaignFogSnapshot {
    std::uint32_t width = 0, height = 0, maxRadius = 0, observerCapacity = 0;
    std::vector<std::uint32_t> factionTables;
    // Table-major, then x+width*y. Includes explored history, not just positions.
    std::vector<std::uint8_t> cells;
    std::vector<CampaignFogSavedObserver> observers;
    friend bool operator==(const CampaignFogSnapshot&, const CampaignFogSnapshot&) = default;
};

class CampaignFog {
public:
    // Explicit table aliases reproduce native pointer sharing without shared
    // C++ ownership. Dense table IDs 0..N-1; each must occur. The caller resolves
    // superfactions (and chooses the actual player separately from UI filters).
    // Owns terrain, counters, observer footprints and all update scratch.
    // Deep-copyable, including scratch; copies can be staged for atomic routes.
    // Access must be serialized by the owner; atomic refusal is not thread synchronization.
    // Resource/validation refusal throws; inputs and existing objects unchanged.
    static CampaignFog create(const CampaignFogTerrain& terrain,
                              std::span<const std::uint32_t> factionTables,
                              std::uint32_t observerCapacity, std::uint32_t maxRadius = 10);

    std::uint32_t width() const noexcept { return terrain_.width; }
    std::uint32_t height() const noexcept { return terrain_.height; }
    const CampaignFogTerrain& terrain() const noexcept { return terrain_; }
    std::uint32_t observer_capacity() const noexcept { return slots_.size(); }
    std::uint32_t max_radius() const noexcept { return maxRadius_; }
    std::span<const std::uint32_t> faction_tables() const noexcept { return factionTables_; }
    // Invalid faction/cell returns empty span/0. Spans are read-only and remain
    // allocated across updates; copy assignment, move, destruction invalidate.
    std::span<const std::uint8_t> table(std::uint32_t faction) const noexcept;
    std::uint8_t at(std::uint32_t faction, std::int32_t x, std::int32_t y) const noexcept;
    std::span<const std::uint32_t> footprint(std::uint32_t id) const noexcept;
    const CampaignFogObserver* observer(std::uint32_t id) const noexcept;

    // Insert or atomically replace slot id (including faction transfer). Uses
    // the RETAINED old footprint; changed radius/eye cannot corrupt removal.
    // Geometry: 492498/492B0F/4930A2 + 491B9D/492007 + 495D3C. Preserves
    // perimeter/interior order, edge duplicates, cast early-return, truncating
    // coordinate conversion, float stores, terrain blockers and revealed blocker.
    // No allocations, callbacks, exceptions, or transient counter publication.
    // Refusals preserve tables/slots/history; diagnostic scratch is invalidated.
    // Each intermediate movement step must call this; endpoint-only updates
    // cannot recover exploration along a route. No automatic per-turn reset.
    CampaignFogStatus set_observer(std::uint32_t id, std::uint32_t faction,
                                   CampaignFogObserver observer) noexcept;
    CampaignFogStatus remove_observer(std::uint32_t id) noexcept;
    // Entire span validated before mutation; duplicates allowed. Native region
    // add/remove has this net effect on counters/history. For map exchange the
    // caller supplies the donating faction's observer footprints AND regions;
    // copying its entire shared/historical table is not the native operation.
    CampaignFogStatus explore(std::uint32_t faction, std::span<const std::uint32_t> cells) noexcept;

    // Net changed counter cells for the last successful set/remove; valid until
    // ANY next mutating call. before>=2 && after==1 needs a last-seen structure
    // snapshot; before<2 && after>=2 invalidates one. This component stores NO
    // structure models/UI snapshots. Live objects/labels require >=2; byte 1
    // alone never authorizes drawing a current live structure.
    std::span<const CampaignFogChange> changes() const noexcept;

    CampaignFogSnapshot snapshot() const;
    // Validates dimensions, exact expected sharing, slot IDs, every regenerated
    // footprint and ALL counters against contributions before returning a value.
    // Cells without contributors must be 0 or 1, preserving supplied history.
    // Caller binds terrain/source identity in its own save envelope. This is an
    // OpenRTW in-memory snapshot, NOT native .sav framing or shroud compatibility.
    static CampaignFog restore(const CampaignFogTerrain& terrain,
                               std::span<const std::uint32_t> expectedFactionTables,
                               const CampaignFogSnapshot& snapshot);

private:
    struct Slot {
        CampaignFogObserver observer;
        std::uint32_t faction = 0, count = 0;
        bool active = false;
    };
    CampaignFog() = default;
    CampaignFogStatus validate(std::uint32_t id, std::uint32_t faction,
                               const CampaignFogObserver& observer) const noexcept;
    void trace(const CampaignFogObserver& observer) noexcept;
    void cast(const CampaignFogObserver& observer, std::size_t targetCount) noexcept;
    bool step(const CampaignFogObserver& observer, std::int32_t x, std::int32_t y) noexcept;
    void clear_marks() noexcept;
    CampaignFogTerrain terrain_;
    std::vector<std::uint32_t> factionTables_;
    std::vector<std::uint8_t> cells_;
    std::vector<Slot> slots_;
    // Fixed-size slices per slot. Copying these vectors retains update capacity.
    std::vector<std::uint32_t> footprints_, targets_, traced_;
    std::vector<std::uint8_t> marks_;
    std::vector<CampaignFogChange> changes_;
    std::size_t stride_ = 0, tracedCount_ = 0, changeCount_ = 0;
    std::uint32_t maxRadius_ = 0;
};

enum class CampaignFogStructureKind { settlement, fort, port, watchtower };
struct CampaignFogInitialStructure {
    std::uint32_t faction = 0;
    CampaignFogStructureKind kind = CampaignFogStructureKind::settlement;
    std::int32_t x = 0, y = 0, level = 0;
    // Exact native region cell indices for settlements; empty for other kinds.
    std::vector<std::uint32_t> regionCells;
};

// Explicit initial-campaign projection, not a parser for unsupported records.
// Character slots are flattened Campaign faction/character order (same IDs as
// CampaignSession), followed by structures in caller order. lineOfSight must
// contain one resolved effect per character: traits/ancillaries are NOT ignored
// implicitly. Caller supplies exact sharing, admitted structures (one per object,
// not one per CAS instance), region cells and landmark cell indices. Ports include
// level 0 fishing villages: 49DE92 -> 4C9F06 registers them at faction+0x130,
// traversed by 4933FC with no level gate. Wonders only explore their own cell.
// Settlement radius 4+level/eye -1, fort 2/0, port 2*level+3/0, watchtower 10/480.
// No starting forts/circles or unknown source directives are invented. Extra
// slots allow later observers. All inputs copied; failure publishes no result.
CampaignFog project_initial_campaign_fog(const Campaign& campaign,
                                         const CampaignFogTerrain& terrain,
                                         std::span<const std::uint32_t> factionTables,
                                         std::span<const std::int32_t> lineOfSight,
                                         std::span<const CampaignFogInitialStructure> structures,
                                         std::span<const std::uint32_t> landmarkCells,
                                         std::uint32_t extraObserverSlots = 0);

} // namespace openrtw
