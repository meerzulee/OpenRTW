#include "renderer.h"
#include "core/backend.h"
#include <GLES3/gl3.h>
#include <emscripten/emscripten.h>
#include <emscripten/heap.h>
#include <emscripten/html5.h>
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <limits>
#include <memory>
#include <new>
#include <sstream>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

#ifndef ROME_VERTEX_PROGRAMS
#define ROME_VERTEX_PROGRAMS 0
#endif

#ifndef ROME_RASTER_VALIDATED
#define ROME_RASTER_VALIDATED 0
#endif

#ifndef ROME_FINITE_DIRECTIONAL
#define ROME_FINITE_DIRECTIONAL 0
#endif

#ifndef ROME_DIRECTIONAL_VERTEX_COLORS
#define ROME_DIRECTIONAL_VERTEX_COLORS 0
#endif

#ifndef ROME_DIRECTIONAL_VERTEX_COLOR_TEX1
#define ROME_DIRECTIONAL_VERTEX_COLOR_TEX1 0
#endif
#if ROME_DIRECTIONAL_VERTEX_COLOR_TEX1 && (!ROME_DIRECTIONAL_VERTEX_COLORS || !ROME_FINITE_DIRECTIONAL)
#error "Directional TEX1 vertex colors require directional vertex colors and finite directional lighting"
#endif

#ifndef ROME_DIRECTIONAL_VERTEX_ALPHA_BLEND
#define ROME_DIRECTIONAL_VERTEX_ALPHA_BLEND 0
#endif

#ifndef ROME_PROGRAMMABLE_SPECULAR
#define ROME_PROGRAMMABLE_SPECULAR 0
#endif

#ifndef ROME_PROGRAMMABLE_SPECULAR_ALPHA_BLEND
#define ROME_PROGRAMMABLE_SPECULAR_ALPHA_BLEND 0
#endif

