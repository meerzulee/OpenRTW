#include "regions.hpp"

#include <algorithm>
#include <charconv>
#include <stdexcept>
#include <unordered_set>
#include <utility>

namespace openrtw {
namespace {

std::string_view trim(std::string_view value) {
    while (!value.empty() && (value.front() == ' ' || value.front() == '\t'))
        value.remove_prefix(1);
    while (!value.empty() && (value.back() == ' ' || value.back() == '\t'))
        value.remove_suffix(1);
    return value;
}

[[noreturn]] void refuse(std::size_t line, std::string_view reason) {
    throw std::runtime_error("descr_regions line " + std::to_string(line) + ": " +
                             std::string(reason));
}

bool identifier(std::string_view value) {
    const auto letter = [](char c) {
        return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '_';
    };
    if (value.empty() || !letter(value.front()))
        return false;
    for (const char c : value)
        if (!letter(c) && !(c >= '0' && c <= '9'))
            return false;
    return true;
}

std::int32_t decimal(std::string_view value, std::size_t line) {
    if (value.empty())
        refuse(line, "missing decimal integer");
    std::int32_t result = 0;
    const auto parsed = std::from_chars(value.data(), value.data() + value.size(), result, 10);
    if (parsed.ec != std::errc{} || parsed.ptr != value.data() + value.size())
        refuse(line, "invalid or overflowing decimal integer");
    return result;
}

Rgb color(std::string_view value, std::size_t line) {
    Rgb result{};
    for (auto& channel : result) {
        value = trim(value);
        const auto end = value.find_first_of(" \t");
        const auto number = decimal(value.substr(0, end), line);
        if (number < 0 || number > 255)
            refuse(line, "RGB channel outside byte range");
        channel = static_cast<std::uint8_t>(number);
        if (end == std::string_view::npos)
            value = {};
        else
            value.remove_prefix(end);
    }
    if (!trim(value).empty())
        refuse(line, "RGB requires exactly three channels");
    return result;
}

std::uint32_t color_key(Rgb rgb) {
    return (std::uint32_t{rgb[0]} << 16) | (std::uint32_t{rgb[1]} << 8) | rgb[2];
}

class TextBudget {
public:
    std::string copy(std::string_view value, std::size_t line) {
        if (value.size() > region_max_owned_text_bytes - used_)
            refuse(line, "owned text budget exceeded");
        auto result = std::string(value);
        used_ += value.size();
        return result;
    }

private:
    std::size_t used_ = 0;
};

class RegionParser {
public:
    RegionDefinitions run(std::string_view input) {
        if (input.size() > region_max_input_bytes)
            refuse(0, "input byte limit exceeded");
        for (std::size_t position = 0; position < input.size();) {
            const auto end = input.find('\n', position);
            auto raw = input.substr(
                position, end == std::string_view::npos ? input.size() - position : end - position);
            position = end == std::string_view::npos ? input.size() : end + 1;
            ++line_;
            if (line_ > region_max_source_lines)
                refuse(line_, "source line limit exceeded");
            if (end != std::string_view::npos && !raw.empty() && raw.back() == '\r')
                raw.remove_suffix(1);
            if (raw.size() > region_max_line_bytes)
                refuse(line_, "source line byte limit exceeded");
            for (const char c : raw) {
                const auto byte = static_cast<unsigned char>(c);
                if (byte >= 0x7f || (byte < 0x20 && byte != '\t'))
                    refuse(line_, "unsupported ASCII/control byte");
            }
            const auto value = trim(raw);
            const bool ignored = value.empty() || value.front() == ';';
            if (!pendingCount_ && ignored) {
                result_.ignoredLines.push_back({line_, budget_.copy(raw, line_)});
                continue;
            }
            if (ignored)
                refuse(line_, "blank/comment inside eight-line record");
            if (!pendingCount_) {
                if (raw.front() == '\t' || raw.front() == ' ' || !identifier(value))
                    refuse(line_, "record must start with an unindented identifier");
                if (result_.definitions.size() == region_max_definitions)
                    refuse(line_, "region definition limit exceeded");
            } else if (raw.front() != '\t') {
                refuse(line_, "record requires seven tab-prefixed fields");
            }
            pending_[pendingCount_] = raw;
            sourceLines_[pendingCount_] = line_;
            if (++pendingCount_ == 8) {
                complete();
                pendingCount_ = 0;
            }
        }
        if (pendingCount_)
            refuse(line_, "incomplete eight-line record");
        if (result_.definitions.empty())
            refuse(line_, "no region definitions");
        return std::move(result_);
    }

private:
    RegionDefinitions result_;
    TextBudget budget_;
    // These views are private and last only for this synchronous parse.
    std::unordered_set<std::string_view> ids_;
    std::unordered_set<std::uint32_t> colors_;
    std::array<std::string_view, 8> pending_{};
    std::array<std::size_t, 8> sourceLines_{};
    std::size_t pendingCount_ = 0, line_ = 0, resourceCount_ = 0;

