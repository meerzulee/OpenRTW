#pragma once
#include "campaign.hpp"
#include "battle_catalog.hpp"
#include <map>
#include <memory>
#include <set>
#include <span>
#include <string>
#include <vector>

namespace openrtw {
// Explicit playable production policy. Native economy/phase/refund parity is not implied.
struct ProductionToken {
    std::string text;
    std::size_t line = 0, close = 0;
    int depth = 0;
};
struct ProductionRecruit {
    std::string unit;
    int experience = 0;
    std::vector<std::string> requirements;
};
struct ProductionBuilding {
    std::string chain, level, settlementMin;
    std::uint32_t cost = 0, turns = 0;
    std::vector<std::string> requirements, upgrades, effects;
    std::vector<ProductionRecruit> recruits;
};
struct ProductionUnit {
    std::string name, category;
    std::uint32_t cost = 0, turns = 0, soldiers = 0;
    std::vector<std::string> ownership;
};
struct ProductionCatalog {
    std::string identity;
    std::vector<ProductionBuilding> buildings;
    std::vector<ProductionUnit> units;
    std::map<std::string, std::string> cultures;
    std::map<std::string, std::vector<std::string>> resources;
    const ProductionBuilding* building(std::string_view chain, std::string_view level) const;
    const ProductionUnit* unit(std::string_view name) const;
};
std::shared_ptr<ProductionCatalog> load_production_catalog(std::string_view buildings,
                                                           const UnitDefinitions& units);
struct ProductionJob {
    std::uint32_t definition = 0, remaining = 0, total = 0, paid = 0;
    int experience = 0;
};
struct ProductionCity {
    std::uint32_t faction = 0, population = 0;
    std::string region, level;
    std::map<std::string, std::string> buildings;
    std::vector<ProductionJob> construction, recruitment;
    std::vector<Unit> garrison;
};
struct CampaignProduction {
    std::shared_ptr<const ProductionCatalog> catalog;
    std::vector<std::int64_t> treasury;
    std::vector<ProductionCity> cities;
    std::vector<std::vector<Unit>> additions;
    bool marianReforms = false;
    static CampaignProduction create(const Campaign&, std::shared_ptr<const ProductionCatalog>);
    std::string building_reason(std::size_t city, std::size_t definition,
                                bool projected = false) const;
    std::string recruit_reason(std::size_t city, std::size_t definition) const;
    void enqueue(std::size_t city, std::size_t definition, bool recruitment);
    void cancel(std::size_t city, std::size_t position, bool recruitment);
    void reorder(std::size_t city, std::size_t from, std::size_t to, bool recruitment);
    void advance();
    void transfer(std::size_t city, std::size_t row, std::size_t actor, std::size_t sourceArmySize);
    std::vector<std::uint8_t> encode() const;
    static CampaignProduction decode(const Campaign&, std::shared_ptr<const ProductionCatalog>,
                                     std::span<const std::uint8_t>);

private:
    std::vector<std::string> factions;
    std::string requirement_reason(const ProductionCity&, const std::vector<std::string>&) const;
};
} // namespace openrtw
