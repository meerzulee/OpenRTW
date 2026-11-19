# OpenRTW

OpenRTW is an experimental engine for **Rome: Total War**. The campaign and
battle logic lives in a portable C++ core that also compiles to WebAssembly.
The browser preview reads game files on your device. Bring your own copy of
Rome: Total War. The verified installation profile targets the original GOG 1.5
release. Other editions can try the unverified Data preview.

## Development progress

### Working today

- [x] Explore the 3D campaign map with fog of war and a minimap.
- [x] Inspect settlements, armies, and building trees.
- [x] Move armies and advance turns using prototype campaign rules.
- [x] Queue construction and recruitment in your settlements using prototype
  production rules.
- [x] Save and load an OpenRTW campaign in the same browser.
- [x] Select formations and issue move and attack orders in prototype battles.

### Still to do

- [ ] Match the original movement and turn rules.
- [ ] Match the original economy, construction, and recruitment rules.
- [ ] Complete diplomacy and strategic AI.
- [ ] Complete tactical combat, morale, and sieges.
- [ ] Apply battle outcomes to the campaign.
- [ ] Bring rendering, animation, interface, and audio closer to the original.
- [ ] Support original save files and replays.
- [ ] Implement multiplayer.

## Run locally

Use Linux with Git, Python 3.12 or later, Node.js 22 or later, and a current
Emscripten SDK. Use a browser with WebGL 2 and folder selection support, such as
Chromium.

From the repository root, clone the public renderer dependency once:

```sh
mkdir -p vendor
git clone --no-checkout https://github.com/meerzulee/dvijoke.git vendor/dvijoke
```

Build and serve the browser preview:

```sh
python3 openrtw/build.py --target wasm --out local/openrtw-preview/core
python3 renderer/build.py --out local/openrtw-preview/renderer
python3 openrtw/package_web.py \
  --core-build local/openrtw-preview/core \
  --renderer-build local/openrtw-preview/renderer \
  --out local/openrtw-preview/web
python3 -m http.server 8772 --bind 127.0.0.1 --directory local/openrtw-preview/web
```

Open the local preview and choose your game installation folder. To try the
unverified mode, choose **Unverified Data preview** and select the game's
`Data` folder. Use fresh output directories when rebuilding.
[Open the preview](http://127.0.0.1:8772/)

## Tests

```sh
npm test
python3 openrtw/build.py --target tests --out local/core-tests
local/core-tests/openrtw-core-tests
python3 openrtw/build.py --target production-tests --out local/production-tests
local/production-tests/openrtw-production-tests
```

The C++ tests need a C++20 compiler. To build the optional native terrain viewer,
install SDL2 development headers and `pkg-config`, then use `--target native`.

## Third-party software

The renderer builds against a pinned Dvijoke revision. Its MIT license is
included in the browser export. OpenRTW is an independent project.
[Dvijoke license](renderer/LICENSE.dvijoke)
