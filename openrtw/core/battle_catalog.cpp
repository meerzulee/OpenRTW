#include "battle_catalog.hpp"

#include <array>
#include <charconv>
#include <stdexcept>
#include <unordered_map>
#include <unordered_set>
#include <utility>

namespace openrtw {
namespace {

std::string_view trim(std::string_view value) noexcept {
    while (!value.empty() && (value.front() == ' ' || value.front() == '\t'))
        value.remove_prefix(1);
    while (!value.empty() && (value.back() == ' ' || value.back() == '\t'))
        value.remove_suffix(1);
    return value;
}

[[noreturn]] void refuse(std::size_t line, std::string_view message) {
    throw std::runtime_error("Battle catalog line " + std::to_string(line) + ": " +
                             std::string(message));
}

bool identifier(std::string_view value) noexcept {
    const auto letter = [](char c) {
        return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '_';
    };
    if (value.empty() || value.size() > battle_catalog_max_line_bytes || !letter(value.front()))
        return false;
    for (const char c : value)
        if (!letter(c) && !(c >= '0' && c <= '9'))
            return false;
    return true;
}

bool unit_type(std::string_view value) noexcept {
    if (value.empty() || value.size() > battle_catalog_max_line_bytes || trim(value) != value ||
        value.find(',') != std::string_view::npos)
        return false;
    for (const char raw : value) {
        const auto c = static_cast<unsigned char>(raw);
        if ((c < 0x20 && c != '\t') || c == 0x7f)
            return false;
    }
    return true;
}

bool single_token(std::string_view value) noexcept {
    return !value.empty() && value.find_first_of(" \t") == std::string_view::npos;
}

bool flexi(std::string_view key) noexcept {
    return key == "model_flexi" || key == "model_flexi_m" || key == "model_flexi_c";
}

class Reader {
public:
    explicit Reader(std::string_view input) : input_(input) {
        if (input.size() > battle_catalog_max_input_bytes)
            refuse(0, "input byte budget exceeded");
    }

    std::string own(std::string_view value) {
        if (value.size() > battle_catalog_max_owned_bytes - owned_)
            refuse(line_, "owned text budget exceeded");
        owned_ += value.size();
        return std::string(value);
    }

    BattleSourceField field(std::string_view key, std::string_view value, std::string_view raw,
                            std::size_t recordFields) {
        if (fields_ == battle_catalog_max_fields ||
            recordFields == battle_catalog_max_fields_per_record)
            refuse(line_, "field record budget exceeded");
        ++fields_;
        return {line_, own(key), own(value), own(raw)};
    }

