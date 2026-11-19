#include "campaign_shadows.hpp"

#include <algorithm>
#include <bit>
#include <charconv>
#include <cmath>
#include <stdexcept>

namespace openrtw {
namespace {
using Point = std::array<float, 3>;
using Triangle = std::array<std::uint16_t, 3>;
using Edge = std::array<std::uint16_t, 2>;
constexpr float coordinateLimit = 1e6f;
[[noreturn]] void refuse(const char* message) {
    throw std::runtime_error(std::string("Campaign shadows: ") + message);
}
void finite(float value) {
    if (!std::isfinite(value) || std::abs(value) > coordinateLimit)
        refuse("non-finite or out-of-bounds coordinate");
}
Point rotate(Point p, std::uint16_t yaw) {
    switch (yaw) {
    case 0:
        return p;
    case 16384:
        return {p[2], p[1], -p[0]};
    case 32768:
        return {-p[0], p[1], -p[2]};
    case 49152:
        return {-p[2], p[1], p[0]};
    default:
        refuse("only cardinal pre-rotated variants are supported");
    }
}
Point subtract(Point a, Point b) {
    return {a[0] - b[0], a[1] - b[1], a[2] - b[2]};
}
Point cross(Point a, Point b) {
    return {a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]};
}
float dot(Point a, Point b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
void spend(std::uint32_t& work) {
    if (work == 0)
        refuse("geometry work budget exceeded");
    --work;
}
void cancel_edge(std::vector<Edge>& edges, Edge edge, std::uint32_t& work) {
    bool append = true;
    for (std::size_t i = edges.size(); i-- > 0;) {
        spend(work);
        if (edges[i] == edge || (edges[i][0] == edge[1] && edges[i][1] == edge[0])) {
            append = false;
            edges[i] = edges.back();
            edges.pop_back();
        }
    }
    if (append)
        edges.push_back(edge);
}
Edge take(std::vector<Edge>& edges, std::size_t index) {
    const auto result = edges[index];
    edges[index] = edges.back();
    edges.pop_back();
    return result;
}
template <class T> void number(std::string& out, T value) {
    char buffer[64];
    const auto result = std::to_chars(buffer, buffer + sizeof(buffer), value);
    if (result.ec != std::errc())
        refuse("number serialization failed");
    out.append(buffer, result.ptr);
}
void point_json(std::string& out, const Point& point) {
    out.push_back('[');
    for (unsigned i = 0; i < 3; ++i) {
        finite(point[i]);
        if (i)
            out.push_back(',');
        number(out, point[i]);
    }
    out.push_back(']');
}
} // namespace

bool campaign_shadow_mesh_casts(std::string_view name) noexcept {
    return name != "symbol";
}

std::uint32_t campaign_shadow_mode_for_role(std::string_view role) {
    if (role == "banner")
        return 0;
    if (role == "buildings" || role == "wall" || role == "fort" || role == "fort_wall" ||
        role == "watchtower" || role == "siege" || role == "blockade")
        return 1;
    if (role == "land" || role == "sea")
        return 3;
    refuse("unrecognized settlement scene role");
}

std::uint32_t campaign_shadow_variant(std::uint32_t mode, std::uint16_t yaw) {
    if (mode == 1)
        return 0;
    if (mode != 3)
        refuse("only shadow modes 1 and 3 are supported");
    return std::min(3u, static_cast<unsigned>(std::nearbyint(static_cast<float>(yaw) / 16384)));
}

CampaignShadowVolume build_campaign_shadow_volume(std::span<const CampaignShadowMesh> meshes,
                                                  Point direction, std::uint16_t yaw) {
    CampaignShadowVolume result;
    result.yaw = yaw;
    rotate({}, yaw); // validate even for empty inputs
    for (const float v : direction)
        finite(v);
    const auto lightLength = std::sqrt(dot(direction, direction));
    if (!(lightLength > 1e-6f))
        refuse("degenerate light direction");
    for (auto& v : direction)
        v /= lightLength;
    const auto horizontal = std::hypot(direction[0], direction[2]);
    if (direction[1] >= -1e-6f || horizontal <= 1e-6f)
        refuse("unsupported horizontal, upward or vertical light");
    result.lightDirection = direction;
    if (meshes.size() > cas_max_meshes)
        refuse("mesh budget exceeded");
    std::vector<Point> vertices;
    std::vector<Triangle> triangles;
    std::uint32_t work = campaign_shadow_max_work;
    for (const auto& mesh : meshes) {
        if (!campaign_shadow_mesh_casts(mesh.name))
            continue;
        if (mesh.positions.size() % 3 || mesh.indices.size() % 3)
            refuse("invalid geometry extent");
        const auto count = mesh.positions.size() / 3;
        if (count > campaign_shadow_max_source_vertices - vertices.size() ||
            mesh.indices.size() / 3 > campaign_shadow_max_source_triangles - triangles.size())
            refuse("source geometry budget exceeded");
        const auto base = vertices.size();
        for (std::size_t i = 0; i < count; ++i) {
            Point p{mesh.positions[3 * i], mesh.positions[3 * i + 1], mesh.positions[3 * i + 2]};
            for (const float v : p)
                finite(v);
            vertices.push_back(rotate(p, yaw));
        }
        for (std::size_t i = 0; i < mesh.indices.size(); i += 3) {
            Triangle tri{};
            for (unsigned k = 0; k < 3; ++k) {
                if (mesh.indices[i + k] >= count)
                    refuse("triangle index outside mesh");
                tri[k] = static_cast<std::uint16_t>(base + mesh.indices[i + k]);
            }
            triangles.push_back(tri);
        }
    }
    result.sourceVertices = static_cast<unsigned>(vertices.size());
    result.sourceTriangles = static_cast<unsigned>(triangles.size());
    for (std::size_t i = 0; i < vertices.size(); ++i)
        for (std::size_t j = i + 1; j < vertices.size(); ++j) {
            spend(work);
            const auto delta = subtract(vertices[i], vertices[j]);
            if (std::abs(delta[0]) < 0.0001f && std::abs(delta[1]) < 0.0001f &&
                std::abs(delta[2]) < 0.0001f) {
                for (auto& tri : triangles) {
                    spend(work);
                    for (auto& index : tri) {
                        if (index == j)
                            index = static_cast<std::uint16_t>(i);
                        if (index > j)
                            --index;
                    }
                }
                vertices.erase(vertices.begin() + static_cast<std::ptrdiff_t>(j));
            }
        }
    result.weldedVertices = static_cast<unsigned>(vertices.size());
    for (std::size_t i = triangles.size(); i-- > 0;)
        if (triangles[i][0] == triangles[i][1] || triangles[i][0] == triangles[i][2] ||
            triangles[i][1] == triangles[i][2]) {
            triangles[i] = triangles.back();
            triangles.pop_back();
        }
    result.retainedTriangles = static_cast<unsigned>(triangles.size());
    if (vertices.empty())
        return result;
    auto minimum = vertices.front(), maximum = vertices.front();
    for (const auto& p : vertices)
        for (unsigned k = 0; k < 3; ++k) {
            minimum[k] = std::min(minimum[k], p[k]);
            maximum[k] = std::max(maximum[k], p[k]);
        }
    const auto height = maximum[1] - minimum[1];
    if (height == 0)
        return result; // OpenRTW policy: native would produce coincident side walls
    result.extrusionDistance = height / -(direction[1] / horizontal) * 1.5f;
    finite(result.extrusionDistance);
    for (unsigned k = 0; k < 3; ++k)
        result.extrusion[k] = direction[k] * result.extrusionDistance;
    std::vector<Edge> edges;
    for (const auto& tri : triangles) {
        auto n = cross(subtract(vertices[tri[1]], vertices[tri[0]]),
                       subtract(vertices[tri[2]], vertices[tri[0]]));
        const auto length = std::sqrt(dot(n, n));
        if (length > 0)
            for (auto& v : n)
                v /= length;
        if (dot(n, direction) < 0) {
            ++result.facingTriangles;
            cancel_edge(edges, {tri[0], tri[1]}, work);
            cancel_edge(edges, {tri[1], tri[2]}, work);
            cancel_edge(edges, {tri[2], tri[0]}, work);
        }
    }
    result.silhouetteEdges = static_cast<unsigned>(edges.size());
    while (!edges.empty()) {
        std::vector<Edge> chain{take(edges, 0)};
        for (;;) {
            const auto next = std::find_if(edges.begin(), edges.end(), [&](Edge edge) {
                spend(work);
                return edge[0] == chain.back()[1];
            });
            if (next == edges.end())
                break;
            chain.push_back(take(edges, static_cast<std::size_t>(next - edges.begin())));
        }
        ++result.chains;
        if (chain.front()[0] != chain.back()[1])
            ++result.openChains;
        const auto vertexCount = 2 * chain.size() + 2, indexCount = 6 * chain.size();
        if (vertexCount > campaign_shadow_max_output_vertices - result.positions.size() ||
            indexCount > campaign_shadow_max_output_indices - result.indices.size())
            refuse("volume geometry budget exceeded");
        const auto base = result.positions.size();
        const auto pair = [&](std::uint16_t index) {
            const auto near = vertices[index];
            Point far{};
            for (unsigned k = 0; k < 3; ++k) {
                far[k] = near[k] + result.extrusion[k];
                finite(far[k]);
            }
            result.positions.push_back(near);
            result.positions.push_back(far);
        };
        for (const auto edge : chain)
            pair(edge[0]);
        pair(chain.back()[1]);
        for (std::size_t n = 0; n < chain.size(); ++n)
            for (const auto index : {2u, 0u, 3u, 0u, 1u, 3u})
                result.indices.push_back(static_cast<std::uint16_t>(base + 2 * n + index));
    }
    if (!result.positions.empty()) {
        result.minimum = result.maximum = result.positions.front();
        for (const auto& p : result.positions)
            for (unsigned k = 0; k < 3; ++k) {
                result.minimum[k] = std::min(result.minimum[k], p[k]);
                result.maximum[k] = std::max(result.maximum[k], p[k]);
            }
    }
    return result;
}

CampaignShadowVolume build_campaign_shadow_volume(const CasStaticModel& model, Point direction,
                                                  std::uint16_t yaw) {
    if (model.meshes.size() > cas_max_meshes)
        refuse("CAS mesh budget exceeded");
    if (model.bones.size() != 1 || model.bones[0].rotationKeys || model.bones[0].translationKeys)
        refuse("static one-root CAS required");
    for (const auto bits : model.bones[0].bindLocalBits)
        if (std::bit_cast<float>(bits) != 0)
            refuse("nonzero root bind translation");
    std::vector<std::vector<float>> positions;
    std::vector<CampaignShadowMesh> meshes;
    std::size_t totalVertices = 0, totalTriangles = 0;
    positions.reserve(model.meshes.size());
    meshes.reserve(model.meshes.size());
    for (const auto& mesh : model.meshes) {
        if (!campaign_shadow_mesh_casts(mesh.name))
            continue;
        if (mesh.chunkKind != 1 || mesh.positionBits.size() != 3 * std::size_t(mesh.vertices) ||
            mesh.indices.size() != 3 * std::size_t(mesh.triangles))
            refuse("unsupported CAS mesh or inconsistent geometry counts");
        if (mesh.vertices > campaign_shadow_max_source_vertices - totalVertices ||
            mesh.triangles > campaign_shadow_max_source_triangles - totalTriangles)
            refuse("CAS geometry budget exceeded");
        totalVertices += mesh.vertices;
        totalTriangles += mesh.triangles;
        auto& points = positions.emplace_back();
        points.reserve(mesh.positionBits.size());
        for (const auto bits : mesh.positionBits)
            points.push_back(std::bit_cast<float>(bits));
        meshes.push_back({mesh.name, points, mesh.indices});
    }
    return build_campaign_shadow_volume(meshes, direction, yaw);
}

std::string campaign_shadow_volume_json(const CampaignShadowVolume& volume) {
    if (volume.positions.size() > campaign_shadow_max_output_vertices ||
        volume.indices.size() > campaign_shadow_max_output_indices || volume.indices.size() % 3)
        refuse("invalid volume publication extent");
    std::string out = "{\"schema\":\"openrtw-campaign-shadow-volume-v1\",\"yaw\":";
    number(out, volume.yaw);
    out += ",\"positions\":[";
    bool first = true;
    for (const auto& p : volume.positions) {
        if (!first)
            out.push_back(',');
        first = false;
        point_json(out, p);
    }
    out += "],\"indices\":[";
    first = true;
    for (const auto index : volume.indices) {
        if (index >= volume.positions.size())
            refuse("invalid volume publication index");
        if (!first)
            out.push_back(',');
        first = false;
        number(out, index);
    }
    out += "],\"extrusion\":";
    point_json(out, volume.extrusion);
    out += ",\"minimum\":";
    point_json(out, volume.minimum);
    out += ",\"maximum\":";
    point_json(out, volume.maximum);
    out += "}";
    return out;
}

} // namespace openrtw
