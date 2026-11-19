#include "terrain.hpp"
#include "campaign.hpp"
#include "regions.hpp"
#include "world_grid.hpp"
#include "categories.hpp"
#include "climates.hpp"
#include "campaign_session.hpp"
#include "campaign_json.hpp"
#include "campaign_save_file.hpp"
#include <SDL.h>
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iomanip>
#include <limits>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <type_traits>
#include <utility>
#include <vector>

namespace {
std::vector<std::uint8_t> read_file(const std::string& path) {
    std::ifstream file(path, std::ios::binary | std::ios::ate);
    if (!file)
        throw std::runtime_error("Cannot read terrain file: " + path);
    const auto size = file.tellg();
    if (size < 0 || size > 64 * 1024 * 1024)
        throw std::runtime_error("Terrain file exceeds viewer input bound");
    std::vector<std::uint8_t> bytes(static_cast<std::size_t>(size));
    file.seekg(0);
    if (!file.read(reinterpret_cast<char*>(bytes.data()), size))
        throw std::runtime_error("Incomplete terrain read");
    return bytes;
}

// New preview colors, not a reconstruction of Rome's terrain shader.
std::uint32_t preview_color(float h) {
    if (h < 0) {
        const float deep = std::clamp(-h / 1400.f, 0.f, 1.f);
        return 0xff000000u | (std::uint32_t(30 - 15 * deep) << 16) |
               (std::uint32_t(100 - 55 * deep) << 8) | std::uint32_t(155 - 50 * deep);
    }
    const float t = std::clamp(h / 6500.f, 0.f, 1.f);
    return 0xff000000u | (std::uint32_t(76 + 165 * t) << 16) | (std::uint32_t(143 + 80 * t) << 8) |
           std::uint32_t(70 + 155 * t);
}

struct Video {
    SDL_Window* window = nullptr;
    SDL_Renderer* renderer = nullptr;
    SDL_Texture* texture = nullptr;
    SDL_Texture* regions = nullptr;
    SDL_Texture* world = nullptr;
    ~Video() {
        if (world)
            SDL_DestroyTexture(world);
        if (regions)
            SDL_DestroyTexture(regions);
        if (texture)
            SDL_DestroyTexture(texture);
        if (renderer)
            SDL_DestroyRenderer(renderer);
        if (window)
            SDL_DestroyWindow(window);
        SDL_Quit();
    }
};

void capture(SDL_Renderer* renderer, const std::string& path) {
    int width = 0, height = 0;
    if (SDL_GetRendererOutputSize(renderer, &width, &height) != 0 || width <= 0 || height <= 0)
        throw std::runtime_error(SDL_GetError());
    std::vector<std::uint8_t> rgb(std::size_t(width) * height * 3);
    if (SDL_RenderReadPixels(renderer, nullptr, SDL_PIXELFORMAT_RGB24, rgb.data(), width * 3) != 0)
        throw std::runtime_error(SDL_GetError());
    std::unique_ptr<std::FILE, decltype(&std::fclose)> out(std::fopen(path.c_str(), "wbx"),
                                                           &std::fclose);
    if (!out)
        throw std::runtime_error("Capture output must be a fresh writable file");
    if (std::fprintf(out.get(), "P6\n%d %d\n255\n", width, height) < 0 ||
        std::fwrite(rgb.data(), 1, rgb.size(), out.get()) != rgb.size() ||
        std::fflush(out.get()) != 0)
        throw std::runtime_error("Incomplete preview capture");
    if (std::fclose(out.release()) != 0)
        throw std::runtime_error("Preview capture close failed");
}

bool within(const std::filesystem::path& child, const std::filesystem::path& root) {
    auto i = child.begin();
    for (const auto& part : root) {
        if (i == child.end() || *i != part)
            return false;
        ++i;
    }
    return true;
}

// This adapter presents the explicit OpenRTW prototype. All actor positions,
// AP, calendar, route search and save validation remain in CampaignSession.
using Session = openrtw::CampaignSession;
using RouteStatus = openrtw::CampaignRouteStatus;
using CommandStatus = openrtw::CampaignCommandStatus;

std::string_view route_name(RouteStatus status) {
    switch (status) {
    case RouteStatus::Ok:
        return "ok";
    case RouteStatus::StaleRevision:
        return "stale_revision";
    case RouteStatus::InvalidActor:
        return "invalid_actor";
    case RouteStatus::OutOfBounds:
        return "out_of_bounds";
    case RouteStatus::NoOp:
        return "no_op";
    case RouteStatus::WorldTooLarge:
        return "world_too_large";
    case RouteStatus::Occupied:
        return "occupied";
    case RouteStatus::Unreachable:
        return "unreachable";
    case RouteStatus::InsufficientAp:
        return "insufficient_ap";
    case RouteStatus::RevisionOverflow:
        return "revision_overflow";
    case RouteStatus::StaleOrderRevision:
        return "stale_order_revision";
    case RouteStatus::NoDestination:
        return "no_destination";
    case RouteStatus::FogRefused:
        return "fog_refused";
    }
    return "unknown";
}
std::string_view command_name(CommandStatus status) {
    switch (status) {
    case CommandStatus::Applied:
        return "applied";
    case CommandStatus::StaleRevision:
        return "stale_revision";
    case CommandStatus::InvalidActor:
        return "invalid_actor";
    case CommandStatus::OutOfBounds:
        return "out_of_bounds";
    case CommandStatus::NoOp:
        return "no_op";
    case CommandStatus::NotAdjacent:
        return "not_adjacent";
    case CommandStatus::NoAp:
        return "no_ap";
    case CommandStatus::Occupied:
        return "occupied";
    case CommandStatus::RevisionOverflow:
        return "revision_overflow";
    case CommandStatus::TurnOverflow:
        return "turn_overflow";
    case CommandStatus::YearOverflow:
        return "year_overflow";
    case CommandStatus::StaleOrderRevision:
        return "stale_order_revision";
    case CommandStatus::FogRefused:
        return "fog_refused";
    }
    return "unknown";
}

// A tiny source-owned 5x7 alphabet keeps this SDL-only view independent of a
// font package. Unsupported source bytes are displayed as explicit hex escapes.
std::array<std::uint8_t, 7> glyph(char c) {
    if (c >= 'a' && c <= 'z')
        c = static_cast<char>(c - 'a' + 'A');
    switch (c) {
    case 'A':
        return {14, 17, 17, 31, 17, 17, 17};
    case 'B':
        return {30, 17, 17, 30, 17, 17, 30};
    case 'C':
        return {14, 17, 16, 16, 16, 17, 14};
    case 'D':
        return {30, 17, 17, 17, 17, 17, 30};
    case 'E':
        return {31, 16, 16, 30, 16, 16, 31};
    case 'F':
        return {31, 16, 16, 30, 16, 16, 16};
    case 'G':
        return {14, 17, 16, 23, 17, 17, 15};
    case 'H':
        return {17, 17, 17, 31, 17, 17, 17};
    case 'I':
        return {14, 4, 4, 4, 4, 4, 14};
    case 'J':
        return {7, 2, 2, 2, 18, 18, 12};
    case 'K':
        return {17, 18, 20, 24, 20, 18, 17};
    case 'L':
        return {16, 16, 16, 16, 16, 16, 31};
    case 'M':
        return {17, 27, 21, 21, 17, 17, 17};
    case 'N':
        return {17, 25, 21, 19, 17, 17, 17};
    case 'O':
        return {14, 17, 17, 17, 17, 17, 14};
    case 'P':
        return {30, 17, 17, 30, 16, 16, 16};
    case 'Q':
        return {14, 17, 17, 17, 21, 18, 13};
    case 'R':
        return {30, 17, 17, 30, 20, 18, 17};
    case 'S':
        return {15, 16, 16, 14, 1, 1, 30};
    case 'T':
        return {31, 4, 4, 4, 4, 4, 4};
    case 'U':
        return {17, 17, 17, 17, 17, 17, 14};
    case 'V':
        return {17, 17, 17, 17, 17, 10, 4};
    case 'W':
        return {17, 17, 17, 21, 21, 21, 10};
    case 'X':
        return {17, 17, 10, 4, 10, 17, 17};
    case 'Y':
        return {17, 17, 10, 4, 4, 4, 4};
    case 'Z':
        return {31, 1, 2, 4, 8, 16, 31};
    case '0':
        return {14, 17, 19, 21, 25, 17, 14};
    case '1':
        return {4, 12, 4, 4, 4, 4, 14};
    case '2':
        return {14, 17, 1, 2, 4, 8, 31};
    case '3':
        return {30, 1, 1, 14, 1, 1, 30};
    case '4':
        return {2, 6, 10, 18, 31, 2, 2};
    case '5':
        return {31, 16, 16, 30, 1, 1, 30};
    case '6':
        return {14, 16, 16, 30, 17, 17, 14};
    case '7':
        return {31, 1, 2, 4, 8, 8, 8};
    case '8':
        return {14, 17, 17, 14, 17, 17, 14};
    case '9':
        return {14, 17, 17, 15, 1, 1, 14};
    case '.':
        return {0, 0, 0, 0, 0, 12, 12};
    case ',':
        return {0, 0, 0, 0, 0, 4, 8};
    case ':':
        return {0, 4, 4, 0, 4, 4, 0};
    case '-':
        return {0, 0, 0, 31, 0, 0, 0};
    case '_':
        return {0, 0, 0, 0, 0, 0, 31};
    case '/':
        return {1, 2, 2, 4, 8, 8, 16};
    case '\\':
        return {16, 8, 8, 4, 2, 2, 1};
    case '+':
        return {0, 4, 4, 31, 4, 4, 0};
    case '(':
        return {2, 4, 8, 8, 8, 4, 2};
    case ')':
        return {8, 4, 2, 2, 2, 4, 8};
    case '[':
        return {14, 8, 8, 8, 8, 8, 14};
    case ']':
        return {14, 2, 2, 2, 2, 2, 14};
    case '=':
        return {0, 0, 31, 0, 31, 0, 0};
    case '!':
        return {4, 4, 4, 4, 4, 0, 4};
    case '?':
        return {14, 17, 1, 2, 4, 0, 4};
    case ' ':
        return {};
    default:
        return {31, 17, 5, 4, 4, 0, 4};
    }
}
std::string display_bytes(std::string_view bytes, std::size_t limit = 160) {
    constexpr char hex[] = "0123456789ABCDEF";
    std::string result;
    result.reserve(limit + 4);
    for (char raw : bytes) {
        const auto c = static_cast<unsigned char>(raw);
        const std::size_t count = (c >= 32 && c < 127) ? 1 : 4;
        if (result.size() + count > limit) {
            result += "...";
            break;
        }
        if (count == 1)
            result += raw;
        else {
            result += "\\x";
            result += hex[c >> 4];
            result += hex[c & 15];
        }
    }
    return result;
}
void draw_color(SDL_Renderer* renderer, Uint8 r, Uint8 g, Uint8 b) {
    if (SDL_SetRenderDrawColor(renderer, r, g, b, 255) != 0)
        throw std::runtime_error(SDL_GetError());
}
void fill(SDL_Renderer* renderer, const SDL_Rect& rect) {
    if (SDL_RenderFillRect(renderer, &rect) != 0)
        throw std::runtime_error(SDL_GetError());
}
void label(SDL_Renderer* renderer, int x, int y, std::string_view text, int scale = 2) {
    for (char c : text) {
        const auto rows = glyph(c);
        for (int row = 0; row < 7; ++row)
            for (int column = 0; column < 5; ++column)
                if (rows[static_cast<std::size_t>(row)] & (1u << (4 - column)))
                    fill(renderer, SDL_Rect{x + column * scale, y + row * scale, scale, scale});
        x += 6 * scale;
    }
}
int paragraph(SDL_Renderer* renderer, int x, int y, std::string_view text, int columns, int lines) {
    for (int line = 0; line < lines && !text.empty(); ++line) {
        const auto count = std::min(text.size(), static_cast<std::size_t>(columns));
        label(renderer, x, y, text.substr(0, count));
        text.remove_prefix(count);
        y += 20;
    }
    return y;
}

struct Panel {
    std::string clock, name, faction, type, position, ap;
};
static_assert(std::is_nothrow_move_assignable_v<Panel>);
Panel make_panel(const Session& session, std::optional<std::uint32_t> selected) {
    Panel value;
    const auto year = static_cast<std::int64_t>(session.year());
    value.clock = "Turn " + std::to_string(session.turn()) + " " +
                  (session.season() == openrtw::Season::summer ? "summer " : "winter ") +
                  std::to_string(year < 0 ? -year : year) + (year < 0 ? " BC" : " AD");
    if (selected) {
        const auto& actor = session.actors().at(*selected);
        const auto& faction = session.source().factions.at(actor.sourceFactionIndex);
        const auto& source = faction.characters.at(actor.sourceCharacterIndex);
        value.name = display_bytes(source.name, 80);
        value.faction = display_bytes(faction.id, 80);
        value.type = display_bytes(source.type, 40);
        value.position =
            "Position " + std::to_string(actor.currentX) + ", " + std::to_string(actor.currentY);
        value.ap = "AP " + std::to_string(actor.ap) + " / " + std::to_string(actor.maxAp);
    } else
        value.name = "Select a character";
    return value;
}

// Opt-in observations are projections of the current owned session, never
// command inputs. Truncation disables only tracing; an I/O/JSON failure is fatal
// observation failure and cannot turn an already accepted command into refusal.
struct TraceLimit {};
class TraceRecord {
public:
    void append(std::string_view value) {
        if (value.size() > 16 * 1024 - size_)
            throw TraceLimit{};
        out_.append(value);
        size_ += value.size();
    }
    template <class Integer> void integer(Integer value) {
        std::array<char, 32> text{};
        const auto result = std::to_chars(text.data(), text.data() + text.size(), value);
        if (result.ec != std::errc{})
            throw std::runtime_error("Trace integer encoding failed");
        append({text.data(), static_cast<std::size_t>(result.ptr - text.data())});
    }
    void string(std::string_view value) {
        constexpr char hex[] = "0123456789abcdef";
        append("\"");
        for (char raw : value) {
            const auto c = static_cast<unsigned char>(raw);
            if (c == '"')
                append("\\\"");
            else if (c == '\\')
                append("\\\\");
            else if (c < 0x20 || c >= 0x7f) {
                const std::array<char, 6> escaped{'\\', 'u', '0', '0', hex[c >> 4], hex[c & 15]};
                append({escaped.data(), escaped.size()});
            } else
                append({&raw, 1});
        }
        append("\"");
    }
    std::string finish() && { return std::move(out_).finish(); }

private:
    openrtw::detail::Json out_;
    std::size_t size_ = 0;
};
class CampaignTrace {
public:
    explicit CampaignTrace(bool enabled) : enabled_(enabled) {}
    void initial(const Session& session) {
        if (!enabled_)
            return;
        try {
            TraceRecord out;
            out.append("{\"kind\":\"campaign-source\",\"profile\":\"openrtw-cardinal-prototype-"
                       "v2\",\"actors\":[");
            bool first = true;
            for (const auto& actor : session.actors()) {
                const auto& faction = session.source().factions.at(actor.sourceFactionIndex);
                const auto& character = faction.characters.at(actor.sourceCharacterIndex);
                if (!first)
                    out.append(",");
                first = false;
                out.append("[");
                out.integer(actor.id);
                out.append(",");
                out.string(character.name);
                out.append(",");
                out.string(faction.id);
                out.append(",");
                out.integer(actor.sourceFactionIndex);
                out.append(",");
                out.integer(actor.sourceCharacterIndex);
                out.append("]");
            }
            out.append("]}");
            emit(std::move(out).finish());
        } catch (const TraceLimit&) {
            truncate();
        } catch (const std::exception& e) {
            throw std::runtime_error("Fatal campaign observation failure: " +
                                     display_bytes(e.what()));
        }
    }
    void action(std::string_view action, std::string_view result, const Session& session,
                std::uint32_t generation, std::optional<std::uint32_t> selected,
                const std::optional<openrtw::CampaignRoutePoint>& target,
                const std::optional<openrtw::CampaignRoutePreview>& route,
                const std::optional<std::array<int, 9>>& geometry,
                std::uint32_t previewOrderRevision, bool canContinue, bool canCancel,
                bool savedCurrent) {
        if (!enabled_)
            return;
        try {
            TraceRecord out;
            out.append("{\"kind\":\"campaign-action\",\"action\":");
            out.string(action);
            out.append(",\"result\":");
            out.string(result);
            out.append(",\"generation\":");
            out.integer(generation);
            out.append(",\"revision\":");
            out.integer(session.revision());
            out.append(",\"orderRevision\":");
            out.integer(session.order_revision());
            out.append(",\"turn\":");
            out.integer(session.turn());
            out.append(",\"year\":");
            out.integer(session.year());
            out.append(",\"season\":");
            out.string(session.season() == openrtw::Season::summer ? "summer" : "winter");
            out.append(",\"selected\":");
            if (selected)
                out.integer(*selected);
            else
                out.append("null");
            out.append(",\"target\":");
            if (target) {
                out.append("[");
                out.integer(target->x);
                out.append(",");
                out.integer(target->y);
                out.append("]");
            } else
                out.append("null");
            out.append(",\"view\":");
            if (geometry) {
                out.append("{\"window\":[");
                out.integer((*geometry)[0]);
                out.append(",");
                out.integer((*geometry)[1]);
                out.append("],\"output\":[");
                out.integer((*geometry)[2]);
                out.append(",");
                out.integer((*geometry)[3]);
                out.append("],\"worldRect\":[");
                for (std::size_t i = 4; i < 8; ++i) {
                    if (i > 4)
                        out.append(",");
                    out.integer((*geometry)[i]);
                }
                out.append("],\"layer\":");
                out.integer((*geometry)[8]);
                out.append("}");
            } else
                out.append("null");
            out.append(",\"route\":");
            if (route) {
                out.append("{\"status\":");
                out.string(route_name(route->status));
                out.append(",\"actorId\":");
                out.integer(route->actorId);
                out.append(",\"revision\":");
                out.integer(route->revision);
                out.append(",\"cost\":");
                out.integer(route->requiredAp);
                out.append(",\"plannedSteps\":");
                out.integer(route->points.empty() ? 0 : route->points.size() - 1);
                out.append(",\"availableAp\":");
                out.integer(route->availableAp);
                out.append(",\"points\":[");
                bool first = true;
                for (const auto& point : route->points) {
                    if (!first)
                        out.append(",");
                    first = false;
                    out.append("[");
                    out.integer(point.x);
                    out.append(",");
                    out.integer(point.y);
                    out.append("]");
                }
                out.append("]}");
            } else
                out.append("null");
            out.append(",\"actors\":[");
            bool first = true;
            for (const auto& actor : session.actors()) {
                if (!first)
                    out.append(",");
                first = false;
                out.append("[");
                out.integer(actor.id);
                out.append(",");
                out.integer(actor.currentX);
                out.append(",");
                out.integer(actor.currentY);
                out.append(",");
                out.integer(actor.ap);
                out.append("]");
            }
            out.append("],\"destinations\":[");
            first = true;
            for (const auto& actor : session.actors()) {
                if (!first)
                    out.append(",");
                first = false;
                out.append("[");
                out.integer(actor.id);
                out.append(",");
                if (actor.destination) {
                    out.append("[");
                    out.integer(actor.destination->x);
                    out.append(",");
                    out.integer(actor.destination->y);
                    out.append("]");
                } else
                    out.append("null");
                out.append("]");
            }
            out.append("],\"previewOrderRevision\":");
            if (route)
                out.integer(previewOrderRevision);
            else
                out.append("null");
            out.append(",\"commandState\":{\"canContinue\":");
            out.append(canContinue ? "true" : "false");
            out.append(",\"canCancel\":");
            out.append(canCancel ? "true" : "false");
            out.append(",\"savedCurrent\":");
            out.append(savedCurrent ? "true" : "false");
            out.append("}}");
            emit(std::move(out).finish());
        } catch (const TraceLimit&) {
            truncate();
        } catch (const std::exception& e) {
            throw std::runtime_error("Fatal campaign observation failure: " +
                                     display_bytes(e.what()));
        }
    }

private:
    bool enabled_;
    std::size_t records_ = 0, bytes_ = 0;
    void truncate() {
        enabled_ = false;
        constexpr std::string_view diagnostic =
            "{\"kind\":\"trace-truncated\",\"complete\":false}\n";
        std::cout << diagnostic;
        std::cout.flush();
        if (!std::cout)
            throw std::runtime_error("Fatal campaign observation failure: stdout write failed");
    }
    void emit(const std::string& record) {
        constexpr std::size_t recordCap = 16 * 1024, totalCap = 256 * 1024;
        // Reserve the last record and 64 bytes for one truncation diagnostic.
        if (records_ >= 127 || record.size() + 1 > recordCap ||
            record.size() + 1 > totalCap - 64 - bytes_) {
            truncate();
            return;
        }
        std::cout << record << '\n';
        std::cout.flush();
        if (!std::cout)
            throw std::runtime_error("stdout write failed");
        ++records_;
        bytes_ += record.size() + 1;
    }
};

class CampaignUi {
public:
    CampaignUi(const openrtw::Campaign& source, const openrtw::RgbImage& map,
               const std::string& savePath, const std::string& gameRoot, const std::string& hgt,
               bool tracing)
        : source_(source), map_(map), identity_(openrtw::campaign_snapshot(source)),
          session_(std::make_unique<Session>(Session::create(source, map.width, map.height))),
          panel_(make_panel(*session_, std::nullopt)), trace_(tracing) {
        try {
            const auto slotPath = std::filesystem::weakly_canonical(savePath);
            const auto terrainPath = std::filesystem::canonical(hgt);
            if (slotPath == terrainPath || (std::filesystem::exists(slotPath) &&
                                            std::filesystem::equivalent(slotPath, terrainPath)))
                throw std::runtime_error("Save path aliases terrain input");
            slot_ = std::make_unique<openrtw::NativeCampaignSaveSlot>(savePath, gameRoot);
        } catch (const std::exception& e) {
            status_ = "Save / Load unavailable: " + display_bytes(e.what());
        }
        trace_.initial(*session_);
        observe("begin", "ready");
    }
    const Session& session() const noexcept { return *session_; }
    const Panel& panel() const noexcept { return panel_; }
    std::optional<std::uint32_t> selected() const noexcept { return selected_; }
    const auto& target() const noexcept { return target_; }
    const auto& route() const noexcept { return route_; }
    std::optional<openrtw::CampaignRoutePoint> destination() const noexcept {
        return selected_ ? session_->actors()[*selected_].destination : std::nullopt;
    }
    void layout_observation(std::optional<std::array<int, 9>> value) noexcept { geometry_ = value; }
    const std::string& status() const noexcept { return status_; }
    bool persistence_available() const noexcept { return bool(slot_); }
    bool saved_current() const noexcept {
        return saved_ && saved_->generation == generation_ &&
               saved_->revision == session_->revision() &&
               saved_->orderRevision == session_->order_revision();
    }
    bool save_uncertain() const noexcept { return saveUncertain_; }
    // Camera/view changes invalidate only the presented preview, never a core order.
    void clear_target() noexcept {
        target_.reset();
        route_.reset();
        routeGeneration_ = 0;
        routeOrderRevision_ = 0;
    }
    bool can_route() const noexcept {
        if (!selected_ || !target_ || !route_ || routeGeneration_ != generation_ ||
            routeOrderRevision_ != session_->order_revision())
            return false;
        const auto& actor = session_->actors()[*selected_];
        const auto& r = *route_;
        return actor.destination && actor.destination->x == target_->x &&
               actor.destination->y == target_->y && r.status == RouteStatus::Ok &&
               r.actorId == *selected_ && r.revision == session_->revision() &&
               r.targetX == target_->x && r.targetY == target_->y && r.availableAp == actor.ap &&
               r.points.size() > 1 && r.points.size() - 1 <= actor.ap;
    }
    bool can_cancel() const noexcept { return bool(destination()); }
    void select(std::optional<std::uint32_t> id) {
        std::string_view result = "selected";
        try {
            if (id && *id >= session_->actors().size())
                throw std::runtime_error("Invalid actor selection");
            auto next = make_panel(*session_, id);
            auto preview = goal_preview(*session_, id);
            std::string message = !id              ? "Selection cleared"
                                  : preview.target ? "Stored journey restored"
                                                   : "Choose a destination in World";
            describe_route(message, preview.route);
            panel_ = std::move(next);
            selected_ = id;
            install_preview(std::move(preview));
            status_ = std::move(message);
        } catch (const std::exception& e) {
            result = "refused";
            status_ = "Selection refused: " + display_bytes(e.what());
        }
        observe("select", result);
    }
    void cycle() {
        if (session_->actors().empty()) {
            select(std::nullopt);
            return;
        }
        select(selected_ ? std::optional<std::uint32_t>{static_cast<std::uint32_t>(
                               (std::size_t(*selected_) + 1) % session_->actors().size())}
                         : std::optional<std::uint32_t>{0});
    }
    void set_destination(openrtw::CampaignRoutePoint point) {
        std::string_view result = "no_selection";
        try {
            if (selected_) {
                auto staged = std::make_unique<Session>(*session_);
                const auto command = staged->set_destination(
                    *selected_, point.x, point.y, session_->revision(), session_->order_revision());
                result = command_name(command.status);
                if (command.accepted() || command.status == CommandStatus::NoOp)
                    publish(std::move(staged), command.accepted() ? "Journey destination set"
                                                                  : "Destination unchanged: no_op");
                else
                    status_ = "Destination refused: " + std::string(result);
            } else
                status_ = "Select a character first";
        } catch (const std::exception& e) {
            result = "refused";
            status_ = "Destination refused: " + display_bytes(e.what());
        }
        observe("set_destination", result);
    }
    void continue_journey() {
        std::string_view result = "no_current_route";
        try {
            if (can_route()) {
                auto staged = std::make_unique<Session>(*session_);
                const auto command =
                    staged->continue_journey(*selected_, route_->revision, routeOrderRevision_);
                result = route_name(command.status);
                if (command.accepted())
                    publish(std::move(staged),
                            "Continued " + std::to_string(command.stepsTaken) + " cells");
                else
                    status_ = "Journey refused: " + std::string(result);
            } else if (route_ && route_->status == RouteStatus::InsufficientAp)
                status_ = "End turn, then Continue the journey";
            else if (route_ && route_->status != RouteStatus::Ok)
                status_ = "Journey blocked: " + std::string(route_name(route_->status));
            else
                status_ = destination() ? "Select the character to refresh its journey preview"
                                        : "Set a journey destination first";
        } catch (const std::exception& e) {
            result = "refused";
            status_ = "Journey refused: " + display_bytes(e.what());
        }
        observe("continue_journey", result);
    }
    void cancel_journey() {
        std::string_view result = "no_selection";
        try {
            if (selected_) {
                auto staged = std::make_unique<Session>(*session_);
                const auto command = staged->cancel_destination(*selected_, session_->revision(),
                                                                session_->order_revision());
                result = command_name(command.status);
                if (command.accepted() || command.status == CommandStatus::NoOp)
                    publish(std::move(staged),
                            command.accepted() ? "Journey cancelled" : "No journey to cancel");
                else
                    status_ = "Cancel refused: " + std::string(result);
            } else
                status_ = "Select a character first";
        } catch (const std::exception& e) {
            result = "refused";
            status_ = "Cancel refused: " + display_bytes(e.what());
        }
        observe("cancel_destination", result);
    }
    void step(std::int32_t dx, std::int32_t dy) {
        std::string_view result = "no_selection";
        try {
            if (selected_) {
                const auto& actor = session_->actors()[*selected_];
                auto staged = std::make_unique<Session>(*session_);
                const auto command = staged->move(*selected_, actor.currentX + dx,
                                                  actor.currentY + dy, session_->revision());
                result = command_name(command.status);
                if (command.accepted())
                    publish(std::move(staged), "Moved one cell: 1 AP");
                else
                    status_ = "Move refused: " + std::string(result);
            } else
                status_ = "Select a character first";
        } catch (const std::exception& e) {
            result = "refused";
            status_ = "Move refused: " + display_bytes(e.what());
        }
        observe("move", result);
    }
    void end_turn() {
        std::string_view result = "refused";
        try {
            auto staged = std::make_unique<Session>(*session_);
            const auto command = staged->end_turn(session_->revision());
            result = command_name(command.status);
            if (command.accepted())
                publish(std::move(staged), "Turn advanced. All AP refilled");
            else
                status_ = "Turn refused: " + std::string(result);
        } catch (const std::exception& e) {
            result = "refused";
            status_ = "Turn refused: " + display_bytes(e.what());
        }
        observe("turn", result);
    }
    void save() {
        std::string_view result = "unavailable";
        try {
            if (slot_) {
                auto bytes = session_->encode_save(identity_, map_.rgb);
                const SavedToken token{generation_, session_->revision(),
                                       session_->order_revision()};
                // Allocate the success presentation before any file publication.
                std::string message = "Saved current campaign and journeys";
                slot_->save(bytes);
                saved_ = token;
                saveUncertain_ = false;
                status_ = std::move(message);
                result = "saved";
            } else
                status_ = "Save unavailable";
        } catch (const openrtw::NativeCampaignSaveError& e) {
            if (e.completion_uncertain()) {
                saved_.reset();
                saveUncertain_ = true;
                result = "completion_uncertain";
                status_ = "Save completion unknown: " + display_bytes(e.what());
            } else {
                result = "refused";
                status_ = "Save refused: " + display_bytes(e.what());
            }
        } catch (const std::exception& e) {
            result = "refused";
            status_ = "Save refused: " + display_bytes(e.what());
        }
        observe("save", result);
    }
    void load() {
        std::string_view result = "unavailable";
        try {
            if (slot_) {
                if (generation_ == std::numeric_limits<std::uint32_t>::max())
                    throw std::runtime_error("Session generation exhausted");
                const auto bytes = slot_->load();
                auto staged = std::make_unique<Session>(Session::decode_save(
                    source_, map_.width, map_.height, identity_, map_.rgb, bytes));
                auto nextPanel = make_panel(*staged, std::nullopt);
                std::string message = "Loaded saved campaign and journeys";
                const SavedToken token{generation_ + 1, staged->revision(),
                                       staged->order_revision()};
                // Everything that can validate/allocate precedes this publication.
                session_.swap(staged);
                panel_ = std::move(nextPanel);
                ++generation_;
                selected_.reset();
                clear_target();
                saved_ = token;
                saveUncertain_ = false;
                status_ = std::move(message);
                result = "loaded";
            } else
                status_ = "Load unavailable";
        } catch (const std::exception& e) {
            result = "refused";
            status_ = "Load refused: " + display_bytes(e.what());
        }
        observe("load", result);
    }
    void normal_stop() {
        observe("normalstop", save_uncertain()  ? "save_completion_unknown"
                              : saved_current() ? "saved_current"
                                                : "manual_save_only");
    }

private:
    struct SavedToken {
        std::uint32_t generation, revision, orderRevision;
    };
    struct GoalPreview {
        std::optional<openrtw::CampaignRoutePoint> target;
        std::optional<openrtw::CampaignRoutePreview> route;
    };
    static_assert(std::is_nothrow_move_assignable_v<GoalPreview>);
    const openrtw::Campaign& source_;
    const openrtw::RgbImage& map_;
    const std::string identity_;
    std::unique_ptr<Session> session_;
    std::unique_ptr<openrtw::NativeCampaignSaveSlot> slot_;
    std::uint32_t generation_ = 1, routeGeneration_ = 0, routeOrderRevision_ = 0;
    std::optional<std::uint32_t> selected_;
    std::optional<openrtw::CampaignRoutePoint> target_;
    std::optional<openrtw::CampaignRoutePreview> route_;
    Panel panel_;
    std::string status_ = "OpenRTW prototype ready";
    std::optional<SavedToken> saved_;
    bool saveUncertain_ = false;
    CampaignTrace trace_;
    std::optional<std::array<int, 9>> geometry_;
    static GoalPreview goal_preview(const Session& session, std::optional<std::uint32_t> id) {
        GoalPreview next;
        if (id) {
            next.target = session.actors().at(*id).destination;
            if (next.target)
                next.route = session.preview_route_advance(*id, next.target->x, next.target->y,
                                                           session.revision());
        }
        return next;
    }
    static void describe_route(std::string& message,
                               const std::optional<openrtw::CampaignRoutePreview>& route) {
        if (!route)
            return;
        if (route->status == RouteStatus::InsufficientAp)
            message += ". End turn, then Continue";
        else if (route->status == RouteStatus::Ok)
            message += ". Continue " + std::to_string(route->points.size() - 1) + " cells; " +
                       std::to_string(route->requiredAp) + " to goal";
        else
            message += ". Route: " + std::string(route_name(route->status));
    }
    void install_preview(GoalPreview&& next) noexcept {
        target_ = next.target;
        route_ = std::move(next.route);
        routeGeneration_ = generation_;
        routeOrderRevision_ = session_->order_revision();
    }
    void observe(std::string_view action, std::string_view result) {
        trace_.action(action, result, *session_, generation_, selected_, target_, route_, geometry_,
                      routeOrderRevision_, can_route(), can_cancel(), saved_current());
    }
    void publish(std::unique_ptr<Session> staged, std::string message) {
        auto nextPanel = make_panel(*staged, selected_);
        auto nextPreview = goal_preview(*staged, selected_);
        if (selected_) {
            const auto priorGoal = session_->actors()[*selected_].destination;
            const auto& nextActor = staged->actors()[*selected_];
            if (priorGoal && !nextActor.destination && nextActor.currentX == priorGoal->x &&
                nextActor.currentY == priorGoal->y)
                message += ". Destination reached";
        }
        describe_route(message, nextPreview.route);
        // All fallible presentation/preview work finishes before publishing core state.
        session_.swap(staged);
        panel_ = std::move(nextPanel);
        install_preview(std::move(nextPreview));
        status_ = std::move(message);
    }
};

struct CampaignLayout {
    int windowW = 0, windowH = 0, outputW = 0, outputH = 0;
    SDL_Rect viewport{}, map{}, sidebar{};
    std::array<SDL_Rect, 5> buttons{};
    std::uint32_t mapW = 0, mapH = 0;
    unsigned layer = 2;
};
bool inside(double x, double y, const SDL_Rect& rect) noexcept {
    return x >= rect.x && y >= rect.y && x < double(rect.x) + rect.w && y < double(rect.y) + rect.h;
}
CampaignLayout layout_for(Video& video, std::uint32_t mapW, std::uint32_t mapH, unsigned layer,
                          double zoom, double panX, double panY) {
    CampaignLayout out;
    SDL_GetWindowSize(video.window, &out.windowW, &out.windowH);
    if (SDL_GetRendererOutputSize(video.renderer, &out.outputW, &out.outputH) != 0)
        throw std::runtime_error(SDL_GetError());
    if (out.windowW < 1 || out.windowH < 1 || out.outputW < 1 || out.outputH < 1 ||
        out.windowW > 16384 || out.windowH > 16384 || out.outputW > 16384 || out.outputH > 16384)
        throw std::runtime_error("Campaign window/output dimensions exceed bounds");
    if (!std::isfinite(zoom) || !std::isfinite(panX) || !std::isfinite(panY) || zoom < .25 ||
        zoom > 8 || std::abs(panX) > 1000000 || std::abs(panY) > 1000000 || mapW == 0 || mapH == 0)
        throw std::runtime_error("Invalid bounded campaign camera");
    out.mapW = mapW;
    out.mapH = mapH;
    out.layer = layer;
    const int side = std::min(340, out.outputW);
    out.sidebar = {out.outputW - side, 0, side, out.outputH};
    out.viewport = {0, 0, out.outputW - side, out.outputH};
    if (out.viewport.w > 0) {
        const auto scale =
            std::min(double(out.viewport.w) / mapW, double(out.viewport.h) / mapH) * zoom;
        const auto width = std::max(1.0, std::floor(mapW * scale)),
                   height = std::max(1.0, std::floor(mapH * scale));
        const auto x = std::floor((out.viewport.w - width) / 2 + panX),
                   y = std::floor((out.viewport.h - height) / 2 + panY);
        // Camera/dimension bounds above keep these casts far inside int range.
        out.map = {static_cast<int>(x), static_cast<int>(y), static_cast<int>(width),
                   static_cast<int>(height)};
    }
    for (std::size_t i = 0; i < out.buttons.size(); ++i)
        out.buttons[i] = {out.sidebar.x + 12, 390 + static_cast<int>(i) * 42,
                          std::max(0, side - 24), 34};
    return out;
}
std::optional<std::pair<double, double>> event_output(Video& video, const CampaignLayout& layout,
                                                      int x, int y) {
    int windowW = 0, windowH = 0, outputW = 0, outputH = 0;
    SDL_GetWindowSize(video.window, &windowW, &windowH);
    if (SDL_GetRendererOutputSize(video.renderer, &outputW, &outputH) != 0)
        throw std::runtime_error(SDL_GetError());
    if (windowW != layout.windowW || windowH != layout.windowH || outputW != layout.outputW ||
        outputH != layout.outputH || x < 0 || y < 0 || x >= windowW || y >= windowH ||
        windowW <= 0 || windowH <= 0)
        return std::nullopt;
    return std::pair{double(x) * outputW / windowW, double(y) * outputH / windowH};
}
std::optional<openrtw::CampaignRoutePoint> world_cell(const CampaignLayout& layout, double x,
                                                      double y) {
    if (layout.layer != 2 || !inside(x, y, layout.viewport) || !inside(x, y, layout.map) ||
        layout.map.w <= 0 || layout.map.h <= 0)
        return std::nullopt;
    const auto column = std::floor((x - layout.map.x) * layout.mapW / layout.map.w);
    const auto row = std::floor((y - layout.map.y) * layout.mapH / layout.map.h);
    if (column < 0 || row < 0 || column >= layout.mapW || row >= layout.mapH)
        return std::nullopt;
    return openrtw::CampaignRoutePoint{static_cast<std::int32_t>(column),
                                       static_cast<std::int32_t>(layout.mapH - 1) -
                                           static_cast<std::int32_t>(row)};
}
std::pair<double, double> project(const CampaignLayout& layout, const Session& session,
                                  std::int32_t x, std::int32_t y) {
    const double column = layout.layer ? double(x) + .5 : 2.0 * x + 1.0;
    const double row = layout.layer ? double(session.height() - 1) - y + .5
                                    : double(layout.mapH - 1) - (2.0 * y + 1.0);
    return {layout.map.x + column * layout.map.w / layout.mapW,
            layout.map.y + row * layout.map.h / layout.mapH};
}
std::optional<std::uint32_t> hit_actor(const CampaignLayout& layout, const Session& session,
                                       double x, double y) {
    if (layout.layer != 2 || !inside(x, y, layout.viewport) || !inside(x, y, layout.map))
        return std::nullopt;
    std::optional<std::uint32_t> result;
    double nearest = 144;
    for (const auto& actor : session.actors()) {
        const auto [px, py] = project(layout, session, actor.currentX, actor.currentY);
        const auto distance = (px - x) * (px - x) + (py - y) * (py - y);
        if (distance < nearest) {
            nearest = distance;
            result = actor.id;
        }
    }
    // Coincident IDs are always separately reachable using Tab.
    return result;
}

void render_campaign(Video& video, const CampaignLayout& layout, const CampaignUi& ui) {
    draw_color(video.renderer, 14, 18, 23);
    if (SDL_RenderClear(video.renderer) != 0)
        throw std::runtime_error(SDL_GetError());
    if (layout.viewport.w > 0) {
        if (SDL_RenderSetClipRect(video.renderer, &layout.viewport) != 0)
            throw std::runtime_error(SDL_GetError());
        if (SDL_RenderCopy(video.renderer,
                           layout.layer == 2   ? video.world
                           : layout.layer == 1 ? video.regions
                                               : video.texture,
                           nullptr, &layout.map) != 0)
            throw std::runtime_error(SDL_GetError());
        if (layout.layer != 1) {
            for (const auto& actor : ui.session().actors()) {
                const auto [x, y] = project(layout, ui.session(), actor.currentX, actor.currentY);
                if (!inside(x, y, layout.viewport) || !inside(x, y, layout.map))
                    continue;
                const auto color = 0x5a73c7u + 0x254f31u * actor.sourceFactionIndex;
                draw_color(video.renderer, static_cast<Uint8>((color >> 16) & 255),
                           static_cast<Uint8>((color >> 8) & 255), static_cast<Uint8>(color & 255));
                fill(video.renderer,
                     SDL_Rect{static_cast<int>(x) - 3, static_cast<int>(y) - 3, 7, 7});
                if (ui.selected() == actor.id) {
                    draw_color(video.renderer, 255, 255, 255);
                    SDL_Rect marker{static_cast<int>(x) - 6, static_cast<int>(y) - 6, 13, 13};
                    if (SDL_RenderDrawRect(video.renderer, &marker) != 0)
                        throw std::runtime_error(SDL_GetError());
                }
            }
        }
        if (layout.layer == 2 && ui.route() && ui.route()->status == RouteStatus::Ok) {
            draw_color(video.renderer, 255, 209, 66);
            std::optional<std::pair<double, double>> prior;
            for (const auto& point : ui.route()->points) {
                const auto current = project(layout, ui.session(), point.x, point.y);
                if (prior && SDL_RenderDrawLine(video.renderer, static_cast<int>(prior->first),
                                                static_cast<int>(prior->second),
                                                static_cast<int>(current.first),
                                                static_cast<int>(current.second)) != 0)
                    throw std::runtime_error(SDL_GetError());
                prior = current;
            }
        }
        if (layout.layer == 2 && ui.target()) {
            const auto [x, y] = project(layout, ui.session(), ui.target()->x, ui.target()->y);
            draw_color(video.renderer, 255, 209, 66);
            SDL_Rect mark{static_cast<int>(x) - 5, static_cast<int>(y) - 5, 11, 11};
            if (SDL_RenderDrawRect(video.renderer, &mark) != 0)
                throw std::runtime_error(SDL_GetError());
        }
        if (SDL_RenderSetClipRect(video.renderer, nullptr) != 0)
            throw std::runtime_error(SDL_GetError());
    }
    draw_color(video.renderer, 26, 34, 43);
    fill(video.renderer, layout.sidebar);
    if (SDL_RenderSetClipRect(video.renderer, &layout.sidebar) != 0)
        throw std::runtime_error(SDL_GetError());
    const int x = layout.sidebar.x + 12;
    const int columns = std::max(1, (layout.sidebar.w - 24) / 12);
    draw_color(video.renderer, 230, 235, 240);
    label(video.renderer, x, 14, "OpenRTW prototype");
    label(video.renderer, x, 40,
          layout.layer == 2   ? "World"
          : layout.layer == 1 ? "Regions - view only"
                              : "Terrain - view only");
    paragraph(video.renderer, x, 70, ui.panel().clock, columns, 2);
    paragraph(video.renderer, x, 116, ui.panel().name, columns, 3);
    paragraph(video.renderer, x, 180, ui.panel().faction, columns, 2);
    paragraph(video.renderer, x, 224, ui.panel().type, columns, 2);
    label(video.renderer, x, 268, ui.panel().position);
    label(video.renderer, x, 290, ui.panel().ap);
    if (const auto goal = ui.destination())
        label(video.renderer, x, 316,
              "Goal " + std::to_string(goal->x) + ", " + std::to_string(goal->y));
    if (ui.route()) {
        label(video.renderer, x, 338, "Total " + std::to_string(ui.route()->requiredAp) + " AP");
        label(video.renderer, x, 360,
              "This turn " +
                  std::to_string(ui.route()->points.empty() ? 0 : ui.route()->points.size() - 1) +
                  " cells");
    }
    constexpr std::array<std::string_view, 5> names = {"Continue journey [Enter]", "End turn [T]",
                                                       "Save [Ctrl+S]", "Load [Ctrl+L]",
                                                       "Cancel journey [C]"};
    for (std::size_t i = 0; i < names.size(); ++i) {
        const bool enabled = i == 0   ? (layout.layer == 2 && ui.can_route())
                             : i == 4 ? ui.can_cancel()
                             : i >= 2 ? ui.persistence_available()
                                      : true;
        draw_color(video.renderer, enabled ? 49 : 32, enabled ? 79 : 40, enabled ? 94 : 48);
        fill(video.renderer, layout.buttons[i]);
        draw_color(video.renderer, enabled ? 240 : 125, enabled ? 240 : 125, enabled ? 240 : 125);
        label(video.renderer, layout.buttons[i].x + 8, layout.buttons[i].y + 10, names[i]);
    }
    draw_color(video.renderer, 230, 235, 240);
    paragraph(video.renderer, x, 608, ui.status(), columns, 4);
    label(video.renderer, x, 694,
          ui.save_uncertain()  ? "Save completion unknown"
          : ui.saved_current() ? "Current state saved"
                               : "Manual Save before exit");
    paragraph(video.renderer, x, 724,
              "Tab: next character  Ctrl-click: select  Click: set destination", columns, 3);
    paragraph(video.renderer, x, 788,
              "WASD: 1 cell / 1 AP  Right-drag / arrows: pan  Wheel: zoom  Home: reset  R: layer",
              columns, 4);
    paragraph(video.renderer, x, 874,
              "80 AP/refill; no terrain rules. Orders wait. Esc exits; no autosave.", columns, 3);
    if (SDL_RenderSetClipRect(video.renderer, nullptr) != 0)
        throw std::runtime_error(SDL_GetError());
}

void run_campaign(Video& video, const openrtw::Campaign& source, const openrtw::RgbImage& map,
                  const openrtw::Terrain& terrain, const std::string& layer,
                  const std::string& savePath, const std::string& gameRoot, const std::string& hgt,
                  const std::string& capturePath, bool tracing) {
    CampaignUi ui(source, map, savePath, gameRoot, hgt, tracing);
    double zoom = 1, panX = 0, panY = 0;
    unsigned layerIndex = layer == "terrain" ? 0u : layer == "regions" ? 1u : 2u;
    bool running = true;
    std::optional<CampaignLayout> painted;
    auto clear_view = [&] {
        ui.clear_target();
        ui.layout_observation(std::nullopt);
        painted.reset();
    };
    auto pan = [&](double x, double y) {
        panX = std::clamp(panX + x, -1000000.0, 1000000.0);
        panY = std::clamp(panY + y, -1000000.0, 1000000.0);
        clear_view();
    };
    while (running) {
        SDL_Event event;
        while (running && SDL_PollEvent(&event)) {
            if (event.type == SDL_QUIT) {
                running = false;
                continue;
            }
            if (event.type == SDL_WINDOWEVENT &&
                (event.window.event == SDL_WINDOWEVENT_SIZE_CHANGED ||
                 event.window.event == SDL_WINDOWEVENT_RESIZED)) {
                clear_view();
                continue;
            }
            if (event.type == SDL_MOUSEWHEEL) {
                zoom =
                    std::clamp(zoom * std::pow(1.15, std::clamp(event.wheel.y, -20, 20)), .25, 8.0);
                clear_view();
                continue;
            }
            if (event.type == SDL_MOUSEMOTION && (event.motion.state & SDL_BUTTON_RMASK)) {
                if (painted)
                    pan(double(event.motion.xrel) * painted->outputW / painted->windowW,
                        double(event.motion.yrel) * painted->outputH / painted->windowH);
                continue;
            }
            if (event.type == SDL_MOUSEBUTTONDOWN && event.button.button == SDL_BUTTON_LEFT &&
                painted) {
                const auto point = event_output(video, *painted, event.button.x, event.button.y);
                if (!point)
                    continue;
                const auto [x, y] = *point;
                bool button = false;
                for (std::size_t i = 0; i < painted->buttons.size(); ++i)
                    if (inside(x, y, painted->buttons[i]) && inside(x, y, painted->sidebar)) {
                        button = true;
                        if (i == 0) {
                            if (layerIndex == 2)
                                ui.continue_journey();
                        } else if (i == 1)
                            ui.end_turn();
                        else if (i == 2)
                            ui.save();
                        else if (i == 3)
                            ui.load();
                        else
                            ui.cancel_journey();
                        break;
                    }
                if (button)
                    continue;
                if (layerIndex != 2 || !inside(x, y, painted->viewport) ||
                    !inside(x, y, painted->map))
                    continue;
                if ((SDL_GetModState() & KMOD_CTRL) || !ui.selected())
                    ui.select(hit_actor(*painted, ui.session(), x, y));
                else if (const auto destination = world_cell(*painted, x, y))
                    ui.set_destination(*destination);
                continue;
            }
            if (event.type != SDL_KEYDOWN || event.key.repeat)
                continue;
            const auto key = event.key.keysym.sym;
            const auto modifiers = event.key.keysym.mod;
            const bool ctrl = (modifiers & KMOD_CTRL) != 0,
                       meta = (modifiers & (KMOD_CTRL | KMOD_ALT | KMOD_GUI)) != 0;
            // One branch per event: Ctrl+S never also walks south.
            if (key == SDLK_ESCAPE) {
                running = false;
                continue;
            }
            if (ctrl && key == SDLK_s) {
                ui.save();
                continue;
            }
            if (ctrl && key == SDLK_l) {
                ui.load();
                continue;
            }
            if (meta)
                continue;
            switch (key) {
            case SDLK_TAB:
                ui.cycle();
                break;
            case SDLK_BACKSPACE:
                ui.select(std::nullopt);
                break;
            case SDLK_RETURN:
            case SDLK_KP_ENTER:
                if (layerIndex == 2)
                    ui.continue_journey();
                break;
            case SDLK_c:
                ui.cancel_journey();
                break;
            case SDLK_t:
                ui.end_turn();
                break;
            case SDLK_w:
                if (layerIndex == 2)
                    ui.step(0, 1);
                break;
            case SDLK_s:
                if (layerIndex == 2)
                    ui.step(0, -1);
                break;
            case SDLK_a:
                if (layerIndex == 2)
                    ui.step(-1, 0);
                break;
            case SDLK_d:
                if (layerIndex == 2)
                    ui.step(1, 0);
                break;
            case SDLK_HOME:
                zoom = 1;
                panX = panY = 0;
                clear_view();
                break;
            case SDLK_r:
                layerIndex = (layerIndex + 1) % 3;
                zoom = 1;
                panX = panY = 0;
                clear_view();
                break;
            case SDLK_LEFT:
                pan(24, 0);
                break;
            case SDLK_RIGHT:
                pan(-24, 0);
                break;
            case SDLK_UP:
                pan(0, 24);
                break;
            case SDLK_DOWN:
                pan(0, -24);
                break;
            default:
                break;
            }
        }
        if (!running)
            break;
        const auto layout =
            layout_for(video, layerIndex ? map.width : terrain.width,
                       layerIndex ? map.height : terrain.height, layerIndex, zoom, panX, panY);
        render_campaign(video, layout, ui);
        painted = layout;
        ui.layout_observation(std::array<int, 9>{
            layout.windowW, layout.windowH, layout.outputW, layout.outputH, layout.map.x,
            layout.map.y, layout.map.w, layout.map.h, static_cast<int>(layout.layer)});
        if (!capturePath.empty()) {
            capture(video.renderer, capturePath);
            running = false;
        }
        SDL_RenderPresent(video.renderer);
        if (running)
            SDL_Delay(16);
    }
    ui.normal_stop(); // No automatic write on Escape/window-close/capture.
}
} // namespace

