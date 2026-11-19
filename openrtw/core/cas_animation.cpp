#include "cas_animation.hpp"

#include <algorithm>
#include <bit>
#include <cmath>
#include <limits>
#include <stdexcept>

namespace openrtw {
namespace {
static_assert(sizeof(float) == 4 && std::numeric_limits<float>::is_iec559);
[[noreturn]] void refuse() {
    throw std::runtime_error("Unsupported or malformed selected CAS animation");
}

struct Budget {
    std::size_t owned = 0;
    void charge(std::size_t size) {
        if (size > cas_animation_max_owned_bytes - owned)
            refuse();
        owned += size;
    }
};

class Reader {
public:
    Reader(std::span<const std::uint8_t> bytes, Budget& budget) : bytes_(bytes), budget_(budget) {}
    std::size_t at() const noexcept { return at_; }
    std::uint32_t integer(unsigned width) {
        if (width > bytes_.size() - at_)
            refuse();
        std::uint32_t value = 0;
        for (unsigned i = 0; i < width; ++i)
            value |= std::uint32_t{bytes_[at_++]} << (8u * i);
        return value;
    }
    CasAnimationByteRange range(std::size_t start) const noexcept {
        return {static_cast<std::uint32_t>(start), static_cast<std::uint32_t>(at_)};
    }
    std::vector<std::uint32_t> words(std::size_t count) {
        if (count > (bytes_.size() - at_) / 4)
            refuse();
        budget_.charge(count * sizeof(std::uint32_t));
        std::vector<std::uint32_t> result;
        result.reserve(count);
        for (std::size_t i = 0; i < count; ++i) {
            const auto word = integer(4);
            if ((word & 0x7f800000u) == 0x7f800000u)
                refuse();
            result.push_back(word);
        }
        return result;
    }

private:
    std::span<const std::uint8_t> bytes_;
    Budget& budget_;
    std::size_t at_ = 0;
};

bool same_range(CasAnimationByteRange range, std::uint32_t start, std::uint32_t end) noexcept {
    return range.start == start && range.endExclusive == end;
}

struct SelectedLayout {
    std::uint32_t bytes, frames, rotationEnd, positionEnd, incrementEnd;
    std::uint32_t distanceEnd, controlEnd, tailEnd;
};
constexpr SelectedLayout selected21{7093, 21, 6389, 6641, 6761, 6801, 7053, 7085};
constexpr SelectedLayout standing11{3733, 11, 3349, 3481, 3541, 3561, 3693, 3725};

const SelectedLayout& selected_layout(CasAnimationAdmissionProfile profile) {
    switch (profile) {
    case CasAnimationAdmissionProfile::selected21:
        return selected21;
    case CasAnimationAdmissionProfile::standing11:
        return standing11;
    }
    refuse();
}

const SelectedLayout& selected_storage(const CasAnimation& value) {
    const auto& layout = selected_layout(value.admissionProfile);
    if (value.sourceBytes.size() != layout.bytes || value.frameCount != layout.frames ||
        value.rotationSlotCount != cas_animation_selected_rotation_slots ||
        value.positionChannelCount != cas_animation_selected_position_channels ||
        value.rotationQuaternionBits.size() != (layout.rotationEnd - 5) / 4 ||
        value.positionChannelBits.size() != (layout.positionEnd - layout.rotationEnd) / 4 ||
        value.doubledIncrementBits.size() != (layout.incrementEnd - layout.positionEnd) / 4 ||
        value.doubledDistanceBits.size() != (layout.distanceEnd - layout.incrementEnd) / 4 ||
        value.controlPositionBits.size() != (layout.controlEnd - layout.distanceEnd) / 4 ||
        value.tailFloatBits.size() != 8 || !same_range(value.headerRange, 0, 5) ||
        !same_range(value.rotationRange, 5, layout.rotationEnd) ||
        !same_range(value.positionRange, layout.rotationEnd, layout.positionEnd) ||
        !same_range(value.doubledIncrementRange, layout.positionEnd, layout.incrementEnd) ||
        !same_range(value.doubledDistanceRange, layout.incrementEnd, layout.distanceEnd) ||
        !same_range(value.controlPositionRange, layout.distanceEnd, layout.controlEnd) ||
        !same_range(value.tailFloatRange, layout.controlEnd, layout.tailEnd) ||
        !same_range(value.trailingRange, layout.tailEnd, layout.bytes) ||
        !same_range(value.positionMaskRange, layout.tailEnd, layout.tailEnd + 4) ||
        !same_range(value.opaqueWriterTailRange, layout.tailEnd + 4, layout.bytes) ||
        value.trailingBytes != std::array<std::uint8_t, 8>{1, 0, 0, 0, 0, 0, 0, 0})
        refuse();
    return layout;
}

void raw_words(const CasAnimation& value, CasAnimationByteRange range,
               std::span<const std::uint32_t> words) {
    if (range.start > range.endExclusive || range.endExclusive > value.sourceBytes.size() ||
        range.bytes() != words.size() * 4)
        refuse();
    for (std::size_t i = 0; i < words.size(); ++i) {
        std::uint32_t word = 0;
        for (unsigned k = 0; k < 4; ++k)
            word |= std::uint32_t{value.sourceBytes[range.start + i * 4 + k]} << (8u * k);
        if (word != words[i] || (word & 0x7f800000u) == 0x7f800000u)
            refuse();
    }
}

void quaternion_domain(std::span<const std::uint32_t> bits) {
    for (std::size_t i = 0; i < bits.size(); i += 4) {
        std::array<double, 4> q{};
        for (std::size_t k = 0; k < 4; ++k)
            q[k] = static_cast<double>(std::bit_cast<float>(bits[i + k]));
        const double norm = q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3];
        if (!std::isfinite(norm) || norm == 0 || std::abs(norm - 1) > 0.001)
            refuse();
    }
}
} // namespace

