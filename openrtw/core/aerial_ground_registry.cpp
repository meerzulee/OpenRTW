#include "aerial_ground_registry.hpp"

#include <algorithm>
#include <optional>
#include <stdexcept>
#include <unordered_map>
#include <utility>

namespace openrtw {
namespace {

[[noreturn]] void refuse(std::size_t line, std::string_view reason) {
    throw std::runtime_error("Aerial ground types line " + std::to_string(line) + ": " +
                             std::string(reason));
}

bool space(char c) {
    return c == ' ' || c == '\t';
}

bool block_name_valid(std::string_view name) {
    if (name.empty() || name.size() > aerial_ground_max_block_name_bytes)
        return false;
    for (const char c : name)
        if ((c < 'a' || c > 'z') && c != '_')
            return false;
    return true;
}

bool texture_name_valid(std::string_view name) {
    if (name.size() < 5 || name.size() > aerial_ground_max_texture_name_bytes ||
        name.front() == '.')
        return false;
    for (const char c : name)
        if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
              c == '_' || c == '.' || c == '-'))
            return false;
    const auto suffix = name.substr(name.size() - 4);
    const auto lower = [](char c) {
        return c >= 'A' && c <= 'Z' ? static_cast<char>(c - 'A' + 'a') : c;
    };
    return suffix[0] == '.' && lower(suffix[1]) == 't' && lower(suffix[2]) == 'g' &&
           lower(suffix[3]) == 'a';
}

std::optional<std::size_t> slot_index(std::string_view name) {
    for (std::size_t s = 0; s < aerial_ground_slot_names.size(); ++s)
        if (aerial_ground_slot_names[s] == name)
            return s;
    return std::nullopt;
}

struct Line {
    std::size_t number = 0;
    std::vector<std::string_view> tokens;
};

// Views into the caller's input; they live only for this synchronous parse.
std::vector<Line> tokenize(std::string_view input) {
    std::vector<Line> lines;
    std::size_t number = 0;
    for (std::size_t begin = 0; begin < input.size();) {
        const auto end = input.find('\n', begin);
        auto raw =
            input.substr(begin, (end == std::string_view::npos ? input.size() : end) - begin);
        begin = end == std::string_view::npos ? input.size() : end + 1;
        ++number;
        if (raw.size() > aerial_ground_max_line_bytes)
            refuse(number, "line byte limit exceeded");
        if (!raw.empty() && raw.back() == '\r')
            raw.remove_suffix(1);
        for (const char c : raw) {
            const auto byte = static_cast<unsigned char>(c);
            if (byte > 126 || (byte < 32 && byte != '\t'))
                refuse(number, "unsupported ASCII/control byte");
        }
        const auto active = raw.substr(0, raw.find(';'));
        Line line{number, {}};
        for (std::size_t at = 0; at < active.size();) {
            while (at < active.size() && space(active[at]))
                ++at;
            if (at == active.size())
                break;
            auto stop = at;
            while (stop < active.size() && !space(active[stop]))
                ++stop;
            line.tokens.push_back(active.substr(at, stop - at));
            at = stop;
        }
        if (!line.tokens.empty())
            lines.push_back(std::move(line));
    }
    return lines;
}

struct Block {
    std::string_view name;
    // [slot][column] texture names; column 1 duplicates column 0 for 2 tokens.
    std::array<std::array<std::string_view, 2>, aerial_ground_slot_count> names{};
};

} // namespace

bool aerial_climate_has_winter(const ClimateDefinition& climate) noexcept {
    for (const auto& row : climate.opaqueRows)
        if (row.tokens.size() == 1 && row.tokens[0] == "winter")
            return true;
    return false;
}

AerialGroundTypes load_aerial_ground_types(std::string_view input, const ClimatePalette& palette) {
    if (palette.definitions.empty() || palette.definitions.size() > climate_max_definitions)
        throw std::invalid_argument("Aerial ground types: climate palette required");
    if (input.size() > aerial_ground_max_input_bytes)
        throw std::runtime_error("Aerial ground types: input byte limit exceeded");
    const auto lines = tokenize(input);
    std::vector<Block> blocks;
    std::unordered_map<std::string_view, std::size_t> byName;
    std::size_t at = 0;
    while (at < lines.size()) {
        const auto& header = lines[at++];
        if (header.tokens.size() != 2 || header.tokens[0] != "climate")
            refuse(header.number, "expected `climate NAME` block header");
        if (!block_name_valid(header.tokens[1]))
            refuse(header.number, "unsupported block name");
        if (byName.contains(header.tokens[1]))
            refuse(header.number, "duplicate block name");
        if (blocks.size() == aerial_ground_max_blocks)
            refuse(header.number, "block limit exceeded");
        if (at == lines.size() || lines[at].tokens.size() != 1 || lines[at].tokens[0] != "{")
            refuse(header.number, "expected standalone `{` after block header");
        ++at;
        Block block;
        block.name = header.tokens[1];
        std::array<bool, aerial_ground_slot_count> seen{};
        bool closed = false;
        while (at < lines.size()) {
            const auto& row = lines[at++];
            if (row.tokens.size() == 1 && row.tokens[0] == "}") {
                closed = true;
                break;
            }
            if (row.tokens.size() != 2 && row.tokens.size() != 3)
                refuse(row.number, "row needs a slot name and one or two textures");
            const auto slot = slot_index(row.tokens[0]);
            if (!slot)
                refuse(row.number, "unknown slot name");
            if (seen[*slot])
                refuse(row.number, "duplicate slot");
            for (std::size_t t = 1; t < row.tokens.size(); ++t)
                if (!texture_name_valid(row.tokens[t]))
                    refuse(row.number, "unsupported texture name");
            seen[*slot] = true;
            block.names[*slot][0] = row.tokens[1];
            block.names[*slot][1] = row.tokens.size() == 3 ? row.tokens[2] : row.tokens[1];
        }
        if (!closed)
            refuse(header.number, "block is not closed by standalone `}`");
        for (std::size_t s = 0; s < seen.size(); ++s)
            if (!seen[s])
                refuse(header.number,
                       "block is missing slot " + std::string(aerial_ground_slot_names[s]));
        byName.emplace(block.name, blocks.size());
        blocks.push_back(block);
    }
    const auto fallback = byName.find("default");
    if (fallback == byName.end())
        throw std::runtime_error("Aerial ground types: required `default` block missing");

    AerialGroundTypes result;
    result.climates.reserve(palette.definitions.size());
    // Keys are views into `input` (stable for this call), never into the
    // growing textureNames vector whose short strings move on reallocation.
    std::unordered_map<std::string_view, std::uint32_t> registry;
    const auto index = [&](std::string_view name) {
        const auto found = registry.find(name);
        if (found != registry.end())
            return found->second;
        const auto next = static_cast<std::uint32_t>(result.textureNames.size());
        result.textureNames.emplace_back(name);
        registry.emplace(name, next);
        return next;
    };
    for (const auto& definition : palette.definitions) {
        const auto named = byName.find(definition.name);
        const auto& block = blocks[(named == byName.end() ? fallback : named)->second];
        AerialGroundClimate climate;
        climate.climateName = definition.name;
        climate.blockName = std::string(block.name);
        climate.winter = aerial_climate_has_winter(definition);
        for (std::size_t s = 0; s < aerial_ground_slot_count; ++s) {
            climate.slots[s][0] = index(block.names[s][0]);
            climate.slots[s][1] = index(block.names[s][1]);
        }
        result.climates.push_back(std::move(climate));
    }
    return result;
}

