#pragma once

#include "campaign.hpp"

#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace openrtw {

// Bounded OpenRTW readers, not original parser capacities or battle rules.
inline constexpr std::size_t battle_catalog_max_input_bytes = 2 * 1024 * 1024;
inline constexpr std::size_t battle_catalog_max_line_bytes = 65536;
inline constexpr std::size_t battle_catalog_max_records = 4096;
inline constexpr std::size_t battle_catalog_max_fields = 65536;
inline constexpr std::size_t battle_catalog_max_fields_per_record = 4096;
inline constexpr std::size_t battle_catalog_max_owned_bytes = 8 * 1024 * 1024;
inline constexpr std::size_t battle_catalog_max_roster_records = 100000;

struct BattleSourceField {
    std::size_t line = 0;
    std::string key;
    // Trimmed field value before the first semicolon; numeric values remain
    // opaque except the second soldier CSV component described below.
    std::string value;
    // Exact physical line, including indentation/comments, without CRLF/LF.
    std::string source;
};

struct UnitDefinition {
    std::string type, dictionary, category, unitClass, soldierModel;
    // Literal nonnegative int32 from soldier CSV component2. This is neither
    // an effective battle troop count nor a replacement for Campaign::Unit.
    std::int32_t sourceSoldierCount = 0;
    std::size_t line = 0;
    // Every non-type field, including the typed singleton fields, in source
    // order. Repeated officer/unknown fields are retained individually.
    std::vector<BattleSourceField> fields;
};

struct ModelDefinition {
    std::string type;
    std::size_t line = 0;
    // Repeated texture/flexi/sprite/skeleton variants stay ordered and raw.
    // No resource, skeleton, faction texture or LOD is selected or opened.
    std::vector<BattleSourceField> fields;
};

struct UnitDefinitions {
    std::string sourceBytes;
    std::vector<UnitDefinition> records;
};

struct BattleModels {
    std::string sourceBytes;
    std::vector<ModelDefinition> records;
};

// Flat line-oriented subset: spaces/tabs, LF/CRLF and semicolon comments.
// Unit type may contain spaces; dictionary/category/class are nonempty single
// tokens, soldier is exactly4 nonempty CSV fields with an identifier model
// and a strict nonnegative decimal int32 count. Each unit requires one of all
// four typed fields. Model IDs are ASCII letters/underscore then letters,
// digits/underscore, and each model needs model_flexi/model_flexi_m/_c.
// All other field values are opaque. Duplicate types/singletons, missing
// fields, fields before type, NUL/control bytes and limits refuse atomically.
// Complete results own their storage, including the exact full source bytes.
UnitDefinitions load_unit_definitions(std::string_view input);
BattleModels load_battle_models(std::string_view input);

// Exact case-sensitive lookup; nullptr means missing, with no fallback.
// Returned pointers borrow the catalog until its records are mutated/destroyed.
const UnitDefinition* find_unit_definition(const UnitDefinitions& definitions,
                                           std::string_view type) noexcept;
const ModelDefinition* find_battle_model(const BattleModels& models,
                                         std::string_view type) noexcept;

struct BattleRosterEntry {
    std::size_t sourceFactionIndex = 0, sourceCharacterIndex = 0, sourceArmyIndex = 0;
    std::size_t unitDefinitionIndex = 0, modelDefinitionIndex = 0;
    // Owned copy of the literal campaign unit: optional count/experience/
    // armour/weapon remain separate from the unit definition's soldier count.
    Unit sourceUnit;
};

struct CampaignBattleRoster {
    // Faction, character, then army source order. Indices are call-local joins
    // into the supplied catalogs, not pointers or original runtime identities.
    std::vector<BattleRosterEntry> records;
};

// Exact army.name -> unit.type -> soldierModel -> model.type joins. Missing
// names, duplicate/invalid supplied catalog IDs and budgets throw runtime_error.
// Inputs are const/stable during the call; no partial output/borrow escapes.
// No ownership, battle deployment, effective count, stats, combat or model
// selection behavior is inferred. Catalog field/source metadata stays raw.
CampaignBattleRoster build_campaign_battle_roster(const Campaign& campaign,
                                                  const UnitDefinitions& definitions,
                                                  const BattleModels& models);

} // namespace openrtw
