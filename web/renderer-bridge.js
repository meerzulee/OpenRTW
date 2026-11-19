// Handwritten, publishable bridge. The caller supplies a separately verified
// Emscripten module/factory; this file never imports generated or local assets.
export const RendererStatus = Object.freeze({
  OK: 0,
  ARGUMENT: 1,
  RESOURCE: 2,
  UNSUPPORTED: 3,
  BACKEND: 4,
  GL: 5,
  NOT_INITIALIZED: 6,
  OUT_OF_MEMORY: 7,
});
export const BufferKind = Object.freeze({ VERTEX: 0, INDEX16: 1, INDEX32: 2 });
export const TextureFormat = Object.freeze({
  RGBA8: 0x80000001,
  A8R8G8B8: 21,
  X8R8G8B8: 22,
  R5G6B5: 23,
  A1R5G5B5: 25,
  A4R4G4B4: 26,
  A8: 28,
  L8: 50,
  A8L8: 51,
  DXT1: 0x31545844,
  DXT3: 0x33545844,
  DXT5: 0x35545844,
});
export const Primitive = Object.freeze({ TRIANGLELIST: 4, TRIANGLESTRIP: 5, TRIANGLEFAN: 6 });
// SPECULAR describes the packed attribute; specular shading remains unsupported.
export const Fvf = Object.freeze({
  XYZ: 0x002,
  XYZRHW: 0x004,
  DIFFUSE: 0x040,
  SPECULAR: 0x080,
  TEX1: 0x100,
  TEX2: 0x200,
});
export const Transform = Object.freeze({ WORLD: 0, VIEW: 1, PROJECTION: 2 });
export const RenderState = Object.freeze({
  ZENABLE: 7,
  FILLMODE: 8,
  SHADEMODE: 9,
  ZWRITEENABLE: 14,
  ALPHATESTENABLE: 15,
  SRCBLEND: 19,
  DESTBLEND: 20,
  CULLMODE: 22,
  ZFUNC: 23,
  ALPHAREF: 24,
  ALPHAFUNC: 25,
  DITHERENABLE: 26,
  ALPHABLENDENABLE: 27,
  FOGENABLE: 28,
  SPECULARENABLE: 29,
  STENCILENABLE: 52,
  STENCILFAIL: 53,
  STENCILZFAIL: 54,
  STENCILPASS: 55,
  STENCILFUNC: 56,
  STENCILREF: 57,
  STENCILMASK: 58,
  STENCILWRITEMASK: 59,
  TEXTUREFACTOR: 60,
  LIGHTING: 137,
  COLORWRITEENABLE: 168,
  BLENDOP: 171,
});
export const StencilOp = Object.freeze({
  KEEP: 1,
  ZERO: 2,
  REPLACE: 3,
  INCRSAT: 4,
  DECRSAT: 5,
  INVERT: 6,
  INCR: 7,
  DECR: 8,
});
export const StageState = Object.freeze({
  COLOROP: 1,
  COLORARG1: 2,
  COLORARG2: 3,
  ALPHAOP: 4,
  ALPHAARG1: 5,
  ALPHAARG2: 6,
  TEXCOORDINDEX: 11,
  ADDRESSU: 13,
  ADDRESSV: 14,
  BORDERCOLOR: 15,
  MAGFILTER: 16,
  MINFILTER: 17,
  MIPFILTER: 18,
  TEXTURETRANSFORMFLAGS: 24,
});
export const TextureOp = Object.freeze({
  DISABLE: 1,
  SELECTARG1: 2,
  SELECTARG2: 3,
  MODULATE: 4,
  MODULATE2X: 5,
  ADD: 7,
});
export const TextureArg = Object.freeze({
  DIFFUSE: 0,
  CURRENT: 1,
  TEXTURE: 2,
  TFACTOR: 3,
  COMPLEMENT: 0x10,
  ALPHAREPLICATE: 0x20,
});
export const Filter = Object.freeze({ NONE: 0, POINT: 1, LINEAR: 2 });
export const Address = Object.freeze({ WRAP: 1, MIRROR: 2, CLAMP: 3 });
export const Compare = Object.freeze({
  NEVER: 1,
  LESS: 2,
  EQUAL: 3,
  LESSEQUAL: 4,
  GREATER: 5,
  NOTEQUAL: 6,
  GREATEREQUAL: 7,
  ALWAYS: 8,
});
export const Blend = Object.freeze({
  ZERO: 1,
  ONE: 2,
  SRCCOLOR: 3,
  INVSRCCOLOR: 4,
  SRCALPHA: 5,
  INVSRCALPHA: 6,
  DESTALPHA: 7,
  INVDESTALPHA: 8,
  DESTCOLOR: 9,
  INVDESTCOLOR: 10,
  SRCALPHASAT: 11,
});
const unsigned = (value, label) => {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff)
    throw new TypeError(`${label} must be uint32`);
  return value;
};
const bytes = (value) => {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('Upload requires an ArrayBuffer or byte-addressable view');
};
let nextCanvas = 1;
// A native renderer module has one device/resource table. Clean disposal permits
// recreation, but an active or incompletely cleaned bridge must keep its claim.
const claimedRendererModules = new WeakSet();
export class RendererError extends Error {
  constructor(operation, status, message, glError = 0) {
    super(`${operation}: ${message}`);
    this.name = 'RendererError';
    this.operation = operation;
    this.status = status;
    this.glError = glError;
  }
}

