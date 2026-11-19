#pragma once

#include "campaign_fog.hpp"

#include <cstddef>
#include <cstdint>
#include <span>
#include <vector>

namespace openrtw {

// OpenRTW internal fog codec version 1, NOT native Rome .sav compatibility.
// Stores one explored bit per cell/table plus active observer specifications;
// counters and LOS footprints are regenerated from the supplied terrain.
// The containing save must bind source/terrain identity and enforce its own
// aggregate size cap. This cap applies only to the fog payload.
inline constexpr std::size_t campaign_fog_save_max_bytes = 1024 * 1024;

std::vector<std::uint8_t> encode_campaign_fog_state(const CampaignFog& fog);

// `initial` is the authoritative INITIAL campaign projection, not the current
// session. Exact dimensions, capacity, aliases, active IDs, factions, radii and
// eye bits must match; only observer positions and explored history may differ.
// The owner additionally validates that only actor positions may change and
// binds them to saved actors; structures must stay at their source positions.
// Rejects lost initial exploration, unexplored current-visible cells, malformed
// framing, nonzero padding and unsupported updates. Extra remembered cells are
// preserved history, not proof that a particular route was traversed.
// Returns a deeply owned staged value with preallocated update scratch. Neither
// input is mutated; validation/resource failures throw without publication.
CampaignFog decode_campaign_fog_state(const CampaignFog& initial,
                                      std::span<const std::uint8_t> bytes);

} // namespace openrtw
