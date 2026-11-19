#pragma once

#include <cstdint>

namespace openrtw::rome_original {

enum class CalendarSeason : std::int32_t { winter = 0, summer = 2 };

struct CalendarDate {
    std::int32_t year = 0;
    CalendarSeason season = CalendarSeason::summer;
};

// 43BEFE, one half-year step on the raw fields. Season 2 -> 0 with the year
// unchanged; every other season value -> 2 with year+1, so the original treats
// any non-2 season as winter. Year 0 is then skipped in BOTH branches, which
// also rewrites an already-zero year. Both year increments are plain 32-bit
// adds: INT32_MAX winter wraps to INT32_MIN and is not refused. The caller owns
// any supported-range policy.
constexpr void advance_calendar_bits(std::int32_t& year, std::int32_t& season) noexcept {
    if (season == 2) {
        season = 0;
    } else {
        season = 2;
        year = static_cast<std::int32_t>(static_cast<std::uint32_t>(year) + 1u);
    }
    if (year == 0)
        year = static_cast<std::int32_t>(static_cast<std::uint32_t>(year) + 1u);
}

constexpr CalendarDate advance_calendar(CalendarDate date) noexcept {
    std::int32_t year = date.year;
    std::int32_t season = static_cast<std::int32_t>(date.season);
    advance_calendar_bits(year, season);
    date.year = year;
    date.season = static_cast<CalendarSeason>(season);
    return date;
}

// 43BF44, one half-year back. Season 2 -> 0 with year-1; every other value ->
// 2 with the year unchanged. There is no year-zero rewrite on this path, so
// rewinding summer of AD 1 yields winter of year 0. That is the original's
// asymmetric repair, not a supported-year rule for this header.
constexpr void rewind_calendar_bits(std::int32_t& year, std::int32_t& season) noexcept {
    if (season == 2) {
        season = 0;
        year = static_cast<std::int32_t>(static_cast<std::uint32_t>(year) - 1u);
    } else {
        season = 2;
    }
}

constexpr CalendarDate rewind_calendar(CalendarDate date) noexcept {
    std::int32_t year = date.year;
    std::int32_t season = static_cast<std::int32_t>(date.season);
    rewind_calendar_bits(year, season);
    date.year = year;
    date.season = static_cast<CalendarSeason>(season);
    return date;
}

// 43BF77, the original's half-year span helper on raw fields. Callers 437F98
// and 528643 copy the current world date and move it by a count (clamped to
// 2..100 in 437F98) to build a later date. The words reproduce the original,
// which is NOT repeated advance_calendar_bits:
//  - odd counts take one step only for positive counts (the original tests a
//    signed idiv remainder against 1), so -1 and -3 both move like -0/-2;
//  - whole years are added with truncation toward zero;
//  - when a negative year plus those years reaches zero or later, one year is
//    SUBTRACTED. Repeated single steps skip year 0 by adding one instead, so
//    the two disagree by two years across the BC/AD boundary and this helper
//    can return year 0. Use the single steps for a calendar; use this only to
//    reproduce original span arithmetic.
constexpr void shift_calendar_half_years_bits(std::int32_t& year, std::int32_t& season,
                                             std::int32_t halfYears) noexcept {
    if (halfYears % 2 == 1) {
        if (halfYears <= 0)
            rewind_calendar_bits(year, season);
        else
            advance_calendar_bits(year, season);
    }
    std::int32_t years = halfYears / 2;
    if (year < 0 &&
        static_cast<std::int32_t>(static_cast<std::uint32_t>(year) +
                                  static_cast<std::uint32_t>(years)) >= 0)
        --years;
    year = static_cast<std::int32_t>(static_cast<std::uint32_t>(year) +
                                     static_cast<std::uint32_t>(years));
}

constexpr CalendarDate shift_calendar_half_years(CalendarDate date,
                                                 std::int32_t halfYears) noexcept {
    std::int32_t year = date.year;
    std::int32_t season = static_cast<std::int32_t>(date.season);
    shift_calendar_half_years_bits(year, season, halfYears);
    date.year = year;
    date.season = static_cast<CalendarSeason>(season);
    return date;
}

} // namespace openrtw::rome_original
