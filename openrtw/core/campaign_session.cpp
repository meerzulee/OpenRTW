#include "campaign_session.hpp"
#include "campaign_fog_save.hpp"
#include "rome_calendar.hpp"

#include <array>
#include <algorithm>
#include <bit>
#include <limits>
#include <stdexcept>
#include <string>

namespace openrtw {
namespace {

constexpr std::array<std::uint8_t, 8> save_magic{'O', 'R', 'T', 'W', 'S', 'A', 'V', 'E'};
constexpr std::uint32_t save_rule_profile = 2;
constexpr std::size_t save1_header_bytes = 64;
constexpr std::size_t save1_actor_bytes = 12;
constexpr std::size_t save2_header_bytes = 80;
constexpr std::size_t save2_actor_bytes = 24;

void validate_dimensions(std::uint32_t width, std::uint32_t height) {
    if (width == 0 || height == 0 || width > campaign_session_max_dimension ||
        height > campaign_session_max_dimension ||
        std::uint64_t{width} * height > campaign_session_max_cells)
        throw std::runtime_error("Campaign session world dimensions exceed supported bounds");
}

struct SourceBudget {
    std::size_t bytes = 0;
    std::size_t records = 0;

    void text(const std::string& value) {
        if (value.size() > campaign_session_max_source_bytes - bytes)
            throw std::runtime_error("Campaign session source byte budget exceeded");
        bytes += value.size();
    }

