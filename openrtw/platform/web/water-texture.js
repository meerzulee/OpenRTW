import {
  TextureFormat,
  RenderState,
  StageState,
  TextureOp,
  TextureArg,
  Address,
  Filter,
  Blend,
  BufferKind,
  Primitive,
} from '/reference/renderer-bridge.js';

export const waterTextureSha256 =
  '6874aa94fcfebec4121c60e0b9ce12a75213a847d0aa0a6ef4ca72c4aa29d3ac';
export const campaignSurfTextureSha256 =
  'be9a179b47a51630188d58f1382510a5f8ec1e10359fc2a6c0bc193bc9396710';
export const waterTexturePolicy = Object.freeze({
  id: 'openrtw-original-water-display-v3',
  seaY: 0,
  uv: 'independent-rotated-warped-world-space-detail-layers',
  color: 'opaque-depth-base;two-faint-original-texture-layers',
  detailOpacityBytes: Object.freeze([48, 32]),
  address: 'wrap',
  min: 'linear',
  mag: 'linear',
  mip: 'linear',
  alpha: 'opaque-no-blend-or-test',
  binding: 'filename-candidate-not-native-water-material-proof',
  nativeMaterialEquivalent: false,
});
// Source identity/format are observed in the retained sea/coast records.
// Its use here, animation, opacity and placement are browser quality policy.
export const campaignSurfTexturePolicy = Object.freeze({
  id: 'openrtw-original-campaign-surf-display-v1',
  path: 'data/terrain/aerial_map/sea/surf2b.tga.dds',
  binding: 'retained-9C2D54/9C2F0C-source;browser-wash-not-native-animation',
  sourceSha256: campaignSurfTextureSha256,
  alpha: 'source-alpha-times-source-beach-suppression-times-subtle-browser-wash',
  nativeMaterialEquivalent: false,
});
const sourceSize = 11064,
  uint = (v) => Number.isInteger(v) && v >= 0 && v <= 0xffffffff;
const digest = async (bytes) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (v) =>
    v.toString(16).padStart(2, '0')
  ).join('');
const checkOpen = (isOpen) => {
  if (!isOpen()) throw new DOMException('Water texture loading cancelled', 'AbortError');
};
const keys = (value, names) =>
  value !== null &&
  typeof value === 'object' &&
  Object.keys(value).sort().join(',') === names.slice().sort().join(',');
const range = (value, start, end) =>
  keys(value, ['start', 'endExclusive']) && value.start === start && value.endExclusive === end;
function copyText(core, pointer, limit) {
  const heap = core.HEAPU8;
  if (!uint(pointer) || !pointer || pointer >= heap.length)
    throw new Error('Water DDS text pointer is invalid');
  const bytes = heap.slice(pointer, Math.min(heap.length, pointer + limit + 1)),
    end = bytes.indexOf(0);
  if (end < 0 || end > limit) throw new Error('Water DDS text exceeds its bound');
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end));
}
const waterSpec = Object.freeze({ label: 'Water', size: sourceSize, width: 128, height: 128,
  levels: 8, blockBytes: 8, format: 'DXT1', fourcc: 0x31545844, pitch: 8192,
  sha256: waterTextureSha256, textureFormat: TextureFormat.DXT1 });
const surfSpec = Object.freeze({ label: 'Surf', size: 43856, width: 256, height: 128,
  levels: 9, blockBytes: 16, format: 'DXT5', fourcc: 0x35545844, pitch: 32768,
  sha256: campaignSurfTextureSha256, textureFormat: TextureFormat.DXT5 });
