// Project-owned balancing overrides. Original installation files are never edited.
// Example: { chain: 'barracks', level: 'militia_barracks', cost: 800, turns: 2 }
export const buildingTreeOverrides = Object.freeze([]);

export function applyBuildingTreeOverrides(bytes, overrides = buildingTreeOverrides) {
  if (!(bytes instanceof Uint8Array) || bytes.length > 2 * 1024 * 1024 ||
      !Array.isArray(overrides) || overrides.length > 256) throw TypeError('Invalid building tree overrides');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (!overrides.length) return bytes.slice();
  const tokens = [], stack = [];
  for (const m of text.matchAll(/;[^\r\n]*|"(?:[^"\\]|\\.)*"|[{},]|[^\s{},;]+/g)) {
    if (m[0].startsWith(';')) continue;
    const t = { word: m[0], start: m.index, end: m.index + m[0].length, depth: stack.length };
    if (t.word === '}') { if (!stack.length) throw Error('Unbalanced building tree'); t.depth--; tokens[stack.pop()].close = tokens.length; }
    tokens.push(t); if (t.word === '{') stack.push(tokens.length - 1);
  }
  if (stack.length) throw Error('Unclosed building tree');
  const replacements = [], seen = new Set(), id = /^[a-z][a-z0-9_+\-]{0,127}$/;
  for (const patch of overrides) {
    if (!patch || Object.getPrototypeOf(patch) !== Object.prototype || !id.test(patch.chain) || !id.test(patch.level) ||
        Object.keys(patch).some(k => !['chain', 'level', 'cost', 'turns', 'prerequisites', 'upgrades'].includes(k))) throw TypeError('Invalid building override');
    const key = patch.chain + ':' + patch.level;
    if (seen.has(key)) throw Error('Duplicate building override'); seen.add(key);
    const group = tokens.findIndex((t, i) => t.depth === 0 && t.word === 'building' && tokens[i + 1]?.word === patch.chain);
    if (group < 0) throw Error('Unknown building chain: ' + patch.chain);
    const groupEnd = tokens[group + 2].close;
    let level = -1;
    for (let i = group + 3; i < groupEnd; i++) if (tokens[i].depth === 2 && tokens[i].word === patch.level) { level = i; break; }
    if (level < 0) throw Error('Unknown building level: ' + key);
    let body = level + 1;
    while (body < groupEnd) {
      if (tokens[body].word === '{' && tokens[body - 1]?.word === 'factions') { body = tokens[body].close + 1; continue; }
      if (tokens[body].word === '{') break; body++;
    }
    if (body >= groupEnd) throw Error('Missing level body');
    const end = tokens[body].close;
    for (const [field, name, min] of [['cost', 'cost', 0], ['turns', 'construction', 1]]) if (Object.hasOwn(patch, field)) {
      const value = patch[field];
      if (!Number.isSafeInteger(value) || value < min || value > (field === 'turns' ? 1000 : 100000000)) throw RangeError('Invalid override amount');
      const indexes = [];
      for (let i = body + 1; i < end; i++) if (tokens[i].depth === 3 && tokens[i].word === name) indexes.push(i + 1);
      if (indexes.length !== 1) throw Error('Ambiguous override property');
      const token = tokens[indexes[0]]; replacements.push({ start: token.start, end: token.end, text: String(value) });
    }
    if (Object.hasOwn(patch, 'prerequisites')) {
      if (typeof patch.prerequisites !== 'string' || patch.prerequisites.length > 4096 || /[;\r\n]/.test(patch.prerequisites)) throw TypeError('Invalid prerequisite override');
      replacements.push({ start: tokens[level].end, end: tokens[body].start, text: patch.prerequisites ? ' requires ' + patch.prerequisites + '\n' : '\n' });
    }
    if (Object.hasOwn(patch, 'upgrades')) {
      if (!Array.isArray(patch.upgrades) || patch.upgrades.length > 32 || patch.upgrades.some(v => !id.test(v)) || new Set(patch.upgrades).size !== patch.upgrades.length) throw TypeError('Invalid upgrade edges');
      let block = -1;
      for (let i = body + 1; i < end; i++) if (tokens[i].depth === 3 && tokens[i].word === 'upgrades') block = i + 1;
      if (block < 0 || tokens[block].word !== '{') throw Error('Missing upgrades block');
      replacements.push({ start: tokens[block].end, end: tokens[tokens[block].close].start, text: '\n' + patch.upgrades.join('\n') + '\n' });
    }
  }
  let output = text, boundary = text.length;
  for (const r of replacements.sort((a, b) => b.start - a.start)) {
    if (r.end > boundary) throw Error('Overlapping building overrides');
    output = output.slice(0, r.start) + r.text + output.slice(r.end); boundary = r.start;
  }
  const result = new TextEncoder().encode(output);
  if (result.length > 2 * 1024 * 1024) throw RangeError('Overridden building tree too large');
  return result;
}