export async function createRendererBridge({
  module: provided,
  moduleFactory,
  canvas,
  width = canvas?.width,
  height = canvas?.height,
} = {}) {
  if (!canvas || typeof canvas.getContext !== 'function')
    throw new TypeError('A renderer canvas is required');
  if (provided && moduleFactory)
    throw new TypeError('Supply a loaded renderer module or its factory');
  if (!provided && typeof moduleFactory !== 'function')
    throw new TypeError('A renderer module/factory is required');
  unsigned(width, 'width');
  unsigned(height, 'height');
  if (!canvas.isConnected || canvas.ownerDocument !== document)
    throw new TypeError('Renderer canvas must be attached to this document');
  if (!canvas.id) {
    let id;
    do {
      id = `rome-renderer-${nextCanvas++}`;
    } while (document.getElementById(id));
    canvas.id = id;
  }
  const selector = `#${CSS.escape(canvas.id)}`;
  if (
    document.querySelectorAll(selector).length !== 1 ||
    document.querySelector(selector) !== canvas
  )
    throw new TypeError('Renderer canvas ID must be unique');
  const module = provided ?? (await moduleFactory({ canvas }));
  if (module._rome_renderer_v1_abi_version?.() !== 1)
    throw new Error('Unsupported renderer C ABI version');
  if (claimedRendererModules.has(module))
    throw new Error('Renderer module is already owned by a bridge or failed cleanup');
  claimedRendererModules.add(module);
  const ownership = { dispose: null };
  try {
    return initializeRendererBridge(module, canvas, width, height, selector, ownership);
  } catch (error) {
    try {
      if (ownership.dispose) ownership.dispose();
      else claimedRendererModules.delete(module);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Renderer startup and cleanup failed', { cause: error });
    }
    throw error;
  }
}

