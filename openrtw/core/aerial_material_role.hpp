#pragma once
#include <cstdint>
#include <optional>

namespace openrtw {
enum class AerialMaterialRole : std::uint8_t {
    cultivated_low = 0,
    cultivated_medium = 1,
    cultivated_high = 2,
    fertility_low = 3,
    fertility_medium = 4,
    fertility_high = 5,
    forest_dense = 6,
    forest_sparse = 7,
    hills = 8,
    mountains_high = 9,
    mountains_low = 10,
    swamp = 11,
    beach = 12,
    scorched = 13
};

std::optional<AerialMaterialRole> select_aerial_material_role(std::int32_t category,
                                                              std::uint8_t byteArg4 = 0,
                                                              std::uint8_t byteArg5 = 0) noexcept;
} // namespace openrtw