CasAnimation load_cas_animation(std::span<const std::uint8_t> input) {
    if (input.size() > cas_animation_max_input_bytes ||
        input.size() != cas_animation_selected_source_bytes)
        refuse();
    Budget budget;
    budget.charge(input.size());
    Reader reader(input, budget);
    CasAnimation result;
    result.frameCount = reader.integer(2);
    result.rotationSlotCount = reader.integer(2);
    result.positionChannelCount = reader.integer(1);
    if (result.frameCount != cas_animation_selected_frames ||
        result.rotationSlotCount != cas_animation_selected_rotation_slots ||
        result.positionChannelCount != cas_animation_selected_position_channels)
        refuse();
    result.headerRange = reader.range(0);
    auto read = [&](std::size_t count, std::vector<std::uint32_t>& words,
                    CasAnimationByteRange& range) {
        const auto start = reader.at();
        words = reader.words(count);
        range = reader.range(start);
    };
    read(std::size_t{result.frameCount} * result.rotationSlotCount * 4,
         result.rotationQuaternionBits, result.rotationRange);
    read(std::size_t{result.positionChannelCount} * result.frameCount * 3,
         result.positionChannelBits, result.positionRange);
    const auto half = (result.frameCount - 1) / 2;
    read(std::size_t{half} * 3, result.doubledIncrementBits, result.doubledIncrementRange);
    read(half, result.doubledDistanceBits, result.doubledDistanceRange);
    read(std::size_t{result.frameCount} * 3, result.controlPositionBits,
         result.controlPositionRange);
    read(8, result.tailFloatBits, result.tailFloatRange);
    const auto tail_start = reader.at();
    for (auto& byte : result.trailingBytes)
        byte = static_cast<std::uint8_t>(reader.integer(1));
    result.trailingRange = reader.range(tail_start);
    result.positionMaskRange = {static_cast<std::uint32_t>(tail_start),
                                static_cast<std::uint32_t>(tail_start + 4)};
    result.opaqueWriterTailRange = {static_cast<std::uint32_t>(tail_start + 4),
                                    static_cast<std::uint32_t>(tail_start + 8)};
    if (reader.at() != input.size())
        refuse();
    quaternion_domain(result.rotationQuaternionBits);
    result.sourceBytes.assign(input.begin(), input.end());
    selected_storage(result);
    return result;
}

