#include "../core/terrain.hpp"
#include "../core/campaign.hpp"

#include <bit>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iostream>
#include <iterator>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace {
void require(bool condition, const char* message) {
    if (!condition)
        throw std::runtime_error(message);
}

template <class Exception = std::runtime_error, class Action> void refuses(Action action) {
    try {
        action();
    } catch (const Exception&) {
        return;
    }
    throw std::runtime_error("expected refusal");
}

void append(std::vector<std::uint8_t>& bytes, std::uint32_t value) {
    for (unsigned shift = 0; shift < 32; shift += 8)
        bytes.push_back(static_cast<std::uint8_t>(value >> shift));
}

std::vector<std::uint8_t> hgt(std::uint32_t width, std::uint32_t height,
                              const std::vector<std::uint32_t>& bits = {}) {
    std::vector<std::uint8_t> bytes;
    append(bytes, width);
    append(bytes, height);
    for (auto value : bits)
        append(bytes, value);
    return bytes;
}

std::vector<std::uint8_t> read_owned(const std::filesystem::path& path) {
    std::ifstream file(path, std::ios::binary);
    if (!file)
        throw std::runtime_error("cannot read optional owned asset");
    file.seekg(0, std::ios::end);
    const auto size = file.tellg();
    if (size < 0 || size > 8 * 1024 * 1024)
        throw std::runtime_error("optional owned asset exceeds bounded read");
    file.seekg(0, std::ios::beg);
    std::vector<std::uint8_t> bytes(static_cast<std::size_t>(size));
    if (!bytes.empty())
        file.read(reinterpret_cast<char*>(bytes.data()), size);
    if (!file)
        throw std::runtime_error("short optional owned asset read");
    return bytes;
}

std::uint32_t source_word(const std::vector<std::uint8_t>& bytes, std::size_t offset) {
    return std::uint32_t(bytes.at(offset)) + (std::uint32_t(bytes.at(offset + 1)) << 8) +
           (std::uint32_t(bytes.at(offset + 2)) << 16) +
           (std::uint32_t(bytes.at(offset + 3)) << 24);
}

