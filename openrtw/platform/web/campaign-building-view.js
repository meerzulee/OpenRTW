// Original card/constructed art and localized text; responsive browser dialog
// placement. Native dialog coordinates and construction mechanics are not
// established. See the retained native-ui-contract in the private analysis.
const maxCards = 256, maxSourceCharacters = 2 * 1024 * 1024;
let instanceSerial = 0;
const styles = `
.campaign-building-list{display:flex;flex-wrap:wrap;gap:5px;margin:0;padding:2px;list-style:none;align-content:flex-start}
.campaign-building-item{display:block;margin:0;padding:0;width:78px;height:62px;flex:0 0 78px}
.campaign-building-card{position:relative;display:block;width:78px;height:62px;padding:0;border:0;background:transparent;color:#342b20;font:11px/13px Georgia,serif;cursor:pointer}
.campaign-building-card canvas{display:block;width:78px;height:62px}
.campaign-building-card:focus-visible{outline:2px solid #8d6426;outline-offset:1px}
.campaign-building-card:disabled{cursor:default;opacity:.6}
.campaign-building-card .campaign-building-fallback{box-sizing:border-box;display:flex;align-items:center;justify-content:center;width:78px;height:62px;padding:3px;background:#e6d6b8;border:1px solid #a38d63;text-align:center;overflow:hidden}
.campaign-building-card [hidden],.campaign-building-preview [hidden]{display:none!important}
.campaign-building-empty{margin:3px;color:#54442e;font:12px/18px Georgia,serif}
.campaign-building-preview{box-sizing:border-box;position:fixed;inset:0;margin:auto;width:550px;max-width:calc(100vw - 24px);max-height:calc(100vh - 24px);overflow:auto;padding:16px;color:#342b20;background:#e9ddc5;border:3px ridge #ac9772;box-shadow:0 8px 35px #0008;font:14px/1.5 Georgia,serif;z-index:10000}
.campaign-building-preview::backdrop{background:#0006}
.campaign-building-preview[data-fallback-open="true"]{display:block}
.campaign-building-preview header{display:flex;align-items:center;gap:12px;margin:0 0 10px;padding:0;border:0;background:transparent}
.campaign-building-preview h2{margin:0;flex:1;font:700 19px/1.3 Georgia,serif}
.campaign-building-close{width:32px;min-width:32px;max-width:32px;flex:0 0 32px;height:32px;min-height:32px;margin:0;padding:0;color:inherit;background:#f1e6cf;border:1px solid #9b8156;font:13px Georgia,serif;cursor:pointer}
.campaign-building-close:focus-visible{outline:2px solid #8d6426;outline-offset:2px}
.campaign-building-preview-art{display:block;width:361px;max-width:100%;height:auto;max-height:none;aspect-ratio:auto;object-fit:fill;background:transparent;border:0;padding:0;margin:0 auto 12px}
.campaign-building-preview-description{white-space:pre-line;margin:8px 0 12px;overflow-wrap:break-word}
.campaign-building-preview h3{font:700 14px Georgia,serif;margin:12px 0 6px}
.campaign-building-benefits{padding-left:20px;margin:0}
.campaign-building-benefits small{display:block;color:#66543c;font:12px/1.4 Georgia,serif}
.campaign-building-preview-missing{margin:8px 0;color:#66543c;font-size:12px}
`;

/** assets is root-owned and is never disposed by this view. createTextLabel
 * optionally paints a source CUF label in an element and returns {dispose()}.
 * Cards inspect existing source records only. No construction commands exist.
 */
