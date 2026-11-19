#include "campaign_production.hpp"
#include <iostream>
#include <limits>
#include <string>

using namespace openrtw;

namespace {
int failures = 0;
void check(bool condition, const std::string& name) {
    std::cout << (condition ? "PASS " : "FAIL ") << name << '\n';
    if (!condition)
        ++failures;
}

const char* buildingSource = R"(
building core_building
{
 levels house villa
 {
  house requires factions { roman, }
  {
   capability { }
   construction 1
   cost 10
   settlement_min village
   upgrades { villa }
  }
  villa requires factions { roman, }
  {
   capability { }
   construction 2
   cost 20
   settlement_min town
   upgrades { }
  }
 }
}
building barracks
{
 levels militia army
 {
  militia requires factions { roman, }
  {
   capability { recruit "test infantry" 1 requires factions { roman, } }
   construction 1
   cost 30
   settlement_min village
   upgrades { army }
  }
  army requires factions { roman, } and building_present_min_level core_building villa
  {
   capability { recruit "test infantry" 2 requires factions { roman, } }
   construction 2
   cost 40
   settlement_min town
   upgrades { }
  }
 }
}
building absent_resource
{
 levels root
 {
  root requires not resource absent
  {
   capability { }
   construction 1
   cost 50
   settlement_min village
   upgrades { }
  }
 }
}
building present_resource
{
 levels root
 {
  root requires resource iron
  {
   capability { }
   construction 1
   cost 60
   settlement_min village
   upgrades { }
  }
 }
}
building hidden
{
 levels root
 {
  root requires not hidden_resource secret
  {
   capability { }
   construction 1
   cost 70
   settlement_min village
   upgrades { }
  }
 }
}
)";

UnitDefinitions makeUnits() {
    UnitDefinitions units;
    units.sourceBytes = "production correctness unit fixture";
    UnitDefinition unit;
    unit.type = "test infantry";
    unit.category = "infantry";
    unit.sourceSoldierCount = 40;
    unit.fields = {{1, "ownership", "roman", ""}, {2, "stat_cost", "2, 100, 10, 0, 0, 0", ""}};
    units.records.push_back(unit);
    return units;
}

Campaign makeCampaign() {
    Campaign source;
    source.id = "production-correctness";
    source.startYear = -270;
    source.startSeason = Season::summer;
    Faction faction;
    faction.id = "romans_julii";
    faction.denari = 10000;
    Settlement city;
    city.region = "test_region";
    city.level = "village";
    city.population = 800;
    city.buildings.push_back(
        {1, {{1, "type core_building house"}, {2, "type barracks militia"}}});
    faction.settlements.push_back(city);
    Character actor;
    actor.name = "Commander";
    actor.type = "named character";
    source.factions.push_back(faction);
    source.factions[0].characters.push_back(actor);
    return source;
}

std::size_t building(const ProductionCatalog& catalog, std::string_view chain,
                     std::string_view level) {
    for (std::size_t i = 0; i < catalog.buildings.size(); ++i)
        if (catalog.buildings[i].chain == chain && catalog.buildings[i].level == level)
            return i;
    throw std::runtime_error("missing fixture building");
}

std::shared_ptr<ProductionCatalog> makeCatalog(const UnitDefinitions& units) {
    auto catalog = load_production_catalog(buildingSource, units);
    catalog->cultures["romans_julii"] = "roman";
    catalog->resources["test_region"] = {"iron"};
    return catalog;
}

void projectedCoreAndReorderContinuation() {
    auto source = makeCampaign();
    auto catalog = makeCatalog(makeUnits());
    const auto villa = building(*catalog, "core_building", "villa");
    const auto army = building(*catalog, "barracks", "army");
    auto state = CampaignProduction::create(source, catalog);
    try {
        state.enqueue(0, villa, false);
        check(state.building_reason(0, army, true).empty(),
              "projected core upgrade supplies settlement tier and building prerequisite");
        state.enqueue(0, army, false);
        state.reorder(0, 1, 0, false);
        state.advance();
        check(state.cities[0].construction.front().definition == army &&
                  state.cities[0].construction.front().remaining == 2 &&
                  state.cities[0].buildings.at("core_building") == "house",
              "reordered dependent head blocks without progress or partial completion");
        state.reorder(0, 1, 0, false);
        const auto snapshot = state.encode();
        auto restored = CampaignProduction::decode(source, catalog, snapshot);
        check(restored.encode() == snapshot, "reordered queue encode/decode is byte exact");
        for (int turn = 0; turn < 4; ++turn) {
            state.advance();
            restored.advance();
            check(state.encode() == restored.encode(),
                  "reordered prerequisite continuation remains identical at turn " +
                      std::to_string(turn + 1));
        }
        check(state.cities[0].construction.empty() && state.cities[0].level == "town" &&
                  state.cities[0].buildings.at("core_building") == "villa" &&
                  state.cities[0].buildings.at("barracks") == "army" &&
                  state.treasury[0] == 10000 - 20 - 40,
              "reordered prerequisite queue completes each building once with exact funds");
    } catch (const std::exception& error) {
        check(false, std::string("projected queue/reorder probe threw: ") + error.what());
    }
}

