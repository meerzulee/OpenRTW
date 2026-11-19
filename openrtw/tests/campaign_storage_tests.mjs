import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { FakeIndexedDB } from './fixtures/controlled-indexeddb.js';

// Import the exact production adapter and its shared metadata/IndexedDB host
// without rewriting or substituting their logic. No module needs DOM globals.
const sourceUrl = new URL('../platform/web/campaign-storage.js', import.meta.url);
const source = await fs.readFile(sourceUrl);
const { createCampaignStorage, campaignSaveMaxBytes } = await import(sourceUrl.href);
assert.equal(campaignSaveMaxBytes, 1048576);

// This event driver is an external IndexedDB contract fixture, not a second
// storage implementation. It never settles a transaction automatically. Tests
// explicitly deliver request and terminal events; only a delivered successful
// transaction completion commits its structured-cloned put candidate. It does
// not prove browser scheduling, filesystem durability or real IndexedDB flush.
// Both legacy and generic storage tests use the same controlled public events.

let microtaskTurns = 0;
async function pump(turns = 12) {
  assert.ok(Number.isInteger(turns) && turns >= 0 && turns <= 32);
  for (let i = 0; i < turns; i++) {
    assert.ok(++microtaskTurns <= 4096, 'Focused test microtask budget exceeded');
    await Promise.resolve();
  }
}
function watch(promise) {
  const observed = { state: 'pending', value: undefined, error: undefined };
  promise.then(
    (value) => {
      observed.state = 'fulfilled';
      observed.value = value;
    },
    (error) => {
      observed.state = 'rejected';
      observed.error = error;
    }
  );
  return observed;
}
async function pending(observed, label) {
  await pump();
  assert.equal(observed.state, 'pending', label);
}
async function terminal(observed, state) {
  for (let i = 0; i < 32 && observed.state === 'pending'; i++) await pump(1);
  assert.equal(
    observed.state,
    state,
    'Promise did not reach expected state within bounded microtasks'
  );
  return state === 'fulfilled' ? observed.value : observed.error;
}
function fixture() {
  const idb = new FakeIndexedDB(),
    failures = [];
  const storage = createCampaignStorage({
    indexedDB: idb,
    onFailure: (error) => failures.push(error),
  });
  return { idb, storage, failures };
}
async function connected() {
  const f = fixture();
  f.idb.openSuccess();
  await pump();
  return f;
}
function newest(idb) {
  const tx = idb.database.transactions.at(-1);
  assert.ok(tx);
  assert.ok(tx.request);
  return tx;
}
function slotBytes(idb) {
  return Array.from(new Uint8Array(idb.database.records.get('slot-1').bytes));
}
async function commit(f, bytes) {
  const result = watch(f.storage.save(bytes));
  await pump();
  const tx = newest(f.idb);
  f.idb.requestSuccess(tx);
  await pending(result, 'put success is not transaction completion');
  f.idb.complete(tx);
  await terminal(result, 'fulfilled');
}

async function completion_and_owned_copies() {
  const f = fixture(),
    input = new Uint8Array([1, 2, 3]);
  const saved = watch(f.storage.save(input));
  input.fill(9);
  await pending(saved, 'Save awaiting actual database open');
  assert.equal(f.idb.database.transactions.length, 0);
  f.idb.openSuccess();
  await pump();
  const tx = newest(f.idb);
  assert.deepEqual(Array.from(new Uint8Array(tx.writes[0].record.bytes)), [1, 2, 3]);
  f.idb.requestSuccess(tx);
  await pending(saved, 'request success cannot mean Saved');
  assert.equal(f.idb.database.records.has('slot-1'), false);
  f.idb.complete(tx);
  await terminal(saved, 'fulfilled');
  assert.deepEqual(slotBytes(f.idb), [1, 2, 3]);
  const first = watch(f.storage.load());
  await pump();
  const read1 = newest(f.idb);
  f.idb.requestSuccess(read1);
  await pending(first, 'Load must also await transaction completion');
  f.idb.complete(read1);
  const loaded = await terminal(first, 'fulfilled');
  assert.ok(loaded instanceof Uint8Array);
  assert.deepEqual(Array.from(loaded), [1, 2, 3]);
  loaded.fill(7);
  assert.deepEqual(slotBytes(f.idb), [1, 2, 3]);
  const second = watch(f.storage.load());
  await pump();
  const read2 = newest(f.idb);
  f.idb.requestSuccess(read2);
  f.idb.complete(read2);
  const again = await terminal(second, 'fulfilled');
  assert.notEqual(again, loaded);
  assert.deepEqual(Array.from(again), [1, 2, 3]);
  await terminal(watch(f.storage.close()), 'fulfilled');
  assert.equal(f.idb.database.closeCalls, 1);
  assert.deepEqual(f.failures, []);
}

