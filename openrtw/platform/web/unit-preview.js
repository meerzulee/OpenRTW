import { describeFailure } from '/runtime/failure.js';
import createRenderer from '/renderer/renderer.mjs';
import {
  createRendererBridge,
  Transform,
  RenderState,
  StageState,
  TextureOp,
  TextureArg,
} from '/reference/renderer-bridge.js';
import { loadUnitTexture } from '/unit-texture.js';
import { assembleCasGeometry } from '/cas-geometry.js';
import { createGeometryResource, geometryResourceSchema } from '/runtime/geometry-resource.js';

const sourcePin = '61e9ad81bb33e9ec14a7b52473535e666ee0898498776f7ce2fa1d098fe2d27d';
// The assembler's existing centered, uniform 2.1/extent mapping is declared as
// an explicit candidate projection. It is not proof of native scale or axes.
const candidateProjection = Object.freeze({
  id: 'openrtw-centered-uniform-extent-v1',
  targetExtent: 2.1,
  center: 'component midpoint of assembled candidate bounds',
  scale: 'targetExtent / maximum candidate extent',
  axisOrder: 'source-order-preserved',
  qualification: 'candidate preview projection; not native scale, pose or axis proof',
});
const sourceSize = 41254,
  identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const uint = (value) => Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
const multiply = (a, b) =>
  Array.from({ length: 16 }, (_, i) => {
    let sum = 0;
    for (let k = 0; k < 4; k++) sum += a[(i >> 2) * 4 + k] * b[k * 4 + (i & 3)];
    return sum;
  });
const digest = async (bytes) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('');
export function geometry(model) {
  if (
    model.schema !== 'openrtw-cas-static-candidate-v1' ||
    model.sourceBytes !== sourceSize ||
    model.versionBits !== 0x40433333 ||
    model.totalVertices !== 171 ||
    model.totalTriangles !== 218 ||
    !Array.isArray(model.bones) ||
    model.bones.length !== 20 ||
    !Array.isArray(model.meshes) ||
    model.meshes.length !== 6 ||
    model.material?.textureName !== 'textures\\unit_roman_hastati_julii.tga'
  )
    throw new Error('Model differs from the retained Hastati layout');
  const mesh = assembleCasGeometry(model),
    vertices = mesh.vertices,
    indexBytes = mesh.indexBytes;
  if (
    !(vertices instanceof Uint8Array) ||
    !(indexBytes instanceof Uint8Array) ||
    vertices.length % 24 ||
    indexBytes.length % 2
  )
    throw new Error('Assembled candidate geometry span is unsupported');
  const extension = {
    schema: 'rome-original.cas-static-geometry/v1',
    projectionPolicy: candidateProjection,
    source: model,
  };
  if (mesh.parts !== undefined) extension.parts = mesh.parts;
  if (mesh.bounds !== undefined) extension.bounds = mesh.bounds;
  const resource = createGeometryResource({
    schema: geometryResourceSchema,
    layout: {
      stride: 24,
      endianness: 'little',
      attributes: [
        { semantic: 'position', format: 'f32x3', offset: 0 },
        { semantic: 'color', format: 'd3dcolor-bgra8', offset: 12 },
        { semantic: 'uv0', format: 'f32x2', offset: 16 },
      ],
    },
    primitive: 'triangle-list',
    indexFormat: 'uint16-le',
    counts: { vertices: vertices.length / 24, indices: indexBytes.length / 2 },
    coordinates: {
      frame: 'cas-candidate-centered',
      units: 'normalized-uniform-extent',
      up: 'uninterpreted',
      handedness: 'uninterpreted',
    },
    vertexBytes: vertices,
    indexBytes,
    extensions: { 'rome-original.cas-static-geometry/v1': extension },
  });
  // Existing title consumers still receive the unchanged assembled fields; the
  // preview uploads through the declared resource contract.
  return { ...mesh, resource };
}

