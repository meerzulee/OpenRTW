#pragma once

#include "cas_mesh.hpp"

#include <array>
#include <cstdint>
#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace openrtw {

struct CampaignShadowMesh {
    std::string_view name;
    std::span<const float> positions; // raw CAS XYZ, mesh/bone metadata NOT applied
    std::span<const std::uint16_t> indices;
};

struct CampaignShadowVolume {
    std::vector<std::array<float, 3>> positions;
    std::vector<std::uint16_t> indices;
    std::array<float, 3> lightDirection{}, extrusion{}, minimum{}, maximum{};
    float extrusionDistance = 0;
    std::uint32_t sourceVertices = 0, weldedVertices = 0, sourceTriangles = 0;
    std::uint32_t retainedTriangles = 0, facingTriangles = 0, silhouetteEdges = 0;
    std::uint32_t chains = 0, openChains = 0;
    std::uint16_t yaw = 0;
};

inline constexpr std::uint32_t campaign_shadow_max_source_vertices = 8192;
inline constexpr std::uint32_t campaign_shadow_max_source_triangles = 32768;
inline constexpr std::uint32_t campaign_shadow_max_output_vertices = 59999;
inline constexpr std::uint32_t campaign_shadow_max_output_indices = 599997;
inline constexpr std::uint32_t campaign_shadow_max_work = 64 * 1024 * 1024;

bool campaign_shadow_mesh_casts(std::string_view name) noexcept;
std::uint32_t campaign_shadow_mode_for_role(std::string_view role);
std::uint32_t campaign_shadow_variant(std::uint32_t mode, std::uint16_t yaw);

CampaignShadowVolume build_campaign_shadow_volume(std::span<const CampaignShadowMesh> meshes,
                                                  std::array<float, 3> diffuseDirection,
                                                  std::uint16_t yaw = 0);
// Source join for the existing general CAS reader. Static rigid chunk 1 only,
// one root bone with zero bind translation and no animation channels; otherwise
// refuse instead of claiming standing-pose/animation fidelity. Raw positions.
CampaignShadowVolume build_campaign_shadow_volume(const CasStaticModel& model,
                                                  std::array<float, 3> diffuseDirection,
                                                  std::uint16_t yaw = 0);

// Portable wire payload consumed by campaign-shadows.js. Only generated geometry
// and diagnostics; no game asset bytes, paths, textures or scene visibility.
std::string campaign_shadow_volume_json(const CampaignShadowVolume& volume);

} // namespace openrtw