function validate(metadata, bytes, spec) {
  const words = [
      0x20534444,
      124,
      0xa1007,
      spec.height,
      spec.width,
      spec.pitch,
      0,
      spec.levels,
      ...Array(11).fill(0),
      32,
      4,
      spec.fourcc,
      ...Array(5).fill(0),
      0x401008,
      0,
      0,
      0,
      0,
    ],
    header = new DataView(bytes.buffer, bytes.byteOffset, 128);
  if (words.some((word, i) => header.getUint32(i * 4, true) !== word))
    throw new Error(spec.label + ' DDS header differs');
  if (
    !keys(metadata, [
      'schema',
      'sourceBytes',
      'width',
      'height',
      'format',
      'blockBytes',
      'headerFlags',
      'pixelFormatFlags',
      'caps',
      'pitchOrLinearSize',
      'declaredMipMapCount',
      'headerRange',
      'payloadRange',
      'mips',
    ]) ||
    metadata.schema !== 'openrtw-dds-texture-v1' ||
    metadata.sourceBytes !== spec.size ||
    metadata.width !== spec.width ||
    metadata.height !== spec.height ||
    metadata.format !== spec.format ||
    metadata.blockBytes !== spec.blockBytes ||
    metadata.headerFlags !== 0xa1007 ||
    metadata.pixelFormatFlags !== 4 ||
    metadata.caps !== 0x401008 ||
    metadata.pitchOrLinearSize !== spec.pitch ||
    metadata.declaredMipMapCount !== spec.levels ||
    !range(metadata.headerRange, 0, 128) ||
    !range(metadata.payloadRange, 128, spec.size) ||
    !Array.isArray(metadata.mips) ||
    metadata.mips.length !== spec.levels
  )
    throw new Error('Core ' + spec.label.toLowerCase() + ' DDS envelope differs');
  let start = 128;
  for (const [level, mip] of metadata.mips.entries()) {
    const width = Math.max(1, spec.width >> level), height = Math.max(1, spec.height >> level),
      blocksX = Math.ceil(width / 4), blocksY = Math.ceil(height / 4),
      end = start + blocksX * blocksY * spec.blockBytes;
    if (
      !keys(mip, ['level', 'width', 'height', 'blocksX', 'blocksY', 'range']) ||
      mip.level !== level ||
      mip.width !== width ||
      mip.height !== height ||
      mip.blocksX !== blocksX ||
      mip.blocksY !== blocksY ||
      !range(mip.range, start, end) ||
      end > bytes.length
    )
      throw new Error('Core ' + spec.label.toLowerCase() + ' DDS mip differs');
    Object.freeze(mip.range);
    Object.freeze(mip);
    start = end;
  }
  if (start !== bytes.length) throw new Error(spec.label + ' DDS extent differs');
  Object.freeze(metadata.headerRange);
  Object.freeze(metadata.payloadRange);
  Object.freeze(metadata.mips);
  return Object.freeze(metadata);
}

// Strict standalone descriptor: no Hastati/general substitution or legacy retry.
// Source, published bytes and bounded JSON are copied before another await.
export async function loadWaterTexture(core, input, { isOpen = () => true, surfInput = null } = {}) {
  if (typeof isOpen !== 'function') throw new TypeError('Water isOpen must be a function');
  checkOpen(isOpen);
  if (!(input instanceof Uint8Array) || !(input.buffer instanceof ArrayBuffer) || input.length !== sourceSize)
    throw new Error('Unexpected water DDS source length');
  const source = new Uint8Array(input);
  if (surfInput !== null && (!(surfInput instanceof Uint8Array) ||
    !(surfInput.buffer instanceof ArrayBuffer) || surfInput.length !== surfSpec.size))
    throw new Error('Unexpected surf DDS source length');
  // Snapshot BOTH inputs before the first await or the next DDS publication.
  const surfSource = surfInput === null ? null : new Uint8Array(surfInput);
  const water = await loadPinnedDds(core, source, waterSpec, isOpen),
    surf = surfSource === null ? null : await loadPinnedDds(core, surfSource, surfSpec, isOpen);
  checkOpen(isOpen);
  return Object.freeze({
    metadata: water.metadata,
    sourceSha256: waterTextureSha256,
    presentationPolicy: waterTexturePolicy,
    surf: surf === null ? null : Object.freeze({ metadata: surf.metadata,
      sourceSha256: campaignSurfTextureSha256, presentationPolicy: campaignSurfTexturePolicy }),
    create(renderer) { return createWaterOwner(renderer, water, surf, isOpen); },
  });
}

