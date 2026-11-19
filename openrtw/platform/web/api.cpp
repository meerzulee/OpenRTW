#include "campaign.hpp"
#include "campaign_session.hpp"
#include "campaign_production_json.hpp"
#include "campaign_fog_inputs.hpp"
#include "settlement_view.hpp"
#include "campaign_json.hpp"
#include "battle_catalog.hpp"
#include "battle_session.hpp"
#include "rome_battle_encounter.hpp"
#include "cas_mesh.hpp"
#include "campaign_shadows.hpp"
#include "cas_animation.hpp"
#include "cas-animation-json.hpp"
#include "dds_texture.hpp"
#include "terrain.hpp"
#include "regions.hpp"
#include "world_grid.hpp"
#include "categories.hpp"
#include "climates.hpp"
#include "aerial_campaign_compositor.hpp"
#include "aerial_decals.hpp"
#include "faction_cultures.hpp"
#include "culture_models.hpp"
#include "settlement_models.hpp"
#include "campaign_trees.hpp"
#include <bit>
#include "pcm.hpp"

#include <algorithm>
#include <array>
#include <charconv>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <limits>
#include <optional>
#include <span>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#ifdef __EMSCRIPTEN__
#include <emscripten/heap.h>
#endif

// Single-threaded data and campaign-command ABI for the new engine. Native callers own a
// readable input span for the duration of a call; WASM spans are additionally
// checked against linear memory. Output pointers are module-owned and remain
// valid until a successful replacement of that data or reset. Session JSON
// is also replaced by successful moves/turns; command tokens bind its generation
// and revision. Failed commands preserve the whole session publication. Failed loads
// change only the bounded error buffer. Memory growth can invalidate JS views;
// callers copy the output after all loading calls have finished.
namespace {

// Engine-defined module identity, not a claim about the user's asset edition.
// These queries are immutable and do not read or mutate any publication slot.
constexpr char core_contract_json[] =
    "{\"schema\":\"openrtw-core-contract-v1\",\"apiVersion\":1,"
    "\"gameId\":\"rome-original\",\"hostApiVersion\":\"openrtw.web.host/v1\","
    "\"rulesVersion\":\"rome-original-1.5-partial-v2\","
    "\"publicationModel\":\"module-owned-slots-v1\"}";

constexpr std::size_t error_bytes = 1024;
constexpr std::size_t settlement_inspection_max_bytes = 4 * 1024 * 1024;
constexpr std::uint64_t max_hgt_bytes = 8 + openrtw::max_terrain_samples * 4;
std::unique_ptr<openrtw::Terrain> terrain;
std::unique_ptr<openrtw::Campaign> campaign;
std::string campaign_json;
std::unique_ptr<openrtw::SettlementView> settlement_view;
std::string settlement_inspection_json;
std::unique_ptr<openrtw::CampaignSession> campaign_session;
std::string campaign_session_json;
std::string campaign_production_json;
std::unique_ptr<openrtw::FogTraits> campaign_fog_traits;
std::unique_ptr<openrtw::FogAncillaries> campaign_fog_ancillaries;
std::unique_ptr<openrtw::RgbImage> campaign_fog_features;
std::unique_ptr<openrtw::CampaignFog> campaign_fog_initial;
std::string campaign_fog_wire, campaign_fog_policy, campaign_fog_reason;
std::vector<std::string> campaign_fog_limitations;
std::vector<std::uint8_t> campaign_save;
std::string campaign_route_json;
std::string campaign_advance_json;
std::string campaign_faction_journeys_json;
std::unique_ptr<openrtw::UnitDefinitions> unit_definitions;
std::unique_ptr<openrtw::BattleModels> battle_models;
std::string battle_catalog_json;
std::string campaign_army_json;
std::unique_ptr<openrtw::BattleSession> battle_session;
std::string battle_session_json;
std::vector<std::uint8_t> battle_save;
constexpr std::string_view battle_save_identity = "rome-original/battle-prototype-save/v1";
std::uint32_t battle_generation = 0, next_battle_generation = 0;
std::uint32_t battle_campaign_generation = 0;
std::uint32_t battle_campaign_revision = 0, battle_campaign_order_revision = 0;
std::unique_ptr<openrtw::CasStaticModel> cas_mesh;
std::string cas_mesh_json;
// Static shadow volumes are derived from exactly one cas_mesh publication. A
// successful CAS replacement or reset clears this so geometry cannot survive a
// different source; failed builds and failed loads keep the previous wire.
std::string campaign_shadow_json;
std::unique_ptr<openrtw::CasAnimation> cas_animation;
std::string cas_animation_json, cas_animation_frame_json;
std::unique_ptr<openrtw::DdsTexture> dds_texture;
std::string dds_texture_json;
std::uint32_t session_generation = 0;
// Kept across reset so an old UI token cannot refer to replacement characters.
std::uint32_t next_session_generation = 0;
// Monotonic token for the authoritative completed-production state used by the
// settlement presentation projections. Commands/turns that may change completed
// buildings bump it; a derived scene/inspection built at an older value is never
// served. Session generation is separate and also binds source replacement.
std::uint64_t production_presentation_epoch = 0;
std::unique_ptr<openrtw::RegionDefinitions> regions;
std::unique_ptr<openrtw::RgbImage> region_map;
std::string regions_json;
std::unique_ptr<openrtw::WorldGrid> world_grid;
std::string world_grid_json;
std::unique_ptr<openrtw::RgbImage> ground_map;
std::unique_ptr<openrtw::CategoryGrid> category_grid;
std::unique_ptr<openrtw::CategoryPointGrid> point_category_grid;
std::unique_ptr<openrtw::ClimatePalette> climates;
std::unique_ptr<openrtw::RgbImage> climate_map;
std::unique_ptr<openrtw::ClimateCoefficientGrid> climate_grid;
std::string climates_json;
// Aerial (campaign) ground compositor epoch. A successful ground-types load
// starts it (bound to the loaded climate palette); textures and the 7 weight
// patterns load into it; the build MOVES the texture pixels into the
// compositor (no second ~24 MiB copy), so texture/pattern loads refuse after
// a build until the ground types are loaded again. Replacing an input of the
// compositor (terrain, ground map, cell/point categories, climate map)
// discards the compositor together with its textures; patterns stay.
// Replacing the climate definitions clears the whole epoch.
constexpr std::size_t aerial_pattern_slots = 7;
// 24-bit TGA with optional 26-byte TGA 2.0 footer at the largest accepted side.
constexpr std::uint64_t aerial_texture_max_tga_bytes =
    18 + std::uint64_t{openrtw::aerial_texture_max_side} * openrtw::aerial_texture_max_side * 3 +
    26;
constexpr std::uint64_t aerial_weight_max_tga_bytes = 18 + openrtw::aerial_mask_samples * 3 + 26;
std::unique_ptr<openrtw::AerialGroundTypes> aerial_types;
// Null while types are loaded means every registry texture is unloaded.
std::unique_ptr<openrtw::AerialGroundTextureSet> aerial_textures;
std::array<openrtw::AerialWeightPattern, aerial_pattern_slots> aerial_patterns{};
std::array<bool, aerial_pattern_slots> aerial_pattern_loaded{};
std::unique_ptr<openrtw::AerialCampaignCompositor> aerial_compositor;
std::vector<std::uint8_t> aerial_page;
bool aerial_page_published = false;
openrtw::AerialTileRgba aerial_tile{};
bool aerial_tile_published = false;
std::string aerial_ground_json;
bool aerial_ground_json_current = false;
constexpr std::uint64_t aerial_decal_text_max_bytes = 1024 * 1024;
// 32-bit TGA with a full ID field and a 26-byte footer at the largest accepted side.
constexpr std::uint64_t aerial_decal_max_tga_bytes =
    18 + 255 + std::uint64_t{openrtw::aerial_decal_max_side} * openrtw::aerial_decal_max_side * 4 +
    26;
// NUL-terminated base type name argument (OpenRTW API bound).
constexpr std::size_t aerial_decal_name_max_bytes = 1024;
std::unique_ptr<openrtw::AerialDecalBases> aerial_bases;
std::vector<openrtw::AerialDecalImage> aerial_base_images;
std::unique_ptr<openrtw::AerialCultureBindings> aerial_cultures;
std::unique_ptr<std::vector<openrtw::FactionCulture>> faction_cultures;
std::string aerial_bases_json;
bool aerial_bases_json_current = false;
// Built products; null layer = not built (an empty layer is a successful build).
std::unique_ptr<openrtw::AerialDecalLayer> aerial_decal_layer;
std::vector<float> aerial_flattened; // (px, py, height) triples, (py, px) order
std::string aerial_decals_json;
std::unique_ptr<openrtw::CultureModelTable> settlement_cultures;
std::unique_ptr<openrtw::BuildingModelLevels> settlement_buildings;
std::unique_ptr<openrtw::SettlementModelScene> settlement_models;
std::string settlement_models_wire;
std::string campaign_trees_wire;
std::optional<float> settlement_symbol_anchor;

// Cache tokens for derived settlement presentation. A production-enabled build
// is bound to the session generation, the completed-production epoch and the
// source owner; stale tokens are never served.
std::uint32_t settlement_models_generation = 0;
std::uint64_t settlement_models_epoch = 0;
bool settlement_models_projection = false;
std::uint32_t settlement_inspection_generation = 0;
std::uint64_t settlement_inspection_epoch = 0;
std::uint32_t settlement_inspection_revision = 0;
std::uint32_t settlement_inspection_order_revision = 0;
bool settlement_inspection_projection = false;

void discard_settlement_models() noexcept {
    std::string{}.swap(campaign_trees_wire);
    settlement_models.reset();
    std::string{}.swap(settlement_models_wire);
    settlement_models_projection = false;
}

// Accepted production commands/turns bump the epoch; retirement drops the wire
// so no caller can read a stale projection. Refusals never call this.
void retire_production_settlement_presentation() noexcept {
    settlement_models.reset();
    std::string{}.swap(settlement_models_wire);
    settlement_models_projection = false;
    std::string{}.swap(settlement_inspection_json);
    settlement_inspection_projection = false;
}

bool settlement_models_stale() noexcept {
    return settlement_models_projection &&
           (!campaign_session || settlement_models_generation != session_generation ||
            settlement_models_epoch != production_presentation_epoch);
}

bool settlement_inspection_stale() noexcept {
    return settlement_inspection_projection &&
           (!campaign_session || settlement_inspection_generation != session_generation ||
            settlement_inspection_epoch != production_presentation_epoch ||
            settlement_inspection_revision != campaign_session->revision() ||
            settlement_inspection_order_revision != campaign_session->order_revision());
}

// Deep copy: the parsed campaign is never mutated. Only the fields the existing
// core selector reads are replaced: `level` and the `type <chain> <level>` lines.
// Faction, region, coordinates, characters and source rows stay the original
// records, so provenance in inspection is unchanged. Completed city buildings
// are authoritative; queued projected levels are deliberately not applied.
openrtw::Campaign project_settlement_models(const openrtw::Campaign& source,
                                            const openrtw::CampaignProduction& production) {
    openrtw::Campaign projected = source;
    std::size_t cityId = 0;
    for (std::size_t factionIndex = 0; factionIndex < projected.factions.size(); ++factionIndex) {
        for (auto& settlement : projected.factions[factionIndex].settlements) {
            if (cityId >= production.cities.size())
                throw std::runtime_error("Production city count differs from the campaign");
            const auto& city = production.cities[cityId];
            if (city.faction != static_cast<std::uint32_t>(factionIndex) ||
                city.region != settlement.region)
                throw std::runtime_error("Production city order differs from the campaign");
            if (city.level.empty())
                throw std::runtime_error("Production city has no completed level");
            settlement.level = city.level;
            settlement.buildings.clear();
            settlement.buildings.reserve(city.buildings.size());
            for (const auto& [chain, level] : city.buildings) {
                if (chain.empty() || level.empty())
                    throw std::runtime_error("Production city has an empty building identity");
                openrtw::SettlementBuilding block;
                // Copy-local synthetic selector line. It is never published as
                // source provenance; inspection keeps the literal source rows.
                block.source.push_back({0, "type " + chain + " " + level});
                settlement.buildings.push_back(std::move(block));
            }
            ++cityId;
        }
    }
    if (cityId != production.cities.size())
        throw std::runtime_error("Production city count differs from the campaign");
    return projected;
}

std::unique_ptr<openrtw::PcmClip> pcm;
std::array<char, error_bytes> error{};

void clear_error() noexcept {
    error[0] = '\0';
}

void fail(std::string_view message) noexcept {
    const auto count = message.size() < error.size() - 1 ? message.size() : error.size() - 1;
    for (std::size_t i = 0; i < count; ++i)
        error[i] = message[i];
    error[count] = '\0';
}

void validate_input(const std::uint8_t* bytes, std::size_t size, std::uint64_t limit) {
    if (!bytes || !size)
        throw std::runtime_error("Input buffer is empty");
    if (size > limit)
        throw std::runtime_error("Input exceeds API byte limit");
#ifdef __EMSCRIPTEN__
    const auto start = reinterpret_cast<std::uintptr_t>(bytes);
    const auto heap_size = emscripten_get_heap_size();
    if (start > heap_size || size > heap_size - start)
        throw std::runtime_error("Input span is outside WASM memory");
#endif
}

using Json = openrtw::detail::Json;

// The prototype battle owns copies of both selected armies. Keep its campaign
// identity fixed until explicit return; rendering-only CAS/DDS APIs stay usable.
void require_campaign_available() {
    if (battle_session)
        throw std::runtime_error("Return from battle before changing the campaign");
}

void clear_battle() noexcept {
    battle_session.reset();
    std::vector<std::uint8_t>{}.swap(battle_save);
    std::string{}.swap(battle_session_json);
    battle_generation = battle_campaign_generation = 0;
    battle_campaign_revision = battle_campaign_order_revision = 0;
    // next_battle_generation survives reset, just like campaign generations.
}

std::string_view battle_outcome_wire(openrtw::BattleOutcome value) noexcept {
    switch (value) {
    case openrtw::BattleOutcome::Active:
        return "ongoing";
    case openrtw::BattleOutcome::PlayerVictory:
        return "player_won";
    case openrtw::BattleOutcome::OpponentVictory:
        return "enemy_won";
    case openrtw::BattleOutcome::Draw:
        return "draw";
    case openrtw::BattleOutcome::Retreated:
        return "retreated";
    }
    return "unknown";
}

std::string battle_snapshot(const openrtw::BattleSession& value, std::uint32_t generation,
                            std::uint32_t campaignGeneration) {
    const auto& origin = value.origin();
    Json out;
    out.append("{\"schema\":\"openrtw-battle-session-v1\",\"ruleProfile\":");
    out.string(openrtw::battle_session_policy);
    out.append(",\"generation\":");
    out.integer(generation);
    out.append(",\"revision\":");
    out.integer(value.revision());
    out.append(",\"campaignGeneration\":");
    out.integer(campaignGeneration);
    out.append(",\"campaignRevision\":");
    out.integer(origin.revision);
    out.append(",\"campaignOrderRevision\":");
    out.integer(origin.orderRevision);
    out.append(",\"ticks\":");
    out.integer(value.ticks());
    out.append(",\"tickMilliseconds\":");
    out.integer(openrtw::battle_session_tick_ms);
    out.append(",\"outcome\":");
    out.string(battle_outcome_wire(value.outcome()));
    out.append(",\"width\":");
    out.integer(value.width());
    out.append(",\"height\":");
    out.integer(value.height());
    out.append(",\"cellMetres\":");
    out.integer(openrtw::battle_session_cell_metres);
    out.append(",\"playerActorId\":");
    out.integer(origin.player.actor.id);
    out.append(",\"enemyActorId\":");
    out.integer(origin.opponent.actor.id);
    out.append(",\"countPolicy\":\"explicit-source-count-else-unscaled-definition-v1\"");
    out.append(",\"campaignResultsApplied\":false,\"teams\":[");
    const std::array<const openrtw::BattleOriginActor*, 2> teams{&origin.player, &origin.opponent};
    for (std::size_t i = 0; i < teams.size(); ++i) {
        if (i)
            out.append(",");
        out.append("{\"team\":");
        out.integer(i);
        out.append(",\"actorId\":");
        out.integer(teams[i]->actor.id);
        out.append(",\"name\":");
        out.string(teams[i]->name);
        out.append(",\"faction\":");
        out.string(teams[i]->sourceFaction);
        out.append("}");
    }
    out.append("],\"units\":[");
    bool first = true;
    for (const auto& unit : value.units()) {
        if (!first)
            out.append(",");
        first = false;
        const auto& profile = unit.profile;
        out.append("{\"id\":");
        out.integer(unit.id);
        out.append(",\"team\":");
        out.integer(unit.team == openrtw::BattleTeam::Player ? 0 : 1);
        out.append(",\"actorId\":");
        out.integer(unit.sourceActorId);
        out.append(",\"sourceFactionIndex\":");
        out.integer(unit.sourceFactionIndex);
        out.append(",\"sourceCharacterIndex\":");
        out.integer(unit.sourceCharacterIndex);
        out.append(",\"armyIndex\":");
        out.integer(unit.sourceArmyIndex);
        out.append(",\"sourceLine\":");
        out.integer(unit.sourceLine);
        out.append(",\"type\":");
        out.string(profile.type);
        out.append(",\"model\":");
        out.string(profile.model);
        out.append(",\"category\":");
        out.string(profile.category);
        out.append(",\"unitClass\":");
        out.string(profile.unitClass);
        out.append(",\"sourceSoldierCount\":");
        out.integer(profile.sourceSoldierCount);
        out.append(",\"sourceCount\":");
        if (unit.sourceUnit.count)
            out.integer(*unit.sourceUnit.count);
        else
            out.append("null");
        out.append(",\"usesExplicitSourceCount\":");
        out.append(unit.usesExplicitSourceCount ? "true" : "false");
        out.append(",\"initialSoldiers\":");
        out.integer(unit.initialSoldiers);
        out.append(",\"soldiers\":");
        out.integer(unit.living_soldiers());
        out.append(",\"hitPoints\":");
        out.integer(unit.hitPoints);
        out.append(",\"maxHitPoints\":");
        out.integer(unit.maxHitPoints);
        out.append(",\"manHitPoints\":");
        out.integer(profile.manHitPoints);
        out.append(",\"x\":");
        out.integer(unit.x);
        out.append(",\"y\":");
        out.integer(unit.y);
        out.append(",\"order\":");
        out.string(openrtw::BattleSession::order_name(unit.order));
        out.append(",\"destination\":");
        if (unit.destination) {
            out.append("{\"x\":");
            out.integer(unit.destination->x);
            out.append(",\"y\":");
            out.integer(unit.destination->y);
            out.append("}");
        } else
            out.append("null");
        out.append(",\"targetId\":");
        if (unit.targetId)
            out.integer(*unit.targetId);
        else
            out.append("null");
        out.append(",\"ammo\":");
        out.integer(unit.ammunition);
        out.append(",\"cooldownTicks\":");
        out.integer(unit.cooldownTicks);
        out.append(",\"formationRanks\":");
        out.integer(profile.formationRanks);
        out.append(",\"spacingMillimetres\":[");
        for (std::size_t i = 0; i < profile.spacingMillimetres.size(); ++i) {
            if (i)
                out.append(",");
            out.integer(profile.spacingMillimetres[i]);
        }
        out.append("],\"sourceProfile\":{\"line\":");
        out.integer(profile.sourceLine);
        out.append(",\"attack\":");
        out.integer(profile.primary.attack);
        out.append(",\"defence\":");
        out.integer(std::uint64_t{profile.armour} + profile.defenceSkill + profile.shield);
        out.append(",\"rangeMetres\":");
        out.integer(profile.primary.rangeMeters);
        out.append(",\"delayTenths\":");
        out.integer(profile.primary.delayTenths);
        out.append(",\"weaponOpaqueTail\":");
        out.string(profile.primary.opaqueTail);
        out.append(",\"secondaryWeaponOpaqueTail\":");
        out.string(profile.secondary.opaqueTail);
        out.append("}}");
    }
    out.append("]}");
    auto json = std::move(out).finish();
    if (json.size() > 1024 * 1024)
        throw std::runtime_error("Battle JSON exceeds API byte limit");
    return json;
}

void require_battle(std::uint32_t generation) {
    if (!battle_session || generation != battle_generation)
        throw std::runtime_error("Battle changed; refresh its controls");
    if (!campaign_session || session_generation != battle_campaign_generation ||
        campaign_session->revision() != battle_campaign_revision ||
        campaign_session->order_revision() != battle_campaign_order_revision)
        throw std::runtime_error("Battle campaign identity changed");
}

template <class Action> int apply_battle(std::uint32_t generation, Action&& action) noexcept {
    try {
        require_battle(generation);
        auto next = std::make_unique<openrtw::BattleSession>(*battle_session);
        const auto result = action(*next);
        if (!result.accepted()) {
            fail(openrtw::BattleSession::status_name(result.status));
            return 0;
        }
        auto json = battle_snapshot(*next, battle_generation, battle_campaign_generation);
        battle_session.swap(next);
        battle_session_json.swap(json);
        std::vector<std::uint8_t>{}.swap(battle_save);
        clear_error();
        return 1;
    } catch (const std::exception& exception) {
        fail(exception.what());
    } catch (...) {
        fail("Unknown battle command failure");
    }
    return 0;
}

void dds_range(Json& out, const openrtw::DdsByteRange& range) {
    out.append("{\"start\":");
    out.integer(range.start);
    out.append(",\"endExclusive\":");
    out.integer(range.endExclusive);
    out.append("}");
}

std::string dds_snapshot(const openrtw::DdsTexture& value) {
    Json out;
    out.append("{\"schema\":\"openrtw-dds-texture-v1\",\"sourceBytes\":");
    out.integer(value.sourceBytes.size());
    out.append(",\"width\":");
    out.integer(value.width);
    out.append(",\"height\":");
    out.integer(value.height);
    out.append(",\"format\":");
    switch (value.compression) {
    case openrtw::DdsCompression::Dxt1:
        out.string("DXT1");
        break;
    case openrtw::DdsCompression::Dxt3:
        out.string("DXT3");
        break;
    case openrtw::DdsCompression::Dxt5:
        out.string("DXT5");
        break;
    }
    out.append(",\"blockBytes\":");
    out.integer(value.blockBytes);
    out.append(",\"headerFlags\":");
    out.integer(value.headerFlags);
    out.append(",\"pixelFormatFlags\":");
    out.integer(value.pixelFormatFlags);
    out.append(",\"caps\":");
    out.integer(value.caps);
    out.append(",\"pitchOrLinearSize\":");
    out.integer(value.pitchOrLinearSize);
    out.append(",\"declaredMipMapCount\":");
    out.integer(value.declaredMipMapCount);
    out.append(",\"headerRange\":");
    dds_range(out, value.headerRange);
    out.append(",\"payloadRange\":");
    dds_range(out, value.payloadRange);
    out.append(",\"mips\":[");
    for (std::size_t i = 0; i < value.mips.size(); ++i) {
        const auto& mip = value.mips[i];
        if (i)
            out.append(",");
        out.append("{\"level\":");
        out.integer(mip.level);
        out.append(",\"width\":");
        out.integer(mip.width);
        out.append(",\"height\":");
        out.integer(mip.height);
        out.append(",\"blocksX\":");
        out.integer(mip.blocksX);
        out.append(",\"blocksY\":");
        out.integer(mip.blocksY);
        out.append(",\"range\":");
        dds_range(out, mip.range);
        out.append("}");
    }
    out.append("]");
    if (value.legacyFlagsProfile)
        out.append(",\"envelopeProfile\":\"legacy-flags-v1\"");
    out.append("}");
    auto json = std::move(out).finish();
    if (json.size() > 8192)
        throw std::runtime_error("DDS metadata JSON exceeds API byte limit");
    return json;
}

void cas_range(Json& out, const openrtw::CasByteRange& range) {
    out.append("{\"start\":");
    out.integer(range.start);
    out.append(",\"endExclusive\":");
    out.integer(range.endExclusive);
    out.append("}");
}

template <class Values> void cas_integers(Json& out, const Values& values) {
    out.append("[");
    bool first = true;
    for (const auto value : values) {
        if (!first)
            out.append(",");
        first = false;
        out.integer(value);
    }
    out.append("]");
}

template <class Values> void cas_doubles(Json& out, const Values& values) {
    out.append("[");
    bool first = true;
    for (const double value : values) {
        if (!std::isfinite(value))
            throw std::runtime_error("CAS candidate coordinate is not finite");
        std::array<char, 64> text{};
        const auto result =
            std::to_chars(text.data(), text.data() + text.size(), value, std::chars_format::general,
                          std::numeric_limits<double>::max_digits10);
        if (result.ec != std::errc{})
            throw std::runtime_error("Cannot encode CAS candidate coordinate");
        if (!first)
            out.append(",");
        first = false;
        out.append({text.data(), static_cast<std::size_t>(result.ptr - text.data())});
    }
    out.append("]");
}

template <class Chunks> void cas_chunks(Json& out, const Chunks& chunks) {
    out.append("[");
    bool first = true;
    for (const auto& chunk : chunks) {
        if (!first)
            out.append(",");
        first = false;
        out.append("{\"kind\":");
        out.integer(chunk.kind);
        out.append(",\"meshes\":");
        out.integer(chunk.meshes);
        out.append(",\"range\":");
        cas_range(out, chunk.range);
        out.append("}");
    }
    out.append("]");
}

std::string cas_snapshot(const openrtw::CasStaticModel& value) {
    Json out;
    out.append("{\"schema\":\"openrtw-cas-static-candidate-v1\",\"sourceBytes\":");
    out.integer(value.sourceBytes.size());
    if (value.repeatedStaticCount312Profile)
        out.append(",\"admissionProfile\":\"openrtw-cas312-repeated-static-count-v1\"");
    if (!value.admissionProfile.empty()) {
        out.append(",\"admissionProfile\":");
        out.string(value.admissionProfile);
    }
    out.append(",\"versionBits\":");
    out.integer(value.versionBits);
    out.append(",\"headerLength\":");
    out.integer(value.headerLength);
    out.append(",\"frameCount\":");
    out.integer(value.frameCount);
    out.append(",\"rotationKeyCount\":");
    out.integer(value.rotationKeyCount);
    out.append(",\"translationKeyCount\":");
    out.integer(value.translationKeyCount);
    out.append(",\"totalVertices\":");
    out.integer(value.totalVertices);
    out.append(",\"totalTriangles\":");
    out.integer(value.totalTriangles);
    out.append(",\"headerRange\":");
    cas_range(out, value.headerRange);
    out.append(",\"animationRange\":");
    cas_range(out, value.animationRange);
    out.append(",\"parentsRange\":");
    cas_range(out, value.parentsRange);
    out.append(",\"frameTimeRange\":");
    cas_range(out, value.frameTimeRange);
    out.append(",\"boneHeadersRange\":");
    cas_range(out, value.boneHeadersRange);
    out.append(",\"rotationRange\":");
    cas_range(out, value.rotationRange);
    out.append(",\"translationRange\":");
    cas_range(out, value.translationRange);
    out.append(",\"bindRange\":");
    cas_range(out, value.bindRange);
    out.append(",\"bones\":[");
    for (std::size_t i = 0; i < value.bones.size(); ++i) {
        const auto& bone = value.bones[i];
        if (i)
            out.append(",");
        out.append("{\"id\":");
        out.integer(bone.id);
        out.append(",\"parent\":");
        out.integer(bone.parent);
        out.append(",\"name\":");
        out.string(bone.name);
        out.append(",\"rotationKeys\":");
        out.integer(bone.rotationKeys);
        out.append(",\"translationKeys\":");
        out.integer(bone.translationKeys);
        out.append(",\"rotationOffset\":");
        out.integer(bone.rotationOffset);
        out.append(",\"translationOffset\":");
        out.integer(bone.translationOffset);
        if (value.versionBits == 0x404a3d71u) {
            out.append(",\"extra316Range\":");
            cas_range(out, bone.extra316Range);
            out.append(",\"extra316Bytes\":");
            cas_integers(out, bone.extra316Bytes);
        }
        out.append(",\"headerRange\":");
        cas_range(out, bone.headerRange);
        out.append(",\"bindLocalBits\":");
        cas_integers(out, bone.bindLocalBits);
        out.append(",\"candidateBindWorld\":");
        cas_doubles(out, bone.candidateBindWorld);
        out.append("}");
    }
    out.append("],\"chunks\":");
    cas_chunks(out, value.chunks);
    out.append(",\"meshes\":[");
    for (std::size_t i = 0; i < value.meshes.size(); ++i) {
        const auto& mesh = value.meshes[i];
        if (i)
            out.append(",");
        out.append("{\"name\":");
        out.string(mesh.name);
        out.append(",\"chunkKind\":");
        out.integer(mesh.chunkKind);
        out.append(",\"attachedBone\":");
        if (mesh.attachedBone)
            out.integer(*mesh.attachedBone);
        else
            out.append("null");
        out.append(",\"vertices\":");
        out.integer(mesh.vertices);
        out.append(",\"triangles\":");
        out.integer(mesh.triangles);
        out.append(",\"textureIndex\":");
        out.integer(mesh.textureIndex);
        if (value.admissionProfile == "openrtw-cas-static-any-v1") {
            out.append(",\"uvFlag\":");
            out.integer(mesh.uvFlag);
            out.append(",\"materialIndex\":");
            out.integer(mesh.textureIndex);
            out.append(",\"isSymbol\":");
            out.append(mesh.name == "symbol" ? "true" : "false");
            out.append(",\"candidateBindNormals\":");
            std::vector<double> normals;
            normals.reserve(mesh.normalBits.size());
            for (const auto bits : mesh.normalBits)
                normals.push_back(std::bit_cast<float>(bits));
            cas_doubles(out, normals);
        }
        if (value.versionBits == 0x404a3d71u || value.versionBits == 0x4047ae14u ||
            !value.admissionProfile.empty()) {
            out.append(",\"vertexColorFlag\":");
            out.integer(mesh.vertexColorFlag);
            out.append(",\"colorRange\":");
            cas_range(out, mesh.colorRange);
            out.append(",\"vertexColorBytes\":");
            cas_integers(out, mesh.vertexColorBytes);
        }
        out.append(",\"metadataBits\":");
        cas_integers(out, mesh.metadataBits);
        out.append(",\"extra1\":");
        cas_integers(out, mesh.extra1);
        out.append(",\"extra2\":");
        cas_integers(out, mesh.extra2);
        if (!value.admissionProfile.empty()) {
            out.append(",\"extra1Range\":");
            cas_range(out, mesh.extra1Range);
            out.append(",\"extra2Range\":");
            cas_range(out, mesh.extra2Range);
        }
        out.append(",\"recordRange\":");
        cas_range(out, mesh.recordRange);
        out.append(",\"assignmentRange\":");
        cas_range(out, mesh.assignmentRange);
        out.append(",\"positionRange\":");
        cas_range(out, mesh.positionRange);
        out.append(",\"normalRange\":");
        cas_range(out, mesh.normalRange);
        out.append(",\"indexRange\":");
        cas_range(out, mesh.indexRange);
        out.append(",\"uvRange\":");
        cas_range(out, mesh.uvRange);
        out.append(",\"positionBits\":");
        cas_integers(out, mesh.positionBits);
        out.append(",\"normalBits\":");
        cas_integers(out, mesh.normalBits);
        out.append(",\"uvBits\":");
        cas_integers(out, mesh.uvBits);
        out.append(",\"boneIndices\":");
        cas_integers(out, mesh.boneIndices);
        out.append(",\"indices\":");
        cas_integers(out, mesh.indices);
        out.append(",\"candidateBindPositions\":");
        cas_doubles(out, mesh.candidateBindPositions);
        out.append("}");
    }
    out.append("],\"opaqueChunks\":");
    cas_chunks(out, value.opaqueChunks);
    out.append(",\"material\":{\"range\":");
    cas_range(out, value.material.range);
    out.append(",\"nameRange\":");
    cas_range(out, value.material.nameRange);
    out.append(",\"textureName\":");
    out.string(value.material.textureName);
    out.append(",\"rawBits\":");
    cas_integers(out, value.material.rawBits);
    if (value.versionBits == 0x404a3d71u || value.versionBits == 0x4047ae14u ||
        !value.admissionProfile.empty()) {
        out.append(",\"opaqueTailRange\":");
        cas_range(out, value.material.opaqueTailRange);
        out.append(",\"opaqueTailBytes\":");
        cas_integers(out, value.material.opaqueTailBytes);
    }
    out.append(",\"lastByte\":");
    out.integer(value.material.lastByte);
    out.append("}");
    if (value.admissionProfile == "openrtw-cas-static-any-v1") {
        out.append(",\"materials\":[");
        for (std::size_t i = 0; i < value.materials.size(); ++i) {
            if (i)
                out.append(",");
            out.append("{\"name\":");
            out.string(value.materials[i].textureName);
            out.append(",\"cull\":");
            out.append(value.materials[i].lastByte ? "true" : "false");
            out.append("}");
        }
        out.append("],\"symbolAnchor\":");
        if (value.symbolAnchor)
            cas_doubles(out, *value.symbolAnchor);
        else
            out.append("null");
    }
    if (value.terminalKind7Range.bytes()) {
        out.append(",\"terminalKind7Range\":");
        cas_range(out, value.terminalKind7Range);
        out.append(",\"terminalKind7Words\":");
        cas_integers(out, value.terminalKind7Words);
    }
    out.append("}");
    return std::move(out).finish();
}

// Session state is separate from the immutable campaign source publication.
// JSON is encoded before any state swap; command failures preserve both.
void invalidate_campaign_command_caches() noexcept {
    std::string{}.swap(campaign_production_json);
    std::vector<std::uint8_t>{}.swap(campaign_save);
    std::string{}.swap(campaign_route_json);
    std::string{}.swap(campaign_advance_json);
    std::string{}.swap(campaign_faction_journeys_json);
    std::string{}.swap(campaign_fog_wire);
}

void invalidate_campaign_session() noexcept {
    campaign_session.reset();
    campaign_fog_initial.reset();
    std::string{}.swap(campaign_fog_policy);
    std::string{}.swap(campaign_fog_reason);
    std::vector<std::string>{}.swap(campaign_fog_limitations);
    std::string{}.swap(campaign_session_json);
    session_generation = 0;
    // A production-derived scene is stale even if its wire is retained; the
    // getter refuses it because there is no current session owner.
    ++production_presentation_epoch;
    std::string{}.swap(campaign_army_json);
    if (settlement_view)
        settlement_view->clear();
    std::string{}.swap(settlement_inspection_json);
    settlement_inspection_projection = false;
    invalidate_campaign_command_caches();
}

// Literal source fields stay unchanged for provenance. When prototype production
// is enabled, an additive `presentation` object exposes the completed city level
// and buildings that the core model selector actually consumes; consumers must
// prefer it over the literal `level`/`buildings` source record.
std::string settlement_snapshot(const openrtw::SettlementInspection* row,
                                std::uint32_t generation,
                                const openrtw::CampaignSession* session) {
    Json out;
    out.append("{\"schema\":\"openrtw-settlement-inspection-v1\",\"campaignGeneration\":");
    out.integer(generation);
    out.append(",\"selected\":");
    if (!row) {
        out.append("null}");
        return std::move(out).finish();
    }
    const auto& value = row->settlement;
    out.append("{\"id\":");
    out.integer(row->id);
    out.append(",\"sourceFactionIndex\":");
    out.integer(row->sourceFactionIndex);
    out.append(",\"sourceSettlementIndex\":");
    out.integer(row->sourceSettlementIndex);
    out.append(",\"sourceFactionLine\":");
    out.integer(row->sourceFactionLine);
    out.append(",\"sourceFaction\":");
    out.string(row->sourceFaction);
    out.append(",\"region\":");
    out.string(value.region);
    out.append(",\"level\":");
    out.string(value.level);
    out.append(",\"population\":");
    out.integer(value.population);
    out.append(",\"yearFounded\":");
    out.integer(value.yearFounded);
    out.append(",\"planSet\":");
    out.string(value.planSet);
    out.append(",\"factionCreator\":");
    out.string(value.factionCreator);
    out.append(",\"line\":");
    out.integer(value.line);
    const auto lines = [&](const auto& source) {
        out.append("[");
        for (std::size_t i = 0; i < source.size(); ++i) {
            if (i)
                out.append(",");
            out.append("{\"line\":");
            out.integer(source[i].line);
            out.append(",\"text\":");
            out.string(source[i].text);
            out.append("}");
        }
        out.append("]");
    };
    out.append(",\"fieldSource\":");
    lines(value.source);
    out.append(",\"buildings\":[");
    for (std::size_t i = 0; i < value.buildings.size(); ++i) {
        if (i)
            out.append(",");
        out.append("{\"line\":");
        out.integer(value.buildings[i].line);
        out.append(",\"source\":");
        lines(value.buildings[i].source);
        out.append("}");
    }
    out.append("]");
    if (const auto* production = session ? session->production() : nullptr) {
        const openrtw::ProductionCity* city = nullptr;
        std::uint32_t cityId = 0;
        for (std::size_t i = 0; i < production->cities.size(); ++i)
            if (production->cities[i].faction == row->sourceFactionIndex &&
                production->cities[i].region == row->settlement.region) {
                if (city)
                    throw std::runtime_error("Ambiguous production settlement projection");
                city = &production->cities[i];
                cityId = static_cast<std::uint32_t>(i);
            }
        if (!city)
            throw std::runtime_error("Production settlement is missing from the campaign");
        if (city->level.empty())
            throw std::runtime_error("Production city has no completed level");
        out.append(",\"presentation\":{\"schema\":\"openrtw-settlement-presentation-v1\","
                   "\"source\":\"completed-production\",\"generation\":");
        out.integer(generation);
        out.append(",\"revision\":");
        out.integer(session->revision());
        out.append(",\"orderRevision\":");
        out.integer(session->order_revision());
        out.append(",\"cityId\":");
        out.integer(cityId);
        out.append(",\"level\":");
        out.string(city->level);
        out.append(",\"buildings\":[");
        bool first = true;
        for (const auto& [chain, level] : city->buildings) {
            if (chain.empty() || level.empty())
                throw std::runtime_error("Production city has an empty building identity");
            if (!first)
                out.append(",");
            first = false;
            out.append("{\"chain\":");
            out.string(chain);
            out.append(",\"level\":");
            out.string(level);
            out.append("}");
        }
        out.append("],\"queued\":[");
        first = true;
        for (const auto& job : city->construction) {
            if (job.definition >= production->catalog->buildings.size())
                throw std::runtime_error("Production queue definition is outside the catalog");
            const auto& building = production->catalog->buildings[job.definition];
            if (!first)
                out.append(",");
            first = false;
            out.append("{\"chain\":");
            out.string(building.chain);
            out.append(",\"level\":");
            out.string(building.level);
            out.append(",\"remaining\":");
            out.integer(job.remaining);
            out.append(",\"total\":");
            out.integer(job.total);
            out.append("}");
        }
        out.append("]}");
    }
    out.append("}}");
    auto json = std::move(out).finish();
    if (json.size() > settlement_inspection_max_bytes)
        throw std::runtime_error("Settlement inspection exceeds the panel byte limit");
    return json;
}

std::string catalog_snapshot(std::size_t units, std::size_t models) {
    Json out;
    out.append("{\"unitDefinitions\":");
    out.integer(units);
    out.append(",\"modelDefinitions\":");
    out.integer(models);
    out.append("}");
    return std::move(out).finish();
}

void optional_integer(Json& out, const std::optional<std::int32_t>& value) {
    if (value)
        out.integer(*value);
    else
        out.append("null");
}

// This is an owned view of literal source records, not a deployed battle army.
// A missing exact join is reported per row, without selecting a fallback model.
std::string army_snapshot(const openrtw::CampaignSession& session,
                          const openrtw::CampaignActor& actor, std::uint32_t generation) {
    const auto& character = session.source()
                                .factions.at(actor.sourceFactionIndex)
                                .characters.at(actor.sourceCharacterIndex);
    Json out;
    out.append("{\"generation\":");
    out.integer(generation);
    out.append(",\"actorId\":");
    out.integer(actor.id);
    out.append(",\"sourceFactionIndex\":");
    out.integer(actor.sourceFactionIndex);
    out.append(",\"sourceCharacterIndex\":");
    out.integer(actor.sourceCharacterIndex);
    out.append(",\"rows\":[");
    const auto army = session.army(actor.id);
    for (std::size_t i = 0; i < army.size(); ++i) {
        const auto& source = army[i];
        const auto* unit = unit_definitions
                               ? openrtw::find_unit_definition(*unit_definitions, source.name)
                               : nullptr;
        const auto* model = unit && battle_models
                                ? openrtw::find_battle_model(*battle_models, unit->soldierModel)
                                : nullptr;
        if (i)
            out.append(",");
        out.append("{\"sourceArmyIndex\":");
        out.integer(i);
        out.append(",\"name\":");
        out.string(source.name);
        out.append(",\"line\":");
        out.integer(source.line);
        if (i >= character.army.size()) out.append(",\"created\":true");
        out.append(",\"count\":");
        optional_integer(out, source.count);
        out.append(",\"experience\":");
        optional_integer(out, source.experience);
        out.append(",\"armour\":");
        optional_integer(out, source.armour);
        out.append(",\"weapon\":");
        optional_integer(out, source.weapon);
        out.append(",\"status\":");
        out.string(!unit    ? "missing_unit_definition"
                   : !model ? "missing_model_definition"
                            : "matched");
        out.append(",\"unitDefinition\":");
        if (unit) {
            out.append("{\"type\":");
            out.string(unit->type);
            out.append(",\"dictionary\":");
            out.string(unit->dictionary);
            out.append(",\"category\":");
            out.string(unit->category);
            out.append(",\"unitClass\":");
            out.string(unit->unitClass);
            out.append(",\"soldierModel\":");
            out.string(unit->soldierModel);
            out.append(",\"sourceSoldierCount\":");
            out.integer(unit->sourceSoldierCount);
            out.append(",\"line\":");
            out.integer(unit->line);
            out.append("}");
        } else
            out.append("null");
        out.append(",\"modelDefinition\":");
        if (model) {
            out.append("{\"type\":");
            out.string(model->type);
            out.append(",\"line\":");
            out.integer(model->line);
            out.append(",\"fields\":[");
            for (std::size_t field = 0; field < model->fields.size(); ++field) {
                const auto& value = model->fields[field];
                if (field)
                    out.append(",");
                out.append("{\"key\":");
                out.string(value.key);
                out.append(",\"value\":");
                out.string(value.value);
                out.append(",\"line\":");
                out.integer(value.line);
                out.append(",\"source\":");
                out.string(value.source);
                out.append("}");
            }
            out.append("]}");
        } else
            out.append("null");
        out.append("}");
    }
    out.append("]}");
    return std::move(out).finish();
}

std::string session_snapshot(const openrtw::CampaignSession& value, std::uint32_t generation) {
    Json out;
    out.append("{\"generation\":");
    out.integer(generation);
    out.append(",\"revision\":");
    out.integer(value.revision());
    out.append(",\"orderRevision\":");
    out.integer(value.order_revision());
    out.append(",\"turn\":");
    out.integer(value.turn());
    out.append(",\"year\":");
    out.integer(value.year());
    out.append(",\"season\":");
    out.string(value.season() == openrtw::Season::summer ? "summer" : "winter");
    out.append(",\"width\":");
    out.integer(value.width());
    out.append(",\"height\":");
    out.integer(value.height());
    out.append(",\"ruleProfile\":\"openrtw-cardinal-prototype-v2\",\"characters\":[");
    bool first = true;
    for (const auto& actor : value.actors()) {
        if (!first)
            out.append(",");
        first = false;
        const auto& faction = value.source().factions.at(actor.sourceFactionIndex);
        const auto& character = faction.characters.at(actor.sourceCharacterIndex);
        out.append("{\"id\":");
        out.integer(actor.id);
        out.append(",\"faction\":");
        out.string(faction.id);
        out.append(",\"sourceFactionIndex\":");
        out.integer(actor.sourceFactionIndex);
        out.append(",\"sourceCharacterIndex\":");
        out.integer(actor.sourceCharacterIndex);
        out.append(",\"name\":");
        out.string(character.name);
        out.append(",\"type\":");
        out.string(character.type);
        out.append(",\"line\":");
        out.integer(actor.sourceLine);
        out.append(",\"x\":");
        out.integer(actor.currentX);
        out.append(",\"y\":");
        out.integer(actor.currentY);
        out.append(",\"actionPoints\":");
        out.integer(actor.ap);
        out.append(",\"maxActionPoints\":");
        out.integer(actor.maxAp);
        out.append(",\"destination\":");
        if (actor.destination) {
            out.append("{\"x\":");
            out.integer(actor.destination->x);
            out.append(",\"y\":");
            out.integer(actor.destination->y);
            out.append("}");
        } else
            out.append("null");
        out.append(",\"armyRecords\":");
        out.integer(value.army(actor.id).size());
        out.append(",\"subFaction\":");
        if (character.subFaction)
            out.string(*character.subFaction);
        else
            out.append("null");
        out.append("}");
    }
    out.append("]");
    if (const auto* production = value.production()) {
        out.append(",\"productionEnabled\":true,\"treasuries\":[");
        for (std::size_t i = 0; i < production->treasury.size(); ++i) {
            if (i) out.append(",");
            out.integer(production->treasury[i]);
        }
        out.append("]");
    }
    out.append("}");
    return std::move(out).finish();
}

std::string_view command_error(openrtw::CampaignCommandStatus status) noexcept {
    using Status = openrtw::CampaignCommandStatus;
    switch (status) {
    case Status::Applied:
        return "";
    case Status::StaleRevision:
        return "Campaign changed; refresh the command";
    case Status::StaleOrderRevision:
        return "Campaign orders changed; refresh the command";
    case Status::InvalidActor:
        return "Select a valid character";
    case Status::OutOfBounds:
        return "Destination is outside the campaign map";
    case Status::NoOp:
        return "Character is already at this cell";
    case Status::NotAdjacent:
        return "Choose a neighboring cell north, south, east or west";
    case Status::NoAp:
        return "No action points left; end the turn to refill";
    case Status::Occupied:
        return "Another character occupies this cell";
    case Status::RevisionOverflow:
        return "Campaign command limit reached";
    case Status::TurnOverflow:
        return "Campaign turn limit reached";
    case Status::YearOverflow:
        return "Campaign year limit reached";
    case Status::FogRefused:
        return "Campaign fog could not admit this observer update; movement was not applied";
    }
    return "Unknown campaign command status";
}

std::string_view route_status(openrtw::CampaignRouteStatus status) noexcept {
    using Status = openrtw::CampaignRouteStatus;
    switch (status) {
    case Status::Ok:
        return "ok";
    case Status::StaleRevision:
        return "stale_revision";
    case Status::StaleOrderRevision:
        return "stale_order_revision";
    case Status::NoDestination:
        return "no_destination";
    case Status::InvalidActor:
        return "invalid_actor";
    case Status::OutOfBounds:
        return "out_of_bounds";
    case Status::NoOp:
        return "no_op";
    case Status::WorldTooLarge:
        return "world_too_large";
    case Status::Occupied:
        return "occupied";
    case Status::Unreachable:
        return "unreachable";
    case Status::InsufficientAp:
        return "insufficient_ap";
    case Status::RevisionOverflow:
        return "revision_overflow";
    case Status::FogRefused:
        return "fog_refused";
    }
    return "unknown";
}

std::string_view route_error(openrtw::CampaignRouteStatus status) noexcept {
    using Status = openrtw::CampaignRouteStatus;
    switch (status) {
    case Status::Ok:
        return "";
    case Status::StaleRevision:
        return "Campaign changed; refresh the route";
    case Status::StaleOrderRevision:
        return "Campaign orders changed; refresh the journey";
    case Status::NoDestination:
        return "Set a destination before continuing the journey";
    case Status::InvalidActor:
        return "Select a valid character";
    case Status::OutOfBounds:
        return "Destination is outside the campaign map";
    case Status::NoOp:
        return "Character is already at this cell";
    case Status::WorldTooLarge:
        return "Campaign map exceeds the route search limit";
    case Status::Occupied:
        return "Another character occupies this cell";
    case Status::Unreachable:
        return "No route reaches this destination";
    case Status::InsufficientAp:
        return "Route needs more action points; end the turn to refill";
    case Status::RevisionOverflow:
        return "Campaign command limit reached";
    case Status::FogRefused:
        return "Campaign fog could not admit this route; movement was not applied";
    }
    return "Unknown campaign route status";
}

std::string route_snapshot(const openrtw::CampaignRoutePreview& value, std::uint32_t generation,
                           std::uint32_t orderRevision, bool advance = false) {
    Json out;
    out.append("{\"ruleProfile\":\"openrtw-cardinal-prototype-v2\",\"generation\":");
    out.integer(generation);
    out.append(",\"revision\":");
    out.integer(value.revision);
    out.append(",\"orderRevision\":");
    out.integer(orderRevision);
    out.append(",\"actorId\":");
    out.integer(value.actorId);
    out.append(",\"target\":{\"x\":");
    out.integer(value.targetX);
    out.append(",\"y\":");
    out.integer(value.targetY);
    out.append("},\"status\":");
    out.string(route_status(value.status));
    out.append(",\"availableAp\":");
    out.integer(value.availableAp);
    out.append(",\"requiredAp\":");
    out.integer(value.requiredAp);
    if (advance) {
        const auto steps = value.status == openrtw::CampaignRouteStatus::Ok && !value.points.empty()
                               ? value.points.size() - 1
                               : 0;
        out.append(",\"plannedSteps\":");
        out.integer(steps);
        out.append(",\"partial\":");
        out.append(steps > 0 && steps < value.requiredAp ? "true" : "false");
    }
    out.append(",\"points\":[");
    for (std::size_t i = 0; i < value.points.size(); ++i) {
        if (i)
            out.append(",");
        out.append("{\"x\":");
        out.integer(value.points[i].x);
        out.append(",\"y\":");
        out.integer(value.points[i].y);
        out.append("}");
    }
    out.append("]}");
    return std::move(out).finish();
}

std::string_view faction_journey_error(openrtw::CampaignFactionJourneyStatus status) noexcept {
    using Status = openrtw::CampaignFactionJourneyStatus;
    switch (status) {
    case Status::Ok:
        return "";
    case Status::StaleRevision:
        return "Campaign changed; refresh the faction journeys";
    case Status::StaleOrderRevision:
        return "Campaign orders changed; refresh the faction journeys";
    case Status::InvalidFaction:
        return "Choose a valid source faction";
    case Status::WorkLimitExceeded:
        return "Faction journeys exceed the batch work limit";
    }
    return "Unknown faction journey status";
}

void journey_point(Json& out, const openrtw::CampaignRoutePoint& point) {
    out.append("{\"x\":");
    out.integer(point.x);
    out.append(",\"y\":");
    out.integer(point.y);
    out.append("}");
}

std::string faction_journeys_snapshot(const openrtw::CampaignFactionJourneyResult& value,
                                      std::uint32_t generation) {
    Json out;
    out.append("{\"ruleProfile\":\"openrtw-cardinal-prototype-v2\",\"generation\":");
    out.integer(generation);
    out.append(",\"sourceFactionIndex\":");
    out.integer(value.sourceFactionIndex);
    out.append(",\"entryRevision\":");
    out.integer(value.entryRevision);
    out.append(",\"revision\":");
    out.integer(value.revision);
    out.append(",\"orderRevision\":");
    out.integer(value.orderRevision);
    out.append(",\"plannedCount\":");
    out.integer(value.rows.size());
    out.append(",\"appliedCount\":");
    out.integer(value.appliedCount);
    out.append(",\"blockedCount\":");
    out.integer(value.blockedCount);
    out.append(",\"totalSteps\":");
    out.integer(value.totalSteps);
    out.append(",\"rows\":[");
    for (std::size_t i = 0; i < value.rows.size(); ++i) {
        const auto& row = value.rows[i];
        if (i)
            out.append(",");
        out.append("{\"actorId\":");
        out.integer(row.actorId);
        out.append(",\"target\":");
        journey_point(out, row.target);
        out.append(",\"before\":{\"x\":");
        out.integer(row.beforePosition.x);
        out.append(",\"y\":");
        out.integer(row.beforePosition.y);
        out.append(",\"actionPoints\":");
        out.integer(row.beforeAp);
        out.append("},\"after\":{\"x\":");
        out.integer(row.afterPosition.x);
        out.append(",\"y\":");
        out.integer(row.afterPosition.y);
        out.append(",\"actionPoints\":");
        out.integer(row.afterAp);
        out.append("},\"status\":");
        out.string(route_status(row.status));
        out.append(",\"stepsTaken\":");
        out.integer(row.stepsTaken);
        out.append(",\"destination\":");
        if (row.remainingDestination)
            journey_point(out, *row.remainingDestination);
        else
            out.append("null");
        out.append("}");
    }
    out.append("]}");
    return std::move(out).finish();
}

std::string region_snapshot(const openrtw::RegionDefinitions& value) {
    Json out;
    out.append("{\"definitions\":[");
    bool first = true;
    for (const auto& region : value.definitions) {
        if (!first)
            out.append(",");
        first = false;
        out.append("{\"id\":");
        out.string(region.id);
        out.append(",\"field2\":");
        out.string(region.field2);
        out.append(",\"field3\":");
        out.string(region.field3);
        out.append(",\"field4\":");
        out.string(region.field4);
        out.append(",\"rgb\":[");
        for (std::size_t i = 0; i < region.rgb.size(); ++i) {
            if (i)
                out.append(",");
            out.integer(region.rgb[i]);
        }
        out.append("],\"resources\":[");
        for (std::size_t i = 0; i < region.resources.size(); ++i) {
            if (i)
                out.append(",");
            out.string(region.resources[i]);
        }
        out.append("],\"numeric7\":");
        out.integer(region.numeric7);
        out.append(",\"numeric8\":");
        out.integer(region.numeric8);
        out.append(",\"line\":");
        out.integer(region.source[0].line);
        out.append("}");
    }
    out.append("],\"counts\":{\"definitions\":");
    out.integer(value.definitions.size());
    out.append(",\"ignoredLines\":");
    out.integer(value.ignoredLines.size());
    out.append("}}");
    return std::move(out).finish();
}

std::string grid_snapshot(const openrtw::WorldGrid& value) {
    Json out;
    out.append("{\"width\":");
    out.integer(value.width);
    out.append(",\"height\":");
    out.integer(value.height);
    out.append(",\"palette\":[");
    for (std::size_t i = 0; i < value.palette.size(); ++i) {
        if (i)
            out.append(",");
        out.append("[");
        for (std::size_t j = 0; j < 3; ++j) {
            if (j)
                out.append(",");
            out.integer(value.palette[i][j]);
        }
        out.append("]");
    }
    out.append("],\"markers\":[");
    for (std::size_t i = 0; i < value.markers.size(); ++i) {
        const auto& m = value.markers[i];
        if (i)
            out.append(",");
        out.append("{\"rawKind\":");
        out.string(m.rawKind == openrtw::WorldMarkerKind::Black ? "black" : "white");
        out.append(",\"imageX\":");
        out.integer(m.imageX);
        out.append(",\"imageY\":");
        out.integer(m.imageY);
        out.append(",\"worldX\":");
        out.integer(m.worldX);
        out.append(",\"worldY\":");
        out.integer(m.worldY);
        out.append(",\"regionIndex\":");
        out.integer(m.regionIndex);
        out.append(",\"coordinateWritten\":");
        out.append(m.coordinateWritten ? "true" : "false");
        out.append("}");
    }
    out.append("]}");
    return std::move(out).finish();
}

// The compositor owns copies of its grids; this keeps the published aerial
// output tied to the currently loaded inputs. Its textures go with it.
void discard_aerial_compositor() noexcept {
    aerial_compositor.reset();
    std::vector<std::uint8_t>{}.swap(aerial_page);
    aerial_page_published = false;
    aerial_tile_published = false;
    aerial_ground_json_current = false;
}

void clear_aerial() noexcept {
    discard_aerial_compositor();
    aerial_types.reset();
    aerial_textures.reset();
    aerial_patterns = {};
    aerial_pattern_loaded = {};
    std::string{}.swap(aerial_ground_json);
}

void require_open_aerial_epoch() {
    if (!aerial_types)
        throw std::runtime_error("Load the aerial ground types first");
    if (aerial_compositor)
        throw std::runtime_error("The built aerial compositor owns its textures and patterns; "
                                 "load the aerial ground types again to replace them");
}

std::uint32_t aerial_season(std::uint32_t winter) {
    if (winter > 1)
        throw std::runtime_error("Aerial season must be 0 (summer) or 1 (winter)");
    return winter;
}

std::string aerial_ground_snapshot() {
    const auto& types = *aerial_types;
    Json out;
    out.append("{\"schema\":\"openrtw-aerial-ground-v1\",\"textures\":[");
    for (std::size_t i = 0; i < types.textureNames.size(); ++i) {
        std::uint32_t side = 0;
        if (aerial_compositor)
            side = aerial_compositor->registry()[i].side;
        else if (aerial_textures && i < aerial_textures->textures.size())
            side = aerial_textures->textures[i].side;
        if (i)
            out.append(",");
        out.append("{\"index\":");
        out.integer(i);
        out.append(",\"name\":");
        out.string(types.textureNames[i]);
        out.append(",\"side\":");
        out.integer(side);
        out.append("}");
    }
    out.append("],\"climates\":[");
    for (std::size_t c = 0; c < types.climates.size(); ++c) {
        const auto& climate = types.climates[c];
        if (c)
            out.append(",");
        out.append("{\"index\":");
        out.integer(c);
        out.append(",\"name\":");
        out.string(climate.climateName);
        out.append(",\"block\":");
        out.string(climate.blockName);
        out.append(",\"winter\":");
        out.append(climate.winter ? "true" : "false");
        out.append("}");
    }
    std::size_t patterns = 0;
    for (const bool loaded : aerial_pattern_loaded)
        patterns += loaded;
    out.append("],\"patterns\":");
    out.integer(patterns);
    out.append(",\"ready\":");
    out.append(aerial_compositor ? "true" : "false");
    out.append(",\"pageCells\":");
    out.integer(openrtw::aerial_page_cells);
    out.append(",\"pageTexels\":");
    out.integer(openrtw::aerial_page_texels);
    out.append(",\"pagesX\":");
    out.integer(aerial_compositor ? aerial_compositor->pages_x() : 0u);
    out.append(",\"pagesY\":");
    out.integer(aerial_compositor ? aerial_compositor->pages_y() : 0u);
    // Row-major (pageY outer) season dependence per page; empty until built.
    // A page with false composes identical bytes in both seasons, so the
    // scene keeps its texture across a season change.
    out.append(",\"seasonalPages\":[");
    if (aerial_compositor)
        for (std::uint32_t y = 0; y < aerial_compositor->pages_y(); ++y)
            for (std::uint32_t x = 0; x < aerial_compositor->pages_x(); ++x) {
                if (x || y)
                    out.append(",");
                out.append(aerial_compositor->page_seasonal(x, y) ? "true" : "false");
            }
    out.append("]}");
    return std::move(out).finish();
}

// Drops the built decal products. An existing compositor loses its layer too, so no
// page composed after an input change shows underlays of the replaced inputs.
void discard_aerial_decals() noexcept {
    discard_settlement_models();
    aerial_decal_layer.reset();
    std::vector<float>{}.swap(aerial_flattened);
    std::string{}.swap(aerial_decals_json);
    if (aerial_compositor && (!aerial_compositor->decal_layer().records.empty() ||
                              !aerial_compositor->decal_layer().images.empty())) {
        try {
            // An empty layer is always accepted (validate_aerial_decal_layer).
            aerial_compositor->set_decal_layer(openrtw::AerialDecalLayer{});
        } catch (...) {
            discard_aerial_compositor();
        }
        aerial_page_published = aerial_tile_published = false;
    }
}

void clear_aerial_decals() noexcept {
    discard_aerial_decals();
    aerial_bases.reset();
    std::vector<openrtw::AerialDecalImage>{}.swap(aerial_base_images);
    aerial_cultures.reset();
    faction_cultures.reset();
    std::string{}.swap(aerial_bases_json);
    aerial_bases_json_current = false;
}

// NUL-terminated name argument of at most `limit` bytes before the NUL. Native
// callers own a readable string; WASM pointers are additionally checked against
// linear memory and the scan never leaves it.
std::string_view name_input(const char* text, std::size_t limit) {
    if (!text)
        throw std::runtime_error("Name argument is missing");
    std::size_t available = limit + 1;
#ifdef __EMSCRIPTEN__
    const auto start = reinterpret_cast<std::uintptr_t>(text);
    const auto heap_size = emscripten_get_heap_size();
    if (start >= heap_size)
        throw std::runtime_error("Name argument is outside WASM memory");
    if (heap_size - start < available)
        available = heap_size - start;
#endif
    for (std::size_t i = 0; i < available; ++i)
        if (text[i] == '\0') {
            if (!i)
                throw std::runtime_error("Name argument is empty");
            return {text, i};
        }
    throw std::runtime_error("Name argument is not NUL-terminated within the API byte limit");
}

// Shortest round-trip decimal of a finite float (std::to_chars); null otherwise.
void json_float(Json& out, float value) {
    if (!std::isfinite(value)) {
        out.append("null");
        return;
    }
    std::array<char, 64> text{};
    const auto result = std::to_chars(text.data(), text.data() + text.size(), value);
    if (result.ec != std::errc{})
        throw std::runtime_error("Cannot encode aerial decal number");
    out.append({text.data(), static_cast<std::size_t>(result.ptr - text.data())});
}

std::string aerial_bases_snapshot() {
    const auto& bases = *aerial_bases;
    Json out;
    out.append("{\"schema\":\"openrtw-aerial-bases-v1\",\"entries\":[");
    std::size_t loaded = 0;
    for (std::size_t i = 0; i < bases.entries.size(); ++i) {
        const auto& entry = bases.entries[i];
        const auto& image = aerial_base_images[i];
        loaded += image.width != 0;
        if (i)
            out.append(",");
        out.append("{\"index\":");
        out.integer(i);
        out.append(",\"name\":");
        out.string(entry.type);
        out.append(",\"filename\":");
        out.string(entry.filename);
        out.append(",\"range\":");
        json_float(out, entry.range);
        out.append(",\"loaded\":");
        out.append(image.width ? "true" : "false");
        out.append(",\"width\":");
        out.integer(image.width);
        out.append(",\"height\":");
        out.integer(image.height);
        out.append("}");
    }
    out.append("],\"imagesLoaded\":");
    out.integer(loaded);
    out.append(",\"cultures\":");
    if (aerial_cultures) {
        out.append("[");
        for (std::size_t c = 0; c < aerial_cultures->cultures.size(); ++c) {
            if (c)
                out.append(",");
            out.string(aerial_cultures->cultures[c].name);
        }
        out.append("],\"unresolvedNames\":[");
        for (std::size_t n = 0; n < aerial_cultures->unresolved.size(); ++n) {
            if (n)
                out.append(",");
            out.string(aerial_cultures->unresolved[n]);
        }
        out.append("]");
    } else
        out.append("null,\"unresolvedNames\":null");
    out.append(",\"factionCultures\":");
    if (faction_cultures) {
        out.append("[");
        for (std::size_t f = 0; f < faction_cultures->size(); ++f) {
            if (f)
                out.append(",");
            out.append("{\"faction\":");
            out.string((*faction_cultures)[f].faction);
            out.append(",\"culture\":");
            out.string((*faction_cultures)[f].culture);
            out.append("}");
        }
        out.append("]");
    } else
        out.append("null");
    out.append("}");
    return std::move(out).finish();
}

std::string_view aerial_object_type_wire(openrtw::AerialMapObjectType type) noexcept {
    switch (type) {
    case openrtw::AerialMapObjectType::settlement:
        return "settlement";
    case openrtw::AerialMapObjectType::fort:
        return "fort";
    case openrtw::AerialMapObjectType::port:
        return "port";
    case openrtw::AerialMapObjectType::watchtower:
        return "watchtower";
    }
    return "unknown";
}

std::string aerial_decals_snapshot(const openrtw::AerialDecalLayer& layer,
                                   const openrtw::AerialMapObjects& objects,
                                   std::span<const openrtw::AerialDecalSelection> selections,
                                   const openrtw::AerialFlattening& flattening) {
    const auto& bases = *aerial_bases;
    const auto& cultures = *aerial_cultures;
    std::vector<const openrtw::AerialDecalSelection*> selectionOf(objects.objects.size(), nullptr);
    std::size_t withoutImage = 0;
    for (const auto& selection : selections) {
        selectionOf[selection.object] = &selection;
        withoutImage += layer.images[selection.base].width == 0;
    }
    std::array<std::size_t, 4> byType{};
    for (const auto& object : objects.objects)
        ++byType[static_cast<std::size_t>(object.type) -
                 static_cast<std::size_t>(openrtw::AerialMapObjectType::settlement)];
    std::size_t cells = 0, maxPerCell = 0, flagged = 0;
    for (std::uint32_t y = 0; y < layer.height; ++y)
        for (std::uint32_t x = 0; x < layer.width; ++x) {
            const auto count = layer.records_at(x, y).size();
            cells += count != 0;
            maxPerCell = std::max(maxPerCell, count);
        }
    for (const auto flag : flattening.chunkFlags)
        flagged += flag != 0;
    Json out;
    out.append("{\"schema\":\"openrtw-aerial-decals-v1\",\"width\":");
    out.integer(layer.width);
    out.append(",\"height\":");
    out.integer(layer.height);
    out.append(",\"objectCount\":");
    out.integer(objects.objects.size());
    out.append(",\"settlements\":");
    out.integer(byType[0]);
    out.append(",\"forts\":");
    out.integer(byType[1]);
    out.append(",\"ports\":");
    out.integer(byType[2]);
    out.append(",\"watchtowers\":");
    out.integer(byType[3]);
    out.append(",\"selections\":");
    out.integer(selections.size());
    out.append(",\"selectionsWithoutImage\":");
    out.integer(withoutImage);
    out.append(",\"records\":");
    out.integer(layer.records.size());
    out.append(",\"recordCells\":");
    out.integer(cells);
    out.append(",\"maxRecordsPerCell\":");
    out.integer(maxPerCell);
    out.append(",\"flattenedPoints\":");
    out.integer(flattening.points.size());
    out.append(",\"flattenedCells\":");
    out.integer(flagged);
    out.append(",\"unresolved\":[");
    for (std::size_t i = 0; i < objects.problems.size(); ++i) {
        if (i)
            out.append(",");
        out.string(objects.problems[i]);
    }
    out.append("],\"objects\":[");
    for (std::size_t i = 0; i < objects.objects.size(); ++i) {
        const auto& object = objects.objects[i];
        const auto* selection = selectionOf[i];
        if (i)
            out.append(",");
        out.append("{\"type\":");
        out.string(aerial_object_type_wire(object.type));
        out.append(",\"region\":");
        out.string(object.region);
        out.append(",\"x\":");
        out.integer(object.x);
        out.append(",\"y\":");
        out.integer(object.y);
        out.append(",\"culture\":");
        out.string(cultures.cultures[object.culture].name);
        out.append(",\"level\":");
        out.integer(object.level);
        out.append(",\"wall\":");
        out.integer(object.wall);
        out.append(",\"base\":");
        if (selection) {
            out.integer(selection->base);
            out.append(",\"decal\":");
            out.string(bases.entries[selection->base].type);
            out.append(",\"range\":");
            json_float(out, selection->range);
            out.append(",\"image\":");
            out.append(layer.images[selection->base].width ? "true" : "false");
        } else
            out.append("-1,\"decal\":null,\"range\":null,\"image\":false");
        out.append("}");
    }
    out.append("]}");
    return std::move(out).finish();
}

std::string climate_snapshot(const openrtw::ClimatePalette& value) {
    Json out;
    out.append("{\"definitions\":[");
    std::size_t opaque = 0;
    for (std::size_t i = 0; i < value.definitions.size(); ++i) {
        const auto& d = value.definitions[i];
        if (i)
            out.append(",");
        out.append("{\"name\":");
        out.string(d.name);
        out.append(",\"rgb\":[");
        for (std::size_t c = 0; c < 3; ++c) {
            if (c)
                out.append(",");
            out.integer(d.colour[c]);
        }
        out.append("],\"heat\":");
        out.integer(d.heat);
        out.append(",\"declarationLine\":");
        out.integer(d.declarationLine);
        out.append(",\"definitionLine\":");
        out.integer(d.definitionLine);
        out.append(",\"colourLine\":");
        out.integer(d.colourLine);
        out.append(",\"heatLine\":");
        out.integer(d.heatLine);
        out.append(",\"opaqueRows\":");
        out.integer(d.opaqueRows.size());
        out.append("}");
        opaque += d.opaqueRows.size();
    }
    out.append("],\"counts\":{\"definitions\":");
    out.integer(value.definitions.size());
    out.append(",\"opaqueRows\":");
    out.integer(opaque);
    out.append("}}");
    return std::move(out).finish();
}

} // namespace

