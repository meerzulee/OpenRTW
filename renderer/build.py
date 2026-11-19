#!/usr/bin/env python3
"""Build the OpenRTW WebGL 2 renderer with the pinned Dvijoke backend."""

import argparse
import hashlib
import io
import json
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]
VENDOR = ROOT / 'vendor/dvijoke'
PIN = 'dd699bf133ca820833150c373be892e3efb78e69'
PATCHES = (
    'patches/dvijoke-indexed-triangle-fan.patch',
    'patches/dvijoke-index-buffer-promotion.patch',
    'patches/dvijoke-renderer-state-lifecycle.patch',
    'patches/dvijoke-renderer-raster.patch',
    'patches/dvijoke-null-texture-operands.patch',
    'patches/dvijoke-dither-x8.patch',
    'patches/dvijoke-render-targets.patch',
    'patches/dvijoke-device-lifecycle.patch',
    'patches/dvijoke-vertex-programs.patch',
    'patches/dvijoke-ambient-material-lighting.patch',
    'patches/dvijoke-dxt-endpoint-bit-replication.patch',
    'patches/dvijoke-dxt-native-color-palette.patch',
    'renderer/patches/dvijoke-texture-base-alpha.patch',
    'renderer/patches/dvijoke-texture-color-lod-bias.patch',
)


def file_record(path):
    data = path.read_bytes()
    return {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    out = args.out.resolve()
    if not out.is_relative_to(ROOT / 'local'):
        parser.error('Build output must be under this checkout local/')
    if out.exists():
        parser.error('Choose a fresh build output directory')
    if not VENDOR.is_dir():
        parser.error('Clone the public Dvijoke dependency into vendor/dvijoke as shown in the README')
    compiler = shutil.which('em++')
    if not compiler:
        parser.error('Install Emscripten before building the renderer')

    header = ROOT / 'renderer/renderer.h'
    source = ROOT / 'renderer/renderer.cpp'
    exports = ['_malloc', '_free'] + ['_' + name for name in re.findall(r'\b(rome_renderer_v1_\w+)\(', header.read_text())]
    archive = subprocess.run(['git', '-C', str(VENDOR), 'archive', PIN, 'd8web'], capture_output=True)
    if archive.returncode:
        parser.error(f'Update vendor/dvijoke to make the pinned revision {PIN} available')
    out.mkdir(parents=True)
    with tempfile.TemporaryDirectory(prefix='openrtw-renderer-') as tmp:
        tree = Path(tmp) / 'd8web'
        with tarfile.open(fileobj=io.BytesIO(archive.stdout)) as files:
            files.extractall(tmp, filter='data')
        subprocess.run(['git', '-C', tmp, 'apply', *(str(ROOT / patch) for patch in PATCHES)], check=True)
        src = tree / 'src'
        backend = src / 'backends/webgl2/gl_backend.cpp'
        emitter = src / 'backends/webgl2/glsl_emitter.cpp'
        subprocess.run([
            compiler, '-std=c++20', '-O2', '-Wall', '-Wextra', '-fexceptions', '-DROME_RASTER_VALIDATED=1',
            '-I' + str(src), '-I' + str(tree / 'include'), str(source), str(backend), str(emitter),
            '--no-entry', '-sMODULARIZE=1', '-sEXPORT_ES6=1', '-sEXPORT_NAME=createRomeRenderer',
            '-sENVIRONMENT=web', '-sMIN_WEBGL_VERSION=2', '-sMAX_WEBGL_VERSION=2', '-sALLOW_MEMORY_GROWTH=1',
            '-sGROWABLE_ARRAYBUFFERS=0', '-sDISABLE_EXCEPTION_CATCHING=0', '-sABORTING_MALLOC=0',
            '-sASSERTIONS=1', '-sGL_ASSERTIONS=1', '-sEXPORTED_FUNCTIONS=' + json.dumps(exports),
            '-sEXPORTED_RUNTIME_METHODS=' + json.dumps(['HEAPU8', 'UTF8ToString']), '-o', str(out / 'renderer.mjs'),
        ], check=True)
        metadata = {
            'schema': 'rome-renderer-build-v1',
            'abiVersion': 1,
            'revision': PIN,
            'compiler': subprocess.check_output([compiler, '--version'], text=True).splitlines()[0],
            'sources': {path.name: file_record(path) for path in (source, header, backend, emitter)},
            'patches': {patch: file_record(ROOT / patch) for patch in PATCHES},
            'artifacts': {name: file_record(out / name) for name in ('renderer.mjs', 'renderer.wasm')},
        }
    (out / 'manifest.json').write_text(json.dumps(metadata, indent=2) + '\n')
    print(json.dumps({'out': str(out), 'wasmBytes': metadata['artifacts']['renderer.wasm']['bytes']}))


if __name__ == '__main__':
    main()