RgbImage decode_aerial_tga24(std::span<const std::uint8_t> bytes) {
    static constexpr std::array<std::uint8_t, 18> signature{
        'T', 'R', 'U', 'E', 'V', 'I', 'S', 'I', 'O', 'N', '-', 'X', 'F', 'I', 'L', 'E', '.', 0};
    if (bytes.size() < 18 || !bytes.data())
        throw std::runtime_error("Aerial TGA: truncated header");
    const auto width = std::uint64_t{bytes[12]} | (std::uint64_t{bytes[13]} << 8);
    const auto height = std::uint64_t{bytes[14]} | (std::uint64_t{bytes[15]} << 8);
    const auto exact = 18 + width * height * 3;
    if (bytes.size() == exact)
        return load_tga24(bytes);
    if (bytes.size() != exact + 26)
        throw std::runtime_error("Aerial TGA: payload/footer length mismatch");
    const auto footer = bytes.subspan(bytes.size() - 26);
    for (std::size_t i = 0; i < 8; ++i)
        if (footer[i] != 0)
            throw std::runtime_error("Aerial TGA: footer extension/developer offsets unsupported");
    if (!std::equal(signature.begin(), signature.end(), footer.begin() + 8))
        throw std::runtime_error("Aerial TGA: invalid TGA 2.0 footer signature");
    return load_tga24(bytes.first(bytes.size() - 26));
}

AerialTexturePixels aerial_ground_texture_pixels(const RgbImage& image) {
    if (image.width != image.height || !image.width || image.width > aerial_texture_max_side ||
        (image.width & (image.width - 1)) ||
        image.rgb.size() != std::size_t{image.width} * image.height * 3)
        throw std::runtime_error(
            "Aerial texture: need a square power-of-two image with exact RGB extent");
    // transpose_aerial_texture_pixels maps row bytes [b0,b1,b2] to word bytes
    // 5/3/1, i.e. it expects native BGR rows: swap canonical RGB once.
    std::vector<std::uint8_t> bgr(image.rgb.size());
    for (std::size_t i = 0; i < image.rgb.size(); i += 3) {
        bgr[i] = image.rgb[i + 2];
        bgr[i + 1] = image.rgb[i + 1];
        bgr[i + 2] = image.rgb[i];
    }
    return transpose_aerial_texture_pixels(bgr, image.width, std::size_t{image.width} * 3);
}

AerialGroundTextureSet make_aerial_ground_texture_set(const AerialGroundTypes& types) {
    AerialGroundTextureSet set;
    set.textures.resize(types.textureNames.size());
    return set;
}

void load_aerial_ground_texture(AerialGroundTextureSet& set, std::uint32_t index,
                                std::span<const std::uint8_t> tgaBytes) {
    if (index >= set.textures.size())
        throw std::invalid_argument("Aerial texture: registry index outside the texture set");
    auto pixels = aerial_ground_texture_pixels(decode_aerial_tga24(tgaBytes));
    set.textures[index] = std::move(pixels);
}

bool aerial_ground_texture_set_complete(const AerialGroundTextureSet& set) noexcept {
    if (set.textures.empty())
        return false;
    for (const auto& texture : set.textures)
        if (!texture.side || texture.side > aerial_texture_max_side ||
            (texture.side & (texture.side - 1)) ||
            texture.words.size() != std::size_t{texture.side} * texture.side)
            return false;
    return true;
}

AerialWeightPattern aerial_weight_pattern(const RgbImage& image) {
    constexpr auto side = aerial_weight_pattern_side;
    if (image.width != side || image.height != side || image.rgb.size() != side * side * 3)
        throw std::runtime_error("Aerial weight pattern: need a 15x15 RGB image");
    AerialWeightPattern pattern{};
    for (std::size_t x = 0; x < side; ++x)
        for (std::size_t y = 0; y < side; ++y)
            pattern[side * x + y] = image.rgb[3 * (y * side + x)];
    return pattern;
}

} // namespace openrtw
