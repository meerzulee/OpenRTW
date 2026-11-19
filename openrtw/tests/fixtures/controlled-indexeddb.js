import assert from 'node:assert/strict';

// Controlled public-event driver: only delivered terminal events commit.
// Synthetic contract evidence, not real browser durability or scheduling.
class FakeDatabase {
  constructor(storeName, expectedKey) { this.storeName = storeName; this.expectedKey = expectedKey; }
  records = new Map();
  transactions = [];
  closeCalls = 0;
  createObjectStore(name) {
    assert.equal(name, this.storeName);
  }
  close() {
    this.closeCalls++;
  }
  transaction(name, mode, options) {
    assert.equal(name, this.storeName);
    assert.ok(mode === 'readonly' || mode === 'readwrite');
    if (mode === 'readwrite') assert.deepEqual(options, { durability: 'strict' });
    else assert.equal(options, undefined);
    const tx = {
      mode,
      error: null,
      request: null,
      writes: [],
      abortRequested: false,
      terminal: false,
    };
    tx.abort = () => {
      assert.equal(tx.terminal, false);
      tx.abortRequested = true;
    };
    tx.objectStore = (store) => {
      assert.equal(store, this.storeName);
      return {
        put: (record, key) => {
          assert.equal(mode, 'readwrite');
          assert.equal(tx.request, null);
          if (this.expectedKey !== null) assert.equal(key, this.expectedKey);
          tx.writes.push({ key, record: structuredClone(record) });
          tx.request = { kind: 'put', key, result: undefined, error: null };
          return tx.request;
        },
        get: (key) => {
          assert.equal(mode, 'readonly');
          assert.equal(tx.request, null);
          if (this.expectedKey !== null) assert.equal(key, this.expectedKey);
          tx.request = { kind: 'get', key, result: undefined, error: null };
          return tx.request;
        },
      };
    };
    this.transactions.push(tx);
    return tx;
  }
}

export class FakeIndexedDB {
  constructor({ databaseName = 'openrtw-campaign-saves-v1', storeName = 'saves', expectedKey = 'slot-1' } = {}) {
    this.databaseName = databaseName;
    this.database = new FakeDatabase(storeName, expectedKey);
  }
  request = null;
  openCalls = 0;
  open(name, version) {
    assert.equal(name, this.databaseName);
    assert.equal(version, 1);
    assert.equal(this.openCalls++, 0, 'Unexpected second database open');
    this.request = { result: undefined, error: null };
    return this.request;
  }
  openSuccess() {
    this.request.result = this.database;
    assert.equal(typeof this.request.onsuccess, 'function');
    this.request.onsuccess({ type: 'success', target: this.request });
  }
  blocked() {
    assert.equal(typeof this.request.onblocked, 'function');
    this.request.onblocked({ type: 'blocked', target: this.request });
  }
  openError(error) {
    this.request.error = error;
    assert.equal(typeof this.request.onerror, 'function');
    this.request.onerror({ type: 'error', target: this.request });
  }
  requestSuccess(tx) {
    assert.equal(tx.terminal, false);
    assert.ok(tx.request);
    tx.request.result =
      tx.request.kind === 'get'
        ? structuredClone(this.database.records.get(tx.request.key))
        : tx.request.key;
    tx.request.onsuccess?.({ type: 'success', target: tx.request });
  }
  requestError(tx, error) {
    assert.equal(tx.terminal, false);
    tx.request.error = error;
    tx.request.onerror?.({ type: 'error', target: tx.request });
  }
  transactionError(tx, error) {
    assert.equal(tx.terminal, false);
    tx.error = error;
    tx.onerror?.({ type: 'error', target: tx });
  }
  complete(tx) {
    assert.equal(tx.terminal, false);
    assert.equal(tx.abortRequested, false);
    tx.terminal = true;
    for (const write of tx.writes)
      this.database.records.set(write.key, structuredClone(write.record));
    assert.equal(typeof tx.oncomplete, 'function');
    tx.oncomplete({ type: 'complete', target: tx });
  }
  abort(tx, error = null) {
    assert.equal(tx.terminal, false);
    tx.terminal = true;
    tx.error = error;
    assert.equal(typeof tx.onabort, 'function');
    tx.onabort({ type: 'abort', target: tx });
  }
}