extern "C" {
std::uint32_t openrtw_api_version() noexcept {
    return 1;
}

const char* openrtw_core_contract_json() noexcept {
    return core_contract_json;
}


int openrtw_begin_battle(std::uint32_t playerId, std::uint32_t enemyId,
                         std::uint32_t expectedGeneration, std::uint32_t expectedRevision,
                         std::uint32_t expectedOrderRevision) noexcept {
    try {
        require_campaign_available();
        if (!campaign_session || !unit_definitions || !battle_models ||
            expectedGeneration != session_generation ||
            expectedRevision != campaign_session->revision() ||
            expectedOrderRevision != campaign_session->order_revision())
            throw std::runtime_error("Battle needs current campaign and complete unit catalogs");
        if (next_battle_generation == std::numeric_limits<std::uint32_t>::max())
            throw std::runtime_error("Battle generation limit reached");
        const auto generation = next_battle_generation + 1;
        auto next = std::make_unique<openrtw::BattleSession>(openrtw::create_rome_battle_session(
            *campaign_session, *unit_definitions, *battle_models, playerId, enemyId));
        auto json = battle_snapshot(*next, generation, session_generation);
        battle_session.swap(next);
        battle_session_json.swap(json);
        battle_generation = next_battle_generation = generation;
        battle_campaign_generation = session_generation;
        battle_campaign_revision = expectedRevision;
        battle_campaign_order_revision = expectedOrderRevision;
        clear_error();
        return 1;
    } catch (const std::exception& exception) {
        fail(exception.what());
    } catch (...) {
        fail("Unknown battle admission failure");
    }
    return 0;
}

const char* openrtw_battle_json() noexcept {
    return battle_session ? battle_session_json.c_str() : nullptr;
}

// Save bytes are borrowed until successful export, battle mutation/replacement,
// leave or reset. Failed calls preserve both save and battle publications.
int openrtw_export_battle_save(std::uint32_t generation, std::uint32_t revision) noexcept {
    try {
        require_battle(generation);
        auto bytes = battle_session->encode_save(battle_save_identity, revision);
        battle_save.swap(bytes);
        clear_error();
        return 1;
    } catch (const std::exception& error) {
        fail(error.what());
    } catch (...) {
        fail("Unknown battle save export failure");
    }
    return 0;
}
const std::uint8_t* openrtw_battle_save_bytes() noexcept {
    return battle_save.empty() ? nullptr : battle_save.data();
}
std::uint32_t openrtw_battle_save_size() noexcept {
    return static_cast<std::uint32_t>(battle_save.size());
}
int openrtw_import_battle_save(const std::uint8_t* bytes, std::size_t size,
                             std::uint32_t generation, std::uint32_t revision) noexcept {
    try {
        require_battle(generation);
        if (revision != battle_session->revision())
            throw std::runtime_error("Battle changed; refresh before loading");
        validate_input(bytes, size, openrtw::BattleSession::save_max_bytes);
        if (next_battle_generation == std::numeric_limits<std::uint32_t>::max())
            throw std::runtime_error("Battle generation limit reached");
        // Source rows are owned and immutable, including eliminated rows.
        // Reconstruct the exact expected encounter without retaining a campaign
        // pointer or rejoining mutable catalogs during save admission.
        openrtw::BattleEncounter encounter;
        encounter.origin = battle_session->origin();
        for (const auto& unit : battle_session->units()) {
            const auto side = unit.team == openrtw::BattleTeam::Player ? 0u : 1u;
            encounter.armies[side].push_back({unit.sourceUnit, unit.profile});
        }
        auto next = std::make_unique<openrtw::BattleSession>(
            openrtw::BattleSession::decode_save(encounter, battle_save_identity, {bytes, size}));
        const auto nextGeneration = next_battle_generation + 1;
        auto json = battle_snapshot(*next, nextGeneration, battle_campaign_generation);
        battle_session.swap(next);
        battle_session_json.swap(json);
        battle_generation = next_battle_generation = nextGeneration;
        std::vector<std::uint8_t>{}.swap(battle_save);
        clear_error();
        return 1;
    } catch (const std::exception& error) {
        fail(error.what());
    } catch (...) {
        fail("Unknown battle save import failure");
    }
    return 0;
}

int openrtw_export_campaign_battle_save(
    std::uint32_t expectedCampaignGeneration, std::uint32_t expectedCampaignRevision,
    std::uint32_t expectedCampaignOrderRevision, std::uint32_t expectedBattleGeneration,
    std::uint32_t expectedBattleRevision) noexcept {
    try {
        require_battle(expectedBattleGeneration);
        if (!campaign || !region_map || expectedCampaignGeneration != session_generation ||
            expectedCampaignRevision != campaign_session->revision() ||
            expectedCampaignOrderRevision != campaign_session->order_revision())
            throw std::runtime_error("Campaign session changed; save the current campaign again");
        auto nextCampaignSave =
            campaign_session->encode_save(campaign_json, region_map->rgb);
        auto nextBattleSave = battle_session->encode_save(battle_save_identity,
                                                          expectedBattleRevision);
        campaign_save.swap(nextCampaignSave);
        battle_save.swap(nextBattleSave);
        clear_error();
        return 1;
    } catch (const std::exception& exception) {
        fail(exception.what());
    } catch (...) {
        fail("Unknown campaign battle save export failure");
    }
    return 0;
}

int openrtw_import_campaign_battle_save(
    const std::uint8_t* campaignBytes, std::size_t campaignSize, const std::uint8_t* battleBytes,
    std::size_t battleSize, std::uint32_t playerId, std::uint32_t enemyId,
    std::uint32_t expectedCampaignGeneration, std::uint32_t expectedCampaignRevision,
    std::uint32_t expectedCampaignOrderRevision, std::uint32_t expectedBattleGeneration,
    std::uint32_t expectedBattleRevision) noexcept {
    try {
        if (!campaign_session || !campaign || !world_grid || !region_map || !unit_definitions ||
            !battle_models || expectedCampaignGeneration != session_generation ||
            expectedCampaignRevision != campaign_session->revision() ||
            expectedCampaignOrderRevision != campaign_session->order_revision())
            throw std::runtime_error(
                "Campaign battle load needs current campaign and complete unit catalogs");
        if (expectedBattleGeneration == 0) {
            if (expectedBattleRevision != 0)
                throw std::runtime_error("Absent battle revision must be zero");
            if (battle_session)
                throw std::runtime_error("Battle exists; refresh before loading a campaign battle");
        } else {
            require_battle(expectedBattleGeneration);
            if (expectedBattleRevision != battle_session->revision())
                throw std::runtime_error("Battle changed; refresh before loading");
        }
        validate_input(campaignBytes, campaignSize, openrtw::campaign_session_save_max_bytes);
        validate_input(battleBytes, battleSize, openrtw::BattleSession::save_max_bytes);
        if (next_session_generation == std::numeric_limits<std::uint32_t>::max())
            throw std::runtime_error("Campaign session limit reached");
        if (next_battle_generation == std::numeric_limits<std::uint32_t>::max())
            throw std::runtime_error("Battle generation limit reached");
        const auto campaignGeneration = next_session_generation + 1;
        const auto battleGeneration = next_battle_generation + 1;
        auto nextCampaign =
            std::make_unique<openrtw::CampaignSession>(openrtw::CampaignSession::decode_save(
                *campaign, world_grid->width, world_grid->height, campaign_json, region_map->rgb,
                {campaignBytes, campaignSize}, campaign_fog_initial.get(),
                campaign_session->fog_identity(),
                campaign_session->production() ? campaign_session->production()->catalog : nullptr));
        const auto encounter = openrtw::make_rome_battle_encounter(
            *nextCampaign, *unit_definitions, *battle_models, playerId, enemyId);
        auto nextBattle = std::make_unique<openrtw::BattleSession>(
            openrtw::BattleSession::decode_save(encounter, battle_save_identity,
                                                {battleBytes, battleSize}));
        auto nextCampaignJson = session_snapshot(*nextCampaign, campaignGeneration);
        auto nextBattleJson =
            battle_snapshot(*nextBattle, battleGeneration, campaignGeneration);
        campaign_session.swap(nextCampaign);
        battle_session.swap(nextBattle);
        campaign_session_json.swap(nextCampaignJson);
        battle_session_json.swap(nextBattleJson);
        session_generation = next_session_generation = campaignGeneration;
        battle_generation = next_battle_generation = battleGeneration;
        battle_campaign_generation = campaignGeneration;
        battle_campaign_revision = campaign_session->revision();
        battle_campaign_order_revision = campaign_session->order_revision();
        if (campaign_session->production()) {
            ++production_presentation_epoch;
            retire_production_settlement_presentation();
        }
        if (settlement_view)
            settlement_view->clear();
        std::string{}.swap(settlement_inspection_json);
        settlement_inspection_projection = false;
        std::string{}.swap(campaign_army_json);
        invalidate_campaign_command_caches();
        std::vector<std::uint8_t>{}.swap(battle_save);
        clear_error();
        return 1;
    } catch (const std::exception& exception) {
        fail(exception.what());
    } catch (...) {
        fail("Unknown campaign battle save import failure");
    }
    return 0;
}

int openrtw_battle_move(std::uint32_t id, std::int32_t x, std::int32_t y, std::uint32_t generation,
                        std::uint32_t revision) noexcept {
    return apply_battle(generation, [&](auto& value) { return value.move(id, x, y, revision); });
}

int openrtw_battle_attack(std::uint32_t id, std::uint32_t targetId, std::uint32_t generation,
                          std::uint32_t revision) noexcept {
    return apply_battle(generation,
                        [&](auto& value) { return value.attack(id, targetId, revision); });
}

int openrtw_battle_hold(std::uint32_t id, std::uint32_t generation,
                        std::uint32_t revision) noexcept {
    return apply_battle(generation, [&](auto& value) { return value.hold(id, revision); });
}

int openrtw_step_battle(std::uint32_t ticks, std::uint32_t generation,
                        std::uint32_t revision) noexcept {
    return apply_battle(generation, [&](auto& value) { return value.step(ticks, revision); });
}

int openrtw_retreat_battle(std::uint32_t generation, std::uint32_t revision) noexcept {
    return apply_battle(generation, [&](auto& value) { return value.retreat(revision); });
}

// Return is allowed before or after an outcome. It abandons only owned battle
// state: campaign/save publications keep their identity, bytes and pointers.
int openrtw_leave_battle(std::uint32_t generation, std::uint32_t revision) noexcept {
    try {
        require_battle(generation);
        if (revision != battle_session->revision())
            throw std::runtime_error("Battle changed; refresh before returning");
        clear_battle();
        clear_error();
        return 1;
    } catch (const std::exception& exception) {
        fail(exception.what());
    } catch (...) {
        fail("Unknown battle return failure");
    }
    return 0;
}

int openrtw_load_dds_texture(const std::uint8_t* bytes, std::size_t size) noexcept {
    try {
        validate_input(bytes, size, openrtw::dds_max_input_bytes);
        auto next = std::make_unique<openrtw::DdsTexture>(openrtw::load_dds_texture({bytes, size}));
        auto json = dds_snapshot(*next);
        dds_texture.swap(next);
        dds_texture_json.swap(json);
        clear_error();
        return 1;
    } catch (const std::exception& exception) {
        fail(exception.what());
    } catch (...) {
        fail("Unknown DDS texture loading failure");
    }
    return 0;
}

int openrtw_load_dds_texture_legacy_flags(const std::uint8_t* bytes, std::size_t size) noexcept {
    try {
        validate_input(bytes, size, openrtw::dds_max_input_bytes);
        auto next = std::make_unique<openrtw::DdsTexture>(
            openrtw::load_dds_texture_legacy_flags({bytes, size}));
        auto json = dds_snapshot(*next);
        dds_texture.swap(next);
        dds_texture_json.swap(json);
        clear_error();
        return 1;
    } catch (const std::exception& exception) {
        fail(exception.what());
    } catch (...) {
        fail("Unknown DDS texture loading failure");
    }
    return 0;
}

const char* openrtw_dds_texture_json() noexcept {
    return dds_texture ? dds_texture_json.c_str() : nullptr;
}

// Module-owned source/JSON survive failed loads and unrelated publications.
// A successful DDS replacement or reset invalidates them; aliased inputs are
// safe because parsing, source ownership and JSON staging precede both swaps.
const std::uint8_t* openrtw_dds_texture_source_bytes() noexcept {
    return dds_texture ? dds_texture->sourceBytes.data() : nullptr;
}

std::uint32_t openrtw_dds_texture_source_size() noexcept {
    return dds_texture ? static_cast<std::uint32_t>(dds_texture->sourceBytes.size()) : 0;
}

int openrtw_load_cas_mesh(const std::uint8_t* bytes, std::size_t size) noexcept {
    try {
        validate_input(bytes, size, openrtw::cas_max_input_bytes);
        auto next = std::make_unique<openrtw::CasStaticModel>(
            openrtw::load_cas_static_model({bytes, size}));
        auto json = cas_snapshot(*next);
        cas_mesh.swap(next);
        cas_mesh_json.swap(json);
        std::string{}.swap(campaign_shadow_json);
        clear_error();
        return 1;
    } catch (const std::exception& exception) {
        fail(exception.what());
    } catch (...) {
        fail("Unknown CAS mesh loading failure");
    }
    return 0;
}

// Explicit reviewed single-static-mesh 3.12 profile. The default entry above
// never retries it; all allocation and JSON work precedes shared publication.
int openrtw_load_cas_mesh_repeated_static_count312(const std::uint8_t* bytes,
                                                   std::size_t size) noexcept {
    try {
        validate_input(bytes, size, openrtw::cas_max_input_bytes);
        auto next = std::make_unique<openrtw::CasStaticModel>(
            openrtw::load_cas_static_model_repeated_static_count312({bytes, size}));
        auto json = cas_snapshot(*next);
        cas_mesh.swap(next);
        cas_mesh_json.swap(json);
        std::string{}.swap(campaign_shadow_json);
        clear_error();
        return 1;
    } catch (const std::exception& exception) {
        fail(exception.what());
    } catch (...) {
        fail("Unknown explicit CAS 3.12 mesh loading failure");
    }
    return 0;
}

// Dedicated explicit profiles share the existing owned publication. They are
// never tried by the default reader and do not modify any other subsystem.
static int
publish_cas_profile(const std::uint8_t* bytes, std::size_t size,
                    openrtw::CasStaticModel (*load)(std::span<const std::uint8_t>)) noexcept {
    try {
        validate_input(bytes, size, openrtw::cas_max_input_bytes);
        auto next = std::make_unique<openrtw::CasStaticModel>(load({bytes, size}));
        auto json = cas_snapshot(*next);
        cas_mesh.swap(next);
        cas_mesh_json.swap(json);
        std::string{}.swap(campaign_shadow_json);
        clear_error();
        return 1;
    } catch (const std::exception& exception) {
        fail(exception.what());
    } catch (...) {
        fail("Unknown explicit CAS profile loading failure");
    }
    return 0;
}

// General strat-model profile; legacy publications retain their existing wire shape.
int openrtw_load_cas_mesh_any(const std::uint8_t* bytes, std::size_t size) noexcept {
    return publish_cas_profile(bytes, size, openrtw::load_cas_static_model_any);
}

int openrtw_load_cas_mesh_terminal_kind7_316(const std::uint8_t* bytes, std::size_t size) noexcept {
    return publish_cas_profile(bytes, size, openrtw::load_cas_static_model_terminal_kind7_316);
}

int openrtw_load_cas_mesh_rider_repeated_count312(const std::uint8_t* bytes,
                                                  std::size_t size) noexcept {
    return publish_cas_profile(bytes, size, openrtw::load_cas_static_model_rider_repeated_count312);
}

int openrtw_load_cas_mesh_empty_static305(const std::uint8_t* bytes, std::size_t size) noexcept {
    return publish_cas_profile(bytes, size, openrtw::load_cas_static_model_empty_static305);
}

// Independent owned animation data. No mesh/campaign/battle state is modified.
// Failed loads and frame requests retain every previous animation publication;
// successful replacement clears the previous frame. Copy views before awaits.
int openrtw_load_cas_animation(const std::uint8_t* bytes, std::size_t size) noexcept {
    try {
        validate_input(bytes, size, openrtw::cas_animation_max_input_bytes);
        auto next =
            std::make_unique<openrtw::CasAnimation>(openrtw::load_cas_animation({bytes, size}));
        auto json = openrtw::cas_animation_snapshot(*next);
        cas_animation.swap(next);
        cas_animation_json.swap(json);
        std::string{}.swap(cas_animation_frame_json);
        clear_error();
        return 1;
    } catch (const std::exception& exception) {
        fail(exception.what());
    } catch (...) {
        fail("Unknown CAS animation loading failure");
    }
    return 0;
}

int openrtw_load_cas_animation_standing11(const std::uint8_t* bytes, std::size_t size) noexcept {
    try {
        validate_input(bytes, size, openrtw::cas_animation_max_input_bytes);
        auto next = std::make_unique<openrtw::CasAnimation>(
            openrtw::load_cas_animation_standing11({bytes, size}));
        auto json = openrtw::cas_animation_snapshot(*next);
        cas_animation.swap(next);
        cas_animation_json.swap(json);
        std::string{}.swap(cas_animation_frame_json);
        clear_error();
        return 1;
    } catch (const std::exception& exception) {
        fail(exception.what());
    } catch (...) {
        fail("Unknown CAS standing11 animation loading failure");
    }
    return 0;
}

int openrtw_select_cas_animation_frame(std::uint32_t frameIndex) noexcept {
    try {
        if (!cas_animation)
            throw std::runtime_error("Load a supported animation before selecting a frame");
        auto json = openrtw::cas_animation_frame_snapshot(*cas_animation, frameIndex);
        cas_animation_frame_json.swap(json);
        clear_error();
        return 1;
    } catch (const std::exception& exception) {
        fail(exception.what());
    } catch (...) {
        fail("Unknown CAS animation frame failure");
    }
    return 0;
}

const char* openrtw_cas_animation_json() noexcept {
    return cas_animation ? cas_animation_json.c_str() : nullptr;
}
const char* openrtw_cas_animation_frame_json() noexcept {
    return cas_animation && !cas_animation_frame_json.empty() ? cas_animation_frame_json.c_str()
                                                              : nullptr;
}
const std::uint8_t* openrtw_cas_animation_source_bytes() noexcept {
    return cas_animation ? cas_animation->sourceBytes.data() : nullptr;
}
std::uint32_t openrtw_cas_animation_source_size() noexcept {
    return cas_animation ? static_cast<std::uint32_t>(cas_animation->sourceBytes.size()) : 0;
}

const char* openrtw_cas_mesh_json() noexcept {
    return cas_mesh ? cas_mesh_json.c_str() : nullptr;
}

// Exact module-owned source span and JSON live until the next successful mesh
// load or reset. Failed loads preserve both, including when input aliases them.
const std::uint8_t* openrtw_cas_mesh_source_bytes() noexcept {
    return cas_mesh ? cas_mesh->sourceBytes.data() : nullptr;
}

std::uint32_t openrtw_cas_mesh_source_size() noexcept {
    return cas_mesh ? static_cast<std::uint32_t>(cas_mesh->sourceBytes.size()) : 0;
}

int openrtw_build_campaign_shadow_volume(const float* diffuseDirection,
                                         std::uint32_t yaw) noexcept {
    try {
        if (!cas_mesh)
            throw std::runtime_error("Load a supported CAS mesh before building shadows");
        if (!diffuseDirection)
            throw std::runtime_error("Campaign shadow direction is null");
#ifdef __EMSCRIPTEN__
        const auto start = reinterpret_cast<std::uintptr_t>(diffuseDirection);
        const auto heap_size = emscripten_get_heap_size();
        if (start > heap_size || sizeof(float) * 3 > heap_size - start)
            throw std::runtime_error("Campaign shadow direction is outside WASM memory");
#endif
        if (yaw > 0xffff)
            throw std::runtime_error("Campaign shadow yaw exceeds the supported range");
        const std::array<float, 3> direction{diffuseDirection[0], diffuseDirection[1],
                                             diffuseDirection[2]};
        auto json = openrtw::campaign_shadow_volume_json(openrtw::build_campaign_shadow_volume(
            *cas_mesh, direction, static_cast<std::uint16_t>(yaw)));
        campaign_shadow_json.swap(json);
        clear_error();
        return 1;
    } catch (const std::exception& exception) {
        fail(exception.what());
    } catch (...) {
        fail("Unknown campaign shadow construction failure");
    }
    return 0;
}

// Module-owned wire lives until the next successful shadow build, a successful
// CAS replacement or reset. Null means no volume was built for the current CAS.
const char* openrtw_campaign_shadow_json() noexcept {
    return campaign_shadow_json.empty() ? nullptr : campaign_shadow_json.c_str();
}

int openrtw_load_unit_definitions(const std::uint8_t* bytes, std::size_t size) noexcept {
    try {
        require_campaign_available();
        validate_input(bytes, size, openrtw::battle_catalog_max_input_bytes);
        auto next = std::make_unique<openrtw::UnitDefinitions>(
            openrtw::load_unit_definitions({reinterpret_cast<const char*>(bytes), size}));
        auto json = catalog_snapshot(next->records.size(),
                                     battle_models ? battle_models->records.size() : 0);
        if (campaign_session && campaign_session->production()) invalidate_campaign_session();
        unit_definitions.swap(next);
        battle_catalog_json.swap(json);
        std::string{}.swap(campaign_army_json);
        clear_error();
        return 1;
    } catch (const std::exception& exception) {
        fail(exception.what());
    } catch (...) {
        fail("Unknown unit definition loading failure");
    }
    return 0;
}

int openrtw_load_battle_models(const std::uint8_t* bytes, std::size_t size) noexcept {
    try {
        require_campaign_available();
        validate_input(bytes, size, openrtw::battle_catalog_max_input_bytes);
        auto next = std::make_unique<openrtw::BattleModels>(
            openrtw::load_battle_models({reinterpret_cast<const char*>(bytes), size}));
        auto json = catalog_snapshot(unit_definitions ? unit_definitions->records.size() : 0,
                                     next->records.size());
        battle_models.swap(next);
        battle_catalog_json.swap(json);
        std::string{}.swap(campaign_army_json);
        clear_error();
        return 1;
    } catch (const std::exception& exception) {
        fail(exception.what());
    } catch (...) {
        fail("Unknown battle model loading failure");
    }
    return 0;
}

const char* openrtw_battle_catalog_json() noexcept {
    return battle_catalog_json.empty() ? nullptr : battle_catalog_json.c_str();
}

// Returned JSON survives commands/turns, but a successful catalog replacement,
// army query, source/session replacement or reset invalidates it. On refusal,
// nullptr is returned and any previously acquired publication remains intact.
const char* openrtw_campaign_army_json(std::uint32_t id,
                                       std::uint32_t expectedGeneration) noexcept {
    try {
        if (!campaign_session || expectedGeneration != session_generation)
            throw std::runtime_error("Campaign session changed; select the character again");
        if (id >= campaign_session->actors().size() || campaign_session->actors()[id].id != id)
            throw std::runtime_error("Select a valid character");
        auto json =
            army_snapshot(*campaign_session, campaign_session->actors()[id], session_generation);
        campaign_army_json.swap(json);
        clear_error();
        return campaign_army_json.c_str();
    } catch (const std::exception& exception) {
        fail(exception.what());
    } catch (...) {
        fail("Unknown campaign army projection failure");
    }
    return nullptr;
}

int openrtw_load_terrain(const std::uint8_t* bytes, std::size_t size) noexcept {
    try {
        require_campaign_available();
        validate_input(bytes, size, max_hgt_bytes);
        auto next = std::make_unique<openrtw::Terrain>(openrtw::load_hgt({bytes, size}));
        if (campaign_session && (campaign_session->fog() || campaign_session->production()))
            invalidate_campaign_session();
        terrain.swap(next);
        category_grid.reset();
        point_category_grid.reset();
        discard_aerial_compositor();
        // Flattening reads the HGT points; the layer extent follows the terrain.
        discard_aerial_decals();
        clear_error();
        return 1;
    } catch (const std::exception& exception) {
        fail(exception.what());
    } catch (...) {
        fail("Unknown terrain loading failure");
    }
    return 0;
}

int openrtw_load_campaign(const std::uint8_t* bytes, std::size_t size) noexcept {
    try {
        require_campaign_available();
        validate_input(bytes, size, openrtw::campaign_max_input_bytes);
        const std::string_view input{reinterpret_cast<const char*>(bytes), size};
        auto next = std::make_unique<openrtw::Campaign>(openrtw::load_campaign(input));
        auto next_json = openrtw::campaign_snapshot(*next);
        auto next_view =
            std::make_unique<openrtw::SettlementView>(openrtw::SettlementView::create(*next));
        // Both swaps are nonthrowing; all parsing/encoding/allocation precedes
        // publication. Calls are synchronous, with no reentrant observers.
        campaign.swap(next);
        campaign_json.swap(next_json);
        settlement_view.swap(next_view);
        invalidate_campaign_session();
        // Decal map objects come from the descr_strat settlements.
        discard_aerial_decals();
        clear_error();
        return 1;
    } catch (const std::exception& exception) {
        fail(exception.what());
    } catch (...) {
        fail("Unknown campaign loading failure");
    }
    return 0;
}

int openrtw_begin_campaign_session() noexcept {
    try {
        require_campaign_available();
        if (!campaign || !world_grid)
            throw std::runtime_error("Campaign session needs loaded campaign and world grid");
        if (next_session_generation == std::numeric_limits<std::uint32_t>::max())
            throw std::runtime_error("Campaign session limit reached");
        const auto generation = next_session_generation + 1;
        std::unique_ptr<openrtw::CampaignFog> initialFog;
        std::string fogIdentity, fogPolicy, fogReason;
        std::vector<std::string> fogLimitations;
        if (terrain && category_grid && regions && settlement_buildings && campaign_fog_features &&
            campaign_fog_traits && campaign_fog_ancillaries) {
            auto inputs = openrtw::build_campaign_fog_inputs(
                *campaign, *terrain, *category_grid, *world_grid, *regions, *settlement_buildings,
                *campaign_fog_features, *campaign_fog_traits, *campaign_fog_ancillaries);
            initialFog =
                std::make_unique<openrtw::CampaignFog>(openrtw::project_initial_campaign_fog(
                    *campaign, inputs.terrain, inputs.factionTables, inputs.lineOfSight,
                    inputs.structures, inputs.landmarks));
            fogIdentity = std::move(inputs.identity);
            fogPolicy = std::move(inputs.policy);
            fogLimitations = std::move(inputs.limitations);
        } else {
            fogReason = "Missing campaign fog inputs:";
            if (!terrain)
                fogReason += " terrain";
            if (!category_grid)
                fogReason += " categories";
            if (!regions)
                fogReason += " regions";
            if (!settlement_buildings)
                fogReason += " settlementBuildings";
            if (!campaign_fog_features)
                fogReason += " campaignFogFeatures";
            if (!campaign_fog_traits)
                fogReason += " campaignFogTraits";
            if (!campaign_fog_ancillaries)
                fogReason += " campaignFogAncillaries";
        }
        auto next = std::make_unique<openrtw::CampaignSession>(openrtw::CampaignSession::create(
            *campaign, world_grid->width, world_grid->height,
            initialFog ? std::optional<openrtw::CampaignFog>{*initialFog} : std::nullopt,
            std::move(fogIdentity)));
        auto json = session_snapshot(*next, generation);
        campaign_session.swap(next);
        campaign_session_json.swap(json);
        campaign_fog_initial.swap(initialFog);
        campaign_fog_policy.swap(fogPolicy);
        campaign_fog_reason.swap(fogReason);
        campaign_fog_limitations.swap(fogLimitations);
        session_generation = next_session_generation = generation;
        if (settlement_view)
            settlement_view->clear();
        std::string{}.swap(settlement_inspection_json);
        settlement_inspection_projection = false;
        std::string{}.swap(campaign_army_json);
        invalidate_campaign_command_caches();
        clear_error();
        return 1;
    } catch (const std::exception& exception) {
        fail(exception.what());
    } catch (...) {
        fail("Unknown campaign session initialization failure");
    }
    return 0;
}

const char* openrtw_campaign_session_json() noexcept {
    return campaign_session ? campaign_session_json.c_str() : nullptr;
}

int openrtw_load_campaign_fog_traits(const std::uint8_t* bytes, std::size_t size) noexcept {
    try {
        require_campaign_available();
        validate_input(bytes, size, 16 * 1024 * 1024);
        auto next = std::make_unique<openrtw::FogTraits>(
            openrtw::load_campaign_fog_traits({reinterpret_cast<const char*>(bytes), size}));
        campaign_fog_traits.swap(next);
        invalidate_campaign_session();
        clear_error();
        return 1;
    } catch (const std::exception& exception) {
        fail(exception.what());
    } catch (...) {
        fail("Unknown campaign fog traits loading failure");
    }
    return 0;
}

int openrtw_load_campaign_fog_ancillaries(const std::uint8_t* bytes, std::size_t size) noexcept {
    try {
        require_campaign_available();
        validate_input(bytes, size, 16 * 1024 * 1024);
        auto next = std::make_unique<openrtw::FogAncillaries>(
            openrtw::load_campaign_fog_ancillaries({reinterpret_cast<const char*>(bytes), size}));
        campaign_fog_ancillaries.swap(next);
        invalidate_campaign_session();
        clear_error();
        return 1;
    } catch (const std::exception& exception) {
        fail(exception.what());
    } catch (...) {
        fail("Unknown campaign fog ancillaries loading failure");
    }
    return 0;
}

int openrtw_load_campaign_fog_features(const std::uint8_t* bytes, std::size_t size) noexcept {
    try {
        require_campaign_available();
        validate_input(bytes, size, 18 + openrtw::region_map_max_pixels * 3);
        auto next = std::make_unique<openrtw::RgbImage>(openrtw::load_tga24({bytes, size}));
        campaign_fog_features.swap(next);
        invalidate_campaign_session();
        clear_error();
        return 1;
    } catch (const std::exception& exception) {
        fail(exception.what());
    } catch (...) {
        fail("Unknown campaign fog features loading failure");
    }
    return 0;
}

const char* openrtw_campaign_fog_json(std::uint32_t factionIndex,
                                      std::uint32_t expectedGeneration) noexcept {
    try {
        require_campaign_available();
        if (!campaign_session || expectedGeneration != session_generation ||
            factionIndex >= campaign_session->source().factions.size())
            throw std::runtime_error(
                "Campaign fog query has a stale generation or invalid faction");
        const auto* fog = campaign_session->fog();
        std::size_t visible = 0, remembered = 0, unseen = 0;
        if (fog)
            for (const auto b : fog->table(factionIndex)) {
                if (b >= 2)
                    ++visible;
                else if (b == 1)
                    ++remembered;
                else
                    ++unseen;
            }
        std::uint32_t player = 0;
        const auto& factions = campaign_session->source().factions;
        for (std::uint32_t i = 0; i < factions.size(); ++i)
            if (factions[i].id == "romans_julii") {
                player = i;
                break;
            }
        Json out;
        out.append("{\"schema\":\"openrtw-campaign-fog-v1\",\"state\":");
        out.string(fog ? "ready" : "unavailable");
        out.append(",\"available\":");
        out.append(fog ? "true" : "false");
        out.append(",\"reason\":");
        if (fog)
            out.append("null");
        else
            out.string(campaign_fog_reason);
        out.append(",\"generation\":");
        out.integer(session_generation);
        out.append(",\"revision\":");
        out.integer(campaign_session->revision());
        out.append(",\"factionIndex\":");
        out.integer(factionIndex);
        out.append(",\"defaultPlayerFactionIndex\":");
        out.integer(player);
        out.append(",\"width\":");
        out.integer(campaign_session->width());
        out.append(",\"height\":");
        out.integer(campaign_session->height());
        out.append(",\"tableIndex\":");
        if (fog)
            out.integer(fog->faction_tables()[factionIndex]);
        else
            out.append("null");
        out.append(",\"byteLength\":");
        out.integer(fog ? fog->table(factionIndex).size() : 0);
        out.append(",\"visibleCount\":");
        out.integer(visible);
        out.append(",\"rememberedCount\":");
        out.integer(remembered);
        out.append(",\"unseenCount\":");
        out.integer(unseen);
        out.append(",\"policy\":");
        out.string(campaign_fog_policy);
        out.append(",\"sourceIdentity\":");
        out.string(campaign_session->fog_identity());
        out.append(",\"limitations\":[");
        for (std::size_t i = 0; i < campaign_fog_limitations.size(); ++i) {
            if (i)
                out.append(",");
            out.string(campaign_fog_limitations[i]);
        }
        out.append("]}");
        auto json = std::move(out).finish();
        campaign_fog_wire.swap(json);
        clear_error();
        return campaign_fog_wire.c_str();
    } catch (const std::exception& exception) {
        fail(exception.what());
    } catch (...) {
        fail("Unknown campaign fog query failure");
    }
    return nullptr;
}

// These getters allocate nothing. Session replacement/movement/reset invalidates
// the view; WASM memory growth can detach JS views. Copy before another call.
const std::uint8_t* openrtw_campaign_fog_data(std::uint32_t factionIndex,
                                              std::uint32_t expectedGeneration) noexcept {
    if (!campaign_session || expectedGeneration != session_generation ||
        factionIndex >= campaign_session->source().factions.size()) {
        fail("Campaign fog query has a stale generation or invalid faction");
        return nullptr;
    }
    if (!campaign_session->fog()) {
        fail("Campaign fog is unavailable; inspect campaign fog JSON");
        return nullptr;
    }
    clear_error();
    return campaign_session->fog()->table(factionIndex).data();
}
std::uint32_t openrtw_campaign_fog_size(std::uint32_t factionIndex,
                                        std::uint32_t expectedGeneration) noexcept {
    if (!openrtw_campaign_fog_data(factionIndex, expectedGeneration))
        return 0;
    return static_cast<std::uint32_t>(campaign_session->fog()->table(factionIndex).size());
}

// Inspection owns UI selection only. Allocation/encoding completes before
// nonthrowing publication, and no campaign/session/save publication changes.
int openrtw_select_settlement(std::uint32_t id, std::uint32_t expectedGeneration) noexcept {
    try {
        require_campaign_available();
        if (!campaign_session || !settlement_view || expectedGeneration != session_generation)
            throw std::runtime_error("Campaign changed; refresh settlement inspection");
        if (id >= settlement_view->records().size())
            throw std::runtime_error("Choose a valid source settlement");
        auto json = settlement_snapshot(&settlement_view->records()[id], session_generation,
                                        campaign_session.get());
        settlement_view->select(id);
        settlement_inspection_json.swap(json);
        settlement_inspection_generation = session_generation;
        settlement_inspection_epoch = production_presentation_epoch;
        settlement_inspection_revision = campaign_session->revision();
        settlement_inspection_order_revision = campaign_session->order_revision();
        settlement_inspection_projection = campaign_session->production() != nullptr;
        clear_error();
        return 1;
    } catch (const std::exception& exception) {
        fail(exception.what());
    } catch (...) {
        fail("Unknown settlement selection failure");
    }
    return 0;
}

int openrtw_clear_settlement(std::uint32_t expectedGeneration) noexcept {
    try {
        require_campaign_available();
        if (!campaign_session || !settlement_view || expectedGeneration != session_generation)
            throw std::runtime_error("Campaign changed; refresh settlement inspection");
        auto json = settlement_snapshot(nullptr, session_generation, campaign_session.get());
        settlement_view->clear();
        settlement_inspection_json.swap(json);
        settlement_inspection_generation = session_generation;
        settlement_inspection_epoch = production_presentation_epoch;
        settlement_inspection_revision = campaign_session->revision();
        settlement_inspection_order_revision = campaign_session->order_revision();
        settlement_inspection_projection = campaign_session->production() != nullptr;
        clear_error();
        return 1;
    } catch (const std::exception& exception) {
        fail(exception.what());
    } catch (...) {
        fail("Unknown settlement clear failure");
    }
    return 0;
}

const char* openrtw_settlement_inspection_json() noexcept {
    if (!campaign_session || settlement_inspection_json.empty() ||
        settlement_inspection_stale())
        return nullptr;
    return settlement_inspection_json.c_str();
}

// Preview1 publishes a report, including ordinary refusals; it applies no move.
// Preview0 preserves prior report/session/save. Copy JSON before another call.
int openrtw_preview_campaign_route(std::uint32_t id, std::int32_t x, std::int32_t y,
                                   std::uint32_t expectedGeneration,
                                   std::uint32_t expectedRevision) noexcept {
    try {
        require_campaign_available();
        if (!campaign_session || expectedGeneration != session_generation ||
            expectedRevision != campaign_session->revision())
            throw std::runtime_error("Campaign changed; refresh the route");
        const auto preview = campaign_session->preview_route(id, x, y, expectedRevision);
        auto json = route_snapshot(preview, session_generation, campaign_session->order_revision());
        campaign_route_json.swap(json);
        clear_error();
        return 1;
    } catch (const std::exception& exception) {
        fail(exception.what());
    } catch (...) {
        fail("Unknown campaign route preview failure");
    }
    return 0;
}

const char* openrtw_campaign_route_json() noexcept {
    return campaign_route_json.empty() ? nullptr : campaign_route_json.c_str();
}

int openrtw_move_campaign_route(std::uint32_t id, std::int32_t x, std::int32_t y,
                                std::uint32_t expectedGeneration,
                                std::uint32_t expectedRevision) noexcept {
    try {
        require_campaign_available();
        if (!campaign_session || expectedGeneration != session_generation ||
            expectedRevision != campaign_session->revision())
            throw std::runtime_error("Campaign changed; refresh the route");
        auto next = std::make_unique<openrtw::CampaignSession>(*campaign_session);
        const auto result = next->move_route(id, x, y, expectedRevision);
        if (!result.accepted()) {
            fail(route_error(result.status));
            return 0;
        }
        auto json = session_snapshot(*next, session_generation);
        campaign_session.swap(next);
        campaign_session_json.swap(json);
        invalidate_campaign_command_caches();
        clear_error();
        return 1;
    } catch (const std::exception& exception) {
        fail(exception.what());
    } catch (...) {
        fail("Unknown campaign route movement failure");
    }
    return 0;
}

// A separate report keeps the existing full-route behavior separate. An Ok
// advance report owns only this turn's affordable prefix, while requiredAp is
// the full remaining distance. Preview0 preserves both reports and all state.
int openrtw_preview_campaign_advance(std::uint32_t id, std::int32_t x, std::int32_t y,
                                     std::uint32_t expectedGeneration,
                                     std::uint32_t expectedRevision) noexcept {
    try {
        require_campaign_available();
        if (!campaign_session || expectedGeneration != session_generation ||
            expectedRevision != campaign_session->revision())
            throw std::runtime_error("Campaign changed; refresh the route");
        const auto preview = campaign_session->preview_route_advance(id, x, y, expectedRevision);
        auto json =
            route_snapshot(preview, session_generation, campaign_session->order_revision(), true);
        campaign_advance_json.swap(json);
        clear_error();
        return 1;
    } catch (const std::exception& exception) {
        fail(exception.what());
    } catch (...) {
        fail("Unknown campaign advance preview failure");
    }
    return 0;
}

const char* openrtw_campaign_advance_json() noexcept {
    return campaign_advance_json.empty() ? nullptr : campaign_advance_json.c_str();
}

int openrtw_advance_campaign_route(std::uint32_t id, std::int32_t x, std::int32_t y,
                                   std::uint32_t expectedGeneration,
                                   std::uint32_t expectedRevision) noexcept {
    try {
        require_campaign_available();
        if (!campaign_session || expectedGeneration != session_generation ||
            expectedRevision != campaign_session->revision())
            throw std::runtime_error("Campaign changed; refresh the route");
        auto next = std::make_unique<openrtw::CampaignSession>(*campaign_session);
        const auto result = next->advance_route(id, x, y, expectedRevision);
        if (!result.accepted()) {
            fail(route_error(result.status));
            return 0;
        }
        auto json = session_snapshot(*next, session_generation);
        campaign_session.swap(next);
        campaign_session_json.swap(json);
        invalidate_campaign_command_caches();
        clear_error();
        return 1;
    } catch (const std::exception& exception) {
        fail(exception.what());
    } catch (...) {
        fail("Unknown campaign advance failure");
    }
    return 0;
}

// Journey commands bind both movement state and manually edited orders. Every
// mutation and its JSON are prepared privately before publishing either one.
int openrtw_set_campaign_destination(std::uint32_t id, std::int32_t x, std::int32_t y,
                                     std::uint32_t expectedGeneration,
                                     std::uint32_t expectedRevision,
                                     std::uint32_t expectedOrderRevision) noexcept {
    try {
        require_campaign_available();
        if (!campaign_session || expectedGeneration != session_generation)
            throw std::runtime_error("Campaign session changed; select the character again");
        auto next = std::make_unique<openrtw::CampaignSession>(*campaign_session);
        const auto result =
            next->set_destination(id, x, y, expectedRevision, expectedOrderRevision);
        if (!result.accepted()) {
            if (result.status == openrtw::CampaignCommandStatus::NoOp)
                fail("Journey destination is unchanged");
            else
                fail(command_error(result.status));
            return 0;
        }
        auto json = session_snapshot(*next, session_generation);
        campaign_session.swap(next);
        campaign_session_json.swap(json);
        invalidate_campaign_command_caches();
        clear_error();
        return 1;
    } catch (const std::exception& exception) {
        fail(exception.what());
    } catch (...) {
        fail("Unknown campaign destination failure");
    }
    return 0;
}

int openrtw_cancel_campaign_destination(std::uint32_t id, std::uint32_t expectedGeneration,
                                        std::uint32_t expectedRevision,
                                        std::uint32_t expectedOrderRevision) noexcept {
    try {
        require_campaign_available();
        if (!campaign_session || expectedGeneration != session_generation)
            throw std::runtime_error("Campaign session changed; select the character again");
        auto next = std::make_unique<openrtw::CampaignSession>(*campaign_session);
        const auto result = next->cancel_destination(id, expectedRevision, expectedOrderRevision);
        if (!result.accepted()) {
            if (result.status == openrtw::CampaignCommandStatus::NoOp)
                fail("This character has no journey to cancel");
            else
                fail(command_error(result.status));
            return 0;
        }
        auto json = session_snapshot(*next, session_generation);
        campaign_session.swap(next);
        campaign_session_json.swap(json);
        invalidate_campaign_command_caches();
        clear_error();
        return 1;
    } catch (const std::exception& exception) {
        fail(exception.what());
    } catch (...) {
        fail("Unknown campaign destination cancellation failure");
    }
    return 0;
}

int openrtw_continue_campaign_journey(std::uint32_t id, std::uint32_t expectedGeneration,
                                      std::uint32_t expectedRevision,
                                      std::uint32_t expectedOrderRevision) noexcept {
    try {
        require_campaign_available();
        if (!campaign_session || expectedGeneration != session_generation)
            throw std::runtime_error("Campaign session changed; select the character again");
        auto next = std::make_unique<openrtw::CampaignSession>(*campaign_session);
        const auto result = next->continue_journey(id, expectedRevision, expectedOrderRevision);
        if (!result.accepted()) {
            fail(route_error(result.status));
            return 0;
        }
        auto json = session_snapshot(*next, session_generation);
        campaign_session.swap(next);
        campaign_session_json.swap(json);
        invalidate_campaign_command_caches();
        clear_error();
        return 1;
    } catch (const std::exception& exception) {
        fail(exception.what());
    } catch (...) {
        fail("Unknown campaign journey failure");
    }
    return 0;
}

// Return1 admits a complete pass, including empty/all-blocked reports. Zero
// steps replaces only this report, preserving session/save/preview pointers.
// All allocating work finishes before publishing either state or report.
int openrtw_continue_campaign_faction_journeys(std::uint32_t sourceFactionIndex,
                                               std::uint32_t expectedGeneration,
                                               std::uint32_t expectedRevision,
                                               std::uint32_t expectedOrderRevision) noexcept {
    try {
        require_campaign_available();
        if (!campaign_session || expectedGeneration != session_generation)
            throw std::runtime_error("Campaign changed; refresh the faction journeys");
        auto next = std::make_unique<openrtw::CampaignSession>(*campaign_session);
        const auto result = next->continue_faction_journeys(sourceFactionIndex, expectedRevision,
                                                            expectedOrderRevision);
        if (!result.admitted()) {
            fail(faction_journey_error(result.status));
            return 0;
        }
        auto report = faction_journeys_snapshot(result, session_generation);
        if (result.totalSteps != 0) {
            auto json = session_snapshot(*next, session_generation);
            campaign_session.swap(next);
            campaign_session_json.swap(json);
            invalidate_campaign_command_caches();
        }
        campaign_faction_journeys_json.swap(report);
        clear_error();
        return 1;
    } catch (const std::exception& exception) {
        fail(exception.what());
    } catch (...) {
        fail("Unknown faction journey failure");
    }
    return 0;
}

const char* openrtw_campaign_faction_journeys_json() noexcept {
    return campaign_faction_journeys_json.empty() ? nullptr
                                                  : campaign_faction_journeys_json.c_str();
}

// Save bytes are C++ owned. A successful export replaces this buffer; every
// successful session mutation/replacement/reset invalidates it. Failed calls
// preserve both the existing save buffer and session publication. JS must copy
// bytes synchronously before awaiting persistence or making another core call.
int openrtw_export_campaign_save(std::uint32_t expectedGeneration,
                                 std::uint32_t expectedRevision) noexcept {
    try {
        require_campaign_available();
        if (!campaign_session || !region_map || expectedGeneration != session_generation ||
            expectedRevision != campaign_session->revision())
            throw std::runtime_error("Campaign session changed; save the current campaign again");
        auto bytes = campaign_session->encode_save(campaign_json, region_map->rgb);
        campaign_save.swap(bytes);
        clear_error();
        return 1;
    } catch (const std::exception& exception) {
        fail(exception.what());
    } catch (...) {
        fail("Unknown campaign save export failure");
    }
    return 0;
}

const std::uint8_t* openrtw_campaign_save_bytes() noexcept {
    return campaign_save.empty() ? nullptr : campaign_save.data();
}

std::uint32_t openrtw_campaign_save_size() noexcept {
    return static_cast<std::uint32_t>(campaign_save.size());
}

int openrtw_import_campaign_save(const std::uint8_t* bytes, std::size_t size,
                                 std::uint32_t expectedGeneration,
                                 std::uint32_t expectedRevision) noexcept {
    try {
        require_campaign_available();
        if (!campaign_session || !campaign || !world_grid || !region_map ||
            expectedGeneration != session_generation ||
            expectedRevision != campaign_session->revision())
            throw std::runtime_error(
                "Campaign session changed; load into the current campaign again");
        validate_input(bytes, size, openrtw::campaign_session_save_max_bytes);
        if (next_session_generation == std::numeric_limits<std::uint32_t>::max())
            throw std::runtime_error("Campaign session limit reached");
        const auto generation = next_session_generation + 1;
        auto next =
            std::make_unique<openrtw::CampaignSession>(openrtw::CampaignSession::decode_save(
                *campaign, world_grid->width, world_grid->height, campaign_json, region_map->rgb,
                {bytes, size}, campaign_fog_initial.get(), campaign_session->fog_identity(),
                campaign_session->production() ? campaign_session->production()->catalog : nullptr));
        auto json = session_snapshot(*next, generation);
        campaign_session.swap(next);
        campaign_session_json.swap(json);
        session_generation = next_session_generation = generation;
        if (campaign_session->production()) {
            ++production_presentation_epoch;
            retire_production_settlement_presentation();
        }
        if (settlement_view)
            settlement_view->clear();
        std::string{}.swap(settlement_inspection_json);
        settlement_inspection_projection = false;
        std::string{}.swap(campaign_army_json);
        invalidate_campaign_command_caches();
        clear_error();
        return 1;
    } catch (const std::exception& exception) {
        fail(exception.what());
    } catch (...) {
        fail("Unknown campaign save import failure");
    }
    return 0;
}

// Existing persistence exports retain their signatures. Journey UIs use the
// full order token so a pending save/load cannot overwrite a newer manual edit.
int openrtw_export_campaign_journey_save(std::uint32_t expectedGeneration,
                                         std::uint32_t expectedRevision,
                                         std::uint32_t expectedOrderRevision) noexcept {
    if (!campaign_session || expectedOrderRevision != campaign_session->order_revision()) {
        fail("Campaign orders changed; save the current campaign again");
        return 0;
    }
    return openrtw_export_campaign_save(expectedGeneration, expectedRevision);
}

int openrtw_import_campaign_journey_save(const std::uint8_t* bytes, std::size_t size,
                                         std::uint32_t expectedGeneration,
                                         std::uint32_t expectedRevision,
                                         std::uint32_t expectedOrderRevision) noexcept {
    if (!campaign_session || expectedOrderRevision != campaign_session->order_revision()) {
        fail("Campaign orders changed; load into the current campaign again");
        return 0;
    }
    return openrtw_import_campaign_save(bytes, size, expectedGeneration, expectedRevision);
}

int openrtw_move_character(std::uint32_t id, std::int32_t x, std::int32_t y,
                           std::uint32_t expectedGeneration,
                           std::uint32_t expectedRevision) noexcept {
    try {
        require_campaign_available();
        if (!campaign_session || expectedGeneration != session_generation)
            throw std::runtime_error("Campaign session changed; select the character again");
        auto next = std::make_unique<openrtw::CampaignSession>(*campaign_session);
        const auto result = next->move(id, x, y, expectedRevision);
        if (!result.accepted()) {
            fail(command_error(result.status));
            return 0;
        }
        auto json = session_snapshot(*next, session_generation);
        campaign_session.swap(next);
        campaign_session_json.swap(json);
        invalidate_campaign_command_caches();
        clear_error();
        return 1;
    } catch (const std::exception& exception) {
        fail(exception.what());
    } catch (...) {
        fail("Unknown campaign movement failure");
    }
    return 0;
}

int openrtw_end_turn(std::uint32_t expectedGeneration, std::uint32_t expectedRevision) noexcept {
    try {
        require_campaign_available();
        if (!campaign_session || expectedGeneration != session_generation)
            throw std::runtime_error("Campaign session changed; refresh before ending the turn");
        auto next = std::make_unique<openrtw::CampaignSession>(*campaign_session);
        const auto result = next->end_turn(expectedRevision);
        if (!result.accepted()) {
            fail(command_error(result.status));
            return 0;
        }
        auto json = session_snapshot(*next, session_generation);
        campaign_session.swap(next);
        campaign_session_json.swap(json);
        // A completed building changes the authoritative presentation state. The
        // old scene/inspection wire is retired; callers rebuild/select afresh.
        if (campaign_session->production()) {
            ++production_presentation_epoch;
            retire_production_settlement_presentation();
        }
        invalidate_campaign_command_caches();
        clear_error();
        return 1;
    } catch (const std::exception& exception) {
        fail(exception.what());
    } catch (...) {
        fail("Unknown campaign turn failure");
    }
    return 0;
}

int openrtw_load_production_catalog(const std::uint8_t* bytes, std::size_t size) noexcept {
    try {
        require_campaign_available();
        validate_input(bytes, size, 2 * 1024 * 1024);
        if (!campaign_session || !unit_definitions) throw std::runtime_error("Production needs a campaign and unit definitions");
        auto catalog = openrtw::load_production_catalog({reinterpret_cast<const char*>(bytes), size}, *unit_definitions);
        if (faction_cultures) for (const auto& row : *faction_cultures) catalog->cultures[row.faction] = row.culture;
        if (regions) for (const auto& row : regions->definitions) catalog->resources[row.id] = row.resources;
        // Context affecting eligibility is included in exact save identity.
        for (const auto& [faction, culture] : catalog->cultures) catalog->identity += "\nC:" + faction + ":" + culture;
        for (const auto& [region, values] : catalog->resources) {
            catalog->identity += "\nR:" + region;
            for (const auto& resource : values) catalog->identity += ":" + resource;
        }
        auto next = std::make_unique<openrtw::CampaignSession>(*campaign_session);
        next->enable_production(std::move(catalog));
        auto json = session_snapshot(*next, session_generation);
        campaign_session.swap(next);campaign_session_json.swap(json);
        ++production_presentation_epoch;
        retire_production_settlement_presentation();
        invalidate_campaign_command_caches();clear_error();return 1;
    } catch (const std::exception& e) { fail(e.what()); } catch (...) { fail("Production catalog loading failed"); }
    return 0;
}
const char* openrtw_production_json(std::uint32_t city, std::uint32_t expectedGeneration) noexcept {
    try {
        require_campaign_available();
        if (!campaign_session || session_generation != expectedGeneration) throw std::runtime_error("Campaign production changed");
        auto json = openrtw::production_snapshot(*campaign_session, session_generation, city);
        campaign_production_json.swap(json);clear_error();return campaign_production_json.c_str();
    } catch (const std::exception& e) { fail(e.what()); } catch (...) { fail("Production projection failed"); }
    return nullptr;
}
int openrtw_production_command(std::uint32_t kind, std::uint32_t city, std::uint32_t first,
                               std::uint32_t second, std::uint32_t faction,
                               std::uint32_t expectedGeneration, std::uint32_t expectedRevision,
                               std::uint32_t expectedOrderRevision) noexcept {
    try {
        require_campaign_available();
        if (!campaign_session || session_generation != expectedGeneration || campaign_session->revision() != expectedRevision ||
            !campaign_session->production() || city >= campaign_session->production()->cities.size() ||
            campaign_session->production()->cities[city].faction != faction)
            throw std::runtime_error("Production settlement ownership or campaign changed");
        if (kind == 6) {
            if (!world_grid || !regions || second >= campaign_session->actors().size()) throw std::runtime_error("Select a local army");
            const auto& a = campaign_session->actors()[second];
            auto regionIndex = world_grid->regionIndices.at(static_cast<std::size_t>(a.currentY) * world_grid->width + a.currentX);
            if (regionIndex >= world_grid->palette.size()) throw std::runtime_error("Army is outside a known region");
            const auto color = world_grid->palette[regionIndex];
            const auto& region = campaign_session->production()->cities[city].region;
            const auto found = std::find_if(regions->definitions.begin(), regions->definitions.end(), [&](const auto& r) { return r.id == region && r.rgb == color; });
            if (found == regions->definitions.end()) throw std::runtime_error("Move the receiving army into this settlement region");
        }
        auto next = std::make_unique<openrtw::CampaignSession>(*campaign_session);
        next->production_command(kind, city, first, second, expectedOrderRevision);
        auto json = session_snapshot(*next, session_generation);
        campaign_session.swap(next);campaign_session_json.swap(json);
        ++production_presentation_epoch;
        retire_production_settlement_presentation();
        std::string{}.swap(campaign_army_json);
        invalidate_campaign_command_caches();clear_error();return 1;
    } catch (const std::exception& e) { fail(e.what()); } catch (...) { fail("Production command failed"); }
    return 0;
}

int openrtw_load_regions(const std::uint8_t* bytes, std::size_t size) noexcept {
    try {
        require_campaign_available();
        validate_input(bytes, size, openrtw::region_max_input_bytes);
        auto next = std::make_unique<openrtw::RegionDefinitions>(
            openrtw::load_regions({reinterpret_cast<const char*>(bytes), size}));
        auto json = region_snapshot(*next);
        if (campaign_session && (campaign_session->fog() || campaign_session->production()))
            invalidate_campaign_session();
        regions.swap(next);
        regions_json.swap(json);
        // Decal markers bind regions by their descr_regions colour.
        discard_aerial_decals();
        clear_error();
        return 1;
    } catch (const std::exception& exception) {
        fail(exception.what());
    } catch (...) {
        fail("Unknown region definitions loading failure");
    }
    return 0;
}

int openrtw_load_region_map(const std::uint8_t* bytes, std::size_t size) noexcept {
    try {
        require_campaign_available();
        validate_input(bytes, size, 18 + openrtw::region_map_max_pixels * 3);
        auto next = std::make_unique<openrtw::RgbImage>(openrtw::load_tga24({bytes, size}));
        region_map.swap(next);
        world_grid.reset();
        std::string{}.swap(world_grid_json);
        invalidate_campaign_session();
        discard_aerial_decals();
        clear_error();
        return 1;
    } catch (const std::exception& exception) {
        fail(exception.what());
    } catch (...) {
        fail("Unknown region map loading failure");
    }
    return 0;
}

int openrtw_build_world_grid() noexcept {
    try {
        require_campaign_available();
        if (!region_map)
            throw std::runtime_error("World grid needs a loaded region map");
        auto next = std::make_unique<openrtw::WorldGrid>(openrtw::build_world_grid(*region_map));
        auto json = grid_snapshot(*next);
        world_grid.swap(next);
        world_grid_json.swap(json);
        invalidate_campaign_session();
        // Decal objects sit on the grid's settlement/port markers.
        discard_aerial_decals();
        clear_error();
        return 1;
    } catch (const std::exception& exception) {
        fail(exception.what());
    } catch (...) {
        fail("Unknown world grid construction failure");
    }
    return 0;
}

int openrtw_load_ground_map(const std::uint8_t* bytes, std::size_t size) noexcept {
    try {
        require_campaign_available();
        validate_input(bytes, size, 18 + openrtw::region_map_max_pixels * 3);
        auto next = std::make_unique<openrtw::RgbImage>(openrtw::load_tga24({bytes, size}));
        if (campaign_session && (campaign_session->fog() || campaign_session->production()))
            invalidate_campaign_session();
        discard_settlement_models();
        ground_map.swap(next);
        category_grid.reset();
        point_category_grid.reset();
        discard_aerial_compositor();
        clear_error();
        return 1;
    } catch (const std::exception& exception) {
        fail(exception.what());
    } catch (...) {
        fail("Unknown ground map loading failure");
    }
    return 0;
}

int openrtw_build_categories() noexcept {
    try {
        require_campaign_available();
        if (!terrain || !ground_map)
            throw std::runtime_error("Categories need loaded terrain and ground map");
        auto next = std::make_unique<openrtw::CategoryGrid>(
            openrtw::build_category_grid(*terrain, *ground_map));
        if (campaign_session && campaign_session->fog() &&
            (!category_grid || category_grid->categories != next->categories ||
             category_grid->width != next->width || category_grid->height != next->height))
            invalidate_campaign_session();
        discard_settlement_models();
        category_grid.swap(next);
        discard_aerial_compositor();
        clear_error();
        return 1;
    } catch (const std::exception& exception) {
        fail(exception.what());
    } catch (...) {
        fail("Unknown category construction failure");
    }
    return 0;
}

// Independent owned full-point publication. A successful terrain/ground load,
// rebuild or reset invalidates its ID pointer; every refusal preserves it.
int openrtw_build_point_categories() noexcept {
    try {
        require_campaign_available();
        if (!terrain || !ground_map)
            throw std::runtime_error("Point categories need loaded terrain and ground map");
        auto next = std::make_unique<openrtw::CategoryPointGrid>(
            openrtw::build_category_point_grid(*terrain, *ground_map));
        point_category_grid.swap(next);
        discard_aerial_compositor();
        clear_error();
        return 1;
    } catch (const std::exception& exception) {
        fail(exception.what());
    } catch (...) {
        fail("Unknown point category construction failure");
    }
    return 0;
}

int openrtw_load_climates(const std::uint8_t* bytes, std::size_t size) noexcept {
    try {
        require_campaign_available();
        validate_input(bytes, size, openrtw::climate_max_input_bytes);
        auto next = std::make_unique<openrtw::ClimatePalette>(
            openrtw::load_climates({reinterpret_cast<const char*>(bytes), size}));
        auto json = climate_snapshot(*next);
        std::string{}.swap(campaign_trees_wire);
        climates.swap(next);
        climates_json.swap(json);
        climate_grid.reset();
        // Aerial ground types bind climate names/order/winter rows of this palette.
        clear_aerial();
        clear_error();
        return 1;
    } catch (const std::exception& exception) {
        fail(exception.what());
    } catch (...) {
        fail("Unknown climate definitions loading failure");
    }
    return 0;
}

int openrtw_load_climate_map(const std::uint8_t* bytes, std::size_t size) noexcept {
    try {
        require_campaign_available();
        validate_input(bytes, size, 18 + openrtw::region_map_max_pixels * 3);
        auto next = std::make_unique<openrtw::RgbImage>(openrtw::load_tga24({bytes, size}));
        std::string{}.swap(campaign_trees_wire);
        climate_map.swap(next);
        climate_grid.reset();
        discard_aerial_compositor();
        clear_error();
        return 1;
    } catch (const std::exception& exception) {
        fail(exception.what());
    } catch (...) {
        fail("Unknown climate map loading failure");
    }
    return 0;
}

int openrtw_build_climate_coefficients() noexcept {
    try {
        require_campaign_available();
        if (!climates || !climate_map)
            throw std::runtime_error("Climate coefficients need loaded definitions and map");
        auto next = std::make_unique<openrtw::ClimateCoefficientGrid>(
            openrtw::build_climate_coefficient_grid(*climates, *climate_map));
        std::string{}.swap(campaign_trees_wire);
        climate_grid.swap(next);
        clear_error();
        return 1;
    } catch (const std::exception& exception) {
        fail(exception.what());
    } catch (...) {
        fail("Unknown climate coefficient construction failure");
    }
    return 0;
}

// Aerial (campaign) ground compositor ABI. Every refusal changes only the
// error buffer: the epoch, compositor and page/tile publications stay intact.
// Ground types start a new epoch bound to the loaded climate palette:
// textures, patterns, compositor and page/tile publications reset on success.
int openrtw_load_aerial_ground_types(const std::uint8_t* bytes, std::size_t size) noexcept {
    try {
        require_campaign_available();
        validate_input(bytes, size, openrtw::aerial_ground_max_input_bytes);
        if (!climates)
            throw std::runtime_error("Aerial ground types need loaded climate definitions");
        auto next = std::make_unique<openrtw::AerialGroundTypes>(openrtw::load_aerial_ground_types(
            {reinterpret_cast<const char*>(bytes), size}, *climates));
        auto textures = std::make_unique<openrtw::AerialGroundTextureSet>(
            openrtw::make_aerial_ground_texture_set(*next));
        clear_aerial();
        aerial_types.swap(next);
        aerial_textures.swap(textures);
        clear_error();
        return 1;
    } catch (const std::exception& exception) {
        fail(exception.what());
    } catch (...) {
        fail("Unknown aerial ground types loading failure");
    }
    return 0;
}

// Report of the current epoch, regenerated lazily after a change. The pointer
// stays valid until the next call after an aerial change, a reset or a
// climate replacement. nullptr (error untouched) while no types are loaded.
// Texture "side" is 0 until loaded; pagesX/pagesY are 0 until ready.
const char* openrtw_aerial_ground_json() noexcept {
    if (!aerial_types)
        return nullptr;
    try {
        if (!aerial_ground_json_current) {
            auto json = aerial_ground_snapshot();
            aerial_ground_json.swap(json);
            aerial_ground_json_current = true;
        }
        return aerial_ground_json.c_str();
    } catch (const std::exception& exception) {
        fail(exception.what());
    } catch (...) {
        fail("Unknown aerial ground report failure");
    }
    return nullptr;
}

// Registry index from the report; the slot is replaced only on success.
int openrtw_load_aerial_ground_texture(std::uint32_t index, const std::uint8_t* bytes,
                                       std::size_t size) noexcept {
    try {
        require_campaign_available();
        require_open_aerial_epoch();
        if (index >= aerial_types->textureNames.size())
            throw std::runtime_error("Aerial ground texture index is outside the registry");
        validate_input(bytes, size, aerial_texture_max_tga_bytes);
        if (!aerial_textures) {
            auto fresh = std::make_unique<openrtw::AerialGroundTextureSet>(
                openrtw::make_aerial_ground_texture_set(*aerial_types));
            aerial_textures.swap(fresh);
        }
        openrtw::load_aerial_ground_texture(*aerial_textures, index, {bytes, size});
        aerial_ground_json_current = false;
        clear_error();
        return 1;
    } catch (const std::exception& exception) {
        fail(exception.what());
    } catch (...) {
        fail("Unknown aerial ground texture loading failure");
    }
    return 0;
}

int openrtw_load_aerial_weight_pattern(std::uint32_t slot, const std::uint8_t* bytes,
                                       std::size_t size) noexcept {
    try {
        require_campaign_available();
        require_open_aerial_epoch();
        if (slot >= aerial_pattern_slots)
            throw std::runtime_error("Aerial weight pattern slot must be 0..6");
        validate_input(bytes, size, aerial_weight_max_tga_bytes);
        const auto pattern =
            openrtw::aerial_weight_pattern(openrtw::decode_aerial_tga24({bytes, size}));
        aerial_patterns[slot] = pattern;
        aerial_pattern_loaded[slot] = true;
        aerial_ground_json_current = false;
        clear_error();
        return 1;
    } catch (const std::exception& exception) {
        fail(exception.what());
    } catch (...) {
        fail("Unknown aerial weight pattern loading failure");
    }
    return 0;
}

// Needs built cell/point categories, climates, climate map, every registry
// texture and all 7 patterns. A compositor that already exists was built from
// the current inputs (every replacement discards it), so a repeat succeeds
// without work. Built decals (openrtw_build_aerial_decals) are copied into the
// new compositor; without them it composes the plain ground.
int openrtw_build_aerial_compositor() noexcept {
    try {
        require_campaign_available();
        if (!aerial_types)
            throw std::runtime_error("Load the aerial ground types first");
        if (aerial_compositor) {
            clear_error();
            return 1;
        }
        if (!category_grid || !point_category_grid)
            throw std::runtime_error("Aerial compositor needs built cell and point categories");
        if (!climates || !climate_map)
            throw std::runtime_error(
                "Aerial compositor needs loaded climate definitions and climate map");
        for (const bool loaded : aerial_pattern_loaded)
            if (!loaded)
                throw std::runtime_error("Aerial compositor needs all 7 weight patterns");
        if (!aerial_textures || !openrtw::aerial_ground_texture_set_complete(*aerial_textures))
            throw std::runtime_error("Aerial compositor needs every registry ground texture");
        // The copy and its validation for this map precede the texture move, so a
        // refusal here keeps the epoch's textures; set_decal_layer then cannot refuse.
        openrtw::AerialDecalLayer decals;
        if (aerial_decal_layer) {
            openrtw::validate_aerial_decal_layer(*aerial_decal_layer, category_grid->width,
                                                 category_grid->height);
            decals = *aerial_decal_layer;
        }
        // The constructor moves the texture set only after complete success.
        auto next = std::make_unique<openrtw::AerialCampaignCompositor>(
            *category_grid, *point_category_grid, *climates, *climate_map, *aerial_types,
            std::move(*aerial_textures),
            std::span<const openrtw::AerialWeightPattern>(aerial_patterns));
        next->set_decal_layer(std::move(decals));
        aerial_compositor.swap(next);
        aerial_textures.reset();
        aerial_page_published = aerial_tile_published = false;
        aerial_ground_json_current = false;
        clear_error();
        return 1;
    } catch (const std::exception& exception) {
        fail(exception.what());
    } catch (...) {
        fail("Unknown aerial compositor construction failure");
    }
    return 0;
}

// Rendering-only (allowed during a battle). Page = 32x32 cells, 1024x1024
// RGBA8 row-major, north row first; slots beyond the map are (0,0,0,0).
// The previous page publication survives every refusal.
int openrtw_compose_aerial_page(std::uint32_t pageX, std::uint32_t pageY,
                                std::uint32_t winter) noexcept {
    try {
        if (!aerial_compositor)
            throw std::runtime_error("Build the aerial compositor before composing pages");
        const auto season = aerial_season(winter);
        if (pageX >= aerial_compositor->pages_x() || pageY >= aerial_compositor->pages_y())
            throw std::runtime_error("Aerial page is outside the map");
        // First use only; unpublished until a compose succeeds. compose_page
        // writes its private staging into `aerial_page` only on success.
        if (aerial_page.size() != openrtw::aerial_page_bytes)
            aerial_page.resize(openrtw::aerial_page_bytes);
        aerial_compositor->compose_page(pageX, pageY, season != 0, aerial_page);
        aerial_page_published = true;
        clear_error();
        return 1;
    } catch (const std::exception& exception) {
        fail(exception.what());
    } catch (...) {
        fail("Unknown aerial page composition failure");
    }
    return 0;
}

const std::uint8_t* openrtw_aerial_page_pixels() noexcept {
    return aerial_page_published ? aerial_page.data() : nullptr;
}
std::uint32_t openrtw_aerial_page_bytes() noexcept {
    return aerial_page_published ? static_cast<std::uint32_t>(aerial_page.size()) : 0;
}

// One 32x32 RGBA8 cell tile, row 0 = north edge.
int openrtw_compose_aerial_tile(std::uint32_t x, std::uint32_t y, std::uint32_t winter) noexcept {
    try {
        if (!aerial_compositor)
            throw std::runtime_error("Build the aerial compositor before composing tiles");
        const auto season = aerial_season(winter);
        if (x >= aerial_compositor->width() || y >= aerial_compositor->height())
            throw std::runtime_error("Aerial tile is outside the map");
        aerial_tile = aerial_compositor->compose_tile(x, y, season != 0);
        aerial_tile_published = true;
        clear_error();
        return 1;
    } catch (const std::exception& exception) {
        fail(exception.what());
    } catch (...) {
        fail("Unknown aerial tile composition failure");
    }
    return 0;
}

const std::uint8_t* openrtw_aerial_tile_pixels() noexcept {
    return aerial_tile_published ? aerial_tile.data() : nullptr;
}

// Aerial decal ABI. Call order: bases, cultures (resolve against the bases),
// faction cultures (any time), one image per bases row by type name, then
// openrtw_build_aerial_decals BEFORE openrtw_build_aerial_compositor (a compositor
// that already exists takes the new layer as well). Every refusal changes only the
// error buffer. Every successful load discards the built decal products.

int openrtw_load_aerial_bases(const std::uint8_t* bytes, std::size_t size) noexcept {
    try {
        require_campaign_available();
        validate_input(bytes, size, aerial_decal_text_max_bytes);
        auto next = std::make_unique<openrtw::AerialDecalBases>(
            openrtw::load_aerial_decal_bases({reinterpret_cast<const char*>(bytes), size}));
        std::vector<openrtw::AerialDecalImage> images(next->entries.size());
        discard_aerial_decals();
        aerial_bases.swap(next);
        aerial_base_images.swap(images);
        aerial_cultures.reset();
        aerial_bases_json_current = false;
        clear_error();
        return 1;
    } catch (const std::exception& exception) {
        fail(exception.what());
    } catch (...) {
        fail("Unknown aerial bases loading failure");
    }
    return 0;
}

int openrtw_load_cultures(const std::uint8_t* bytes, std::size_t size) noexcept {
    try {
        require_campaign_available();
        if (!aerial_bases)
            throw std::runtime_error("Load the aerial bases before the cultures");
        validate_input(bytes, size, aerial_decal_text_max_bytes);
        auto next =
            std::make_unique<openrtw::AerialCultureBindings>(openrtw::load_aerial_culture_bindings(
                {reinterpret_cast<const char*>(bytes), size}, *aerial_bases));
        discard_aerial_decals();
        aerial_cultures.swap(next);
        aerial_bases_json_current = false;
        clear_error();
        return 1;
    } catch (const std::exception& exception) {
        fail(exception.what());
    } catch (...) {
        fail("Unknown cultures loading failure");
    }
    return 0;
}

// descr_sm_factions.txt faction -> culture rows (OpenRTW minimal reader).
int openrtw_load_faction_cultures(const std::uint8_t* bytes, std::size_t size) noexcept {
    try {
        require_campaign_available();
        validate_input(bytes, size, openrtw::faction_cultures_max_input_bytes);
        auto next = std::make_unique<std::vector<openrtw::FactionCulture>>(
            openrtw::load_faction_cultures({reinterpret_cast<const char*>(bytes), size}));
        discard_aerial_decals();
        if (campaign_session && campaign_session->production()) invalidate_campaign_session();
        faction_cultures.swap(next);
        aerial_bases_json_current = false;
        clear_error();
        return 1;
    } catch (const std::exception& exception) {
        fail(exception.what());
    } catch (...) {
        fail("Unknown faction cultures loading failure");
    }
    return 0;
}

int openrtw_load_aerial_base_image(const char* name, const std::uint8_t* bytes,
                                   std::size_t size) noexcept {
    try {
        require_campaign_available();
        if (!aerial_bases)
            throw std::runtime_error("Load the aerial bases before their images");
        const auto type = name_input(name, aerial_decal_name_max_bytes);
        const auto index = aerial_bases->find(type);
        if (index < 0)
            throw std::runtime_error("Unknown aerial base type: " + std::string(type));
        validate_input(bytes, size, aerial_decal_max_tga_bytes);
        auto image = openrtw::load_aerial_decal_tga({bytes, size});
        discard_aerial_decals();
        aerial_base_images[static_cast<std::size_t>(index)] = std::move(image);
        aerial_bases_json_current = false;
        clear_error();
        return 1;
    } catch (const std::exception& exception) {
        fail(exception.what());
    } catch (...) {
        fail("Unknown aerial base image loading failure");
    }
    return 0;
}

// Bases report, regenerated lazily after a change: entries {index, name (type),
// filename, range, loaded, width, height}, imagesLoaded, cultures, unresolvedNames
// and factionCultures (null until loaded). nullptr (error untouched) while no bases
// are loaded. The pointer stays valid until the next call after a decal-input change
// or a reset.
const char* openrtw_aerial_bases_json() noexcept {
    if (!aerial_bases)
        return nullptr;
    try {
        if (!aerial_bases_json_current) {
            auto json = aerial_bases_snapshot();
            aerial_bases_json.swap(json);
            aerial_bases_json_current = true;
        }
        return aerial_bases_json.c_str();
    } catch (const std::exception& exception) {
        fail(exception.what());
    } catch (...) {
        fail("Unknown aerial bases report failure");
    }
    return nullptr;
}

int openrtw_build_aerial_decals() noexcept {
    try {
        require_campaign_available();
        if (!aerial_bases || !aerial_cultures || !faction_cultures)
            throw std::runtime_error(
                "Aerial decals need the loaded bases, cultures and faction cultures");
        if (!campaign || !regions || !world_grid || !terrain)
            throw std::runtime_error(
                "Aerial decals need the loaded campaign, regions, world grid and terrain");
        if (terrain->width != 2 * std::uint64_t{world_grid->width} + 1 ||
            terrain->height != 2 * std::uint64_t{world_grid->height} + 1)
            throw std::runtime_error(
                "Aerial decals need terrain with (2W+1)x(2H+1) points for the WxH world grid");
        const auto markers = openrtw::build_aerial_region_markers(*regions, *world_grid);
        const auto objects = openrtw::build_aerial_map_objects(*campaign, *faction_cultures,
                                                               *aerial_cultures, markers);
        const auto selections =
            openrtw::select_aerial_decals(objects.objects, *aerial_cultures, *aerial_bases);
        auto layer = std::make_unique<openrtw::AerialDecalLayer>(openrtw::build_aerial_decal_layer(
            world_grid->width, world_grid->height, selections, aerial_base_images));
        if (layer->records.size() > static_cast<std::size_t>(std::numeric_limits<int>::max()))
            throw std::runtime_error("Aerial decal record count exceeds the API range");
        const auto flattening = openrtw::build_aerial_flattening(*terrain, selections);
        std::vector<float> points;
        points.reserve(flattening.points.size() * 3);
        for (const auto& point : flattening.points) {
            points.push_back(static_cast<float>(point.px));
            points.push_back(static_cast<float>(point.py));
            points.push_back(point.height);
        }
        auto json = aerial_decals_snapshot(*layer, objects, selections, flattening);
        if (aerial_compositor) {
            // Refused (extent) before anything is published; the compositor then
            // keeps its previous layer.
            aerial_compositor->set_decal_layer(*layer);
            aerial_page_published = aerial_tile_published = false;
        }
        discard_settlement_models();
        aerial_decal_layer.swap(layer);
        aerial_flattened.swap(points);
        aerial_decals_json.swap(json);
        clear_error();
        return static_cast<int>(aerial_decal_layer->records.size());
    } catch (const std::exception& exception) {
        fail(exception.what());
    } catch (...) {
        fail("Unknown aerial decal construction failure");
    }
    return -1;
}

// Report of the last successful build (aerial_decals_snapshot); nullptr until built
// and after any decal-input change or reset.
const char* openrtw_aerial_decals_json() noexcept {
    return aerial_decal_layer ? aerial_decals_json.c_str() : nullptr;
}

// Flattened HGT points of the last build: count, then count (x, y, height) float
// triples. x, y are HGT point coordinates (index y*terrainWidth + x, y grows north
// like the HGT rows), height is in raw HGT units (before any renderer scale); sorted
// by (y, x). The native also forces these points' normals to (0,1,0). 0/nullptr
// until built and after any decal-input change or reset.
std::uint32_t openrtw_aerial_flattened_count() noexcept {
    return aerial_decal_layer ? static_cast<std::uint32_t>(aerial_flattened.size() / 3) : 0;
}
const float* openrtw_aerial_flattened_points() noexcept {
    return aerial_decal_layer && !aerial_flattened.empty() ? aerial_flattened.data() : nullptr;
}

// Initial-campaign settlement scene. Each loader stages its parse before
// invalidating the last scene; refused inputs preserve the publication.
int openrtw_load_culture_models(const std::uint8_t* bytes, std::size_t size) noexcept {
    try {
        require_campaign_available();
        validate_input(bytes, size, openrtw::culture_models_max_input_bytes);
        auto next = std::make_unique<openrtw::CultureModelTable>(
            openrtw::load_culture_models({reinterpret_cast<const char*>(bytes), size}));
        discard_settlement_models();
        settlement_cultures.swap(next);
        settlement_symbol_anchor.reset();
        clear_error();
        return 1;
    } catch (const std::exception& exception) {
        fail(exception.what());
    } catch (...) {
        fail("Unknown settlement culture loading failure");
    }
    return 0;
}

int openrtw_load_settlement_buildings(const std::uint8_t* bytes, std::size_t size) noexcept {
    try {
        require_campaign_available();
        validate_input(bytes, size, 16 * 1024 * 1024);
        auto next = std::make_unique<openrtw::BuildingModelLevels>(
            openrtw::load_building_model_levels({reinterpret_cast<const char*>(bytes), size}));
        // The renderer may load the same EDB after session creation. An identical
        // port level table does not replace the fog source or lose its history.
        if (campaign_session && campaign_session->fog() &&
            (!settlement_buildings || settlement_buildings->ports != next->ports))
            invalidate_campaign_session();
        discard_settlement_models();
        settlement_buildings.swap(next);
        clear_error();
        return 1;
    } catch (const std::exception& exception) {
        fail(exception.what());
    } catch (...) {
        fail("Unknown settlement building loading failure");
    }
    return 0;
}

const char* openrtw_settlement_symbol_path() noexcept {
    return settlement_cultures ? settlement_cultures->symbol.c_str() : nullptr;
}

int openrtw_set_settlement_symbol_anchor(double y) noexcept {
    try {
        require_campaign_available();
        if (!settlement_cultures || !std::isfinite(y) || std::abs(y) > 10000)
            throw std::runtime_error(
                "Settlement symbol anchor is missing or outside policy bounds");
        discard_settlement_models();
        settlement_symbol_anchor = static_cast<float>(y);
        clear_error();
        return 1;
    } catch (const std::exception& exception) {
        fail(exception.what());
    } catch (...) {
        fail("Unknown settlement symbol anchor failure");
    }
    return 0;
}

// Owned source placement. The browser copies the JSON before building another season.
// Native9B92B6 admits a structure's complete ground decal when its owner cell
// has been explored. Changed page records are owned by the compositor.
int openrtw_sync_aerial_decal_fog(std::uint32_t faction, std::uint32_t generation) noexcept {
    try {
        require_campaign_available();
        if (!aerial_compositor || !campaign_session || generation != session_generation ||
            !campaign_session->fog() || faction >= campaign_session->fog()->faction_tables().size())
            throw std::runtime_error(
                "Aerial decal fog requires the current session and player table");
        const auto pages =
            aerial_compositor->set_decal_visibility(campaign_session->fog()->table(faction));
        if (!pages.empty())
            aerial_page_published = aerial_tile_published = false;
        clear_error();
        return static_cast<int>(pages.size());
    } catch (const std::exception& exception) {
        fail(exception.what());
    } catch (...) {
        fail("Unknown aerial decal visibility failure");
    }
    return -1;
}
const std::uint32_t* openrtw_aerial_decal_dirty_pages() noexcept {
    static_assert(sizeof(openrtw::AerialDecalPage) == 2 * sizeof(std::uint32_t));
    if (!aerial_compositor || aerial_compositor->decal_dirty_pages().empty())
        return nullptr;
    return &aerial_compositor->decal_dirty_pages().data()->pageX;
}

int openrtw_build_campaign_trees(std::uint32_t winter) noexcept {
    try {
        require_campaign_available();
        if (winter > 1 || !climates || !climate_grid || !category_grid || !terrain)
            throw std::runtime_error(
                "Campaign trees need climate, category and terrain inputs and season0/1");
        openrtw::AerialFlattening flattening;
        flattening.width = category_grid->width;
        flattening.height = category_grid->height;
        flattening.chunkFlags.assign(std::size_t{flattening.width} * flattening.height, 0);
        for (std::size_t i = 0; i < aerial_flattened.size(); i += 3) {
            const auto px = static_cast<std::uint32_t>(aerial_flattened[i]);
            const auto py = static_cast<std::uint32_t>(aerial_flattened[i + 1]);
            flattening.points.push_back({px, py, aerial_flattened[i + 2]});
            for (int dy = (py & 1u) ? 0 : -1; dy <= 0; ++dy)
                for (int dx = (px & 1u) ? 0 : -1; dx <= 0; ++dx) {
                    const auto x = static_cast<int>(px / 2) + dx;
                    const auto y = static_cast<int>(py / 2) + dy;
                    if (x >= 0 && y >= 0 && x < static_cast<int>(flattening.width) &&
                        y < static_cast<int>(flattening.height))
                        flattening.chunkFlags[std::size_t(y) * flattening.width + x] = 1;
                }
        }
        const auto scene =
            openrtw::build_campaign_trees(*climates, *climate_grid, *category_grid, *terrain,
                                          winter != 0, aerial_decal_layer ? &flattening : nullptr);
        auto json = openrtw::campaign_trees_json(scene);
        if (json.size() > 16 * 1024 * 1024 || scene.models.size() > 100000)
            throw std::runtime_error("Campaign tree publication exceeds its budget");
        campaign_trees_wire.swap(json);
        clear_error();
        return static_cast<int>(scene.models.size());
    } catch (const std::exception& exception) {
        fail(exception.what());
    } catch (...) {
        fail("Unknown campaign tree construction failure");
    }
    return -1;
}
const char* openrtw_campaign_trees_json() noexcept {
    return campaign_trees_wire.empty() ? nullptr : campaign_trees_wire.c_str();
}

int openrtw_build_settlement_models() noexcept {
    try {
        require_campaign_available();
        if (!settlement_cultures || !settlement_buildings || !faction_cultures || !campaign ||
            !regions || !world_grid || !terrain || !category_grid)
            throw std::runtime_error("Settlement models need cultures, building levels, factions, "
                                     "campaign, regions, world grid, terrain and categories");
        if (!settlement_symbol_anchor)
            throw std::runtime_error("Load the settlement symbol anchor before building models");
        const auto markers = openrtw::build_aerial_region_markers(*regions, *world_grid);
        openrtw::AerialFlattening flattening;
        flattening.width = world_grid->width;
        flattening.height = world_grid->height;
        for (std::size_t i = 0; i < aerial_flattened.size(); i += 3)
            flattening.points.push_back({static_cast<std::uint32_t>(aerial_flattened[i]),
                                         static_cast<std::uint32_t>(aerial_flattened[i + 1]),
                                         aerial_flattened[i + 2]});
        const openrtw::CampaignProduction* production =
            campaign_session ? campaign_session->production() : nullptr;
        openrtw::Campaign projected;
        const openrtw::Campaign* settlementSource = campaign.get();
        if (production) {
            // Owned deep copy borrowed only for this synchronous build; the
            // returned scene owns every published string.
            projected = project_settlement_models(*campaign, *production);
            settlementSource = &projected;
        }
        auto next =
            std::make_unique<openrtw::SettlementModelScene>(openrtw::build_settlement_models(
                *settlementSource, *regions, *faction_cultures, *settlement_cultures,
                *settlement_buildings, markers, *terrain, *category_grid,
                aerial_decal_layer ? &flattening : nullptr, *settlement_symbol_anchor));
        auto json = openrtw::settlement_models_json(*next);
        if (next->models.size() > static_cast<std::size_t>(std::numeric_limits<int>::max()))
            throw std::runtime_error("Settlement model count exceeds API range");
        settlement_models.swap(next);
        settlement_models_wire.swap(json);
        settlement_models_generation = session_generation;
        settlement_models_epoch = production_presentation_epoch;
        settlement_models_projection = production != nullptr;
        clear_error();
        return static_cast<int>(settlement_models->models.size());
    } catch (const std::exception& exception) {
        fail(exception.what());
    } catch (...) {
        fail("Unknown settlement model construction failure");
    }
    return -1;
}

const char* openrtw_settlement_models_json() noexcept {
    if (!settlement_models || settlement_models_stale())
        return nullptr;
    return settlement_models_wire.c_str();
}

int openrtw_load_pcm(const std::uint8_t* bytes, std::size_t size) noexcept {
    try {
        require_campaign_available();
        validate_input(bytes, size, openrtw::pcm_max_input_bytes);
        auto next = std::make_unique<openrtw::PcmClip>(openrtw::load_pcm({bytes, size}));
        pcm.swap(next);
        clear_error();
        return 1;
    } catch (const std::exception& exception) {
        fail(exception.what());
    } catch (...) {
        fail("Unknown PCM loading failure");
    }
    return 0;
}

std::uint32_t openrtw_pcm_rate() noexcept {
    return pcm ? pcm->sampleRate : 0;
}
std::uint32_t openrtw_pcm_frames() noexcept {
    return pcm ? static_cast<std::uint32_t>(pcm->monoSamples.size()) : 0;
}
const std::int16_t* openrtw_pcm_samples() noexcept {
    return pcm ? pcm->monoSamples.data() : nullptr;
}

void openrtw_reset() noexcept {
    clear_battle();
    invalidate_campaign_session();
    campaign_fog_traits.reset();
    campaign_fog_ancillaries.reset();
    campaign_fog_features.reset();
    dds_texture.reset();
    std::string{}.swap(dds_texture_json);
    cas_mesh.reset();
    std::string{}.swap(cas_mesh_json);
    std::string{}.swap(campaign_shadow_json);
    cas_animation.reset();
    std::string{}.swap(cas_animation_json);
    std::string{}.swap(cas_animation_frame_json);
    unit_definitions.reset();
    battle_models.reset();
    std::string{}.swap(battle_catalog_json);
    pcm.reset();
    terrain.reset();
    campaign.reset();
    settlement_view.reset();
    std::string{}.swap(settlement_inspection_json);
    regions.reset();
    region_map.reset();
    std::string{}.swap(regions_json);
    world_grid.reset();
    std::string{}.swap(world_grid_json);
    ground_map.reset();
    category_grid.reset();
    point_category_grid.reset();
    climates.reset();
    climate_map.reset();
    climate_grid.reset();
    std::string{}.swap(climates_json);
    clear_aerial();
    clear_aerial_decals();
    settlement_cultures.reset();
    settlement_symbol_anchor.reset();
    settlement_buildings.reset();
    std::string{}.swap(campaign_json);
    clear_error();
}

std::uint32_t openrtw_terrain_width() noexcept {
    return terrain ? terrain->width : 0;
}
std::uint32_t openrtw_terrain_height() noexcept {
    return terrain ? terrain->height : 0;
}
const std::uint32_t* openrtw_terrain_bits() noexcept {
    return terrain ? terrain->heightBits.data() : nullptr;
}
std::uint32_t openrtw_terrain_count() noexcept {
    return terrain ? static_cast<std::uint32_t>(terrain->heightBits.size()) : 0;
}
const char* openrtw_campaign_json() noexcept {
    return campaign ? campaign_json.c_str() : nullptr;
}
const char* openrtw_error() noexcept {
    return error.data();
}
const char* openrtw_regions_json() noexcept {
    return regions ? regions_json.c_str() : nullptr;
}
std::uint32_t openrtw_region_map_width() noexcept {
    return region_map ? region_map->width : 0;
}
std::uint32_t openrtw_region_map_height() noexcept {
    return region_map ? region_map->height : 0;
}
const std::uint8_t* openrtw_region_map_rgb() noexcept {
    return region_map ? region_map->rgb.data() : nullptr;
}
std::uint32_t openrtw_region_map_bytes() noexcept {
    return region_map ? static_cast<std::uint32_t>(region_map->rgb.size()) : 0;
}
const char* openrtw_world_grid_json() noexcept {
    return world_grid ? world_grid_json.c_str() : nullptr;
}
const std::uint32_t* openrtw_world_grid_indices() noexcept {
    return world_grid ? world_grid->regionIndices.data() : nullptr;
}
std::uint32_t openrtw_world_grid_count() noexcept {
    return world_grid ? static_cast<std::uint32_t>(world_grid->regionIndices.size()) : 0;
}
std::uint32_t openrtw_category_width() noexcept {
    return category_grid ? category_grid->width : 0;
}
std::uint32_t openrtw_category_height() noexcept {
    return category_grid ? category_grid->height : 0;
}
std::uint32_t openrtw_category_count() noexcept {
    return category_grid ? static_cast<std::uint32_t>(category_grid->categories.size()) : 0;
}
const std::uint32_t* openrtw_category_ids() noexcept {
    return category_grid ? category_grid->categories.data() : nullptr;
}

const char* openrtw_climates_json() noexcept {
    return climates ? climates_json.c_str() : nullptr;
}
std::uint32_t openrtw_point_category_width() noexcept {
    return point_category_grid ? point_category_grid->width : 0;
}
std::uint32_t openrtw_point_category_height() noexcept {
    return point_category_grid ? point_category_grid->height : 0;
}
std::uint32_t openrtw_point_category_count() noexcept {
    return point_category_grid ? static_cast<std::uint32_t>(point_category_grid->categories.size())
                               : 0;
}
const std::uint8_t* openrtw_point_category_ids() noexcept {
    return point_category_grid ? point_category_grid->categories.data() : nullptr;
}

std::uint32_t openrtw_climate_width() noexcept {
    return climate_grid ? climate_grid->width : 0;
}
std::uint32_t openrtw_climate_height() noexcept {
    return climate_grid ? climate_grid->height : 0;
}
std::uint32_t openrtw_climate_count() noexcept {
    return climate_grid ? static_cast<std::uint32_t>(climate_grid->coefficientBits.size()) : 0;
}
const std::uint32_t* openrtw_climate_coefficient_bits() noexcept {
    return climate_grid ? climate_grid->coefficientBits.data() : nullptr;
}
const std::uint8_t* openrtw_climate_source_ids() noexcept {
    return climate_grid ? climate_grid->sourceIndices.data() : nullptr;
}

} // extern "C"