    template <class Accept> void lines(Accept accept) {
        for (std::size_t at = 0; at < input_.size();) {
            const auto end = input_.find('\n', at);
            auto raw =
                input_.substr(at, end == std::string_view::npos ? input_.size() - at : end - at);
            at = end == std::string_view::npos ? input_.size() : end + 1;
            ++line_;
            if (!raw.empty() && raw.back() == '\r')
                raw.remove_suffix(1);
            if (raw.size() > battle_catalog_max_line_bytes)
                refuse(line_, "line byte budget exceeded");
            for (const char byte : raw) {
                const auto c = static_cast<unsigned char>(byte);
                if ((c < 0x20 && c != '\t') || c == 0x7f)
                    refuse(line_, "control byte in source");
            }
            const auto text = trim(raw.substr(0, raw.find(';')));
            if (text.empty())
                continue;
            const auto split = text.find_first_of(" \t");
            const auto key = text.substr(0, split);
            const auto value =
                split == std::string_view::npos ? std::string_view{} : trim(text.substr(split));
            if (!identifier(key))
                refuse(line_, "invalid field key");
            accept(key, value, raw, line_);
        }
    }

private:
    std::string_view input_;
    std::size_t owned_ = 0, fields_ = 0, line_ = 0;
};

std::pair<std::string_view, std::int32_t> soldier(std::string_view value, std::size_t line) {
    std::array<std::string_view, 4> values{};
    for (std::size_t i = 0; i < values.size(); ++i) {
        const auto comma = value.find(',');
        if ((i < 3 && comma == std::string_view::npos) ||
            (i == 3 && comma != std::string_view::npos))
            refuse(line, "soldier requires exactly four CSV fields");
        values[i] = trim(value.substr(0, comma));
        if (values[i].empty())
            refuse(line, "empty soldier CSV field");
        if (comma != std::string_view::npos)
            value.remove_prefix(comma + 1);
    }
    if (!identifier(values[0]))
        refuse(line, "invalid soldier model identifier");
    for (const char c : values[1])
        if (c < '0' || c > '9')
            refuse(line, "invalid nonnegative soldier count");
    std::int32_t count = 0;
    const auto parsed =
        std::from_chars(values[1].data(), values[1].data() + values[1].size(), count);
    if (parsed.ec != std::errc{} || parsed.ptr != values[1].data() + values[1].size() || count < 0)
        refuse(line, "invalid nonnegative soldier count");
    return {values[0], count};
}

void finish_unit(const UnitDefinitions& result, unsigned seen) {
    if (!result.records.empty() && seen != 15)
        refuse(result.records.back().line, "missing unit singleton field");
}

void finish_model(const BattleModels& result, bool mesh) {
    if (!result.records.empty() && !mesh)
        refuse(result.records.back().line, "model requires a flexi mesh field");
}

} // namespace

UnitDefinitions load_unit_definitions(std::string_view input) {
    Reader reader(input);
    UnitDefinitions result;
    result.sourceBytes = reader.own(input);
    std::unordered_set<std::string_view> types;
    unsigned seen = 0;
    reader.lines(
        [&](std::string_view key, std::string_view value, std::string_view raw, std::size_t line) {
            if (key == "type") {
                finish_unit(result, seen);
                if (!unit_type(value))
                    refuse(line, "invalid unit type");
                if (result.records.size() == battle_catalog_max_records)
                    refuse(line, "unit record budget exceeded");
                if (!types.insert(value).second)
                    refuse(line, "duplicate unit type");
                UnitDefinition record;
                record.type = reader.own(value);
                record.line = line;
                result.records.push_back(std::move(record));
                seen = 0;
                return;
            }
            if (result.records.empty())
                refuse(line, "unit field before type");
            auto& record = result.records.back();
            unsigned bit = 0;
            if (key == "dictionary")
                bit = 1;
            else if (key == "category")
                bit = 2;
            else if (key == "class")
                bit = 4;
            else if (key == "soldier")
                bit = 8;
            if ((seen & bit) != 0)
                refuse(line, "duplicate unit singleton field");
            if (bit == 8) {
                const auto parsed = soldier(value, line);
                record.soldierModel = reader.own(parsed.first);
                record.sourceSoldierCount = parsed.second;
            } else if (bit != 0) {
                if (!single_token(value))
                    refuse(line, "unit singleton requires one token");
                auto text = reader.own(value);
                if (bit == 1)
                    record.dictionary = std::move(text);
                else if (bit == 2)
                    record.category = std::move(text);
                else
                    record.unitClass = std::move(text);
            }
            seen |= bit;
            record.fields.push_back(reader.field(key, value, raw, record.fields.size()));
        });
    finish_unit(result, seen);
    if (result.records.empty())
        refuse(0, "no unit records");
    return result;
}

BattleModels load_battle_models(std::string_view input) {
    Reader reader(input);
    BattleModels result;
    result.sourceBytes = reader.own(input);
    std::unordered_set<std::string_view> types;
    bool mesh = false;
    reader.lines(
        [&](std::string_view key, std::string_view value, std::string_view raw, std::size_t line) {
            if (key == "type") {
                finish_model(result, mesh);
                if (!identifier(value))
                    refuse(line, "invalid model type identifier");
                if (result.records.size() == battle_catalog_max_records)
                    refuse(line, "model record budget exceeded");
                if (!types.insert(value).second)
                    refuse(line, "duplicate model type");
                ModelDefinition record;
                record.type = reader.own(value);
                record.line = line;
                result.records.push_back(std::move(record));
                mesh = false;
                return;
            }
            if (result.records.empty())
                refuse(line, "model field before type");
            auto& record = result.records.back();
            if (flexi(key)) {
                if (value.empty())
                    refuse(line, "empty flexi mesh field");
                mesh = true;
            }
            record.fields.push_back(reader.field(key, value, raw, record.fields.size()));
        });
    finish_model(result, mesh);
    if (result.records.empty())
        refuse(0, "no model records");
    return result;
}

const UnitDefinition* find_unit_definition(const UnitDefinitions& definitions,
                                           std::string_view type) noexcept {
    for (const auto& record : definitions.records)
        if (record.type == type)
            return &record;
    return nullptr;
}

const ModelDefinition* find_battle_model(const BattleModels& models,
                                         std::string_view type) noexcept {
    for (const auto& record : models.records)
        if (record.type == type)
            return &record;
    return nullptr;
}

CampaignBattleRoster build_campaign_battle_roster(const Campaign& campaign,
                                                  const UnitDefinitions& definitions,
                                                  const BattleModels& models) {
    if (definitions.records.empty() || models.records.empty() ||
        definitions.records.size() > battle_catalog_max_records ||
        models.records.size() > battle_catalog_max_records)
        refuse(0, "roster catalog record budget or empty catalog");
    std::unordered_map<std::string_view, std::size_t> units, model_ids;
    std::size_t join_text = 0;
    const auto charge_join = [&](std::size_t bytes) {
        if (bytes > battle_catalog_max_owned_bytes - join_text)
            refuse(0, "roster catalog key budget exceeded");
        join_text += bytes;
    };
    for (std::size_t i = 0; i < definitions.records.size(); ++i) {
        const auto& value = definitions.records[i];
        charge_join(value.type.size());
        charge_join(value.soldierModel.size());
        if (!unit_type(value.type) || !identifier(value.soldierModel) ||
            value.sourceSoldierCount < 0 || !units.emplace(value.type, i).second)
            refuse(value.line, "invalid or duplicate roster unit type/model");
    }
    for (std::size_t i = 0; i < models.records.size(); ++i) {
        const auto& value = models.records[i];
        charge_join(value.type.size());
        if (!identifier(value.type) || !model_ids.emplace(value.type, i).second)
            refuse(value.line, "invalid or duplicate roster model type");
    }
    CampaignBattleRoster result;
    std::size_t text_bytes = 0, visited = 0;
    if (campaign.factions.size() > campaign_max_records)
        refuse(0, "roster faction budget exceeded");
    for (std::size_t f = 0; f < campaign.factions.size(); ++f) {
        const auto& faction = campaign.factions[f];
        if (faction.characters.size() > campaign_max_records - visited)
            refuse(faction.line, "roster character budget exceeded");
        visited += faction.characters.size();
        for (std::size_t c = 0; c < faction.characters.size(); ++c) {
            const auto& actor = faction.characters[c];
            if (actor.army.size() > battle_catalog_max_roster_records - result.records.size())
                refuse(actor.line, "roster army record budget exceeded");
            for (std::size_t a = 0; a < actor.army.size(); ++a) {
                const auto& source = actor.army[a];
                if (source.name.size() > battle_catalog_max_owned_bytes - text_bytes)
                    refuse(source.line, "roster owned text budget exceeded");
                text_bytes += source.name.size();
                const auto found = units.find(source.name);
                if (found == units.end())
                    refuse(source.line, "campaign unit type missing from catalog");
                const auto model = model_ids.find(definitions.records[found->second].soldierModel);
                if (model == model_ids.end())
                    refuse(source.line, "soldier model missing from catalog");
                result.records.push_back({f, c, a, found->second, model->second, source});
            }
        }
    }
    return result;
}

} // namespace openrtw
