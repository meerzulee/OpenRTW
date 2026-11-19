#include "aerial_mask_weights.hpp"
#include <algorithm>
#include <bit>
#include <stdexcept>

namespace openrtw {
namespace {
struct Binary {
    std::uint64_t significand;
    int power;
};
Binary unpack(std::uint32_t bits) {
    return {bits ? (bits & 0x7fffffu) | 0x800000u : 0,
            bits ? static_cast<int>(bits >> 23) - 150 : 0};
}
std::uint32_t assemble(std::uint64_t mantissa, int exponent) {
    if (mantissa == 0x1000000u) {
        mantissa >>= 1;
        ++exponent;
    }
    if (exponent < -126 || exponent > 127 || mantissa < 0x800000u || mantissa >= 0x1000000u)
        throw std::runtime_error("Aerial masks: internal numeric domain");
    return (static_cast<std::uint32_t>(exponent + 127) << 23) |
           (static_cast<std::uint32_t>(mantissa) & 0x7fffffu);
}
// Exact nonnegative integer*2^power -> normal F32 RNE, or positive zero.
std::uint32_t round_binary(std::uint64_t n, int power) {
    if (!n)
        return 0;
    const int high = static_cast<int>(std::bit_width(n)) - 1;
    const int shift = high - 23;
    std::uint64_t q;
    if (shift > 0) {
        q = n >> shift;
        const auto remainder = n & ((std::uint64_t{1} << shift) - 1);
        const auto half = std::uint64_t{1} << (shift - 1);
        if (remainder > half || (remainder == half && (q & 1)))
            ++q;
    } else
        q = n << (-shift);
    return assemble(q, high + power);
}
// Closed source domain: n<=255 or1, d<=24 significant bits. The quotient
// remainder is far enough from an F32 midpoint that PC64/RN division followed
// by its source F32 store agrees with exact-rational RNE here.
std::uint32_t ratio(std::uint64_t n, std::uint64_t d, int power = 0) {
    if (!n)
        return 0;
    int exponent = static_cast<int>(std::bit_width(n)) - static_cast<int>(std::bit_width(d));
    if (exponent >= 0) {
        if (n < (d << exponent))
            --exponent;
    } else if ((n << (-exponent)) < d)
        --exponent;
    const int shift = 23 - exponent;
    if (shift < 0 || shift > 47 || n > (UINT64_MAX >> shift))
        throw std::runtime_error("Aerial masks: internal division domain");
    const auto scaled = n << shift;
    auto q = scaled / d;
    const auto remainder = scaled % d;
    if (remainder * 2 > d || (remainder * 2 == d && (q & 1)))
        ++q;
    return assemble(q, exponent + power);
}
std::uint32_t add(std::uint32_t a, std::uint32_t b) {
    if (!a)
        return b;
    if (!b)
        return a;
    const auto x = unpack(a), y = unpack(b);
    const int power = std::min(x.power, y.power);
    // At most four [0,1] byte/255 terms: exact aligned sums fit well below64b.
    return round_binary((x.significand << (x.power - power)) + (y.significand << (y.power - power)),
                        power);
}
std::uint8_t weight(std::uint32_t reciprocal, std::uint32_t sum) {
    if (!reciprocal || !sum)
        return 0;
    const auto a = unpack(reciprocal), b = unpack(sum);
    // Both source FMULs are exact under PC64: <=24+24+8=56 bits. Do NOT
    // round/spill their first product to F32 or route through binary64.
    const auto bits = round_binary(a.significand * b.significand * 255u, a.power + b.power);
    const auto value = unpack(bits);
    const int exponent = static_cast<int>(bits >> 23) - 127;
    if (exponent > 23)
        throw std::runtime_error("Aerial masks: internal integer domain");
    const auto integer =
        exponent < 0 ? 0u : static_cast<std::uint32_t>(value.significand >> (23 - exponent));
    return static_cast<std::uint8_t>(integer & 255u); // Native FRNDINT toward0 + AL.
}
std::uint64_t lanes(std::uint8_t n) {
    return std::uint64_t{n} * 0x0001000100010001ull;
}
} // namespace
AerialMaskWeights
build_aerial_mask_weights(const std::array<std::span<const std::uint8_t>, 4>& patterns,
                          const std::array<std::uint32_t, 4>& labels,
                          AerialMaskNumericPolicy policy) {
    if (policy != AerialMaskNumericPolicy::Extended64NearestEven)
        throw std::runtime_error("Aerial masks: explicit supported numeric policy required");
    for (unsigned i = 0; i < 4; ++i)
        if (patterns[i].size() != aerial_mask_samples || !patterns[i].data() || labels[i] > 3)
            throw std::runtime_error("Aerial masks: need four225-byte patterns and labels0..3");
    AerialMaskWeights out;
    for (unsigned corner = 0; corner < 4; ++corner) {
        unsigned group = 0;
        while (group < out.groupCount && out.groupLabels[group] != labels[corner])
            ++group;
        if (group == out.groupCount)
            out.groupLabels[out.groupCount++] = labels[corner];
        out.cornerGroups[corner] = static_cast<std::uint8_t>(group);
    }
    for (unsigned a = 0; a < 15; ++a)
        for (unsigned b = 0; b < 15; ++b) {
            const std::array<unsigned, 4> source{15 * a + b, 15 * (14 - a) + b, 15 * a + (14 - b),
                                                 15 * (14 - a) + (14 - b)};
            std::array<std::uint32_t, 4> sums{};
            std::uint32_t total = 0;
            for (unsigned c = 0; c < 4; ++c) {
                // Source's following F32 multiply-by-one is exactly unchanged.
                const auto value = ratio(patterns[c][source[c]], 255);
                sums[out.cornerGroups[c]] = add(sums[out.cornerGroups[c]], value);
                total = add(total, value);
            }
            const auto t = unpack(total);
            const auto reciprocal = total ? ratio(1, t.significand, -t.power) : 0;
            for (unsigned group = 0; group < out.groupCount; ++group) {
                const auto w = weight(reciprocal, sums[group]);
                const auto index = 15 * a + b;
                out.normal[group][index] = lanes(w);
                out.quarter[group][index] = lanes(w >> 2);
            }
        }
    return out;
}
} // namespace openrtw
