#include "settlement_view.hpp"

#include "regions.hpp"

#include <set>
#include <stdexcept>

namespace openrtw {
namespace {

struct InspectionBudget {
    std::size_t bytes = 0;
    std::size_t records = 0;

    void text(const std::string& value) {
        if (value.size() > campaign_max_retained_bytes - bytes)
            throw std::runtime_error("Settlement inspection text budget exceeded");
        bytes += value.size();
    }

    void rows(std::size_t count) {
        if (count > campaign_max_records - records)
            throw std::runtime_error("Settlement inspection record budget exceeded");
        records += count;
    }
};

std::size_t validate_source(const Campaign& source) {
    InspectionBudget budget;
    // Also bounds the source indices before their uint32_t conversion, even
    // for manually assembled Campaign objects with many empty factions.
    budget.rows(source.factions.size());
    std::size_t settlements = 0;
    std::size_t buildings = 0;
    std::set<std::string_view> regions;
    for (const auto& faction : source.factions) {
        if (faction.settlements.size() > campaign_max_settlement_blocks - settlements)
            throw std::runtime_error("Settlement inspection settlement budget exceeded");
        settlements += faction.settlements.size();
        budget.rows(faction.settlements.size());
        for (const auto& settlement : faction.settlements) {
            if (settlement.region.empty() || !regions.insert(settlement.region).second)
                throw std::runtime_error("Settlement inspection requires unique nonempty regions");
            // sourceFaction is stored once per inspection row, so account for
            // those actual copies rather than one string per source faction.
            budget.text(faction.id);
            budget.text(settlement.region);
            budget.text(settlement.level);
            budget.text(settlement.planSet);
            budget.text(settlement.factionCreator);
            budget.rows(settlement.source.size());
            for (const auto& line : settlement.source)
                budget.text(line.text);
            if (settlement.buildings.size() > campaign_max_buildings_per_settlement ||
                settlement.buildings.size() > campaign_max_total_settlement_buildings - buildings)
                throw std::runtime_error("Settlement inspection building budget exceeded");
            buildings += settlement.buildings.size();
            budget.rows(settlement.buildings.size());
            for (const auto& building : settlement.buildings) {
                budget.rows(building.source.size());
                for (const auto& line : building.source)
                    budget.text(line.text);
            }
        }
    }
    return settlements;
}

} // namespace

SettlementView SettlementView::create(const Campaign& source) {
    const auto count = validate_source(source);
    SettlementView view;
    view.records_.reserve(count);
    for (std::size_t factionIndex = 0; factionIndex < source.factions.size(); ++factionIndex) {
        const auto& faction = source.factions[factionIndex];
        for (std::size_t settlementIndex = 0; settlementIndex < faction.settlements.size();
             ++settlementIndex) {
            view.records_.push_back({static_cast<std::uint32_t>(view.records_.size()),
                                     static_cast<std::uint32_t>(factionIndex),
                                     static_cast<std::uint32_t>(settlementIndex), faction.line,
                                     faction.id, faction.settlements[settlementIndex]});
        }
    }
    return view;
}

const SettlementInspection* SettlementView::find(std::string_view region) const noexcept {
    for (const auto& row : records_)
        if (row.settlement.region == region)
            return &row;
    return nullptr;
}

const SettlementInspection* SettlementView::selected() const noexcept {
    if (!selected_ || *selected_ >= records_.size())
        return nullptr;
    return &records_[*selected_];
}

std::optional<std::uint32_t> SettlementView::selected_id() const noexcept {
    return selected() ? selected_ : std::nullopt;
}

bool SettlementView::select(std::uint32_t id) noexcept {
    if (id >= records_.size())
        return false;
    selected_ = id;
    return true;
}

bool SettlementView::select_region(std::string_view region) noexcept {
    const auto* row = find(region);
    return row && select(row->id);
}

const RegionDefinition* find_settlement_region(const SettlementInspection& settlement,
                                               const RegionDefinitions& definitions) noexcept {
    const RegionDefinition* match = nullptr;
    for (const auto& region : definitions.definitions) {
        if (region.id != settlement.settlement.region)
            continue;
        if (match)
            return nullptr;
        match = &region;
    }
    return match;
}

} // namespace openrtw
