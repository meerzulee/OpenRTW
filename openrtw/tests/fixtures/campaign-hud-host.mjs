import assert from 'node:assert/strict';

// Synthetic DOM/device ports shared by the real HUD constructor tests.
export function installCampaignHudHost() {
  const old = Object.fromEntries(
    ['document', 'window', 'HTMLElement', 'ImageData', 'ResizeObserver'].map((k) => [
      k,
      globalThis[k],
    ])
  );
  const created = [], observers = [];
  class Element {
    constructor(tag) {
      this.tagName = tag;
      this.children = [];
      this.dataset = {};
      this.attributes = {};
      this.listeners = new Map();
      this.style = {
        setProperty(key, value) { this[key] = value; },
        removeProperty(key) {
          delete this[key];
        },
      };
      this._text = '';
      this.className = '';
      this.width = this.height = 0;
      this.parentElement = null;
      this.classList = {
        add: (name) => {
          this.className += ' ' + name;
        },
        remove: (name) => {
          this.className = this.className
            .split(' ')
            .filter((v) => v !== name)
            .join(' ');
        },
      };
      this.context = {
        uploads: 0,
        putImageData: (image) => {
          this.context.uploads++;
          this.image = image;
        },
        createImageData: (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }),
        drawImage() {},
        fillRect() {},
        fillText() {},
        save() {},
        restore() {},
        beginPath() {},
        rect() {},
        clip() {},
        moveTo() {}, lineTo() {}, closePath() {}, stroke() {},
      };
      created.push(this);
    }
    get ownerDocument() {
      return globalThis.document;
    }
    get textContent() {
      return this._text + this.children.map((c) => c.textContent).join('');
    }
    set textContent(value) {
      this._text = value;
      this.children = [];
    }
    get firstElementChild() {
      return this.children[0];
    }
    append(...nodes) {
      for (const node of nodes) {
        if (node.tagName === 'fragment') this.append(...node.children);
        else {
          this.children.push(node);
          node.parentElement = this;
        }
      }
    }
    replaceChildren(...nodes) {
      this.children = [];
      this._text = '';
      this.append(...nodes);
    }
    setAttribute(k, v) {
      this.attributes[k] = v;
    }
    getAttribute(k) { return this.attributes[k] ?? null; }
    hasAttribute(k) { return Object.hasOwn(this.attributes, k); }
    removeAttribute(k) { delete this.attributes[k]; }
    focus() { globalThis.document.activeElement = this; }
    addEventListener(name, callback) {
      if (!this.listeners.has(name)) this.listeners.set(name, new Set());
      this.listeners.get(name).add(callback);
    }
    removeEventListener(name, callback) {
      this.listeners.get(name)?.delete(callback);
    }
    click() {
      if (!this.disabled) for (const callback of this.listeners.get('click') ?? []) callback();
    }
    remove() {
      if (this.parentElement)
        this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
    }
    getContext() {
      return this.context;
    }
    toDataURL() {
      return 'data:image/png;base64,AA==';
    }
    getBoundingClientRect() {
      return this.rect ?? { left: 0, top: 0, width: 1024, height: 181 };
    }
  }
  globalThis.HTMLElement = Element;
  globalThis.document = {
    createElement: (tag) => new Element(tag),
    createDocumentFragment: () => new Element('fragment'),
  };
  globalThis.document.body = new Element('body');
  globalThis.window = new Element('window');
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback; this.disconnects = 0; observers.push(this); }
    observe(target) { this.target = target; }
    disconnect() { this.disconnects++; }
  };
  globalThis.ImageData = class {
    constructor(data, width, height) {
      assert.equal(data.length, width * height * 4);
      Object.assign(this, { data, width, height });
    }
  };
  const all = (node) => [node, ...node.children.flatMap(all)];
  const hasClass = (node, name) => node.className.split(' ').includes(name);
  return {Element, created, observers, all, hasClass, restore() {
    for (const [key, value] of Object.entries(old))
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
  }};
}
