#pragma once
#include "campaign_session.hpp"
#include "campaign_json.hpp"
namespace openrtw {
inline std::string production_snapshot(const CampaignSession& session, std::uint32_t generation,
                                       std::uint32_t cityId) {
    const auto* state = session.production();
    if (!state || cityId >= state->cities.size())
        throw std::runtime_error("Select a production settlement");
    const auto& c = state->cities[cityId];
    detail::Json out;
    auto field = [&](std::string_view key, auto value) {
        out.append(",\"");
        out.append(key);
        out.append("\":");
        out.integer(value);
    };
    auto strings = [&](auto& values) {
        out.append("[");
        bool first = true;
        for (auto& v : values) {
            if (!first)
                out.append(",");
            first = false;
            out.string(v);
        }
        out.append("]");
    };
    out.append("{\"schema\":\"openrtw-production-v1\"");
    field("generation", generation);
    field("revision", session.revision());
    field("orderRevision", session.order_revision());
    field("cityId", cityId);
    field("factionIndex", c.faction);
    field("population", c.population);
    field("treasury", state->treasury.at(c.faction));
    out.append(",\"region\":");
    out.string(c.region);
    out.append(",\"level\":");
    out.string(c.level);
    out.append(",\"construction\":[");
    auto jobs = [&](const auto& rows, bool recruitment) {
        bool first = true;
        for (auto& j : rows) {
            if (!first)
                out.append(",");
            first = false;
            out.append("{\"definition\":");
            out.integer(j.definition);
            field("remaining", j.remaining);
            field("total", j.total);
            field("paid", j.paid);
            out.append(",\"reason\":");
            out.string(recruitment ? state->recruit_reason(cityId, j.definition)
                                   : state->building_reason(cityId, j.definition));
            out.append("}");
        }
    };
    jobs(c.construction, false);
    out.append("],\"recruitment\":[");
    jobs(c.recruitment, true);
    out.append("],\"buildings\":[");
    for (std::size_t i = 0; i < state->catalog->buildings.size(); ++i) {
        auto& b = state->catalog->buildings[i];
        if (i)
            out.append(",");
        out.append("{\"id\":");
        out.integer(i);
        out.append(",\"chain\":");
        out.string(b.chain);
        out.append(",\"level\":");
        out.string(b.level);
        field("cost", b.cost);
        field("turns", b.turns);
        out.append(",\"settlementMin\":");
        out.string(b.settlementMin);
        out.append(",\"requires\":");
        strings(b.requirements);
        out.append(",\"upgrades\":");
        strings(b.upgrades);
        out.append(",\"effects\":");
        strings(b.effects);
        out.append(",\"recruits\":[");
        for (std::size_t recruit = 0; recruit < b.recruits.size(); ++recruit) {
            if (recruit)
                out.append(",");
            out.string(b.recruits[recruit].unit);
        }
        out.append("]");
        out.append(",\"built\":");
        out.append(c.buildings.contains(b.chain) && c.buildings.at(b.chain) == b.level ? "true"
                                                                                       : "false");
        out.append(",\"reason\":");
        out.string(state->building_reason(cityId, i, true));
        out.append("}");
    }
    out.append("],\"units\":[");
    for (std::size_t i = 0; i < state->catalog->units.size(); ++i) {
        auto& u = state->catalog->units[i];
        if (i)
            out.append(",");
        out.append("{\"id\":");
        out.integer(i);
        out.append(",\"name\":");
        out.string(u.name);
        field("cost", u.cost);
        field("turns", u.turns);
        field("soldiers", u.soldiers);
        out.append(",\"reason\":");
        out.string(state->recruit_reason(cityId, i));
        out.append("}");
    }
    out.append("],\"garrison\":[");
    for (std::size_t i = 0; i < c.garrison.size(); ++i) {
        auto& u = c.garrison[i];
        if (i)
            out.append(",");
        out.append("{\"name\":");
        out.string(u.name);
        field("soldiers", u.count.value_or(0));
        field("experience", u.experience.value_or(0));
        out.append("}");
    }
    out.append("]}");
    return std::move(out).finish();
}
} // namespace openrtw
