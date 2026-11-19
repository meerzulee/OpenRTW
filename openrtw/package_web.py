#!/usr/bin/env python3
"""Export engine files for static hosting; players supply their own game data."""
import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def verified_build_receipt(directory, kind, frozen):
    """Bind selected payloads to their trusted local build receipt, not paths.

    Only the digest and ABI summary leave local/: source paths, compiler command
    lines and native reference material in a build tree are never exported.
    This checks consistency, not authenticity of a user-edited receipt.
    """
    with (directory / 'manifest.json').open('rb') as source:
        raw = source.read(2 * 1024 * 1024 + 1)
    if len(raw) > 2 * 1024 * 1024:
        raise ValueError(kind + ' build receipt exceeds its bound')
    try:
        receipt = json.loads(raw)
    except (ValueError, RecursionError) as error:
        raise ValueError(kind + ' build receipt is malformed') from error
    if not isinstance(receipt, dict):
        raise ValueError(kind + ' build receipt must be an object')
    if kind == 'core':
        if receipt.get('schema') != 'openrtw-build-v2' or receipt.get('target') != 'wasm':
            raise ValueError('Core export requires an OpenRTW WASM build receipt')
        records = {
            'core/openrtw-core.mjs': receipt.get('binary'),
            'core/openrtw-core.wasm': receipt.get('wasm'),
        }
        summary = {'schema': receipt['schema'], 'target': 'wasm'}
    else:
        if receipt.get('schema') != 'rome-renderer-build-v1' or type(receipt.get('abiVersion')) is not int or receipt['abiVersion'] != 1:
            raise ValueError('Renderer export requires the supported renderer ABI 1 receipt')
        artifacts = receipt.get('artifacts')
        if not isinstance(artifacts, dict):
            raise ValueError('Renderer build receipt is missing artifacts')
        records = {'renderer/' + name: artifacts.get(name) for name in ['renderer.mjs', 'renderer.wasm']}
        summary = {'schema': receipt['schema'], 'abiVersion': 1}
    for name, record in records.items():
        if not isinstance(record, dict) or type(record.get('bytes')) is not int or not isinstance(record.get('sha256'), str) or not re.fullmatch('[a-f0-9]{64}', record['sha256']):
            raise ValueError('Invalid build artifact record: ' + name)
        payload = frozen[name]
        if record['bytes'] != len(payload) or record['sha256'] != hashlib.sha256(payload).hexdigest():
            raise ValueError('Build receipt does not match selected artifact: ' + name)
    summary['receiptSha256'] = hashlib.sha256(raw).hexdigest()
    summary['artifacts'] = {
        name: {'bytes': record['bytes'], 'sha256': record['sha256']}
        for name, record in records.items()
    }
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--core-build', type=Path, required=True)
    parser.add_argument('--renderer-build', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--standing-pose-preview', action=argparse.BooleanOptionalAction, default=True, help='Use the selected original standing pose from player files (default: enabled)')
    parser.add_argument('--battle-assets-preview', action='store_true', help='Enable selected original battle models using player files')
    parser.add_argument('--infantry-standing-pose-preview', action='store_true', help='Enable source-bound infantry frame-zero poses using player files')
    args = parser.parse_args()
    if args.infantry_standing_pose_preview and not args.battle_assets_preview:
        parser.error('Infantry standing poses require --battle-assets-preview')
    out = args.out.resolve()
    try:
        out.relative_to(ROOT / 'local')
    except ValueError:
        parser.error('Choose a fresh output directory under this checkout local/')
    if out.exists():
        parser.error('Output already exists; choose a fresh directory')
    web = ROOT / 'openrtw/platform/web'
    core, renderer = args.core_build.resolve(), args.renderer_build.resolve()
    sources = {
        'index.html': web / 'index.html',
        'LICENSE.dvijoke': ROOT / 'renderer/LICENSE.dvijoke',
        **{name: web / name for name in ['app.js', 'audio.js', 'campaign-storage.js', 'unit-preview.js', 'cas-geometry.js', 'cas-profile-geometry.js', 'vegetation-assets.js', 'vegetation-geometry.js', 'campaign-vegetation.js', 'cas-animation.js', 'infantry-standing-animation.js', 'infantry-standing-skeleton.js', 'infantry-standing-source-assets.js', 'infantry-standing-pose.js', 'infantry-standing-pose-assets.js', 'standing-source-assets.js', 'campaign-standing-pose.js', 'terrain-material-source.js', 'campaign-model.js', 'campaign-scene.js', 'aerial-terrain-pages.js', 'terrain-appearance.js', 'campaign-water.js', 'town-assets.js', 'campaign-settlements.js', 'settlement-model-assets.js', 'campaign-settlement-models.js', 'battle-scene.js', 'battle-assets.js', 'battle-source-assets.js', 'battle-view.js', 'unit-texture.js', 'water-texture.js', 'unit-card-image.js', 'texture-image.js', 'hud-sprites.js', 'campaign-hud.js', 'game-assets.js']},
        'settlement-labels.js': web / 'settlement-labels.js',
        'cuf-font.js': web / 'cuf-font.js',
        'campaign-fog.js': web / 'campaign-fog.js',
        'campaign-shadows.js': web / 'campaign-shadows.js',
        'campaign-shadow-scene.js': web / 'campaign-shadow-scene.js',
        'campaign-idle-pose.js': web / 'campaign-idle-pose.js',
        'campaign-coastline.js': web / 'campaign-coastline.js',
        'coastline-texture.js': web / 'coastline-texture.js',
        'campaign-tree-assets.js': web / 'campaign-tree-assets.js',
        'campaign-trees.js': web / 'campaign-trees.js',
        'campaign-banner-assets.js': web / 'campaign-banner-assets.js',
        'campaign-banners.js': web / 'campaign-banners.js',
        'campaign-fog-renderer.js': web / 'campaign-fog-renderer.js',
        'campaign-camera-reference.js': web / 'campaign-camera-reference.js',
        'campaign-cursor.js': web / 'campaign-cursor.js',
        'campaign-interactions.js': web / 'campaign-interactions.js',
        'campaign-movement-range.js': web / 'campaign-movement-range.js',
        'campaign-camera-keys.js': web / 'campaign-camera-keys.js',
        'campaign-minimap.js': web / 'campaign-minimap.js',
        'campaign-radar-map.js': web / 'campaign-radar-map.js',
        'campaign-building-manifest.js': web / 'campaign-building-manifest.js',
        'campaign-building-assets.js': web / 'campaign-building-assets.js',
        'campaign-building-view.js': web / 'campaign-building-view.js',
        'campaign-travel.js': web / 'campaign-travel.js',
        'campaign-walking-pose.js': web / 'campaign-walking-pose.js',
        'reference/renderer-bridge.js': ROOT / 'web/renderer-bridge.js',
        'core/openrtw-core.mjs': core / 'openrtw-core.mjs',
        'core/openrtw-core.wasm': core / 'openrtw-core.wasm',
        'renderer/renderer.mjs': renderer / 'renderer.mjs',
        'renderer/renderer.wasm': renderer / 'renderer.wasm',
    }
    frozen = {}
    for name in [
        'runtime/game-profile-registry.js',
        'runtime/save-envelope.js',
        'runtime/indexeddb-store.js',
        'runtime/pcm-audio-output.js',
        'runtime/texture-resource.js',
        'runtime/resource-data.js',
        'runtime/geometry-resource.js',
        'runtime/session-runtime.js',
        'runtime/failure.js',
        'runtime/fixed-step-clock.js',
        'runtime/asset-read-scope.js',
        'runtime/trusted-game-bundle.js',
        'games/rome-original/core-session.js',
        'games/rome-original/profile.js',
        'games/rome-original/checkpoint-storage.js',
        'games/rome-original/checkpoint-actions.js',
        'games/rome-original/production-view.js',
        'games/rome-original/production-settlement-refresh.js',
        'games/rome-original/production-rules.js',
        'games/rome-original/launch-profile.js',
        'games/rome-original/bundle.js',
        'games/rome-original/bundle-loader.js',
    ]:
        sources[name] = web / name
    for name, path in sources.items():
        with path.open('rb') as source:
            data = source.read(16 * 1024 * 1024 + 1)
        if len(data) > 16 * 1024 * 1024:
            parser.error('Engine file exceeds export bound: ' + name)
        if name.endswith('.wasm') and not data.startswith(b'\0asm\x01\0\0\0'):
            parser.error('Invalid engine WebAssembly file: ' + name)
        frozen[name] = data
    try:
        builds = {
            'core': verified_build_receipt(core, 'core', frozen),
            'renderer': verified_build_receipt(renderer, 'renderer', frozen),
        }
        inspection = subprocess.run(
            ['node', str(ROOT / 'openrtw/tools/inspect_web_core.mjs'), str(core)],
            capture_output=True, timeout=30, check=False,
        )
        if inspection.returncode != 0:
            parser.error('Core compatibility inspection failed: ' + inspection.stderr[:2048].decode('utf-8', errors='replace').strip())
        if len(inspection.stdout) > 32 * 1024:
            parser.error('Core compatibility metadata exceeds its bound')
        inspected = json.loads(inspection.stdout)
        if not isinstance(inspected, dict) or inspected.get('schema') != 'openrtw-core-build-compatibility-v1' or not isinstance(inspected.get('contract'), dict):
            parser.error('Invalid core compatibility inspection result')
        contract = inspected['contract']
        bundle = inspected.get('bundle')
        if not isinstance(bundle, dict) or bundle.get('schema') != 'openrtw.trusted-game-bundle/v1':
            parser.error('Core inspection is missing its trusted bundle declaration')
        if any(bundle.get(field) != contract.get(field) for field in ['gameId', 'hostApiVersion', 'rulesVersion']):
            parser.error('Trusted bundle and compiled core identities differ')
        if bundle.get('interfaces', {}).get('coreContract') != contract.get('schema'):
            parser.error('Trusted bundle and compiled core contract schemas differ')
        if bundle.get('build') != {'target': 'wasm', 'module': 'core/openrtw-core.mjs', 'wasm': 'core/openrtw-core.wasm'}:
            parser.error('Trusted bundle does not describe the selected core artifacts')
        builds['core']['compatibility'] = contract
        builds['core']['bundleId'] = bundle['bundleId']
    except subprocess.TimeoutExpired:
        parser.error('Core compatibility inspection timed out')
    except (OSError, ValueError) as error:
        parser.error(str(error))
    # Include the inspection in the capture window: it imports the same title
    # profile/adapter and module bytes that will be written into the bundle.
    for name, path in sources.items():
        with path.open('rb') as source:
            checked = source.read(16 * 1024 * 1024 + 1)
        if checked != frozen[name]:
            parser.error('Engine sources changed during export')
    config = {'developmentAssets': False}
    config['standingPosePreview'] = args.standing_pose_preview
    if args.battle_assets_preview:
        config['battleAssetsPreview'] = True
    if args.infantry_standing_pose_preview:
        config['infantryStandingPosePreview'] = True
    frozen['config.json'] = json.dumps(config).encode()
    out.mkdir(parents=True)
    for name, data in frozen.items():
        path = out / name
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open('xb') as target:
            target.write(data)
    manifest = {
        'schema': 'openrtw-engine-only-web-export-v1',
        'implementation': {'gameId': builds['core']['compatibility']['gameId'],
                           'hostApiVersion': builds['core']['compatibility']['hostApiVersion'],
                           'rulesVersion': builds['core']['compatibility']['rulesVersion'],
                           'bundleId': inspected['bundle']['bundleId'],
                           'entrypoint': 'app.js',
                           'profileModule': 'games/rome-original/profile.js',
                           'bundleModule': 'games/rome-original/bundle.js'},
        'bundle': inspected['bundle'],
        'builds': builds,
        'gameAssetsIncluded': False,
        'assetSource': 'Player-selected local game folder; no hosted asset fallback.',
        'files': {name: {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()} for name, data in frozen.items()},
    }
    with (out / 'engine-manifest.json').open('x') as target:
        json.dump(manifest, target, indent=2)
        target.write('\n')
    print(json.dumps({'out': str(out), 'files': len(frozen), 'gameAssetsIncluded': False}))


if __name__ == '__main__':
    main()
