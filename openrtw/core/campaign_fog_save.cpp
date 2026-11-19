#include "campaign_fog_save.hpp"

#include <algorithm>
#include <array>
#include <bit>
#include <stdexcept>

namespace openrtw {
namespace {
// All integers and IEEE binary32 eye bits are little-endian. Header, aliases,
// ascending-ID observer records, then table-major bitmaps. Every table starts
// on a byte boundary; cells use low bit first in x+width*y order.
constexpr std::array<std::uint8_t, 8> magic{'O', 'R', 'T', 'W', 'F', 'O', 'G', 0};
constexpr std::uint32_t version = 1;
constexpr std::size_t headerBytes = 44, observerBytes = 24;

[[noreturn]] void fail(const char* message) {
    throw std::runtime_error(message);
}

struct Layout {
    std::uint32_t tables = 0, observers = 0, bitmapBytes = 0;
    std::size_t cellsPerTable = 0, bitmapOffset = 0, size = 0;
};

Layout layout(const CampaignFog& fog) {
    Layout result;
    result.cellsPerTable = std::size_t{fog.width()} * fog.height();
    for (const auto table : fog.faction_tables())
        result.tables = std::max(result.tables, table + 1);
    for (std::uint32_t id = 0; id < fog.observer_capacity(); ++id)
        result.observers += fog.observer(id) != nullptr;
    result.bitmapBytes = static_cast<std::uint32_t>((result.cellsPerTable + 7) / 8);
    const auto offset = std::uint64_t{headerBytes} + fog.faction_tables().size() * 4ull +
                        result.observers * std::uint64_t{observerBytes};
    const auto size = offset + std::uint64_t{result.tables} * result.bitmapBytes;
    if (size > campaign_fog_save_max_bytes)
        fail("Campaign fog save exceeds payload size limit");
    result.bitmapOffset = static_cast<std::size_t>(offset);
    result.size = static_cast<std::size_t>(size);
    return result;
}

void append_u32(std::vector<std::uint8_t>& out, std::uint32_t value) {
    for (unsigned shift = 0; shift != 32; shift += 8)
        out.push_back(static_cast<std::uint8_t>(value >> shift));
}

class Reader {
public:
    explicit Reader(std::span<const std::uint8_t> bytes) : bytes_(bytes) {}
    std::uint32_t u32() {
        if (bytes_.size() - cursor_ < 4)
            fail("Truncated campaign fog save");
        std::uint32_t value = 0;
        for (unsigned shift = 0; shift != 32; shift += 8)
            value |= std::uint32_t{bytes_[cursor_++]} << shift;
        return value;
    }

private:
    std::span<const std::uint8_t> bytes_;
    std::size_t cursor_ = magic.size();
};

bool explored(std::span<const std::uint8_t> bytes, const Layout& shape, std::size_t index) {
    const auto table = index / shape.cellsPerTable;
    const auto cell = index % shape.cellsPerTable;
    return (bytes[shape.bitmapOffset + table * shape.bitmapBytes + cell / 8] &
            (1u << (cell % 8))) != 0;
}

void accept(CampaignFogStatus status) {
    if (status != CampaignFogStatus::Ok)
        fail("Campaign fog save observer update refused");
}
} // namespace

std::vector<std::uint8_t> encode_campaign_fog_state(const CampaignFog& fog) {
    const auto shape = layout(fog);
    const auto saved = fog.snapshot();
    std::vector<std::uint8_t> result;
    result.reserve(shape.size);
    result.insert(result.end(), magic.begin(), magic.end());
    append_u32(result, version);
    append_u32(result, saved.width);
    append_u32(result, saved.height);
    append_u32(result, saved.maxRadius);
    append_u32(result, saved.observerCapacity);
    append_u32(result, static_cast<std::uint32_t>(saved.factionTables.size()));
    append_u32(result, shape.tables);
    append_u32(result, shape.observers);
    append_u32(result, shape.bitmapBytes);
    for (const auto table : saved.factionTables)
        append_u32(result, table);
    for (const auto& item : saved.observers) {
        append_u32(result, item.id);
        append_u32(result, item.faction);
        append_u32(result, std::bit_cast<std::uint32_t>(item.observer.x));
        append_u32(result, std::bit_cast<std::uint32_t>(item.observer.y));
        append_u32(result, item.observer.radius);
        append_u32(result, std::bit_cast<std::uint32_t>(item.observer.eye));
    }
    result.resize(shape.size, 0);
    for (std::size_t i = 0; i < saved.cells.size(); ++i)
        if (saved.cells[i]) {
            const auto table = i / shape.cellsPerTable, cell = i % shape.cellsPerTable;
            result[shape.bitmapOffset + table * shape.bitmapBytes + cell / 8] |=
                static_cast<std::uint8_t>(1u << (cell % 8));
        }
    return result;
}

CampaignFog decode_campaign_fog_state(const CampaignFog& initial,
                                      std::span<const std::uint8_t> bytes) {
    if (bytes.size() < headerBytes || bytes.size() > campaign_fog_save_max_bytes ||
        !std::equal(magic.begin(), magic.end(), bytes.begin()))
        fail("Invalid campaign fog save framing");
    const auto shape = layout(initial);
    if (bytes.size() != shape.size)
        fail("Campaign fog save length does not match initial projection");
    Reader reader(bytes);
    if (reader.u32() != version || reader.u32() != initial.width() ||
        reader.u32() != initial.height() || reader.u32() != initial.max_radius() ||
        reader.u32() != initial.observer_capacity() ||
        reader.u32() != initial.faction_tables().size() || reader.u32() != shape.tables ||
        reader.u32() != shape.observers || reader.u32() != shape.bitmapBytes)
        fail("Campaign fog save configuration does not match initial projection");
    for (const auto table : initial.faction_tables())
        if (reader.u32() != table)
            fail("Campaign fog save sharing does not match initial projection");
    const unsigned usedBits = shape.cellsPerTable % 8;
    if (usedBits)
        for (std::uint32_t table = 0; table < shape.tables; ++table)
            if ((bytes[shape.bitmapOffset + (table + 1) * shape.bitmapBytes - 1] >> usedBits) != 0)
                fail("Campaign fog save has nonzero bitmap padding");

    // Framing and all attacker-controlled lengths were checked before allocating.
    auto expected = initial.snapshot();
    for (auto& item : expected.observers) {
        const auto id = reader.u32(), faction = reader.u32();
        const auto x = std::bit_cast<std::int32_t>(reader.u32());
        const auto y = std::bit_cast<std::int32_t>(reader.u32());
        const auto radius = reader.u32(), eye = reader.u32();
        if (id != item.id || faction != item.faction || radius != item.observer.radius ||
            eye != std::bit_cast<std::uint32_t>(item.observer.eye))
            fail("Campaign fog save observers do not match initial projection");
        if (x < 0 || y < 0 || static_cast<std::uint32_t>(x) >= initial.width() ||
            static_cast<std::uint32_t>(y) >= initial.height())
            fail("Campaign fog save observer is outside terrain");
        item.observer.x = x;
        item.observer.y = y;
    }
    for (std::size_t i = 0; i < expected.cells.size(); ++i)
        if (expected.cells[i] && !explored(bytes, shape, i))
            fail("Campaign fog save loses initial exploration");

    auto staged = CampaignFog::create(initial.terrain(), initial.faction_tables(),
                                      initial.observer_capacity(), initial.max_radius());
    // Regenerate from empty contributions: replacing initial observers one by
    // one can temporarily overflow even when both complete states are valid.
    for (const auto& item : expected.observers)
        accept(staged.set_observer(item.id, item.faction, item.observer));
    auto restored = staged.snapshot();
    for (std::size_t i = 0; i < restored.cells.size(); ++i) {
        const bool seen = explored(bytes, shape, i);
        if (restored.cells[i] >= 2) {
            if (!seen)
                fail("Campaign fog save hides a current observer footprint");
        } else {
            restored.cells[i] = seen ? 1 : 0;
        }
    }
    return CampaignFog::restore(initial.terrain(), initial.faction_tables(), restored);
}

} // namespace openrtw
