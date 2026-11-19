#pragma once

#include <cstddef>
#include <cstdint>
#include <span>
#include <vector>

namespace openrtw {

// New portable resource policy, not a recovered Miles allocation limit.
inline constexpr std::size_t pcm_max_input_bytes = 8 * 1024 * 1024;

struct PcmClip {
    std::uint32_t sampleRate = 0;
    // Owned signed samples in the source's mono order. No normalization,
    // resampling, mixing, scheduling or output device behavior is performed.
    std::vector<std::int16_t> monoSamples;
    bool operator==(const PcmClip&) const = default;
};

// Explicit subset of the retained first SFX asset: RIFF/WAVE, fmt chunk size16
// at byte12, data chunk at byte36, PCM1/mono22050Hz/16bit/block2/byteRate44100.
// RIFF, file and data extents must agree exactly; data is nonempty and even.
// The supplied span must be readable for its full extent. All validation and
// allocation precede a complete owned return; unsupported input throws
// std::runtime_error. No input storage or metadata pointer is retained.
// Strict format/refusal policies are new engine behavior. Existing native
// metadata proves the owned first29140B WAV and its14548 sample frames;
// general chunks/codecs/archive parsing and Miles CPU/lifecycle/playback
// behavior are not claimed by this integer-only source reader.
PcmClip load_pcm(std::span<const std::uint8_t> bytes);

} // namespace openrtw
