// Rome descriptor data only. Native key/modifier precedence, dispatch, focus
// and callback identities are not inferred from these literal records.
export const shortcutLimits = Object.freeze({ bytes: 1048576, lines: 65536,
  records: 8192, groups: 256, keysets: 64, tokensPerRow: 32, tokenBytes: 128 });

function inputLines(input) {
  if (!(input instanceof Uint8Array) ||
      (typeof SharedArrayBuffer !== 'undefined' && input.buffer instanceof SharedArrayBuffer))
    throw new TypeError('Shortcut input needs an unshared Uint8Array');
  if (input.byteLength > shortcutLimits.bytes) throw Error('Shortcut byte limit');
  const bytes = new Uint8Array(input);
  for (const b of bytes)
    if (b > 126 || (b < 32 && b !== 9 && b !== 10 && b !== 13))
      throw Error('Unsupported shortcut encoding/control byte');
  const sourceText = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const lines = sourceText.split(/\r\n|\n|\r/);
  if (lines.at(-1) === '') lines.pop();
  if (lines.length > shortcutLimits.lines) throw Error('Shortcut line limit');
  return { sourceText, sourceBytes: bytes.length, lines };
}
function tokens(line, number) {
  const text = line.split(';', 1)[0].trim();
  const parts = text ? text.split(/[ \t]+/) : [];
  if (parts.length > shortcutLimits.tokensPerRow || parts.some(p =>
    p.length > shortcutLimits.tokenBytes || !/^[A-Za-z0-9_]+$/.test(p)))
    throw Error('Unsupported shortcut tokens at line ' + number);
  return parts;
}
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function decodeShortcutDefinitions(input) {
  const { sourceText, sourceBytes, lines } = inputLines(input);
  const keysets = [], mappings = [];
  let keyset = null, group = null, mapping = false, mappingsLine = null;
  let records = 0, groups = 0;
  for (let i = 0; i < lines.length; i++) {
    const row = tokens(lines[i], i + 1);
    if (!row.length) continue;
    const fail = () => { throw Error('Shortcut structure at line ' + (i + 1)); };
    if (row[0] === 'keyset') {
      if (group || mapping || row.length !== 2) fail();
      if (keysets.length === shortcutLimits.keysets) throw Error('Shortcut keyset limit');
      keyset = { name: row[1], line: i + 1, groups: [] };
      keysets.push(keyset);
    } else if (row[0] === 'mappings') {
      if (group || mapping || row.length !== 1) fail();
      mapping = true; mappingsLine = i + 1; keyset = null;
    } else if (row[0] === 'end') {
      if (!group || row.length !== 1) fail();
      group = null;
    } else if (!group) {
      if ((!keyset && !mapping) || row.length !== 1) fail();
      if (++groups > shortcutLimits.groups) throw Error('Shortcut group limit');
      group = { name: row[0], line: i + 1, rows: [] };
      (mapping ? mappings : keyset.groups).push(group);
    } else {
      if ((!mapping && row.length < 2) || (mapping && row.length > 2)) fail();
      if (++records > shortcutLimits.records) throw Error('Shortcut record limit');
      group.rows.push({ action: row[0], arguments: row.slice(1), line: i + 1 });
    }
  }
  if (group) throw Error('Unclosed shortcut group');
  return freeze({ schema: 'openrtw-rome-shortcuts-v1', sourceText, sourceBytes,
    physicalLines: lines.length, records, keysets, mappings, mappingsLine });
}

export function decodeShortcutLookup(input) {
  const { sourceText, sourceBytes, lines } = inputLines(input);
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    const row = tokens(lines[i], i + 1);
    if (!row.length) continue;
    if (row.length !== 1) throw Error('Shortcut lookup arity at line ' + (i + 1));
    if (entries.length === shortcutLimits.records) throw Error('Shortcut lookup limit');
    entries.push({ name: row[0], line: i + 1 });
  }
  // Position is retained as file order, not claimed to be a native enum ID.
  return freeze({ schema: 'openrtw-rome-shortcut-lookup-v1', sourceText,
    sourceBytes, physicalLines: lines.length, entries });
}
