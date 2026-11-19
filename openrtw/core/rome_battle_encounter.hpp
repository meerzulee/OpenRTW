#pragma once

#include "battle_session.hpp"
#include "campaign_session.hpp"

namespace openrtw {

// Rome owns selected actor/army/catalog joins and the copied campaign origin.
// Both results own their data. Neither path mutates campaign state or applies
// battle results; native casualties/retreat/capture/aftermath remain unproven.
BattleEncounter make_rome_battle_encounter(const CampaignSession&, const UnitDefinitions&,
                                         const BattleModels&, std::uint32_t playerActorId,
                                         std::uint32_t enemyActorId);
BattleSession create_rome_battle_session(const CampaignSession&, const UnitDefinitions&,
                                       const BattleModels&, std::uint32_t playerActorId,
                                       std::uint32_t enemyActorId);

} // namespace openrtw
