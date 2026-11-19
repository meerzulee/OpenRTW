#pragma once

#include "campaign.hpp"
#include "campaign_fog.hpp"
#include "campaign_production.hpp"

#include <cstddef>
#include <cstdint>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace openrtw {

// Explicit OpenRTW prototype rules with only the original single-step date
// arithmetic integrated. Movement, actor/type, passability, faction-turn and
// AP semantics are not recovered RTW behavior.
inline constexpr std::uint32_t campaign_session_max_ap = 80;
inline constexpr std::uint32_t campaign_session_step_cost = 1;
inline constexpr std::uint32_t campaign_session_max_dimension = 8191;
inline constexpr std::uint64_t campaign_session_max_cells = 16 * 1024 * 1024;
inline constexpr std::size_t campaign_session_max_actors = 4096;
inline constexpr std::size_t campaign_session_max_factions = 256;
inline constexpr std::size_t campaign_session_max_source_bytes = 16 * 1024 * 1024;
inline constexpr std::size_t campaign_session_save_max_bytes = 1024 * 1024;
inline constexpr std::uint32_t campaign_route_max_cells = 65536;
inline constexpr std::size_t campaign_faction_journey_max_planned = 256;
inline constexpr std::uint64_t campaign_faction_journey_max_search_work = std::uint64_t{1} << 24;

struct CampaignRoutePoint {
    std::int32_t x = 0;
    std::int32_t y = 0;
};

struct CampaignActor {
    // Flat zero-based ID, fixed by faction/character source order in this
    // session. IDs have no original runtime-object identity meaning.
    std::uint32_t id = 0;
    std::uint32_t sourceFactionIndex = 0;
    std::uint32_t sourceCharacterIndex = 0;
    std::size_t sourceLine = 0;
    std::int32_t initialX = 0;
    std::int32_t initialY = 0;
    std::int32_t currentX = 0;
    std::int32_t currentY = 0;
    std::uint32_t ap = campaign_session_max_ap;
    std::uint32_t maxAp = campaign_session_max_ap;
    // Owned prototype intent; movement is always an explicit command.
    std::optional<CampaignRoutePoint> destination;
};

enum class CampaignCommandStatus {
    Applied,
    StaleRevision,
    InvalidActor,
    OutOfBounds,
    NoOp,
    NotAdjacent,
    NoAp,
    Occupied,
    RevisionOverflow,
    TurnOverflow,
    YearOverflow,
    StaleOrderRevision,
    FogRefused,
};

struct CampaignSessionCommandResult {
    CampaignCommandStatus status = CampaignCommandStatus::Applied;
    std::uint32_t revision = 0;
    bool accepted() const noexcept { return status == CampaignCommandStatus::Applied; }
};

enum class CampaignRouteStatus {
    Ok,
    StaleRevision,
    InvalidActor,
    OutOfBounds,
    NoOp,
    WorldTooLarge,
    Occupied,
    Unreachable,
    InsufficientAp,
    RevisionOverflow,
    StaleOrderRevision,
    NoDestination,
    FogRefused,
};

struct CampaignRoutePreview {
    CampaignRouteStatus status = CampaignRouteStatus::Ok;
    std::uint32_t actorId = 0;
    std::uint32_t revision = 0;
    std::uint32_t availableAp = 0;
    std::uint32_t requiredAp = 0;
    std::int32_t targetX = 0;
    std::int32_t targetY = 0;
    std::vector<CampaignRoutePoint> points;
};

struct CampaignRouteCommandResult {
    CampaignRouteStatus status = CampaignRouteStatus::Ok;
    std::uint32_t revision = 0;
    std::uint32_t stepsTaken = 0;
    bool accepted() const noexcept { return status == CampaignRouteStatus::Ok; }
};

enum class CampaignFactionJourneyStatus {
    Ok,
    StaleRevision,
    StaleOrderRevision,
    InvalidFaction,
    WorkLimitExceeded,
};

struct CampaignFactionJourneyRow {
    std::uint32_t actorId = 0;
    CampaignRoutePoint target;
    CampaignRoutePoint beforePosition;
    CampaignRoutePoint afterPosition;
    std::uint32_t beforeAp = 0;
    std::uint32_t afterAp = 0;
    CampaignRouteStatus status = CampaignRouteStatus::Ok;
    std::uint32_t stepsTaken = 0;
    std::optional<CampaignRoutePoint> remainingDestination;
    bool arrived = false;
};

struct CampaignFactionJourneyResult {
    CampaignFactionJourneyStatus status = CampaignFactionJourneyStatus::Ok;
    std::uint32_t sourceFactionIndex = 0;
    std::uint32_t entryRevision = 0;
    std::uint32_t revision = 0;
    std::uint32_t orderRevision = 0;
    std::uint32_t totalSteps = 0;
    std::uint32_t appliedCount = 0;
    std::uint32_t blockedCount = 0;
    std::vector<CampaignFactionJourneyRow> rows;
    // Admitted reports include empty/all-blocked passes; this does not mean
    // any movement occurred. Top-level refusals have no rows or steps.
    bool admitted() const noexcept { return status == CampaignFactionJourneyStatus::Ok; }
};