async function loadPinnedDds(core, source, spec, isOpen) {
  if ((await digest(source)) !== spec.sha256)
    throw new Error(spec.label + ' DDS differs from the retained candidate');
  checkOpen(isOpen);
  const pointer = core._malloc(source.length);
  if (!uint(pointer) || !pointer) throw new Error(spec.label + ' DDS input allocation failed');
  try {
    if (pointer > core.HEAPU8.length - source.length)
      throw new Error('Water DDS input span is invalid');
    core.HEAPU8.set(source, pointer);
    if (core._openrtw_load_dds_texture(pointer, source.length) !== 1)
      throw new Error(copyText(core, core._openrtw_error(), 1024));
  } finally {
    core._free(pointer);
  }
  checkOpen(isOpen);
  const sourcePointer = core._openrtw_dds_texture_source_bytes(),
    length = core._openrtw_dds_texture_source_size(),
    heap = core.HEAPU8;
  if (
    !uint(sourcePointer) ||
    !sourcePointer ||
    length !== spec.size ||
    sourcePointer > heap.length - length
  )
    throw new Error('Core water DDS source span is invalid');
  const owned = heap.slice(sourcePointer, sourcePointer + length);
  if (!owned.every((value, i) => value === source[i]))
    throw new Error('Core water DDS source bytes differ');
  const metadata = validate(
    JSON.parse(copyText(core, core._openrtw_dds_texture_json(), 8192)),
    owned, spec
  );
  if ((await digest(owned)) !== spec.sha256)
    throw new Error('Published ' + spec.label.toLowerCase() + ' DDS hash differs');
  checkOpen(isOpen);
  return { metadata, owned, spec };
}

