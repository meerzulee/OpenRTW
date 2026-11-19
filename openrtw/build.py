#!/usr/bin/env python3
"""Build the OpenRTW core, native viewer, or synthetic core tests."""

import argparse
import hashlib
import json
from pathlib import Path
import shlex
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
CORE = Path('openrtw/core')
WEB = Path('openrtw/platform/web')
NATIVE = Path('openrtw/platform/native')
TESTS = Path('openrtw/tests')
CORE_SOURCES = (
    'terrain.cpp',
    'campaign.cpp',
    'regions.cpp',
    'categories.cpp',
    'climates.cpp',
    'world_grid.cpp',
    'pcm.cpp',
    'aerial_ground_registry.cpp',
    'aerial_tile_table.cpp',
    'aerial_campaign_compositor.cpp',
    'aerial_mask_bank.cpp',
    'aerial_mask_weights.cpp',
    'aerial_material_support.cpp',
    'aerial_material_role.cpp',
    'aerial_normal_tile.cpp',
    'aerial_texture_pixels.cpp',
    'aerial_word_math.cpp',
    'aerial_decals.cpp',
    'faction_cultures.cpp',
    'campaign_trees.cpp',
    'culture_models.cpp',
    'settlement_models.cpp',
    'dds_texture.cpp',
    'cas_mesh.cpp',
    'battle_catalog.cpp',
    'campaign_production.cpp',
    'campaign_session.cpp',
    'campaign_fog.cpp',
    'campaign_fog_save.cpp',
    'battle_profile.cpp',
    'battle_encounter.cpp',
    'battle_session.cpp',
    'rome_battle_encounter.cpp',
)
WEB_SOURCES = (
    'cas_animation.cpp', 'campaign_shadows.cpp', 'campaign_fog_inputs.cpp', 'settlement_view.cpp',
)
WEB_EXPORTS = """
    _malloc _free _openrtw_api_version _openrtw_core_contract_json _openrtw_load_terrain
    _openrtw_load_campaign _openrtw_reset _openrtw_terrain_width _openrtw_terrain_height
    _openrtw_terrain_bits _openrtw_terrain_count _openrtw_campaign_json _openrtw_error
    _openrtw_load_regions _openrtw_load_region_map _openrtw_regions_json _openrtw_region_map_width
    _openrtw_region_map_height _openrtw_region_map_rgb _openrtw_region_map_bytes
    _openrtw_build_world_grid _openrtw_world_grid_json _openrtw_world_grid_indices
    _openrtw_world_grid_count _openrtw_load_ground_map _openrtw_build_categories _openrtw_category_width
    _openrtw_category_height _openrtw_category_count _openrtw_category_ids
    _openrtw_build_point_categories _openrtw_point_category_width _openrtw_point_category_height
    _openrtw_point_category_count _openrtw_point_category_ids _openrtw_load_climates
    _openrtw_load_climate_map _openrtw_build_climate_coefficients _openrtw_climates_json
    _openrtw_climate_width _openrtw_climate_height _openrtw_climate_count
    _openrtw_climate_coefficient_bits _openrtw_climate_source_ids _openrtw_load_pcm _openrtw_pcm_rate
    _openrtw_pcm_frames _openrtw_pcm_samples _openrtw_begin_campaign_session
    _openrtw_campaign_session_json _openrtw_move_character _openrtw_end_turn
    _openrtw_build_campaign_trees _openrtw_campaign_trees_json _openrtw_sync_aerial_decal_fog
    _openrtw_aerial_decal_dirty_pages _openrtw_load_campaign_fog_traits
    _openrtw_load_campaign_fog_ancillaries _openrtw_load_campaign_fog_features
    _openrtw_campaign_fog_json _openrtw_campaign_fog_data _openrtw_campaign_fog_size
    _openrtw_export_campaign_save _openrtw_campaign_save_bytes _openrtw_campaign_save_size
    _openrtw_import_campaign_save _openrtw_preview_campaign_route _openrtw_campaign_route_json
    _openrtw_move_campaign_route _openrtw_preview_campaign_advance _openrtw_campaign_advance_json
    _openrtw_advance_campaign_route _openrtw_set_campaign_destination
    _openrtw_cancel_campaign_destination _openrtw_continue_campaign_journey
    _openrtw_continue_campaign_faction_journeys _openrtw_campaign_faction_journeys_json
    _openrtw_export_campaign_journey_save _openrtw_import_campaign_journey_save
    _openrtw_load_unit_definitions _openrtw_load_battle_models _openrtw_battle_catalog_json
    _openrtw_campaign_army_json _openrtw_select_settlement _openrtw_clear_settlement
    _openrtw_settlement_inspection_json _openrtw_begin_battle _openrtw_battle_json _openrtw_battle_move
    _openrtw_battle_attack _openrtw_battle_hold _openrtw_step_battle _openrtw_retreat_battle
    _openrtw_leave_battle _openrtw_export_battle_save _openrtw_battle_save_bytes
    _openrtw_battle_save_size _openrtw_import_battle_save _openrtw_export_campaign_battle_save
    _openrtw_import_campaign_battle_save _openrtw_load_production_catalog _openrtw_production_json
    _openrtw_production_command _openrtw_load_dds_texture _openrtw_dds_texture_json
    _openrtw_dds_texture_source_bytes _openrtw_dds_texture_source_size
    _openrtw_load_dds_texture_legacy_flags _openrtw_load_cas_mesh_repeated_static_count312
    _openrtw_load_cas_mesh_terminal_kind7_316 _openrtw_load_cas_mesh_rider_repeated_count312
    _openrtw_load_cas_mesh_empty_static305 _openrtw_load_cas_animation _openrtw_cas_animation_json
    _openrtw_cas_animation_source_bytes _openrtw_cas_animation_source_size
    _openrtw_select_cas_animation_frame _openrtw_cas_animation_frame_json
    _openrtw_load_cas_animation_standing11 _openrtw_load_cas_mesh_any _openrtw_load_culture_models
    _openrtw_load_settlement_buildings _openrtw_build_settlement_models _openrtw_settlement_models_json
    _openrtw_settlement_symbol_path _openrtw_set_settlement_symbol_anchor _openrtw_load_cas_mesh
    _openrtw_cas_mesh_json _openrtw_cas_mesh_source_bytes _openrtw_cas_mesh_source_size
    _openrtw_build_campaign_shadow_volume _openrtw_campaign_shadow_json
    _openrtw_load_aerial_ground_types _openrtw_aerial_ground_json _openrtw_load_aerial_ground_texture
    _openrtw_load_aerial_weight_pattern _openrtw_build_aerial_compositor _openrtw_compose_aerial_page
    _openrtw_aerial_page_pixels _openrtw_aerial_page_bytes _openrtw_compose_aerial_tile
    _openrtw_aerial_tile_pixels _openrtw_load_aerial_bases _openrtw_load_cultures
    _openrtw_load_faction_cultures _openrtw_load_aerial_base_image _openrtw_aerial_bases_json
    _openrtw_build_aerial_decals _openrtw_aerial_decals_json _openrtw_aerial_flattened_count
    _openrtw_aerial_flattened_points
""".split()