class CampaignSession {
public:
    // Validates dimensions, owned-source budgets and all starting coordinates
    // before copying/publishing. Coincident initial characters are retained.
    // Throws runtime_error/allocation failure without publishing a session.
    static CampaignSession create(const Campaign& source, std::uint32_t width, std::uint32_t height,
                                  std::optional<CampaignFog> fog = std::nullopt,
                                  std::string fogIdentity = {});

    const Campaign& source() const noexcept { return source_; }
    const std::vector<CampaignActor>& actors() const noexcept { return actors_; }
    std::uint32_t width() const noexcept { return width_; }
    std::uint32_t height() const noexcept { return height_; }
    std::uint64_t turn() const noexcept { return turn_; }
    std::int32_t year() const noexcept { return year_; }
    Season season() const noexcept { return season_; }
    std::uint32_t revision() const noexcept { return revision_; }
    std::uint32_t order_revision() const noexcept { return orderRevision_; }
    const CampaignFog* fog() const noexcept { return fog_ ? &*fog_ : nullptr; }
    const std::string& fog_identity() const noexcept { return fogIdentity_; }
    const CampaignProduction* production() const noexcept { return production_ ? &*production_ : nullptr; }
    void enable_production(std::shared_ptr<const ProductionCatalog> catalog);
    void production_command(std::uint32_t kind, std::uint32_t city, std::uint32_t first,
                            std::uint32_t second, std::uint32_t expectedOrderRevision);
    std::vector<Unit> army(std::uint32_t actor) const;

    // One in-bounds cardinal step costs 1 AP. Any other actor at the target
    // blocks it, including one of several initially coincident characters.
    // No source category/height/type is interpreted as RTW traversal legality.
    CampaignSessionCommandResult move(std::uint32_t actorId, std::int32_t targetX,
                                      std::int32_t targetY,
                                      std::uint32_t expectedRevision) noexcept;

    // Existing full-round policy refills every actor and increments turn; only
    // its date step uses 43BEFE, including BC/AD year-zero skip and int32 wrap.
    // Enabled prototype production stages its two queues before this date step.
    // No AI, original faction round/economy or aging is implied.
    CampaignSessionCommandResult end_turn(std::uint32_t expectedRevision);

    // Manual intent edits increment only order_revision; neither AP, movement
    // revision nor calendar changes. Both tokens must match. Any in-bounds
    // non-current destination may be stored, even if presently blocked.
    CampaignSessionCommandResult set_destination(std::uint32_t actorId, std::int32_t targetX,
                                                 std::int32_t targetY,
                                                 std::uint32_t expectedRevision,
                                                 std::uint32_t expectedOrderRevision) noexcept;
    CampaignSessionCommandResult cancel_destination(std::uint32_t actorId,
                                                    std::uint32_t expectedRevision,
                                                    std::uint32_t expectedOrderRevision) noexcept;

    // Recompute and advance the selected actor's stored intent using the same
    // atomic affordable-prefix operation. A refusal preserves that intent.
    // Arrival by any successful primitive move clears only that actor's intent;
    // the movement revision already records the change. End turn keeps intents.
    CampaignRouteCommandResult continue_journey(std::uint32_t actorId,
                                                std::uint32_t expectedRevision,
                                                std::uint32_t expectedOrderRevision);

    // Explicit prototype batch, grouped by containing source faction, not a
    // recovered current-owner rule. Initially planned actor IDs are visited
    // once in ascending order; later routes see earlier staged moves. Ordinary
    // per-actor refusals retain goals and are reported without retry. Cap the
    // planned count and planned*world-cells before copying/searching; each route
    // still has its own WorldTooLarge refusal. Stage all state and report rows
    // before one publication. Exception/top refusal leaves every member fixed;
    // empty/all-blocked admission also preserves existing state/pointers.
    // Only actual primitive steps change revision/AP, arrivals clear goals,
    // and calendar/order_revision/source stay fixed. May allocate/throw.
    CampaignFactionJourneyResult continue_faction_journeys(std::uint32_t sourceFactionIndex,
                                                           std::uint32_t expectedRevision,
                                                           std::uint32_t expectedOrderRevision);

    // Profile1 shortest cardinal route: only dimensions and other actor
    // positions define the graph. No terrain or original RTW legality is used.
    // Search is capped at 65536 cells, neighbor order +x,+y,-x,-y. Current
    // revision/actor AP are reported even on refusal (invalid actor AP is 0).
    // Only Ok owns points, including start/destination, at most 81 total.
    // requiredAp is exact for Ok/InsufficientAp/RevisionOverflow, otherwise 0.
    // Preview is const; both route operations may allocate/throw.
    CampaignRoutePreview preview_route(std::uint32_t actorId, std::int32_t targetX,
                                       std::int32_t targetY, std::uint32_t expectedRevision) const;