// drawSurface is optional scene integration; legacy bind() remains available.
// One bounded cache per owner, one shared index buffer per sea strip, no timers,
// renderer ownership, extra sampler stage, per-frame vertex-array allocation
// or readback.
function createWaterOwner(renderer, water, surf, isOpen) {
  checkOpen(isOpen);
  let id = 0, surfId = 0, closed = false, surface = null;
  const buffers = new Set();
  const alive = () => {
    if (closed || !id) throw new Error('Water texture is disposed');
    checkOpen(isOpen);
  };
  function sampling(texture) {
    renderer.setTexture(0, texture);
    renderer.setStageState(0, StageState.TEXCOORDINDEX, 0);
    renderer.setStageState(0, StageState.TEXTURETRANSFORMFLAGS, 0);
    for (const state of [StageState.ADDRESSU, StageState.ADDRESSV])
      renderer.setStageState(0, state, Address.WRAP);
    for (const state of [StageState.MINFILTER, StageState.MAGFILTER, StageState.MIPFILTER])
      renderer.setStageState(0, state, Filter.LINEAR);
  }
  function material(texture, alphaArg = TextureArg.TFACTOR) {
    sampling(texture);
    renderer.setStageState(0, StageState.COLOROP, TextureOp.MODULATE);
    renderer.setStageState(0, StageState.COLORARG1, TextureArg.TEXTURE);
    renderer.setStageState(0, StageState.COLORARG2, TextureArg.DIFFUSE);
    renderer.setStageState(0, StageState.ALPHAOP, TextureOp.SELECTARG1);
    renderer.setStageState(0, StageState.ALPHAARG1, alphaArg);
  }
  function releaseBuffers() {
    const errors = [];
    for (const buffer of buffers) {
      buffers.delete(buffer);
      try { renderer.destroyBuffer(buffer); } catch (error) { errors.push(error); }
    }
    surface = null;
    return errors;
  }
  function buffer(kind, bytes, dynamic = false) {
    const handle = renderer.createBuffer({ kind, bytes: bytes.length, dynamic });
    if (!uint(handle) || !handle) throw new Error('Invalid campaign water buffer handle');
    buffers.add(handle);
    checkOpen(isOpen);
    renderer.uploadBuffer(handle, bytes, { discard: dynamic });
    checkOpen(isOpen);
    return handle;
  }
  function makeSurface(geometry, coastGeometry, groundBytes, groundStride) {
    if (!geometry || typeof geometry.update !== 'function' ||
      geometry.metadata?.schema !== 'openrtw-campaign-water-geometry-v2' ||
      !Array.isArray(geometry.strips) || geometry.strips.length > 128 ||
      ![24, 32].includes(groundStride) || typeof groundBytes !== 'function')
      throw new TypeError('Invalid campaign water surface integration');
    const surfGeometry = surfId && coastGeometry ? geometry.createSurf(coastGeometry) : null;
    let vertexCount = 0, gpuBytes = 0;
    // Check complete budgets before allocating any GPU storage. Index bytes
    // are immutable copied owner data; the geometry constructor validates U16.
    for (const [strips, detail] of [[geometry.strips, true], [surfGeometry?.strips ?? [], false]])
      for (const strip of strips) {
        if (!(strip.vertices instanceof Uint8Array) || !(strip.indexBytes instanceof Uint8Array) ||
          !Number.isInteger(strip.vertexCount) || strip.vertexCount < 1 || strip.vertexCount > 65536 ||
          strip.vertices.length !== strip.vertexCount * 24 ||
          !Number.isInteger(strip.triangleCount) || strip.triangleCount < 1 ||
          strip.indexBytes.length !== strip.triangleCount * 6 ||
          (detail && (!(strip.detailVertices instanceof Uint8Array) ||
            strip.detailVertices.length !== strip.vertices.length)))
          throw new TypeError('Invalid campaign water upload strip');
        vertexCount += strip.vertexCount;
        gpuBytes += strip.vertexCount * groundStride * (detail ? 2 : 1) + strip.indexBytes.length;
      }
    if (vertexCount > 262144 || gpuBytes > 24 * 1024 * 1024)
      throw new RangeError('Campaign water GPU buffer budget exceeded');
    function batch(strip, detail) {
      const index = buffer(BufferKind.INDEX16, strip.indexBytes);
      function vertex(bytes) {
        const transformed = groundBytes(bytes);
        if (!(transformed instanceof Uint8Array) || !(transformed.buffer instanceof ArrayBuffer) ||
          transformed.length !== strip.vertexCount * groundStride)
          throw new TypeError('Invalid campaign water ground vertex transform');
        // Keep fog UVs and storage stable. Future updates copy only XYZ,
        // diffuse and detail UV; the appended world-space fog UVs never move.
        const upload = groundStride === 24 ? bytes : transformed.slice();
        return { source: bytes, upload, words: new Uint32Array(upload.buffer, upload.byteOffset, upload.length / 4),
          sourceWords: new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4),
          vb: buffer(BufferKind.VERTEX, upload, true) };
      }
      return { ib: index, triangles: strip.triangleCount,
        base: vertex(strip.vertices), detail: detail ? vertex(strip.detailVertices) : null };
    }
    try {
      const seaBatches = geometry.strips.map((s) => batch(s, true)),
        surfBatches = (surfGeometry?.strips ?? []).map((s) => batch(s, false));
      return { geometry, coastGeometry, groundBytes, groundStride, surfGeometry, seaBatches, surfBatches,
        frame: geometry.frame, surfFrame: surfGeometry?.frame ?? -1,
        gpuBytes, vertexCount, uploads: seaBatches.length * 2 + surfBatches.length,
        uploadBytes: [...seaBatches.flatMap((b) => [b.base, b.detail]), ...surfBatches.map((b) => b.base)]
          .reduce((sum, b) => sum + b.upload.length, 0), draws: 0 };
    } catch (error) {
      const failures = releaseBuffers();
      if (failures.length) throw new AggregateError([error, ...failures], 'Water surface construction cleanup failed');
      throw error;
    }
  }
  function refresh(entry, stride) {
    if (stride === 32) {
      const source = entry.sourceWords, target = entry.words;
      for (let i = 0, at = 0; i < source.length; i += 6, at += 8)
        for (let k = 0; k < 6; k++) target[at + k] = source[i + k];
    }
    renderer.uploadBuffer(entry.vb, entry.upload, { discard: true });
    checkOpen(isOpen);
    surface.uploads++;
    surface.uploadBytes += entry.upload.length;
  }
  function resetDrawState() {
    // Do not touch stage1: the scene's drawGroundIndexed owns fog. Independent
    // alpha is changed only for optional surf and reset even after draw errors.
    const actions = [
      () => renderer.setTextureAlphaLod0?.(0, false),
      () => renderer.setTexture(0, 0),
      () => renderer.setRenderState(RenderState.TEXTUREFACTOR, 0xffffffff),
      () => renderer.setRenderState(RenderState.ALPHABLENDENABLE, 0),
      () => renderer.setRenderState(RenderState.ALPHATESTENABLE, 0),
      () => renderer.setRenderState(RenderState.ZWRITEENABLE, 1),
      () => renderer.setStageState(0, StageState.COLOROP, TextureOp.SELECTARG1),
      () => renderer.setStageState(0, StageState.COLORARG1, TextureArg.DIFFUSE),
      () => renderer.setStageState(0, StageState.ALPHAOP, TextureOp.SELECTARG1),
      () => renderer.setStageState(0, StageState.ALPHAARG1, TextureArg.DIFFUSE),
    ], errors = [];
    for (const action of actions) try { action(); } catch (error) { errors.push(error); }
    return errors;
  }
  const owner = Object.freeze({
    bind() {
      alive();
      material(id, TextureArg.TEXTURE);
      renderer.setStageState(1, StageState.COLOROP, TextureOp.DISABLE);
      renderer.setRenderState(RenderState.ALPHATESTENABLE, 0);
      renderer.setRenderState(RenderState.ALPHABLENDENABLE, 0);
    },
    drawSurface({ geometry, timeSeconds = 0, groundBytes = (bytes) => bytes,
      groundStride = 24, drawGroundIndexed, depthWrite = true, coastGeometry = null } = {}) {
      alive();
      if (typeof drawGroundIndexed !== 'function' || typeof depthWrite !== 'boolean')
        throw new TypeError('Invalid campaign water draw callback or depth policy');
      // Validate time before creating GPU storage or mutating renderer state.
      if (!Number.isFinite(timeSeconds) || timeSeconds < 0 || timeSeconds > 1e9)
        throw new RangeError('Invalid campaign water elapsed seconds');
      if (surface && (surface.geometry !== geometry || surface.coastGeometry !== coastGeometry ||
        surface.groundStride !== groundStride))
        throw new Error('Campaign water surface integration changed');
      geometry?.update(timeSeconds);
      if (!surface) surface = makeSurface(geometry, coastGeometry, groundBytes, groundStride);
      const current = surface;
      if (current.frame !== geometry.frame) {
        for (const batch of current.seaBatches) {
          refresh(batch.base, groundStride);
          refresh(batch.detail, groundStride);
        }
        current.frame = geometry.frame;
      }
      current.surfGeometry?.update(timeSeconds);
      if (current.surfGeometry && current.surfFrame !== current.surfGeometry.frame) {
        for (const batch of current.surfBatches) refresh(batch.base, groundStride);
        current.surfFrame = current.surfGeometry.frame;
      }
      function draw(batches, layer) {
        for (const batch of batches) {
          alive();
          renderer.setStream(batch[layer].vb, groundStride);
          renderer.setIndices(batch.ib, 0);
          drawGroundIndexed({ primitive: Primitive.TRIANGLELIST, primitiveCount: batch.triangles });
          current.draws++;
        }
      }
      let failure = null;
      try {
        renderer.setTextureAlphaLod0?.(0, false);
        renderer.setRenderState(RenderState.ZENABLE, 1);
        renderer.setRenderState(RenderState.ZFUNC, 4);
        renderer.setRenderState(RenderState.ZWRITEENABLE, Number(depthWrite));
        renderer.setRenderState(RenderState.CULLMODE, 1);
        renderer.setRenderState(RenderState.ALPHATESTENABLE, 0);
        renderer.setRenderState(RenderState.ALPHABLENDENABLE, 0);
        renderer.setTexture(0, 0);
        for (const [op, arg] of [[StageState.COLOROP, StageState.COLORARG1],
          [StageState.ALPHAOP, StageState.ALPHAARG1]]) {
          renderer.setStageState(0, op, TextureOp.SELECTARG1);
          renderer.setStageState(0, arg, TextureArg.DIFFUSE);
        }
        draw(current.seaBatches, 'base');
        material(id);
        renderer.setRenderState(RenderState.SRCBLEND, Blend.SRCALPHA);
        renderer.setRenderState(RenderState.DESTBLEND, Blend.INVSRCALPHA);
        renderer.setRenderState(RenderState.ALPHABLENDENABLE, 1);
        renderer.setRenderState(RenderState.ZWRITEENABLE, 0);
        renderer.setRenderState(RenderState.TEXTUREFACTOR, 0x30000000);
        draw(current.seaBatches, 'base');
        renderer.setRenderState(RenderState.TEXTUREFACTOR, 0x20000000);
        draw(current.seaBatches, 'detail');
        if (current.surfBatches.length) {
          material(surfId, TextureArg.TEXTURE);
          renderer.setStageState(0, StageState.ALPHAOP, TextureOp.MODULATE);
          renderer.setStageState(0, StageState.ALPHAARG2, TextureArg.DIFFUSE);
          renderer.setTextureAlphaLod0?.(0, true);
          draw(current.surfBatches, 'base');
        }
      } catch (error) { failure = error; }
      const failures = resetDrawState();
      if (failure || failures.length) {
        if (failure && !failures.length) throw failure;
        throw new AggregateError([...(failure ? [failure] : []), ...failures], 'Water surface draw cleanup failed');
      }
    },
    get surfaceStats() {
      return surface === null ? null : Object.freeze({ gpuBytes: surface.gpuBytes,
        vertexCount: surface.vertexCount, uploads: surface.uploads, uploadBytes: surface.uploadBytes,
        drawCalls: surface.draws, surf: surface.surfGeometry?.metadata ?? null });
    },
    dispose() {
      if (closed) return;
      closed = true;
      const failures = releaseBuffers(), old = id, oldSurf = surfId;
      id = surfId = 0;
      for (const texture of [oldSurf, old]) if (texture)
        try { renderer.destroyTexture(texture); } catch (error) { failures.push(error); }
      if (failures.length === 1) throw failures[0];
      if (failures.length) throw new AggregateError(failures, 'Water disposal failed');
    },
  });
  function texture(asset, setId) {
    const { spec, metadata, owned } = asset;
    const handle = renderer.createTexture({ width: spec.width, height: spec.height,
      levels: spec.levels, format: spec.textureFormat });
    if (!uint(handle) || !handle) throw new Error('Invalid ' + spec.label.toLowerCase() + ' texture handle');
    setId(handle);
    checkOpen(isOpen);
    for (const mip of metadata.mips) {
      renderer.uploadTexture(handle, mip.level, owned.subarray(mip.range.start, mip.range.endExclusive), { rowPitch: 0 });
      checkOpen(isOpen);
    }
  }
  try {
    texture(water, (handle) => { id = handle; });
    if (surf) texture(surf, (handle) => { surfId = handle; });
  } catch (error) {
    try { owner.dispose(); } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Water texture creation failed');
    }
    throw error;
  }
  return owner;
}