export function createCampaignBuildingView({mount, assets, createTextLabel = null, decorateDialog = null, isOpen = () => true} = {}) {
  const document = mount?.ownerDocument;
  if (!document || typeof mount.append !== 'function' || !assets ||
    typeof assets.describe !== 'function' || typeof assets.loadImage !== 'function' ||
    typeof isOpen !== 'function' || createTextLabel !== null && typeof createTextLabel !== 'function' ||
    decorateDialog !== null && typeof decorateDialog !== 'function')
    throw new TypeError('Invalid campaign building view adapter');
  const id = `campaign-building-preview-${++instanceSerial}`, listeners = [], cardLabels = [], previewLabels = [],
    cards = [], cardCanvases = [], models = [], frameOwners = [];
  let disposed = false, revision = 0, previewRevision = 0, selected = null, disabled = false,
    contextKey = null, previousFocus = null, pendingImages = 0, loadedCards = 0, missingCards = 0,
    previewLoaded = false, currentSettlementId = null;
  const alive = () => { if (disposed) throw new Error('Campaign building view is disposed'); };
  const current = () => !disposed && isOpen();
  function element(tag, className = '', text = '') {
    const node = document.createElement(tag); node.className = className;
    if (text) node.textContent = text;
    return node;
  }
  const style = element('style'), list = element('ul', 'campaign-building-list'),
    dialog = element('dialog', 'campaign-building-preview'), header = element('header'),
    heading = element('h2'), closeButton = element('button', 'campaign-building-close', 'Close'),
    preview = element('canvas', 'campaign-building-preview-art'),
    previewMissing = element('p', 'campaign-building-preview-missing', 'Preview image unavailable'),
    description = element('p', 'campaign-building-preview-description'),
    benefitsHeading = element('h3', '', 'Building benefits'), benefits = element('ul', 'campaign-building-benefits');
  style.textContent = styles;
  list.setAttribute('aria-label', 'Existing settlement buildings');
  heading.id = `${id}-title`; description.id = `${id}-description`; dialog.id = id;
  dialog.setAttribute('aria-labelledby', heading.id); dialog.setAttribute('aria-describedby', description.id);
  dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('role', 'dialog');
  closeButton.type = 'button'; closeButton.setAttribute('aria-label', 'Close building inspection');
  preview.width = 361; preview.height = 163; preview.hidden = true;
  preview.setAttribute('role', 'img');
  header.append(heading, closeButton);
  dialog.append(header, preview, previewMissing, description, benefitsHeading, benefits);
  // A document-level modal also works when the Buildings tab's mount is hidden.
  try {
    if (decorateDialog) {
      const owner = decorateDialog(dialog, {closeButton});
      if (owner) frameOwners.push(owner);
    }
    (document.body ?? mount).append(dialog);
    mount.append(style, list);
  } catch (error) {
    for (const owner of frameOwners) try { owner?.dispose?.(); } catch {}
    dialog.remove(); style.remove(); list.remove(); throw error;
  }
  function listen(target, type, listener, options) {
    target.addEventListener(type, listener, options);
    listeners.push(() => target.removeEventListener(type, listener, options));
  }
  function release(labels) {
    const errors = [];
    for (const owner of labels.splice(0)) try { owner?.dispose?.(); } catch (error) { errors.push(error); }
    return errors;
  }
  function releaseCanvases(canvases) {
    const errors = [];
    for (const canvas of canvases.splice(0)) {
      for (const dimension of ['width', 'height']) {
        try { canvas[dimension] = 0; } catch (error) { errors.push(error); }
      }
    }
    return errors;
  }
  function text(node, value, owners, rasterize = true) {
    node.textContent = value;
    if (rasterize && createTextLabel && value) {
      const owner = createTextLabel(node, value);
      if (owner) owners.push(owner);
    }
  }
  function paint(canvas, image, label) {
    const admitted = image && (canvas === preview
      ? image.width === 361 && image.height === 163 || image.width === 360 && image.height === 160
      : image.width === 78 && image.height === 62);
    if (!admitted || !(image.rgba instanceof Uint8Array) ||
      image.rgba.length !== image.width * image.height * 4 ||
      !Number.isInteger(image.width) || !Number.isInteger(image.height))
      throw new Error('Invalid original building image');
    canvas.width = image.width; canvas.height = image.height;
    canvas.style.width = `${image.width}px`;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Building image canvas is unavailable');
    const pixels = context.createImageData(image.width, image.height);
    pixels.data.set(image.rgba); context.putImageData(pixels, 0, 0);
    canvas.setAttribute('aria-label', label);
    canvas.dataset.sourcePath = image.sourcePath ?? '';
    canvas.dataset.sourceSha256 = image.sourceSha256 ?? '';
    canvas.dataset.generic = String(Boolean(image.generic));
    canvas.hidden = false;
  }
  function close({restoreFocus = true} = {}) {
    if (selected === null) return;
    selected = null; previewRevision++; previewLoaded = false;
    if (typeof dialog.close === 'function' && dialog.open) dialog.close();
    else { dialog.removeAttribute('open'); delete dialog.dataset.fallbackOpen; }
    dialog.removeAttribute('aria-busy');
    preview.hidden = true; preview.width = 361; preview.height = 163;
    const failures = release(previewLabels);
    if (restoreFocus && previousFocus?.isConnected !== false) previousFocus?.focus?.();
    previousFocus = null;
    if (failures.length) throw new AggregateError(failures, 'Building preview text cleanup failed');
  }
  function conditionText(effect) {
    if (/\band not marian_reforms\s*$/.test(effect.condition)) return 'Before the Marian reforms';
    if (/\band marian_reforms\s*$/.test(effect.condition)) return 'After the Marian reforms';
    return 'Conditional benefit';
  }
  function open(index = 0) {
    alive();
    if (!current() || disabled || !Number.isInteger(index) || index < 0 || index >= models.length) return false;
    const returnFocus = selected !== null ? previousFocus : document.activeElement;
    close({restoreFocus: false});
    const model = models[index], token = ++previewRevision, generation = revision;
    selected = index; previousFocus = returnFocus ?? cards[index]; previewLoaded = false;
    release(previewLabels); heading.replaceChildren(); description.replaceChildren(); benefits.replaceChildren();
    text(heading, model.name, previewLabels);
    // The HUD adapter supplies bounded multiline CUF rendering; the complete
    // paragraph remains the DOM/accessibility fallback.
    text(description, model.description || model.shortDescription || 'No description available.', previewLabels);
    const rows = (model.effects ?? []).filter((v) => v.interpretation !== 'source-declaration');
    for (const effect of rows) {
      const item = element('li'); text(item, effect.label, previewLabels);
      if (effect.conditional) item.append(element('small', '', conditionText(effect)));
      benefits.append(item);
    }
    benefitsHeading.hidden = benefits.hidden = rows.length === 0;
    preview.hidden = true; preview.width = 361; preview.height = 163; previewMissing.hidden = false;
    previewMissing.textContent = 'Loading preview…';
    dialog.setAttribute('aria-busy', 'true');
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else { dialog.setAttribute('open', ''); dialog.dataset.fallbackOpen = 'true'; }
    closeButton.focus?.();
    pendingImages++;
    Promise.resolve().then(() => current() && generation === revision && token === previewRevision
      ? assets.loadImage(model, 'preview') : null).then((image) => {
      if (!current() || generation !== revision || token !== previewRevision || selected !== index) return;
      if (image) {
        paint(preview, image, `${model.name} building preview`); previewMissing.hidden = true; previewLoaded = true;
      } else previewMissing.textContent = 'Preview image unavailable';
    }).catch(() => {
      if (current() && generation === revision && token === previewRevision) previewMissing.textContent = 'Preview image unavailable';
    }).finally(() => {
      pendingImages--;
      if (current() && token === previewRevision) dialog.removeAttribute('aria-busy');
    });
    return true;
  }
  listen(closeButton, 'click', () => close());
  listen(dialog, 'cancel', (event) => { event.preventDefault(); close(); });
  listen(dialog, 'close', () => { if (!dialog.open && selected !== null) close(); });
  listen(dialog, 'keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    else if (event.key === 'Tab' && selected !== null) {
      // The only interactive element inside the read-only preview is Close.
      event.preventDefault(); closeButton.focus?.();
    }
  });
  function update({settlement = null, disabled: nextDisabled = false} = {}) {
    alive();
    if (typeof nextDisabled !== 'boolean' || settlement !== null &&
      (!Array.isArray(settlement.buildings) || settlement.buildings.length > maxCards ||
        typeof settlement.sourceFaction !== 'string' || settlement.sourceFaction.length > 128))
      throw new TypeError('Invalid building view settlement');
    let characters = 0;
    for (const building of settlement?.buildings ?? []) {
      if (!Array.isArray(building?.source) || building.source.length > 1024) throw new TypeError('Invalid building view source');
      for (const row of building.source) {
        if (typeof row?.text !== 'string' || row.text.length > 16384) throw new TypeError('Invalid building view source row');
        characters += row.text.length;
        if (characters > maxSourceCharacters) throw new RangeError('Building view source budget exceeded');
      }
    }
    const nextKey = settlement === null ? '' : JSON.stringify([settlement.id, settlement.sourceFaction,
      settlement.culture ?? null, settlement.buildings]);
    if (nextKey === contextKey) {
      disabled = nextDisabled;
      for (const card of cards) card.disabled = disabled;
      if (disabled) close();
      return;
    }
    // Validate/derive every model before clearing the previous inspection.
    const nextModels = (settlement?.buildings ?? []).map((b) => assets.describe(b, {
      sourceFaction: settlement.sourceFaction, culture: settlement.culture ?? null}));
    close({restoreFocus: false}); revision++; contextKey = nextKey; currentSettlementId = settlement?.id ?? null;
    disabled = nextDisabled; loadedCards = missingCards = 0;
    const failures = [...release(cardLabels), ...releaseCanvases(cardCanvases)];
    cards.length = models.length = 0; list.replaceChildren();
    if (failures.length) throw new AggregateError(failures, 'Building card text cleanup failed');
    if (!settlement || !nextModels.length) {
      const item = element('li', 'campaign-building-empty', settlement ? 'No buildings' : 'Select a settlement');
      list.append(item); return;
    }
    const generation = revision;
    nextModels.forEach((model, index) => {
      models.push(model);
      const item = element('li', 'campaign-building-item'), button = element('button', 'campaign-building-card'),
        canvas = element('canvas'), fallback = element('span', 'campaign-building-fallback');
      canvas.width = 78; canvas.height = 62; canvas.hidden = true; canvas.setAttribute('aria-hidden', 'true');
      cardCanvases.push(canvas);
      text(fallback, model.name, cardLabels);
      button.type = 'button'; button.disabled = disabled;
      button.setAttribute('aria-label', `Inspect ${model.name}`); button.setAttribute('aria-haspopup', 'dialog');
      button.setAttribute('aria-controls', id); button.setAttribute('aria-busy', 'true');
      button.title = [model.name, model.shortDescription].filter(Boolean).join('\n');
      button.dataset.buildingLevel = model.level ?? ''; button.dataset.buildingType = model.type ?? '';
      button.append(canvas, fallback); item.append(button); list.append(item); cards.push(button);
      // List-level delegation below owns these interactions without retaining
      // a new listener closure per card or settlement refresh.
      button.dataset.buildingIndex = String(index);
      pendingImages++;
      Promise.resolve().then(() => current() && generation === revision ? assets.loadImage(model, 'card') : null).then((image) => {
        if (!current() || generation !== revision) return;
        if (image) { paint(canvas, image, model.name); fallback.hidden = true; loadedCards++; }
        else missingCards++;
      }).catch(() => { if (current() && generation === revision) missingCards++; }).finally(() => {
        pendingImages--;
        if (current() && generation === revision) button.removeAttribute('aria-busy');
      });
    });
  }
  function inspectEvent(event) {
    let node = event.target;
    while (node && node !== list && !node.dataset?.buildingIndex) node = node.parentElement;
    if (!node || node === list || !node.dataset?.buildingIndex) return;
    if (event.type === 'contextmenu') event.preventDefault();
    open(Number(node.dataset.buildingIndex));
  }
  listen(list, 'click', inspectEvent); listen(list, 'contextmenu', inspectEvent);
  return Object.freeze({update, open, close,
    get status() { return Object.freeze({state: disposed ? 'disposed' : 'ready', cards: cards.length,
      loadedCards, missingCards, pendingImages, selectedIndex: selected, previewLoaded,
      settlementId: currentSettlementId}); },
    dispose() {
      if (disposed) return;
      const failures = [];
      try { close({restoreFocus: false}); } catch (error) { failures.push(error); }
      disposed = true; revision++; previewRevision++;
      for (const remove of listeners.splice(0)) try { remove(); } catch (error) { failures.push(error); }
      failures.push(...release(cardLabels), ...release(previewLabels), ...release(frameOwners));
      failures.push(...releaseCanvases(cardCanvases), ...releaseCanvases([preview]));
      for (const node of [dialog, list, style]) try { node.remove(); } catch (error) { failures.push(error); }
      cards.length = models.length = 0; currentSettlementId = null; contextKey = null;
      if (failures.length) throw new AggregateError(failures, 'Building view cleanup failed');
    },
  });
}
