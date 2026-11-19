#include "climates.hpp"

#include <charconv>
#include <stdexcept>
#include <unordered_map>
#include <unordered_set>
#include <utility>

namespace openrtw {
namespace {

[[noreturn]] void refuse(const char* message) {
    throw std::runtime_error(message);
}

bool space(char c) {
    return c == ' ' || c == '\t';
}

void ascii(std::string_view text) {
    for (const char raw : text) {
        const auto c = static_cast<unsigned char>(raw);
        if ((c < 32 && c != '\t' && c != '\r' && c != '\n') || c > 126)
            refuse("Climates: unsupported ASCII byte");
    }
}

bool name_valid(std::string_view name) {
    if (name.empty() || name.size() > climate_max_name_bytes)
        return false;
    for (const char c : name)
        if ((c < 'a' || c > 'z') && c != '_')
            return false;
    return true;
}

struct Row {
    std::size_t line;
    std::string_view text;
    std::vector<std::string_view> tokens;
};

std::vector<Row> rows(std::string_view source) {
    std::vector<Row> result;
    std::size_t line = 0;
    for (std::size_t begin = 0; begin < source.size();) {
        if (++line > climate_max_source_lines)
            refuse("Climates: source line limit exceeded");
        const auto end = source.find('\n', begin);
        const auto length = (end == std::string_view::npos ? source.size() : end) - begin;
        if (length > climate_max_line_bytes)
            refuse("Climates: source line limit exceeded");
        auto raw = source.substr(begin, length);
        if (!raw.empty() && raw.back() == '\r')
            raw.remove_suffix(1);
        if (raw.find('\r') != std::string_view::npos)
            refuse("Climates: CR outside line ending");
        auto active = raw.substr(0, raw.find(';'));
        Row row{line, raw, {}};
        for (std::size_t at = 0; at < active.size();) {
            while (at < active.size() && space(active[at]))
                ++at;
            if (at == active.size())
                break;
            auto stop = at;
            while (stop < active.size() && !space(active[stop]))
                ++stop;
            auto token = active.substr(at, stop - at);
            if (token.size() > climate_max_token_bytes ||
                token.find('"') != std::string_view::npos ||
                token.find('\'') != std::string_view::npos ||
                row.tokens.size() == climate_max_tokens_per_row)
                refuse("Climates: unsupported token or row extent");
            row.tokens.push_back(token);
            at = stop;
        }
        if (row.tokens.size() > 1)
            for (const auto token : row.tokens)
                if (token == "{" || token == "}")
                    refuse("Climates: brace token outside standalone row");
        if (!row.tokens.empty())
            result.push_back(std::move(row));
        begin = end == std::string_view::npos ? source.size() : end + 1;
    }
    return result;
}

ClimateSourceRow own(const Row& row) {
    ClimateSourceRow result{row.line, std::string(row.text), {}};
    for (const auto token : row.tokens)
        result.tokens.emplace_back(token);
    return result;
}

std::int32_t integer(std::string_view token) {
    std::int32_t value = 0;
    const auto [end, error] = std::from_chars(token.data(), token.data() + token.size(), value);
    if (error != std::errc{} || end != token.data() + token.size())
        refuse("Climates: unsupported signed integer");
    return value;
}

bool single(const Row& row, std::string_view token) {
    return row.tokens.size() == 1 && row.tokens[0] == token;
}

void brace(const std::vector<Row>& source, std::size_t& at, std::string_view token) {
    if (at == source.size() || !single(source[at], token))
        refuse("Climates: expected standalone brace");
    ++at;
}

void validate_palette(const ClimatePalette& palette) {
    if (palette.definitions.empty() || palette.definitions.size() > climate_max_definitions ||
        palette.sourceBytes.size() > climate_max_input_bytes)
        refuse("Climates: invalid palette or source extent");
    ascii(palette.sourceBytes);
    std::size_t textBytes = palette.sourceBytes.size(), opaqueCount = 0;
    const auto charge = [&](std::size_t bytes) {
        if (bytes > climate_max_owned_text_bytes - textBytes)
            refuse("Climates: owned text limit exceeded");
        textBytes += bytes;
    };
    std::unordered_set<std::string_view> names;
    for (const auto& definition : palette.definitions) {
        if (!name_valid(definition.name) || !names.insert(definition.name).second ||
            definition.heat < 0 || definition.heat > 4 ||
            definition.declarationLine > climate_max_source_lines ||
            definition.definitionLine > climate_max_source_lines ||
            definition.colourLine > climate_max_source_lines ||
            definition.heatLine > climate_max_source_lines)
            refuse("Climates: invalid definition domain");
        charge(definition.name.size());
        if (definition.opaqueRows.size() > climate_max_source_lines - opaqueCount)
            refuse("Climates: opaque row limit exceeded");
        opaqueCount += definition.opaqueRows.size();
        for (const auto& row : definition.opaqueRows) {
            if (!row.line || row.line > climate_max_source_lines ||
                row.text.size() > climate_max_line_bytes || row.tokens.empty() ||
                row.tokens.size() > climate_max_tokens_per_row)
                refuse("Climates: invalid opaque row extent");
            ascii(row.text);
            charge(row.text.size());
            for (const auto& token : row.tokens) {
                if (token.empty() || token.size() > climate_max_token_bytes || token == "{" ||
                    token == "}")
                    refuse("Climates: invalid opaque token extent");
                ascii(token);
                charge(token.size());
            }
        }
    }
}

void validate_image(const RgbImage& image) {
    if (image.width <= 1 || image.height <= 1 || image.width % 2 == 0 || image.height % 2 == 0 ||
        image.width > region_map_max_dimension || image.height > region_map_max_dimension)
        refuse("Climates: unsupported odd point dimensions");
    const auto count = std::uint64_t{image.width} * image.height;
    if (count > region_map_max_pixels || image.rgb.size() != count * 3)
        refuse("Climates: inconsistent image extent or pixel limit");
}

std::uint32_t coefficient(std::int32_t selector) {
    if (selector == 0 || selector == 4)
        return 0x3f800000u;
    if (selector == 1 || selector == 3)
        return 0x3f666666u;
    return 0x3f4ccccdu;
}

std::size_t grid_offset(const ClimateCoefficientGrid& grid, std::uint32_t x, std::uint32_t y) {
    if (x >= grid.width || y >= grid.height)
        throw std::out_of_range("Climates: coordinates outside grid");
    if (!grid.width || !grid.height || grid.width > (region_map_max_dimension - 1) / 2 ||
        grid.height > (region_map_max_dimension - 1) / 2 || !grid.definitionCount ||
        grid.definitionCount > climate_max_definitions)
        refuse("Climates: invalid grid domain");
    const auto count = std::uint64_t{grid.width} * grid.height;
    if (count > region_map_max_pixels / 4 || grid.coefficientBits.size() != count ||
        grid.sourceIndices.size() != count)
        refuse("Climates: inconsistent grid extent");
    const auto offset = static_cast<std::size_t>(std::uint64_t{y} * grid.width + x);
    if (grid.sourceIndices[offset] >= grid.definitionCount ||
        (grid.coefficientBits[offset] != 0x3f800000u &&
         grid.coefficientBits[offset] != 0x3f666666u &&
         grid.coefficientBits[offset] != 0x3f4ccccdu))
        refuse("Climates: invalid grid payload");
    return offset;
}

} // namespace

ClimatePalette load_climates(std::string_view input) {
    if (input.size() > climate_max_input_bytes)
        refuse("Climates: input limit exceeded");
    ascii(input);
    ClimatePalette result;
    result.sourceBytes.assign(input);
    const auto source = rows(result.sourceBytes);
    std::size_t at = 0;
    if (source.empty() || !single(source[at++], "climates"))
        refuse("Climates: missing declaration block");
    brace(source, at, "{");
    std::unordered_map<std::string_view, std::size_t> indices;
    while (at < source.size() && !single(source[at], "}")) {
        const auto& row = source[at++];
        if (row.tokens.size() != 1 || !name_valid(row.tokens[0]) ||
            result.definitions.size() == climate_max_definitions || indices.contains(row.tokens[0]))
            refuse("Climates: invalid or duplicate declaration");
        indices.emplace(row.tokens[0], result.definitions.size());
        ClimateDefinition definition;
        definition.name = row.tokens[0];
        definition.declarationLine = row.line;
        result.definitions.push_back(std::move(definition));
    }
    brace(source, at, "}");
    std::vector<bool> defined(result.definitions.size(), false);
    while (at < source.size()) {
        const auto& header = source[at++];
        if (header.tokens.size() != 2 || header.tokens[0] != "climate")
            refuse("Climates: invalid definition header");
        const auto found = indices.find(header.tokens[1]);
        if (found == indices.end() || defined[found->second])
            refuse("Climates: undefined or duplicate definition");
        defined[found->second] = true;
        auto& definition = result.definitions[found->second];
        definition.definitionLine = header.line;
        brace(source, at, "{");
        bool colourSeen = false, heatSeen = false;
        while (at < source.size() && !single(source[at], "}")) {
            const auto& row = source[at];
            const auto& tokens = row.tokens;
            const auto key = tokens[0];
            if (key == "colour") {
                if (tokens.size() != 4 || colourSeen)
                    refuse("Climates: invalid or duplicate colour");
                for (std::size_t i = 0; i < 3; ++i) {
                    const auto value = integer(tokens[i + 1]);
                    if (value < 0 || value > 255)
                        refuse("Climates: colour outside admitted domain");
                    definition.colour[i] = static_cast<std::uint8_t>(value);
                }
                definition.colourLine = row.line;
                colourSeen = true;
            } else if (key == "heat") {
                if (tokens.size() != 2 || heatSeen)
                    refuse("Climates: invalid or duplicate heat");
                definition.heat = integer(tokens[1]);
                if (definition.heat < 0 || definition.heat > 4)
                    refuse("Climates: heat outside admitted selector domain");
                definition.heatLine = row.line;
                heatSeen = true;
            } else if (key == "battle_vegetation" || key == "battle_winter_vegetation") {
                if (tokens.size() != 1 || at + 2 >= source.size() ||
                    source[at + 1].tokens.size() != 2 ||
                    source[at + 1].tokens[0] != "dense_forest" ||
                    source[at + 2].tokens.size() != 2 || source[at + 2].tokens[0] != "dense_scrub")
                    refuse("Climates: invalid battle-next-two rows");
                definition.opaqueRows.push_back(own(row));
                definition.opaqueRows.push_back(own(source[++at]));
                definition.opaqueRows.push_back(own(source[++at]));
            } else {
                const bool winter = key == "winter" && tokens.size() == 1;
                const bool strategy = key == "strategy" && tokens.size() == 5 &&
                                      (tokens[1] == "summer" || tokens[1] == "winter") &&
                                      (tokens[2] == "sparse_tree" || tokens[2] == "dense_tree" ||
                                       tokens[2] == "canopy");
                const bool environment = key == "env_map" && tokens.size() == 2;
                if (!winter && !strategy && !environment)
                    refuse("Climates: unsupported opaque property shape");
                definition.opaqueRows.push_back(own(row));
            }
            ++at;
        }
        brace(source, at, "}");
        if (!colourSeen || !heatSeen)
            refuse("Climates: required colour or heat missing");
    }
    for (const auto present : defined)
        if (!present)
            refuse("Climates: registered name without definition");
    validate_palette(result);
    return result;
}

ClimateCoefficientGrid build_climate_coefficient_grid(const ClimatePalette& palette,
                                                      const RgbImage& image) {
    validate_palette(palette);
    validate_image(image);
    ClimateCoefficientGrid result;
    result.width = (image.width - 1) / 2;
    result.height = (image.height - 1) / 2;
    result.definitionCount = static_cast<std::uint32_t>(palette.definitions.size());
    const auto count = static_cast<std::size_t>(std::uint64_t{result.width} * result.height);
    result.coefficientBits.resize(count);
    result.sourceIndices.resize(count);
    for (std::uint32_t y = 0; y < result.height; ++y) {
        const auto topY = image.height - 2 * y - 2;
        for (std::uint32_t x = 0; x < result.width; ++x) {
            const auto rgbOffset =
                static_cast<std::size_t>(3 * (std::uint64_t{topY} * image.width + 2 * x + 1));
            const Rgb colour{image.rgb[rgbOffset], image.rgb[rgbOffset + 1],
                             image.rgb[rgbOffset + 2]};
            std::uint8_t selected = 0;
            for (std::size_t i = 0; i < palette.definitions.size(); ++i)
                if (palette.definitions[i].colour == colour)
                    selected = static_cast<std::uint8_t>(i);
            const auto output = static_cast<std::size_t>(std::uint64_t{y} * result.width + x);
            result.sourceIndices[output] = selected;
            result.coefficientBits[output] = coefficient(palette.definitions[selected].heat);
        }
    }
    return result;
}

std::uint32_t ClimateCoefficientGrid::coefficient_bits_at(std::uint32_t x, std::uint32_t y) const {
    return coefficientBits[grid_offset(*this, x, y)];
}

std::uint8_t ClimateCoefficientGrid::source_index_at(std::uint32_t x, std::uint32_t y) const {
    return sourceIndices[grid_offset(*this, x, y)];
}

} // namespace openrtw
