import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { romeOriginalProfile } from '../platform/web/games/rome-original/profile.js';
import { romeOriginalBundle } from '../platform/web/games/rome-original/bundle.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const scratchRoot = path.join(root, 'local', 'scratch');
await fs.mkdir(scratchRoot, { recursive: true });
const scratch = await fs.mkdtemp(path.join(scratchRoot, 'engine-export-'));
const core = path.join(scratch, 'core'), renderer = path.join(scratch, 'renderer');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
let counter = 0, passed = 0;
// Public synthetic empty WASM and metadata stubs test receipt/export consistency
// and compatibility admission only. Real core/renderer behavior is separate.
const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
const contract = { schema: 'openrtw-core-contract-v1', apiVersion: 1,
  gameId: romeOriginalProfile.gameId, hostApiVersion: romeOriginalProfile.hostApiVersion,
  rulesVersion: romeOriginalProfile.rulesVersion, publicationModel: 'module-owned-slots-v1' };
const js = Buffer.from(`export default async function fixture() {
  const contract = ${JSON.stringify(contract)};
  const heap = new Uint8Array(2048);
  heap.set(new TextEncoder().encode(JSON.stringify(contract)), 32);
  return { HEAPU8: heap, _openrtw_reset() {},
    _openrtw_api_version: () => 1, _openrtw_core_contract_json: () => 32 };
}\n`);
const record = (bytes) => ({ bytes: bytes.length, sha256: sha256(bytes) });
const coreReceipt = () => ({ schema: 'openrtw-build-v2', target: 'wasm',
  binary: { ...record(js), path: '/private/build/openrtw-core.mjs' },
  wasm: { ...record(wasm), path: '/private/build/openrtw-core.wasm' },
  sources: [{ path: '/private/not-for-export/owned.CAS' }] });
const rendererReceipt = () => ({ schema: 'rome-renderer-build-v1', abiVersion: 1,
  artifacts: { 'renderer.mjs': record(js), 'renderer.wasm': record(wasm) } });