    void rows(std::size_t count) {
        if (count > campaign_max_records - records)
            throw std::runtime_error("Campaign session source record budget exceeded");
        records += count;
    }
};

std::size_t validate_source(const Campaign& source, std::uint32_t width, std::uint32_t height) {
    if (source.startSeason != Season::summer && source.startSeason != Season::winter)
        throw std::runtime_error("Campaign session source season is invalid");
    if (source.factions.size() > campaign_session_max_factions)
        throw std::runtime_error("Campaign session faction budget exceeded");

    SourceBudget budget;
    budget.text(source.id);
    budget.rows(source.factions.size());
    budget.rows(source.unsupported.size());
    for (const auto& row : source.unsupported) {
        budget.text(row.text);
        budget.text(row.context);
    }

    std::size_t actors = 0;
    std::size_t settlements = 0;
    std::size_t buildings = 0;
    for (const auto& faction : source.factions) {
        budget.text(faction.id);
        if (faction.characters.size() > campaign_session_max_actors - actors)
            throw std::runtime_error("Campaign session actor budget exceeded");
        actors += faction.characters.size();
        budget.rows(faction.characters.size());
        for (const auto& character : faction.characters) {
            if (character.x < 0 || character.y < 0 ||
                static_cast<std::uint32_t>(character.x) >= width ||
                static_cast<std::uint32_t>(character.y) >= height)
                throw std::runtime_error("Campaign session source coordinate is outside world");
            budget.text(character.name);
            budget.text(character.type);
            if (character.subFaction)
                budget.text(*character.subFaction);
            budget.rows(character.army.size());
            for (const auto& unit : character.army)
                budget.text(unit.name);
        }
        if (faction.settlements.size() > campaign_max_settlement_blocks - settlements)
            throw std::runtime_error("Campaign session settlement budget exceeded");
        settlements += faction.settlements.size();
        budget.rows(faction.settlements.size());
        for (const auto& settlement : faction.settlements) {
            budget.text(settlement.level);
            budget.text(settlement.region);
            budget.text(settlement.planSet);
            budget.text(settlement.factionCreator);
            budget.rows(settlement.source.size());
            for (const auto& row : settlement.source)
                budget.text(row.text);
            if (settlement.buildings.size() > campaign_max_buildings_per_settlement ||
                settlement.buildings.size() > campaign_max_total_settlement_buildings - buildings)
                throw std::runtime_error("Campaign session building budget exceeded");
            buildings += settlement.buildings.size();
            budget.rows(settlement.buildings.size());
            for (const auto& building : settlement.buildings) {
                budget.rows(building.source.size());
                for (const auto& row : building.source)
                    budget.text(row.text);
            }
        }
    }
    return actors;
}

std::size_t save_extent(std::uint32_t width, std::uint32_t height, std::size_t actors,
                        std::string_view identity, std::span<const std::uint8_t> rgb,
                        bool journeys) {
    validate_dimensions(width, height);
    if (actors > campaign_session_max_actors || identity.empty() ||
        identity.size() > campaign_session_save_max_bytes ||
        rgb.size() > campaign_session_save_max_bytes ||
        std::uint64_t{width} * height * 3 != rgb.size())
        throw std::runtime_error("Campaign save binding extent is invalid");
    // Each term is bounded above before addition; no size_t/u32 wrapping.
    const auto header_bytes = journeys ? save2_header_bytes : save1_header_bytes;
    const auto actor_bytes = journeys ? save2_actor_bytes : save1_actor_bytes;
    const auto total = std::uint64_t{header_bytes} + identity.size() + rgb.size() +
                       std::uint64_t{actor_bytes} * actors;
    if (total > campaign_session_save_max_bytes)
        throw std::runtime_error("Campaign save exceeds byte budget");
    return static_cast<std::size_t>(total);
}

std::uint32_t read32(std::span<const std::uint8_t> bytes, std::size_t offset) noexcept {
    std::uint32_t value = 0;
    for (unsigned i = 0; i < 4; ++i)
        value |= std::uint32_t{bytes[offset + i]} << (8u * i);
    return value;
}

std::uint64_t read64(std::span<const std::uint8_t> bytes, std::size_t offset) noexcept {
    std::uint64_t value = 0;
    for (unsigned i = 0; i < 8; ++i)
        value |= std::uint64_t{bytes[offset + i]} << (8u * i);
    return value;
}

void write32(std::vector<std::uint8_t>& bytes, std::size_t offset, std::uint32_t value) noexcept {
    for (unsigned i = 0; i < 4; ++i)
        bytes[offset + i] = static_cast<std::uint8_t>(value >> (8u * i));
}

void write64(std::vector<std::uint8_t>& bytes, std::size_t offset, std::uint64_t value) noexcept {
    for (unsigned i = 0; i < 8; ++i)
        bytes[offset + i] = static_cast<std::uint8_t>(value >> (8u * i));
}

std::uint64_t distance(const CampaignActor& actor) noexcept {
    const auto dx = std::int64_t{actor.currentX} - actor.initialX;
    const auto dy = std::int64_t{actor.currentY} - actor.initialY;
    return static_cast<std::uint64_t>(dx < 0 ? -dx : dx) +
           static_cast<std::uint64_t>(dy < 0 ? -dy : dy);
}

rome_original::CalendarDate expected_calendar(std::int32_t source_year, Season source_season,
                                               std::uint32_t completed_turns) noexcept {
    using rome_original::CalendarSeason;
    rome_original::CalendarDate date{
        source_year, source_season == Season::summer ? CalendarSeason::summer
                                                     : CalendarSeason::winter};
    if (completed_turns == 0)
        return date;

    auto remaining = completed_turns;
    if (date.year == 0 && date.season == CalendarSeason::summer) {
        date = rome_original::advance_calendar(date);
        --remaining;
    }

    // Two steps retain the season and advance on the nonzero-year cycle. The
    // pair count is <= INT32_MAX, so a negative start crosses year zero at most
    // once; positive-start overflow is ordinary uint32 word wrap.
    const auto pairs = remaining / 2;
    auto year = static_cast<std::uint32_t>(date.year) + pairs;
    if (date.year < 0 && std::int64_t{date.year} + pairs >= 0)
        ++year;
    date.year = std::bit_cast<std::int32_t>(year);
    if ((remaining & 1u) != 0)
        date = rome_original::advance_calendar(date);
    return date;
}

void validate_saved_state(const Campaign& source, std::uint32_t width, std::uint32_t height,
                          const std::vector<CampaignActor>& actors, std::uint64_t turn,
                          std::int32_t year, Season season, std::uint32_t revision,
                          std::uint32_t order_revision) {
    if (turn == 0 || turn > std::uint64_t{revision} + 1)
        throw std::runtime_error("Campaign save turn and revision disagree");
    const auto completed_turns = turn - 1;
    const auto moves = std::uint64_t{revision} - completed_turns;
    const auto expected =
        expected_calendar(source.startYear, source.startSeason,
                          static_cast<std::uint32_t>(completed_turns));
    const auto expected_season = expected.season == rome_original::CalendarSeason::summer
                                     ? Season::summer
                                     : Season::winter;
    if (year != expected.year || season != expected_season)
        throw std::runtime_error("Campaign save calendar disagrees with source and turn");

    std::uint64_t total_spent = 0;
    std::uint64_t total_distance = 0;
    std::size_t active_orders = 0;
    for (const auto& actor : actors) {
        if (actor.currentX < 0 || actor.currentY < 0 ||
            static_cast<std::uint32_t>(actor.currentX) >= width ||
            static_cast<std::uint32_t>(actor.currentY) >= height ||
            actor.maxAp != campaign_session_max_ap || actor.ap > actor.maxAp)
            throw std::runtime_error("Campaign save actor position or AP is invalid");
        if (actor.destination) {
            const auto& point = *actor.destination;
            if (point.x < 0 || point.y < 0 || static_cast<std::uint32_t>(point.x) >= width ||
                static_cast<std::uint32_t>(point.y) >= height ||
                (point.x == actor.currentX && point.y == actor.currentY))
                throw std::runtime_error("Campaign save destination is invalid");
            ++active_orders;
        }
        const auto spent = std::uint64_t{actor.maxAp - actor.ap};
        const auto travelled = distance(actor);
        total_spent += spent;
        total_distance += travelled;
        if (turn == 1 && (travelled > spent || (travelled & 1u) != (spent & 1u)))
            throw std::runtime_error("Campaign save first-turn actor distance and AP disagree");
    }
    if (active_orders > order_revision)
        throw std::runtime_error("Campaign save destinations exceed order revision");
    if (total_spent > moves || (turn == 1 && total_spent != moves) || total_distance > moves ||
        (total_distance & 1u) != (moves & 1u) || (actors.empty() && moves != 0))
        throw std::runtime_error("Campaign save movement counts disagree");

    // Bounded <=4096 actors; at most 4096*4095/2 coordinate comparisons.
    // Initial coincident actors can leave but cannot move back onto each other.
    for (std::size_t i = 0; i < actors.size(); ++i) {
        const auto& a = actors[i];
        for (std::size_t j = i + 1; j < actors.size(); ++j) {
            const auto& b = actors[j];
            if (a.currentX == b.currentX && a.currentY == b.currentY &&
                (a.currentX != a.initialX || a.currentY != a.initialY || b.currentX != b.initialX ||
                 b.currentY != b.initialY || a.ap != campaign_session_max_ap ||
                 b.ap != campaign_session_max_ap))
                throw std::runtime_error("Campaign save introduces an actor overlap");
        }
    }
}

void validate_fog_actors(const CampaignFog& fog, const std::vector<CampaignActor>& actors,
                         std::uint32_t width, std::uint32_t height, std::size_t factions) {
    if (fog.width() != width || fog.height() != height || fog.faction_tables().size() != factions)
        throw std::runtime_error("Campaign fog dimensions or factions disagree with session");
    const auto saved = fog.snapshot();
    if (saved.observers.size() < actors.size())
        throw std::runtime_error("Campaign fog is missing actor observers");
    for (std::size_t i = 0; i < actors.size(); ++i) {
        const auto& item = saved.observers[i];
        const auto& actor = actors[i];
        if (item.id != actor.id || item.faction != actor.sourceFactionIndex ||
            item.observer.x != actor.currentX || item.observer.y != actor.currentY)
            throw std::runtime_error("Campaign fog actor observer binding disagrees");
    }
}

} // namespace

CampaignSession CampaignSession::create(const Campaign& source, std::uint32_t width,
                                        std::uint32_t height, std::optional<CampaignFog> fog,
                                        std::string fogIdentity) {
    validate_dimensions(width, height);
    const auto actor_count = validate_source(source, width, height);

    CampaignSession session;
    session.source_ = source;
    session.actors_.reserve(actor_count);
    session.width_ = width;
    session.height_ = height;
    session.year_ = source.startYear;
    session.season_ = source.startSeason;
    for (std::size_t faction_index = 0; faction_index < source.factions.size(); ++faction_index) {
        const auto& faction = source.factions[faction_index];
        for (std::size_t character_index = 0; character_index < faction.characters.size();
             ++character_index) {
            const auto& character = faction.characters[character_index];
            CampaignActor actor;
            actor.id = static_cast<std::uint32_t>(session.actors_.size());
            actor.sourceFactionIndex = static_cast<std::uint32_t>(faction_index);
            actor.sourceCharacterIndex = static_cast<std::uint32_t>(character_index);
            actor.sourceLine = character.line;
            actor.initialX = actor.currentX = character.x;
            actor.initialY = actor.currentY = character.y;
            session.actors_.push_back(actor);
        }
    }
    if (fog) {
        if (fogIdentity.empty() || fogIdentity.size() > 256)
            throw std::runtime_error("Campaign fog source binding is missing or too large");
        validate_fog_actors(*fog, session.actors_, width, height, source.factions.size());
    } else if (!fogIdentity.empty()) {
        throw std::runtime_error("Campaign fog binding exists without fog state");
    }
    session.fog_ = std::move(fog);
    session.fogIdentity_ = std::move(fogIdentity);
    return session;
}

CampaignSessionCommandResult CampaignSession::move(std::uint32_t actorId, std::int32_t targetX,
                                                   std::int32_t targetY,
                                                   std::uint32_t expectedRevision) noexcept {
    const auto refusal = [this](CampaignCommandStatus status) {
        return CampaignSessionCommandResult{status, revision_};
    };
    if (expectedRevision != revision_)
        return refusal(CampaignCommandStatus::StaleRevision);
    if (actorId >= actors_.size())
        return refusal(CampaignCommandStatus::InvalidActor);
    if (targetX < 0 || targetY < 0 || static_cast<std::uint32_t>(targetX) >= width_ ||
        static_cast<std::uint32_t>(targetY) >= height_)
        return refusal(CampaignCommandStatus::OutOfBounds);
    auto& actor = actors_[actorId];
    if (targetX == actor.currentX && targetY == actor.currentY)
        return refusal(CampaignCommandStatus::NoOp);
    const std::int64_t dx = std::int64_t{targetX} - actor.currentX;
    const std::int64_t dy = std::int64_t{targetY} - actor.currentY;
    if (!((dx == 1 || dx == -1) && dy == 0) && !(dx == 0 && (dy == 1 || dy == -1)))
        return refusal(CampaignCommandStatus::NotAdjacent);
    if (actor.ap < campaign_session_step_cost)
        return refusal(CampaignCommandStatus::NoAp);
    for (const auto& other : actors_) {
        if (other.id != actorId && other.currentX == targetX && other.currentY == targetY)
            return refusal(CampaignCommandStatus::Occupied);
    }
    if (revision_ == std::numeric_limits<std::uint32_t>::max())
        return refusal(CampaignCommandStatus::RevisionOverflow);

    // Every movement path uses this primitive, including every intermediate
    // route tile. All actor checks precede fog, whose own refusal is atomic.
    if (fog_) {
        const auto* before = fog_->observer(actorId);
        if (!before)
            return refusal(CampaignCommandStatus::FogRefused);
        auto observer = *before;
        observer.x = targetX;
        observer.y = targetY;
        if (fog_->set_observer(actorId, actor.sourceFactionIndex, observer) !=
            CampaignFogStatus::Ok)
            return refusal(CampaignCommandStatus::FogRefused);
    }
    actor.currentX = targetX;
    actor.currentY = targetY;
    actor.ap -= campaign_session_step_cost;
    ++revision_;
    if (actor.destination && actor.destination->x == targetX && actor.destination->y == targetY)
        actor.destination.reset();
    return {CampaignCommandStatus::Applied, revision_};
}

void CampaignSession::enable_production(std::shared_ptr<const ProductionCatalog> catalog) {
    if (production_ || turn_ != 1 || revision_ != 0 || orderRevision_ != 0)
        throw std::runtime_error("Production must initialize before campaign commands");
    if (!catalog) throw std::runtime_error("Production catalog is missing");
    production_ = CampaignProduction::create(source_, std::make_shared<const ProductionCatalog>(*catalog));
}
std::vector<Unit> CampaignSession::army(std::uint32_t id) const {
    const auto& a = actors_.at(id);
    auto result = source_.factions.at(a.sourceFactionIndex).characters.at(a.sourceCharacterIndex).army;
    if (production_) {
        const auto& added = production_->additions.at(id);
        result.insert(result.end(), added.begin(), added.end());
    }
    return result;
}
void CampaignSession::production_command(std::uint32_t kind, std::uint32_t city,
                                         std::uint32_t first, std::uint32_t second,
                                         std::uint32_t expectedOrderRevision) {
    if (!production_ || expectedOrderRevision != orderRevision_ ||
        orderRevision_ == std::numeric_limits<std::uint32_t>::max())
        throw std::runtime_error("Production orders changed or unavailable");
    auto next = *production_;
    switch (kind) {
    case 0: next.enqueue(city, first, false); break;
    case 1: next.enqueue(city, first, true); break;
    case 2: next.cancel(city, first, false); break;
    case 3: next.cancel(city, first, true); break;
    case 4: next.reorder(city, first, second, false); break;
    case 5: next.reorder(city, first, second, true); break;
    case 6: {
        const auto& actor = actors_.at(second);
        if (actor.sourceFactionIndex != next.cities.at(city).faction)
            throw std::runtime_error("Cannot transfer units to another faction");
        const auto& source = source_.factions.at(actor.sourceFactionIndex).characters.at(actor.sourceCharacterIndex);
        if (source.type != "named character" && source.type != "general" && source.type != "captain")
            throw std::runtime_error("Select a land army commander");
        next.transfer(city, first, second, source.army.size()); break;
    }
    default: throw std::runtime_error("Unknown production command");
    }
    production_ = std::move(next);
    ++orderRevision_;
}

CampaignSessionCommandResult CampaignSession::end_turn(std::uint32_t expectedRevision) {
    const auto refusal = [this](CampaignCommandStatus status) {
        return CampaignSessionCommandResult{status, revision_};
    };
    if (expectedRevision != revision_)
        return refusal(CampaignCommandStatus::StaleRevision);
    if (revision_ == std::numeric_limits<std::uint32_t>::max())
        return refusal(CampaignCommandStatus::RevisionOverflow);
    if (turn_ == std::numeric_limits<std::uint64_t>::max())
        return refusal(CampaignCommandStatus::TurnOverflow);

    auto nextProduction = production_;
    if (nextProduction) nextProduction->advance();
    const auto date = rome_original::advance_calendar(
        {year_, season_ == Season::summer ? rome_original::CalendarSeason::summer
                                          : rome_original::CalendarSeason::winter});
    for (auto& actor : actors_)
        actor.ap = actor.maxAp;
    production_.swap(nextProduction);
    ++turn_;
    year_ = date.year;
    season_ = date.season == rome_original::CalendarSeason::summer ? Season::summer
                                                                   : Season::winter;
    ++revision_;
    return {CampaignCommandStatus::Applied, revision_};
}

CampaignSessionCommandResult
CampaignSession::set_destination(std::uint32_t actorId, std::int32_t targetX, std::int32_t targetY,
                                 std::uint32_t expectedRevision,
                                 std::uint32_t expectedOrderRevision) noexcept {
    const auto refusal = [this](CampaignCommandStatus status) {
        return CampaignSessionCommandResult{status, revision_};
    };
    if (expectedRevision != revision_)
        return refusal(CampaignCommandStatus::StaleRevision);
    if (expectedOrderRevision != orderRevision_)
        return refusal(CampaignCommandStatus::StaleOrderRevision);
    if (actorId >= actors_.size())
        return refusal(CampaignCommandStatus::InvalidActor);
    if (targetX < 0 || targetY < 0 || static_cast<std::uint32_t>(targetX) >= width_ ||
        static_cast<std::uint32_t>(targetY) >= height_)
        return refusal(CampaignCommandStatus::OutOfBounds);
    auto& actor = actors_[actorId];
    if ((targetX == actor.currentX && targetY == actor.currentY) ||
        (actor.destination && actor.destination->x == targetX && actor.destination->y == targetY))
        return refusal(CampaignCommandStatus::NoOp);
    if (orderRevision_ == std::numeric_limits<std::uint32_t>::max())
        return refusal(CampaignCommandStatus::RevisionOverflow);
    actor.destination = CampaignRoutePoint{targetX, targetY};
    ++orderRevision_;
    return {CampaignCommandStatus::Applied, revision_};
}

CampaignSessionCommandResult
CampaignSession::cancel_destination(std::uint32_t actorId, std::uint32_t expectedRevision,
                                    std::uint32_t expectedOrderRevision) noexcept {
    const auto refusal = [this](CampaignCommandStatus status) {
        return CampaignSessionCommandResult{status, revision_};
    };
    if (expectedRevision != revision_)
        return refusal(CampaignCommandStatus::StaleRevision);
    if (expectedOrderRevision != orderRevision_)
        return refusal(CampaignCommandStatus::StaleOrderRevision);
    if (actorId >= actors_.size())
        return refusal(CampaignCommandStatus::InvalidActor);
    if (!actors_[actorId].destination)
        return refusal(CampaignCommandStatus::NoOp);
    if (orderRevision_ == std::numeric_limits<std::uint32_t>::max())
        return refusal(CampaignCommandStatus::RevisionOverflow);
    actors_[actorId].destination.reset();
    ++orderRevision_;
    return {CampaignCommandStatus::Applied, revision_};
}

CampaignRouteCommandResult CampaignSession::continue_journey(std::uint32_t actorId,
                                                             std::uint32_t expectedRevision,
                                                             std::uint32_t expectedOrderRevision) {
    if (expectedRevision != revision_)
        return {CampaignRouteStatus::StaleRevision, revision_, 0};
    if (expectedOrderRevision != orderRevision_)
        return {CampaignRouteStatus::StaleOrderRevision, revision_, 0};
    if (actorId >= actors_.size())
        return {CampaignRouteStatus::InvalidActor, revision_, 0};
    if (!actors_[actorId].destination)
        return {CampaignRouteStatus::NoDestination, revision_, 0};
    const auto destination = *actors_[actorId].destination;
    return advance_route(actorId, destination.x, destination.y, expectedRevision);
}

CampaignFactionJourneyResult
CampaignSession::continue_faction_journeys(std::uint32_t sourceFactionIndex,
                                           std::uint32_t expectedRevision,
                                           std::uint32_t expectedOrderRevision) {
    CampaignFactionJourneyResult report;
    report.sourceFactionIndex = sourceFactionIndex;
    report.entryRevision = report.revision = revision_;
    report.orderRevision = orderRevision_;
    const auto refuse = [&report](CampaignFactionJourneyStatus status) {
        report.status = status;
        return report;
    };
    if (expectedRevision != revision_)
        return refuse(CampaignFactionJourneyStatus::StaleRevision);
    if (expectedOrderRevision != orderRevision_)
        return refuse(CampaignFactionJourneyStatus::StaleOrderRevision);
    if (sourceFactionIndex >= source_.factions.size())
        return refuse(CampaignFactionJourneyStatus::InvalidFaction);

    std::size_t planned = 0;
    for (const auto& actor : actors_)
        if (actor.sourceFactionIndex == sourceFactionIndex && actor.destination)
            ++planned;
    const auto cells = std::uint64_t{width_} * height_;
    // Division keeps the work comparison checked even if the source limits
    // grow later. No state, route or prefix is processed on budget refusal.
    if (planned > campaign_faction_journey_max_planned ||
        (planned != 0 && cells > campaign_faction_journey_max_search_work / planned))
        return refuse(CampaignFactionJourneyStatus::WorkLimitExceeded);
    if (planned == 0)
        return report;

    // Session IDs are fixed flat source ordinals, stored in ascending order.
    // Capture the initial work list; a blocked row is never retried this pass.
    std::array<std::uint32_t, campaign_faction_journey_max_planned> ids{};
    std::size_t next_id = 0;
    for (const auto& actor : actors_)
        if (actor.sourceFactionIndex == sourceFactionIndex && actor.destination)
            ids[next_id++] = actor.id;

    report.rows.reserve(planned);
    auto staged = *this;
    for (std::size_t i = 0; i < planned; ++i) {
        const auto id = ids[i];
        // An individual advance swaps the staged actor vector, so retain no
        // reference into that vector across the call.
        const auto before = staged.actors_[id];
        CampaignFactionJourneyRow row;
        row.actorId = id;
        row.target = *before.destination;
        row.beforePosition = {before.currentX, before.currentY};
        row.beforeAp = before.ap;
        const auto result = staged.continue_journey(id, staged.revision_, staged.orderRevision_);
        const auto& after = staged.actors_[id];
        row.afterPosition = {after.currentX, after.currentY};
        row.afterAp = after.ap;
        row.status = result.status;
        row.stepsTaken = result.stepsTaken;
        row.remainingDestination = after.destination;
        row.arrived = result.accepted() && !after.destination;
        if (result.accepted()) {
            ++report.appliedCount;
            report.totalSteps += result.stepsTaken; // At most 256 * 80.
        } else {
            ++report.blockedCount;
        }
        report.rows.push_back(row);
    }
    report.revision = staged.revision_;
    if (report.appliedCount != 0) {
        // Every allocation and all per-actor work preceded this publication.
        // No-op admissions also retain the existing actor-vector addresses.
        actors_.swap(staged.actors_);
        fog_.swap(staged.fog_);
        revision_ = staged.revision_;
    }
    return report;
}

CampaignRoutePreview CampaignSession::preview_route(std::uint32_t actorId, std::int32_t targetX,
                                                    std::int32_t targetY,
                                                    std::uint32_t expectedRevision) const {
    return preview_route_impl(actorId, targetX, targetY, expectedRevision, false);
}

CampaignRoutePreview CampaignSession::preview_route_advance(std::uint32_t actorId,
                                                            std::int32_t targetX,
                                                            std::int32_t targetY,
                                                            std::uint32_t expectedRevision) const {
    return preview_route_impl(actorId, targetX, targetY, expectedRevision, true);
}

CampaignRoutePreview CampaignSession::preview_route_impl(std::uint32_t actorId,
                                                         std::int32_t targetX, std::int32_t targetY,
                                                         std::uint32_t expectedRevision,
                                                         bool allowPartial) const {
    CampaignRoutePreview report;
    report.actorId = actorId;
    report.revision = revision_;
    report.targetX = targetX;
    report.targetY = targetY;
    if (actorId < actors_.size())
        report.availableAp = actors_[actorId].ap;
    const auto refusal = [&report](CampaignRouteStatus status) {
        report.status = status;
        return report;
    };
    if (expectedRevision != revision_)
        return refusal(CampaignRouteStatus::StaleRevision);
    if (actorId >= actors_.size())
        return refusal(CampaignRouteStatus::InvalidActor);
    if (targetX < 0 || targetY < 0 || static_cast<std::uint32_t>(targetX) >= width_ ||
        static_cast<std::uint32_t>(targetY) >= height_)
        return refusal(CampaignRouteStatus::OutOfBounds);
    const auto& actor = actors_[actorId];
    if (targetX == actor.currentX && targetY == actor.currentY)
        return refusal(CampaignRouteStatus::NoOp);
    const auto wide_count = std::uint64_t{width_} * height_;
    if (wide_count > campaign_route_max_cells)
        return refusal(CampaignRouteStatus::WorldTooLarge);
    const auto count = static_cast<std::uint32_t>(wide_count);
    const auto index = [this](std::int32_t x, std::int32_t y) {
        return static_cast<std::uint32_t>(std::uint64_t{static_cast<std::uint32_t>(y)} * width_ +
                                          static_cast<std::uint32_t>(x));
    };
    const auto start = index(actor.currentX, actor.currentY);
    const auto target = index(targetX, targetY);
    std::vector<std::uint8_t> blocked(count, 0);
    for (const auto& other : actors_)
        if (other.id != actorId)
            blocked[index(other.currentX, other.currentY)] = 1;
    if (blocked[target] != 0)
        return refusal(CampaignRouteStatus::Occupied);

    constexpr auto unseen = std::numeric_limits<std::uint32_t>::max();
    std::vector<std::uint32_t> parent(count, unseen);
    std::vector<std::uint32_t> queue(count);
    std::uint32_t head = 0;
    std::uint32_t tail = 1;
    parent[start] = start;
    queue[0] = start; // Initial coincidence may leave, but its cell stays blocked.
    while (head < tail && parent[target] == unseen) {
        const auto current = queue[head++];
        const auto x = current % width_;
        const auto y = current / width_;
        const auto enqueue = [&](std::uint32_t next) {
            if (parent[target] != unseen || blocked[next] != 0 || parent[next] != unseen)
                return;
            // Mark at enqueue: each of count cells occupies at most one slot.
            parent[next] = current;
            queue[tail++] = next;
        };
        if (x + 1 < width_)
            enqueue(current + 1);
        if (y + 1 < height_)
            enqueue(current + width_);
        if (x != 0)
            enqueue(current - 1);
        if (y != 0)
            enqueue(current - width_);
    }
    if (parent[target] == unseen)
        return refusal(CampaignRouteStatus::Unreachable);

    // Count the shortest path without materializing an over-AP route. Parent
    // links are immutable and this loop is independently bounded by count.
    std::uint32_t cursor = target;
    std::uint32_t steps = 0;
    while (cursor != start && steps < count) {
        if (cursor >= count || parent[cursor] == unseen)
            throw std::logic_error("Campaign route parent chain is invalid");
        cursor = parent[cursor];
        ++steps;
    }
    if (cursor != start || steps == 0)
        throw std::logic_error("Campaign route parent chain exceeds its bound");
    report.requiredAp = steps;
    if ((!allowPartial && steps > actor.ap) || actor.ap == 0)
        return refusal(CampaignRouteStatus::InsufficientAp);
    const auto advance_steps = allowPartial && steps > actor.ap ? actor.ap : steps;
    if (advance_steps > std::numeric_limits<std::uint32_t>::max() - revision_)
        return refusal(CampaignRouteStatus::RevisionOverflow);

    report.points.resize(static_cast<std::size_t>(advance_steps) + 1);
    cursor = target;
    // Discard the unaffordable suffix of the already validated parent chain.
    // Reconstruction still owns at most AP+1 points and uses <=count work.
    for (auto remaining = steps; remaining > advance_steps; --remaining)
        cursor = parent[cursor];
    for (std::size_t i = report.points.size(); i != 0; --i) {
        report.points[i - 1] = {static_cast<std::int32_t>(cursor % width_),
                                static_cast<std::int32_t>(cursor / width_)};
        if (i != 1)
            cursor = parent[cursor];
    }
    return report;
}

CampaignRouteCommandResult CampaignSession::move_route(std::uint32_t actorId, std::int32_t targetX,
                                                       std::int32_t targetY,
                                                       std::uint32_t expectedRevision) {
    return move_route_impl(actorId, targetX, targetY, expectedRevision, false);
}

CampaignRouteCommandResult CampaignSession::advance_route(std::uint32_t actorId,
                                                          std::int32_t targetX,
                                                          std::int32_t targetY,
                                                          std::uint32_t expectedRevision) {
    return move_route_impl(actorId, targetX, targetY, expectedRevision, true);
}

CampaignRouteCommandResult
CampaignSession::move_route_impl(std::uint32_t actorId, std::int32_t targetX, std::int32_t targetY,
                                 std::uint32_t expectedRevision, bool allowPartial) {
    const auto report =
        preview_route_impl(actorId, targetX, targetY, expectedRevision, allowPartial);
    if (report.status != CampaignRouteStatus::Ok)
        return {report.status, revision_, 0};
    auto staged = *this;
    for (std::size_t i = 1; i < report.points.size(); ++i) {
        const auto& point = report.points[i];
        const auto result = staged.move(actorId, point.x, point.y, staged.revision_);
        if (result.status == CampaignCommandStatus::FogRefused)
            return {CampaignRouteStatus::FogRefused, revision_, 0};
        if (!result.accepted())
            throw std::logic_error("Campaign route primitive check failed before publication");
    }
    actors_.swap(staged.actors_);
    fog_.swap(staged.fog_);
    revision_ = staged.revision_;
    return {CampaignRouteStatus::Ok, revision_,
            static_cast<std::uint32_t>(report.points.size() - 1)};
}

std::vector<std::uint8_t>
CampaignSession::encode_save(std::string_view campaignIdentity,
                             std::span<const std::uint8_t> worldRgb) const {
    if (production_) {
        auto legacy = *this;
        legacy.production_.reset();
        auto base = legacy.encode_save(campaignIdentity, worldRgb);
        auto production = production_->encode();
        const auto size = 20 + base.size() + production.size();
        if (size > campaign_session_save_max_bytes)
            throw std::runtime_error("Production checkpoint exceeds 1 MiB");
        std::vector<std::uint8_t> bytes(size, 0);
        constexpr std::string_view magic = "ORTWPROD";
        std::copy(magic.begin(), magic.end(), bytes.begin());
        write32(bytes, 8, static_cast<std::uint32_t>(base.size()));
        write32(bytes, 12, static_cast<std::uint32_t>(production.size()));
        std::copy(base.begin(), base.end(), bytes.begin() + 16);
        std::copy(production.begin(), production.end(), bytes.begin() + 16 + base.size());
        std::uint32_t crc = ~0u;
        for (std::size_t i = 0; i < size - 4; ++i) {
            crc ^= bytes[i];
            for (int bit = 0; bit < 8; ++bit) crc = (crc >> 1) ^ (0xedb88320u & (0u - (crc & 1u)));
        }
        write32(bytes, size - 4, ~crc);
        return bytes;
    }
    const auto count = validate_source(source_, width_, height_);
    if (count != actors_.size())
        throw std::runtime_error("Campaign save actor count disagrees with source");
    const bool journeys = orderRevision_ != 0 || fog_.has_value();
    const auto baseSize = save_extent(width_, height_, count, campaignIdentity, worldRgb, journeys);
    std::vector<std::uint8_t> fogBytes;
    if (fog_) {
        validate_fog_actors(*fog_, actors_, width_, height_, source_.factions.size());
        fogBytes = encode_campaign_fog_state(*fog_);
    }
    const auto size = std::uint64_t{baseSize} + fogBytes.size() + fogIdentity_.size();
    if (size > campaign_session_save_max_bytes)
        throw std::runtime_error("Campaign Save3 exceeds the 1 MiB save budget");
    validate_saved_state(source_, width_, height_, actors_, turn_, year_, season_, revision_,
                         orderRevision_);
    std::vector<std::uint8_t> bytes(size, 0);
    for (std::size_t i = 0; i < save_magic.size(); ++i)
        bytes[i] = save_magic[i];
    write32(bytes, 8, fog_ ? 3u : journeys ? 2u : 1u);
    write32(bytes, 12, save_rule_profile);
    write32(bytes, 16, static_cast<std::uint32_t>(size));
    write32(bytes, 20, static_cast<std::uint32_t>(campaignIdentity.size()));
    write32(bytes, 24, static_cast<std::uint32_t>(worldRgb.size()));
    write32(bytes, 28, width_);
    write32(bytes, 32, height_);
    write32(bytes, 36, static_cast<std::uint32_t>(count));
    write64(bytes, 40, turn_);
    write32(bytes, 48, std::bit_cast<std::uint32_t>(year_));
    write32(bytes, 52, season_ == Season::summer ? 0u : 1u);
    write32(bytes, 56, revision_);
    if (journeys)
        write32(bytes, 64, orderRevision_);
    if (fog_) {
        write32(bytes, 68, static_cast<std::uint32_t>(fogBytes.size()));
        write32(bytes, 72, static_cast<std::uint32_t>(fogIdentity_.size()));
    }
    std::size_t offset = journeys ? save2_header_bytes : save1_header_bytes;
    for (const char c : campaignIdentity)
        bytes[offset++] = static_cast<std::uint8_t>(static_cast<unsigned char>(c));
    for (const auto c : worldRgb)
        bytes[offset++] = c;
    for (const auto& actor : actors_) {
        write32(bytes, offset, std::bit_cast<std::uint32_t>(actor.currentX));
        write32(bytes, offset + 4, std::bit_cast<std::uint32_t>(actor.currentY));
        write32(bytes, offset + 8, actor.ap);
        if (journeys && actor.destination) {
            write32(bytes, offset + 12, 1);
            write32(bytes, offset + 16, std::bit_cast<std::uint32_t>(actor.destination->x));
            write32(bytes, offset + 20, std::bit_cast<std::uint32_t>(actor.destination->y));
        }
        offset += journeys ? save2_actor_bytes : save1_actor_bytes;
    }
    for (const char c : fogIdentity_)
        bytes[offset++] = static_cast<std::uint8_t>(static_cast<unsigned char>(c));
    for (const auto c : fogBytes)
        bytes[offset++] = c;
    return bytes;
}

CampaignSession CampaignSession::decode_save(const Campaign& source, std::uint32_t width,
                                             std::uint32_t height,
                                             std::string_view campaignIdentity,
                                             std::span<const std::uint8_t> worldRgb,
                                             std::span<const std::uint8_t> saveBytes,
                                             const CampaignFog* initialFog,
                                             std::string_view fogIdentity,
                                             std::shared_ptr<const ProductionCatalog> productionCatalog) {
    if (saveBytes.size() >= 8 && std::equal(saveBytes.begin(), saveBytes.begin() + 8, "ORTWPROD")) {
        if (!productionCatalog || saveBytes.size() < 20 || saveBytes.size() > campaign_session_save_max_bytes)
            throw std::runtime_error("Production save needs the matching building catalog");
        const auto baseSize = read32(saveBytes, 8), productionSize = read32(saveBytes, 12);
        if (std::uint64_t{baseSize} + productionSize + 20 != saveBytes.size())
            throw std::runtime_error("Invalid production save extent");
        std::uint32_t crc = ~0u;
        for (std::size_t i = 0; i < saveBytes.size() - 4; ++i) {
            crc ^= saveBytes[i];
            for (int bit = 0; bit < 8; ++bit) crc = (crc >> 1) ^ (0xedb88320u & (0u - (crc & 1u)));
        }
        if (~crc != read32(saveBytes, saveBytes.size() - 4))
            throw std::runtime_error("Production save checksum differs");
        auto next = decode_save(source, width, height, campaignIdentity, worldRgb,
                                saveBytes.subspan(16, baseSize), initialFog, fogIdentity);
        next.production_ = CampaignProduction::decode(source, std::move(productionCatalog),
                                                     saveBytes.subspan(16 + baseSize, productionSize));
        return next;
    }
    if (productionCatalog) throw std::runtime_error("Saved production state is missing");

    if (saveBytes.size() < save1_header_bytes || saveBytes.size() > campaign_session_save_max_bytes)
        throw std::runtime_error("Campaign save input extent is invalid");
    for (std::size_t i = 0; i < save_magic.size(); ++i)
        if (saveBytes[i] != save_magic[i])
            throw std::runtime_error("Campaign save magic is invalid");
    const auto version = read32(saveBytes, 8);
    const bool hasFog = version == 3;
    const bool journeys = version >= 2;
    if ((version < 1 || version > 3) || read32(saveBytes, 12) != save_rule_profile ||
        read32(saveBytes, 60) != 0)
        throw std::runtime_error("Campaign save version, profile or reserved field is invalid");
    if (initialFog && !hasFog)
        throw std::runtime_error(
            "Legacy Save1/2 has no explored fog history; cannot load into a fog-enabled session");
    if (hasFog && (!initialFog || fogIdentity.empty() || fogIdentity.size() > 256))
        throw std::runtime_error(
            "Save3 requires the loaded campaign fog inputs and source binding");
    if (journeys && saveBytes.size() < save2_header_bytes)
        throw std::runtime_error("Campaign journey save header is truncated");
    const auto order_revision = journeys ? read32(saveBytes, 64) : 0;
    if (journeys && (read32(saveBytes, 76) != 0 ||
                     (!hasFog && (order_revision == 0 || read32(saveBytes, 68) != 0 ||
                                  read32(saveBytes, 72) != 0))))
        throw std::runtime_error(
            "Campaign journey save order revision or reserved fields are invalid");
    validate_dimensions(width, height);
    const auto count = validate_source(source, width, height);
    const auto baseSize = save_extent(width, height, count, campaignIdentity, worldRgb, journeys);
    const auto fogBytes = hasFog ? read32(saveBytes, 68) : 0;
    const auto fogBindingBytes = hasFog ? read32(saveBytes, 72) : 0;
    if (hasFog && (fogBytes == 0 || fogBytes > campaign_session_save_max_bytes ||
                   fogBindingBytes != fogIdentity.size()))
        throw std::runtime_error("Campaign Save3 fog framing is invalid");
    const auto size = std::uint64_t{baseSize} + fogBytes + fogBindingBytes;
    if (saveBytes.size() != size || read32(saveBytes, 16) != size ||
        read32(saveBytes, 20) != campaignIdentity.size() ||
        read32(saveBytes, 24) != worldRgb.size() || read32(saveBytes, 28) != width ||
        read32(saveBytes, 32) != height || read32(saveBytes, 36) != count)
        throw std::runtime_error("Campaign save framing or source dimensions disagree");
    std::size_t offset = journeys ? save2_header_bytes : save1_header_bytes;
    for (const char c : campaignIdentity) {
        if (saveBytes[offset++] != static_cast<std::uint8_t>(static_cast<unsigned char>(c)))
            throw std::runtime_error("Campaign save source identity differs");
    }
    for (const auto c : worldRgb)
        if (saveBytes[offset++] != c)
            throw std::runtime_error("Campaign save world RGB differs");
    const auto season_word = read32(saveBytes, 52);
    if (season_word > 1)
        throw std::runtime_error("Campaign save season is invalid");

    auto staged = create(source, width, height);
    if (hasFog)
        validate_fog_actors(*initialFog, staged.actors_, width, height, source.factions.size());
    staged.turn_ = read64(saveBytes, 40);
    staged.year_ = std::bit_cast<std::int32_t>(read32(saveBytes, 48));
    staged.season_ = season_word == 0 ? Season::summer : Season::winter;
    staged.revision_ = read32(saveBytes, 56);
    staged.orderRevision_ = order_revision;
    for (auto& actor : staged.actors_) {
        actor.currentX = std::bit_cast<std::int32_t>(read32(saveBytes, offset));
        actor.currentY = std::bit_cast<std::int32_t>(read32(saveBytes, offset + 4));
        actor.ap = read32(saveBytes, offset + 8);
        if (journeys) {
            const auto flag = read32(saveBytes, offset + 12);
            const auto x = read32(saveBytes, offset + 16);
            const auto y = read32(saveBytes, offset + 20);
            if (flag > 1 || (flag == 0 && (x != 0 || y != 0)))
                throw std::runtime_error(
                    "Campaign journey save destination flag or padding is invalid");
            if (flag != 0)
                actor.destination = CampaignRoutePoint{std::bit_cast<std::int32_t>(x),
                                                       std::bit_cast<std::int32_t>(y)};
        }
        offset += journeys ? save2_actor_bytes : save1_actor_bytes;
    }
    validate_saved_state(staged.source_, width, height, staged.actors_, staged.turn_, staged.year_,
                         staged.season_, staged.revision_, staged.orderRevision_);
    if (hasFog) {
        for (const char c : fogIdentity)
            if (saveBytes[offset++] != static_cast<std::uint8_t>(static_cast<unsigned char>(c)))
                throw std::runtime_error("Campaign Save3 fog input identity differs");
        auto restored = decode_campaign_fog_state(*initialFog, saveBytes.subspan(offset, fogBytes));
        validate_fog_actors(restored, staged.actors_, width, height, source.factions.size());
        const auto original = initialFog->snapshot();
        const auto saved = restored.snapshot();
        // This session only moves characters. The codec admits generic position
        // updates; structures must remain at their source-defined positions here.
        for (std::size_t i = staged.actors_.size(); i < original.observers.size(); ++i)
            if (original.observers[i].observer != saved.observers[i].observer)
                throw std::runtime_error("Campaign Save3 changed a static structure observer");
        staged.fog_ = std::move(restored);
        staged.fogIdentity_ = fogIdentity;
    }
    return staged;
}

} // namespace openrtw