void terrain_tests(const std::function<void(const char*, std::function<void()>)>& test) {
    test("terrain exact little-endian words and row order", [] {
        const std::vector<std::uint32_t> bits{0x00000000, 0x80000000, 0x3f800000,
                                              0xbf800000, 0x00000001, 0x80000001,
                                              0x7f7fffff, 0xff7fffff, 0x41200000};
        const auto input = hgt(3, 3, bits);
        const auto before = input;
        const auto terrain = openrtw::load_hgt(input);
        require(terrain.width == 3 && terrain.height == 3, "wrong dimensions");
        require(terrain.heightBits == bits, "height payload changed");
        for (std::uint32_t y = 0; y < 3; ++y)
            for (std::uint32_t x = 0; x < 3; ++x)
                require(std::bit_cast<std::uint32_t>(terrain.height_at(x, y)) == bits[y * 3 + x],
                        "height lookup changed bits or row order");
        require(input == before, "parser changed input");
    });
    test("terrain minimal odd rectangular grids", [] {
        auto a = openrtw::load_hgt(hgt(1, 1, {0x80000000}));
        require(std::bit_cast<std::uint32_t>(a.height_at(0, 0)) == 0x80000000,
                "negative zero lost");
        auto b = openrtw::load_hgt(hgt(1, 3, {0, 0x3f800000, 0x40000000}));
        require(b.height_at(0, 2) == 2.0f, "rectangular lookup failed");
    });
    test("terrain exact finite payload corpus", [] {
        std::vector<std::uint32_t> bits;
        std::uint32_t state = 0x9e3779b9;
        while (bits.size() < 33 * 33) {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            if ((state & 0x7f800000u) != 0x7f800000u)
                bits.push_back(state);
        }
        auto terrain = openrtw::load_hgt(hgt(33, 33, bits));
        require(terrain.heightBits == bits, "finite corpus altered");
    });
    test("terrain short dimensions and payloads refuse", [] {
        const auto full = hgt(3, 1, {0x3f800000, 0x40000000, 0x40400000});
        for (std::size_t n = 0; n < full.size(); ++n)
            refuses([&] { openrtw::load_hgt(std::span(full).first(n)); });
    });
    test("terrain zero even huge and sample-limit dimensions refuse", [] {
        for (auto dimensions : std::vector<std::pair<std::uint32_t, std::uint32_t>>{
                 {0, 1},
                 {1, 0},
                 {2, 1},
                 {1, 2},
                 {511, 312},
                 {0xffffffff, 0xffffffff},
                 {0x10001, 0x10001},
                 {openrtw::max_terrain_dimension + 2, 1},
                 {4097, 4097}})
            refuses([&] { openrtw::load_hgt(hgt(dimensions.first, dimensions.second)); });
    });
    test("terrain exact-length policy refuses trailing bytes", [] {
        auto input = hgt(1, 1, {0});
        input.push_back(0);
        refuses([&] { openrtw::load_hgt(input); });
        input.insert(input.end(), 3, 0);
        refuses([&] { openrtw::load_hgt(input); });
    });
    test("terrain all nonfinite classes refuse without input mutation", [] {
        for (std::uint32_t bits :
             {0x7f800000u, 0xff800000u, 0x7fc00000u, 0xffc01234u, 0x7f800001u, 0xff800001u}) {
            auto input = hgt(3, 1, {0, 0x3f800000, bits});
            const auto before = input;
            refuses([&] { openrtw::load_hgt(input); });
            require(input == before, "refusal changed input");
        }
    });
    test("terrain failure leaves caller output unchanged", [] {
        auto terrain = openrtw::load_hgt(hgt(1, 1, {0x80000000}));
        for (auto bad : {hgt(3, 1, {0, 0, 0x7f800001}), hgt(1, 1)}) {
            refuses([&] { terrain = openrtw::load_hgt(bad); });
            require(terrain.width == 1 && terrain.height == 1 &&
                        terrain.heightBits == std::vector<std::uint32_t>{0x80000000},
                    "partial terrain output escaped refusal");
        }
    });
    test("terrain coordinate and public-state misuse refuse safely", [] {
        auto terrain = openrtw::load_hgt(hgt(1, 1, {0}));
        refuses<std::out_of_range>([&] { terrain.height_at(1, 0); });
        refuses<std::out_of_range>([&] { terrain.height_at(0, 1); });
        refuses<std::out_of_range>([&] { terrain.height_at(0xffffffff, 0xffffffff); });
        terrain.heightBits.clear();
        refuses([&] { terrain.height_at(0, 0); });
        terrain.heightBits = {0x7f800000};
        refuses([&] { terrain.height_at(0, 0); });
    });
}

const std::string campaign_header = "campaign demo\nstart_date -270 summer\n";
const std::string faction_header = "faction romans_julii, comfortable caesar\ndenari 5000\n";
const std::string character_line =
    "character Flavius Julius, named character, leader, age 47, , x 89, y 82";