async function aborted_save_preserves_prior_slot() {
  const f = await connected();
  await commit(f, new Uint8Array([4, 5]));
  const original = structuredClone(f.idb.database.records.get('slot-1'));
  const saved = watch(f.storage.save(new Uint8Array([8, 9])));
  await pump();
  const tx = newest(f.idb);
  f.idb.requestSuccess(tx);
  await pending(saved, 'replacement put success cannot commit slot');
  assert.deepEqual(f.idb.database.records.get('slot-1'), original);
  const failure = new Error('Controlled quota abort');
  f.idb.requestError(tx, failure);
  f.idb.transactionError(tx, failure);
  await pending(saved, 'nonterminal error must not release admitted save');
  assert.deepEqual(f.failures, []);
  f.idb.abort(tx, failure);
  assert.equal(await terminal(saved, 'rejected'), failure);
  assert.deepEqual(f.idb.database.records.get('slot-1'), original);
  assert.deepEqual(f.failures, [failure]);
  assert.equal(await terminal(watch(f.storage.flush()), 'rejected'), failure);
  assert.equal(await terminal(watch(f.storage.close()), 'rejected'), failure);
  assert.equal(f.idb.database.closeCalls, 1);
}

async function close_waits_admitted_transaction() {
  const f = await connected(),
    saved = watch(f.storage.save(new Uint8Array([10])));
  await pump();
  const tx = newest(f.idb);
  const closingPromise = f.storage.close(),
    closing = watch(closingPromise);
  assert.equal(f.storage.close(), closingPromise, 'Close must be idempotent');
  await pending(closing, 'Close must await admitted write transaction');
  assert.equal(f.idb.database.closeCalls, 0);
  const refused = watch(f.storage.save(new Uint8Array([99])));
  await terminal(refused, 'rejected');
  assert.equal(f.idb.database.transactions.length, 1);
  f.idb.requestSuccess(tx);
  await pending(saved, 'Save after request success');
  await pending(closing, 'Close after request success');
  assert.equal(f.idb.database.closeCalls, 0);
  f.idb.complete(tx);
  await terminal(saved, 'fulfilled');
  await terminal(closing, 'fulfilled');
  assert.deepEqual(slotBytes(f.idb), [10]);
  assert.equal(f.idb.database.closeCalls, 1);
}

async function close_waits_admitted_pending_open() {
  const f = fixture(),
    saved = watch(f.storage.save(new Uint8Array([11, 12]))),
    closing = watch(f.storage.close());
  await pending(closing, 'Close cannot finish before pending database open');
  assert.equal(f.idb.database.transactions.length, 0);
  assert.equal(f.idb.database.closeCalls, 0);
  f.idb.openSuccess();
  await pump();
  const tx = newest(f.idb);
  f.idb.requestSuccess(tx);
  await pending(saved, 'Previously admitted save must remain pending until tx complete');
  await pending(closing, 'Open success is not admitted save completion');
  f.idb.complete(tx);
  await terminal(saved, 'fulfilled');
  await terminal(closing, 'fulfilled');
  assert.deepEqual(slotBytes(f.idb), [11, 12]);
  assert.equal(f.idb.database.closeCalls, 1);
}

async function close_waits_abort_terminal() {
  const f = await connected();
  await commit(f, new Uint8Array([13]));
  const saved = watch(f.storage.save(new Uint8Array([14])));
  await pump();
  const tx = newest(f.idb);
  const closing = watch(f.storage.close()),
    failure = new Error('Controlled late abort');
  f.idb.transactionError(tx, failure);
  await pending(saved, 'Transaction error alone cannot settle Save');
  await pending(closing, 'Close must not finish on a nonterminal error');
  assert.equal(f.idb.database.closeCalls, 0);
  assert.deepEqual(slotBytes(f.idb), [13]);
  f.idb.abort(tx, failure);
  assert.equal(await terminal(saved, 'rejected'), failure);
  assert.equal(await terminal(closing, 'rejected'), failure);
  assert.deepEqual(slotBytes(f.idb), [13]);
  assert.equal(f.idb.database.closeCalls, 1);
}