export function createUnitPreview({ dialog, canOpen, onState = () => {}, readAsset, createCoreSession, sessionIdentity }) {
  if (typeof createCoreSession !== 'function')
    throw new TypeError('Model preview requires a trusted core-session factory');
  const launchIdentity = Object.freeze(Object.fromEntries(
    ['gameId', 'profileId', 'hostApiVersion', 'rulesVersion'].map((field) => {
      const value = sessionIdentity?.[field];
      if (typeof value !== 'string' || !value.length || value.length > 128)
        throw new TypeError('Model preview requires a valid session identity: ' + field);
      return [field, value];
    })
  ));
  const mount = dialog.querySelector('[data-model-mount]'),
    status = dialog.querySelector('[data-model-status]'),
    back = dialog.querySelector('[data-model-close]');
  const left = dialog.querySelector('[data-model-left]'),
    right = dialog.querySelector('[data-model-right]'),
    reset = dialog.querySelector('[data-model-reset]');
  const controls = [left, right, reset],
    cleanupFailures = [],
    observers = new Set();
  let current = null,
    pending = null,
    disposed = false,
    closing = false,
    cachedBytes = null,
    cachedTextureBytes = null,
    serial = 0,
    disposal = null,
    notifying = false;
  const disable = () =>
    controls.forEach((button) => {
      button.disabled = true;
    });
  disable();
  const live = (context) => !disposed && current === context && !context.cancelled;
  function recordCleanup(failures) {
    if (failures.length) {
      cleanupFailures.push(...failures);
      try { dialog.dataset.cleanupError = cleanupFailures.join('\n'); }
      catch (error) { cleanupFailures.push(describeFailure(error)); }
    }
  }
  function notifyState() {
    if (notifying) return;
    notifying = true;
    try {
      const result = onState();
      if (result && typeof result.then === 'function') {
        const observed = Promise.resolve(result).catch((error) => recordCleanup([describeFailure(error)]));
        observers.add(observed);
        observed.then(() => observers.delete(observed));
      }
    } catch (error) { recordCleanup([describeFailure(error)]); }
    finally { notifying = false; }
  }
  function listen(context, target, type, listener, options) {
    context.listeners.push({ target, type, listener, options });
    target.addEventListener(type, listener, options);
  }
  function release(context) {
    const failures = [];
    context.geometry = null;
    const renderer = context.renderer,
      owner = context.coreOwner;
    context.renderer = context.core = context.coreOwner = context.geometry = null;
    for (const { target, type, listener, options } of context.listeners.splice(0).reverse())
      try { target.removeEventListener(type, listener, options); }
      catch (error) { failures.push(describeFailure(error)); }
    const texture = context.texture;
    context.texture = null;
    if (texture)
      try {
        texture.dispose();
      } catch (error) {
        failures.push(describeFailure(error));
      }
    if (renderer)
      for (let i = context.buffers.length - 1; i >= 0; i--)
        if (context.buffers[i]) {
          const id = context.buffers[i];
          context.buffers[i] = 0;
          try {
            renderer.destroyBuffer(id);
          } catch (error) {
            failures.push(describeFailure(error));
          }
        }
    if (renderer)
      try {
        renderer.dispose();
      } catch (error) {
        failures.push(describeFailure(error));
      }
    if (owner)
      try {
        owner.dispose();
      } catch (error) {
        failures.push(describeFailure(error));
      }
    return failures;
  }
  function cleanupStep(run) {
    try { return run(); }
    catch (error) { recordCleanup([describeFailure(error)]); }
  }
  function retire(context) {
    context.cancelled = true;
    cleanupStep(() => context.abort.abort());
    recordCleanup(release(context));
  }
  function close() {
    if (closing) return;
    closing = true;
    const context = current;
    current = null;
    try {
      if (context) retire(context);
      for (const button of controls) cleanupStep(() => { button.disabled = true; });
      cleanupStep(() => mount.replaceChildren());
      for (const key of ['mesh', 'unitTexture']) cleanupStep(() => { delete dialog.dataset[key]; });
      cleanupStep(() => { dialog.dataset.state = 'closed'; });
      cleanupStep(() => { if (dialog.open) dialog.close(); });
    } finally { closing = false; }
    notifyState();
  }
  function draw(context) {
    if (!live(context) || !context.renderer || !context.geometry) return;
    try {
      const counts = context.geometry.descriptor.counts,
        c = Math.cos(context.yaw),
        s = Math.sin(context.yaw),
        cx = Math.cos(context.pitch),
        sx = Math.sin(context.pitch);
      const ry = [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1],
        rx = [1, 0, 0, 0, 0, cx, sx, 0, 0, -sx, cx, 0, 0, 0, 0, 1],
        move = [...identity];
      move[14] = context.distance;
      context.renderer.setTransform(Transform.WORLD, multiply(multiply(ry, rx), move));
      context.texture.bind();
      context.renderer.clear({ color: 0xff151e29, depth: 1, flags: 3 });
      context.renderer.drawIndexed({
        primitive: context.geometry.descriptor.technical.primitive,
        primitiveCount: counts.triangles,
      });
      context.renderer.present();
      if (!live(context)) return;
      context.draws++;
      dialog.dataset.draws = String(context.draws);
      dialog.dataset.yaw = String(context.yaw);
      dialog.dataset.pitch = String(context.pitch);
      dialog.dataset.distance = String(context.distance);
    } catch (error) {
      showFailure(context, error);
    }
  }
  function showFailure(context, error) {
    if (!live(context)) return;
    retire(context);
    // A destructor can close/dispose the context. Its terminal state wins.
    if (current !== context || disposed) return;
    for (const button of controls) cleanupStep(() => { button.disabled = true; });
    cleanupStep(() => { dialog.dataset.state = 'error'; });
    for (const key of ['mesh', 'unitTexture']) cleanupStep(() => { delete dialog.dataset[key]; });
    cleanupStep(() => { status.textContent = `Model preview unavailable: ${describeFailure(error)}`; });
    notifyState();
  }
  async function initialize(context) {
    try {
      let bytes = cachedBytes;
      if (!bytes) {
        if (readAsset) bytes = await readAsset('hastati', { signal: context.abort.signal });
        else {
          const response = await fetch('/assets/hastati.cas', { signal: context.abort.signal });
          if (!response.ok) throw new Error(`Cannot load Hastati model: HTTP ${response.status}`);
          const declared = Number(response.headers.get('Content-Length'));
          if (!Number.isInteger(declared) || declared !== sourceSize)
            throw new Error('Unexpected model source length');
          bytes = new Uint8Array(await response.arrayBuffer());
        }
        if (!(bytes instanceof Uint8Array) || bytes.length !== sourceSize)
          throw new Error('Unexpected model source length');
        bytes = new Uint8Array(bytes);
        if ((await digest(bytes)) !== sourcePin)
          throw new Error('Hastati source differs from the retained original');
        if (!live(context)) return;
        cachedBytes = bytes;
      }
      if (!live(context)) return;
      const openedOwner = await createCoreSession(launchIdentity, {
        token: Object.freeze({
          throwIfCancelled() {
            if (!live(context)) throw new DOMException('Model preview session closed', 'AbortError');
          },
        }),
      });
      context.coreOwner = openedOwner;
      if (!live(context)) {
        recordCleanup(release(context));
        return;
      }
      const openedCore = openedOwner.core;
      if (!live(context)) return;
      context.core = openedCore;
      const pointer = openedCore._malloc(bytes.length);
      if (!pointer) throw new Error('Model input allocation failed');
      try {
        openedCore.HEAPU8.set(bytes, pointer);
        if (openedCore._openrtw_load_cas_mesh(pointer, bytes.length) !== 1)
          throw new Error(openedCore.UTF8ToString(openedCore._openrtw_error()));
      } finally {
        openedCore._free(pointer);
      }
      const sourcePointer = openedCore._openrtw_cas_mesh_source_bytes(),
        sourceLength = openedCore._openrtw_cas_mesh_source_size();
      if (
        !uint(sourcePointer) ||
        !sourcePointer ||
        sourceLength !== sourceSize ||
        sourcePointer > openedCore.HEAPU8.length - sourceLength ||
        (await digest(openedCore.HEAPU8.slice(sourcePointer, sourcePointer + sourceLength))) !==
          sourcePin
      )
        throw new Error('Core model source ownership differs');
      if (!live(context)) return;
      const jsonPointer = openedCore._openrtw_cas_mesh_json(),
        limit = 4 * 1024 * 1024;
      if (!uint(jsonPointer) || !jsonPointer || jsonPointer >= openedCore.HEAPU8.length)
        throw new Error('Core model projection is unavailable');
      const wire = openedCore.UTF8ToString(
        jsonPointer,
        Math.min(limit + 1, openedCore.HEAPU8.length - jsonPointer)
      );
      if (wire.length > limit) throw new Error('Core model projection exceeds the view limit');
      const model = JSON.parse(wire),
        assembled = geometry(model),
        resource = assembled.resource;
      context.geometry = resource;
      let textureBytes = cachedTextureBytes;
      if (!textureBytes) {
        if (readAsset)
          textureBytes = await readAsset('hastatiTexture', { signal: context.abort.signal });
        else {
          const response = await fetch('/assets/hastati-texture.dds', {
            signal: context.abort.signal,
          });
          if (!response.ok || Number(response.headers.get('Content-Length')) !== 87536)
            throw new Error('Cannot load the retained Hastati DDS candidate');
          textureBytes = new Uint8Array(await response.arrayBuffer());
        }
      }
      if (!live(context)) return;
      if (!(textureBytes instanceof Uint8Array) || textureBytes.length !== 87536)
        throw new Error('Unexpected Hastati DDS source length');
      textureBytes = new Uint8Array(textureBytes);
      const unitTexture = await loadUnitTexture(openedCore, textureBytes, {
        isOpen: () => live(context),
      });
      if (!live(context)) return;
      cachedTextureBytes = new Uint8Array(textureBytes);
      const canvas = document.createElement('canvas');
      canvas.id = `unit-model-${context.id}`;
      canvas.width = 720;
      canvas.height = 520;
      canvas.setAttribute('aria-label', 'Original Hastati static model');
      mount.replaceChildren(canvas);
      const openedRenderer = await createRendererBridge({
        moduleFactory: createRenderer,
        canvas,
        width: canvas.width,
        height: canvas.height,
      });
      if (!live(context)) {
        try {
          openedRenderer.dispose();
        } catch (error) {
          recordCleanup([describeFailure(error)]);
        }
        return;
      }
      context.renderer = openedRenderer;
      const requireLive = () => {
        if (!live(context)) throw new DOMException('Model preview session closed', 'AbortError');
      };
      const useRenderer = (name, ...args) => {
        requireLive();
        const result = openedRenderer[name](...args);
        requireLive();
        return result;
      };
      const ownBuffer = (slot, spec) => {
        requireLive();
        const id = openedRenderer.createBuffer(spec);
        if (!live(context)) {
          cleanupStep(() => openedRenderer.destroyBuffer(id));
          requireLive();
        }
        context.buffers[slot] = id;
        return id;
      };
      const caps = useRenderer('capabilities');
      if (
        !caps.features?.unlitFvf ||
        !caps.features?.xyz ||
        !caps.features?.depth ||
        !caps.features?.buffers ||
        !caps.indexFormats?.includes(16)
      )
        throw new Error('Renderer cannot display the model layout');
      const buffers = resource.upload({
        allocateBuffer: (slot, spec) => ownBuffer(slot, spec),
        uploadBuffer: (id, bytes) => {
          useRenderer('uploadBuffer', id, bytes);
        },
      });
      useRenderer('setStream', buffers.vertexBuffer, resource.descriptor.layout.stride);
      useRenderer('setIndices', buffers.indexBuffer, 0);
      requireLive();
      const createdTexture = unitTexture.create(openedRenderer);
      if (!live(context)) {
        cleanupStep(() => createdTexture.dispose());
        requireLive();
      }
      context.texture = createdTexture;
      useRenderer('setFvf', resource.descriptor.technical.fvf);
      useRenderer('setMaterialLighting', { enabled: false });
      useRenderer('setDirectionalLighting', { enabled: false });
      for (const state of [
        RenderState.LIGHTING,
        RenderState.ALPHATESTENABLE,
        RenderState.ALPHABLENDENABLE,
        RenderState.FOGENABLE,
        RenderState.SPECULARENABLE,
      ])
        useRenderer('setRenderState', state, 0);
      useRenderer('setRenderState', RenderState.CULLMODE, 1);
      useRenderer('setRenderState', RenderState.ZENABLE, 1);
      useRenderer('setRenderState', RenderState.ZWRITEENABLE, 1);
      useRenderer('setRenderState', RenderState.ZFUNC, 4);
      useRenderer('setTexture', 0, 0);
      useRenderer('setStageState', 1, StageState.COLOROP, TextureOp.DISABLE);
      for (const [operation, argument] of [
        [StageState.COLOROP, StageState.COLORARG1],
        [StageState.ALPHAOP, StageState.ALPHAARG1],
      ]) {
        useRenderer('setStageState', 0, operation, TextureOp.SELECTARG1);
        useRenderer('setStageState', 0, argument, TextureArg.DIFFUSE);
      }
      const near = 0.1,
        far = 100,
        ys = 1 / Math.tan(Math.PI / 8),
        xs = ys / (canvas.width / canvas.height);
      useRenderer('setTransform', Transform.VIEW, identity);
      useRenderer('setTransform', Transform.PROJECTION, [
        xs,
        0,
        0,
        0,
        0,
        ys,
        0,
        0,
        0,
        0,
        far / (far - near),
        1,
        0,
        0,
        (-near * far) / (far - near),
        0,
      ]);
      let drag = null;
      listen(context, canvas, 'pointerdown', (event) => {
        if (!live(context)) return;
        drag = [event.clientX, event.clientY];
        canvas.setPointerCapture(event.pointerId);
      });
      listen(context, canvas, 'pointermove', (event) => {
        if (!drag || !live(context)) return;
        context.yaw += (event.clientX - drag[0]) * 0.01;
        context.pitch = Math.max(
          -1.2,
          Math.min(1.2, context.pitch + (event.clientY - drag[1]) * 0.01)
        );
        drag = [event.clientX, event.clientY];
        draw(context);
      });
      for (const name of ['pointerup', 'pointercancel', 'lostpointercapture'])
        listen(context, canvas, name, () => {
          drag = null;
        });
      listen(
        context,
        canvas,
        'wheel',
        (event) => {
          event.preventDefault();
          if (!live(context)) return;
          context.distance = Math.max(
            2,
            Math.min(7, context.distance * Math.exp(event.deltaY * 0.001))
          );
          draw(context);
        },
        { passive: false }
      );
      dialog.dataset.mesh = wire;
      dialog.dataset.sourceSha256 = sourcePin;
      dialog.dataset.unitTexture = JSON.stringify({
        metadata: unitTexture.metadata,
        sourceSha256: unitTexture.sourceSha256,
        presentationPolicy: unitTexture.presentationPolicy,
      });
      dialog.dataset.vertices = String(resource.descriptor.counts.vertices);
      dialog.dataset.triangles = String(resource.descriptor.counts.triangles);
      dialog.dataset.state = 'ready';
      status.textContent = `${resource.descriptor.counts.vertices} vertices · ${resource.descriptor.counts.triangles} triangles · original Hastati DDS candidate, 9 mips. Drag to rotate; scroll to zoom.`;
      controls.forEach((button) => {
        button.disabled = false;
      });
      draw(context);
      notifyState();
    } catch (error) {
      if (live(context)) showFailure(context, error);
      else {
        let aborted = false;
        try { aborted = error?.name === 'AbortError'; } catch {}
        if (!aborted) recordCleanup([describeFailure(error)]);
      }
    }
  }
  function open() {
    if (disposed || closing || pending || observers.size || cleanupFailures.length || current || !canOpen()) return;
    const context = {
      id: ++serial,
      cancelled: false,
      abort: new AbortController(),
      core: null,
      coreOwner: null,
      renderer: null,
      texture: null,
      geometry: null,
      buffers: [0, 0],
      listeners: [],
      yaw: 0.55,
      pitch: -0.15,
      distance: 3.5,
      draws: 0,
    };
    current = context;
    for (const key of [
      'mesh',
      'sourceSha256',
      'unitTexture',
      'vertices',
      'triangles',
      'draws',
      'yaw',
      'pitch',
      'distance',
    ])
      delete dialog.dataset[key];
    dialog.dataset.state = 'loading';
    status.textContent = 'Loading the original Hastati mesh and DDS candidate…';
    disable();
    // Install the barrier before any host callback can close/dispose the view.
    pending = Promise.resolve().then(() => live(context) && initialize(context)).finally(() => {
      pending = null;
      notifyState();
    });
    try { dialog.showModal(); }
    catch (error) { showFailure(context, error); }
    notifyState();
  }
  const turn = (amount) => {
    if (current && dialog.dataset.state === 'ready') {
      current.yaw += amount;
      draw(current);
    }
  };
  const turnLeft = () => turn(-0.35),
    turnRight = () => turn(0.35),
    resetView = () => {
      if (current && dialog.dataset.state === 'ready') {
        current.yaw = 0.55;
        current.pitch = -0.15;
        current.distance = 3.5;
        draw(current);
      }
    };
  const cancel = (event) => {
    event.preventDefault();
    close();
  };
  const nativeClosed = () => {
    // A queued close event from an earlier opening must not close a new one.
    if (!dialog.open) close();
  };
  const bindings = [];
  try {
    for (const [target, type, listener] of [
      [back, 'click', close], [dialog, 'cancel', cancel], [dialog, 'close', nativeClosed],
      [left, 'click', turnLeft], [right, 'click', turnRight], [reset, 'click', resetView],
    ]) {
      const guarded = (...args) => { if (!disposed) return listener(...args); };
      bindings.push([target, type, guarded]);
      target.addEventListener(type, guarded);
    }
  } catch (error) {
    disposed = true;
    const failures = [error];
    for (const [target, type, listener] of bindings.splice(0).reverse())
      try { target.removeEventListener(type, listener); } catch (cleanup) { failures.push(cleanup); }
    if (failures.length > 1)
      throw new AggregateError(failures, 'Model preview registration and cleanup failed');
    throw error;
  }
  return Object.freeze({
    open,
    close,
    get isOpen() {
      return current !== null;
    },
    get busy() {
      return pending !== null || observers.size > 0;
    },
    dispose() {
      if (disposal) return disposal;
      disposed = true;
      disposal = Promise.resolve().then(async () => {
        close();
        cachedBytes = cachedTextureBytes = null;
        for (const [target, type, listener] of bindings.splice(0).reverse())
          cleanupStep(() => target.removeEventListener(type, listener));
        if (pending)
          try { await pending; } catch (error) { recordCleanup([describeFailure(error)]); }
        while (observers.size) await Promise.all([...observers]);
        if (cleanupFailures.length)
          throw new Error(`Model preview cleanup failed: ${cleanupFailures.join('; ')}`);
      });
      return disposal;
    },
  });
}