void campaign_tests(const std::function<void(const char*, std::function<void()>)>& test) {
    test("campaign exact subset and opaque unimplemented syntax", [] {
        const auto text =
            campaign_header + faction_header + character_line +
            "\ntraits GoodCommander 2\narmy\nunit roman hastati exp 1 armour 0 weapon_lvl 2\n";
        const auto result = openrtw::load_campaign(text);
        require(result.id == "demo" && result.startYear == -270 &&
                    result.startSeason == openrtw::Season::summer,
                "campaign header incorrect");
        require(result.factions.size() == 1, "faction count incorrect");
        const auto& faction = result.factions.front();
        require(faction.id == "romans_julii" && faction.denari == 5000 && faction.line == 3,
                "faction fields incorrect");
        require(faction.characters.size() == 1, "character count incorrect");
        const auto& character = faction.characters.front();
        require(character.name == "Flavius Julius" && character.type == "named character" &&
                    character.age == 47 && character.x == 89 && character.y == 82 &&
                    character.line == 5,
                "character fields incorrect");
        require(character.army.size() == 1, "army count incorrect");
        const auto& unit = character.army.front();
        require(unit.name == "roman hastati" && !unit.count && unit.experience == 1 &&
                    unit.armour == 0 && unit.weapon == 2 && unit.line == 8,
                "unit fields incorrect");
        bool flags = false, ai = false, traits = false;
        for (const auto& unknown : result.unsupported) {
            flags |= unknown.line == 5 && unknown.text == character_line;
            ai |= unknown.line == 3 && unknown.text == "faction romans_julii, comfortable caesar";
            traits |= unknown.line == 6 && unknown.text == "traits GoodCommander 2";
        }
        require(flags && ai && traits, "unimplemented flags/AI/traits lost");
    });
    test("campaign sub-faction prefix retained literally", [] {
        auto result = openrtw::load_campaign(
            campaign_header + "faction slave\ndenari 0\ncharacter sub_faction gauls, Brennus, "
                              "general, age 40, x 5, y 7\n"
                              "army\nunit barbarian warrior exp 0 armour 0 weapon_lvl 0\n");
        const auto& character = result.factions.front().characters.front();
        require(character.name == "Brennus" && character.type == "general" &&
                    character.subFaction == "gauls" && character.army.size() == 1,
                "literal sub-faction prefix misparsed");
    });
    test("campaign CRLF source lines and optional age", [] {
        auto result = openrtw::load_campaign(
            "; heading\r\ncampaign winter_demo\r\nstart_date 14 winter\r\n"
            "faction romans_julii\r\ndenari 0\r\ncharacter Spy, spy, x 1, y 2\r\n");
        require(result.startSeason == openrtw::Season::winter && result.startYear == 14,
                "winter header misparsed");
        const auto& character = result.factions.front().characters.front();
        require(!character.age && character.line == 6 && character.name == "Spy",
                "optional age or physical line count incorrect");
    });
    test("campaign nested unsupported blocks cannot attach typed records", [] {
        const std::string decoy = "character Decoy, spy, age 20, x 1, y 2";
        auto result = openrtw::load_campaign(
            campaign_header + faction_header + "settlement\n{\n" + decoy +
            "\n denari 999\n"
            " building\n {\n unit invented exp 0 armour 0 weapon_lvl 0\n }\n}\n" +
            character_line + "\n");
        require(result.factions.size() == 1 && result.factions[0].denari == 5000 &&
                    result.factions[0].characters.size() == 1 &&
                    result.factions[0].characters[0].name == "Flavius Julius",
                "unsupported block mutated typed state");
        bool retained = false;
        for (const auto& row : result.unsupported)
            retained |= row.text == decoy && row.line == 7;
        require(retained, "opaque block line lost");
    });
    test("campaign quoted opaque syntax cannot hide block boundaries", [] {
        for (const auto& opening : std::vector<std::string>{
                 "opaque \"a;b\" {", "opaque \"a\\\";b\" {", "opaque \"{;}\" {"}) {
            auto result = openrtw::load_campaign(
                campaign_header + faction_header + opening +
                "\ncharacter Decoy, spy, x 1, y 2\ndenari 999\n}\n" + character_line + "\n");
            require(result.factions.size() == 1 && result.factions.front().denari == 5000 &&
                        result.factions.front().characters.size() == 1 &&
                        result.factions.front().characters.front().name == "Flavius Julius",
                    "quoted semicolon or brace escaped opaque scope");
            bool retained = false;
            for (const auto& row : result.unsupported)
                retained |= row.text == opening;
            require(retained, "quoted opaque input not retained exactly");
        }
        refuses([&] {
            openrtw::load_campaign(campaign_header + faction_header + "opaque \"unterminated\n");
        });
        refuses([&] {
            openrtw::load_campaign(campaign_header + faction_header +
                                   "character \"Spy\", spy, x 1, y 2\n");
        });
        const auto commented = openrtw::load_campaign(
            campaign_header + faction_header + "opaque; \"unterminated comment is literal\n");
        require(commented.factions.size() == 1, "literal comment quote interpreted as syntax");
    });
    test("campaign owns text beyond input lifetime", [] {
        std::string text =
            campaign_header + faction_header + character_line + "\nopaque literal text\n";
        auto result = openrtw::load_campaign(text);
        text.assign(text.size(), 'x');
        require(result.id == "demo" &&
                    result.factions.front().characters.front().name == "Flavius Julius",
                "typed text borrowed input");
        bool retained = false;
        for (const auto& row : result.unsupported)
            retained |= row.text == "opaque literal text";
        require(retained, "opaque text borrowed input");
    });
    test("campaign malformed required headers and duplicates refuse", [] {
        for (const auto& text : std::vector<std::string>{
                 "", "campaign demo\n", "start_date -270 summer\n",
                 "campaign demo\ncampaign duplicate\nstart_date -270 summer\n",
                 "campaign demo\nstart_date -270 summer\nstart_date 1 winter\n",
                 "campaign demo\nstart_date 2147483648 summer\n",
                 "campaign demo\nstart_date -2147483649 summer\n",
                 "campaign demo\nstart_date 1.5 summer\n",
                 "campaign demo\nstart_date -270 autumn\n"})
            refuses([&] { openrtw::load_campaign(text); });
    });
    test("campaign missing duplicate overflowing faction money refuses", [] {
        for (const auto& suffix : std::vector<std::string>{
                 "faction romans_julii\n", "denari 5\n",
                 "faction romans_julii\ndenari 5\ndenari 6\n",
                 "faction romans_julii\ndenari 9223372036854775808\n",
                 "faction romans_julii\ndenari 1junk\n",
                 "faction romans_julii\ndenari 0\nfaction romans_julii\ndenari 1\n"})
            refuses([&] { openrtw::load_campaign(campaign_header + suffix); });
    });
    test("campaign malformed recognized character fields refuse", [] {
        for (const auto& row : std::vector<std::string>{
                 "character , spy, age 20, x 1, y 2", "character Spy, , age 20, x 1, y 2",
                 "character Spy, spy, age 20, x 1", "character Spy, spy, age 20, y 2",
                 "character Spy, spy, age 20, x 1, x 2, y 3",
                 "character Spy, spy, age 20, age 30, x 1, y 2",
                 "character Spy, spy, age 20, x 2147483648, y 2",
                 "character Spy, spy, age 20, x 1junk, y 2"})
            refuses([&] { openrtw::load_campaign(campaign_header + faction_header + row + "\n"); });
    });
    test("campaign orphan armies and malformed units refuse", [] {
        for (const auto& tail :
             std::vector<std::string>{"army\n", "unit roman hastati exp 1 armour 0 weapon_lvl 0\n"})
            refuses([&] { openrtw::load_campaign(campaign_header + faction_header + tail); });
        for (const auto& unit :
             std::vector<std::string>{"unit exp 1 armour 0 weapon_lvl 0",
                                      "unit roman hastati exp bad armour 0 weapon_lvl 0",
                                      "unit roman hastati exp 1 armour 2147483648 weapon_lvl 0",
                                      "unit roman hastati exp 1 armour 0 weapon_lvl 0 junk"})
            refuses([&] {
                openrtw::load_campaign(campaign_header + faction_header + character_line +
                                       "\narmy\n" + unit + "\n");
            });
    });
    test("campaign brace ambiguity and embedded controls refuse", [] {
        for (const auto& suffix : std::vector<std::string>{"}\n", "settlement\n{\n", "{\n"})
            refuses([&] { openrtw::load_campaign(campaign_header + faction_header + suffix); });
        auto text = campaign_header + faction_header;
        text.append("opaque\0injected", 15);
        refuses([&] { openrtw::load_campaign(text); });
    });
    test("campaign bounded input line and physical record limits", [] {
        refuses([&] {
            openrtw::load_campaign(std::string(openrtw::campaign_max_input_bytes + 1, ' '));
        });
        refuses([&] {
            openrtw::load_campaign(campaign_header +
                                   std::string(openrtw::campaign_max_line_bytes + 1, 'x'));
        });
        std::string lines = campaign_header;
        for (std::size_t i = 0; i < openrtw::campaign_max_records; ++i)
            lines += ";\n";
        refuses([&] { openrtw::load_campaign(lines); });
    });
    test("campaign repeated long contexts refuse within retained-text budget", [] {
        // ~13KiB input can otherwise expand beyond 16MiB of owned contexts.
        std::string text = campaign_header + "faction " + std::string(8192, 'a') + "\ndenari 0\n";
        for (unsigned i = 0; i < 2100; ++i)
            text += ";\n";
        require(text.size() < 32768, "resource refusal fixture is not modest");
        refuses([&] { openrtw::load_campaign(text); });
    });
    test("campaign late refusal leaves caller output unchanged", [] {
        auto result =
            openrtw::load_campaign(campaign_header + faction_header + character_line + "\n");
        refuses([&] {
            result = openrtw::load_campaign(campaign_header + faction_header + character_line +
                                            "\nfaction late\ndenari 9223372036854775808\n");
        });
        require(result.id == "demo" && result.factions.size() == 1 &&
                    result.factions.front().denari == 5000 &&
                    result.factions.front().characters.front().name == "Flavius Julius",
                "partial campaign state escaped refusal");
    });
}