void resourcesAndMalformedExpressions() {
    auto source = makeCampaign();
    auto catalog = makeCatalog(makeUnits());
    auto state = CampaignProduction::create(source, catalog);
    check(state.building_reason(0, building(*catalog, "absent_resource", "root")).empty(),
          "not resource absent is satisfied for an absent ordinary resource");
    check(state.building_reason(0, building(*catalog, "present_resource", "root")).empty(),
          "present ordinary resource is satisfied");
    check(state.building_reason(0, building(*catalog, "hidden", "root")) ==
              "Unsupported prerequisite expression",
          "hidden-resource inversion remains explicitly unsupported");

    const std::string marker = "root requires not resource absent";
    const std::string replacement = "root requires ";
    const std::string expressions[] = {
        "factions { roman } and",
        "factions { roman } or or factions { roman }",
        "not",
        "building_present_min_level core_building",
        "resource",
        "factions roman",
        "factions { roman } garbage factions { roman }",
        "unknown_rule",
    };
    for (const auto& expression : expressions) {
        std::string input = buildingSource;
        const auto at = input.find(marker);
        input.replace(at, marker.size(), replacement + expression);
        try {
            auto malformed = load_production_catalog(input, makeUnits());
            malformed->cultures["romans_julii"] = "roman";
            auto malformedState = CampaignProduction::create(source, malformed);
            check(malformedState.building_reason(
                      0, building(*malformed, "absent_resource", "root")) ==
                      "Unsupported prerequisite expression",
                  "malformed prerequisite fails closed: " + expression);
        } catch (const std::exception& error) {
            check(false, "malformed prerequisite unexpectedly threw: " + expression + ": " + error.what());
        }
    }
}

void duplicateUnitAdmission() {
    auto units = makeUnits();
    UnitDefinition duplicate = units.records.front();
    duplicate.sourceSoldierCount = 80;
    units.records.push_back(duplicate);
    bool rejected = false;
    try {
        (void)makeCatalog(units);
    } catch (const std::exception& error) {
        rejected = std::string(error.what()).find("duplicate unit") != std::string::npos;
    }
    check(rejected, "duplicate unit names refuse at catalog admission");
}

void armyCapacityOverflow() {
    auto source = makeCampaign();
    auto catalog = makeCatalog(makeUnits());
    auto state = CampaignProduction::create(source, catalog);
    const Unit unit{"test infantry", 40, 0, 0, 0, 0};
    state.cities[0].garrison.push_back(unit);
    state.additions[0].push_back(unit);
    const auto before = state.encode();
    bool refused = false;
    try {
        state.transfer(0, 0, 0, std::numeric_limits<std::size_t>::max());
    } catch (...) {
        refused = true;
    }
    check(refused && state.encode() == before && state.additions[0].size() == 1 &&
              state.cities[0].garrison.size() == 1,
          "overflowing army-size input refuses without transfer or mutation");
}

void populationAndGarrisonInvariant() {
    auto source = makeCampaign();
    source.factions[0].settlements[0].population = 41;
    auto catalog = makeCatalog(makeUnits());
    auto state = CampaignProduction::create(source, catalog);
    state.enqueue(0, 0, true);
    state.advance();
    check(state.cities[0].population == 41 && state.cities[0].garrison.empty(),
          "recruitment does not deduct population before completion");
    state.advance();
    check(state.cities[0].population == 1 && state.cities[0].garrison.size() == 1,
          "recruitment completion leaves positive population and one garrison unit");
    state.enqueue(0, 0, true);
    state.advance();
    check(state.cities[0].population == 1 && state.cities[0].garrison.size() == 1 &&
              state.cities[0].recruitment.front().remaining == 2,
          "insufficient population blocks without duplicating soldiers or progress");
    state.cancel(0, 0, true);
    check(state.treasury[0] == 10000 - 100 && state.cities[0].recruitment.empty(),
          "blocked recruitment cancel refunds exactly its paid cost");
}

void armyCapacityBoundaries() {
    const auto source = makeCampaign();
    const auto catalog = makeCatalog(makeUnits());
    const Unit unit{"test infantry", 40, 0, 0, 0, 0};
    struct Case { std::size_t initial, additional; bool admitted; };
    const Case cases[] = {{19, 0, true}, {19, 1, false}, {20, 0, false}, {0, 20, false}};
    for (const auto& row : cases) {
        auto state = CampaignProduction::create(source, catalog);
        state.cities[0].garrison.push_back(unit);
        state.additions[0].assign(row.additional, unit);
        const auto before = state.encode();
        bool admitted = true;
        try { state.transfer(0, 0, 0, row.initial); }
        catch (const std::exception&) { admitted = false; }
        check(admitted == row.admitted &&
                  (admitted ? state.additions[0].size() == row.additional + 1 &&
                                  state.cities[0].garrison.empty()
                            : state.encode() == before),
              "army capacity boundary initial=" + std::to_string(row.initial) +
                  " additions=" + std::to_string(row.additional));
    }
}
} // namespace

int main() {
    projectedCoreAndReorderContinuation();
    resourcesAndMalformedExpressions();
    duplicateUnitAdmission();
    armyCapacityOverflow();
    armyCapacityBoundaries();
    populationAndGarrisonInvariant();
    std::cout << "FAILURES " << failures << '\n';
    return failures ? 1 : 0;
}
