// Bounded owned snapshots of trusted plain resource metadata. This copies
// admitted fields, signed zero, unknown versioned records and metadata graphs;
// it does not decode, normalize or interpret them.
export const resourceDataLimits = Object.freeze({ nodes: 1048576, depth: 32, units: 4194304 });

function snapshotLimits(input) {
  if (!input || ![Object.prototype, null].includes(Object.getPrototypeOf(input)))
    throw new TypeError('Resource data: plain limits record required');
  const fields = Object.getOwnPropertyDescriptors(input), keys = Reflect.ownKeys(fields);
  if (keys.length !== 3 || keys.some(key => !Object.hasOwn(resourceDataLimits, key)))
    throw new TypeError('Resource data: nodes, depth and units limits required');
  const result = {};
  for (const name of ['nodes', 'depth', 'units']) {
    const field = fields[name];
    if (!Object.hasOwn(field, 'value') || !field.enumerable || !Number.isSafeInteger(field.value) ||
        field.value < (name === 'nodes' ? 1 : 0) || field.value > resourceDataLimits[name])
      throw new TypeError('Resource data: invalid ' + name + ' limit');
    result[name] = field.value;
  }
  return result;
}

export function snapshotPlainResourceData(input, limits, label = 'Resource data') {
  // Capture validated scalar limits before visiting any caller metadata.
  limits = snapshotLimits(limits);
  if (typeof label !== 'string' || !label.length || label.length > 128)
    throw new TypeError('Resource data: bounded diagnostic label required');
  let nodes = 0,
    units = 0;
  const ancestors = new Set();
  const refuse = (message) => {
    throw new TypeError(label + ': ' + message);
  };
  function text(value) {
    units += value.length;
    if (units > limits.units) refuse('metadata text budget');
    return value;
  }
  function copy(value, depth = 0) {
    if (++nodes > limits.nodes || depth > limits.depth) refuse('metadata graph budget');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') return text(value);
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (!value || typeof value !== 'object' || ancestors.has(value))
      refuse('metadata must be finite plain data without cycles');
    const array = Array.isArray(value);
    if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
      refuse('metadata record type');
    const fields = Object.getOwnPropertyDescriptors(value),
      keys = Reflect.ownKeys(fields);
    if (keys.length > limits.nodes) refuse('metadata field budget');
    const result = array ? [] : {};
    if (array && (value.length > limits.nodes || keys.length !== value.length + 1))
      refuse('metadata arrays must be dense');
    ancestors.add(value);
    for (let i = 0; i < (array ? value.length : keys.length); i++) {
      const key = array ? String(i) : keys[i],
        field = fields[key];
      if (typeof key !== 'string' || !field || !Object.hasOwn(field, 'value') || !field.enumerable)
        refuse('metadata data fields required');
      text(key);
      Object.defineProperty(result, key, { value: copy(field.value, depth + 1), enumerable: true });
    }
    ancestors.delete(value);
    return Object.freeze(result);
  }
  return copy(input);
}

export function snapshotVersionedExtensions(input, limits, label = 'Resource data') {
  const refuse = (message) => {
    throw new TypeError(label + ': ' + message);
  };
  if (!input || Array.isArray(input) || typeof input !== 'object')
    refuse('extension record required');
  const extensions = snapshotPlainResourceData(input, limits, label);
  for (const [key, extension] of Object.entries(extensions))
    if (
      !/^[a-z0-9][a-z0-9._-]{0,79}\/v[1-9][0-9]*$/.test(key) ||
      !extension ||
      Array.isArray(extension) ||
      extension.schema !== key
    )
      refuse('versioned extension record required');
  return extensions;
}
