import { decodeTgaTexture } from '/texture-image.js';
import { decodeUnitCardTga } from '/unit-card-image.js';
import { campaignBuildingImageSpecs } from '/campaign-building-manifest.js';
export { campaignBuildingImageSpecs, campaignBuildingFileSpecs } from '/campaign-building-manifest.js';

export const campaignBuildingLimits = Object.freeze({
  descriptorBytes: 2 * 1024 * 1024, localizationBytes: 2 * 1024 * 1024,
  rows: 32768, tokens: 131072, definitions: 2048, sourceRows: 1024,
  decodedImages: 32, decodedBytes: 8 * 1024 * 1024, imageConcurrency: 4,
});
const identifier = (v) => typeof v === 'string' && /^[a-z][a-z0-9_+\-]{0,127}$/.test(v);
const freeze = Object.freeze;
const humanize = (v) => v.replace(/_/g, ' ').replace(/\b[a-z]/g, (s) => s.toUpperCase());
const abortError = () => new DOMException('Building assets loading cancelled', 'AbortError');
function textInput(bytes, limit, localized = false) {
  if (!(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer) ||
    bytes.length < 1 || bytes.length > limit) throw new TypeError('Building source byte bound exceeded');
  const utf16 = bytes[0] === 255 && bytes[1] === 254;
  if (localized && !utf16 && !(bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191))
    throw new Error('Building localization requires a UTF-16LE or UTF-8 BOM');
  const text = new TextDecoder(utf16 ? 'utf-16le' : 'utf-8', {fatal: true}).decode(bytes);
  if (text.includes('\0') || text.split('\n').length > campaignBuildingLimits.rows)
    throw new RangeError('Building source text extent refused');
  return text;
}
function withoutComment(line) {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"' && line[i - 1] !== '\\') quoted = !quoted;
    if (!quoted && line[i] === ';') return line.slice(0, i);
  }
  if (quoted) throw new Error('Unterminated building source string');
  return line;
}
function tokenize(text) {
  const tokens = [], stack = [];
  let offset = 0;
  for (const [lineIndex, raw] of text.split('\n').entries()) {
    if (raw.length > 16384) throw new RangeError('Building source row too long');
    const line = withoutComment(raw);
    for (const m of line.matchAll(/"(?:[^"\\]|\\.)*"|[{},]|[^\s{},]+/g)) {
      if (tokens.length >= campaignBuildingLimits.tokens) throw new RangeError('Building token budget exceeded');
      const value = m[0], token = {value, line: lineIndex + 1, start: offset + m.index,
        end: offset + m.index + value.length, depth: stack.length, close: -1};
      if (value === '}') {
        if (!stack.length) throw new Error('Unbalanced building source braces');
        token.depth--;
        tokens[stack.pop()].close = tokens.length;
      }
      tokens.push(token);
      if (value === '{') {
        if (stack.length >= 32) throw new RangeError('Building brace depth exceeded');
        stack.push(tokens.length - 1);
      }
    }
    offset += raw.length + 1;
  }
  if (stack.length) throw new Error('Unclosed building source braces');
  return tokens;
}
function parseDescriptors(bytes) {
  const text = textInput(bytes, campaignBuildingLimits.descriptorBytes), tokens = tokenize(text), definitions = new Map();
  let groups = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].depth !== 0 || tokens[i].value !== 'building') continue;
    const type = tokens[++i]?.value, group = tokens[++i];
    if (!identifier(type) || group?.value !== '{') throw new Error('Invalid building declaration');
    groups++;
    let levelsAt = -1;
    for (let j = i + 1; j < group.close; j++)
      if (tokens[j].depth === 1 && tokens[j].value === 'levels') { levelsAt = j; break; }
    if (levelsAt < 0) throw new Error('Building declaration has no levels');
    const levels = [];
    let j = levelsAt + 1;
    while (j < group.close && tokens[j].value !== '{') {
      if (!identifier(tokens[j].value) || levels.length >= 256) throw new Error('Invalid building level list');
      levels.push(tokens[j++].value);
    }
    if (!levels.length || tokens[j]?.value !== '{') throw new Error('Invalid building level block');
    const levelsBlock = tokens[j], seen = new Set();
    for (j++; j < levelsBlock.close; j++) {
      if (tokens[j].depth !== 2) continue;
      const levelToken = tokens[j], level = levelToken.value;
      if (!levels.includes(level) || seen.has(level)) throw new Error('Undeclared or duplicate building level');
      seen.add(level);
      let open = j + 1;
      while (open < levelsBlock.close) {
        if (tokens[open].value === '{') {
          if (tokens[open - 1]?.value === 'factions') { open = tokens[open].close + 1; continue; }
          break;
        }
        open++;
      }
      const body = tokens[open];
      if (!body || body.value !== '{' || body.depth !== 2) throw new Error('Missing building level body');
      const capabilities = [];
      let cost = null, construction = null;
      for (let k = open + 1; k < body.close; k++) {
        if (tokens[k].depth !== 3) continue;
        const name = tokens[k].value;
        if (name === 'capability' && tokens[k + 1]?.value === '{') {
          const cap = tokens[++k];
          for (let at = k + 1; at < cap.close;) {
            const first = tokens[at];
            if (first.depth !== 4) throw new Error('Invalid capability row');
            let end = at + 1;
            while (end < cap.close && (tokens[end].line === first.line || tokens[end].depth > 4 || tokens[end].value === '}')) end++;
            const source = text.slice(first.start, tokens[end - 1].end).replace(/\s+/g, ' ').trim();
            if (source.length > 4096 || capabilities.length >= 256) throw new RangeError('Building capability budget exceeded');
            capabilities.push(freeze({source, line: first.line}));
            at = end;
          }
          k = cap.close;
        } else if (name === 'cost' || name === 'construction') {
          const value = tokens[k + 1]?.value;
          if (!/^\d{1,8}$/.test(value ?? '')) throw new Error('Invalid building descriptor amount');
          if (name === 'cost') cost = Number(value); else construction = Number(value);
        } else if (tokens[k].value === '{') k = tokens[k].close;
      }
      const key = `${type}:${level}`;
      if (definitions.has(key) || definitions.size >= campaignBuildingLimits.definitions)
        throw new RangeError('Building definition budget or duplicate exceeded');
      definitions.set(key, freeze({type, level, line: levelToken.line, cost, construction,
        capabilities: freeze(capabilities)}));
      j = body.close;
    }
    if (seen.size !== levels.length) throw new Error('Incomplete building level definitions');
    i = group.close;
  }
  if (!groups || !definitions.size) throw new Error('No building definitions');
  return definitions;
}
function parseLocalization(bytes) {
  const text = textInput(bytes, campaignBuildingLimits.localizationBytes, true), values = new Map();
  let key = null, parts = [];
  function finish() {
    if (key === null) return;
    const value = parts.join('\n').trim().replace(/\\n/g, '\n');
    if (value.length > 32768 || values.has(key) || values.size >= 16384)
      throw new RangeError('Building localization entry budget or duplicate exceeded');
    values.set(key, value);
  }
  for (const row of text.split(/\r?\n/)) {
    if (/^\s*¬/.test(row)) continue;
    const m = /^\s*\{([a-zA-Z0-9_+\-]+)\}(.*)$/.exec(row);
    if (m) { finish(); key = m[1]; parts = [m[2].trimStart()]; }
    else if (key !== null) parts.push(row);
  }
  finish();
  if (!values.size) throw new Error('No building localization entries');
  return values;
}
function parseVariants(bytes) {
  const tokens = tokenize(textInput(bytes, 65536)), variants = new Map();
  if (tokens[0]?.value !== 'lookup_variants' || tokens[1]?.value !== '{' || tokens[1].close !== tokens.length - 1)
    throw new Error('Invalid building UI variants');
  for (let i = 2; i < tokens.length - 1; i += 2) {
    const from = tokens[i]?.value, to = tokens[i + 1]?.value;
    if (!identifier(from) || !identifier(to) || tokens[i].line !== tokens[i + 1].line)
      throw new Error('Invalid building UI variant pair');
    const list = variants.get(from) ?? [];
    if (list.length >= 16 || list.includes(to)) throw new RangeError('Building UI variant budget or duplicate exceeded');
    list.push(to); variants.set(from, list);
  }
  return variants;
}
function parseFactions(bytes) {
  const factions = new Map();
  let faction = null;
  for (const raw of textInput(bytes, 256 * 1024).split('\n')) {
    const row = withoutComment(raw).trim(), m = /^(faction|culture)\s+([a-z][\w-]*)$/.exec(row);
    if (!m) continue;
    if (m[1] === 'faction') faction = m[2];
    else if (faction) {
      if (factions.has(faction) || factions.size >= 128) throw new Error('Duplicate or excessive building faction cultures');
      factions.set(faction, m[2]); faction = null;
    }
  }
  if (!factions.size) throw new Error('No building faction cultures');
  return factions;
}
const effectNames = freeze({farming_level: 'Farming level', trade_fleet: 'Trade fleet',
  road_level: 'Road level', population_health_bonus: 'Health bonus', population_growth_bonus: 'Population growth bonus',
  happiness_bonus: 'Happiness bonus', law_bonus: 'Law bonus', trade_base_income_bonus: 'Base trade income bonus',
  recruits_exp_bonus: 'Recruit experience bonus', recruits_morale_bonus: 'Recruit morale bonus',
  wall_level: 'Wall level', tower_level: 'Tower level', gate_strength: 'Gate strength', gate_defences: 'Gate defences',
  armour: 'Armour', weapon_simple: 'Simple weapons', weapon_bladed: 'Bladed weapons', weapon_missile: 'Missile weapons',
  mine_resource: 'Mining resource level', upgrade_bodyguard: 'Bodyguard upgrade', stage_games: 'Games level', stage_races: 'Races level'});
