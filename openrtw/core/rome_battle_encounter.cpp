#include "rome_battle_encounter.hpp"

#include <stdexcept>
#include <string_view>
#include <utility>

namespace openrtw {
namespace {
static_assert(sizeof(BattleSourceActor) == sizeof(CampaignActor),
              "source snapshot preserves the counted origin storage budget");
const CampaignActor& actor_by_id(const CampaignSession& campaign, std::uint32_t id) {
    if (id >= campaign.actors().size() || campaign.actors()[id].id != id)
        throw std::runtime_error("battle: invalid campaign actor ID");
    return campaign.actors()[id];
}
BattleSourceActor copy_actor(const CampaignActor& actor) {
    BattleSourceActor result{actor.id, actor.sourceFactionIndex, actor.sourceCharacterIndex,
                            actor.sourceLine, actor.initialX, actor.initialY, actor.currentX,
                            actor.currentY, actor.ap, actor.maxAp, {}};
    if (actor.destination)
        result.destination = BattlePoint{actor.destination->x, actor.destination->y};
    return result;
}
const UnitDefinition& selected_definition(const UnitDefinitions& definitions, std::string_view name) {
    const UnitDefinition* found = nullptr;
    for (const auto& row : definitions.records)
        if (row.type == name) {
            if (found)
                throw std::runtime_error("battle: duplicate selected unit definition");
            found = &row;
        }
    if (!found)
        throw std::runtime_error("battle: selected unit definition missing");
    return *found;
}
void require_model(const BattleModels& models, std::string_view name) {
    std::size_t matches = 0;
    for (const auto& row : models.records)
        if (row.type == name)
            ++matches;
    if (matches != 1)
        throw std::runtime_error("battle: selected model definition missing or duplicate");
}
} // namespace

BattleEncounter make_rome_battle_encounter(const CampaignSession& campaign,
                                         const UnitDefinitions& definitions,
                                         const BattleModels& models, std::uint32_t playerActorId,
                                         std::uint32_t enemyActorId) {
    if (playerActorId == enemyActorId)
        throw std::runtime_error("battle: two distinct actors required");
    if (definitions.records.size() > battle_catalog_max_records ||
        models.records.size() > battle_catalog_max_records)
        throw std::runtime_error("battle: catalog record budget exceeded");
    BattleEncounter result;
    result.origin.campaignId = campaign.source().id;
    result.origin.revision = campaign.revision();
    result.origin.orderRevision = campaign.order_revision();
    result.origin.turn = campaign.turn();
    result.origin.year = campaign.year();
    result.origin.season = campaign.season();
    validate_battle_encounter_budget(result);
    for (std::size_t side = 0; side < result.armies.size(); ++side) {
        const auto& actor = actor_by_id(campaign, side == 0 ? playerActorId : enemyActorId);
        if (actor.sourceFactionIndex >= campaign.source().factions.size())
            throw std::runtime_error("battle: invalid source faction join");
        const auto& faction = campaign.source().factions[actor.sourceFactionIndex];
        if (actor.sourceCharacterIndex >= faction.characters.size())
            throw std::runtime_error("battle: invalid source character join");
        const auto& character = faction.characters[actor.sourceCharacterIndex];
        const auto formations = campaign.army(actor.id);
        if (formations.empty() || formations.size() > battle_session_max_team_units)
            throw std::runtime_error("battle: selected army must have 1..20 formations");
        auto& origin = side == 0 ? result.origin.player : result.origin.opponent;
        origin.actor = copy_actor(actor);
        origin.name = character.name;
        origin.type = character.type;
        origin.sourceFaction = faction.id;
        validate_battle_encounter_budget(result);
        auto& army = result.armies[side];
        army.reserve(formations.size());
        for (const auto& source : formations) {
            BattleEncounterFormation row;
            row.profile = load_battle_unit_profile(selected_definition(definitions, source.name));
            require_model(models, row.profile.model);
            row.sourceUnit = source;
            (void)inspect_battle_formation(row);
            army.push_back(std::move(row));
            validate_battle_encounter_budget(result);
        }
    }
    validate_battle_encounter(result);
    return result;
}

BattleSession create_rome_battle_session(const CampaignSession& campaign,
                                       const UnitDefinitions& definitions, const BattleModels& models,
                                       std::uint32_t playerActorId, std::uint32_t enemyActorId) {
    return BattleSession::create(make_rome_battle_encounter(campaign, definitions, models,
                                                          playerActorId, enemyActorId));
}

} // namespace openrtw
