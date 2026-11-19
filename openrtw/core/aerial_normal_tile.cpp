#include "aerial_normal_tile.hpp"
#include "aerial_word_math.hpp"
#include <stdexcept>

namespace openrtw {
namespace {
[[noreturn]] void invalid() {
    throw std::invalid_argument("Aerial normal tile: invalid explicit input");
}
std::uint32_t index(const AerialMaterialRecord& r) {
    return std::uint32_t(r[0]) | (std::uint32_t(r[1]) << 8) | (std::uint32_t(r[2]) << 16) |
           (std::uint32_t(r[3]) << 24);
}
struct Patch {
    unsigned u = 0, v = 0, count = 0;
    std::array<AerialMaterialRecord, 4> groups{};
    std::array<std::uint32_t, 4> corners{};
    std::uint16_t maskIndex = 0;
};
Patch group_patch(const std::array<AerialMaterialRecord, 25>& r, unsigned u, unsigned v) {
    Patch p;
    p.u = u;
    p.v = v;
    const std::array<unsigned, 4> cells{5 * u + v + 1, 5 * (u + 1) + v + 1, 5 * u + v,
                                        5 * (u + 1) + v};
    for (unsigned c = 0; c < 4; ++c) {
        unsigned g = 0;
        while (g < p.count && !aerial_material_equal(p.groups[g], r[cells[c]]))
            ++g;
        if (g == p.count)
            p.groups[p.count++] = r[cells[c]];
        p.corners[c] = g;
    }
    return p;
}
void validate_mask(const AerialMaskWeights& m, const Patch& p) {
    if (m.groupCount != p.count)
        invalid();
    for (unsigned c = 0; c < 4; ++c)
        if (m.cornerGroups[c] != p.corners[c])
            invalid();
    for (unsigned g = 0; g < 4; ++g) {
        if (m.groupLabels[g] != (g < p.count ? g : 0))
            invalid();
        for (unsigned i = 0; i < 225; ++i) {
            const auto n = m.normal[g][i];
            const auto w = n & 255u;
            if (n != w * 0x0001000100010001ull ||
                m.quarter[g][i] != (w >> 2) * 0x0001000100010001ull || (g >= p.count && n != 0))
                invalid();
        }
    }
}
std::uint64_t sample(const AerialNormalTexture& t, unsigned x, unsigned y, std::uint32_t offsetA,
                     std::uint32_t offsetB) {
    const auto a = (std::uint32_t(x) + offsetA) & (t.side - 1);
    const auto b = (std::uint32_t(y) + offsetB) & (t.side - 1);
    return t.samples[std::size_t(a) * t.side + b];
}
} // namespace
AerialNormalTile build_aerial_normal_tile(const std::array<AerialMaterialRecord, 25>& records,
                                          std::span<const AerialNormalTexture> registry,
                                          std::span<const AerialMaskWeights> masks,
                                          std::uint32_t offsetA, std::uint32_t offsetB,
                                          std::uint32_t seed, std::uint32_t callerFlag) {
    // Refuse unsupported branch domains before any RNG or pixel work.
    if (callerFlag != 0 || registry.empty() || registry.size() > 65536 || masks.size() != 2048)
        invalid();
    for (const auto& r : records)
        if (index(r) > 65535 || index(r) >= registry.size())
            invalid();
    for (const auto& t : registry)
        if (!t.side || t.side > 4096 || (t.side & (t.side - 1)) || !t.samples.data() ||
            t.samples.size() != std::size_t(t.side) * t.side)
            invalid();
    AerialNormalTile out;
    std::array<Patch, 16> patches{};
    unsigned cursor = 0;
    // Native9E6670/9E668E: v outer, u inner. Advance even single-group and
    // clipped patches (9E6D79), before any source sampling.
    for (unsigned v = 0; v < 4; ++v)
        for (unsigned u = 0; u < 4; ++u) {
            auto p = group_patch(records, u, v);
            p.maskIndex = static_cast<std::uint16_t>(
                aerial_mask_index_bounded(p.corners, aerial_random_range_bits(seed, 0, 7)));
            validate_mask(masks[p.maskIndex], p);
            out.maskIndices[cursor] = p.maskIndex;
            patches[cursor++] = p;
        }
    out.finalSeed = seed;
    for (const auto& p : patches) {
        const unsigned alo = p.u == 0 ? 14 : 0, ahi = p.u == 3 ? 0 : 14;
        const unsigned blo = p.v == 3 ? 14 : 0, bhi = p.v == 0 ? 0 : 14;
        for (unsigned a = alo; a <= ahi; ++a)
            for (unsigned b = blo; b <= bhi; ++b) {
                const unsigned x = static_cast<unsigned>(15 * (int(p.u) - 1) + 1 + int(a));
                const unsigned y = static_cast<unsigned>(15 * (2 - int(p.v)) + 1 + int(b));
                std::array<std::uint64_t, 4> samples{}, weights{};
                for (unsigned g = 0; g < p.count; ++g) {
                    const auto& r = p.groups[g];
                    samples[g] = sample(registry[index(r)], x, y, offsetA, offsetB);
                    const auto& m = masks[p.maskIndex];
                    weights[g] = (r[5] ? m.quarter[g] : m.normal[g])[15 * a + b];
                }
                const auto q = p.count == 1
                                   ? aerial_word_math::normal_single(samples[0], p.groups[0][5])
                                   : aerial_word_math::normal_mixed4(samples, weights);
                out.words[32 * x + y] = q;
            }
    }
    return out;
}
} // namespace openrtw