void owned_campaign_test(const std::filesystem::path& root) {
    const auto bytes =
        read_owned(root / "data/world/maps/campaign/imperial_campaign/descr_strat.txt");
    require(bytes.size() == 126195, "owned campaign extent differs from pinned original");
    const auto result = openrtw::load_campaign(
        std::string_view(reinterpret_cast<const char*>(bytes.data()), bytes.size()));
    require(result.id == "imperial_campaign" && result.startYear == -270 &&
                result.startSeason == openrtw::Season::summer && result.factions.size() == 21,
            "owned campaign header/faction count differs");
    std::size_t characters = 0, units = 0, sub_factions = 0;
    for (const auto& faction : result.factions) {
        characters += faction.characters.size();
        for (const auto& character : faction.characters) {
            sub_factions += character.subFaction.has_value();
            units += character.army.size();
            for (const auto& unit : character.army)
                require(!unit.count && unit.experience && unit.armour && unit.weapon,
                        "owned army unit fields incomplete or count invented");
        }
    }
    std::cout << "OWNED campaign=imperial_campaign factions=" << result.factions.size()
              << " characters=" << characters << " units=" << units
              << " sub_factions=" << sub_factions << " unsupported=" << result.unsupported.size()
              << '\n';
    // Independent actual-line inventory proves 30 character prefixes; an
    // earlier expected count of 33 was an incorrect inventory assumption.
    require(characters == 177 && units == 535 && sub_factions == 30,
            "owned campaign typed records lost or invented");
    const auto& faction = result.factions.front();
    require(faction.id == "romans_julii" && faction.denari == 5000 && faction.line == 451,
            "owned first faction differs");
    const auto& character = faction.characters.front();
    require(character.name == "Flavius Julius" && character.type == "named character" &&
                character.age == 47 && character.x == 89 && character.y == 82 &&
                character.line == 520,
            "owned first character differs");
    require(character.army.size() == 5 &&
                character.army.front().name == "roman generals guard cavalry early",
            "owned first army differs");
}

} // namespace

