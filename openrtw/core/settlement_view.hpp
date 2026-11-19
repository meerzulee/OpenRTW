#pragma once

#include "campaign.hpp"

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace openrtw {

struct RegionDefinition;
struct RegionDefinitions;

struct SettlementInspection {
    // Flat zero-based identity in faction/settlement source order. This is a
    // view-local ID, not an original runtime-object identity or map position.
    std::uint32_t id = 0;
    std::uint32_t sourceFactionIndex = 0;
    std::uint32_t sourceSettlementIndex = 0;
    std::size_t sourceFactionLine = 0;
    // Containing source section and literal settlement.factionCreator remain
    // separate. Neither establishes a recovered current-owner rule.
    std::string sourceFaction;
    Settlement settlement;
};

// Read-only source inspection plus independent UI selection. It owns only the
// inspected records; there is no CampaignSession reference, simulation command,
// economy, construction or capture state. Recreate it when replacing a campaign;
// source-local IDs and selection are not persisted in campaign saves.
class SettlementView {
public:
    // Copies complete literal settlements/building blocks after validating
    // identity and campaign record/text/building budgets. Empty/duplicate region
    // IDs refuse as OpenRTW inspection policy. Throws without publishing a view.
    static SettlementView create(const Campaign& source);

    const std::vector<SettlementInspection>& records() const noexcept { return records_; }
    const SettlementInspection* find(std::string_view region) const noexcept;
    const SettlementInspection* selected() const noexcept;
    std::optional<std::uint32_t> selected_id() const noexcept;

    // Exact identities only; no trimming or case folding. A repeat succeeds,
    // invalid IDs/regions return false and retain the previous selection.
    // These operations allocate nothing and never alter inspected records.
    bool select(std::uint32_t id) noexcept;
    bool select_region(std::string_view region) noexcept;
    void clear() noexcept { selected_.reset(); }

    // References/pointers from records/find/selected survive select/clear and
    // expire when this view is assigned, moved from, or destroyed. No caller
    // Campaign/Regions storage is borrowed by this class.

private:
    SettlementView() = default;
    std::vector<SettlementInspection> records_;
    std::optional<std::uint32_t> selected_;
};

// Optional exact-ID source join. Missing/ambiguous IDs return nullptr; there is
// no guessed display-name, owner or coordinate fallback. The result borrows
// definitions and expires when that storage is changed or destroyed. Region
// field2/3/4 remain literal source fields with their existing qualified meaning.
const RegionDefinition* find_settlement_region(const SettlementInspection& settlement,
                                               const RegionDefinitions& definitions) noexcept;

} // namespace openrtw