namespace {
using namespace d8web;
struct Buffer { BackendHandle backend; uint32_t kind,size; };
struct Format { TexFormat backend; uint32_t pixelBytes,blockBytes; bool alpha; };
struct Texture { BackendHandle backend; uint32_t width,height,levels,format; Format description; };
struct RenderTarget { BackendHandle backend; uint32_t width,height; };
std::unique_ptr<IBackend> backend;
StateSnapshot state;
VertexLayout layout;
std::unordered_map<uint32_t,Buffer> buffers;
std::unordered_map<uint32_t,Texture> textures;
std::unordered_map<uint32_t,RenderTarget> targets;
std::unordered_map<uint32_t,BackendHandle> vertexPrograms;
uint32_t currentVertexProgram=0;
uint32_t nextId=1,width=0,height=0,stream=0,stride=0,indices=0,baseVertex=0;
uint32_t currentTarget=0;
uint32_t presentedWidth=0,presentedHeight=0;
bool currentDepth=true;
bool materialLightingEnabled=false;
bool directionalLightingEnabled=false;
bool directionalDiffuseFromVertex=false,directionalAmbientFromVertex=false;
uint32_t textureIds[kActiveStages]{};
uint32_t status=RR_OK,glError=0;
char errorText[512]{};
std::string selector,capabilities;
GLint maxTexture=0,maxRenderbuffer=0,maxViewport[2]{};
GLint measuredStencilBits=0;
// D3D8 numbers not present in the vendor's deliberately small enum table.
constexpr uint32_t stencilFail=53,stencilDepthFail=54,stencilPass=55,stencilFunction=56;
constexpr uint32_t stencilReference=57,stencilMask=58,stencilWriteMask=59,blendOperation=171;
struct SavedDrawState {
    StateSnapshot state;
    VertexLayout layout;
    uint32_t program,stream,stride,indices,baseVertex,target;
    bool depth,materialLighting,directionalLighting,diffuseFromVertex,ambientFromVertex;
    std::array<uint32_t,kActiveStages> textures;
};
std::vector<SavedDrawState> drawStateStack;
void stencilDefaults(){
    state.rs[stencilFail]=state.rs[stencilDepthFail]=state.rs[stencilPass]=1;
    state.rs[stencilFunction]=D3DCMP_ALWAYS;state.rs[stencilReference]=0;
    state.rs[stencilMask]=state.rs[stencilWriteMask]=0xffffffffu;state.rs[blendOperation]=1;
}
GLenum stencilCompare(uint32_t value){
    constexpr GLenum table[]={GL_NEVER,GL_LESS,GL_EQUAL,GL_LEQUAL,GL_GREATER,GL_NOTEQUAL,GL_GEQUAL,GL_ALWAYS};
    return table[value-1];
}
GLenum stencilOperation(uint32_t value){
    constexpr GLenum table[]={GL_KEEP,GL_ZERO,GL_REPLACE,GL_INCR,GL_DECR,GL_INVERT,GL_INCR_WRAP,GL_DECR_WRAP};
    return table[value-1];
}
void applyStencilState(){
    if(state.rs[D3DRS_STENCILENABLE]){
        glEnable(GL_STENCIL_TEST);
        // GL and D3D both compare masked reference OP masked stored stencil.
        glStencilFunc(stencilCompare(state.rs[stencilFunction]),GLint(state.rs[stencilReference]),state.rs[stencilMask]&255u);
        glStencilMask(state.rs[stencilWriteMask]&255u);
        glStencilOp(stencilOperation(state.rs[stencilFail]),stencilOperation(state.rs[stencilDepthFail]),stencilOperation(state.rs[stencilPass]));
    }else glDisable(GL_STENCIL_TEST);
    glBlendEquation(GL_FUNC_ADD); // the accepted D3DBLENDOP subset is ADD only
}

uint32_t fail(uint32_t code,const char* message){status=code;std::snprintf(errorText,sizeof(errorText),"%s",message);return code;}
void clearError(){status=RR_OK;glError=0;errorText[0]=0;}
void releaseRenderer(){
    drawStateStack.clear();measuredStencilBits=0;
    buffers.clear();textures.clear();targets.clear();vertexPrograms.clear();currentVertexProgram=0;backend.reset();capabilities.clear();selector.clear();materialLightingEnabled=directionalLightingEnabled=false;
    directionalDiffuseFromVertex=directionalAmbientFromVertex=false;
    width=height=stream=stride=indices=baseVertex=0;for(auto& id:textureIds)id=0;
    currentTarget=0;currentDepth=true;presentedWidth=presentedHeight=0;state=StateSnapshot{};layout=VertexLayout{};
}
bool span(const void* data,uint64_t size){return data && uint64_t(uintptr_t(data))<=emscripten_get_heap_size() && size<=emscripten_get_heap_size()-uint64_t(uintptr_t(data));}
bool ready(){if(backend)return true;fail(RR_NOT_INITIALIZED,"Renderer is not initialized");return false;}
uint32_t backendResult(){
    if(backend->lastError())return fail(RR_BACKEND,backend->lastError());
    glError=glGetError();return glError?fail(RR_GL,"WebGL operation failed"):RR_OK;
}
template<class F> uint32_t operation(F&& fn){clearError();try{return fn();}catch(const std::bad_alloc&){return fail(RR_OUT_OF_MEMORY,"Renderer memory allocation failed");}catch(const std::exception& e){return fail(RR_BACKEND,e.what());}}
template<class F> uint32_t resource(F&& fn){clearError();try{return fn();}catch(const std::bad_alloc&){fail(RR_OUT_OF_MEMORY,"Renderer memory allocation failed");return 0;}catch(const std::exception& e){fail(RR_BACKEND,e.what());return 0;}}
uint32_t newId(){if(!nextId)throw std::runtime_error("Renderer resource ID space exhausted");return nextId++;}
uint32_t mipCount(uint32_t w,uint32_t h){uint32_t result=1;for(uint32_t n=std::max(w,h);n>1;n>>=1)++result;return result;}
bool formatInfo(uint32_t format,Format& info){
    switch(format){
        case RR_RGBA8:case D3DFMT_A8R8G8B8: info={TexFormat::RGBA8,4,0,true};return true;
        case D3DFMT_X8R8G8B8:info={TexFormat::RGBA8,4,0,false};return true;
        case D3DFMT_R5G6B5:info={TexFormat::RGB565,2,0,false};return true;
        case D3DFMT_A1R5G5B5:info={TexFormat::RGB5A1,2,0,true};return true;
        case D3DFMT_A4R4G4B4:info={TexFormat::RGBA4,2,0,true};return true;
        case D3DFMT_L8:info={TexFormat::RGBA8,1,0,false};return true;
        case D3DFMT_A8L8:info={TexFormat::RGBA8,2,0,true};return true;
        case D3DFMT_A8:info={TexFormat::RGBA8,1,0,true};return true;
        case D3DFMT_DXT1:info={TexFormat::DXT1,0,8,true};return true;
        case D3DFMT_DXT3:info={TexFormat::DXT3,0,16,true};return true;
        case D3DFMT_DXT5:info={TexFormat::DXT5,0,16,true};return true;
        default:return false;
    }
}
bool directionalColorFvf(uint32_t fvf){
    return ROME_DIRECTIONAL_VERTEX_COLORS&&(fvf==0x252||(ROME_DIRECTIONAL_VERTEX_COLOR_TEX1&&fvf==0x152));
}
bool supportedFvf(uint32_t fvf){
    if(directionalColorFvf(fvf))return true;
    // The synthetic finite controls cover TEX1 and the earlier consumer covers
    // no UV. Other normal layouts remain outside the optional color paths.
    if(ROME_FINITE_DIRECTIONAL&&(fvf==0x12||fvf==0x112))return true;
    const uint32_t position=fvf&D3DFVF_POSITION_MASK;
    return (position==D3DFVF_XYZ||position==D3DFVF_XYZRHW) &&
        // Rome's pretransformed vertices include an unused specular DWORD.
        // VertexLayout still consumes it so texture coordinates retain their
        // native offsets. This does not enable specular shading or vertex fog.
        (!(fvf&D3DFVF_SPECULAR)||position==D3DFVF_XYZRHW) &&
        !(fvf&~(D3DFVF_POSITION_MASK|D3DFVF_DIFFUSE|D3DFVF_SPECULAR|D3DFVF_TEXCOUNT_MASK)) &&
        ((fvf&D3DFVF_TEXCOUNT_MASK)>>D3DFVF_TEXCOUNT_SHIFT)<=2;
}
bool viewportFitsExtent(uint32_t extentWidth,uint32_t extentHeight,uint32_t x,uint32_t y,uint32_t w,uint32_t h,float minZ,float maxZ){
    return w&&h&&x<=extentWidth&&y<=extentHeight&&w<=extentWidth-x&&h<=extentHeight-y&&
        w<=uint32_t(maxViewport[0])&&h<=uint32_t(maxViewport[1])&&
        std::isfinite(minZ)&&std::isfinite(maxZ)&&minZ>=0&&maxZ<=1&&minZ<=maxZ;
}
bool viewportFits(uint32_t x,uint32_t y,uint32_t w,uint32_t h,float minZ,float maxZ){
    const auto& target=currentTarget?targets.at(currentTarget):RenderTarget{0,width,height};
    return viewportFitsExtent(target.width,target.height,x,y,w,h,minZ,maxZ);
}
bool targetDescription(uint32_t id,RenderTarget& result){
    if(!id){result={0,width,height};return true;}
    const auto found=targets.find(id);if(found==targets.end()){fail(RR_RESOURCE,"Unknown render target ID");return false;}
    result=found->second;return true;
}
std::string quoted(const char* text){std::string out="\"";
    if(text){for(const unsigned char* p=(const unsigned char*)text;*p;p++){
        if(*p=='"'||*p=='\\'){out+='\\';out+=char(*p);}else if(*p>=32)out+=char(*p);
    }}
    return out+'"';
}
bool operationSamplesTexture(uint32_t operation,uint32_t first,uint32_t second){
    const auto texture=[](uint32_t argument){return (argument&D3DTA_SELECTMASK)==D3DTA_TEXTURE;};
    if(operation==D3DTOP_DISABLE)return false;
    if(operation==D3DTOP_SELECTARG1)return texture(first);
    if(operation==D3DTOP_SELECTARG2)return texture(second);
    return texture(first)||texture(second);
}
bool programmableSpecularBlendState(){
    return ROME_PROGRAMMABLE_SPECULAR_ALPHA_BLEND&&currentVertexProgram&&
        state.rs[D3DRS_SPECULARENABLE]==1&&state.rs[D3DRS_FOGENABLE]==0&&
        state.rs[D3DRS_ALPHABLENDENABLE]==1&&state.rs[D3DRS_SRCBLEND]==D3DBLEND_SRCALPHA&&
        state.rs[D3DRS_DESTBLEND]==D3DBLEND_INVSRCALPHA&&
        (state.rs[D3DRS_ALPHATESTENABLE]==0||(state.rs[D3DRS_ALPHATESTENABLE]==1&&
         state.rs[D3DRS_ALPHAFUNC]==D3DCMP_GREATER&&state.rs[D3DRS_ALPHAREF]==0));
}
ShaderKey rendererShaderKey(){
    // The retained ShaderKey patch resolves NULL textures by the operands
    // actually read by each operation, independently for RGB and alpha.
    if (currentVertexProgram) {
        VertexLayout output; output.xyz=true; output.diffuse=true; output.texCoordSets=2;
        auto key=ShaderKey::from(state,output); key.lighting=false;
#if ROME_PROGRAMMABLE_SPECULAR
        key.programmableSpecularAddition=state.rs[D3DRS_SPECULARENABLE]==1;
#endif
#if ROME_PROGRAMMABLE_SPECULAR_ALPHA_BLEND
        key.programmableSpecularAlphaBlend=programmableSpecularBlendState();
#endif
        return key;
    }
    auto key=ShaderKey::from(state,layout);
    if(materialLightingEnabled&&!layout.xyzrhw){key.lighting=true;key.directionalLights=0;key.pointLights=0;}
#if ROME_FINITE_DIRECTIONAL
    if(directionalLightingEnabled&&!layout.xyzrhw){
        key.lighting=true;key.directionalLights=state.lights[0].enabled?1:0;key.pointLights=0;
        key.normalizeNormals=state.rs[D3DRS_NORMALIZENORMALS]!=0;
#if ROME_DIRECTIONAL_VERTEX_COLORS
        key.vertexDiffuseSource=directionalDiffuseFromVertex;
        key.vertexAmbientSource=directionalAmbientFromVertex;
#if ROME_DIRECTIONAL_VERTEX_ALPHA_BLEND
        key.directionalVertexAlphaBlend=directionalColorFvf(state.fvf)&&(state.rs[D3DRS_ALPHABLENDENABLE]!=0||
            (state.rs[D3DRS_ALPHATESTENABLE]&&state.rs[D3DRS_ALPHAFUNC]==D3DCMP_GREATER&&state.rs[D3DRS_ALPHAREF]==0));
#endif
#endif
    }
#endif
    return key;
}
bool boundedNormalInverse(){
    // Match the host's local numeric guard for the shader inverse. The D3D
    // row-major WORLD*VIEW is the transpose of uploaded GLSL view*world.
    // Separate rounded operations also exclude fused-product cancellation.
    const auto f=[](float value){volatile float rounded=value;return rounded;};
    float m[9],cofactors[9];double scale=0;
    for(unsigned row=0;row<3;row++)for(unsigned column=0;column<3;column++){
        const float a=f(state.world.m[row][0]*state.view.m[0][column]);
        const float b=f(state.world.m[row][1]*state.view.m[1][column]);
        const float c=f(state.world.m[row][2]*state.view.m[2][column]);
        const float value=f(f(a+b)+c);
        if(!std::isfinite(value))return false;
        m[row*3+column]=value;scale=std::max(scale,std::abs(double(value)));
    }
    for(unsigned row=0;row<3;row++)for(unsigned column=0;column<3;column++){
        unsigned rows[2],columns[2],r=0,c=0;
        for(unsigned i=0;i<3;i++){if(i!=row)rows[r++]=i;if(i!=column)columns[c++]=i;}
        const float minor=f(f(m[rows[0]*3+columns[0]]*m[rows[1]*3+columns[1]])-
                            f(m[rows[0]*3+columns[1]]*m[rows[1]*3+columns[0]]));
        const float value=(row+column)%2?f(-minor):minor;
        if(!std::isfinite(value))return false;
        cofactors[row*3+column]=value;
    }
    const float determinant=f(f(f(m[0]*cofactors[0])+f(m[1]*cofactors[1]))+f(m[2]*cofactors[2]));
    if(!std::isfinite(determinant)||determinant==0||
       std::abs(double(determinant))<scale*scale*scale*1e-5)return false;
    for(const float cofactor:cofactors){
        const float inverse=f(cofactor/determinant);
        if(!std::isfinite(inverse)||std::abs(inverse)>1e6f)return false;
    }
    return true;
}
void describeCapabilities(){
    GLint attributes=0,units=0,subpixel=0,depth=0,stencil=0,red=0,green=0,blue=0,alpha=0;
    GLint64 maximumIndex=0;
    glGetIntegerv(GL_MAX_VERTEX_ATTRIBS,&attributes);glGetIntegerv(GL_MAX_TEXTURE_IMAGE_UNITS,&units);
    glGetIntegerv(GL_SUBPIXEL_BITS,&subpixel);glGetIntegerv(GL_DEPTH_BITS,&depth);glGetIntegerv(GL_STENCIL_BITS,&stencil);
    measuredStencilBits=stencil;
    glGetIntegerv(GL_RED_BITS,&red);glGetIntegerv(GL_GREEN_BITS,&green);glGetIntegerv(GL_BLUE_BITS,&blue);glGetIntegerv(GL_ALPHA_BITS,&alpha);
    glGetInteger64v(GL_MAX_ELEMENT_INDEX,&maximumIndex);
    std::ostringstream out;
    out<<"{\"schema\":\"rome-renderer-capabilities-v1\",\"abiVersion\":1,\"backend\":\"dvijoke-webgl2\","
       <<"\"limits\":{\"maxTexture2D\":"<<maxTexture<<",\"maxRenderbuffer\":"<<maxRenderbuffer
       <<",\"maxViewport\":["<<maxViewport[0]<<','<<maxViewport[1]<<"],\"vertexAttributes\":"<<attributes
       <<",\"textureUnits\":"<<units<<",\"implementedTextureStages\":"<<std::min(units,kActiveStages)
       <<",\"maxIndex32\":"<<std::min<uint64_t>(maximumIndex,0xfffffffeu)
       <<",\"subpixelBits\":"<<subpixel<<",\"colorBits\":["<<red<<','<<green<<','<<blue<<','<<alpha
       <<"],\"depthBits\":"<<depth<<",\"stencilBits\":"<<stencil<<"},"
       <<"\"features\":{\"buffers\":true,\"index16Including65535\":true,\"index32\":true,\"textures2D\":true,"
       <<"\"mipUploads\":true,\"pitchedUploads\":true,\"independentSamplers\":true,\"unlitFvf\":"<<(ROME_RASTER_VALIDATED?"true":"false")
       <<",\"xyz\":"<<(ROME_RASTER_VALIDATED?"true":"false")<<",\"xyzrhw\":"<<(ROME_RASTER_VALIDATED?"true":"false")
       <<",\"ignoredSpecularAttribute\":"<<(ROME_RASTER_VALIDATED?"true":"false")<<",\"specular\":false"
       <<",\"nullTextureOperands\":"<<(ROME_RASTER_VALIDATED?"true":"false")
       <<",\"ditherX8\":"<<(ROME_RASTER_VALIDATED?"true":"false")
       <<",\"alphaTest\":true,\"alphaBlend\":true,\"depth\":"<<(ROME_RASTER_VALIDATED?"true":"false")
       <<",\"boundedVertexPrograms\":"<<(ROME_VERTEX_PROGRAMS?"true":"false")
       <<",\"programmableSpecularAddition\":"<<(ROME_PROGRAMMABLE_SPECULAR?"true":"false")
       <<",\"programmableSpecularAlphaBlend\":"<<(ROME_PROGRAMMABLE_SPECULAR_ALPHA_BLEND?"true":"false")
       <<",\"ambientMaterialLighting\":true"
       <<",\"normalVertexFormats\":"<<(ROME_FINITE_DIRECTIONAL?"true":"false")
       <<",\"boundedDirectionalMaterialLighting\":"<<(ROME_FINITE_DIRECTIONAL?"true":"false")
       <<",\"directionalVertexColors\":"<<(ROME_DIRECTIONAL_VERTEX_COLORS?"true":"false")
       <<",\"directionalVertexColorTex1\":"<<(ROME_DIRECTIONAL_VERTEX_COLOR_TEX1?"true":"false")
       <<",\"directionalVertexAlphaBlend\":"<<(ROME_DIRECTIONAL_VERTEX_ALPHA_BLEND?"true":"false")
       <<",\"modulate2X\":true"
       <<",\"cameraSpacePositionTextureCoordinates\":"<<(ROME_FINITE_DIRECTIONAL?"true":"false")
       <<",\"textureTransformCount3\":"<<(ROME_FINITE_DIRECTIONAL?"true":"false")
       <<",\"lighting\":false,\"fog\":false,\"stencil\":"<<(ROME_RASTER_VALIDATED&&stencil==8?"true":"false")
       <<",\"campaignShadowZPass\":"<<(ROME_RASTER_VALIDATED&&stencil==8?"true":"false")
       <<",\"drawStateScopes\":true,\"stencilClear\":true,\"vertexShaders\":false,\"pixelShaders\":false,\"renderTargets\":true,\"renderTargetReadback\":true,\"renderTargetUpload\":true,\"sharedPrimaryDepth\":true,\"renderTargetTextures\":false,\"cubeTextures\":false,\"volumeTextures\":false,\"multisample\":false},"
       <<"\"renderTargetFormats\":[22],\"renderTargetMultiSampleTypes\":[0],"
       <<"\"filtering\":[\"point\",\"linear\",\"point-mip\",\"linear-mip\"],\"addressing\":[\"wrap\",\"mirror\",\"clamp\"],"
       <<"\"primitiveTypes\":[4,5,6],\"indexFormats\":[16,32],\"maxStreams\":1,\"maxStreamStride\":255,"
       <<"\"blendFactors\":{\"source\":[1,2,3,4,5,6,7,8,9,10,11],\"destination\":[1,2,3,4,5,6,7,8,9,10]},"
       <<"\"compareFunctions\":{\"alpha\":[1,2,3,4,5,6,7,8],\"depth\":[1,2,3,4,5,6,7,8]},"
       <<"\"culling\":[\"none\",\"cw\",\"ccw\"],\"shading\":[\"gouraud\"],\"fill\":[\"solid\"],"
       <<"\"textureStageOperations\":[\"disable\",\"selectArg1\",\"selectArg2\",\"modulate\",\"add\",\"modulate2X\"],"
       <<"\"formats\":[\"RGBA8\",\"A8R8G8B8-BGRA\",\"X8R8G8B8-BGRX\",\"R5G6B5-LE\",\"A1R5G5B5-LE\",\"A4R4G4B4-LE\",\"L8\",\"A8L8-LA\",\"A8\",\"DXT1\",\"DXT3\",\"DXT5\"],"
       <<"\"textureFormatCodes\":[21,22,23,25,26,28,50,51,827611204,861165636,894720068],"
       <<"\"compressedTexturesPowerOfTwoOnly\":true,\"backbuffer\":\"opaque-X8R8G8B8\",\"rasterProfile\":"
       <<quoted(ROME_RASTER_VALIDATED?"Wine-D3D8-bounded-native-vectors; driver subpixel precision remains explicit":"not-enabled-before-native-vector-validation")
       <<",\"driver\":{\"version\":"<<quoted((const char*)glGetString(GL_VERSION))
       <<",\"vendor\":"<<quoted((const char*)glGetString(GL_VENDOR))<<",\"renderer\":"<<quoted((const char*)glGetString(GL_RENDERER))<<"}}";
    capabilities=out.str();
}
uint32_t draw(uint32_t primitive,uint32_t start,uint32_t count,bool indexed){
    if(!ready())return status;
    if(!ROME_RASTER_VALIDATED)return fail(RR_UNSUPPORTED,"Raster drawing is not enabled before native-vector validation");
    if(state.rs[D3DRS_STENCILENABLE]&&(!currentDepth||measuredStencilBits!=8))
        return fail(RR_ARGUMENT,"Stencil drawing requires an attached 8-bit depth-stencil surface");
    if(primitive<D3DPT_TRIANGLELIST||primitive>D3DPT_TRIANGLEFAN)return fail(RR_UNSUPPORTED,"This renderer slice supports triangle list/strip/fan only");
    if(!currentVertexProgram&&!supportedFvf(state.fvf))return fail(RR_UNSUPPORTED,"No supported vertex layout is bound");
    if(!currentVertexProgram&&directionalColorFvf(state.fvf)){
        if(!directionalLightingEnabled||(!ROME_DIRECTIONAL_VERTEX_ALPHA_BLEND&&state.rs[D3DRS_ALPHABLENDENABLE]))
            return fail(RR_UNSUPPORTED,"The characterized normal/color layout requires directional lighting without alpha blending");
        if(state.rs[D3DRS_ALPHABLENDENABLE]&&
           (state.rs[D3DRS_SRCBLEND]!=D3DBLEND_SRCALPHA||state.rs[D3DRS_DESTBLEND]!=D3DBLEND_INVSRCALPHA||
            (state.rs[D3DRS_ALPHATESTENABLE]&&(state.rs[D3DRS_ALPHAFUNC]!=D3DCMP_GREATER||state.rs[D3DRS_ALPHAREF]!=0))))
            return fail(RR_UNSUPPORTED,"Directional vertex alpha blending requires SRCALPHA/INVSRCALPHA and alpha test disabled or GREATER/ref0");
    }
    if(materialLightingEnabled&&!currentVertexProgram&&!layout.xyzrhw&&(layout.diffuse||layout.specular||layout.normal))
        return fail(RR_UNSUPPORTED,"Ambient material lighting requires XYZ without vertex color or normal attributes");
    if(directionalLightingEnabled&&!currentVertexProgram&&!layout.xyzrhw){
        const bool colored=directionalColorFvf(state.fvf);
        if(!layout.normal||layout.specular||(!colored&&(layout.diffuse||(state.fvf!=0x12&&state.fvf!=0x112))))
            return fail(RR_UNSUPPORTED,"Directional lighting requires a characterized XYZ normal layout");
        if((directionalDiffuseFromVertex||directionalAmbientFromVertex)&&!colored)
            return fail(RR_UNSUPPORTED,"Vertex material sources require the characterized normal/color layout");
        if(state.lights[0].enabled&&!boundedNormalInverse())
            return fail(RR_UNSUPPORTED,"Directional normal inverse exceeds the bounded float32 numerical domain");
    }
    if(currentVertexProgram&&state.rs[D3DRS_FOGENABLE])
        return fail(RR_UNSUPPORTED,"Programmable fog consumers are not enabled");
    if(currentVertexProgram&&state.rs[D3DRS_SPECULARENABLE]&&
       (!ROME_PROGRAMMABLE_SPECULAR||state.rs[D3DRS_SPECULARENABLE]!=1||
        ((state.rs[D3DRS_ALPHATESTENABLE]||state.rs[D3DRS_ALPHABLENDENABLE])&&!programmableSpecularBlendState())))
        return fail(RR_UNSUPPORTED,"Programmable specular addition requires its bounded opaque, alpha-test-disabled profile");
    if(ROME_PROGRAMMABLE_SPECULAR&&!currentVertexProgram&&state.rs[D3DRS_SPECULARENABLE])
        return fail(RR_UNSUPPORTED,"Specular addition requires a selected vertex program");
    if(!currentVertexProgram&&layout.specular&&(state.rs[D3DRS_SPECULARENABLE]||state.rs[D3DRS_FOGENABLE]))
        return fail(RR_UNSUPPORTED,"The specular vertex attribute is supported only when specular shading and fog are disabled");
    auto vb=buffers.find(stream);if(vb==buffers.end()||vb->second.kind!=RR_VERTEX)return fail(RR_RESOURCE,"No vertex buffer is bound");
    for(unsigned stage=0;stage<kActiveStages;stage++) {
        if(state.stages[stage].values[D3DTSS_COLOROP]==D3DTOP_DISABLE)break;
        const auto& values=state.stages[stage].values;
        const bool sampled=operationSamplesTexture(values[D3DTSS_COLOROP],values[D3DTSS_COLORARG1],values[D3DTSS_COLORARG2])||
            operationSamplesTexture(values[D3DTSS_ALPHAOP],values[D3DTSS_ALPHAARG1],values[D3DTSS_ALPHAARG2]);
        if(sampled&&textureIds[stage]){
            const auto coordinate=values[D3DTSS_TEXCOORDINDEX],transform=values[D3DTSS_TEXTURETRANSFORMFLAGS];
            if(coordinate==D3DTSS_TCI_CAMERASPACEPOSITION){
                if(!ROME_FINITE_DIRECTIONAL||currentVertexProgram||layout.xyzrhw||transform!=D3DTTFF_COUNT3)
                    return fail(RR_UNSUPPORTED,"Camera position texture coordinates require unprojected COUNT3 on fixed XYZ vertices");
            }else{
                if(coordinate>=uint32_t(currentVertexProgram?2:layout.texCoordSets))
                    return fail(RR_UNSUPPORTED,"Texture stage references an absent vertex coordinate set");
                if(transform)return fail(RR_UNSUPPORTED,"Vertex UV texture transforms are not characterized");
            }
        }
    }
    DrawGeometry geometry;geometry.vb=vb->second.backend;geometry.vbStride=stride;geometry.layout=layout;
    if(currentVertexProgram) {
        auto program=vertexPrograms.find(currentVertexProgram);
        if(program==vertexPrograms.end())return fail(RR_RESOURCE,"No live vertex program is bound");
        geometry.vertexProgram=program->second;
    }
    geometry.primitive=D3DPRIMITIVETYPE(primitive);geometry.primCount=count;
    if(indexed){auto ib=buffers.find(indices);if(ib==buffers.end()||ib->second.kind==RR_VERTEX)return fail(RR_RESOURCE,"No index buffer is bound");
        geometry.ib=ib->second.backend;geometry.index32=ib->second.kind==RR_INDEX32;geometry.baseVertexIndex=baseVertex;geometry.startIndex=start;
    }else geometry.startVertex=start;
    // The pinned backend applies depth, cull and colour state but has no stencil
    // implementation. Apply our bounded stencil state at its C ABI seam. It is
    // independent of FVF/program and re-applied after every clear/target switch.
    applyStencilState();backend->draw(geometry,state,rendererShaderKey());return backendResult();
}
}

