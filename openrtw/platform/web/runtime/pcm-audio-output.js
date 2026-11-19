export const PCM_AUDIO_OUTPUT_CAPABILITIES = Object.freeze({
  precision: 'float32',
  channels: 1,
  layout: 'mono',
  minSampleRate: 3000,
  maxSampleRate: 384000,
  maxFrames: 16 * 1024 * 1024,
});

// Keep missing-stage sentinels distinct from an operation throwing a falsy value.
function failureValue(error) {
  return error || new Error('Audio operation failed with ' + String(error), { cause: error });
}

function combineErrors(message, errors) {
  const unique = [...new Set(errors.filter(Boolean))];
  if (unique.length === 0) return null;
  if (unique.length === 1) return unique[0];
  return new AggregateError(unique, message);
}

function ownedFloat32Samples(samples, format) {
  if (format === null || typeof format !== 'object' || Array.isArray(format))
    throw new TypeError('PCM format must be an object');
  const { precision, channels, layout, sampleRate } = format;
  if (precision !== PCM_AUDIO_OUTPUT_CAPABILITIES.precision)
    throw new RangeError('PCM output supports only float32 samples');
  if (channels !== PCM_AUDIO_OUTPUT_CAPABILITIES.channels || layout !== PCM_AUDIO_OUTPUT_CAPABILITIES.layout)
    throw new RangeError('PCM output supports only mono samples');
  if (!Number.isInteger(sampleRate) ||
      sampleRate < PCM_AUDIO_OUTPUT_CAPABILITIES.minSampleRate ||
      sampleRate > PCM_AUDIO_OUTPUT_CAPABILITIES.maxSampleRate)
    throw new RangeError('PCM sample rate is outside the supported bounds');
  if (!(samples instanceof Float32Array))
    throw new TypeError('PCM samples must be a Float32Array');
  if (samples.length === 0 || samples.length > PCM_AUDIO_OUTPUT_CAPABILITIES.maxFrames)
    throw new RangeError('PCM frame count is outside the supported bounds');

  const source = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  const bytes = new Uint8Array(source.byteLength);
  bytes.set(source);
  return { samples: new Float32Array(bytes.buffer), channels, sampleRate };
}

