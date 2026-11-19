#include "cas_mesh.hpp"

#include <bit>
#include <cmath>
#include <limits>
#include <stdexcept>
#include <string_view>
#include <utility>

namespace openrtw {
namespace {
static_assert(sizeof(float) == 4 && std::numeric_limits<float>::is_iec559);
static_assert(sizeof(double) == 8 && std::numeric_limits<double>::is_iec559 &&
              std::numeric_limits<double>::digits == 53);

[[noreturn]] void refuse() {
    throw std::runtime_error("Unsupported or malformed static CAS candidate");
}

struct Budget {
    std::size_t retained = 0;
    void charge(std::size_t bytes) {
        if (bytes > cas_max_owned_bytes - retained)
            refuse();
        retained += bytes;
    }
};

class Reader {
public:
    Reader(std::span<const std::uint8_t> source, Budget& budget)
        : source_(source), budget_(budget), end_(source.size()) {}
    std::size_t at() const noexcept { return at_; }
    void need(std::size_t bytes) const {
        if (bytes > end_ - at_)
            refuse();
    }
    void skip(std::size_t bytes) {
        need(bytes);
        at_ += bytes;
    }
    void limit(std::size_t end) {
        if (end < at_ || end > source_.size())
            refuse();
        end_ = end;
    }
    std::size_t extent(std::size_t start, std::uint32_t size, std::size_t minimum) const {
        if (size < minimum || start > source_.size() || size > source_.size() - start)
            refuse();
        return start + size;
    }
    CasByteRange range(std::size_t start) const noexcept {
        return {static_cast<std::uint32_t>(start), static_cast<std::uint32_t>(at_)};
    }
    std::uint8_t u8() {
        need(1);
        return source_[at_++];
    }
    std::uint16_t u16() {
        need(2);
        const auto low = u8();
        return static_cast<std::uint16_t>(std::uint16_t{low} | (std::uint16_t{u8()} << 8u));
    }
    std::uint32_t u32() {
        need(4);
        std::uint32_t value = 0;
        for (unsigned i = 0; i < 4; ++i)
            value |= std::uint32_t{u8()} << (8u * i);
        return value;
    }
    std::uint32_t peek_u32(std::size_t relative) const {
        if (relative > end_ - at_ || end_ - at_ - relative < 4)
            refuse();
        std::uint32_t value = 0;
        for (unsigned i = 0; i < 4; ++i)
            value |= std::uint32_t{source_[at_ + relative + i]} << (8u * i);
        return value;
    }
    std::uint32_t finite_word() {
        const auto value = u32();
        if ((value & 0x7f800000u) == 0x7f800000u)
            refuse();
        return value;
    }
    std::string text(bool prefixed = true) {
        const auto size = prefixed ? u32() : 0;
        if (prefixed && (size < 2 || size > 256))
            refuse();
        if (prefixed)
            need(size);
        std::string value;
        for (std::size_t i = 0; i < (prefixed ? size : 256); ++i) {
            const auto byte = u8();
            if (byte == 0) {
                if (value.empty() || (prefixed && i + 1 != size))
                    refuse();
                budget_.charge(value.size());
                return value;
            }
            if (byte < 32 || byte > 126)
                refuse();
            value.push_back(static_cast<char>(byte));
        }
        refuse();
    }
    std::vector<std::uint32_t> words(std::size_t count, bool finite = true) {
        if (count > cas_max_input_bytes / 4)
            refuse();
        need(count * 4);
        budget_.charge(count * sizeof(std::uint32_t));
        std::vector<std::uint32_t> result;
        result.reserve(count);
        for (std::size_t i = 0; i < count; ++i)
            result.push_back(finite ? finite_word() : u32());
        return result;
    }
    void channel(std::uint32_t keys, std::size_t width) {
        const auto count = std::size_t{keys} * width;
        if (count > cas_max_input_bytes / 4)
            refuse();
        need(count * 4);
        for (std::size_t i = 0; i < count; ++i)
            (void)finite_word();
    }
    std::vector<std::uint8_t> opaque_bone_extra() {
        const auto size = u32();
        if (size > cas_max_bone_extra_bytes)
            refuse();
        need(size);
        budget_.charge(size);
        std::vector<std::uint8_t> result;
        result.reserve(size);
        for (std::uint32_t i = 0; i < size; ++i)
            result.push_back(u8());
        return result;
    }
    std::vector<std::uint8_t> empty_extra() {
        if (u32() != 1 || u8() != 0)
            refuse();
        budget_.charge(1);
        return {0};
    }
    std::vector<std::uint8_t> opaque_mesh_extra31() {
        const auto size = u32();
        if (size > cas_max_mesh_extra_bytes || size != 31)
            refuse();
        need(size);
        budget_.charge(size);
        std::vector<std::uint8_t> result;
        result.reserve(size);
        for (std::uint32_t i = 0; i < size; ++i)
            result.push_back(u8());
        return result;
    }
    std::vector<std::uint8_t> opaque_mesh_extra() {
        const auto size = u32();
        if (size > cas_max_mesh_extra_bytes)
            refuse();
        need(size);
        budget_.charge(size);
        std::vector<std::uint8_t> result;
        result.reserve(size);
        for (std::uint32_t i = 0; i < size; ++i)
            result.push_back(u8());
        return result;
    }

private:
    std::span<const std::uint8_t> source_;
    Budget& budget_;
    std::size_t at_ = 0, end_;
};

double decoded(std::uint32_t value) noexcept {
    return static_cast<double>(std::bit_cast<float>(value));
}

void add_bounded(std::uint32_t& total, std::uint32_t added, std::uint32_t maximum) {
    if (added > maximum - total)
        refuse();
    total += added;
}

enum class Profile { strict, olive312, terminal_kind7_316, rider312, empty_static305, any };

} // namespace

float cas_version_value(std::uint32_t versionBits) noexcept {
    return std::bit_cast<float>(versionBits);
}

static CasStaticModel load_cas_static_model_impl(std::span<const std::uint8_t> input,
                                                 Profile profile) {
    const bool repeated_static_count312 = profile == Profile::olive312;
    const bool terminal_kind7 = profile == Profile::terminal_kind7_316;
    const bool rider312 = profile == Profile::rider312;
    const bool empty_static305 = profile == Profile::empty_static305;
    const bool any = profile == Profile::any;
    if (input.empty() || input.size() > cas_max_input_bytes)
        refuse();
    Budget budget;
    budget.charge(input.size());
    Reader r(input, budget);
    CasStaticModel result;
    result.versionBits = r.u32();
    result.headerLength = r.u32();
    const float version = cas_version_value(result.versionBits);
    const bool version312 = result.versionBits == 0x4047ae14u;
    const bool version316 = result.versionBits == 0x404a3d71u;
    if (any) {
        if (!(version >= 3.02f && version <= 3.23f) || result.headerLength != 38)
            refuse();
    } else if ((!version312 && !version316 && result.versionBits != 0x40433333u) ||
               result.headerLength != 38) {
        refuse();
    }
    if (repeated_static_count312 && !version312)
        refuse();
    if ((terminal_kind7 && !version316) || (rider312 && !version312) ||
        (empty_static305 && result.versionBits != 0x40433333u))
        refuse();
    r.skip(34);
    result.headerRange = r.range(0);
    const auto animation_start = r.at();
    const auto animation_end = r.extent(animation_start, r.u32(), 10);
    r.limit(animation_end);
    if (r.u32() != 0)
        refuse();
    const std::uint32_t bones = (any && version < 3.045f) ? r.u8() : r.u16();
    if (bones == 0 || bones > cas_max_bones)
        refuse();
    if (repeated_static_count312 && bones != 1)
        refuse();
    if (((terminal_kind7 || rider312) && bones != 20) || (empty_static305 && bones != 21))
        refuse();
    budget.charge(std::size_t{bones} * sizeof(CasBone));
    result.bones.resize(bones);
    auto start = r.at();
    r.need(std::size_t{bones} * 4);
    for (std::uint32_t i = 0; i < bones; ++i) {
        auto& bone = result.bones[i];
        bone.id = i;
        bone.parent = r.u32();
        if ((i == 0 && bone.parent != 0) || (i != 0 && bone.parent >= i))
            refuse();
    }
    result.parentsRange = r.range(start);
    result.frameCount = r.u32();
    if (result.frameCount == 0 || result.frameCount > cas_max_frames)
        refuse();
    start = r.at();
    result.frameTimeBits = r.words(result.frameCount);
    result.frameTimeRange = r.range(start);
    for (std::size_t i = 1; i < result.frameTimeBits.size(); ++i)
        if (decoded(result.frameTimeBits[i]) < decoded(result.frameTimeBits[i - 1]))
            refuse();
    const auto headers_start = r.at();
    std::uint32_t total_keys = 0;
    for (auto& bone : result.bones) {
        start = r.at();
        bone.name = r.text();
        bone.rotationKeys = r.u32();
        bone.translationKeys = r.u32();
        bone.rotationOffset = r.u32();
        bone.translationOffset = r.u32();
        const auto flags = r.u32();
        for (unsigned i = 0; i < 4; ++i)
            bone.flagBytes[i] = static_cast<std::uint8_t>(flags >> (8u * i));
        if ((!any && flags != 0) || bone.rotationKeys > result.frameCount ||
            bone.translationKeys > result.frameCount)
            refuse();
        add_bounded(total_keys, bone.rotationKeys, cas_max_channel_keys);
        add_bounded(total_keys, bone.translationKeys, cas_max_channel_keys);
        result.rotationKeyCount += bone.rotationKeys;
        result.translationKeyCount += bone.translationKeys;
        if (version316 || (any && version >= 3.13f)) {
            const auto extra_start = r.at();
            bone.extra316Bytes = r.opaque_bone_extra();
            bone.extra316Range = r.range(extra_start);
        }
        bone.headerRange = r.range(start);
    }
    result.boneHeadersRange = r.range(headers_start);
    if (repeated_static_count312 && total_keys != 0)
        refuse();
    if (empty_static305 && total_keys != 0)
        refuse();
    std::uint32_t rotation_offset = 0, translation_offset = result.rotationKeyCount * 16;
    for (const auto& bone : result.bones) {
        if (bone.rotationOffset != rotation_offset || bone.translationOffset != translation_offset)
            refuse();
        rotation_offset += bone.rotationKeys * 16;
        translation_offset += bone.translationKeys * 12;
    }
    start = r.at();
    r.channel(result.rotationKeyCount, 4);
    result.rotationRange = r.range(start);
    start = r.at();
    r.channel(result.translationKeyCount, 3);
    result.translationRange = r.range(start);
    start = r.at();
    r.need(std::size_t{bones} * 12);
    for (auto& bone : result.bones)
        for (auto& value : bone.bindLocalBits)
            value = r.finite_word();
    result.bindRange = r.range(start);
    if (r.at() != animation_end)
        refuse();
    result.animationRange = {static_cast<std::uint32_t>(animation_start),
                             static_cast<std::uint32_t>(animation_end)};
    r.limit(input.size());
    for (auto& bone : result.bones) {
        for (std::size_t axis = 0; axis < 3; ++axis) {
            const auto parent =
                bone.id == 0 ? 0.0 : result.bones[bone.parent].candidateBindWorld[axis];
            bone.candidateBindWorld[axis] = decoded(bone.bindLocalBits[axis]) + parent;
            if (!std::isfinite(bone.candidateBindWorld[axis]))
                refuse();
        }
    }

    const auto read_mesh_chunk = [&](std::uint32_t kind, std::size_t chunk_start,
                                     std::uint32_t size) {
        const auto end = r.extent(chunk_start, size, 12);
        r.limit(end);
        const auto count = r.u32();
        if ((count == 0 && !any && !(version312 && kind == 2) && !(empty_static305 && kind == 1)) ||
            count > cas_max_meshes || count > cas_max_meshes - result.meshes.size())
            refuse();
        if (repeated_static_count312 && count != (kind == 1 ? 1u : 0u))
            refuse();
        if ((terminal_kind7 && count != (kind == 1 ? 3u : 2u)) ||
            (rider312 && count != (kind == 1 ? 3u : 1u)) ||
            (empty_static305 && count != (kind == 1 ? 0u : 1u)))
            refuse();
        budget.charge(std::size_t{count} * sizeof(CasMeshPart));
        for (std::uint32_t part = 0; part < count; ++part) {
            const auto record_start = r.at();
            CasMeshPart mesh;
            mesh.name = r.text();
            mesh.chunkKind = kind;
            const auto extra1_start = r.at();
            if (any) {
                if (kind == 2 || version >= 3.03f)
                    mesh.extra1 = r.opaque_mesh_extra();
            } else {
                mesh.extra1 =
                    ((terminal_kind7 && kind == 2 && part == 1) || (empty_static305 && kind == 2))
                        ? r.opaque_mesh_extra31()
                        : r.empty_extra();
            }
            mesh.extra1Range = r.range(extra1_start);
            const auto extra2_start = r.at();
            if (kind == 1) {
                if (any && version >= 3.01f)
                    mesh.extra2 = r.opaque_mesh_extra();
                else if (!any)
                    mesh.extra2 = r.empty_extra();
            }
            mesh.extra2Range = r.range(extra2_start);
            if (kind == 1) {
                mesh.attachedBone = r.u32();
                if (*mesh.attachedBone >= bones)
                    refuse();
            }
            for (auto& word : mesh.metadataBits)
                word = r.finite_word();
            mesh.vertices = r.u16();
            mesh.triangles = r.u16();
            mesh.uvFlag = r.u8();
            if (mesh.vertices == 0 || mesh.triangles == 0 ||
                (any ? mesh.uvFlag > 1 : mesh.uvFlag != 1))
                refuse();
            mesh.vertexColorFlag = r.u8();
            if (mesh.vertexColorFlag > 1 ||
                (!version312 && !version316 && !any && mesh.vertexColorFlag != 0))
                refuse();
            if (repeated_static_count312 && mesh.vertexColorFlag != 1)
                refuse();
            if ((terminal_kind7 || rider312) && mesh.vertexColorFlag != 1)
                refuse();
            add_bounded(result.totalVertices, mesh.vertices, cas_max_vertices);
            add_bounded(result.totalTriangles, mesh.triangles, cas_max_triangles);
            r.need(std::size_t{mesh.vertices} *
                       ((kind == 1 ? 24 : 28) + mesh.uvFlag * 8 + mesh.vertexColorFlag * 4) +
                   std::size_t{mesh.triangles} * 6 + 5);
            start = r.at();
            if (kind == 2)
                mesh.boneIndices = r.words(mesh.vertices, false);
            else {
                budget.charge(std::size_t{mesh.vertices} * 4);
                mesh.boneIndices.assign(mesh.vertices, *mesh.attachedBone);
            }
            for (const auto bone : mesh.boneIndices)
                if (bone >= bones)
                    refuse();
            mesh.assignmentRange = r.range(start);
            start = r.at();
            mesh.positionBits = r.words(std::size_t{mesh.vertices} * 3);
            mesh.positionRange = r.range(start);
            start = r.at();
            mesh.normalBits = r.words(std::size_t{mesh.vertices} * 3);
            mesh.normalRange = r.range(start);
            start = r.at();
            budget.charge(std::size_t{mesh.triangles} * 3 * sizeof(std::uint16_t));
            mesh.indices.reserve(std::size_t{mesh.triangles} * 3);
            for (std::size_t i = 0; i < std::size_t{mesh.triangles} * 3; ++i) {
                const auto index = r.u16();
                if (index >= mesh.vertices)
                    refuse();
                mesh.indices.push_back(index);
            }
            mesh.indexRange = r.range(start);
            mesh.textureIndex = std::bit_cast<std::int32_t>(r.u32());
            if (any ? mesh.textureIndex < -1 : mesh.textureIndex != 0)
                refuse();
            start = r.at();
            if (mesh.uvFlag != 0)
                mesh.uvBits = r.words(std::size_t{mesh.vertices} * 2);
            mesh.uvRange = r.range(start);
            start = r.at();
            if (mesh.vertexColorFlag != 0) {
                const auto bytes = std::size_t{mesh.vertices} * 4;
                r.need(bytes);
                budget.charge(bytes);
                mesh.vertexColorBytes.reserve(bytes);
                for (std::size_t i = 0; i < bytes; ++i)
                    mesh.vertexColorBytes.push_back(r.u8());
            }
            mesh.colorRange = r.range(start);
            const auto end_start = r.at();
            if (any && version >= 3.17f) {
                const auto ids = r.u32();
                if (ids > cas_max_mesh_flag_ids)
                    refuse();
                mesh.endFlagIds = r.words(ids, false);
            } else {
                mesh.endFlagMask = r.u8();
                if (!any && mesh.endFlagMask != 0)
                    refuse();
            }
            mesh.endRange = r.range(end_start);
            mesh.recordRange = r.range(record_start);
            budget.charge(std::size_t{mesh.vertices} * 3 * sizeof(double));
            mesh.candidateBindPositions.resize(std::size_t{mesh.vertices} * 3);
            for (std::size_t i = 0; i < mesh.candidateBindPositions.size(); ++i) {
                mesh.candidateBindPositions[i] =
                    decoded(mesh.positionBits[i]) +
                    result.bones[mesh.boneIndices[i / 3]].candidateBindWorld[i % 3];
                if (!std::isfinite(mesh.candidateBindPositions[i]))
                    refuse();
            }
            result.meshes.push_back(std::move(mesh));
        }
        if (kind == 1 && r.u16() != 0)
            refuse();
        const auto trailer_count =
            version312 && kind == 1 && !repeated_static_count312 && !rider312 ? 0u : count;
        const auto trailer = r.u32();
        result.chunkTrailerWords[kind - 1] = trailer;
        if ((!any && trailer != trailer_count) || r.at() != end)
            refuse();
        result.chunks[kind - 1] = {kind, count, r.range(chunk_start)};
        r.limit(input.size());
    };
    const auto read_empty_chunk = [&](std::uint32_t kind, std::size_t chunk_start,
                                      std::uint32_t size) {
        if (size != 16 || r.u32() != 0 || r.u32() != 0)
            refuse();
        result.opaqueChunks[kind == 3 ? 0 : kind == 8 ? 1 : 2] = {kind, 0, r.range(chunk_start)};
    };
    const auto read_materials = [&](std::size_t chunk_start, std::uint32_t size) {
        const auto material_end = r.extent(chunk_start, size, 12);
        if (!any && material_end != input.size() - (terminal_kind7 ? 12 : 0))
            refuse();
        const auto material_count = r.u32();
        if (any ? (material_count == 0 || material_count > cas_max_materials) : material_count != 1)
            refuse();
        r.limit(material_end);
        budget.charge(std::size_t{material_count} * sizeof(CasMaterial));
        result.materials.reserve(material_count);
        for (std::uint32_t m = 0; m < material_count; ++m) {
            CasMaterial material;
            const auto record_start = r.at();
            if (r.u32() != 1 || r.u8() != 0)
                refuse();
            start = r.at();
            material.textureName = r.text(false);
            material.nameRange = r.range(start);
            for (auto& word : material.rawBits)
                word = r.finite_word();
            start = r.at();
            for (auto& byte : material.opaqueTailBytes) {
                byte = r.u8();
                if (!version312 && !version316 && !empty_static305 && !any && byte != 0)
                    refuse();
            }
            material.opaqueTailRange = r.range(start);
            material.lastByte = r.u8();
            if (any ? material.lastByte > 1 : material.lastByte != 1)
                refuse();
            material.range = r.range(record_start);
            result.materials.push_back(std::move(material));
        }
        if (r.at() != material_end)
            refuse();
        result.material = result.materials.front();
        result.material.range = r.range(chunk_start);
        r.limit(input.size());
    };
    const auto read_kind7 = [&](std::size_t chunk_start, std::uint32_t size) {
        constexpr std::array<std::uint32_t, 3> signature{12, 7, 0};
        if (size != signature[0])
            refuse();
        result.terminalKind7Words = {size, 7, r.u32()};
        if (result.terminalKind7Words[2] != signature[2])
            refuse();
        result.terminalKind7Range = r.range(chunk_start);
    };

    if (any) {
        std::array<bool, 11> seen{};
        while (r.at() != input.size()) {
            const auto chunk_start = r.at();
            const auto size = r.u32();
            const auto kind = r.u32();
            if (kind == 0 || kind > 10 || seen[kind])
                refuse();
            seen[kind] = true;
            switch (kind) {
            case 1:
            case 2:
                read_mesh_chunk(kind, chunk_start, size);
                break;
            case 3:
            case 8:
            case 10:
                read_empty_chunk(kind, chunk_start, size);
                break;
            case 5:
                read_materials(chunk_start, size);
                break;
            case 7:
                read_kind7(chunk_start, size);
                break;
            default:
                refuse();
            }
        }
        if (!seen[5] || result.meshes.empty())
            refuse();
        for (std::uint32_t kind = 1; kind <= 2; ++kind)
            if (!seen[kind])
                result.chunks[kind - 1] = {kind, 0, {}};
        for (const auto& mesh : result.meshes)
            if (mesh.textureIndex >= 0 &&
                static_cast<std::uint32_t>(mesh.textureIndex) >= result.materials.size())
                refuse();
    } else {
        for (std::uint32_t kind = 1; kind <= 2; ++kind) {
            // The reviewed 3.12 layout can omit either geometry chunk. Absent
            // chunks have an empty range at the next record; no bytes are skipped.
            if (version312 && r.peek_u32(4) != kind) {
                if (rider312)
                    refuse();
                result.chunks[kind - 1] = {kind, 0, r.range(r.at())};
                continue;
            }
            const auto chunk_start = r.at();
            const auto size = r.u32();
            (void)r.extent(chunk_start, size, 12);
            if (r.u32() != kind)
                refuse();
            read_mesh_chunk(kind, chunk_start, size);
        }
        if (version312 && result.meshes.empty())
            refuse();
        if (repeated_static_count312 &&
            (result.meshes.size() != 1 || result.meshes[0].chunkKind != 1 ||
             result.chunks[0].meshes != 1 || result.chunks[1].meshes != 0 ||
             result.chunks[1].range.bytes() != 16))
            refuse();
        constexpr std::array<std::uint32_t, 3> kinds{3, 8, 10};
        for (const auto kind : kinds) {
            start = r.at();
            const auto size = r.u32();
            if (r.u32() != kind)
                refuse();
            read_empty_chunk(kind, start, size);
        }
        const auto material_start = r.at();
        const auto material_size = r.u32();
        if (terminal_kind7 && input.size() < 12)
            refuse();
        if (r.u32() != 5)
            refuse();
        read_materials(material_start, material_size);
        if (terminal_kind7) {
            start = r.at();
            if (r.u32() != 12 || r.u32() != 7)
                refuse();
            read_kind7(start, 12);
        }
    }
    if (r.at() != input.size())
        refuse();
    for (const auto& mesh : result.meshes) {
        if (mesh.name != "symbol")
            continue;
        std::array<double, 3> sum{};
        for (std::size_t i = 0; i < mesh.positionBits.size(); ++i)
            sum[i % 3] += decoded(mesh.positionBits[i]);
        for (auto& axis : sum) {
            axis /= static_cast<double>(mesh.vertices);
            if (!std::isfinite(axis))
                refuse();
        }
        result.symbolAnchor = sum;
    }
    result.repeatedStaticCount312Profile = repeated_static_count312;
    const std::string_view marker = terminal_kind7    ? "openrtw-cas316-terminal-kind7-v1"
                                    : rider312        ? "openrtw-cas312-rider-repeated-count-v1"
                                    : empty_static305 ? "openrtw-cas305-empty-static-v1"
                                    : any             ? "openrtw-cas-static-any-v1"
                                                      : "";
    budget.charge(marker.size());
    result.admissionProfile = marker;
    result.sourceBytes.assign(input.begin(), input.end());
    return result;
}

CasStaticModel load_cas_static_model(std::span<const std::uint8_t> input) {
    return load_cas_static_model_impl(input, Profile::strict);
}

CasStaticModel load_cas_static_model_repeated_static_count312(std::span<const std::uint8_t> input) {
    return load_cas_static_model_impl(input, Profile::olive312);
}

CasStaticModel load_cas_static_model_terminal_kind7_316(std::span<const std::uint8_t> input) {
    return load_cas_static_model_impl(input, Profile::terminal_kind7_316);
}

CasStaticModel load_cas_static_model_rider_repeated_count312(std::span<const std::uint8_t> input) {
    return load_cas_static_model_impl(input, Profile::rider312);
}

CasStaticModel load_cas_static_model_empty_static305(std::span<const std::uint8_t> input) {
    return load_cas_static_model_impl(input, Profile::empty_static305);
}

CasStaticModel load_cas_static_model_any(std::span<const std::uint8_t> input) {
    return load_cas_static_model_impl(input, Profile::any);
}

} // namespace openrtw