function effect(row, faction, culture) {
  const [declaration, condition = ''] = row.source.split(/\s+requires\s+/, 2);
  let applies = true;
  if (condition) {
    const factions = /^factions\s*\{\s*([\w,\s-]+)\s*\}(.*)$/.exec(condition);
    if (!factions) applies = null;
    else {
      const matches = factions[1].split(/[\s,]+/).some((v) => v && (v === faction || v === culture)),
        rest = factions[2].trim();
      applies = rest ? !matches && /^and\b/.test(rest) ? false : null : matches;
    }
  }
  if (applies === false) return null;
  const numeric = /^([a-z_]+)\s+(?:bonus\s+)?(-?\d+)$/.exec(declaration),
    recruitment = /^(recruit|agent)\s+(?:"([^"]+)"|([\w-]+))\s+(-?\d+)$/.exec(declaration);
  let label = declaration;
  if (numeric && Object.hasOwn(effectNames, numeric[1])) label = `${effectNames[numeric[1]]}: ${numeric[2]}`;
  if (recruitment) label = `${recruitment[1] === 'agent' ? 'Agent' : 'Recruitment'}: ${humanize(recruitment[2] ?? recruitment[3])}`;
  return freeze({label, source: row.source, line: row.line, conditional: applies === null,
    condition: applies === null ? condition : '', value: numeric ? Number(numeric[2]) : null,
    // Amounts remain source units. No percentage, income or current-city
    // total is inferred, and unknown conditions remain visibly conditional.
    interpretation: numeric ? 'source-amount' : recruitment ? 'source-recruitment' : 'source-declaration'});
}
export function decodeCampaignBuildingImage(bytes, kind) {
  if (kind !== 'card' && kind !== 'preview') throw new TypeError('Invalid building image kind');
  if (!(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer) ||
    bytes.length < 18 || bytes.length > 256 * 1024) throw new TypeError('Building image byte bound exceeded');
  const header = new DataView(bytes.buffer, bytes.byteOffset, 18),
    width = header.getUint16(12, true), height = header.getUint16(14, true),
    // The owned generic constructed fallback is 360x160; culture-specific
    // illustrations are 361x163. Both are independently pinned in the manifest.
    admitted = kind === 'card' ? width === 78 && height === 62 :
      width === 361 && height === 163 || width === 360 && height === 160;
  if (!admitted)
    throw new Error('Original building image dimensions differ');
  const image = bytes[2] === 10 ? decodeUnitCardTga(bytes) : decodeTgaTexture(bytes);
  return {width: image.width, height: image.height, rgba: image.rgba};
}

