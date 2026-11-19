#pragma once
#include <stdint.h>

// Versioned renderer ABI. All pointers address this module's WASM memory;
// resource IDs are opaque and are never guest COM pointers or GL names.
// Setters return status. Creators return an ID, or zero with status/error set.
enum RomeRendererStatus { RR_OK=0, RR_ARGUMENT=1, RR_RESOURCE=2, RR_UNSUPPORTED=3,
    RR_BACKEND=4, RR_GL=5, RR_NOT_INITIALIZED=6, RR_OUT_OF_MEMORY=7 };
enum RomeRendererBuffer { RR_VERTEX=0, RR_INDEX16=1, RR_INDEX32=2 };
enum RomeRendererTransform { RR_WORLD=0, RR_VIEW=1, RR_PROJECTION=2,
    RR_TEXTURE0=16, RR_TEXTURE1=17 };
// All other accepted texture format numbers are D3DFMT_* values. A8R8G8B8
// means BGRA byte order; X8R8G8B8 is BGRX. Packed16 formats are little endian.
#define RR_RGBA8 UINT32_C(0x80000001)

#ifdef __cplusplus
extern "C" {
#endif
uint32_t rome_renderer_v1_abi_version(void);
uint32_t rome_renderer_v1_status(void);
const char* rome_renderer_v1_error(void);
uint32_t rome_renderer_v1_gl_error(void);
uint32_t rome_renderer_v1_init(const char* selector,uint32_t width,uint32_t height);
uint32_t rome_renderer_v1_dispose(void);
const char* rome_renderer_v1_capabilities(void);
uint32_t rome_renderer_v1_resize(uint32_t width,uint32_t height);
uint32_t rome_renderer_v1_create_buffer(uint32_t kind,uint32_t bytes,uint32_t dynamic);
uint32_t rome_renderer_v1_update_buffer(uint32_t id,uint32_t offset,const void* data,uint32_t bytes,uint32_t discard);
uint32_t rome_renderer_v1_destroy_buffer(uint32_t id);
uint32_t rome_renderer_v1_create_texture(uint32_t width,uint32_t height,uint32_t levels,uint32_t format);
uint32_t rome_renderer_v1_upload_texture(uint32_t id,uint32_t level,uint32_t row_pitch,const void* data,uint32_t bytes);
uint32_t rome_renderer_v1_destroy_texture(uint32_t id);
uint32_t rome_renderer_v1_set_texture(uint32_t stage,uint32_t id);
// Browser quality policy, default off; stage must be0, enabled BOOL0/1.
// Stage0 texture RGB keeps implicit LOD, alpha uses textureLod(...,0). Stage1
// is unchanged. Reset clears it; draw-state scopes restore it on exceptions.
uint32_t rome_renderer_v1_set_texture_alpha_lod0(uint32_t stage,uint32_t enabled);
// Independent browser RGB policy: stage0 only, finite bias in [-4,4], default0.
// RGB uses implicit texture LOD plus bias; alpha retains its ordinary implicit
// LOD or the separate base-alpha override. Reset/scopes restore this draw state.
uint32_t rome_renderer_v1_set_texture_color_lod_bias(uint32_t stage,float bias);
uint32_t rome_renderer_v1_set_fvf(uint32_t fvf);
// Bounded material lighting: no active lights and XYZ without vertex colors.
uint32_t rome_renderer_v1_set_material_lighting(uint32_t enabled,const void* material_words,uint32_t ambient);
// Optional finite directional slice: XYZ+NORMAL without vertex colors, one
// directional light or a null light pointer for no enabled lights. Both packets
// retain raw material17/light26 DWORDs; normalize_normals is D3DRS143, not153.
uint32_t rome_renderer_v1_set_directional_lighting(uint32_t enabled,const void* material_words,
    const void* light_words,uint32_t ambient,uint32_t normalize_normals);
// Optional vertex-color extension. Effective diffuse/ambient COLOR1 sources
// are separate BOOLs; the original five-argument call selects material sources.
uint32_t rome_renderer_v1_set_directional_vertex_lighting(uint32_t enabled,const void* material_words,
    const void* light_words,uint32_t ambient,uint32_t normalize_normals,
    uint32_t diffuse_from_vertex,uint32_t ambient_from_vertex);
// Optional bounded vertex-program extension. Declaration records contain four
// uint32 words: register, byte offset, D3DVSDT_FLOAT1..4/D3DCOLOR, reserved zero.
// Program source is ES3 emitted by the separately validated token translator.
uint32_t rome_renderer_v1_create_vertex_program(const char* source,uint32_t source_bytes,
    const uint32_t* attributes,uint32_t attribute_count,uint32_t constant_count);
uint32_t rome_renderer_v1_destroy_vertex_program(uint32_t id);
uint32_t rome_renderer_v1_set_vertex_program(uint32_t id);
uint32_t rome_renderer_v1_set_vertex_constants(uint32_t start,const float* values,uint32_t count);
uint32_t rome_renderer_v1_set_stream(uint32_t id,uint32_t stride);
uint32_t rome_renderer_v1_set_indices(uint32_t id,uint32_t base_vertex);
uint32_t rome_renderer_v1_set_render_state(uint32_t state,uint32_t value);
// Bounded synchronous draw-state scopes (at most 16, nested). Retain all logical
// draw states, lighting/program selections, bindings, target/depth and viewport.
// Pop restores the logical state; the backend rebinds draw resources on the next
// draw. No pixel/texture/buffer contents are rolled back. Resizing/reset/dispose,
// changing vertex constants and destroying a saved binding are refused in scope.
uint32_t rome_renderer_v1_push_draw_state(void);
uint32_t rome_renderer_v1_pop_draw_state(void);
uint32_t rome_renderer_v1_set_stage_state(uint32_t stage,uint32_t state,uint32_t value);
uint32_t rome_renderer_v1_set_transform(uint32_t transform,const float* matrix16);
uint32_t rome_renderer_v1_set_viewport(uint32_t x,uint32_t y,uint32_t width,uint32_t height,float min_z,float max_z);
// flags: 1 color, 2 depth, 4 stencil. Stencil clear writes its low eight bits;
// draws support stencil states52..59: uint8 reference, uint32 masks, all eight
// compare/operation values; absent stencil storage refuses. State171 accepts ADD.
uint32_t rome_renderer_v1_clear(uint32_t flags,uint32_t argb,float depth,uint32_t stencil);
uint32_t rome_renderer_v1_draw(uint32_t primitive,uint32_t start_vertex,uint32_t primitive_count);
uint32_t rome_renderer_v1_draw_indexed(uint32_t primitive,uint32_t start_index,uint32_t primitive_count);
uint32_t rome_renderer_v1_present(void);
uint32_t rome_renderer_v1_device_state(void);
uint32_t rome_renderer_v1_presented_width(void);
uint32_t rome_renderer_v1_presented_height(void);
uint32_t rome_renderer_v1_read_presented(void* data,uint32_t bytes);
uint32_t rome_renderer_v1_reset(uint32_t width,uint32_t height);
// RGBA8, top-left row first, independent of the backend's internal FBO layout.
uint32_t rome_renderer_v1_read_pixels(void* data,uint32_t bytes);
// Standalone X8R8G8B8/MSAA0 targets. Zero target selects the primary buffer;
// primary_depth is 0 (no attachment) or 1 (the existing primary D24S8 surface).
uint32_t rome_renderer_v1_create_render_target(uint32_t width,uint32_t height,uint32_t format,uint32_t multi_sample);
uint32_t rome_renderer_v1_destroy_render_target(uint32_t id);
uint32_t rome_renderer_v1_set_render_target(uint32_t id,uint32_t primary_depth,uint32_t reset_viewport);
uint32_t rome_renderer_v1_read_target(uint32_t id,void* data,uint32_t bytes);
// Input is guest BGRX, top-left rows; padding is permitted and X is ignored.
uint32_t rome_renderer_v1_upload_target(uint32_t id,uint32_t x,uint32_t y,uint32_t width,uint32_t height,
    uint32_t row_pitch,uint32_t format,const void* data,uint32_t bytes);
#ifdef __cplusplus
}
#endif