    void complete() {
        std::array<std::string_view, 8> fields{};
        for (std::size_t i = 0; i < fields.size(); ++i)
            fields[i] = trim(pending_[i]);
        for (std::size_t i = 0; i < 4; ++i)
            if (!identifier(fields[i]))
                refuse(sourceLines_[i], "unsupported identifier field");
        const auto rgb = color(fields[4], sourceLines_[4]);
        const auto numeric7 = decimal(fields[6], sourceLines_[6]);
        const auto numeric8 = decimal(fields[7], sourceLines_[7]);
        if (!ids_.insert(fields[0]).second)
            refuse(sourceLines_[0], "duplicate region identifier");
        if (!colors_.insert(color_key(rgb)).second)
            refuse(sourceLines_[4], "duplicate region RGB");

        RegionDefinition parsed;
        parsed.id = budget_.copy(fields[0], sourceLines_[0]);
        parsed.field2 = budget_.copy(fields[1], sourceLines_[1]);
        parsed.field3 = budget_.copy(fields[2], sourceLines_[2]);
        parsed.field4 = budget_.copy(fields[3], sourceLines_[3]);
        parsed.rgb = rgb;
        parsed.numeric7 = numeric7;
        parsed.numeric8 = numeric8;
        auto resources = fields[5];
        for (;;) {
            const auto comma = resources.find(',');
            const auto token = trim(resources.substr(0, comma));
            if (!identifier(token))
                refuse(sourceLines_[5], "unsupported resource token");
            if (parsed.resources.size() == region_max_resources_per_definition ||
                resourceCount_ == region_max_total_resources)
                refuse(sourceLines_[5], "resource token limit exceeded");
            parsed.resources.push_back(budget_.copy(token, sourceLines_[5]));
            ++resourceCount_;
            if (comma == std::string_view::npos)
                break;
            resources.remove_prefix(comma + 1);
        }
        for (std::size_t i = 0; i < parsed.source.size(); ++i)
            parsed.source[i] = {sourceLines_[i], budget_.copy(pending_[i], sourceLines_[i])};
        result_.definitions.push_back(std::move(parsed));
    }
};

std::uint16_t word16(std::span<const std::uint8_t> bytes, std::size_t offset) {
    return static_cast<std::uint16_t>(std::uint16_t{bytes[offset]} |
                                      (std::uint16_t{bytes[offset + 1]} << 8));
}

std::uint64_t image_pixels(std::uint32_t width, std::uint32_t height) {
    if (!width || !height || width > region_map_max_dimension || height > region_map_max_dimension)
        throw std::runtime_error("TGA24: unsupported dimensions");
    const auto count = std::uint64_t{width} * height;
    if (count > region_map_max_pixels)
        throw std::runtime_error("TGA24: pixel limit exceeded");
    return count;
}

} // namespace

RegionDefinitions load_regions(std::string_view input) {
    return RegionParser{}.run(input);
}

RgbImage load_tga24(std::span<const std::uint8_t> bytes) {
    if (bytes.size() < 18)
        throw std::runtime_error("TGA24: truncated header");
    TgaHeader header;
    std::copy_n(bytes.begin(), header.bytes.size(), header.bytes.begin());
    header.idLength = bytes[0];
    header.colorMapType = bytes[1];
    header.imageType = bytes[2];
    header.colorMapFirstEntry = word16(bytes, 3);
    header.colorMapLength = word16(bytes, 5);
    header.colorMapEntryBits = bytes[7];
    header.xOrigin = word16(bytes, 8);
    header.yOrigin = word16(bytes, 10);
    header.width = word16(bytes, 12);
    header.height = word16(bytes, 14);
    header.pixelDepth = bytes[16];
    header.descriptor = bytes[17];
    if (header.idLength || header.colorMapType || header.colorMapFirstEntry ||
        header.colorMapLength || header.colorMapEntryBits || header.imageType != 2 ||
        header.pixelDepth != 24 || (header.descriptor & ~0x30u))
        throw std::runtime_error("TGA24: unsupported header format");
    const auto count = image_pixels(header.width, header.height);
    if (bytes.size() != 18 + count * 3)
        throw std::runtime_error("TGA24: payload length mismatch");
    RgbImage image;
    image.width = header.width;
    image.height = header.height;
    image.header = header;
    image.rgb.resize(static_cast<std::size_t>(count * 3));
    const bool rightOrigin = (header.descriptor & 0x10) != 0;
    const bool topOrigin = (header.descriptor & 0x20) != 0;
    for (std::uint32_t y = 0; y < image.height; ++y) {
        const auto sourceY = topOrigin ? y : image.height - 1 - y;
        for (std::uint32_t x = 0; x < image.width; ++x) {
            const auto sourceX = rightOrigin ? image.width - 1 - x : x;
            const auto source =
                static_cast<std::size_t>(18 + 3 * (std::uint64_t{sourceY} * image.width + sourceX));
            const auto target = static_cast<std::size_t>(3 * (std::uint64_t{y} * image.width + x));
            image.rgb[target] = bytes[source + 2];
            image.rgb[target + 1] = bytes[source + 1];
            image.rgb[target + 2] = bytes[source];
        }
    }
    return image;
}

Rgb RgbImage::pixel_at(std::uint32_t x, std::uint32_t y) const {
    if (x >= width || y >= height)
        throw std::out_of_range("RGB image: pixel coordinates outside image");
    const auto count = image_pixels(width, height);
    if (rgb.size() != count * 3)
        throw std::runtime_error("RGB image: inconsistent byte extent");
    const auto offset = static_cast<std::size_t>(3 * (std::uint64_t{y} * width + x));
    return {rgb[offset], rgb[offset + 1], rgb[offset + 2]};
}

} // namespace openrtw
