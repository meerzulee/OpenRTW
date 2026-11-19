#pragma once
#include "aerial_mask_weights.hpp"
#include "aerial_material_support.hpp"
#include <array>
#include <cstdint>
#include <span>

namespace openrtw {
// Explicit source-plane representation: a-major packed QWORD samples. No image
// decode/orientation or allocation semantics of native9EA918 are inferred.
struct AerialNormalTexture {
    std::uint32_t side = 0;
    std::span<const std::uint64_t> samples;
};
struct AerialNormalTile {
    // Numeric packed QWORD at32*x+y; all1024 samples owned and written.
    // Native little-endian byte encoding is separate from this typed output.
    std::array<std::uint64_t, 1024> words{};
    std::uint32_t finalSeed = 0;
    // Diagnostic order is native v-outer/u-inner, even clipped edge patches.
    std::array<std::uint16_t, 16> maskIndices{};
};
// Normal-only9E65EA source projection: callerFlag must0; every record index
// must be nonnegative,<registry.size(),<=65535. No pseudo/default lookup.
// OpenRTW bounds:1..65536 registry entries, power-of-two side1..4096 with
// exactly side*side samples, exactly2048 caller-owned prebuilt masks. Selected
// masks must match stable corner grouping, replicated byte weights/quarter
// relation and zero unused planes from build_aerial_mask_weights's contract.
// Numeric policy/pattern order belong to that explicit prebuilt bank; this
// function adds no native incomingFP-state/image/pixel/renderer parity claim.
// Inputs are borrowed synchronously only. Refusal publishes nothing and does
// not mutate input records, samples, masks or caller seed.
AerialNormalTile build_aerial_normal_tile(const std::array<AerialMaterialRecord, 25>& records,
                                          std::span<const AerialNormalTexture> registry,
                                          std::span<const AerialMaskWeights> masks,
                                          std::uint32_t offsetA, std::uint32_t offsetB,
                                          std::uint32_t seed, std::uint32_t callerFlag);
} // namespace openrtw