async function blocked_open_waits_late_success() {
  const f = fixture(),
    saved = watch(f.storage.save(new Uint8Array([15])));
  f.idb.blocked();
  const failure = await terminal(saved, 'rejected');
  assert.match(failure.message, /blocked/);
  assert.deepEqual(f.failures, [failure]);
  const closing = watch(f.storage.close()),
    drained = watch(f.storage.flush());
  await pending(closing, 'Blocked database rejection is not open-request terminal success');
  await pending(drained, 'Flush also waits blocked open terminal');
  assert.equal(f.idb.database.closeCalls, 0);
  assert.equal(f.idb.database.transactions.length, 0);
  f.idb.openSuccess();
  assert.equal(await terminal(closing, 'rejected'), failure);
  assert.equal(await terminal(drained, 'rejected'), failure);
  assert.equal(f.idb.database.closeCalls, 1, 'Abandoned late success must close its acquired DB');
  assert.equal(f.idb.database.transactions.length, 0);
  assert.deepEqual(f.failures, [failure]);
}

async function blocked_open_waits_late_error() {
  const f = fixture();
  f.idb.blocked();
  await pump();
  assert.equal(f.failures.length, 1);
  const first = f.failures[0],
    closing = watch(f.storage.close());
  await pending(closing, 'Blocked open is not terminal error');
  f.idb.openError(new Error('Different actual open terminal error'));
  assert.equal(
    await terminal(closing, 'rejected'),
    first,
    'First blocked failure must remain observable'
  );
  assert.equal(f.idb.database.closeCalls, 0);
  assert.equal(f.idb.database.transactions.length, 0);
  assert.deepEqual(f.failures, [first]);
}

async function malformed_load_waits_abort_and_refuses() {
  const malformed = [
    null,
    {},
    { schema: 'wrong', bytes: new ArrayBuffer(2) },
    { schema: 'openrtw-campaign-slot-v1', bytes: new Uint8Array([1, 2]) },
    { schema: 'openrtw-campaign-slot-v1', bytes: new ArrayBuffer(0) },
    { schema: 'openrtw-campaign-slot-v1', bytes: new ArrayBuffer(campaignSaveMaxBytes + 1) },
  ];
  for (const record of malformed) {
    const f = await connected();
    f.idb.database.records.set('slot-1', structuredClone(record));
    const previous = structuredClone(record),
      loaded = watch(f.storage.load());
    await pump();
    const tx = newest(f.idb);
    f.idb.requestSuccess(tx);
    assert.equal(tx.abortRequested, true, 'Malformed load must request transaction abort');
    await pending(loaded, 'abort() call is not terminal transaction evidence');
    const closing = watch(f.storage.close());
    await pending(closing, 'Close waits malformed read abort');
    f.idb.abort(tx);
    const failure = await terminal(loaded, 'rejected');
    assert.ok(failure instanceof Error);
    assert.equal(await terminal(closing, 'rejected'), failure);
    assert.deepEqual(
      f.idb.database.records.get('slot-1'),
      previous,
      'Malformed load cannot repair/replace committed record'
    );
    assert.equal(f.idb.database.closeCalls, 1);
    assert.deepEqual(f.failures, [failure]);
  }
  const absent = await connected(),
    loaded = watch(absent.storage.load());
  await pump();
  const tx = newest(absent.idb);
  absent.idb.requestSuccess(tx);
  await pending(loaded, 'Empty slot still waits transaction complete');
  absent.idb.complete(tx);
  assert.equal(await terminal(loaded, 'fulfilled'), null);
  await terminal(watch(absent.storage.close()), 'fulfilled');
  assert.deepEqual(absent.failures, []);
}

const families = [
  completion_and_owned_copies,
  aborted_save_preserves_prior_slot,
  close_waits_admitted_transaction,
  close_waits_admitted_pending_open,
  close_waits_abort_terminal,
  blocked_open_waits_late_success,
  blocked_open_waits_late_error,
  malformed_load_waits_abort_and_refuses,
];
try {
  for (const family of families) await family();
  console.log(
    JSON.stringify({
      passed: true,
      families: families.length,
      microtaskTurns,
      sourceSha256: createHash('sha256').update(source).digest('hex'),
      engineSha256: createHash('sha256').update(await fs.readFile(new URL(
        '../platform/web/runtime/indexeddb-store.js', import.meta.url
      ))).digest('hex'),
      driverSha256: createHash('sha256').update(await fs.readFile(new URL(
        './fixtures/controlled-indexeddb.js', import.meta.url
      ))).digest('hex'),
      realIndexedDB: false,
      browserDurabilityProved: false,
      qualification:
        'Controlled fake public-event driver; real two-browser persistence remains required.',
    })
  );
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
}