CasAnimation load_cas_animation_standing11(std::span<const std::uint8_t> input) {
    if (input.size() > cas_animation_max_input_bytes ||
        input.size() != cas_animation_standing11_source_bytes)
        refuse();
    Budget budget;
    budget.charge(input.size());
    Reader reader(input, budget);
    CasAnimation result;
    result.admissionProfile = CasAnimationAdmissionProfile::standing11;
    result.frameCount = reader.integer(2);
    result.rotationSlotCount = reader.integer(2);
    result.positionChannelCount = reader.integer(1);
    if (result.frameCount != cas_animation_standing11_frames ||
        result.rotationSlotCount != cas_animation_selected_rotation_slots ||
        result.positionChannelCount != cas_animation_selected_position_channels)
        refuse();
    result.headerRange = reader.range(0);
    auto read = [&](std::size_t count, std::vector<std::uint32_t>& words,
                    CasAnimationByteRange& range) {
        const auto start = reader.at();
        words = reader.words(count);
        range = reader.range(start);
    };
    read(std::size_t{result.frameCount} * result.rotationSlotCount * 4,
         result.rotationQuaternionBits, result.rotationRange);
    read(std::size_t{result.positionChannelCount} * result.frameCount * 3,
         result.positionChannelBits, result.positionRange);
    const auto half = (result.frameCount - 1) / 2;
    read(std::size_t{half} * 3, result.doubledIncrementBits, result.doubledIncrementRange);
    read(half, result.doubledDistanceBits, result.doubledDistanceRange);
    read(std::size_t{result.frameCount} * 3, result.controlPositionBits,
         result.controlPositionRange);
    read(8, result.tailFloatBits, result.tailFloatRange);
    const auto tail_start = reader.at();
    for (auto& byte : result.trailingBytes)
        byte = static_cast<std::uint8_t>(reader.integer(1));
    result.trailingRange = reader.range(tail_start);
    result.positionMaskRange = {static_cast<std::uint32_t>(tail_start),
                                static_cast<std::uint32_t>(tail_start + 4)};
    result.opaqueWriterTailRange = {static_cast<std::uint32_t>(tail_start + 4),
                                    static_cast<std::uint32_t>(tail_start + 8)};
    if (reader.at() != input.size())
        refuse();
    quaternion_domain(result.rotationQuaternionBits);
    result.sourceBytes.assign(input.begin(), input.end());
    selected_storage(result);
    return result;
}

CasAnimationFrame cas_animation_frame(const CasAnimation& animation, std::uint32_t frameIndex) {
    const auto& layout = selected_storage(animation);
    if (frameIndex >= animation.frameCount)
        refuse();
    // Public values are mutable: validate source joins before exposing a frame.
    const auto& source = animation.sourceBytes;
    if (source[0] != layout.frames || source[1] != 0 || source[2] != 19 || source[3] != 0 ||
        source[4] != 1 ||
        !std::equal(animation.trailingBytes.begin(), animation.trailingBytes.end(),
                    source.begin() + layout.tailEnd))
        refuse();
    raw_words(animation, animation.rotationRange, animation.rotationQuaternionBits);
    raw_words(animation, animation.positionRange, animation.positionChannelBits);
    raw_words(animation, animation.doubledIncrementRange, animation.doubledIncrementBits);
    raw_words(animation, animation.doubledDistanceRange, animation.doubledDistanceBits);
    raw_words(animation, animation.controlPositionRange, animation.controlPositionBits);
    raw_words(animation, animation.tailFloatRange, animation.tailFloatBits);
    quaternion_domain(animation.rotationQuaternionBits);
    CasAnimationFrame result;
    result.frameIndex = frameIndex;
    const auto rotation_start =
        animation.rotationRange.start + frameIndex * animation.rotationSlotCount * 16;
    result.rotationRange = {rotation_start, rotation_start + animation.rotationSlotCount * 16};
    result.rotationQuaternionBits.resize(animation.rotationSlotCount);
    for (std::size_t slot = 0; slot < result.rotationQuaternionBits.size(); ++slot)
        std::copy_n(animation.rotationQuaternionBits.begin() +
                        static_cast<std::ptrdiff_t>(
                            (std::size_t{frameIndex} * animation.rotationSlotCount + slot) * 4),
                    4, result.rotationQuaternionBits[slot].begin());
    const auto position_start = animation.positionRange.start + frameIndex * 12;
    result.positionChannelRange = {position_start, position_start + 12};
    const auto control_start = animation.controlPositionRange.start + frameIndex * 12;
    result.controlPositionRange = {control_start, control_start + 12};
    std::copy_n(animation.positionChannelBits.begin() + static_cast<std::ptrdiff_t>(frameIndex * 3),
                3, result.positionChannelBits.begin());
    std::copy_n(animation.controlPositionBits.begin() + static_cast<std::ptrdiff_t>(frameIndex * 3),
                3, result.controlPositionBits.begin());
    return result;
}

} // namespace openrtw