    // Same bounded BFS and full requiredAp as preview_route, but Ok owns only
    // the affordable prefix: K=min(full distance, current AP), K+1 points.
    // The last point may precede targetX/targetY; no target/order is persisted.
    // AP0 refuses as InsufficientAp with exact full cost and no points.
    // Revision capacity is checked for K steps, not the full remaining cost.
    CampaignRoutePreview preview_route_advance(std::uint32_t actorId, std::int32_t targetX,
                                               std::int32_t targetY,
                                               std::uint32_t expectedRevision) const;

    // Recomputes at the expected revision, applies K existing moves on a private
    // copy, then swaps actor state/revision only after all K succeed. Refusal or
    // exception leaves every member unchanged. AP falls by K and revision rises
    // by K; calendar/source stay fixed. No supplied path or preview is trusted.
    CampaignRouteCommandResult move_route(std::uint32_t actorId, std::int32_t targetX,
                                          std::int32_t targetY, std::uint32_t expectedRevision);

    // Recompute an affordable prefix and apply exactly K primitive moves on a
    // private copy. Success reports stepsTaken=K, AP-K and revision+K. Refusal
    // or exception is atomic; source/calendar/Save1/profile2 stay unchanged.
    CampaignRouteCommandResult advance_route(std::uint32_t actorId, std::int32_t targetX,
                                             std::int32_t targetY, std::uint32_t expectedRevision);

    // Without fog, OpenRTW Save1 stays byte-exact until the first manual intent edit. Save2
    // uses an 80-byte header (order revision at64, zeros68..79) and 24-byte actor
    // rows (x/y/AP, destination flag/x/y); version determines the layout. Both
    // bind the same opaque campaign_json identity and decoded base-region RGB.
    // The caller must supply the trusted current identity/map, stable for this
    // call. These bind the published source projection, not all raw source or
    // original RTW .sav data. Generation is external and never serialized.
    // Header word12 is rule profile2; profile1 records are refused, not migrated.
    // Export owns its bytes and does not mutate the session. Import validates
    // all framing/binding/state before returning an owned staged session;
    // refusals throw without touching caller state or retaining borrowed spans.
    // Necessary calendar/AP/move/distance/parity/overlap checks do not replay
    // history or prove complete path reachability. UINT32_MAX revision is a
    // valid consistent read-only endpoint. Both methods may allocate/throw.
    // Fog-enabled sessions write Save3: the Save2 header/actor layout (order
    // revision may be zero), fog byte length at68, source-binding length at72,
    // then the binding and packed explored history/observer records after actors.
    // 1 MiB limit remains. Current footprints/counters regenerate from bound
    // inputs; explored history is serialized, never guessed from final positions.
    // Import requires the INITIAL fog template and matching source identity.
    // Save1/2 explicitly refuse into a fog-enabled session (history absent).
    std::vector<std::uint8_t> encode_save(std::string_view campaignIdentity,
                                          std::span<const std::uint8_t> worldRgb) const;
    static CampaignSession decode_save(const Campaign& source, std::uint32_t width,
                                       std::uint32_t height, std::string_view campaignIdentity,
                                       std::span<const std::uint8_t> worldRgb,
                                       std::span<const std::uint8_t> saveBytes,
                                       const CampaignFog* initialFog = nullptr,
                                       std::string_view fogIdentity = {},
                                       std::shared_ptr<const ProductionCatalog> productionCatalog = nullptr);

    // Primitive commands check before mutation and preserve state on refusal.
    // End turn with production may allocate while staging queue completion.
    // Revision starts at 0, turn at 1;
    // each accepted command increments revision exactly once, never wraps.

private:
    CampaignSession() = default;
    CampaignRoutePreview preview_route_impl(std::uint32_t actorId, std::int32_t targetX,
                                            std::int32_t targetY, std::uint32_t expectedRevision,
                                            bool allowPartial) const;
    CampaignRouteCommandResult move_route_impl(std::uint32_t actorId, std::int32_t targetX,
                                               std::int32_t targetY, std::uint32_t expectedRevision,
                                               bool allowPartial);
    Campaign source_;
    std::vector<CampaignActor> actors_;
    std::uint32_t width_ = 0;
    std::uint32_t height_ = 0;
    std::uint64_t turn_ = 1;
    std::int32_t year_ = 0;
    Season season_ = Season::summer;
    std::uint32_t revision_ = 0;
    std::uint32_t orderRevision_ = 0;
    std::optional<CampaignFog> fog_;
    std::string fogIdentity_;
    std::optional<CampaignProduction> production_;
};

} // namespace openrtw
