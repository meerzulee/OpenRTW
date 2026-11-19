// Keyboard navigation is camera presentation only: it never issues a campaign
// order. The app supplies its existing frame clock and owns rendering.
const directions = new Map([
  ['KeyW', [0, 1]],
  ['ArrowUp', [0, 1]],
  ['KeyS', [0, -1]],
  ['ArrowDown', [0, -1]],
  ['KeyA', [1, 0]],
  ['ArrowLeft', [1, 0]],
  ['KeyD', [-1, 0]],
  ['ArrowRight', [-1, 0]],
]);
const editable = (target) =>
  Boolean(
    target?.isContentEditable ||
      target?.closest?.('input,select,textarea,[contenteditable="true"],dialog')
  );
export function createCampaignCameraKeys({
  document,
  view,
  canNavigate,
  onPan,
  onActivity = () => {},
  speed = 360,
}) {
  if (
    !document?.addEventListener ||
    !view?.addEventListener ||
    typeof canNavigate !== 'function' ||
    typeof onPan !== 'function' ||
    typeof onActivity !== 'function' ||
    !Number.isFinite(speed) ||
    speed <= 0 ||
    speed > 2000
  )
    throw TypeError('Invalid campaign camera keyboard owner');
  const held = new Set(),
    listeners = [];
  let disposed = false,
    boost = false;
  const listen = (target, name, fn) => {
    target.addEventListener(name, fn);
    listeners.push([target, name, fn]);
  };
  const allowed = (target) =>
    !disposed &&
    !document.hidden &&
    canNavigate() &&
    !editable(target) &&
    !editable(document.activeElement);
  const signal = () => {
    if (!disposed) onActivity();
  };
  function clear() {
    const changed = held.size > 0;
    held.clear();
    boost = false;
    if (changed) signal();
  }
  listen(document, 'keydown', (event) => {
    if (!directions.has(event.code)) return;
    if (
      event.defaultPrevented ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      !allowed(event.target)
    )
      return;
    event.preventDefault();
    boost = Boolean(event.shiftKey);
    if (!held.has(event.code)) {
      held.add(event.code);
      signal();
    }
  });
  listen(document, 'keyup', (event) => {
    if (event.code === 'ShiftLeft' || event.code === 'ShiftRight') boost = false;
    if (held.delete(event.code)) {
      event.preventDefault();
      signal();
    }
  });
  listen(document, 'focusin', (event) => {
    if (editable(event.target)) clear();
  });
  listen(document, 'visibilitychange', () => {
    if (document.hidden) clear();
  });
  listen(view, 'blur', clear);
  return Object.freeze({
    get active() {
      return !disposed && held.size > 0;
    },
    clear,
    step(seconds) {
      if (!Number.isFinite(seconds) || seconds < 0)
        throw RangeError('Invalid camera frame interval');
      if (!allowed(document.activeElement)) {
        clear();
        return false;
      }
      let x = 0,
        y = 0;
      for (const key of held) {
        const d = directions.get(key);
        x += d[0];
        y += d[1];
      }
      x = Math.sign(x);
      y = Math.sign(y);
      if (!x && !y) return false;
      // Aliases and diagonal keys never exceed the requested camera speed.
      const length = Math.hypot(x, y),
        distance = speed * (boost ? 2 : 1) * Math.min(seconds, 0.05);
      if (!distance) return false;
      onPan((x / length) * distance, (y / length) * distance);
      return true;
    },
    status() {
      return { active: !disposed && held.size > 0, keys: [...held], boost };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      held.clear();
      boost = false;
      for (const [target, name, fn] of listeners) target.removeEventListener(name, fn);
      listeners.length = 0;
    },
  });
}