export function createPcmAudioOutput({
  samples,
  format,
  createContext = () => new AudioContext(),
  onStateChange,
  onError,
} = {}) {
  const { samples: ownedSamples, channels, sampleRate } = ownedFloat32Samples(samples, format);
  if (typeof createContext !== 'function') throw new TypeError('createContext must be a function');
  if (onStateChange !== undefined && typeof onStateChange !== 'function')
    throw new TypeError('onStateChange must be a function');
  if (onError !== undefined && typeof onError !== 'function') throw new TypeError('onError must be a function');

  const frameCount = ownedSamples.length;
  let current = null;
  let stopPromise = null;
  let disposePromise = null;
  let disposed = false;
  let snapshot = Object.freeze({ state: 'ready', contextSampleRate: null, error: null });

  function isLive(record) {
    return current === record && !record.cancelled && !record.ended;
  }

  async function publish(state, contextSampleRate = null, error = null) {
    snapshot = Object.freeze({ state, contextSampleRate, error });
    if (onStateChange) await onStateChange(snapshot);
  }

  function cleanupRecord(record) {
    if (record.cleanupPromise) return record.cleanupPromise;
    record.cleanupPromise = Promise.resolve().then(async () => {
      const failures = [];
      const pending = [];
      const attempt = (operation) => {
        try {
          const result = operation();
          if (result !== null && (typeof result === 'object' || typeof result === 'function')) {
            const observed = Promise.resolve(result).catch((error) => failures.push(failureValue(error)));
            pending.push(observed);
          }
        } catch (error) {
          error = failureValue(error);
          failures.push(error);
        }
      };

      const source = record.source;
      if (source) {
        attempt(() => { source.onended = null; });
        attempt(() => source.stop());
        attempt(() => source.disconnect());
      }
      const context = record.context;
      if (context) {
        let state;
        let stateFailed = false;
        try {
          state = context.state;
        } catch (error) {
          error = failureValue(error);
          stateFailed = true;
          failures.push(error);
        }
        if (stateFailed || state !== 'closed') attempt(() => context.close());
      }
      await Promise.all(pending);
      record.cleanupError = combineErrors('Audio resource cleanup failed', failures);
      return record.cleanupError;
    });
    return record.cleanupPromise;
  }

  async function reportAsyncFailure(error) {
    const failures = [error];
    if (onError) {
      try {
        await onError(error);
      } catch (observerError) {
        observerError = failureValue(observerError);
        failures.push(observerError);
      }
    }
    let failure = combineErrors('Asynchronous audio output failed', failures);
    try {
      await publish('error', null, failure);
    } catch (observerError) {
      observerError = failureValue(observerError);
      failure = combineErrors('Asynchronous audio output failed', [failure, observerError]);
      snapshot = Object.freeze({ state: 'error', contextSampleRate: null, error: failure });
    }
  }

  function ended(record) {
    if (current !== record || record.cancelled || record.ended) return;
    record.ended = true;
    record.endedPromise = Promise.resolve().then(async () => {
      const cleanupError = await cleanupRecord(record);
      let playError = null;
      try {
        await record.playPromise;
      } catch (error) {
        error = failureValue(error);
        playError = error;
      }
      if (record.cancelled || disposed) {
        if (current === record) current = null;
        return;
      }
      const failure = combineErrors('Audio playback completion failed', [
        record.failure,
        playError,
        cleanupError,
      ]);
      if (failure) {
        await reportAsyncFailure(failure);
      } else {
        try {
          await publish('ended');
        } catch (error) {
          error = failureValue(error);
          if (!record.cancelled && !disposed) await reportAsyncFailure(error);
        }
      }
      if (current === record) current = null;
    }).catch((error) => {
      error = failureValue(error);
      if (current === record) current = null;
      snapshot = Object.freeze({ state: 'error', contextSampleRate: null, error });
    });
  }

  async function performPlay(record) {
    const stale = Symbol('stale audio generation');
    const requireLive = () => { if (!isLive(record)) throw stale; };
    let resuming = false;
    try {
      requireLive();
      record.context = createContext();
      if (!record.context) throw new Error('AudioContext factory returned no context');
      requireLive();
      resuming = true;
      await record.context.resume();
      resuming = false;
      requireLive();
      if (record.context.state !== 'running') throw new Error('Audio output could not start');
      requireLive();

      const buffer = record.context.createBuffer(channels, frameCount, sampleRate);
      buffer.copyToChannel(ownedSamples, 0);
      requireLive();
      record.source = record.context.createBufferSource();
      requireLive();
      record.source.buffer = buffer;
      record.source.connect(record.context.destination);
      record.source.onended = () => ended(record);
      const contextSampleRate = record.context.sampleRate;
      requireLive();
      record.source.start();
      record.started = true;
      requireLive();
      await publish('playing', contextSampleRate);
      // A completed source still fulfilled this play attempt. Stop/dispose
      // cancellation remains distinct from natural end during the observer.
      if (record.cancelled || disposed || current !== record) throw stale;
      return true;
    } catch (error) {
      error = failureValue(error);
      const wasCancelled = record.cancelled;
      const wasEnded = record.ended;
      const cleanupError = await cleanupRecord(record);
      if (error === stale) return false;
      // Shutdown may reject an outstanding resume. Other failures, including
      // a rejected playing observer after Stop, remain real error causes.
      if (wasCancelled && resuming) return false;
      record.failure = combineErrors('Audio playback failed', [record.failure, error, cleanupError]);
      snapshot = Object.freeze({ state: 'error', contextSampleRate: null, error: record.failure });
      if (!wasCancelled && !wasEnded && current === record) current = null;
      throw record.failure;
    }
  }

  function play() {
    if (disposed || current || stopPromise) return Promise.resolve(false);
    const record = {
      context: null,
      source: null,
      started: false,
      cancelled: false,
      ended: false,
      cleanupPromise: null,
      cleanupError: null,
      endedPromise: null,
      playPromise: null,
      failure: null,
    };
    current = record;
    record.playPromise = Promise.resolve().then(() => performPlay(record));
    return record.playPromise;
  }

  function stopCurrent(notify) {
    if (stopPromise) return stopPromise;
    const record = current;
    if (!record) return Promise.resolve(false);
    record.cancelled = true;
    stopPromise = (async () => {
      try {
        await Promise.resolve();
        // Close independently of resume/observers. A pending resume can itself
        // require context closure before it settles.
        const cleanup = cleanupRecord(record);
        let playError = null;
        try {
          await record.playPromise;
        } catch (error) {
          error = failureValue(error);
          playError = error;
        }
        const cleanupError = await cleanup;
        if (record.endedPromise) await record.endedPromise;
        if (current === record) current = null;
        let failure = combineErrors('Audio output stop failed', [
          record.failure,
          playError,
          cleanupError,
        ]);
        if (notify && !disposed) {
          try {
            await publish('stopped');
          } catch (error) {
            error = failureValue(error);
            failure = combineErrors('Audio output stop failed', [failure, error]);
          }
        }
        if (failure) throw failure;
        return true;
      } finally {
        stopPromise = null;
      }
    })();
    return stopPromise;
  }

  function stop() {
    return stopCurrent(true);
  }

  function dispose() {
    if (disposePromise) return disposePromise;
    disposed = true;
    if (current) current.cancelled = true;
    disposePromise = (async () => {
      await Promise.resolve();
      let failure = null;
      try {
        await stopCurrent(false);
      } catch (error) {
        error = failureValue(error);
        failure = error;
      }
      try {
        await publish('closed');
      } catch (error) {
        error = failureValue(error);
        failure = combineErrors('Audio output disposal failed', [failure, error]);
      }
      if (failure) throw failure;
    })();
    return disposePromise;
  }

  return Object.freeze({
    play,
    stop,
    dispose,
    getState: () => snapshot,
  });
}
