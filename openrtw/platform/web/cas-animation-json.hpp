#pragma once

#include "cas_animation.hpp"
#include "campaign_json.hpp"

#include <string>
#include <utility>

namespace openrtw {
inline constexpr std::size_t cas_animation_json_max_bytes = 64 * 1024;
namespace animation_json_detail {
inline void range(detail::Json& out, CasAnimationByteRange value) {
    out.append("{\"start\":");
    out.integer(value.start);
    out.append(",\"endExclusive\":");
    out.integer(value.endExclusive);
    out.append("}");
}
template <class Values> inline void words(detail::Json& out, const Values& values) {
    out.append("[");
    bool first = true;
    for (const auto value : values) {
        if (!first)
            out.append(",");
        first = false;
        out.integer(value);
    }
    out.append("]");
}
inline void counts(detail::Json& out, const CasAnimation& value) {
    out.append(",\"sourceBytes\":");
    out.integer(value.sourceBytes.size());
    out.append(",\"frameCount\":");
    out.integer(value.frameCount);
    out.append(",\"rotationSlotCount\":");
    out.integer(value.rotationSlotCount);
    out.append(",\"positionChannelCount\":");
    out.integer(value.positionChannelCount);
}
inline void profile(detail::Json& out, const CasAnimation& value) {
    // Validation runs before serialization; selected21 emits no extra bytes.
    if (value.admissionProfile == CasAnimationAdmissionProfile::standing11)
        out.append(",\"admissionProfile\":\"openrtw-cas-animation-standing11-v1\"");
}
inline std::string finish(detail::Json&& out) {
    auto json = std::move(out).finish();
    if (json.size() > cas_animation_json_max_bytes)
        throw std::runtime_error("CAS animation JSON exceeds bridge byte limit");
    return json;
}
} // namespace animation_json_detail

// Pure owned projections. Checked frame access validates the complete mutable
// source object before serialization, including unselected words and all tail
// bytes. No float conversion, names, parents, timing or pose policy is added.
inline std::string cas_animation_snapshot(const CasAnimation& value) {
    static_cast<void>(cas_animation_frame(value, 0));
    detail::Json out;
    out.append("{\"schema\":\"openrtw-cas-animation-v1\"");
    animation_json_detail::profile(out, value);
    animation_json_detail::counts(out, value);
    const auto fieldRange = [&](const char* name, CasAnimationByteRange bytes) {
        out.append(",");
        out.string(name);
        out.append(":");
        animation_json_detail::range(out, bytes);
    };
    fieldRange("headerRange", value.headerRange);
    fieldRange("rotationRange", value.rotationRange);
    fieldRange("positionRange", value.positionRange);
    fieldRange("doubledIncrementRange", value.doubledIncrementRange);
    fieldRange("doubledDistanceRange", value.doubledDistanceRange);
    fieldRange("controlPositionRange", value.controlPositionRange);
    fieldRange("tailFloatRange", value.tailFloatRange);
    fieldRange("trailingRange", value.trailingRange);
    fieldRange("positionMaskRange", value.positionMaskRange);
    fieldRange("opaqueWriterTailRange", value.opaqueWriterTailRange);
    const auto fieldWords = [&](const char* name, const auto& words) {
        out.append(",");
        out.string(name);
        out.append(":");
        animation_json_detail::words(out, words);
    };
    fieldWords("rotationQuaternionBits", value.rotationQuaternionBits);
    fieldWords("positionChannelBits", value.positionChannelBits);
    fieldWords("doubledIncrementBits", value.doubledIncrementBits);
    fieldWords("doubledDistanceBits", value.doubledDistanceBits);
    fieldWords("controlPositionBits", value.controlPositionBits);
    fieldWords("tailFloatBits", value.tailFloatBits);
    fieldWords("trailingBytes", value.trailingBytes);
    out.append("}");
    return animation_json_detail::finish(std::move(out));
}

inline std::string cas_animation_frame_snapshot(const CasAnimation& value,
                                                std::uint32_t frameIndex) {
    const auto frame = cas_animation_frame(value, frameIndex);
    detail::Json out;
    out.append("{\"schema\":\"openrtw-cas-animation-frame-v1\"");
    animation_json_detail::profile(out, value);
    animation_json_detail::counts(out, value);
    out.append(",\"frameIndex\":");
    out.integer(frame.frameIndex);
    out.append(",\"rotationRange\":");
    animation_json_detail::range(out, frame.rotationRange);
    out.append(",\"positionChannelRange\":");
    animation_json_detail::range(out, frame.positionChannelRange);
    out.append(",\"controlPositionRange\":");
    animation_json_detail::range(out, frame.controlPositionRange);
    out.append(",\"rotationQuaternionBits\":[");
    for (std::size_t i = 0; i < frame.rotationQuaternionBits.size(); ++i) {
        if (i)
            out.append(",");
        animation_json_detail::words(out, frame.rotationQuaternionBits[i]);
    }
    out.append("],\"positionChannelBits\":");
    animation_json_detail::words(out, frame.positionChannelBits);
    out.append(",\"controlPositionBits\":");
    animation_json_detail::words(out, frame.controlPositionBits);
    out.append("}");
    return animation_json_detail::finish(std::move(out));
}
} // namespace openrtw
