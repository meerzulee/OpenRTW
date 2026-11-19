#pragma once
#include <array>
#include <cstddef>
#include <cstdint>
#include <span>

namespace openrtw {
inline constexpr std::size_t aerial_mask_side = 15;
inline constexpr std::size_t aerial_mask_samples = 225;
// Explicit candidate policy. The native incoming x87 CW was not observed.
// PC64/RN means 64 significand bits, nearest-even; source F32 stores retained.
enum class AerialMaskNumericPolicy { Extended64NearestEven = 1 };
struct AerialMaskWeights {
    std::uint32_t groupCount = 0;
    std::array<std::uint32_t, 4> groupLabels{};
    std::array<std::uint8_t, 4> cornerGroups{};
    // Native a-major indexing: 15*a+b, not an asserted image orientation.
    // Each QWORD has four equal uint16 lanes; only groupCount planes are used.
    std::array<std::array<std::uint64_t, aerial_mask_samples>, 4> normal{};
    std::array<std::array<std::uint64_t, aerial_mask_samples>, 4> quarter{};
};
// Four explicit ordered 225-byte patterns and labels0..3. No RNG/selection,
// native bank layout/padding, image orientation or material/FP-state parity.
// Groups follow first appearance. Unused owned planes/labels are zero by new
// API policy. Refuses invalid extents/labels/policy before returning any data.
AerialMaskWeights
build_aerial_mask_weights(const std::array<std::span<const std::uint8_t>, 4>& patterns,
                          const std::array<std::uint32_t, 4>& labels,
                          AerialMaskNumericPolicy policy);
} // namespace openrtw
