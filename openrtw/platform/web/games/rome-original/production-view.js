export { applyBuildingTreeOverrides } from './production-rules.js';
export function createProductionView({ mount, core, getSession, canInteract, execute, playerFactionIndex }) {
  const doc = mount.ownerDocument;
  let events = new AbortController();
  let city = null, key = '', disposed = false;
  const node = (tag, text) => { const n = doc.createElement(tag); if (text) n.textContent = text; return n; };
  const title = node('h2', 'Construction & recruitment'), info = node('p'), message = node('p', 'End turn advances one construction and one recruitment order. Completed units enter the garrison.'), content = node('div');
  message.setAttribute('role', 'status');
  const style = node('style'); style.textContent = '.production-chain{margin:10px 0;padding:8px;border:1px solid #9c8d69;border-radius:4px}.production-level{display:block;margin:5px 0;padding:7px;border-left:3px solid #a68c4f}.production-level[data-built=true]{border-color:#478155}.production-level button{margin:4px 0}.production-lock{font-size:12px;color:#756950}.production-queue li{margin:8px 0}.production-queue button{display:inline-block;width:auto;margin:3px;font-size:12px}';
  mount.append(style, title, info, message, content);
  function button(parent, text, action, disabled = false) {
    const b = node('button', text); b.type = 'button'; b.disabled = disabled || !canInteract();
    b.addEventListener('click', () => { if (!disposed && canInteract()) action(); }, { signal: events.signal }); parent.append(b); return b;
  }
  function act(kind, first, second = 0) {
    if (!canInteract()) return;
    try {
      const s = getSession();
      const ok = execute(() => core._openrtw_production_command(kind, city, first, second,
        playerFactionIndex, s.generation, s.revision, s.orderRevision));
      message.textContent = ok ? 'Production order updated.' : core.UTF8ToString(core._openrtw_error());
    } catch (error) { message.textContent = error.message; }
    key = ''; refresh();
  }
  function refresh(selectedCity = city) {
    if (disposed) return;
    city = selectedCity;
    mount.hidden = city === null;
    if (city === null) { key = ''; return; }
    if (!canInteract()) { for (const b of content.querySelectorAll('button')) b.disabled = true; key = ''; return; }
    const s = getSession(), nextKey = `${city}:${s.generation}:${s.revision}:${s.orderRevision}`;
    if (key === nextKey) return;
    const pointer = core._openrtw_production_json(city, s.generation);
    if (!pointer) { info.textContent = core.UTF8ToString(core._openrtw_error()); content.replaceChildren(); return; }
    const model = JSON.parse(core.UTF8ToString(pointer));
    if (model.schema !== 'openrtw-production-v1' || model.cityId !== city || model.generation !== s.generation ||
        !Array.isArray(model.buildings) || model.buildings.length > 2048 || !Array.isArray(model.units) || model.units.length > 4096) throw Error('Invalid production view');
    key = nextKey; events.abort(); events = new AbortController(); content.replaceChildren();
    info.textContent = `${model.region} · ${model.level.replaceAll('_', ' ')} · population ${model.population.toLocaleString()} · treasury ${model.treasury.toLocaleString()} denarii`;
    const own = model.factionIndex === playerFactionIndex;
    if (!own) { content.append(node('p', 'Select one of your settlements to issue production orders.')); return; }
    const queue = (name, jobs, definitions, recruitment) => {
      content.append(node('h3', name)); const list = node('ol'); list.className = 'production-queue'; content.append(list);
      if (!jobs.length) list.append(node('li', 'Queue empty'));
      jobs.forEach((job, i) => {
        const item = node('li', `${definitions[job.definition]?.level ?? definitions[job.definition]?.name} · ${job.remaining}/${job.total} turns${job.reason ? ' · ' + job.reason : ''}`);
        button(item, `Cancel (+${job.paid})`, () => act(recruitment ? 3 : 2, i));
        if (i) button(item, 'Move up', () => act(recruitment ? 5 : 4, i, i - 1));
        if (i + 1 < jobs.length) button(item, 'Move down', () => act(recruitment ? 5 : 4, i, i + 1)); list.append(item);
      });
    };
    queue('Construction queue', model.construction, model.buildings, false);
    queue('Recruitment queue', model.recruitment, model.units, true);
    content.append(node('h3', 'Garrison'));
    if (!model.garrison.length) content.append(node('p', 'Completed units will appear here.'));
    const army = node('select'); army.setAttribute('aria-label', 'Receiving army');
    for (const actor of s.characters.filter(a => a.sourceFactionIndex === playerFactionIndex && ['named character', 'general', 'captain'].includes(a.type))) {
      const option = node('option', `${actor.name} · ${actor.armyRecords}/20 units`); option.value = String(actor.id); army.append(option);
    }
    content.append(army);
    model.garrison.forEach((u, i) => { const row = node('div', `${u.name} · ${u.soldiers} soldiers · experience ${u.experience}`);
      button(row, 'Assign to army in this region', () => act(6, i, Number(army.value)), !army.options.length); content.append(row); });
    const recruitment = node('details'); recruitment.open = true; recruitment.append(node('summary', 'Recruit units'));
    for (const u of model.units.filter(u => u.reason !== 'Unit belongs to another faction' && u.reason !== 'Fleet recruitment is not available')) {
      const row = node('div'); row.className = 'production-level';
      row.append(node('strong', `${u.name} · ${u.soldiers} soldiers`), node('div', `${u.cost} denarii · ${u.turns} turns`));
      const reason = u.reason || (model.treasury < u.cost ? 'Insufficient funds' : model.recruitment.length >= 9 ? 'Queue full' : '');
      button(row, 'Recruit', () => act(1, u.id), Boolean(reason)); if (reason) row.append(node('div', reason)); recruitment.append(row);
    }
    content.append(recruitment);
    const tree = node('details'); tree.open = true; tree.append(node('summary', 'Building trees'));
    const chains = new Map(); for (const b of model.buildings) { if (!chains.has(b.chain)) chains.set(b.chain, []); chains.get(b.chain).push(b); }
    for (const [chain, levels] of chains) {
      const group = node('details'); group.className = 'production-chain'; group.append(node('summary', chain.replaceAll('_', ' ')));
      for (const b of levels) {
        const row = node('div'); row.className = 'production-level'; row.dataset.built = String(b.built);
        row.append(node('strong', b.level.replaceAll('_', ' ') + (b.built ? ' ✓ Built' : '')),
          node('div', `${b.cost} denarii · ${b.turns} turns · ${b.settlementMin.replaceAll('_', ' ')}`));
        if (b.upgrades.length) row.append(node('div', '→ ' + b.upgrades.map(v => v.replaceAll('_', ' ')).join(' / ')));
        if (b.recruits?.length) row.append(node('div', 'Recruitment unlocks: ' + [...new Set(b.recruits)].join(', ')));
        const reason = b.reason || (model.treasury < b.cost ? 'Insufficient funds' : model.construction.length >= 9 ? 'Queue full' : '');
        button(row, 'Construct', () => act(0, b.id), Boolean(reason));
        const details = node('div', reason || 'Available'); details.className = 'production-lock'; row.append(details);
        if (b.requires.length) row.append(node('small', b.requires.join(' ')));
        group.append(row);
      }
      tree.append(group);
    }
    content.append(tree);
  }
  return Object.freeze({ refresh, dispose() { if (disposed) return; disposed = true; events.abort(); mount.replaceChildren(); } });
}