/** readAsset(name) is the root-owned gameAssets.read adapter. Source metadata
 * is parsed synchronously; only inspected cards and requested previews load.
 * The owner retains no DOM, callbacks after disposal, original input bytes,
 * URLs, timers or simulated economy. Missing/corrupt images degrade locally.
 */
export function createCampaignBuildingAssets({descriptorBytes, localizationBytes, uiVariantsBytes, factionBytes,
  readAsset, isOpen = () => true} = {}) {
  if (typeof readAsset !== 'function' || typeof isOpen !== 'function') throw new TypeError('Invalid building asset adapter');
  if (!isOpen()) throw abortError();
  const definitions = parseDescriptors(descriptorBytes), localization = parseLocalization(localizationBytes),
    variants = parseVariants(uiVariantsBytes), factions = parseFactions(factionBytes),
    specs = new Map(campaignBuildingImageSpecs.map((v) => [`${v.culture}:${v.level}:${v.kind}`, v])),
    models = new WeakSet(), cache = new Map(), pending = new Map(), failures = new Set(), queue = [],
    abort = new AbortController();
  let disposed = false, decodedBytes = 0, active = 0, imageReads = 0;
  descriptorBytes = localizationBytes = uiVariantsBytes = factionBytes = null;
  const alive = () => { if (disposed || !isOpen()) throw abortError(); };
  alive();
  function localized(level, faction, culture, suffix) {
    const keys = [`${level}_${faction}${suffix}`, `${level}_${culture}${suffix}`];
    if (culture === 'carthaginian') keys.push(`${level}_carthage${suffix}`);
    keys.push(level + suffix);
    for (const key of keys) {
      const value = localization.get(key);
      if (value && !/placeholder|do not translate|should never appear/i.test(value)) return {key, value};
    }
    return {key: null, value: ''};
  }
  function pump() {
    while (!disposed && active < campaignBuildingLimits.imageConcurrency && queue.length) {
      const {run, resolve, reject} = queue.shift(); active++;
      Promise.resolve().then(run).then(resolve, reject).finally(() => { active--; pump(); });
    }
  }
  function readImage(spec) {
    alive();
    if (cache.has(spec.name)) { const v = cache.get(spec.name); cache.delete(spec.name); cache.set(spec.name, v); return Promise.resolve(v); }
    if (failures.has(spec.name)) return Promise.resolve(null);
    if (pending.has(spec.name)) return pending.get(spec.name);
    const promise = new Promise((resolve, reject) => {
      queue.push({resolve, reject, run: async () => {
        alive(); imageReads++;
        try {
          const input = await readAsset(spec.name, {signal: abort.signal}); alive();
          if (!(input instanceof Uint8Array) || !(input.buffer instanceof ArrayBuffer) || input.length !== spec.limit)
            throw new Error('Original building image source extent differs');
          const bytes = new Uint8Array(input), hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
            (n) => n.toString(16).padStart(2, '0')).join('');
          alive();
          if (hash !== spec.sha256) throw new Error('Original building image source hash differs');
          const decoded = decodeCampaignBuildingImage(bytes, spec.kind), image = freeze({...decoded,
            sourcePath: spec.path, sourceSha256: hash, generic: spec.culture === 'generic'});
          while (cache.size && (cache.size >= campaignBuildingLimits.decodedImages ||
            decodedBytes + image.rgba.length > campaignBuildingLimits.decodedBytes)) {
            const [key, old] = cache.entries().next().value; cache.delete(key); decodedBytes -= old.rgba.length;
          }
          cache.set(spec.name, image); decodedBytes += image.rgba.length;
          return image;
        } catch (error) {
          if (disposed || !isOpen() || error?.name === 'AbortError') throw abortError();
          failures.add(spec.name); return null;
        }
      }});
      pump();
    });
    pending.set(spec.name, promise);
    promise.then(() => pending.delete(spec.name), () => pending.delete(spec.name));
    return promise;
  }
  return freeze({
    describe(building, {sourceFaction = '', culture = null} = {}) {
      alive();
      if (!building || !Array.isArray(building.source) || building.source.length > campaignBuildingLimits.sourceRows ||
        building.source.some((r) => !r || typeof r.text !== 'string' || r.text.length > 16384))
        throw new TypeError('Invalid building inspection source rows');
      if (sourceFaction && !identifier(sourceFaction) || culture !== null && !identifier(culture))
        throw new TypeError('Invalid building source faction or culture');
      const types = building.source.map((r) => ({...r, text: withoutComment(r.text).trim()})).filter((r) => /^type\b/.test(r.text)),
        match = types.length === 1 && /^type\s+([a-z][\w+\-]*)\s+([a-z][\w+\-]*)$/.exec(types[0].text),
        type = match ? match[1] : null, level = match ? match[2] : null,
        definition = match ? definitions.get(`${type}:${level}`) : null;
      culture ??= factions.get(sourceFaction) ?? null;
      const name = level ? localized(level, sourceFaction, culture, '') : {value: '', key: null},
        description = level ? localized(level, sourceFaction, culture, '_desc') : {value: '', key: null},
        short = level ? localized(level, sourceFaction, culture, '_desc_short') : {value: '', key: null},
        model = freeze({type, level, sourceFaction, culture,
          name: name.value || (level ? humanize(level) : 'Building'),
          group: type ? humanize(type) : 'Details unavailable',
          description: description.value, shortDescription: short.value,
          localizationKeys: freeze({name: name.key, description: description.key, shortDescription: short.key}),
          sourceLine: types[0]?.line ?? null, descriptorLine: definition?.line ?? null,
          cost: definition?.cost ?? null, construction: definition?.construction ?? null,
          effects: freeze((definition?.capabilities ?? []).map((r) => effect(r, sourceFaction, culture)).filter(Boolean)),
          status: definition ? 'source-backed' : match ? 'unmapped' : 'ambiguous'});
      models.add(model); return model;
    },
    async loadImage(model, kind) {
      alive();
      if (!models.has(model) || !['card', 'preview'].includes(kind)) throw new TypeError('Invalid building model or image kind');
      if (model.status !== 'source-backed') return null;
      const cultures = model.culture ? [model.culture, ...(variants.get(model.culture) ?? [])] : [],
        levels = [model.level, ...(variants.get(model.level) ?? [])];
      // Keep cached pixels private, including when consumers share a pending
      // decode. The frozen result metadata does not make a typed array immutable.
      for (const culture of cultures) for (const level of levels) {
        const spec = specs.get(`${culture}:${level}:${kind}`);
        if (spec) { const image = await readImage(spec); alive(); if (image) return freeze({...image, rgba: new Uint8Array(image.rgba)}); }
      }
      const generic = specs.get(`generic:generic:${kind}`);
      const image = generic ? await readImage(generic) : null;
      alive(); return image ? freeze({...image, rgba: new Uint8Array(image.rgba)}) : null;
    },
    get status() { return freeze({state: disposed ? 'disposed' : 'ready', definitions: definitions.size,
      localizedEntries: localization.size, cultures: factions.size, decodedImages: cache.size, decodedBytes,
      pendingImages: pending.size, activeImages: active, failedImages: failures.size, imageReads}); },
    dispose() {
      if (disposed) return; disposed = true; abort.abort();
      for (const item of queue.splice(0)) item.reject(abortError());
      cache.clear(); pending.clear(); failures.clear(); decodedBytes = 0;
      definitions.clear(); localization.clear(); variants.clear(); factions.clear(); specs.clear();
    },
  });
}
