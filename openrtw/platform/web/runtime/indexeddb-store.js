// IndexedDB transaction and connection ownership. Codecs and namespaces are
// supplied by the owning implementation; this module has no game imports.
function boundedName(value, label, maximum) {
  if (typeof value !== 'string' || !value.length || value.length > maximum ||
      /[\x00-\x1f\x7f]/.test(value))
    throw new TypeError(label + ' must be a bounded nonempty string');
  return value;
}

function describeFailure(value) {
  try { return String(value); } catch { return 'Unprintable failure cause'; }
}

// Codecs own their format/byte limits. The host additionally refuses shared
// memory and bounds traversal of the cloned record/result graph. View buffers
// are visited as buffers, never as one property per sample.
function unshared(value) {
  const seen = new Set(), pending = [[value, 0]];
  let visited = 0;
  const add = (item, depth) => {
    if (pending.length >= 4096) throw new Error('Storage record graph exceeds its bound');
    pending.push([item, depth]);
  };
  while (pending.length) {
    const [item, depth] = pending.pop();
    if (++visited > 4096 || depth > 64)
      throw new Error('Storage record graph exceeds its bound');
    if (item === null || typeof item !== 'object' || seen.has(item)) continue;
    seen.add(item);
    if (typeof SharedArrayBuffer === 'function' && item instanceof SharedArrayBuffer)
      throw new Error('Storage records require unshared memory');
    if (ArrayBuffer.isView(item)) { add(item.buffer, depth + 1); continue; }
    if (item instanceof ArrayBuffer) continue;
    if (item instanceof Map)
      for (const [key, entry] of item) { add(key, depth + 1); add(entry, depth + 1); }
    if (item instanceof Set)
      for (const entry of item) add(entry, depth + 1);
    for (const key of Reflect.ownKeys(item)) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (descriptor && 'value' in descriptor) add(descriptor.value, depth + 1);
      else throw new TypeError('Storage record results require data properties');
    }
  }
  return value;
}

