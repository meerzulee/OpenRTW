#include "aerial_material_role.hpp"
#include <array>
#include <cstddef>

namespace openrtw {
std::optional<AerialMaterialRole> select_aerial_material_role(std::int32_t category,
                                                              std::uint8_t byteArg4,
                                                              std::uint8_t byteArg5) noexcept {
    using R = AerialMaterialRole;
    if (byteArg5 == 1)
        return R::scorched;
    if (category < 0 || category >= 14)
        return std::nullopt;
    constexpr std::array<R, 3> cultivated{R::cultivated_low, R::cultivated_medium,
                                          R::cultivated_high};
    if (byteArg4 == 1 && category <= 2)
        return cultivated[static_cast<std::size_t>(category)];
    constexpr std::array<R, 14> roles{R::fertility_low,  R::fertility_medium,
                                      R::fertility_high, R::fertility_low,
                                      R::mountains_high, R::mountains_low,
                                      R::hills,          R::forest_dense,
                                      R::forest_sparse,  R::swamp,
                                      R::beach,          R::beach,
                                      R::beach,          R::beach};
    return roles[static_cast<std::size_t>(category)];
}
} // namespace openrtw