async function reset() {
  for (const dir of [core, renderer]) await fs.mkdir(dir, { recursive: true });
  for (const [dir, base] of [[core, 'openrtw-core'], [renderer, 'renderer']]) {
    await fs.writeFile(path.join(dir, base + '.mjs'), js);
    await fs.writeFile(path.join(dir, base + '.wasm'), wasm);
  }
  await fs.writeFile(path.join(core, 'manifest.json'), JSON.stringify(coreReceipt()));
  await fs.writeFile(path.join(renderer, 'manifest.json'), JSON.stringify(rendererReceipt()));
}
async function pack(expectedError) {
  const out = path.join(scratch, 'out-' + ++counter);
  const result = spawnSync('python3', ['openrtw/package_web.py', '--core-build', core,
    '--renderer-build', renderer, '--out', out], { cwd: root, encoding: 'utf8', timeout: 30000 });
  assert.ifError(result.error);
  if (expectedError) {
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stderr, expectedError);
    await assert.rejects(fs.stat(out), { code: 'ENOENT' });
    return;
  }
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return { out, manifest: JSON.parse(await fs.readFile(path.join(out, 'engine-manifest.json'), 'utf8')) };
}
async function test(name, run) {
  await reset();
  await run();
  passed++;
  console.log('PASS ' + name);
}
try {
  await test('export binds both module pairs without copying private receipt paths', async () => {
    const { out, manifest } = await pack();
    assert.equal(manifest.implementation.gameId, romeOriginalProfile.gameId);
    assert.equal(manifest.implementation.rulesVersion, romeOriginalProfile.rulesVersion);
    assert.equal(manifest.implementation.bundleId, romeOriginalBundle.bundleId);
    assert.equal(manifest.implementation.bundleModule, 'games/rome-original/bundle.js');
    assert.deepEqual(manifest.bundle, romeOriginalBundle);
    assert.equal(manifest.builds.core.bundleId, romeOriginalBundle.bundleId);
    assert.deepEqual(manifest.builds.core.compatibility, contract);
    assert.equal(manifest.gameAssetsIncluded, false);
    assert.equal(manifest.builds.core.target, 'wasm');
    assert.equal(manifest.builds.renderer.abiVersion, 1);
    assert.equal(manifest.builds.core.receiptSha256, sha256(await fs.readFile(path.join(core, 'manifest.json'))));
    assert.ok(!JSON.stringify(manifest).includes('/private/'));
    for (const [name, pin] of Object.entries(manifest.files)) {
      const bytes = await fs.readFile(path.join(out, name));
      assert.deepEqual(record(bytes), pin);
      assert.ok(!/\.CAS$|RomeTW\.exe$|\.i64$|\.gpr$|\/sources\//i.test(name));
    }
    for (const build of Object.values(manifest.builds))
      for (const [name, pin] of Object.entries(build.artifacts)) assert.deepEqual(pin, manifest.files[name]);
    assert.equal(JSON.parse(await fs.readFile(path.join(out, 'config.json'))).developmentAssets, false);
  });
  await test('unlisted game payload beside a trusted build cannot join the engine export', async () => {
    const marker = 'synthetic-selected-game-payload-must-not-be-packaged';
    for (const dir of [core, renderer]) {
      await fs.mkdir(path.join(dir, 'data'), { recursive: true });
      for (const name of ['RomeTW.exe', 'Autosave.sav', 'data/export_descr_unit.txt', 'mod.js'])
        await fs.writeFile(path.join(dir, name), marker);
    }
    const { out, manifest } = await pack();
    for (const name of Object.keys(manifest.files)) {
      assert(!/RomeTW|Autosave|export_descr_unit|mod\.js/.test(name));
      assert(!(await fs.readFile(path.join(out, name))).includes(Buffer.from(marker)), name);
    }
    assert.equal(manifest.gameAssetsIncluded, false);
  });
  await test('changed core and renderer artifacts refuse before output creation', async () => {
    for (const [dir, name] of [[core, 'openrtw-core.mjs'], [core, 'openrtw-core.wasm'],
      [renderer, 'renderer.mjs'], [renderer, 'renderer.wasm']]) {
      await reset();
      await fs.appendFile(path.join(dir, name), Buffer.from([0]));
      await pack(/does not match selected artifact/);
    }
  });
  await test('native or unknown core receipt cannot be packaged as WASM', async () => {
    for (const change of [{ target: 'native' }, { schema: 'other-build' }]) {
      await fs.writeFile(path.join(core, 'manifest.json'), JSON.stringify({ ...coreReceipt(), ...change }));
      await pack(/WASM build receipt/);
    }
  });
  await test('unknown renderer ABI and malformed artifact records refuse', async () => {
    for (const abiVersion of [2, true, '1']) {
      await fs.writeFile(path.join(renderer, 'manifest.json'), JSON.stringify({ ...rendererReceipt(), abiVersion }));
      await pack(/supported renderer ABI/);
    }
    for (const pin of [null, { bytes: true, sha256: '0'.repeat(64) }, { bytes: wasm.length, sha256: 'invalid' }]) {
      const receipt = rendererReceipt();
      receipt.artifacts['renderer.wasm'] = pin;
      await fs.writeFile(path.join(renderer, 'manifest.json'), JSON.stringify(receipt));
      await pack(/Invalid build artifact record/);
    }
  });
  await test('missing, malformed and oversized receipts refuse before output creation', async () => {
    await fs.rm(path.join(core, 'manifest.json'));
    await pack(/manifest.json/);
    for (const text of ['[', '[]', '['.repeat(2000) + ']'.repeat(2000), ' '.repeat(2 * 1024 * 1024 + 1)]) {
      await fs.writeFile(path.join(core, 'manifest.json'), text);
      await pack(/receipt (?:is malformed|must be an object|exceeds its bound)/);
    }
  });
  await test('matching receipt hashes cannot hide incompatible core API or rules', async () => {
    for (const [changed, expectedError] of [
      [js.toString().replace('_openrtw_api_version: () => 1', '_openrtw_api_version: () => 2'), /API version is incompatible/],
      [js.toString().replace(JSON.stringify(contract.rulesVersion), '"other-rules-version"'), /does not match the selected implementation/],
    ]) {
      const bytes = Buffer.from(changed);
      await fs.writeFile(path.join(core, 'openrtw-core.mjs'), bytes);
      await fs.writeFile(path.join(core, 'manifest.json'), JSON.stringify({ ...coreReceipt(), binary: record(bytes) }));
      await pack(expectedError);
    }
  });
} finally { await fs.rm(scratch, { recursive: true, force: true }); }
console.log(`${passed} engine export families passed`);