export function createIndexedDBStore({
  indexedDB = globalThis.indexedDB,
  databaseName,
  databaseVersion = 1,
  storeName,
  encode,
  decode,
  onFailure = () => {},
} = {}) {
  boundedName(databaseName, 'Database name', 128);
  boundedName(storeName, 'Object store name', 128);
  if (!Number.isInteger(databaseVersion) || databaseVersion < 1 || databaseVersion > 0xffffffff)
    throw new TypeError('Database version must be a positive uint32');
  if (typeof encode !== 'function' || typeof decode !== 'function' ||
      typeof onFailure !== 'function')
    throw new TypeError('Storage codecs and failure observer must be functions');
  if (typeof indexedDB?.open !== 'function')
    throw new Error('Save storage is unavailable');
  const pending = new Set(), observers = new Set(), observerErrors = [], connectionErrors = [];
  let accepting = true,
    connection = null,
    connectionClosed = false,
    abandoned = false,
    firstError,
    failed = false,
    closing = null;
  const observe = (value) => {
    const work = Promise.resolve(value);
    observers.add(work);
    work.then(
      () => observers.delete(work),
      (error) => { observerErrors.push(error); observers.delete(work); }
    );
  };
  const synchronous = (value) => {
    if (value !== null && (typeof value === 'object' || typeof value === 'function') &&
        typeof value.then === 'function') {
      // Invalid asynchronous codecs may already have rejected. Retain that
      // failure while refusing to admit their eventual value.
      observe(value);
      throw new TypeError('Storage codecs must be synchronous');
    }
    return value;
  };
  const remember = (error) => {
    if (failed) return;
    failed = true;
    firstError = error;
    accepting = false;
    try {
      observe(onFailure(error));
    } catch (failure) {
      observerErrors.push(failure);
    }
  };
  const closeConnection = () => {
    if (connection && !connectionClosed) {
      connectionClosed = true;
      connection.close();
    }
  };
  let finishOpen;
  const openTerminal = new Promise((resolve) => {
    finishOpen = resolve;
  });
  const database = new Promise((resolve, reject) => {
    let request;
    const fail = (error) => {
      abandoned = true;
      remember(error);
      reject(error);
    };
    try {
      request = indexedDB.open(databaseName, databaseVersion);
    } catch (error) {
      fail(error);
      finishOpen();
      return;
    }
    request.onupgradeneeded = () => {
      if (abandoned) {
        try {
          request.transaction?.abort();
        } catch (error) {
          remember(error);
        }
        return;
      }
      try {
        request.result.createObjectStore(storeName);
      } catch (error) {
        try {
          request.transaction.abort();
        } catch {}
        fail(error);
      }
    };
    request.onsuccess = () => {
      try {
        if (abandoned) {
          // A blocked/failed open may still deliver a connection. Own its
          // single close attempt and retain a failure alongside the original
          // open error; remember() intentionally keeps only the first cause.
          connection = request.result;
          try {
            closeConnection();
          } catch (error) {
            connectionErrors.push(error);
          }
          return;
        }
        connection = request.result;
        connection.onversionchange = () => {
          if (connectionClosed) return;
          remember(new Error('Save storage changed in another tab'));
          // Event callbacks cannot report failures by throwing. The same
          // flush/close barrier that owns admitted work reports this cleanup.
          try {
            closeConnection();
          } catch (error) {
            connectionErrors.push(error);
          }
        };
        connection.onclose = () => {
          if (!connectionClosed) remember(new Error('Save storage closed unexpectedly'));
        };
        resolve(connection);
      } catch (error) {
        fail(error);
      } finally {
        finishOpen();
      }
    };
    request.onerror = () => {
      try {
        fail(request.error ?? new Error('Save storage could not open'));
      } finally {
        finishOpen();
      }
    };
    request.onblocked = () =>
      fail(new Error('Save storage upgrade is blocked by another tab'));
  });
  database.catch(remember);
  function track(operation) {
    pending.add(operation);
    operation.then(
      () => pending.delete(operation),
      (error) => {
        remember(error);
        pending.delete(operation);
      }
    );
    return operation;
  }
  function operation(start) {
    if (!accepting)
      return Promise.reject(failed ? firstError : new Error('Save storage is closing or closed'));
    // Admission is recorded before awaiting even the initial database open.
    return track(
      database.then((db) => {
        if (failed) throw firstError;
        return start(db);
      })
    );
  }
  function transaction(db, mode, issue, read) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(
        storeName,
        mode,
        ...(mode === 'readwrite' ? [{ durability: 'strict' }] : [])
      );
      let request,
        result,
        error,
        hasError = false;
      const capture = (value) => {
        if (!hasError) { hasError = true; error = value; }
      };
      const abort = () => {
        try {
          tx.abort();
        } catch {
          /* Only a terminal event releases admission. */
        }
      };
      tx.oncomplete = () => (hasError ? reject(error) : resolve(result));
      tx.onabort = () =>
        reject(
          hasError ? error : tx.error ?? request?.error ?? new Error('Save transaction aborted')
        );
      tx.onerror = () => capture(tx.error ?? request?.error ?? new Error('Save transaction failed'));
      try {
        request = issue(tx.objectStore(storeName));
        request.onerror = () => capture(request.error ?? new Error('Save request failed'));
        if (read)
          request.onsuccess = () => {
            try {
              result = read(request.result);
            } catch (failure) {
              capture(failure);
              abort();
            }
          };
      } catch (failure) {
        capture(failure);
        abort();
      }
    });
  }
  async function drain() {
    // An early blocked/upgrade failure may reject database while the underlying
    // open request is still pending. Only its success/error event is terminal.
    await Promise.allSettled([database, openTerminal]);
    while (pending.size || observers.size)
      await Promise.allSettled([...pending, ...observers]);
    if (observerErrors.length || connectionErrors.length) {
      const errors = failed
        ? [firstError, ...observerErrors, ...connectionErrors]
        : [...observerErrors, ...connectionErrors];
      throw new AggregateError(errors, 'Save storage errors: ' + errors.map(describeFailure).join('; '));
    }
    if (failed) throw firstError;
  }
  return Object.freeze({
    save(key, value) {
      if (!accepting)
        return Promise.reject(failed ? firstError : new Error('Save storage is closing or closed'));
      let owned;
      try {
        boundedName(key, 'Save key', 2048);
        // The trusted codec enforces its format and byte bounds synchronously.
        // Clone its admitted record before any database await.
        owned = unshared(structuredClone(synchronous(encode(value, key))));
      } catch (error) {
        return track(Promise.reject(error));
      }
      return operation((db) =>
        transaction(db, 'readwrite', (store) => store.put(owned, key))
      );
    },
    load(key) {
      if (!accepting)
        return Promise.reject(failed ? firstError : new Error('Save storage is closing or closed'));
      try {
        boundedName(key, 'Save key', 2048);
      } catch (error) {
        return track(Promise.reject(error));
      }
      return operation((db) => transaction(
        db, 'readonly', (store) => store.get(key), (record) => {
          return unshared(synchronous(decode(record, key)));
        }
      ));
    },
    flush: drain,
    close() {
      if (closing) return closing;
      accepting = false;
      closing = (async () => {
        let failure, drainFailed = false;
        try {
          await drain();
        } catch (error) {
          drainFailed = true;
          failure = error;
        }
        try {
          closeConnection();
        } catch (error) {
          if (drainFailed)
            throw new AggregateError([failure, error], 'Save storage close errors: ' +
              describeFailure(failure) + '; ' + describeFailure(error));
          throw error;
        }
        if (drainFailed) throw failure;
      })();
      return closing;
    },
  });
}