function initializeRendererBridge(module, canvas, width, height, selector, ownership) {
  let alive = true,
    currentWidth = width,
    currentHeight = height,
    currentStream = [0, 0],
    currentIndices = [0, 0],
    drawScopeDepth = 0;
  let contextLost = false,
    contextRestored = false;
  let lifecycle = false;
  const lost = (event) => {
    if (!alive) return;
    contextLost = true;
    event.preventDefault();
  };
  const restored = () => {
    if (!alive) return;
    contextLost = false;
    contextRestored = true;
  };
  const targets = new Map();
  let nativeStarted = false, lostListener = false, restoredListener = false;
  const fail = (operation, status) =>
    new RendererError(
      operation,
      status,
      module.UTF8ToString(module._rome_renderer_v1_error()),
      module._rome_renderer_v1_gl_error() >>> 0
    );
  const checkAlive = () => {
    if (!alive)
      throw new RendererError(
        'renderer',
        RendererStatus.NOT_INITIALIZED,
        'Renderer has been disposed'
      );
    if (contextRestored)
      throw new RendererError(
        'renderer',
        RendererStatus.UNSUPPORTED,
        'Restored-context resource re-creation is not implemented'
      );
  };
  function call(name, ...args) {
    checkAlive();
    const fn = module[`_rome_renderer_v1_${name}`];
    if (typeof fn !== 'function') throw new Error(`Missing renderer ABI function: ${name}`);
    const status = fn(...args) >>> 0;
    if (status) throw fail(name, status);
  }
  function create(name, ...args) {
    checkAlive();
    const id = module[`_rome_renderer_v1_${name}`](...args) >>> 0;
    if (!id) throw fail(name, module._rome_renderer_v1_status() >>> 0);
    return id;
  }
  function stableInput(data) {
    const source = bytes(data);
    return source.buffer === module.HEAPU8.buffer ? source.slice() : source;
  }
  function memory(data, consume) {
    checkAlive();
    const source = stableInput(data);
    unsigned(source.byteLength, 'upload bytes');
    const pointer = module._malloc(Math.max(1, source.byteLength)) >>> 0;
    if (!pointer)
      throw new RendererError(
        'upload',
        RendererStatus.OUT_OF_MEMORY,
        'Renderer upload allocation failed'
      );
    return withCleanup(() => {
      module.HEAPU8.set(source, pointer);
      return consume(pointer, source.byteLength);
    }, [() => module._free(pointer)]);
  }
  function withCleanup(action, cleanup) {
    const errors = [];
    let result;
    try {
      result = action();
    } catch (error) {
      errors.push(error);
    }
    for (const release of cleanup)
      try {
        release();
      } catch (error) {
        errors.push(error);
      }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, 'Renderer operation and cleanup failed');
    return result;
  }
  function disposeOwned() {
    if (!alive) return;
    // Close admission before any native or event-target hook can reenter.
    alive = false;
    targets.clear();
    const errors = [];
    if (nativeStarted) {
      try {
        const status = module._rome_renderer_v1_dispose() >>> 0;
        if (status) throw fail('dispose', status);
      } catch (error) { errors.push(error); }
    }
    for (const [attempted, name, listener] of [
      [lostListener, 'webglcontextlost', lost],
      [restoredListener, 'webglcontextrestored', restored],
    ]) {
      if (attempted) {
        try { canvas.removeEventListener(name, listener); }
        catch (error) { errors.push(error); }
      }
    }
    if (!errors.length) claimedRendererModules.delete(module);
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, 'Renderer cleanup failed');
  }
  ownership.dispose = disposeOwned;
  lifecycle = typeof module._rome_renderer_v1_device_state === 'function';
  memory(new TextEncoder().encode(selector + '\0'), (pointer) => {
    nativeStarted = true;
    call('init', pointer, width, height);
  });
  const capsPointer = module._rome_renderer_v1_capabilities() >>> 0;
  if (!capsPointer) throw fail('capabilities', module._rome_renderer_v1_status() >>> 0);
  const capabilities = JSON.parse(module.UTF8ToString(capsPointer));
  const api = {
    capabilities: () => {
      checkAlive();
      return structuredClone(capabilities);
    },
    createBuffer({ kind, bytes: size, dynamic = false }) {
      return create(
        'create_buffer',
        unsigned(kind, 'kind'),
        unsigned(size, 'bytes'),
        Number(Boolean(dynamic))
      );
    },
    uploadBuffer(id, data, { offset = 0, discard = false } = {}) {
      unsigned(id, 'id');
      unsigned(offset, 'offset');
      memory(data, (p, n) => call('update_buffer', id, offset, p, n, Number(Boolean(discard))));
    },
    destroyBuffer(id) {
      call('destroy_buffer', unsigned(id, 'id'));
      if (currentStream[0] === id) currentStream = [0, 0];
      if (currentIndices[0] === id) currentIndices = [0, 0];
    },
    createTexture({ width: w, height: h, levels = 0, format }) {
      return create(
        'create_texture',
        unsigned(w, 'width'),
        unsigned(h, 'height'),
        unsigned(levels, 'levels'),
        unsigned(format, 'format')
      );
    },
    uploadTexture(id, level, data, { rowPitch = 0 } = {}) {
      unsigned(id, 'id');
      unsigned(level, 'level');
      unsigned(rowPitch, 'rowPitch');
      memory(data, (p, n) => call('upload_texture', id, level, rowPitch, p, n));
    },
    destroyTexture(id) {
      call('destroy_texture', unsigned(id, 'id'));
    },
    createRenderTarget({
      width: w,
      height: h,
      format = TextureFormat.X8R8G8B8,
      multiSampleType = 0,
    }) {
      const id = create(
        'create_render_target',
        unsigned(w, 'width'),
        unsigned(h, 'height'),
        unsigned(format, 'format'),
        unsigned(multiSampleType, 'multiSampleType')
      );
      targets.set(id, { width: w, height: h });
      return id;
    },
    destroyRenderTarget(id) {
      call('destroy_render_target', unsigned(id, 'id'));
      targets.delete(id);
    },
    setRenderTarget(id = 0, { depth = 'none', resetViewport = true } = {}) {
      if (depth !== 'none' && depth !== 'primary')
        throw new TypeError('Render target depth must be none or primary');
      if (typeof resetViewport !== 'boolean') throw new TypeError('resetViewport must be boolean');
      call(
        'set_render_target',
        unsigned(id, 'id'),
        Number(depth === 'primary'),
        Number(resetViewport)
      );
    },
    readTarget(id = 0) {
      checkAlive();
      unsigned(id, 'id');
      const target = id ? targets.get(id) : { width: currentWidth, height: currentHeight };
      if (!target)
        throw new RendererError('readTarget', RendererStatus.RESOURCE, 'Unknown render target ID');
      const size = unsigned(target.width * target.height * 4, 'readback bytes'),
        pointer = module._malloc(size) >>> 0;
      if (!pointer)
        throw new RendererError(
          'readTarget',
          RendererStatus.OUT_OF_MEMORY,
          'Readback allocation failed'
        );
      return withCleanup(() => {
        call('read_target', id, pointer, size);
        return {
          ...target,
          origin: 'top-left',
          rgba: module.HEAPU8.slice(pointer, pointer + size),
        };
      }, [() => module._free(pointer)]);
    },
    uploadTarget(
      id,
      data,
      { x = 0, y = 0, width: w, height: h, rowPitch = 0, format = TextureFormat.X8R8G8B8 } = {}
    ) {
      checkAlive();
      unsigned(id, 'id');
      const target = id ? targets.get(id) : { width: currentWidth, height: currentHeight };
      if (!target)
        throw new RendererError(
          'uploadTarget',
          RendererStatus.RESOURCE,
          'Unknown render target ID'
        );
      w ??= target.width;
      h ??= target.height;
      for (const [name, value] of Object.entries({ x, y, width: w, height: h, rowPitch, format }))
        unsigned(value, name);
      memory(data, (p, n) => call('upload_target', id, x, y, w, h, rowPitch, format, p, n));
    },
    setTexture(stage, id = 0) {
      call('set_texture', unsigned(stage, 'stage'), unsigned(id, 'id'));
    },
    setFvf(fvf) {
      call('set_fvf', unsigned(fvf, 'fvf'));
    },
    setStream(id, vertexStride) {
      call('set_stream', unsigned(id, 'id'), unsigned(vertexStride, 'stride'));
      currentStream = [id, vertexStride];
    },
    setIndices(id, base = 0) {
      call('set_indices', unsigned(id, 'id'), unsigned(base, 'baseVertex'));
      currentIndices = [id, base];
    },
    setRenderState(state, value) {
      call('set_render_state', unsigned(state, 'state'), unsigned(value, 'value'));
    },
    setStageState(stage, state, value) {
      call(
        'set_stage_state',
        unsigned(stage, 'stage'),
        unsigned(state, 'state'),
        unsigned(value, 'value')
      );
    },
    setTransform(kind, matrix) {
      unsigned(kind, 'transform');
      if (!matrix || matrix.length !== 16)
        throw new TypeError('A transform contains sixteen row-major floats');
      const values = new Float32Array(matrix);
      memory(values, (p) => call('set_transform', kind, p));
    },
    setViewport({ x = 0, y = 0, width: w, height: h, minZ = 0, maxZ = 1 }) {
      for (const [n, v] of Object.entries({ x, y, width: w, height: h })) unsigned(v, n);
      if (!Number.isFinite(minZ) || !Number.isFinite(maxZ))
        throw new TypeError('Viewport depth must be finite');
      call('set_viewport', x, y, w, h, minZ, maxZ);
    },
    resize(w, h) {
      call('resize', unsigned(w, 'width'), unsigned(h, 'height'));
      currentWidth = w;
      currentHeight = h;
    },
    clear({ color = 0xff000000, depth = 1, stencil = 0, flags = 1 } = {}) {
      if (!Number.isFinite(depth)) throw new TypeError('Clear depth must be finite');
      call(
        'clear',
        unsigned(flags, 'flags'),
        unsigned(color, 'color'),
        depth,
        unsigned(stencil, 'stencil')
      );
    },
    draw({ primitive, primitiveCount, startVertex = 0 }) {
      call(
        'draw',
        unsigned(primitive, 'primitive'),
        unsigned(startVertex, 'startVertex'),
        unsigned(primitiveCount, 'primitiveCount')
      );
    },
    drawIndexed({ primitive, primitiveCount, startIndex = 0 }) {
      call(
        'draw_indexed',
        unsigned(primitive, 'primitive'),
        unsigned(startIndex, 'startIndex'),
        unsigned(primitiveCount, 'primitiveCount')
      );
    },
    // Immediate helpers are renderer operations, not guest D3D8 COM methods.
    // The guest service separately applies D3D8's post-UP binding semantics.
    drawUP({ vertices, vertexStride, primitive, primitiveCount }) {
      checkAlive();
      const saved = [...currentStream],
        data = stableInput(vertices),
        vb = api.createBuffer({ kind: BufferKind.VERTEX, bytes: data.byteLength, dynamic: true });
      return withCleanup(() => {
        api.uploadBuffer(vb, data, { discard: true });
        api.setStream(vb, vertexStride);
        api.draw({ primitive, primitiveCount });
      }, [() => api.setStream(...saved), () => api.destroyBuffer(vb)]);
    },
    drawIndexedUP({
      vertices,
      vertexStride,
      indexData,
      index32 = false,
      primitive,
      primitiveCount,
      startIndex = 0,
      baseVertex = 0,
    }) {
      checkAlive();
      const oldStream = [...currentStream],
        oldIndices = [...currentIndices],
        vertexBytes = stableInput(vertices),
        indexBytes = stableInput(indexData);
      const vb = api.createBuffer({
        kind: BufferKind.VERTEX,
        bytes: vertexBytes.byteLength,
        dynamic: true,
      });
      let ib = 0;
      return withCleanup(() => {
        ib = api.createBuffer({
          kind: index32 ? BufferKind.INDEX32 : BufferKind.INDEX16,
          bytes: indexBytes.byteLength,
          dynamic: true,
        });
        api.uploadBuffer(vb, vertexBytes, { discard: true });
        api.uploadBuffer(ib, indexBytes, { discard: true });
        api.setStream(vb, vertexStride);
        api.setIndices(ib, baseVertex);
        api.drawIndexed({ primitive, primitiveCount, startIndex });
      }, [
        () => api.setStream(...oldStream),
        () => api.setIndices(...oldIndices),
        () => {
          if (ib) api.destroyBuffer(ib);
        },
        () => api.destroyBuffer(vb),
      ]);
    },
    present() {
      call('present');
    },
    readPixels() {
      checkAlive();
      const size = unsigned(currentWidth * currentHeight * 4, 'readback bytes'),
        pointer = module._malloc(size) >>> 0;
      if (!pointer)
        throw new RendererError(
          'readPixels',
          RendererStatus.OUT_OF_MEMORY,
          'Readback allocation failed'
        );
      return withCleanup(() => {
        call('read_pixels', pointer, size);
        return {
          width: currentWidth,
          height: currentHeight,
          origin: 'top-left',
          rgba: module.HEAPU8.slice(pointer, pointer + size),
        };
      }, [() => module._free(pointer)]);
    },
    dispose() {
      if (drawScopeDepth) throw new TypeError('Cannot dispose inside a draw-state scope');
      disposeOwned();
    },
  };
  // Optional exports keep this handwritten bridge compatible with older,
  // immutable artifacts. A scope restores logical draw state and bindings;
  // pixel/resource contents intentionally retain all draws and clears.
  if (
    typeof module._rome_renderer_v1_push_draw_state === 'function' &&
    typeof module._rome_renderer_v1_pop_draw_state === 'function'
  ) {
    api.withDrawState = (operation) => {
      if (typeof operation !== 'function' || operation.constructor?.name === 'AsyncFunction')
        throw new TypeError('Draw-state scope requires a synchronous function');
      const savedStream = [...currentStream],
        savedIndices = [...currentIndices],
        errors = [];
      call('push_draw_state');
      drawScopeDepth++;
      let result;
      try {
        result = operation();
        if (result && typeof result.then === 'function')
          throw new TypeError('Draw-state scope must not return a promise');
      } catch (error) {
        errors.push(error);
      } finally {
        try {
          call('pop_draw_state');
          currentStream = savedStream;
          currentIndices = savedIndices;
        } catch (error) {
          errors.push(error);
        }
        drawScopeDepth--;
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length) throw new AggregateError(errors, 'Draw-state scope failed');
      return result;
    };
  }
  if (typeof module._rome_renderer_v1_set_material_lighting === 'function') {
    api.setMaterialLighting = ({ enabled = false, material = [], ambient = 0 } = {}) => {
      if (typeof enabled !== 'boolean')
        throw new TypeError('Material lighting selector must be boolean');
      if (!enabled) {
        call('set_material_lighting', 0, 0, 0);
        return;
      }
      if (
        (!Array.isArray(material) && !(material instanceof Uint32Array)) ||
        material.length !== 17
      )
        throw new TypeError('Material contains seventeen raw DWORDs');
      const values = Uint32Array.from(material, (value) => unsigned(value, 'material DWORD'));
      memory(values, (p) =>
        call('set_material_lighting', 1, p, unsigned(ambient, 'ambient color'))
      );
    };
  }
  if (typeof module._rome_renderer_v1_set_directional_lighting === 'function') {
    api.setDirectionalLighting = ({
      enabled = false,
      material = [],
      light = [],
      ambient = 0,
      normalizeNormals = false,
      diffuseFromVertex = false,
      ambientFromVertex = false,
    } = {}) => {
      if (
        [enabled, normalizeNormals, diffuseFromVertex, ambientFromVertex].some(
          (value) => typeof value !== 'boolean'
        )
      )
        throw new TypeError('Directional lighting selectors must be boolean');
      if (!enabled) {
        call('set_directional_lighting', 0, 0, 0, 0, 0);
        return;
      }
      const vertexSources = diffuseFromVertex || ambientFromVertex;
      if (
        vertexSources &&
        typeof module._rome_renderer_v1_set_directional_vertex_lighting !== 'function'
      )
        throw new RendererError(
          'setDirectionalLighting',
          RendererStatus.UNSUPPORTED,
          'Directional vertex color sources are not implemented'
        );
      if (
        (!Array.isArray(material) && !(material instanceof Uint32Array)) ||
        material.length !== 17
      )
        throw new TypeError('Directional material contains seventeen raw DWORDs');
      if (
        (!Array.isArray(light) && !(light instanceof Uint32Array)) ||
        ![0, 26].includes(light.length)
      )
        throw new TypeError('Directional light contains zero or twenty-six raw DWORDs');
      const words = Uint32Array.from(material, (value) => unsigned(value, 'material DWORD'));
      const lightWords = Uint32Array.from(light, (value) => unsigned(value, 'light DWORD'));
      const select = (p, q) =>
        vertexSources
          ? call(
              'set_directional_vertex_lighting',
              1,
              p,
              q,
              unsigned(ambient, 'ambient color'),
              Number(normalizeNormals),
              Number(diffuseFromVertex),
              Number(ambientFromVertex)
            )
          : call(
              'set_directional_lighting',
              1,
              p,
              q,
              unsigned(ambient, 'ambient color'),
              Number(normalizeNormals)
            );
      memory(words, (p) => {
        if (lightWords.length) memory(lightWords, (q) => select(p, q));
        else select(p, 0);
      });
    };
  }
  if (typeof module._rome_renderer_v1_set_texture_alpha_lod0 === 'function') {
    api.setTextureAlphaLod0 = (stage, enabled) => {
      if (typeof enabled !== 'boolean') throw new TypeError('Base-alpha policy must be boolean');
      call('set_texture_alpha_lod0', unsigned(stage, 'stage'), Number(enabled));
    };
  }
  if (typeof module._rome_renderer_v1_set_texture_color_lod_bias === 'function') {
    api.setTextureColorLodBias = (stage, bias) => {
      if (typeof bias !== 'number' || !Number.isFinite(bias) || bias < -4 || bias > 4)
        throw new RangeError('Color LOD bias must be a finite number in [-4,4]');
      call('set_texture_color_lod_bias', unsigned(stage, 'stage'), bias);
    };
  }
  if (typeof module._rome_renderer_v1_create_vertex_program === 'function') {
    Object.assign(api, {
      createVertexProgram({ vertexSource, attributes, constantCount = 256 }) {
        if (typeof vertexSource !== 'string' || !vertexSource.length || vertexSource.includes('\0'))
          throw new TypeError('Vertex source must be a nonempty ES3 string');
        if (!Array.isArray(attributes) || attributes.length > 16)
          throw new TypeError('Vertex declaration permits up to16 active attributes');
        const types = { FLOAT1: 0, FLOAT2: 1, FLOAT3: 2, FLOAT4: 3, D3DCOLOR: 4 },
          seen = new Set();
        const declaration = new Uint32Array(attributes.length * 4);
        attributes.forEach((a, i) => {
          const register = unsigned(a.registerIndex, 'vertex register'),
            offset = unsigned(a.offsetBytes, 'vertex offset');
          const type = typeof a.type === 'string' ? types[a.type] : a.type;
          if (
            register >= 16 ||
            offset > 255 ||
            !Number.isInteger(type) ||
            type < 0 ||
            type > 4 ||
            seen.has(register) ||
            (a.location !== undefined && a.location !== register)
          )
            throw new TypeError('Invalid vertex declaration attribute');
          seen.add(register);
          declaration.set([register, offset, type, 0], i * 4);
        });
        unsigned(constantCount, 'constantCount');
        return memory(new TextEncoder().encode(vertexSource + '\0'), (source, sourceBytes) =>
          memory(declaration, (p) =>
            create(
              'create_vertex_program',
              source,
              sourceBytes,
              p,
              attributes.length,
              constantCount
            )
          )
        );
      },
      destroyVertexProgram(id) {
        call('destroy_vertex_program', unsigned(id, 'id'));
      },
      setVertexProgram(id = 0) {
        call('set_vertex_program', unsigned(id, 'id'));
      },
      setVertexConstants(start, values) {
        unsigned(start, 'constant register');
        const data = stableInput(values);
        if (data.byteLength % 16)
          throw new TypeError('Vertex constants contain complete float4 registers');
        memory(data, (p, n) => call('set_vertex_constants', start, p, n / 16));
      },
    });
  }
  if (lifecycle) {
    lostListener = true;
    canvas.addEventListener('webglcontextlost', lost);
    restoredListener = true;
    canvas.addEventListener('webglcontextrestored', restored);
    Object.assign(api, {
      testCooperativeLevel() {
        if (!alive || contextLost) return 0x88760868;
        if (contextRestored) return 0x88760869;
        const state = module._rome_renderer_v1_device_state() >>> 0;
        if (state === 0) return 0;
        if (state === 1 || state === 2) return 0x88760868;
        throw new RendererError(
          'testCooperativeLevel',
          RendererStatus.UNSUPPORTED,
          'Unknown device state'
        );
      },
      readFrontBuffer() {
        checkAlive();
        const w = module._rome_renderer_v1_presented_width() >>> 0,
          h = module._rome_renderer_v1_presented_height() >>> 0;
        if (!w || !h)
          throw new RendererError(
            'readFrontBuffer',
            RendererStatus.UNSUPPORTED,
            'No frame has been presented'
          );
        const size = unsigned(w * h * 4, 'front-buffer bytes'),
          pointer = module._malloc(size) >>> 0;
        if (!pointer)
          throw new RendererError(
            'readFrontBuffer',
            RendererStatus.OUT_OF_MEMORY,
            'Front-buffer allocation failed'
          );
        try {
          call('read_presented', pointer, size);
          return {
            width: w,
            height: h,
            origin: 'top-left',
            rgba: module.HEAPU8.slice(pointer, pointer + size),
          };
        } finally {
          module._free(pointer);
        }
      },
      reset({ width: w, height: h }) {
        call('reset', unsigned(w, 'width'), unsigned(h, 'height'));
        currentWidth = w;
        currentHeight = h;
        currentStream = [0, 0];
        currentIndices = [0, 0];
      },
    });
  }
  return Object.freeze(api);
}