def file_record(path, data):
    return {'path': str(path), 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--target', choices=('wasm', 'native', 'audio', 'tests', 'production-tests'), default='wasm')
    args = parser.parse_args()
    out = args.out.resolve()
    if not out.is_relative_to(ROOT / 'local'):
        parser.error('Build output must be under this checkout local/')
    if out.exists():
        parser.error('Choose a fresh build output directory')

    compiler = shutil.which('em++') if args.target == 'wasm' else shutil.which('clang++') or shutil.which('c++')
    if not compiler:
        parser.error('Install Emscripten for the WASM build or a C++20 compiler for native builds')

    flags = []
    headers = []
    if args.target == 'wasm':
        sources = [CORE / name for name in CORE_SOURCES + WEB_SOURCES] + [WEB / 'api.cpp']
        headers.append(WEB / 'cas-animation-json.hpp')
        binary = out / 'openrtw-core.mjs'
        flags = [
            '--no-entry', '-fexceptions', '-sDISABLE_EXCEPTION_CATCHING=0', '-sABORTING_MALLOC=0',
            '-sMODULARIZE=1', '-sEXPORT_ES6=1', '-sENVIRONMENT=web,node', '-sALLOW_MEMORY_GROWTH=1',
            '-sINITIAL_MEMORY=16777216', '-sMAXIMUM_MEMORY=268435456',
            '-sEXPORTED_FUNCTIONS=' + json.dumps(WEB_EXPORTS),
            '-sEXPORTED_RUNTIME_METHODS=' + json.dumps(['HEAPU8', 'UTF8ToString']),
        ]
    elif args.target == 'native':
        sources = [CORE / name for name in CORE_SOURCES] + [NATIVE / 'main.cpp']
        headers.append(NATIVE / 'campaign_save_file.hpp')
        binary = out / 'openrtw-native'
    elif args.target == 'audio':
        sources = [CORE / 'pcm.cpp', NATIVE / 'audio.cpp']
        binary = out / 'openrtw-audio'
    elif args.target == 'production-tests':
        sources = [CORE / name for name in ('campaign.cpp', 'battle_catalog.cpp', 'campaign_production.cpp')]
        sources.append(TESTS / 'campaign_production_correctness_tests.cpp')
        binary = out / 'openrtw-production-tests'
    else:
        sources = [CORE / 'terrain.cpp', CORE / 'campaign.cpp', TESTS / 'core_tests.cpp']
        binary = out / 'openrtw-core-tests'

    if args.target in ('native', 'audio'):
        try:
            flags = shlex.split(subprocess.check_output(['pkg-config', '--cflags', '--libs', 'sdl2'], text=True))
        except (OSError, subprocess.CalledProcessError):
            parser.error('Install pkg-config and the SDL2 development files for native builds')

    headers.extend(path.relative_to(ROOT) for path in sorted((ROOT / CORE).glob('*.hpp')))
    files = {path: (ROOT / path).read_bytes() for path in sources + headers}
    if any((ROOT / path).read_bytes() != data for path, data in files.items()):
        parser.error('Source changed while snapshotting; retry with stable source files')
    out.mkdir(parents=True)
    frozen = out / 'sources'
    for path, data in files.items():
        copy = frozen / path
        copy.parent.mkdir(parents=True, exist_ok=True)
        copy.write_bytes(data)

    command = [compiler, '-std=c++20', '-O2', '-Wall', '-Wextra', '-Werror', '-I' + str(frozen / CORE),
               *(str(frozen / path) for path in sources), *flags, '-o', str(binary)]
    log_path = out / 'build.log'
    with log_path.open('w') as log:
        result = subprocess.run(command, stdout=log, stderr=log)
    if result.returncode:
        parser.exit(result.returncode, f'Build failed. See {log_path}\n')

    receipt = {
        'schema': 'openrtw-build-v2',
        'target': args.target,
        'compiler': subprocess.check_output([compiler, '--version'], text=True).splitlines()[0],
        'sources': [file_record(path, data) for path, data in files.items()],
        'binary': file_record(binary.name, binary.read_bytes()),
    }
    if args.target == 'wasm':
        wasm = binary.with_suffix('.wasm')
        receipt['wasm'] = file_record(wasm.name, wasm.read_bytes())
    (out / 'manifest.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps({'out': str(out), 'binary': str(binary)}))


if __name__ == '__main__':
    main()
