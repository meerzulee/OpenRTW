#include "pcm.hpp"

#include <stdexcept>

namespace openrtw {
namespace {

std::uint16_t half(std::span<const std::uint8_t> bytes, std::size_t offset) {
    return static_cast<std::uint16_t>(std::uint32_t{bytes[offset]} |
                                      (std::uint32_t{bytes[offset + 1]} << 8));
}

std::uint32_t word(std::span<const std::uint8_t> bytes, std::size_t offset) {
    return std::uint32_t{bytes[offset]} | (std::uint32_t{bytes[offset + 1]} << 8) |
           (std::uint32_t{bytes[offset + 2]} << 16) | (std::uint32_t{bytes[offset + 3]} << 24);
}

bool tag(std::span<const std::uint8_t> bytes, std::size_t offset, const char (&expected)[5]) {
    for (std::size_t i = 0; i < 4; ++i)
        if (bytes[offset + i] != static_cast<std::uint8_t>(expected[i]))
            return false;
    return true;
}

} // namespace

PcmClip load_pcm(std::span<const std::uint8_t> bytes) {
    if (bytes.size() > pcm_max_input_bytes)
        throw std::runtime_error("PCM: input limit exceeded");
    if (bytes.size() < 44)
        throw std::runtime_error("PCM: truncated canonical header");
    if (!tag(bytes, 0, "RIFF") || !tag(bytes, 8, "WAVE") || !tag(bytes, 12, "fmt ") ||
        !tag(bytes, 36, "data"))
        throw std::runtime_error("PCM: unsupported canonical chunk layout");
    if (word(bytes, 16) != 16 || half(bytes, 20) != 1 || half(bytes, 22) != 1 ||
        word(bytes, 24) != 22050 || word(bytes, 28) != 44100 || half(bytes, 32) != 2 ||
        half(bytes, 34) != 16)
        throw std::runtime_error("PCM: unsupported mono PCM format");
    const auto dataBytes = word(bytes, 40);
    if (std::uint64_t{word(bytes, 4)} + 8 != bytes.size() ||
        std::uint64_t{dataBytes} + 44 != bytes.size() || dataBytes == 0 || dataBytes % 2 != 0)
        throw std::runtime_error("PCM: inconsistent or empty data extent");

    PcmClip result;
    result.sampleRate = 22050;
    result.monoSamples.reserve(static_cast<std::size_t>(dataBytes / 2));
    for (std::size_t offset = 44; offset < bytes.size(); offset += 2) {
        const auto bits = half(bytes, offset);
        // Arithmetic conversion avoids alignment, host endian and out-of-range
        // unsigned-to-signed cast assumptions while preserving every PCM word.
        const auto sample = bits < 0x8000u ? static_cast<std::int32_t>(bits)
                                           : static_cast<std::int32_t>(bits) - 65536;
        result.monoSamples.push_back(static_cast<std::int16_t>(sample));
    }
    return result;
}

} // namespace openrtw
