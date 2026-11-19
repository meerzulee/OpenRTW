#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <span>
#include <vector>

namespace openrtw {

// OpenRTW admission budgets and two closed standalone-animation profiles.
// These are not recovered original engine limits or a generic CAS version.
inline constexpr std::size_t cas_animation_max_input_bytes = 1024 * 1024;
inline constexpr std::size_t cas_animation_max_owned_bytes = 8 * 1024 * 1024;
inline constexpr std::uint32_t cas_animation_selected_frames = 21;
inline constexpr std::uint32_t cas_animation_selected_rotation_slots = 19;
inline constexpr std::uint32_t cas_animation_selected_position_channels = 1;
inline constexpr std::size_t cas_animation_selected_source_bytes = 7093;
inline constexpr std::uint32_t cas_animation_standing11_frames = 11;
inline constexpr std::size_t cas_animation_standing11_source_bytes = 3733;

enum class CasAnimationAdmissionProfile : std::uint8_t { selected21, standing11 };

struct CasAnimationByteRange {
    std::uint32_t start = 0, endExclusive = 0;
    std::uint32_t bytes() const noexcept { return endExclusive - start; }
};

struct CasAnimation {
    // Exact owned input: five-byte count header, raw finite F32 words and tail.
    // No normalization, interpolation, axis conversion or unknown-scale repair.
    std::vector<std::uint8_t> sourceBytes;
    std::uint32_t frameCount = 0, rotationSlotCount = 0, positionChannelCount = 0;
    CasAnimationByteRange headerRange, rotationRange, positionRange;
    CasAnimationByteRange doubledIncrementRange, doubledDistanceRange;
    CasAnimationByteRange controlPositionRange, tailFloatRange;
    CasAnimationByteRange trailingRange, positionMaskRange, opaqueWriterTailRange;
    // Frame-major [frame][rotation slot][XYZW raw words]. Slots have no names.
    std::vector<std::uint32_t> rotationQuaternionBits;
    // Channel-major [channel][frame][XYZ], with exactly one selected channel.
    std::vector<std::uint32_t> positionChannelBits;
    std::vector<std::uint32_t> doubledIncrementBits, doubledDistanceBits;
    std::vector<std::uint32_t> controlPositionBits, tailFloatBits;
    // Raw eight bytes after the eight tail floats. Selected writer emits
    // DWORD1 then DWORD0; the last DWORD's native meaning remains unknown.
    std::array<std::uint8_t, 8> trailingBytes{};
    // Explicit admission provenance, not a count-derived format guess. Mutable
    // public values are checked against the complete closed layout on access.
    CasAnimationAdmissionProfile admissionProfile = CasAnimationAdmissionProfile::selected21;
};

struct CasAnimationFrame {
    std::uint32_t frameIndex = 0;
    CasAnimationByteRange rotationRange, positionChannelRange, controlPositionRange;
    std::vector<std::array<std::uint32_t, 4>> rotationQuaternionBits;
    std::array<std::uint32_t, 3> positionChannelBits{}, controlPositionBits{};
};

// Source-backed selected21/19/1 standalone profile, not the mesh CAS header.
// The primary writer emits eight tail bytes; its importer consumes only six
// and does not enforce EOF. This profile retains/checks all eight as raw data
// and requires exact EOF. It does not relabel the final bytes as padding.
// All F32 words must be finite. As an explicit OpenRTW admission policy,
// quaternion norm squared must be nonzero and within0.001 of1; raw bits are
// retained unchanged. Other count/tail/layout profiles refuse, without retry.
// Validation/allocation completes before return; no borrowed input escapes.
// Malformed/unsupported input throws runtime_error; allocation errors propagate.
// No stored names/parents, timing, scale, native pose or rendering is inferred.
CasAnimation load_cas_animation(std::span<const std::uint8_t> input);

// Explicit selected11/19/1/3733 profile for the separately projected infantry
// standing source. Retains the same finite/raw/quaternion/full-tail policies;
// refuses21-frame and every other layout, without retrying the default reader.
CasAnimation load_cas_animation_standing11(std::span<const std::uint8_t> input);

// Pure, checked, owned raw access for indices0..20 or0..10 in the admitted
// closed profile, without sampling a pose.
// Also refuses malformed caller-constructed/mutated CasAnimation storage.
// Returned arrays share no mutable storage with the source animation.
CasAnimationFrame cas_animation_frame(const CasAnimation& animation, std::uint32_t frameIndex);

} // namespace openrtw
