// Caller-owned timing policy. Timestamps are quantized to integer microseconds;
// cumulative elapsed time survives bounded catch-up without per-frame clamping.
export function createFixedStepClock({ tickMilliseconds, maxTicksPerAdvance }) {
  const micros = (n) => {
    if (!Number.isFinite(n) || n < 0 || !Number.isSafeInteger(Math.round(n * 1000)))
      throw new RangeError('Clock timestamp exceeds its microsecond bound');
    return Math.round(n * 1000);
  };
  const tick = micros(tickMilliseconds);
  if (!tick || tick / 1000 !== tickMilliseconds ||
      !Number.isSafeInteger(maxTicksPerAdvance) || maxTicksPerAdvance < 1 ||
      maxTicksPerAdvance > 1000000)
    throw new RangeError('Invalid fixed-step clock policy');
  let last = null, pending = 0, rate = 1;
  const due = () => Math.min(maxTicksPerAdvance, Math.floor(pending / tick));
  return Object.freeze({
    advance(timestamp) {
      const next = micros(timestamp);
      if (last !== null && next < last) throw new RangeError('Clock moved backwards');
      const debt = pending + (last === null ? 0 : (next - last) * rate);
      if (!Number.isSafeInteger(debt)) throw new RangeError('Clock debt exceeds its bound');
      last = next;
      pending = debt;
      return due();
    },
    consume(ticks) {
      if (!Number.isSafeInteger(ticks) || ticks < 0 || ticks > due())
        throw new RangeError('Invalid clock tick consumption');
      pending -= ticks * tick;
    },
    // Rate applies to the next observed interval; hosts choose observation points.
    setRate(value) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 1024)
        throw new RangeError('Invalid clock rate');
      rate = value;
    },
    reset() { last = null; pending = 0; },
    // Saved debt is independent of the time origin. The first observation
    // after restore establishes a new baseline without charging time offline.
    snapshot: () => Object.freeze({
      schema: 'openrtw.fixed-step-clock/v1', tickMicroseconds: tick,
      maxTicksPerAdvance, pendingMicroseconds: pending, rate,
    }),
    restore(snapshot) {
      if (!snapshot || typeof snapshot !== 'object')
        throw new TypeError('Invalid clock snapshot');
      const descriptors = Object.getOwnPropertyDescriptors(snapshot),
        keys = ['schema', 'tickMicroseconds', 'maxTicksPerAdvance', 'pendingMicroseconds', 'rate'];
      if (Reflect.ownKeys(descriptors).length !== keys.length ||
          keys.some((key) => !descriptors[key] || !('value' in descriptors[key])))
        throw new TypeError('Invalid clock snapshot fields');
      const value = Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
      if (value.schema !== 'openrtw.fixed-step-clock/v1' ||
          value.tickMicroseconds !== tick || value.maxTicksPerAdvance !== maxTicksPerAdvance ||
          !Number.isSafeInteger(value.pendingMicroseconds) || value.pendingMicroseconds < 0 ||
          !Number.isSafeInteger(value.rate) || value.rate < 1 || value.rate > 1024)
        throw new RangeError('Clock snapshot differs from policy or exceeds bounds');
      last = null;
      pending = value.pendingMicroseconds;
      rate = value.rate;
    },
    getState: () => Object.freeze({ lastMicroseconds: last, pendingMicroseconds: pending, rate }),
  });
}