int main(int argc, char** argv) {
    try {
        std::string game_dir, hgt, capture_path,
            layer = "terrain", mode = "viewer",
            save_path = "local/openrtw-native-saves/campaign.save";
        bool explicit_layer = false, trace_campaign = false, explicit_save = false;
        for (int i = 1; i < argc; i++) {
            const std::string key = argv[i];
            if (key == "--trace-campaign") {
                trace_campaign = true;
                continue;
            }
            if (i + 1 >= argc)
                throw std::runtime_error("Missing option value");
            const std::string value = argv[++i];
            if (key == "--game-dir")
                game_dir = value;
            else if (key == "--hgt")
                hgt = value;
            else if (key == "--capture")
                capture_path = value;
            else if (key == "--layer") {
                layer = value;
                explicit_layer = true;
            } else if (key == "--mode")
                mode = value;
            else if (key == "--save-file") {
                save_path = value;
                explicit_save = true;
            } else
                throw std::runtime_error("Unknown option: " + key);
        }
        if (mode != "viewer" && mode != "campaign")
            throw std::runtime_error("Mode must be viewer or campaign");
        if (mode == "campaign" && game_dir.empty())
            throw std::runtime_error("Campaign mode requires --game-dir");
        if (mode == "campaign" && !explicit_layer)
            layer = "world";
        if (mode != "campaign" && (trace_campaign || explicit_save))
            throw std::runtime_error("Save and trace options require --mode campaign");
        if (layer != "terrain" && layer != "regions" && layer != "world")
            throw std::runtime_error("Layer must be terrain, regions or world");
        if (layer != "terrain" && game_dir.empty())
            throw std::runtime_error("Region/world layer needs --game-dir");
        if (hgt.empty() && !game_dir.empty())
            hgt = game_dir + "/data/world/maps/base/map_heights.hgt";
        if (hgt.empty())
            throw std::runtime_error(
                "Usage: openrtw-native --game-dir PATH [--capture OUTPUT.ppm]");
        if (!capture_path.empty()) {
            const auto output = std::filesystem::weakly_canonical(capture_path);
            if (std::filesystem::exists(output) || output == std::filesystem::canonical(hgt) ||
                (!game_dir.empty() && within(output, std::filesystem::canonical(game_dir))))
                throw std::runtime_error("Capture must be fresh and outside owned game inputs");
        }
        const auto bytes = read_file(hgt);
        const auto terrain = openrtw::load_hgt(bytes);
        std::optional<openrtw::Campaign> campaign;
        std::optional<openrtw::RegionDefinitions> definitions;
        std::optional<openrtw::RgbImage> region_map;
        std::optional<openrtw::WorldGrid> world_grid;
        std::optional<openrtw::CategoryGrid> category_grid;
        std::optional<openrtw::ClimatePalette> climates;
        std::optional<openrtw::ClimateCoefficientGrid> climate_grid;
        if (!game_dir.empty()) {
            const auto source =
                read_file(game_dir + "/data/world/maps/campaign/imperial_campaign/descr_strat.txt");
            campaign = openrtw::load_campaign(
                std::string_view(reinterpret_cast<const char*>(source.data()), source.size()));
            const auto region_source =
                read_file(game_dir + "/data/world/maps/base/descr_regions.txt");
            definitions = openrtw::load_regions(
                {reinterpret_cast<const char*>(region_source.data()), region_source.size()});
            region_map =
                openrtw::load_tga24(read_file(game_dir + "/data/world/maps/base/map_regions.tga"));
            world_grid = openrtw::build_world_grid(*region_map);
            const auto ground = openrtw::load_tga24(
                read_file(game_dir + "/data/world/maps/base/map_ground_types.tga"));
            category_grid = openrtw::build_category_grid(terrain, ground);
            const auto climate_source = read_file(game_dir + "/data/descr_climates.txt");
            climates = openrtw::load_climates(
                {reinterpret_cast<const char*>(climate_source.data()), climate_source.size()});
            const auto climate_map =
                openrtw::load_tga24(read_file(game_dir + "/data/world/maps/base/map_climates.tga"));
            climate_grid = openrtw::build_climate_coefficient_grid(*climates, climate_map);
            if (climate_grid->width != region_map->width ||
                climate_grid->height != region_map->height)
                throw std::runtime_error(
                    "Climate and region grid dimensions do not match this bootstrap");
            if (terrain.width != 2 * region_map->width + 1 ||
                terrain.height != 2 * region_map->height + 1)
                throw std::runtime_error(
                    "Terrain and region grid dimensions do not match this bootstrap");
        }
        std::vector<std::uint32_t> pixels(terrain.heightBits.size());
        float low = std::numeric_limits<float>::infinity(), high = -low;
        for (std::uint32_t y = 0; y < terrain.height; y++)
            for (std::uint32_t x = 0; x < terrain.width; x++) {
                const float h = terrain.height_at(x, y);
                low = std::min(low, h);
                high = std::max(high, h);
                pixels[std::size_t(terrain.height - 1 - y) * terrain.width + x] = preview_color(h);
            }
        Video video;
        if (SDL_Init(SDL_INIT_VIDEO | SDL_INIT_EVENTS) != 0)
            throw std::runtime_error(SDL_GetError());
        const auto title = "OpenRTW | " + (campaign ? campaign->id : "terrain bootstrap") + " | " +
                           std::to_string(terrain.width) + " x " + std::to_string(terrain.height);
        video.window = SDL_CreateWindow(
            title.c_str(), SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED,
            mode == "campaign" ? 1280 : 1000, mode == "campaign" ? 940 : 720,
            SDL_WINDOW_RESIZABLE |
                (mode == "campaign" ? static_cast<Uint32>(SDL_WINDOW_ALLOW_HIGHDPI) : 0u));
        if (!video.window)
            throw std::runtime_error(SDL_GetError());
        video.renderer = SDL_CreateRenderer(video.window, -1, SDL_RENDERER_SOFTWARE);
        if (!video.renderer)
            throw std::runtime_error(SDL_GetError());
        video.texture = SDL_CreateTexture(video.renderer, SDL_PIXELFORMAT_ARGB8888,
                                          SDL_TEXTUREACCESS_STATIC, terrain.width, terrain.height);
        if (!video.texture ||
            SDL_UpdateTexture(video.texture, nullptr, pixels.data(), terrain.width * 4) != 0)
            throw std::runtime_error(SDL_GetError());
        if (region_map) {
            std::vector<std::uint32_t> colors(std::size_t(region_map->width) * region_map->height);
            for (std::size_t i = 0; i < colors.size(); ++i)
                colors[i] = 0xff000000u | (std::uint32_t(region_map->rgb[3 * i]) << 16) |
                            (std::uint32_t(region_map->rgb[3 * i + 1]) << 8) |
                            region_map->rgb[3 * i + 2];
            video.regions =
                SDL_CreateTexture(video.renderer, SDL_PIXELFORMAT_ARGB8888,
                                  SDL_TEXTUREACCESS_STATIC, region_map->width, region_map->height);
            if (!video.regions || SDL_UpdateTexture(video.regions, nullptr, colors.data(),
                                                    region_map->width * 4) != 0)
                throw std::runtime_error(SDL_GetError());
            for (std::uint32_t y = 0; y < world_grid->height; ++y)
                for (std::uint32_t x = 0; x < world_grid->width; ++x) {
                    const auto rgb = world_grid->rgb_at(x, world_grid->height - 1 - y);
                    colors[std::size_t(y) * world_grid->width + x] =
                        0xff000000u | (std::uint32_t(rgb[0]) << 16) | (std::uint32_t(rgb[1]) << 8) |
                        rgb[2];
                }
            video.world =
                SDL_CreateTexture(video.renderer, SDL_PIXELFORMAT_ARGB8888,
                                  SDL_TEXTUREACCESS_STATIC, world_grid->width, world_grid->height);
            if (!video.world ||
                SDL_UpdateTexture(video.world, nullptr, colors.data(), world_grid->width * 4) != 0)
                throw std::runtime_error(SDL_GetError());
        }
        std::cout << "{\"engine\":\"OpenRTW\",\"slice\":\"terrain-bootstrap\",\"width\":"
                  << terrain.width << ",\"height\":" << terrain.height
                  << ",\"samples\":" << terrain.heightBits.size() << ",\"minimum\":" << low
                  << ",\"maximum\":" << high;
        if (campaign) {
            std::size_t characters = 0, units = 0, settlements = 0, buildings = 0;
            for (const auto& f : campaign->factions) {
                settlements += f.settlements.size();
                for (const auto& settlement : f.settlements)
                    buildings += settlement.buildings.size();
                for (const auto& c : f.characters) {
                    ++characters;
                    units += c.army.size();
                }
            }
            std::cout << ",\"campaign\":" << std::quoted(campaign->id)
                      << ",\"startYear\":" << campaign->startYear << ",\"startSeason\":\""
                      << (campaign->startSeason == openrtw::Season::summer ? "summer" : "winter")
                      << "\",\"factions\":" << campaign->factions.size()
                      << ",\"characters\":" << characters << ",\"unitRecords\":" << units
                      << ",\"opaqueRecords\":" << campaign->unsupported.size()
                      << ",\"settlements\":" << settlements << ",\"buildingRecords\":" << buildings;
        }
        if (region_map)
            std::cout << ",\"regionDefinitions\":" << definitions->definitions.size()
                      << ",\"regionWidth\":" << region_map->width
                      << ",\"regionHeight\":" << region_map->height;
        if (world_grid)
            std::cout << ",\"worldRegions\":" << world_grid->palette.size()
                      << ",\"worldCells\":" << world_grid->regionIndices.size()
                      << ",\"markers\":" << world_grid->markers.size();
        if (category_grid)
            std::cout << ",\"groundCategories\":" << category_grid->categories.size();
        if (climate_grid)
            std::cout << ",\"climateDefinitions\":" << climates->definitions.size()
                      << ",\"climateCoefficients\":" << climate_grid->coefficientBits.size();
        std::cout << "}\n";
        std::cout.flush();
        if (mode == "campaign") {
            run_campaign(video, *campaign, *region_map, terrain, layer, save_path, game_dir, hgt,
                         capture_path, trace_campaign);
            return 0;
        }
        float zoom = 1, pan_x = 0, pan_y = 0;
        bool running = true;
        unsigned layer_index = layer == "terrain" ? 0u : layer == "regions" ? 1u : 2u;
        while (running) {
            SDL_Event event;
            while (SDL_PollEvent(&event)) {
                if (event.type == SDL_QUIT)
                    running = false;
                if (event.type == SDL_MOUSEWHEEL)
                    zoom = std::clamp(zoom * std::pow(1.15f, float(event.wheel.y)), .25f, 8.f);
                if (event.type == SDL_KEYDOWN) {
                    if (event.key.keysym.sym == SDLK_ESCAPE)
                        running = false;
                    if (event.key.keysym.sym == SDLK_HOME) {
                        zoom = 1;
                        pan_x = pan_y = 0;
                    }
                    if (event.key.keysym.sym == SDLK_r && region_map) {
                        layer_index = (layer_index + 1) % 3;
                        zoom = 1;
                        pan_x = pan_y = 0;
                    }
                }
                if (event.type == SDL_MOUSEMOTION && (event.motion.state & SDL_BUTTON_LMASK)) {
                    pan_x += event.motion.xrel;
                    pan_y += event.motion.yrel;
                }
            }
            const auto* keys = SDL_GetKeyboardState(nullptr);
            pan_x += float(keys[SDL_SCANCODE_LEFT] - keys[SDL_SCANCODE_RIGHT]) * 8;
            pan_y += float(keys[SDL_SCANCODE_UP] - keys[SDL_SCANCODE_DOWN]) * 8;
            int width = 0, height = 0;
            if (SDL_GetRendererOutputSize(video.renderer, &width, &height) != 0 || width <= 0 ||
                height <= 0)
                throw std::runtime_error("Invalid renderer output dimensions: " +
                                         std::string(SDL_GetError()));
            const auto map_width = layer_index ? region_map->width : terrain.width,
                       map_height = layer_index ? region_map->height : terrain.height;
            const float scale =
                std::min(float(width) / map_width, float(height) / map_height) * zoom;
            SDL_Rect target{int((width - map_width * scale) / 2 + pan_x),
                            int((height - map_height * scale) / 2 + pan_y), int(map_width * scale),
                            int(map_height * scale)};
            if (SDL_SetRenderDrawColor(video.renderer, 14, 18, 23, 255) != 0 ||
                SDL_RenderClear(video.renderer) != 0)
                throw std::runtime_error(SDL_GetError());
            if (SDL_RenderCopy(video.renderer,
                               layer_index == 2   ? video.world
                               : layer_index == 1 ? video.regions
                                                  : video.texture,
                               nullptr, &target) != 0)
                throw std::runtime_error(SDL_GetError());
            if (campaign && layer_index != 1) {
                std::uint32_t faction_index = 0;
                for (const auto& faction : campaign->factions) {
                    // Preview marker colors and cell-center placement are new
                    // presentation choices, not original rendering evidence.
                    const auto color = 0x5a73c7u + 0x254f31u * faction_index++;
                    if (SDL_SetRenderDrawColor(video.renderer, (color >> 16) & 255,
                                               (color >> 8) & 255, color & 255, 255) != 0)
                        throw std::runtime_error(SDL_GetError());
                    for (const auto& character : faction.characters) {
                        const float px =
                            (layer_index ? character.x + .5f : 2.f * character.x + 1) * scale +
                            target.x;
                        const float py =
                            (layer_index ? region_map->height - 1 - character.y + .5f
                                         : terrain.height - 1 - (2.f * character.y + 1)) *
                                scale +
                            target.y;
                        if (px < target.x || py < target.y || px >= target.x + target.w ||
                            py >= target.y + target.h)
                            continue;
                        SDL_Rect marker{int(px) - 2, int(py) - 2, 5, 5};
                        if (SDL_RenderFillRect(video.renderer, &marker) != 0)
                            throw std::runtime_error(SDL_GetError());
                    }
                }
            }
            if (!capture_path.empty()) {
                capture(video.renderer, capture_path);
                running = false;
            }
            SDL_RenderPresent(video.renderer);
            if (running)
                SDL_Delay(16);
        }
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "OpenRTW: " << error.what() << "\n";
        return 1;
    }
}
