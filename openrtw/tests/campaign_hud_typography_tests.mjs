import { installCampaignHudHost } from './fixtures/campaign-hud-host.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
const web = new URL('../platform/web/', import.meta.url);
const { parseCufFont, fitCufText, createCufTextPresenter } = await import(
  new URL('cuf-font.js', web)
);
const { createCampaignFog } = await import(new URL('campaign-fog.js', web));
const hudSource = (await fs.readFile(new URL('campaign-hud.js', web), 'utf8')).replace(
  /from '\/([^']+)'/g,
  (_, name) => `from '${new URL(name, web).href}'`
);
const { createCampaignHud, campaignHudUnitCount } = await import(
  'data:text/javascript;base64,' + Buffer.from(hudSource).toString('base64')
);
let passed = 0;
const test = async (name, run) => {
  await run();
  passed++;
  console.log('PASS ' + name);
};
const host = installCampaignHudHost();
const {Element, created, all, hasClass} = host;
function font() {
  const start = 32 + 65536 * 2,
    count = 95,
    bitmap = start + count * 8;
  const bytes = new Uint8Array(bitmap + count),
    view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('CUF0'));
  view.setUint16(6, 10, true);
  view.setInt16(8, 3, true);
  view.setInt16(14, 2, true);
  view.setUint16(26, count, true);
  view.setUint32(28, count, true);
  bytes.fill(255, 32, start);
  for (let i = 0; i < count; i++) {
    view.setUint16(32 + (i + 32) * 2, i, true);
    bytes.set([2, 2, 1, 1], start + i * 4);
    view.setUint32(start + count * 4 + i * 4, i, true);
    bytes[bitmap + i] = 255;
  }
  return parseCufFont(bytes);
}
try {
  await test('source glyph labels preserve full DOM text, truncate whole glyphs and reuse their canvas', () => {
    const parsed = font(),
      node = new Element('strong');
    assert.equal(fitCufText(parsed, 'abcdefgh', 12), 'abc...');
    const owner = createCufTextPresenter({
      node,
      font: parsed,
      createCanvas: () => new Element('canvas'),
      maxWidth: 12,
    });
    const state = owner.set('abcdefgh'),
      bitmap = node.children[1];
    assert.equal(state.state, 'active');
    assert.equal(state.renderedText, 'abc...');
    assert.equal(node.textContent, 'abcdefgh');
    assert.equal(bitmap.attributes['aria-hidden'], 'true');
    assert.equal(owner.set('abcdefgh'), state);
    assert.equal(bitmap.context.uploads, 1);
    owner.set('X');
    assert.equal(node.children[1], bitmap);
    assert.equal(bitmap.context.uploads, 2);
    assert.equal(owner.set('\u2603').state, 'fallback');
    assert.equal(node.textContent, '\u2603');
    assert(bitmap.hidden);
    owner.dispose();
    owner.dispose();
    assert.equal(bitmap.width + bitmap.height, 0);
    assert.equal(node.textContent, '\u2603');
    assert.throws(() => owner.set('X'), /disposed/);
  });
  await test('absent font keeps readable DOM text without allocating bitmap resources', () => {
    const node = new Element('span');
    const owner = createCufTextPresenter({
      node,
      createCanvas: () => {
        throw Error('must not allocate');
      },
    });
    assert.equal(owner.set('Army').state, 'fallback');
    assert.equal(node.textContent, 'Army');
    owner.dispose();
  });
  await test('only explicit campaign soldier counts become badges; definition sizes stay in accessible details', () => {
    for (const base of [12, 40]) {
      const info = campaignHudUnitCount({
        count: null,
        unitDefinition: { sourceSoldierCount: base },
      });
      assert.equal(info.badge, '');
      assert.match(info.description, /unavailable/);
      assert(info.detail.includes(String(base)));
    }
    assert.equal(campaignHudUnitCount({ count: 0 }).badge, '0');
    assert.equal(
      campaignHudUnitCount({ count: 121, unitDefinition: { sourceSoldierCount: 40 } }).badge,
      '121'
    );
    assert.throws(() => campaignHudUnitCount({ count: -1 }));
  });
  if (process.env.OPENRTW_OWNED_GAME) {
    const inputs = {
      campaignHudLayout: 'ui/strat3.rsd',
      campaignHudAtlas1: 'ui/roman/interface/stratpage_01.tga',
      campaignHudAtlas2: 'ui/roman/interface/stratpage_02.tga',
      campaignHudAtlas3: 'ui/roman/interface/stratpage_03.tga',
      campaignHudSharedLayout: 'ui/shared2.rsd',
      campaignHudSharedAtlas0: 'ui/roman/interface/sharedpage_01.tga',
      campaignHudSharedAtlas1: 'ui/roman/interface/sharedpage_00.tga',
      unitCardJuliiGeneral: 'ui/units/romans_julii/#roman_generals_guard_cavalry_early.tga',
      unitCardJuliiHastati: 'ui/units/romans_julii/#roman_hastati.tga',
      unitCardJuliiTriarii: 'ui/units/romans_julii/#roman_triarii.tga',
      unitCardJuliiArcher: 'ui/units/romans_julii/#roman_archer.tga',
      campaignFontDb: 'descr_font_db.txt',
      campaignCalendarFont: 'fonts/sml_font_10.cuf',
    };
    const assets = new Map(
      await Promise.all(
        Object.entries(inputs).map(async ([k, file]) => [
          k,
          new Uint8Array(
            await fs.readFile(path.join(process.env.OPENRTW_OWNED_GAME, 'data', file))
          ),
        ])
      )
    );
    for (const missingFont of [false, true])
      await test(`owned full HUD typography uses ${missingFont ? 'DOM fallback' : 'source glyphs'}, retains controls and releases all canvases`, async () => {
        const start = created.length,
          parent = new Element('div'),
          mount = new Element('div');
        parent.clientWidth = 1024;
        parent.clientHeight = 768;
        parent.append(mount);
        const noop = () => {},
          owner = await createCampaignHud({
            mount,
            isOpen: () => true,
            readAsset: async (name) => {
              if (missingFont && name === 'campaignFontDb') throw Error('Missing optional font');
              return assets.get(name);
            },
            onSelect: noop,
            onContinue: noop,
            onEndTurn: noop,
            onCenter: noop,
            onMenu: noop,
          });
        const state = {
          characters: [{ id: 0, name: 'Flavius Julius', x: 1, y: 1, actionPoints: 80 }],
          selectedId: 0,
          army: {
            actorId: 0,
            faction: 'romans_julii',
            rows: [
              {
                sourceArmyIndex: 0,
                name: 'roman hastati',
                count: null,
                unitDefinition: { dictionary: 'roman_hastati', sourceSoldierCount: 40 },
              },
            ],
          },
          calendar: 'Summer 270 BC',
          canSelect: true,
          canContinue: true,
          canEndTurn: true,
          canCenter: true,
          worldWidth: 4,
          worldHeight: 4,
        };
        owner.update(state);
        assert.equal(all(mount).find((n) => hasClass(n, 'hud-name')).textContent, 'Flavius Julius');
        assert.equal(all(mount).find((n) => hasClass(n, 'hud-ap')).textContent, '80 AP');
        assert.equal(mount.dataset.inspection, 'army');
        const nodes = all(mount),
          labels = nodes.filter((n) => hasClass(n, 'hud-cuf-label'));
        assert(labels.length >= 12);
        for (const n of labels)
          if (n.textContent)
            assert.equal(n.dataset.font, missingFont ? 'fallback' : 'cuf', n.textContent);
        const select = nodes.find((n) => n.tagName === 'select');
        assert.equal(select.attributes['aria-label'], 'Select campaign character');
        assert.equal(select.value, '0');
        assert(select.children[0].disabled, 'the prompt cannot replace an active selection');
        assert.equal(select.children[1].textContent, 'Flavius Julius');
        assert(!mount.textContent.includes('Soldier counts are unavailable'));
        assert(!mount.textContent.includes('Unit cards show'));
        assert(!mount.textContent.includes('WASD'));
        assert(!nodes.some((n) => hasClass(n, 'hud-inspection-note')));
        assert(!nodes.some((n) => hasClass(n, 'hud-help')));
        assert.equal(nodes.filter((n) => hasClass(n, 'hud-unit-count')).length, 0);
        const card = nodes.find((n) => n.dataset.hudUnitCard);
        assert.equal(card.children.find((n) => hasClass(n, 'hud-unit-name')).textContent, 'Hastati');
        assert.equal(card.children.find((n) => hasClass(n, 'hud-unit-name')).children[0].dataset.font,
          missingFont ? 'fallback' : 'cuf');
        assert.equal(card.attributes['aria-label'], 'Hastati');
        assert.match(card.title, /40/);
        assert.match(card.title, /unavailable/);
        const roster = nodes.find((n) => hasClass(n, 'hud-roster')),
          firstCard = roster.children[0];
        const before = created.filter((n) => n.tagName === 'canvas').length;
        owner.update(state);
        assert.equal(roster.children[0], firstCard);
        assert.equal(created.filter((n) => n.tagName === 'canvas').length, before);
        const explicit = structuredClone(state);
        explicit.army.rows[0].count = 120;
        owner.update(explicit);
        const count = all(mount).find((n) => hasClass(n, 'hud-unit-count'));
        assert.equal(count.textContent, '120');
        const oldBitmap = count.children.find((n) => n.tagName === 'canvas');
        owner.update(state);
        if (oldBitmap) assert.equal(oldBitmap.width + oldBitmap.height, 0);
        owner.update({
          ...state,
          army: {
            ...state.army,
            rows: [{
              ...state.army.rows[0],
              name: 'roman generals guard cavalry early',
              unitDefinition: { dictionary: 'roman_generals_guard_cavalry_early' },
            }],
          },
        });
        const bodyguardName = all(mount).find((n) => hasClass(n, 'hud-unit-name'));
        assert.equal(bodyguardName.textContent, "General's Bodyguard");
        assert(bodyguardName.children.length <= 2);
        const townState = {
          ...state,
          selectedId: null,
          army: null,
          canCenter: false,
          canContinue: false,
          selectedSettlement: {
            id: 3,
            name: 'Arretium',
            region: 'Etruria',
            x: 1,
            y: 1,
            level: 'large_town',
            population: 4000,
            sourceFaction: 'romans_julii',
            buildings: [{ source: [{ line: 4, text: 'type core_building governors_house' }] }],
          },
        };
        owner.update(townState);
        assert.equal(mount.dataset.inspection, 'town');
        assert.equal(mount.dataset.selectedSettlementId, '3');
        assert.equal(all(mount).find((n) => hasClass(n, 'hud-name')).textContent, 'Arretium');
        assert(roster.hidden);
        const town = all(mount).find((n) => hasClass(n, 'hud-settlement'));
        assert(!town.hidden);
        assert.match(town.textContent, /Population 4,000/);
        assert.match(town.textContent, /Large Town/);
        const armyTab = all(mount).find((n) => n.dataset.hudTab === 'army'),
          buildingTab = all(mount).find((n) => n.dataset.hudTab === 'buildings');
        assert(armyTab.disabled);
        assert(!buildingTab.disabled);
        buildingTab.click();
        assert.equal(mount.dataset.inspection, 'buildings');
        assert(town.hidden);
        const buildings = all(mount).find((n) => hasClass(n, 'hud-buildings'));
        assert(!buildings.hidden);
        assert.match(buildings.textContent, /Governors House/);
        assert.match(buildings.textContent, /Core Building/);
        const fog = createCampaignFog({ width: 4, height: 4 });
        fog.adopt({
          bytes: new Uint8Array(16),
          playerFaction: 'romans_julii',
          generation: 1,
          revision: 1,
        });
        owner.update({ ...townState, fog });
        assert.equal(mount.dataset.inspection, 'overview');
        assert.equal(mount.dataset.selectedSettlementId, '');
        assert(
          !mount.textContent.includes('Arretium'),
          'hidden settlement details must be cleared'
        );
        assert.equal(buildings.children.length, 0);
        assert.equal(town.textContent, '');
        assert.equal(all(mount).find((n) => hasClass(n, 'hud-name')).textContent, '');
        owner.update(state);
        assert.equal(mount.dataset.inspection, 'army');
        assert(!roster.hidden);
        assert(buildings.hidden);
        assert.equal(mount.dataset.selectedSettlementId, '');
        assert(armyTab.attributes['aria-selected'] === 'true');
        assert(buildingTab.disabled);
        const regionalFog = createCampaignFog({ width: 255, height: 156 }),
          regionalBytes = new Uint8Array(255 * 156),
          adoptRegional = () =>
            regionalFog.adopt({
              bytes: regionalBytes,
              playerFaction: 'romans_julii',
              generation: 1,
              revision: 1,
            });
        regionalBytes[0] = regionalBytes[regionalBytes.length - 1] = 1;
        regionalBytes[80 * 255 + 90] = regionalBytes[80 * 255 + 120] = 2;
        adoptRegional();
        const regionalState = {
          ...state,
          worldWidth: 255,
          worldHeight: 156,
          characters: [{ ...state.characters[0], x: 90, y: 80 }],
          fog: regionalFog,
        };
        owner.update(regionalState);
        const mapMode = all(mount).find((n) => n.dataset.hudMapMode !== undefined);
        assert.equal(JSON.parse(mount.dataset.minimapFrame).scope, 'world');
        assert.equal(JSON.parse(mount.dataset.minimapFrame).width, 255);
        mapMode.click();
        const regionalFrame = JSON.parse(mount.dataset.minimapFrame);
        assert.equal(regionalFrame.scope, 'selection');
        assert.equal(regionalFrame.height, 48);
        assert.equal(regionalFrame.y + regionalFrame.height / 2, 80.5);
        assert.equal(regionalFrame.x + regionalFrame.width / 2, 90.5);
        mapMode.click();
        assert.equal(JSON.parse(mount.dataset.minimapFrame).scope, 'world');
        assert.equal(JSON.parse(mount.dataset.minimapFrame).width, 255);
        mapMode.click();
        assert.deepEqual(JSON.parse(mount.dataset.minimapFrame), regionalFrame);
        owner.update({
          ...regionalState,
          characters: [{ ...regionalState.characters[0], x: 120 }],
        });
        assert.equal(JSON.parse(mount.dataset.minimapFrame).x + regionalFrame.width / 2, 120.5);
        owner.update({
          ...regionalState,
          selectedId: null,
          army: null,
          selectedSettlement: { ...townState.selectedSettlement, x: 120, y: 80 },
        });
        assert.equal(mount.dataset.inspection, 'town');
        assert.equal(JSON.parse(mount.dataset.minimapFrame).scope, 'selection');
        assert.equal(JSON.parse(mount.dataset.minimapFrame).x + regionalFrame.width / 2, 120.5);
        regionalBytes[80 * 255 + 120] = 1;
        adoptRegional();
        owner.update({
          ...regionalState,
          selectedId: null,
          army: null,
          selectedSettlement: { ...townState.selectedSettlement, x: 120, y: 80 },
        });
        assert.equal(mount.dataset.inspection, 'overview');
        assert.equal(JSON.parse(mount.dataset.minimapFrame).scope, 'explored');
        assert(!mount.textContent.includes('Arretium'));
        owner.update(state);
        const tooltip = new Element('span'),
          tooltipLabel = owner.createTextLabel(tooltip, 160, [255, 255, 255]);
        const tooltipState = tooltipLabel.set('Right-click to move');
        assert.equal(tooltipState.state, missingFont ? 'fallback' : 'active');
        assert.equal(tooltip.textContent, 'Right-click to move');
        assert.equal(tooltipLabel.set('Right-click to move'), tooltipState);
        tooltipLabel.dispose();
        tooltipLabel.dispose();
        assert.equal(tooltipLabel.set('Closed'), false);
        assert.equal(tooltip.textContent, 'Right-click to move');
        const attachedTooltip = new Element('span'),
          attachedLabel = owner.createTextLabel(attachedTooltip, 160);
        attachedLabel.set('Blocked');
        owner.dispose();
        owner.dispose();
        assert.equal(attachedLabel.set('Closed'), false);
        attachedLabel.dispose();
        assert.equal(owner.createTextLabel(new Element('span')), null);
        for (const c of created.slice(start).filter((n) => n.tagName === 'canvas'))
          assert.equal(c.width + c.height, 0, c.className);
        assert.equal(mount.children.length, 0);
      });
    const mountHud = async (options = {}) => {
      const mount = new Element('div'), parent = new Element('div'), noop = () => {};
      parent.append(mount);
      document.body.append(parent);
      const owner = await createCampaignHud({mount, readAsset: async (name) => assets.get(name),
        isOpen: () => true, onSelect:noop, onContinue:noop, onEndTurn:noop,
        onCenter:noop, onMenu:noop, ...options});
      return {owner, mount, parent};
    };
    const overview = {
      characters:[], selectedId:null, army:null, selectedSettlement:null,
      calendar:'Turn 1 · summer 270 BC', initialTreasury:'5000',
      canSelect:true, canContinue:false, canEndTurn:true, canCenter:false, canNavigate:true,
      worldWidth:255, worldHeight:156,
      minimap:{width:255,height:156,rgba:new Uint8Array(255*156*4),
        detail:{width:510,height:312,rgba:new Uint8Array(510*312*4)}},
    };
    await test('treasury displays source text and safe integer campaign balances', async () => {
      const {owner,mount} = await mountHud();
      try {
        const treasury = all(mount).find((n) => hasClass(n, 'hud-treasury'));
        for (const [value, label] of [['5000', '5000'], [3000, '3000'], [0, '0'], [-20, '-20'], [null, '']]) {
          owner.update({...overview, initialTreasury: value});
          assert.equal(treasury.textContent, label);
        }
        assert.throws(() => owner.update({...overview, initialTreasury: 1.5}), /Invalid HUD initial treasury/);
        assert.throws(() => owner.update({...overview, initialTreasury: Number.MAX_SAFE_INTEGER + 1}), /Invalid HUD initial treasury/);
      } finally {
        owner.dispose();
      }
    });
    await test('minimap navigation respects letterboxing, explicit local zoom, disabled state and cleanup', async () => {
      const calls = [], selected = [],
        {owner,mount} = await mountHud({onMapNavigate: (cell) => calls.push(cell), onSelect: (id) => selected.push(id)}),
        state = {...overview, characters:[{id:1,name:'Flavius Julius',x:90,y:80,actionPoints:80}], selectedId:1,
          canSelect:false, cameraFootprint:[{x:50,y:50},{x:100,y:50},{x:100,y:100},{x:50,y:100}]};
      owner.update(state);
      assert.equal(JSON.parse(mount.dataset.minimapFrame).mode,'world');
      const map = all(mount).find((n) => hasClass(n,'hud-map')),
        toggle = all(mount).find((n) => n.dataset.hudMapMode !== undefined);
      map.rect = {left:10,top:20,width:512,height:330};
      const click = (x,y) => {
        for (const callback of map.listeners.get('click')) callback({button:0,clientX:x,clientY:y});
      };
      click(12,185);
      assert.equal(calls.length,0,'letterbox clicks cannot navigate');
      click(266,185);
      assert.deepEqual(calls.at(-1),{x:127,y:78});
      let stopped = 0;
      for (const callback of map.listeners.get('keydown')) callback({key:'ArrowUp',preventDefault(){},stopPropagation(){stopped++;}});
      assert.deepEqual(calls.at(-1),{x:127,y:79});
      assert.equal(stopped,1);
      toggle.click();
      assert.equal(JSON.parse(mount.dataset.minimapFrame).scope,'selection');
      assert(created.some((c) => c.image?.width === 510 && c.image.height === 312),'local uses original 2x radar');
      click(266,185);
      assert.deepEqual(calls.at(-1),{x:90,y:80});
      assert.equal(selected.length,0,'navigation cannot select a character');
      assert.equal(mount.dataset.selectedId,'1');
      owner.update({...state,canNavigate:false});
      const before = calls.length;
      click(266,185);
      assert.equal(calls.length,before);
      assert.equal(map.tabIndex,-1);
      owner.dispose();
      assert.equal(map.listeners.get('click').size,0);
      assert.equal(map.listeners.get('keydown').size,0);
    });
    await test('source building preview integrates the native frame, complete CUF paragraphs and modal navigation guards', async () => {
      const start = created.length, calls = [],
        paragraph = ('This complete building description must wrap with original glyphs and preserve every sentence. ').repeat(10) + '\n\nThe final paragraph stays visible.',
        provider = {disposed:0, describe:() => ({name:"Governor's House",description:paragraph,shortDescription:'Government',
          level:'governors_house',type:'core_building',effects:[]}),
          loadImage:async (_,kind) => {const [width,height] = kind === 'card' ? [78,62] : [361,163];
            return {width,height,rgba:new Uint8Array(width*height*4)};},
          dispose(){this.disposed++;}},
        {owner,mount} = await mountHud({buildingAssets:provider,onMapNavigate:(cell)=>calls.push(cell)}),
        settlement = {id:3,name:'Arretium',region:'Etruria',x:90,y:80,level:'large_town',population:4000,
          sourceFaction:'romans_julii',buildings:[{source:[{text:'type core_building governors_house'}]}]};
      owner.update({...overview,selectedSettlement:settlement});
      const trigger = all(mount).find((n) => hasClass(n,'hud-building-preview'));
      assert(!trigger.disabled && !trigger.hidden);
      trigger.click();
      await new Promise(setImmediate);
      const dialog = document.body.children.find((n) => hasClass(n,'campaign-building-preview')),
        description = all(dialog).find((n) => hasClass(n,'campaign-building-preview-description'));
      assert(dialog.hasAttribute('open'));
      assert.match(dialog.style.borderImage,/data:image\/png;base64/);
      assert.equal(description.textContent,paragraph,'full source text appears exactly once in the DOM');
      assert.equal(description.dataset.font,'cuf');
      const bitmaps = all(description).filter((n) => n.tagName === 'canvas');
      assert(bitmaps.length > 3);
      assert(bitmaps.every((c) => c.width <= 416));
      const map = all(mount).find((n) => hasClass(n,'hud-map'));
      for (const callback of map.listeners.get('click')) callback({button:0,clientX:512,clientY:90});
      assert.equal(calls.length,0,'open source modal prevents minimap navigation');
      for (const callback of dialog.listeners.get('keydown')) callback({key:'Escape',preventDefault(){},stopPropagation(){}});
      assert(!dialog.hasAttribute('open'));
      assert(bitmaps.every((c) => c.width + c.height === 0));
      owner.dispose();
      assert.equal(provider.disposed,0,'the provider remains root-owned');
      assert(!document.body.children.includes(dialog));
      for (const c of created.slice(start).filter((n) => n.tagName === 'canvas'))
        assert.equal(c.width + c.height,0,JSON.stringify({className:c.className,width:c.width,height:c.height}));
    });
  }
} finally {
  host.restore();
}
console.log(`${passed} HUD typography families passed`);
