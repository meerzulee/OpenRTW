// Logical read lifetime only: providers own their I/O and byte validation.
const validSignal = value => {
  if (value != null && (typeof value.aborted !== 'boolean' ||
      typeof value.addEventListener !== 'function' || typeof value.removeEventListener !== 'function'))
    throw new TypeError('Asset scope requires an AbortSignal');
};

// Cancel the caller's wait, while observing an underlying read/hash that may
// finish later. The operation must return data, not an owned device/resource.
export function awaitAssetRead(signal, start, message = 'Asset read aborted') {
  validSignal(signal);
  if (typeof start !== 'function') throw new TypeError('Asset read requires an operation');
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      try { signal?.removeEventListener('abort', onAbort); }
      catch (error) {
        reject(
          callback === reject
            ? new AggregateError([value, error], 'Asset read cancellation/cleanup failed')
            : error
        );
        return;
      }
      callback(value);
    };
    const onAbort = () => {
      try {
        if (signal?.aborted)
          finish(reject, signal.reason ?? new DOMException(message, 'AbortError'));
      } catch (error) { finish(reject, error); }
    };
    try {
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      if (settled) return;
      Promise.resolve(start()).then(value => finish(resolve, value), error => finish(reject, error));
    } catch (error) { finish(reject, error); }
  });
}

export function createAssetReadScope(provider, { signal } = {}) {
  validSignal(signal);
  if (!provider || typeof provider.read !== 'function')
    throw new TypeError('Asset scope requires a read provider');
  let source = provider;
  provider = null;
  let closed = false, reason;
  const active = new Set();
  const close = (cause = new Error('Asset read scope closed')) => {
    if (closed) return;
    closed = true;
    reason = cause;
    signal?.removeEventListener('abort', onParentAbort);
    for (const cancel of [...active]) cancel(reason);
    source = null;
  };
  const onParentAbort = () => close(signal.reason);
  const scope = { mode: source.mode, close };
  if (typeof source.describe === 'function') scope.describe = () => {
    if (closed) throw reason;
    return source.describe();
  };
  for (const method of ['read', 'readModel', 'readFile']) {
    if (typeof source[method] !== 'function') continue;
    scope[method] = (name, options = {}) => {
      const supplied = { ...options }, callerSignal = supplied.signal;
      validSignal(callerSignal);
      return new Promise((resolve, reject) => {
        if (closed) { reject(reason); return; }
        const controller = new AbortController();
        let settled = false;
        const finish = (callback, value) => {
          if (settled) return false;
          settled = true;
          active.delete(cancel);
          callerSignal?.removeEventListener('abort', onCallerAbort);
          callback(value);
          return true;
        };
        const cancel = cause => {
          if (finish(reject, cause)) controller.abort(cause);
        };
        const onCallerAbort = () => cancel(callerSignal.reason);
        active.add(cancel);
        try {
          callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
          if (callerSignal?.aborted) { cancel(callerSignal.reason); return; }
          // A parent abort can win during a caller's signal registration.
          if (closed || settled) { cancel(reason); return; }
          Promise.resolve(source[method](name, { ...supplied, signal: controller.signal })).then(
            value => finish(resolve, value), error => finish(reject, error)
          );
        } catch (error) { finish(reject, error); }
      });
    };
  }
  if (signal?.aborted) close(signal.reason);
  else signal?.addEventListener('abort', onParentAbort, { once: true });
  return Object.freeze(scope);
}
