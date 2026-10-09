/**
 * Slider shaders in both shading languages. Pixi binds the scene
 * transform automatically (GL: uniforms by name; WGSL: globalUniforms at
 * @group(0), localUniforms at @group(1)); our own resources live in
 * @group(2) in declaration order.
 *
 * Pass 1 (prepass) — rendered into a per-slider coverage texture with
 * MAX blending. Each fragment of a segment's quad writes
 * clamp(1 − distance-to-segment / radius); the max over all quads is the
 * distance to the whole path: an exact union of capsules.
 *
 * Pass 2 (composite) — one quad over the path bounds maps the coverage
 * through the gradient LUT (border, track, rim) and is drawn in the
 * playfield like any sprite. The LUT isn't monotonic, so colour must be
 * applied after the max, never blended with it.
 */

export const PREPASS_GLSL_VERTEX = /* glsl */ `
in vec2 aPosition;
in vec2 aSegA;
in vec2 aSegB;
out vec2 vPath;
out vec2 vSegA;
out vec2 vSegB;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
void main() {
    mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
    gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
    vPath = aPosition;
    vSegA = aSegA;
    vSegB = aSegB;
}`;

export const PREPASS_GLSL_FRAGMENT = /* glsl */ `
in vec2 vPath;
in vec2 vSegA;
in vec2 vSegB;
uniform float uRadius;
out vec4 finalColor;
float dstToLine(vec2 p, vec2 a, vec2 b) {
    vec2 dir = b - a;
    float len2 = dot(dir, dir);
    if (len2 < 1e-6) return distance(p, a);
    float t = clamp(dot(p - a, dir), 0.0, len2) / len2;
    return distance(p, a + dir * t);
}
void main() {
    float cov = clamp(1.0 - dstToLine(vPath, vSegA, vSegB) / uRadius, 0.0, 1.0);
    if (cov <= 0.0) discard;
    finalColor = vec4(cov);
}`;

export const PREPASS_WGSL = /* wgsl */ `
struct GlobalUniforms {
    uProjectionMatrix: mat3x3<f32>,
    uWorldTransformMatrix: mat3x3<f32>,
    uWorldColorAlpha: vec4<f32>,
    uResolution: vec2<f32>,
}
struct LocalUniforms {
    uTransformMatrix: mat3x3<f32>,
    uColor: vec4<f32>,
    uRound: f32,
}
struct PrepassUniforms {
    uRadius: f32,
}
@group(0) @binding(0) var<uniform> globalUniforms: GlobalUniforms;
@group(1) @binding(0) var<uniform> localUniforms: LocalUniforms;
@group(2) @binding(0) var<uniform> prepassUniforms: PrepassUniforms;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) vPath: vec2<f32>,
    @location(1) vSegA: vec2<f32>,
    @location(2) vSegB: vec2<f32>,
}

@vertex
fn mainVertex(
    @location(0) aPosition: vec2<f32>,
    @location(1) aSegA: vec2<f32>,
    @location(2) aSegB: vec2<f32>,
) -> VertexOutput {
    let mvp = globalUniforms.uProjectionMatrix * globalUniforms.uWorldTransformMatrix * localUniforms.uTransformMatrix;
    var out: VertexOutput;
    out.position = vec4<f32>((mvp * vec3<f32>(aPosition, 1.0)).xy, 0.0, 1.0);
    out.vPath = aPosition;
    out.vSegA = aSegA;
    out.vSegB = aSegB;
    return out;
}

fn dstToLine(p: vec2<f32>, a: vec2<f32>, b: vec2<f32>) -> f32 {
    let dir = b - a;
    let len2 = dot(dir, dir);
    if (len2 < 1e-6) {
        return distance(p, a);
    }
    let t = clamp(dot(p - a, dir), 0.0, len2) / len2;
    return distance(p, a + dir * t);
}

@fragment
fn mainFragment(
    @location(0) vPath: vec2<f32>,
    @location(1) vSegA: vec2<f32>,
    @location(2) vSegB: vec2<f32>,
) -> @location(0) vec4<f32> {
    let cov = clamp(1.0 - dstToLine(vPath, vSegA, vSegB) / prepassUniforms.uRadius, 0.0, 1.0);
    if (cov <= 0.0) {
        discard;
    }
    return vec4<f32>(cov, cov, cov, cov);
}`;

export const COMPOSITE_GLSL_VERTEX = /* glsl */ `
in vec2 aPosition;
in vec2 aUV;
in float aRow;
out vec2 vUV;
out float vRow;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
void main() {
    mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
    gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
    vUV = aUV;
    vRow = aRow;
}`;

export const COMPOSITE_GLSL_FRAGMENT = /* glsl */ `
in vec2 vUV;
in float vRow;
uniform sampler2D uCoverage;
uniform sampler2D uLut;
uniform vec4 uColor;
out vec4 finalColor;
void main() {
    float cov = texture(uCoverage, vUV).r;
    if (cov <= 0.0) discard;
    finalColor = uColor.a * texture(uLut, vec2(1.0 - cov, vRow));
}`;

export const COMPOSITE_WGSL = /* wgsl */ `
struct GlobalUniforms {
    uProjectionMatrix: mat3x3<f32>,
    uWorldTransformMatrix: mat3x3<f32>,
    uWorldColorAlpha: vec4<f32>,
    uResolution: vec2<f32>,
}
struct LocalUniforms {
    uTransformMatrix: mat3x3<f32>,
    uColor: vec4<f32>,
    uRound: f32,
}
@group(0) @binding(0) var<uniform> globalUniforms: GlobalUniforms;
@group(1) @binding(0) var<uniform> localUniforms: LocalUniforms;
@group(2) @binding(0) var uCoverage: texture_2d<f32>;
@group(2) @binding(1) var uCoverageSampler: sampler;
@group(2) @binding(2) var uLut: texture_2d<f32>;
@group(2) @binding(3) var uLutSampler: sampler;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) vUV: vec2<f32>,
    @location(1) vRow: f32,
}

@vertex
fn mainVertex(@location(0) aPosition: vec2<f32>, @location(1) aUV: vec2<f32>, @location(2) aRow: f32) -> VertexOutput {
    let mvp = globalUniforms.uProjectionMatrix * globalUniforms.uWorldTransformMatrix * localUniforms.uTransformMatrix;
    var out: VertexOutput;
    out.position = vec4<f32>((mvp * vec3<f32>(aPosition, 1.0)).xy, 0.0, 1.0);
    out.vUV = aUV;
    out.vRow = aRow;
    return out;
}

@fragment
fn mainFragment(@location(0) vUV: vec2<f32>, @location(1) vRow: f32) -> @location(0) vec4<f32> {
    let cov = textureSample(uCoverage, uCoverageSampler, vUV).r;
    let lut = textureSample(uLut, uLutSampler, vec2<f32>(1.0 - cov, vRow));
    if (cov <= 0.0) {
        discard;
    }
    return localUniforms.uColor.a * lut;
}`;
