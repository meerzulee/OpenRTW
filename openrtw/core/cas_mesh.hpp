#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <span>
#include <string>
#include <vector>

namespace openrtw {

// New admission/retained-payload budgets for the reviewed CAS3.05/3.12/3.16 subsets.
inline constexpr std::size_t cas_max_input_bytes = 1024 * 1024;
inline constexpr std::uint32_t cas_max_bones = 128, cas_max_frames = 4096;
inline constexpr std::uint32_t cas_max_channel_keys = 32768;
inline constexpr std::uint32_t cas_max_meshes = 64, cas_max_vertices = 16384;
inline constexpr std::uint32_t cas_max_triangles = 32768;
inline constexpr std::uint32_t cas_max_bone_extra_bytes = 256;
inline constexpr std::uint32_t cas_max_mesh_extra_bytes = 256;
inline constexpr std::size_t cas_max_owned_bytes = 8 * 1024 * 1024;
inline constexpr std::uint32_t cas_max_materials = 64, cas_max_mesh_flag_ids = 64;

struct CasByteRange {
    std::uint32_t start = 0, endExclusive = 0;
    std::uint32_t bytes() const noexcept { return endExclusive - start; }
};

struct CasBone {
    std::uint32_t id = 0, parent = 0;
    std::string name;
    std::uint32_t rotationKeys = 0, translationKeys = 0;
    std::uint32_t rotationOffset = 0, translationOffset = 0;
    CasByteRange headerRange, extra316Range;
    std::vector<std::uint8_t> extra316Bytes;
    std::array<std::uint8_t, 4> flagBytes{};
    std::array<std::uint32_t, 3> bindLocalBits{};
    // Candidate parent-translation accumulation only, ordinary binary64 sums.
    std::array<double, 3> candidateBindWorld{};
};

struct CasMeshPart {
    std::string name;
    std::uint32_t chunkKind = 0;
    std::optional<std::uint32_t> attachedBone;
    std::uint32_t vertices = 0, triangles = 0;
    std::int32_t textureIndex = 0;
    std::uint8_t uvFlag = 1;
    std::uint32_t vertexColorFlag = 0;
    CasByteRange colorRange;
    // Raw source RGBA bytes, four per vertex when flag1 (3.12/3.16).
    std::vector<std::uint8_t> vertexColorBytes;
    std::array<std::uint32_t, 7> metadataBits{};
    std::vector<std::uint8_t> extra1, extra2;
    CasByteRange extra1Range, extra2Range;
    CasByteRange recordRange, assignmentRange, positionRange, normalRange, indexRange, uvRange;
    // Raw finite F32 words, flat XYZ/XYZ/UV arrays; original axes/UV/winding.
    std::vector<std::uint32_t> positionBits, normalBits, uvBits, boneIndices;
    std::vector<std::uint16_t> indices;
    // Flat XYZ binary64 values: F32(local) + candidateBindWorld[bone].
    // No additional F32 narrowing, animation, bone rotation or skin weighting.
    std::vector<double> candidateBindPositions;
    std::uint8_t endFlagMask = 0;
    std::vector<std::uint32_t> endFlagIds;
    CasByteRange endRange;
};

struct CasChunk {
    std::uint32_t kind = 0, meshes = 0;
    CasByteRange range;
};

struct CasMaterial {
    CasByteRange range, nameRange;
    std::string textureName;
    std::array<std::uint32_t, 7> rawBits{};
    // Fixed-width payload, with unknown material meaning; zero-only for3.05.
    std::array<std::uint8_t, 28> opaqueTailBytes{};
    CasByteRange opaqueTailRange;
    std::uint8_t lastByte = 0;
};

struct CasStaticModel {
    // Exact owned input, including uninterpreted34-byte header extension,
    // raw channel values and all checked trailers. No hash is baked into core.
    std::vector<std::uint8_t> sourceBytes;
    std::uint32_t versionBits = 0, headerLength = 0, frameCount = 0;
    std::uint32_t rotationKeyCount = 0, translationKeyCount = 0;
    std::uint32_t totalVertices = 0, totalTriangles = 0;
    CasByteRange headerRange, animationRange, parentsRange, frameTimeRange;
    CasByteRange boneHeadersRange, rotationRange, translationRange, bindRange;
    std::vector<std::uint32_t> frameTimeBits;
    std::vector<CasBone> bones;
    std::array<CasChunk, 2> chunks{};
    std::vector<CasMeshPart> meshes;
    std::array<CasChunk, 3> opaqueChunks{};
    // First material; its `range` spans the whole chunk 5 (legacy publication).
    CasMaterial material;
    std::vector<CasMaterial> materials;
    // Explicit opt-in profile only; the default town/3.05/3.16 reader remains
    // unchanged. This records admission policy, not native asset semantics.
    bool repeatedStaticCount312Profile = false;
    // Fixed admission-policy literal for the three newer explicit profiles;
    // empty for both existing entries so their publications stay unchanged.
    std::string admissionProfile;
    CasByteRange terminalKind7Range;
    std::array<std::uint32_t, 3> terminalKind7Words{};
    std::array<std::uint32_t, 2> chunkTrailerWords{};
    std::optional<std::array<double, 3>> symbolAnchor;
};

float cas_version_value(std::uint32_t versionBits) noexcept;

// Bounded static candidate reconstructed from the retained selected parser,
// not an original parser/native renderer/battle equivalence claim. Admits
// versions raw40433333 (3.05)/4047AE14 (3.12)/404A3D71 (3.16), header-length38; finite
// ordered parent hierarchy;
// monotonic times and packed finite channel/rest arrays; exactly geometry
// chunks1 then2 (optional ordered chunks and empty type2 allowed for3.12);
// UV1/color0 for3.05, UV1/color0or1 for3.12/3.16; raw RGBA
// bytes follow UVs when color1. One explicit bone per type2 vertex, type1 attached
// bone, valid U16 triangle indices; one-zero-byte extra strings/mesh markers;
// checked chunk counts/extents/trailers (six zero static trailer bytes for3.12);
// zero footers3/8/10; final one-material
// chunk5 with indices0, finite seven words/28 raw bytes/lastByte1 (3.05
// requires that fixed tail to be zero). 3.16 bone headers have an additional
// u32 length plus opaque payload, at most256bytes; its meaning is unknown. Channel
// offsets must match contiguous packed rotation/translation metadata. Names
// are nonempty ASCII with at most255 bytes, length includes terminal NUL for
// bone/mesh names. Uninterpreted header extension is retained, not decoded.
// Every extent/count is checked before allocation/read; budgets above limit
// total meshes/vertices/triangles/channel keys and owned payload. All raw and
// derived numbers must be finite; parent/world sums use binary64 candidate
// arithmetic only. Full validation/allocation completes before return, input
// never changes and no borrowed pointer escapes. Unsupported layouts throw
// runtime_error; allocation failures propagate without partial publication.
CasStaticModel load_cas_static_model(std::span<const std::uint8_t> input);

// Narrow explicit 3.12 exporter candidate observed in the retained campaign
// olive: one root bone, no channel keys, one type1 rigid color1 mesh, followed
// by an explicit empty16-byte type2 chunk. The type1 trailer must be WORD0 +
// DWORD1 (its repeated mesh count), rather than the default town WORD0+DWORD0.
// Everything else uses the same finite arrays, ownership/resource bounds,
// materials, ordered zero footers and exact EOF checks above. Other versions,
// other structures, default town zero trailers and implicit/automatic retries
// refuse. Successful results set repeatedStaticCount312Profile=true. No tree
// identity, original loader/renderer, alpha, scale or placement is inferred.
CasStaticModel load_cas_static_model_repeated_static_count312(std::span<const std::uint8_t> input);

// Separate reviewed structural subsets. These never run as default retries.
// All existing finite-array, hierarchy, extent, ownership and resource bounds
// remain in force; frame counts retain their existing bounded variation.
// 3.16:20 bones,3 rigid+2 assigned color1 meshes; only the last assigned
// mesh has a31-byte opaque extra1. Material ends before exact12-byte raw
// signature[12,7,0], whose native meaning remains unknown.
CasStaticModel load_cas_static_model_terminal_kind7_316(std::span<const std::uint8_t> input);
// 3.12:20 bones,3 rigid+1 assigned color1 meshes, rigid WORD0+DWORD3.
CasStaticModel load_cas_static_model_rider_repeated_count312(std::span<const std::uint8_t> input);
// 3.05:21 bones, no channels, explicit empty18-byte rigid chunk and one
// assigned color0 mesh with31-byte opaque extra1;28-byte material tail is
// retained opaquely. No mounted composition, scale or pose is inferred.
CasStaticModel load_cas_static_model_empty_static305(std::span<const std::uint8_t> input);

CasStaticModel load_cas_static_model_any(std::span<const std::uint8_t> input);

} // namespace openrtw