int main() {
    unsigned passed = 0, failed = 0;
    const auto test = [&](const char* label, std::function<void()> action) {
        try {
            action();
            ++passed;
            std::cout << "PASS " << label << '\n';
        } catch (const std::exception& error) {
            ++failed;
            std::cerr << "FAIL " << label << ": " << error.what() << '\n';
        }
    };
    terrain_tests(test);
    campaign_tests(test);
    if (const char* root = std::getenv("OPENRTW_OWNED_GAME")) {
        test("owned original HGT matches all 159943 exact words", [&] {
            const auto bytes =
                read_owned(std::filesystem::path(root) / "data/world/maps/base/map_heights.hgt");
            require(bytes.size() == 639780, "owned HGT extent differs from pinned original");
            const auto terrain = openrtw::load_hgt(bytes);
            require(terrain.width == 511 && terrain.height == 313 &&
                        terrain.heightBits.size() == 159943,
                    "owned original dimensions changed");
            for (std::size_t i = 0; i < terrain.heightBits.size(); ++i)
                require(terrain.heightBits[i] == source_word(bytes, 8 + i * 4),
                        "owned original height word mismatch");
        });
        test("owned original campaign typed subset", [&] { owned_campaign_test(root); });
    } else
        std::cout << "SKIP owned asset checks: set OPENRTW_OWNED_GAME\n";
    std::cout << "RESULT passed=" << passed << " failed=" << failed << '\n';
    return failed ? 1 : 0;
}