extern "C" {
EMSCRIPTEN_KEEPALIVE uint32_t rome_renderer_v1_abi_version(){return 1;}
EMSCRIPTEN_KEEPALIVE uint32_t rome_renderer_v1_status(){return status;}
EMSCRIPTEN_KEEPALIVE const char* rome_renderer_v1_error(){return errorText;}
EMSCRIPTEN_KEEPALIVE uint32_t rome_renderer_v1_gl_error(){return glError;}
EMSCRIPTEN_KEEPALIVE uint32_t rome_renderer_v1_init(const char* target,uint32_t w,uint32_t h){
    const bool alreadyInitialized=bool(backend);
    const auto result=operation([&]()->uint32_t{
    if(backend)return fail(RR_ARGUMENT,"Renderer is already initialized");
    if(!span(target,1)||!w||!h)return fail(RR_ARGUMENT,"Invalid renderer initialization arguments");
    size_t length=0;while(length<255&&span(target,length+1)&&target[length])++length;
    if(!length||length==255||!span(target,length+1))return fail(RR_ARGUMENT,"Invalid canvas selector");
    std::string chosen(target,length);
    if(emscripten_set_canvas_element_size(chosen.c_str(),1,1)!=EMSCRIPTEN_RESULT_SUCCESS)return fail(RR_ARGUMENT,"Canvas selector did not resolve");
    std::unique_ptr<IBackend> created(createWebGL2BackendForCanvas(chosen.c_str()));
    if(!created->init(1,1))return fail(RR_BACKEND,created->lastError()?created->lastError():"WebGL2 context creation failed");
    glGetIntegerv(GL_MAX_TEXTURE_SIZE,&maxTexture);glGetIntegerv(GL_MAX_RENDERBUFFER_SIZE,&maxRenderbuffer);glGetIntegerv(GL_MAX_VIEWPORT_DIMS,maxViewport);
    if(w>uint32_t(maxRenderbuffer)||h>uint32_t(maxRenderbuffer)||w>uint32_t(maxViewport[0])||h>uint32_t(maxViewport[1]))return fail(RR_ARGUMENT,"Backbuffer exceeds measured WebGL limits");
    selector=chosen;backend=std::move(created);width=w;height=h;
    backend->resize(int(w),int(h));
    if(backendResult())return status;
    state=StateSnapshot{};state.rs[D3DRS_LIGHTING]=FALSE;state.rs[D3DRS_CULLMODE]=D3DCULL_NONE;
    stencilDefaults();
    state.rs[D3DRS_ZENABLE]=FALSE;state.rs[D3DRS_ZWRITEENABLE]=TRUE;state.rs[D3DRS_TEXTUREFACTOR]=0xffffffffu;
    for(unsigned stage=0;stage<kActiveStages;stage++)state.stages[stage].values[D3DTSS_TEXCOORDINDEX]=stage;
    state.viewport={0,0,w,h,0,1};backend->setViewport(state.viewport);
    describeCapabilities();return backendResult();
    });
    // A rejected duplicate init belongs to the existing renderer. Any failure
    // during a new initialization releases only the resources created here.
    if(result&&!alreadyInitialized)releaseRenderer();
    return result;
}
EMSCRIPTEN_KEEPALIVE uint32_t rome_renderer_v1_dispose(){return operation([]()->uint32_t{
    if(!drawStateStack.empty()&&backend&&backend->cooperativeState()==0)return fail(RR_ARGUMENT,"Cannot dispose inside a draw-state scope");
    releaseRenderer();return RR_OK;
});}
EMSCRIPTEN_KEEPALIVE const char* rome_renderer_v1_capabilities(){clearError();return ready()?capabilities.c_str():nullptr;}
EMSCRIPTEN_KEEPALIVE uint32_t rome_renderer_v1_resize(uint32_t w,uint32_t h){return operation([&]()->uint32_t{
    if(!drawStateStack.empty())return fail(RR_ARGUMENT,"Cannot resize inside a draw-state scope");
    if(!ready())return status;if(!w||!h||w>uint32_t(maxRenderbuffer)||h>uint32_t(maxRenderbuffer)||w>uint32_t(maxViewport[0])||h>uint32_t(maxViewport[1]))return fail(RR_ARGUMENT,"Backbuffer exceeds measured WebGL limits");
    if(currentTarget)return fail(RR_UNSUPPORTED,"Select the primary target before resizing the backbuffer");
    backend->resize(int(w),int(h));if(backendResult())return status;width=w;height=h;currentDepth=true;state.viewport={0,0,w,h,0,1};backend->setViewport(state.viewport);return backendResult();
});}
EMSCRIPTEN_KEEPALIVE uint32_t rome_renderer_v1_device_state(){
    if(!backend)return 2;
    const int value=backend->cooperativeState();return value<0?2:uint32_t(value);
}
EMSCRIPTEN_KEEPALIVE uint32_t rome_renderer_v1_presented_width(){return presentedWidth;}
EMSCRIPTEN_KEEPALIVE uint32_t rome_renderer_v1_presented_height(){return presentedHeight;}
EMSCRIPTEN_KEEPALIVE uint32_t rome_renderer_v1_read_presented(void* data,uint32_t bytes){return operation([&]()->uint32_t{
    if(!ready())return status;
    if(!presentedWidth||!presentedHeight)return fail(RR_UNSUPPORTED,"No frame has been presented");
    if(uint64_t(presentedWidth)*presentedHeight*4>bytes||!span(data,bytes))return fail(RR_ARGUMENT,"Presented readback is out of bounds");
    if(!backend->readPresentedRGBA8(data,bytes)){backendResult();return status?status:fail(RR_BACKEND,"Presented readback failed");}
    return backendResult();
});}
EMSCRIPTEN_KEEPALIVE uint32_t rome_renderer_v1_reset(uint32_t w,uint32_t h){return operation([&]()->uint32_t{
    if(!ready())return status;
    if(!drawStateStack.empty())return fail(RR_ARGUMENT,"Cannot reset inside a draw-state scope");
    if(backend->cooperativeState()!=0)return fail(RR_UNSUPPORTED,"Lost-context resource restoration is not implemented");
    if(!w||!h||w>uint32_t(maxRenderbuffer)||h>uint32_t(maxRenderbuffer)||w>uint32_t(maxViewport[0])||h>uint32_t(maxViewport[1]))return fail(RR_ARGUMENT,"Backbuffer exceeds measured WebGL limits");
    if(!targets.empty())return fail(RR_UNSUPPORTED,"Release default-pool render targets before reset");
    if(!backend->setRenderTarget(0,true)){backendResult();return status?status:fail(RR_BACKEND,"Could not select primary reset target");}
    backend->resize(int(w),int(h));if(backendResult())return status;
    width=w;height=h;currentTarget=0;currentDepth=true;stream=stride=indices=baseVertex=0;currentVertexProgram=0;
    for(auto& id:textureIds)id=0;
    state=StateSnapshot{};layout=VertexLayout{};materialLightingEnabled=directionalLightingEnabled=false;
    stencilDefaults();
    directionalDiffuseFromVertex=directionalAmbientFromVertex=false;
    state.rs[D3DRS_LIGHTING]=FALSE;state.rs[D3DRS_CULLMODE]=D3DCULL_NONE;
    state.rs[D3DRS_ZENABLE]=FALSE;state.rs[D3DRS_ZWRITEENABLE]=TRUE;state.rs[D3DRS_TEXTUREFACTOR]=0xffffffffu;
    for(unsigned stage=0;stage<kActiveStages;stage++)state.stages[stage].values[D3DTSS_TEXCOORDINDEX]=stage;
    state.viewport={0,0,w,h,0,1};backend->setViewport(state.viewport);return backendResult();
});}
EMSCRIPTEN_KEEPALIVE uint32_t rome_renderer_v1_create_render_target(uint32_t w,uint32_t h,uint32_t format,uint32_t samples){return resource([&]()->uint32_t{
    if(!ready())return 0;
    if(format!=D3DFMT_X8R8G8B8||samples){fail(RR_UNSUPPORTED,"Only X8R8G8B8 render targets without multisampling are implemented");return 0;}
    if(!w||!h||w>uint32_t(maxTexture)||h>uint32_t(maxTexture)||w>uint32_t(maxRenderbuffer)||h>uint32_t(maxRenderbuffer)||
       w>uint32_t(maxViewport[0])||h>uint32_t(maxViewport[1])){fail(RR_ARGUMENT,"Render target exceeds measured WebGL limits");return 0;}
    const auto id=newId();targets.reserve(targets.size()+1);
    const auto handle=backend->createRenderTarget(w,h);const auto result=backendResult();
    if(!handle||result){if(handle)backend->destroyRenderTarget(handle);if(!result)fail(RR_BACKEND,"Render target allocation returned no handle");return 0;}
    try{targets.emplace(id,RenderTarget{handle,w,h});}catch(...){backend->destroyRenderTarget(handle);throw;}
    return id;
});}
EMSCRIPTEN_KEEPALIVE uint32_t rome_renderer_v1_destroy_render_target(uint32_t id){return operation([&]()->uint32_t{
    if(!ready())return status;RenderTarget target;
    if(!id)return fail(RR_ARGUMENT,"The primary render target is owned by the renderer");
    if(!targetDescription(id,target))return status;
    if(id==currentTarget)return fail(RR_ARGUMENT,"Cannot destroy the selected render target");
    for(const auto& saved:drawStateStack)if(saved.target==id)return fail(RR_ARGUMENT,"Render target is retained by a draw-state scope");
    if(!backend->destroyRenderTarget(target.backend)){backendResult();return status?status:fail(RR_BACKEND,"Render target destruction failed");}
    if(backendResult())return status;targets.erase(id);return RR_OK;
});}
EMSCRIPTEN_KEEPALIVE uint32_t rome_renderer_v1_set_render_target(uint32_t id,uint32_t primaryDepth,uint32_t resetViewport){return operation([&]()->uint32_t{
    if(!ready())return status;RenderTarget target;
    if(!targetDescription(id,target))return status;
    if(primaryDepth>1||resetViewport>1)return fail(RR_ARGUMENT,"Invalid render target selection flags");
    if(primaryDepth&&(target.width>width||target.height>height))return fail(RR_ARGUMENT,"Primary depth surface is smaller than the color target");
    auto viewport=resetViewport?D3DVIEWPORT8{0,0,target.width,target.height,0,1}:state.viewport;
    if(!viewportFitsExtent(target.width,target.height,viewport.X,viewport.Y,viewport.Width,viewport.Height,viewport.MinZ,viewport.MaxZ))
        return fail(RR_ARGUMENT,"Preserved viewport exceeds selected target");
    if(!backend->setRenderTarget(target.backend,primaryDepth!=0)){backendResult();return status?status:fail(RR_BACKEND,"Render target selection failed");}
    if(backendResult())return status;
    backend->setViewport(viewport);
    if(backendResult())return status;
    currentTarget=id;currentDepth=primaryDepth!=0;state.viewport=viewport;return RR_OK;
});}
EMSCRIPTEN_KEEPALIVE uint32_t rome_renderer_v1_read_target(uint32_t id,void* data,uint32_t bytes){return operation([&]()->uint32_t{
    if(!ready())return status;RenderTarget target;if(!targetDescription(id,target))return status;
    if(uint64_t(target.width)*target.height*4>bytes||!span(data,bytes))return fail(RR_ARGUMENT,"Render target readback destination is too small");
    if(!backend->readRenderTargetRGBA8(target.backend,data,bytes)){backendResult();return status?status:fail(RR_BACKEND,"Render target readback failed");}
    return backendResult();
});}
EMSCRIPTEN_KEEPALIVE uint32_t rome_renderer_v1_upload_target(uint32_t id,uint32_t x,uint32_t y,uint32_t w,uint32_t h,uint32_t pitch,uint32_t format,const void* data,uint32_t bytes){return operation([&]()->uint32_t{
    if(!ready())return status;RenderTarget target;if(!targetDescription(id,target))return status;
    if(format!=D3DFMT_X8R8G8B8)return fail(RR_UNSUPPORTED,"Render target upload requires guest BGRX bytes");
    if(!w||!h||x>target.width||y>target.height||w>target.width-x||h>target.height-y)return fail(RR_ARGUMENT,"Render target upload rectangle is out of bounds");
    const uint64_t row=uint64_t(w)*4,rowPitch=pitch?pitch:row,required=rowPitch*(h-1)+row;
    if(rowPitch<row||required>bytes||!span(data,bytes))return fail(RR_ARGUMENT,"Render target upload pitch or byte range is invalid");
    std::vector<uint8_t> rgb(size_t(w)*h*3);
    for(uint32_t py=0;py<h;py++)for(uint32_t px=0;px<w;px++){
        const auto* source=(const uint8_t*)data+size_t(py)*rowPitch+size_t(px)*4;
        auto* destination=rgb.data()+(size_t(py)*w+px)*3;
        destination[0]=source[2];destination[1]=source[1];destination[2]=source[0];
    }
    if(!backend->updateRenderTargetRGB8(target.backend,x,y,w,h,rgb.data(),UINT(rgb.size()))){backendResult();return status?status:fail(RR_BACKEND,"Render target upload failed");}
    return backendResult();
});}
EMSCRIPTEN_KEEPALIVE uint32_t rome_renderer_v1_create_buffer(uint32_t kind,uint32_t bytes,uint32_t dynamic){return resource([&]()->uint32_t{
    if(!ready())return 0;if(kind>RR_INDEX32||!bytes||dynamic>1){fail(RR_ARGUMENT,"Invalid buffer description");return 0;}
    auto type=kind==RR_VERTEX?BufferKind::Vertex:kind==RR_INDEX16?BufferKind::Index16:BufferKind::Index32;
    const auto handle=backend->createBuffer(type,bytes,dynamic!=0);const auto result=backendResult();
    if(!handle||result){if(handle)backend->destroyBuffer(handle);if(!result)fail(RR_BACKEND,"Buffer allocation returned no handle");return 0;}
    const auto id=newId();try{buffers.emplace(id,Buffer{handle,kind,bytes});}catch(...){backend->destroyBuffer(handle);throw;}return id;
});}
EMSCRIPTEN_KEEPALIVE uint32_t rome_renderer_v1_update_buffer(uint32_t id,uint32_t offset,const void* data,uint32_t bytes,uint32_t discard){return operation([&]()->uint32_t{
    if(!ready())return status;auto b=buffers.find(id);if(b==buffers.end())return fail(RR_RESOURCE,"Unknown buffer ID");
    if(discard>1||offset>b->second.size||bytes>b->second.size-offset||!span(data,bytes))return fail(RR_ARGUMENT,"Buffer upload is out of bounds");
    backend->updateBuffer(b->second.backend,offset,data,bytes,discard!=0);return backendResult();
});}
EMSCRIPTEN_KEEPALIVE uint32_t rome_renderer_v1_destroy_buffer(uint32_t id){return operation([&]()->uint32_t{
    if(!ready())return status;auto b=buffers.find(id);if(b==buffers.end())return fail(RR_RESOURCE,"Unknown buffer ID");
    for(const auto& saved:drawStateStack)if(saved.stream==id||saved.indices==id)return fail(RR_ARGUMENT,"Buffer is retained by a draw-state scope");
    backend->destroyBuffer(b->second.backend);if(backendResult())return status;buffers.erase(b);if(stream==id)stream=stride=0;if(indices==id)indices=baseVertex=0;return RR_OK;
});}
EMSCRIPTEN_KEEPALIVE uint32_t rome_renderer_v1_create_texture(uint32_t w,uint32_t h,uint32_t levels,uint32_t format){return resource([&]()->uint32_t{
    if(!ready())return 0;Format description;if(!formatInfo(format,description)){fail(RR_UNSUPPORTED,"Unsupported texture format");return 0;}
    if(!w||!h||w>uint32_t(maxTexture)||h>uint32_t(maxTexture)||levels>mipCount(w,h)){fail(RR_ARGUMENT,"Invalid texture dimensions or mip count");return 0;}
    if(description.blockBytes&&((w&(w-1))||(h&(h-1)))){fail(RR_UNSUPPORTED,"Compressed texture profile currently requires power-of-two dimensions");return 0;}
    levels=levels?levels:mipCount(w,h);auto handle=backend->createTexture(w,h,levels,description.backend);
    const auto result=backendResult();if(!handle||result){if(handle)backend->destroyTexture(handle);if(!result)fail(RR_BACKEND,"Texture allocation returned no handle");return 0;}
    const auto id=newId();try{textures.emplace(id,Texture{handle,w,h,levels,format,description});}catch(...){backend->destroyTexture(handle);throw;}return id;
});}
EMSCRIPTEN_KEEPALIVE uint32_t rome_renderer_v1_upload_texture(uint32_t id,uint32_t level,uint32_t pitch,const void* data,uint32_t bytes){return operation([&]()->uint32_t{
    if(!ready())return status;auto found=textures.find(id);if(found==textures.end())return fail(RR_RESOURCE,"Unknown texture ID");const auto& t=found->second;
    if(level>=t.levels)return fail(RR_ARGUMENT,"Texture mip level is out of bounds");
    const uint32_t w=std::max(1u,t.width>>level),h=std::max(1u,t.height>>level);
    const uint64_t row=t.description.blockBytes?uint64_t((w+3)/4)*t.description.blockBytes:uint64_t(w)*t.description.pixelBytes;
    const uint32_t rows=t.description.blockBytes?(h+3)/4:h;
    const uint64_t sourcePitch=pitch?pitch:row,required=sourcePitch*(rows-1)+row;
    if(sourcePitch<row||required>bytes||!span(data,bytes))return fail(RR_ARGUMENT,"Texture upload pitch or byte range is invalid");
    std::vector<uint8_t> packed(size_t(row)*rows);
    for(uint32_t y=0;y<rows;y++)std::memcpy(packed.data()+size_t(y)*row,(const uint8_t*)data+size_t(y)*sourcePitch,size_t(row));
    if(t.format==D3DFMT_A8R8G8B8||t.format==D3DFMT_X8R8G8B8){for(size_t i=0;i<packed.size();i+=4){std::swap(packed[i],packed[i+2]);if(t.format==D3DFMT_X8R8G8B8)packed[i+3]=255;}}
    else if(t.format==D3DFMT_A1R5G5B5||t.format==D3DFMT_A4R4G4B4){for(size_t i=0;i<packed.size();i+=2){uint16_t v=uint16_t(packed[i]|uint16_t(packed[i+1])<<8);
        v=t.format==D3DFMT_A1R5G5B5?uint16_t((v<<1)|(v>>15)):uint16_t((v<<4)|(v>>12));packed[i]=uint8_t(v);packed[i+1]=uint8_t(v>>8);}}
    else if(t.format==D3DFMT_L8||t.format==D3DFMT_A8L8||t.format==D3DFMT_A8){std::vector<uint8_t> expanded(size_t(w)*h*4);
        for(size_t i=0;i<size_t(w)*h;i++){const auto luminance=t.format==D3DFMT_A8?255:packed[i*t.description.pixelBytes];
            expanded[i*4]=expanded[i*4+1]=expanded[i*4+2]=luminance;expanded[i*4+3]=t.format==D3DFMT_A8?packed[i]:t.format==D3DFMT_A8L8?packed[i*2+1]:255;}
        packed.swap(expanded);}
    backend->updateTexture(t.backend,level,w,h,t.description.backend,packed.data(),UINT(packed.size()));return backendResult();
});}
EMSCRIPTEN_KEEPALIVE uint32_t rome_renderer_v1_destroy_texture(uint32_t id){return operation([&]()->uint32_t{
    if(!ready())return status;auto t=textures.find(id);if(t==textures.end())return fail(RR_RESOURCE,"Unknown texture ID");
    for(const auto& saved:drawStateStack)for(const auto binding:saved.textures)if(binding==id)return fail(RR_ARGUMENT,"Texture is retained by a draw-state scope");
    backend->destroyTexture(t->second.backend);if(backendResult())return status;
    textures.erase(t);for(unsigned i=0;i<kActiveStages;i++)if(textureIds[i]==id){textureIds[i]=0;state.textures[i]=0;state.textureHasAlpha[i]=false;}return RR_OK;
});}
EMSCRIPTEN_KEEPALIVE uint32_t rome_renderer_v1_set_texture(uint32_t stage,uint32_t id){return operation([&]()->uint32_t{
    if(!ready())return status;if(stage>=kActiveStages)return fail(RR_UNSUPPORTED,"Texture stage is unsupported");auto t=textures.find(id);if(id&&t==textures.end())return fail(RR_RESOURCE,"Unknown texture ID");
    textureIds[stage]=id;state.textures[stage]=id?t->second.backend:0;state.textureHasAlpha[stage]=id?t->second.description.alpha:false;return RR_OK;
});}
EMSCRIPTEN_KEEPALIVE uint32_t rome_renderer_v1_set_texture_alpha_lod0(uint32_t stage,uint32_t enabled){return operation([&]()->uint32_t{
    if(!ready())return status;
    if(stage!=0)return fail(RR_UNSUPPORTED,"Base-alpha quality policy supports stage0 only");
    if(enabled>1)return fail(RR_ARGUMENT,"Base-alpha quality policy requires BOOL 0/1");
    state.stage0BaseAlpha=enabled!=0;return RR_OK;
});}
EMSCRIPTEN_KEEPALIVE uint32_t rome_renderer_v1_set_texture_color_lod_bias(uint32_t stage,float bias){return operation([&]()->uint32_t{
    if(!ready())return status;
    if(stage!=0)return fail(RR_UNSUPPORTED,"Color LOD bias quality policy supports stage0 only");
    if(!std::isfinite(bias)||bias < -4.0f||bias > 4.0f)return fail(RR_ARGUMENT,"Color LOD bias must be finite and within [-4,4]");
    state.stage0ColorLodBias=bias;return RR_OK;
});}
EMSCRIPTEN_KEEPALIVE uint32_t rome_renderer_v1_set_fvf(uint32_t fvf){return operation([&]()->uint32_t{
    if(!ready())return status;if(!supportedFvf(fvf))return fail(RR_UNSUPPORTED,"Vertex format is outside the bounded renderer layouts");state.fvf=fvf;layout=VertexLayout::fromFVF(fvf);currentVertexProgram=0;return RR_OK;
});}
EMSCRIPTEN_KEEPALIVE uint32_t rome_renderer_v1_create_vertex_program(const char* source,uint32_t bytes,
        const uint32_t* declarations,uint32_t count,uint32_t constants){return resource([&]()->uint32_t{
    if(!ready())return 0;
    if(!ROME_VERTEX_PROGRAMS){fail(RR_UNSUPPORTED,"Bounded vertex programs are not enabled");return 0;}
    if(!bytes||bytes>(1u<<20)||!span(source,bytes)||source[bytes-1]||
            std::memchr(source,0,bytes-1)||count>16||(count&&(!span(declarations,uint64_t(count)*16)||
            uintptr_t(declarations)%4))||!constants||constants>8192){fail(RR_ARGUMENT,"Invalid vertex program inputs");return 0;}
    std::vector<VertexAttribute> attributes(count);uint32_t seen=0;
    for(uint32_t i=0;i<count;i++){
        auto& a=attributes[i];a={declarations[i*4],declarations[i*4+1],declarations[i*4+2],declarations[i*4+3]};
        const uint32_t storage=a.type==4?4:(a.type+1)*4;
        if(a.registerIndex>=16||a.type>4||a.reserved||a.offset>255||storage>255-a.offset||
                (seen&(1u<<a.registerIndex))){fail(RR_ARGUMENT,"Invalid vertex program attribute");return 0;}
        seen|=1u<<a.registerIndex;
    }
    if(vertexPrograms.size()>=4096){fail(RR_RESOURCE,"Vertex program limit exceeded");return 0;}
    auto handle=backend->createVertexProgram(source,attributes.data(),count,constants);
    const auto result=backendResult();
    if(!handle||result){if(handle)backend->destroyVertexProgram(handle);if(!result)fail(RR_BACKEND,"Vertex program creation failed");return 0;}
    try{auto id=newId();vertexPrograms.emplace(id,handle);return id;}
    catch(...){backend->destroyVertexProgram(handle);throw;}
});}
EMSCRIPTEN_KEEPALIVE uint32_t rome_renderer_v1_destroy_vertex_program(uint32_t id){return operation([&]()->uint32_t{
    if(!ready())return status;auto p=vertexPrograms.find(id);
    if(p==vertexPrograms.end())return fail(RR_RESOURCE,"Unknown vertex program ID");
    for(const auto& saved:drawStateStack)if(saved.program==id)return fail(RR_ARGUMENT,"Vertex program is retained by a draw-state scope");
    if(!backend->destroyVertexProgram(p->second)){backendResult();return status?status:fail(RR_BACKEND,"Vertex program destruction failed");}
    if(backendResult())return status;vertexPrograms.erase(p);if(currentVertexProgram==id)currentVertexProgram=0;return RR_OK;
});}
EMSCRIPTEN_KEEPALIVE uint32_t rome_renderer_v1_set_vertex_program(uint32_t id){return operation([&]()->uint32_t{
    if(!ready())return status;if(!ROME_VERTEX_PROGRAMS&&id)return fail(RR_UNSUPPORTED,"Bounded vertex programs are not enabled");
    if(id&&!vertexPrograms.count(id))return fail(RR_RESOURCE,"Unknown vertex program ID");currentVertexProgram=id;return RR_OK;
});}
EMSCRIPTEN_KEEPALIVE uint32_t rome_renderer_v1_set_vertex_constants(uint32_t start,const float* values,uint32_t count){return operation([&]()->uint32_t{
    if(!ready())return status;if(!ROME_VERTEX_PROGRAMS)return fail(RR_UNSUPPORTED,"Bounded vertex programs are not enabled");
    if(!drawStateStack.empty())return fail(RR_UNSUPPORTED,"Vertex constant mutation inside a draw-state scope is not implemented");
    if(start>8192||count>8192-start||(count&&(!span(values,uint64_t(count)*16)||uintptr_t(values)%4)))
        return fail(RR_ARGUMENT,"Invalid vertex constant upload");
    if(!backend->updateVertexConstants(start,values,count)){backendResult();return status?status:fail(RR_BACKEND,"Vertex constant upload failed");}
    return backendResult();
});}
EMSCRIPTEN_KEEPALIVE uint32_t rome_renderer_v1_set_stream(uint32_t id,uint32_t bytes){return operation([&]()->uint32_t{
    if(!ready())return status;auto b=buffers.find(id);if(id&&(b==buffers.end()||b->second.kind!=RR_VERTEX))return fail(RR_RESOURCE,"Invalid vertex buffer ID");if(id&&(!bytes||bytes>255))return fail(RR_ARGUMENT,"Vertex stride must be1..255");stream=id;stride=id?bytes:0;return RR_OK;
});}
EMSCRIPTEN_KEEPALIVE uint32_t rome_renderer_v1_set_indices(uint32_t id,uint32_t base){return operation([&]()->uint32_t{
    if(!ready())return status;auto b=buffers.find(id);if(id&&(b==buffers.end()||b->second.kind==RR_VERTEX))return fail(RR_RESOURCE,"Invalid index buffer ID");indices=id;baseVertex=id?base:0;return RR_OK;
});}
EMSCRIPTEN_KEEPALIVE uint32_t rome_renderer_v1_set_render_state(uint32_t name,uint32_t value){return operation([&]()->uint32_t{
    if(!ready())return status;bool allowed=false;
    switch(name){
        case D3DRS_ZENABLE:case D3DRS_ZWRITEENABLE:case D3DRS_ALPHATESTENABLE:case D3DRS_ALPHABLENDENABLE:case D3DRS_DITHERENABLE:allowed=value<=1;break;
        case D3DRS_ZFUNC:case D3DRS_ALPHAFUNC:allowed=value>=D3DCMP_NEVER&&value<=D3DCMP_ALWAYS;break;
        case D3DRS_SRCBLEND:allowed=value>=D3DBLEND_ZERO&&value<=D3DBLEND_SRCALPHASAT;break;
        case D3DRS_DESTBLEND:allowed=value>=D3DBLEND_ZERO&&value<=D3DBLEND_INVDESTCOLOR;break;
        case D3DRS_ALPHAREF:allowed=value<=255;break;
        case D3DRS_TEXTUREFACTOR:allowed=true;break;
        case D3DRS_COLORWRITEENABLE:allowed=value<=15;break;
        case D3DRS_CULLMODE:allowed=value>=D3DCULL_NONE&&value<=D3DCULL_CCW;break;
        case D3DRS_FILLMODE:allowed=value==D3DFILL_SOLID;break;
        case D3DRS_SHADEMODE:allowed=value==D3DSHADE_GOURAUD;break;
        case D3DRS_SPECULARENABLE:allowed=value==0||(ROME_PROGRAMMABLE_SPECULAR&&currentVertexProgram&&value==1);break;
        case D3DRS_STENCILENABLE:allowed=value<=1&&(!value||(ROME_RASTER_VALIDATED&&measuredStencilBits==8));break;
        case stencilFail:case stencilDepthFail:case stencilPass:case stencilFunction:allowed=value>=1&&value<=8;break;
        // Explicit bounded reference range; masks retain full uint32 semantics
        // at the ABI and consume their low eight bits on D24S8.
        case stencilReference:allowed=value<=255;break;
        case stencilMask:case stencilWriteMask:allowed=true;break;
        case blendOperation:allowed=value==1;break;
        case D3DRS_LIGHTING:case D3DRS_FOGENABLE:allowed=value==0;break;
        default:return fail(RR_UNSUPPORTED,"Render state is not implemented by this slice");
    }
    if(!allowed)return fail(RR_UNSUPPORTED,"Render-state value is not implemented by this slice");state.rs[name]=value;return RR_OK;
});}
EMSCRIPTEN_KEEPALIVE uint32_t rome_renderer_v1_push_draw_state(){return operation([]()->uint32_t{
    if(!ready())return status;
    if(drawStateStack.size()>=16)return fail(RR_ARGUMENT,"Draw-state scope nesting exceeds 16");
    SavedDrawState saved{state,layout,currentVertexProgram,stream,stride,indices,baseVertex,currentTarget,currentDepth,
        materialLightingEnabled,directionalLightingEnabled,directionalDiffuseFromVertex,directionalAmbientFromVertex,{}};
    std::copy(std::begin(textureIds),std::end(textureIds),saved.textures.begin());
    drawStateStack.push_back(std::move(saved));return RR_OK;
});}
EMSCRIPTEN_KEEPALIVE uint32_t rome_renderer_v1_pop_draw_state(){return operation([]()->uint32_t{
    if(!ready())return status;
    if(drawStateStack.empty())return fail(RR_ARGUMENT,"No draw-state scope is active");
    const auto saved=drawStateStack.back();
    // Saved resource destruction, resets and resizes are prohibited, so all
    // retained bindings and the previous target extent remain valid.
    const auto target=saved.target?targets.at(saved.target).backend:0;
    if(!backend->setRenderTarget(target,saved.depth)){backendResult();return status?status:fail(RR_BACKEND,"Draw-state target restoration failed");}
    backend->setViewport(saved.state.viewport);if(backendResult())return status;
    state=saved.state;layout=saved.layout;currentVertexProgram=saved.program;
    stream=saved.stream;stride=saved.stride;indices=saved.indices;baseVertex=saved.baseVertex;
    currentTarget=saved.target;currentDepth=saved.depth;
    materialLightingEnabled=saved.materialLighting;directionalLightingEnabled=saved.directionalLighting;
    directionalDiffuseFromVertex=saved.diffuseFromVertex;directionalAmbientFromVertex=saved.ambientFromVertex;
    std::copy(saved.textures.begin(),saved.textures.end(),std::begin(textureIds));
    drawStateStack.pop_back();applyStencilState();return backendResult();
});}
EMSCRIPTEN_KEEPALIVE uint32_t rome_renderer_v1_set_stage_state(uint32_t stage,uint32_t name,uint32_t value){return operation([&]()->uint32_t{
    if(!ready())return status;if(stage>=kActiveStages)return fail(RR_UNSUPPORTED,"Texture stage is unsupported");bool allowed=false;
    switch(name){
        case D3DTSS_COLOROP:allowed=value==D3DTOP_DISABLE||value==D3DTOP_SELECTARG1||value==D3DTOP_SELECTARG2||value==D3DTOP_MODULATE||value==D3DTOP_MODULATE2X||value==D3DTOP_ADD;break;
        case D3DTSS_ALPHAOP:allowed=value==D3DTOP_DISABLE||value==D3DTOP_SELECTARG1||value==D3DTOP_SELECTARG2||value==D3DTOP_MODULATE||value==D3DTOP_ADD;break;
        case D3DTSS_COLORARG1:case D3DTSS_COLORARG2:case D3DTSS_ALPHAARG1:case D3DTSS_ALPHAARG2:allowed=(value&~0x3f)==0&&(value&15)<=D3DTA_TFACTOR;break;
        case D3DTSS_TEXCOORDINDEX:allowed=value<2||(ROME_FINITE_DIRECTIONAL&&value==D3DTSS_TCI_CAMERASPACEPOSITION);break;
        case D3DTSS_ADDRESSU:case D3DTSS_ADDRESSV:allowed=value==D3DTADDRESS_WRAP||value==D3DTADDRESS_MIRROR||value==D3DTADDRESS_CLAMP;break;
        case D3DTSS_MINFILTER:case D3DTSS_MAGFILTER:allowed=value==D3DTEXF_POINT||value==D3DTEXF_LINEAR;break;
        case D3DTSS_MIPFILTER:allowed=value<=D3DTEXF_LINEAR;break;
        case D3DTSS_TEXTURETRANSFORMFLAGS:allowed=value==0||(ROME_FINITE_DIRECTIONAL&&value==D3DTTFF_COUNT3);break;
        default:return fail(RR_UNSUPPORTED,"Texture-stage state is not implemented by this slice");
    }
    if(!allowed)return fail(RR_UNSUPPORTED,"Texture-stage value is not implemented by this slice");state.stages[stage].values[name]=value;return RR_OK;
});}
EMSCRIPTEN_KEEPALIVE uint32_t rome_renderer_v1_set_material_lighting(uint32_t enabled,const void* words,uint32_t ambient){return operation([&]()->uint32_t{
    if(!ready())return status;
    if(enabled>1)return fail(RR_ARGUMENT,"Invalid ambient material lighting selector");
    if(!enabled){materialLightingEnabled=directionalLightingEnabled=false;directionalDiffuseFromVertex=directionalAmbientFromVertex=false;state.lights={};return RR_OK;}
    if(!span(words,68))return fail(RR_ARGUMENT,"Material pointer is out of bounds");
    float values[17];std::memcpy(values,words,68);
    for(unsigned i:{3u,4u,5u,6u,12u,13u,14u})if(!std::isfinite(values[i]))
        return fail(RR_UNSUPPORTED,"Nonfinite consumed ambient material components are not characterized");
    std::memcpy(&state.material,words,68);state.rs[D3DRS_AMBIENT]=ambient;state.lights={};directionalLightingEnabled=false;materialLightingEnabled=true;
    directionalDiffuseFromVertex=directionalAmbientFromVertex=false;return RR_OK;
});}
EMSCRIPTEN_KEEPALIVE uint32_t rome_renderer_v1_set_directional_lighting(uint32_t enabled,const void* words,
        const void* lightWords,uint32_t ambient,uint32_t normalizeNormals){
    return rome_renderer_v1_set_directional_vertex_lighting(enabled,words,lightWords,ambient,normalizeNormals,0,0);
}
EMSCRIPTEN_KEEPALIVE uint32_t rome_renderer_v1_set_directional_vertex_lighting(uint32_t enabled,const void* words,
        const void* lightWords,uint32_t ambient,uint32_t normalizeNormals,
        uint32_t diffuseFromVertex,uint32_t ambientFromVertex){return operation([&]()->uint32_t{
    if(!ready())return status;
    if(enabled>1||normalizeNormals>1||diffuseFromVertex>1||ambientFromVertex>1)return fail(RR_ARGUMENT,"Invalid directional lighting selector");
    if(!enabled){materialLightingEnabled=directionalLightingEnabled=false;directionalDiffuseFromVertex=directionalAmbientFromVertex=false;state.lights={};return RR_OK;}
    if(!ROME_FINITE_DIRECTIONAL)return fail(RR_UNSUPPORTED,"Finite directional lighting is not enabled in this build");
    if((diffuseFromVertex||ambientFromVertex)&&!ROME_DIRECTIONAL_VERTEX_COLORS)
        return fail(RR_UNSUPPORTED,"Directional vertex material sources are not enabled in this build");
    static_assert(sizeof(D3DMATERIAL8)==68&&sizeof(D3DLIGHT8)==104);
    if(!span(words,68))return fail(RR_ARGUMENT,"Material pointer is out of bounds");
    float values[17];std::memcpy(values,words,68);
    for(unsigned i:{3u,4u,5u,6u,12u,13u,14u})if(!std::isfinite(values[i]))
        return fail(RR_UNSUPPORTED,"Nonfinite consumed directional material components are not characterized");
    D3DLIGHT8 light{};
    if(lightWords){
        if(!span(lightWords,104))return fail(RR_ARGUMENT,"Light pointer is out of bounds");
        std::memcpy(&light,lightWords,104);
        if(light.Type!=D3DLIGHT_DIRECTIONAL)return fail(RR_UNSUPPORTED,"Only one standard directional light is supported");
        for(unsigned i:{0u,1u,2u})if(!std::isfinite(values[i]))
            return fail(RR_UNSUPPORTED,"Nonfinite consumed material diffuse components are not characterized");
        float fields[26];std::memcpy(fields,lightWords,104);
        for(unsigned i:{1u,2u,3u,9u,10u,11u,16u,17u,18u})if(!std::isfinite(fields[i]))
            return fail(RR_UNSUPPORTED,"Nonfinite consumed light components are not characterized");
        const double directionLengthSquared=double(light.Direction.x)*light.Direction.x+
            double(light.Direction.y)*light.Direction.y+double(light.Direction.z)*light.Direction.z;
        if(std::abs(directionLengthSquared-1.0)>1e-6)
            return fail(RR_UNSUPPORTED,"Only measured unit directional vectors are characterized");
    }
    // All checks precede publication, including pointer extents and finite
    // fields. Unused specular/scalar packet words remain unchanged.
    std::memcpy(&state.material,words,68);state.lights={};
    if(lightWords){state.lights[0].light=light;state.lights[0].enabled=true;state.lights[0].defined=true;}
    state.rs[D3DRS_AMBIENT]=ambient;state.rs[D3DRS_NORMALIZENORMALS]=normalizeNormals;
    directionalDiffuseFromVertex=diffuseFromVertex!=0;directionalAmbientFromVertex=ambientFromVertex!=0;
    materialLightingEnabled=false;directionalLightingEnabled=true;return RR_OK;
});}
EMSCRIPTEN_KEEPALIVE uint32_t rome_renderer_v1_set_transform(uint32_t kind,const float* values){return operation([&]()->uint32_t{
    if(!ready())return status;if(kind>RR_PROJECTION&&!(ROME_FINITE_DIRECTIONAL&&(kind==RR_TEXTURE0||kind==RR_TEXTURE1)))return fail(RR_UNSUPPORTED,"Transform kind is outside the bounded renderer slice");if(!span(values,64))return fail(RR_ARGUMENT,"Matrix pointer is out of bounds");
    for(unsigned i=0;i<16;i++)if(!std::isfinite(values[i]))return fail(RR_UNSUPPORTED,"Nonfinite matrices are outside this renderer profile");
    auto& matrix=kind>=RR_TEXTURE0?state.texMatrices[kind-RR_TEXTURE0]:kind==RR_WORLD?state.world:kind==RR_VIEW?state.view:state.projection;std::memcpy(&matrix,values,64);return RR_OK;
});}
EMSCRIPTEN_KEEPALIVE uint32_t rome_renderer_v1_set_viewport(uint32_t x,uint32_t y,uint32_t w,uint32_t h,float minZ,float maxZ){return operation([&]()->uint32_t{
    if(!ready())return status;if(!viewportFits(x,y,w,h,minZ,maxZ))return fail(RR_ARGUMENT,"Viewport exceeds backbuffer or depth range");state.viewport={x,y,w,h,minZ,maxZ};backend->setViewport(state.viewport);return backendResult();
});}
EMSCRIPTEN_KEEPALIVE uint32_t rome_renderer_v1_clear(uint32_t flags,uint32_t color,float depth,uint32_t stencil){return operation([&]()->uint32_t{
    if(!ready())return status;
    if(!flags||(flags&~7u)||!std::isfinite(depth)||depth<0||depth>1)return fail(RR_UNSUPPORTED,"Invalid clear flags or depth range");
    if((flags&6)&&!currentDepth)return fail(RR_ARGUMENT,"Selected render target has no depth-stencil attachment");
    backend->clear(flags&1,flags&2,flags&4,color,depth,stencil);return backendResult();
});}
EMSCRIPTEN_KEEPALIVE uint32_t rome_renderer_v1_draw(uint32_t primitive,uint32_t start,uint32_t count){return operation([&]{return draw(primitive,start,count,false);});}
EMSCRIPTEN_KEEPALIVE uint32_t rome_renderer_v1_draw_indexed(uint32_t primitive,uint32_t start,uint32_t count){return operation([&]{return draw(primitive,start,count,true);});}
EMSCRIPTEN_KEEPALIVE uint32_t rome_renderer_v1_present(){return operation([]()->uint32_t{if(!ready())return status;backend->present();if(backendResult())return status;presentedWidth=width;presentedHeight=height;return RR_OK;});}
EMSCRIPTEN_KEEPALIVE uint32_t rome_renderer_v1_read_pixels(void* data,uint32_t bytes){return operation([&]()->uint32_t{
    if(!ready())return status;if(uint64_t(width)*height*4>bytes||!span(data,bytes))return fail(RR_ARGUMENT,"Readback destination is too small");
#if ROME_RASTER_VALIDATED
    if(!backend->readPixelsRGBA8(data,bytes,true))return fail(RR_BACKEND,backend->lastError()?backend->lastError():"Readback failed");
#else
    return fail(RR_UNSUPPORTED,"Logical readback requires the validated raster backend");
#endif
    return backendResult();
});}
}
