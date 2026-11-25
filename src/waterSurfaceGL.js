// 纯 WebGL2 3D 镜面水波（Obsidian Moonlit Water）
// 无任何网格与方块：解析 3D 射线-水面求交 + 多层动态水波法线 + 真实菲涅尔与月光碎影反光。
// - 低频/鼓点在湖心激起宽阔深沉的同心涟漪与涌浪；
// - 钢琴/人声瞬态在湖面轻点出细腻的雨滴波纹；
// - 每一圈波纹穿过月光倒影路径时泛起克制而真实的银白/暖象牙碎光。

import { createTerrainResponse, stepTerrainResponse } from './terrainResponse.js';

const LOW_EQ = [96, 94];
const MAX_RIPPLES = 12;

const VERT = `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  vec2 pos = vec2((gl_VertexID == 1) ? 3.0 : -1.0, (gl_VertexID == 2) ? 3.0 : -1.0);
  vUv = pos * 0.5 + 0.5;
  gl_Position = vec4(pos, 0.0, 1.0);
}
`;

const FRAG = `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uTime;
uniform float uSubBass;
uniform float uBass;
uniform float uMid;
uniform float uHigh;
uniform float uEnergy;
uniform float uBeatPulse;
uniform float uWarmth;
// xy: ripple center xz, z: spawn time, w: strength
uniform vec4 uRipples[${MAX_RIPPLES}];
// x: active (>0.5), y: speed/scale (0=bass ring, 1=piano/vocal raindrop)
uniform vec2 uRippleMeta[${MAX_RIPPLES}];

in vec2 vUv;
out vec4 fragColor;

// 快速平滑 2D 噪声（用于自然微风细浪）
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// 计算水面某一点 (x, z) 的瞬时高度（微风细浪 + 低频长涌 + 12 圈实时音符/鼓点同心涟漪）
float waterHeight(vec2 p) {
  // 1. 轻柔微风细浪（保证静音/慢歌时水面依然有真实液态微颤）
  vec2 w1 = p * 0.24 + vec2(uTime * 0.28, -uTime * 0.22);
  vec2 w2 = p * 0.48 + vec2(-uTime * 0.35, uTime * 0.30);
  float wind = (vnoise(w1) - 0.5) * 0.14 + (vnoise(w2) - 0.5) * 0.065;
  wind += sin(p.x * 0.32 + p.y * 0.18 - uTime * 0.75) * 0.045;

  // 2. 低频驱动的暗海长涌（随 Sub-Bass 与 Bass 舒展起伏）
  float swell = sin(p.y * 0.19 - uTime * (0.95 + uEnergy * 0.55) + sin(p.x * 0.11) * 1.2)
    * (0.05 + uSubBass * 0.28 + uBass * 0.18);

  // 3. 音乐拍点 / 琴键触发的真实同心水波纹
  float ripples = 0.0;
  for (int i = 0; i < ${MAX_RIPPLES}; i++) {
    if (uRippleMeta[i].x > 0.5) {
      float age = max(0.0, uTime - uRipples[i].z);
      bool isDrop = uRippleMeta[i].y > 0.5;
      float speed = isDrop ? 7.8 : 11.2;
      float freq = isDrop ? 2.8 : 1.75;
      float width = isDrop ? 3.4 : 8.5;
      float decay = isDrop ? 0.85 : 0.48;

      float dist = length(p - uRipples[i].xy);
      float radius = age * speed;
      float d = dist - radius;
      float packet = exp(-(d * d) / width) * exp(-age * decay);
      // 距离波心极近处稍微平滑避免中心奇点
      float ring = cos(d * freq) * packet * smoothstep(0.0, 0.8, dist + 0.2);
      ripples += ring * uRipples[i].w * (isDrop ? 0.19 : 0.36);
    }
  }

  return wind + swell + ripples;
}

// 渲染夜空与地平线月晕（天空和倒影共用，保证物理反射一致）
vec3 evalSky(vec3 dir) {
  float elev = clamp(dir.y, 0.0, 1.0);
  vec3 zenith = vec3(0.026, 0.030, 0.040);
  vec3 horizon = vec3(0.072, 0.082, 0.106);
  vec3 sky = mix(horizon, zenith, pow(elev, 0.55));

  // 柔和月光/星云地平线光晕（随低频与能量呼吸）
  vec3 moonDir = normalize(vec3(0.0, 0.21, 1.0));
  float moonDot = max(dot(dir, moonDir), 0.0);

  vec3 coolMoon = vec3(0.76, 0.84, 0.98);
  vec3 warmMoon = vec3(0.95, 0.89, 0.80);
  vec3 moonTint = mix(coolMoon, warmMoon, clamp(uWarmth * 0.45, 0.0, 0.45));

  float moonGlow = pow(moonDot, 10.0) * (0.16 + uSubBass * 0.24 + uBeatPulse * 0.14);
  float moonCore = pow(moonDot, 180.0) * (0.42 + uEnergy * 0.28);
  float horizonBand = exp(-elev * 7.5) * (0.08 + uBass * 0.10);

  sky += moonTint * (moonGlow + moonCore + horizonBand);
  return sky;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / max(uResolution.y, 1.0);

  // 摄像机低伏掠过广阔黑曜石湖面，地平线略微偏上，让水波与月光倒影铺满主体区域
  vec3 ro = vec3(0.0, 5.6 + uSubBass * 0.25, -24.0);
  vec3 rd = normalize(vec3(uv.x * 1.15, uv.y * 1.15 - 0.16, 1.0));

  vec3 color = evalSky(rd);

  if (rd.y < -0.002) {
    float t = -ro.y / rd.y;
    if (t > 0.0 && t < 240.0) {
      vec3 hit = ro + rd * t;
      vec2 xz = hit.xz;

      // 随距离轻微放大采样步长，消除远处水面锯齿闪烁
      float eps = clamp(0.08 + t * 0.0035, 0.08, 0.45);
      float hL = waterHeight(xz - vec2(eps, 0.0));
      float hR = waterHeight(xz + vec2(eps, 0.0));
      float hD = waterHeight(xz - vec2(0.0, eps));
      float hU = waterHeight(xz + vec2(0.0, eps));
      vec3 N = normalize(vec3(hL - hR, 2.0 * eps, hD - hU));

      vec3 V = -rd;
      vec3 R = reflect(rd, N);
      R.y = abs(R.y); // 防止极端掠射角反射向下穿透

      // Schlick 菲涅尔反射系数
      float ndotv = max(dot(N, V), 0.0);
      float fresnel = 0.05 + 0.95 * pow(1.0 - ndotv, 4.2);

      // 深邃黑曜石水体底色 + 天空倒影
      vec3 deepWater = vec3(0.022, 0.026, 0.034);
      vec3 skyRefl = evalSky(R);

      // 月光高光碎影（水面波纹切割月光形成的标志性银白星芒）
      vec3 moonDir = normalize(vec3(0.0, 0.21, 1.0));
      vec3 H = normalize(moonDir + V);
      float ndoth = max(dot(N, H), 0.0);
      float glitterSharp = pow(ndoth, 220.0) * (1.35 + uEnergy * 0.75 + uBeatPulse * 0.55);
      float glitterSoft = pow(ndoth, 28.0) * (0.20 + uSubBass * 0.22);

      vec3 coolTint = vec3(0.78, 0.86, 1.0);
      vec3 warmTint = vec3(0.96, 0.90, 0.82);
      vec3 specTint = mix(coolTint, warmTint, clamp(uWarmth * 0.45, 0.0, 0.45));

      // 波纹脊背微光：让非月光路径上的涟漪也带有克制的银灰液态轮廓
      float slope = clamp(length(N.xz) * 2.2, 0.0, 1.0);
      vec3 waterCol = mix(deepWater, skyRefl * 1.18, clamp(fresnel * 0.92, 0.0, 0.95));
      waterCol += specTint * (glitterSharp + glitterSoft + slope * (0.09 + uMid * 0.14));

      // 远处雾化平滑融入地平线夜空
      float fog = exp(-t * 0.0155);
      vec3 horizonFog = evalSky(normalize(vec3(rd.x, 0.01, rd.z)));
      color = mix(horizonFog, waterCol, fog);
    }
  }

  // 柔和色调映射与边缘轻暗角，确保专辑封面卡片与歌词清晰突出
  color = color / (1.0 + color * 0.58);
  float vignette = smoothstep(1.42, 0.35, length(uv));
  color *= 0.76 + 0.24 * vignette;

  fragColor = vec4(color, 0.94);
}
`;

function clamp01(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`water shader compile failed: ${info}`);
  }
  return shader;
}

export function createWaterSurfaceGL(canvas, options = {}) {
  const mobile = !!options.mobile;
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    antialias: false,
    premultipliedAlpha: false,
    powerPreference: 'high-performance',
  });
  if (!gl || gl.isContextLost?.() === true) return null;

  const program = gl.createProgram();
  const vertShader = compileShader(gl, gl.VERTEX_SHADER, VERT);
  const fragShader = compileShader(gl, gl.FRAGMENT_SHADER, FRAG);
  gl.attachShader(program, vertShader);
  gl.attachShader(program, fragShader);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program);
    gl.detachShader?.(program, vertShader);
    gl.detachShader?.(program, fragShader);
    gl.deleteShader?.(vertShader);
    gl.deleteShader?.(fragShader);
    gl.deleteProgram?.(program);
    throw new Error(`water program link failed: ${info}`);
  }
  gl.useProgram(program);

  const vao = gl.createVertexArray();
  const U = {};
  const uniformNames = [
    'uResolution', 'uTime', 'uSubBass', 'uBass', 'uMid', 'uHigh',
    'uEnergy', 'uBeatPulse', 'uWarmth',
  ];
  uniformNames.forEach(name => { U[name] = gl.getUniformLocation(program, name); });
  U.uRipples = gl.getUniformLocation(program, 'uRipples[0]');
  U.uRippleMeta = gl.getUniformLocation(program, 'uRippleMeta[0]');

  const rippleData = new Float32Array(MAX_RIPPLES * 4);
  const rippleMeta = new Float32Array(MAX_RIPPLES * 2);
  let rippleCursor = 0;
  let lastBeatRippleTime = -99;
  let lastDropRippleTime = -99;

  const lowResponse = createTerrainResponse();
  let smoothSub = 0;
  let smoothBass = 0;
  let smoothMid = 0;
  let smoothHigh = 0;
  let smoothEnergy = 0;
  let smoothBeat = 0;
  let prevMid = 0;
  let viewportWidth = 0;
  let viewportHeight = 0;

  gl.disable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.clearColor(0, 0, 0, 0);

  function spawnRipple(x, z, time, strength, isDrop) {
    const slot = rippleCursor % MAX_RIPPLES;
    rippleCursor += 1;
    rippleData[slot * 4] = x;
    rippleData[slot * 4 + 1] = z;
    rippleData[slot * 4 + 2] = time;
    rippleData[slot * 4 + 3] = strength;
    rippleMeta[slot * 2] = 1;
    rippleMeta[slot * 2 + 1] = isDrop ? 1 : 0;
  }

  function resize(width, height, dpr) {
    const effectiveDpr = Math.max(0.75, Math.min(mobile ? 1.0 : 1.25, Number(dpr) || 1));
    const w = Math.max(1, Math.round(width * effectiveDpr));
    const h = Math.max(1, Math.round(height * effectiveDpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    if (w !== viewportWidth || h !== viewportHeight) {
      viewportWidth = w;
      viewportHeight = h;
      gl.viewport(0, 0, w, h);
    }
  }

  function frame(input) {
    const delta = Math.max(0, Math.min(0.1, Number.isFinite(input.dt) ? input.dt : 1 / 60));
    const bins = input.bins;
    const binCount = bins ? bins.length : 0;
    const binHz = (input.sampleRate || 44100) / (binCount * 2 || 1024);

    let subRaw = 0;
    let bassRaw = 0;
    let midRaw = 0;
    let highRaw = 0;
    if (input.playing && binCount) {
      const bandAvg = (loHz, hiHz) => {
        const from = Math.min(binCount - 1, Math.max(0, Math.floor(loHz / binHz)));
        const to = Math.min(binCount, Math.max(from + 1, Math.ceil(hiHz / binHz)));
        let sum = 0;
        for (let k = from; k < to; k += 1) sum += bins[k];
        return clamp01(sum / (to - from) / 255);
      };
      subRaw = bandAvg(30, 90);
      bassRaw = bandAvg(90, 260);
      midRaw = bandAvg(260, 2200);
      highRaw = bandAvg(2200, 8000);
    }

    const low = stepTerrainResponse(lowResponse, {
      subBass: subRaw,
      bass: bassRaw,
      onset: input.onset,
      playing: input.playing,
      dt: delta,
      eq: LOW_EQ,
      profile: 'default',
    });

    const rise = 1 - Math.exp(-16.0 * delta);
    const fall = 1 - Math.exp(-4.8 * delta);
    smoothSub += (low.subBass - smoothSub) * (low.subBass > smoothSub ? rise : fall);
    smoothBass += (low.bass - smoothBass) * (low.bass > smoothBass ? rise : fall);
    smoothMid += (midRaw - smoothMid) * (midRaw > smoothMid ? rise : fall);
    smoothHigh += (highRaw - smoothHigh) * (highRaw > smoothHigh ? rise : fall);

    const targetEnergy = input.playing ? clamp01(input.energy || 0) : 0;
    smoothEnergy += (targetEnergy - smoothEnergy) * (targetEnergy > smoothEnergy ? rise : fall);

    const targetBeat = input.playing ? clamp01(Math.max(low.kickEnvelope, input.kickEnvelope || 0)) : 0;
    smoothBeat += (targetBeat - smoothBeat) * (targetBeat > smoothBeat ? rise : fall);

    // 1. 低频/鼓点在湖心附近激起宽阔同心涟漪（降低高频触发，每圈涟漪从容散开）
    const beatGap = Number(options.beatRippleCooldown) || 0.95;
    if (input.playing && low.impulseStrength > 0.14 && input.time - lastBeatRippleTime > beatGap) {
      lastBeatRippleTime = input.time;
      const rx = (Math.random() - 0.5) * 14;
      const rz = -4 + Math.random() * 20;
      spawnRipple(rx, rz, input.time, 0.45 + low.impulseStrength * 0.65, false);
    }

    // 2. 钢琴/人声明显起音时偶尔落下一滴细腻雨滴波纹，避免密集刷屏
    const midRise = midRaw - prevMid;
    prevMid = midRaw;
    const dropGap = Number(options.dropRippleCooldown) || 1.4;
    if (input.playing && (midRise > 0.085 || (input.onsetHigh || 0) > 0.55) && input.time - lastDropRippleTime > dropGap) {
      lastDropRippleTime = input.time;
      const rx = (Math.random() - 0.5) * 30;
      const rz = -8 + Math.random() * 34;
      const power = clamp01(0.3 + midRise * 3.2 + (input.onsetHigh || 0) * 0.32);
      spawnRipple(rx, rz, input.time, power, true);
    }

    // 清理衰减完毕的水波
    for (let i = 0; i < MAX_RIPPLES; i += 1) {
      if (rippleMeta[i * 2] > 0.5 && input.time - rippleData[i * 4 + 2] > 9.0) {
        rippleMeta[i * 2] = 0;
      }
    }

    const lowSum = smoothSub + smoothBass + smoothMid;
    const totalSum = lowSum + smoothHigh;
    const warmth = totalSum > 0.001 ? clamp01(lowSum / totalSum) : 0.45;

    gl.useProgram?.(program);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform2f(U.uResolution, viewportWidth || canvas.width || 1, viewportHeight || canvas.height || 1);
    gl.uniform1f(U.uTime, input.time);
    gl.uniform1f(U.uSubBass, smoothSub);
    gl.uniform1f(U.uBass, smoothBass);
    gl.uniform1f(U.uMid, smoothMid);
    gl.uniform1f(U.uHigh, smoothHigh);
    gl.uniform1f(U.uEnergy, smoothEnergy);
    gl.uniform1f(U.uBeatPulse, smoothBeat);
    gl.uniform1f(U.uWarmth, warmth);
    gl.uniform4fv(U.uRipples, rippleData);
    gl.uniform2fv(U.uRippleMeta, rippleMeta);

    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  let disposed = false;

  return {
    resize,
    frame,
    dispose({ loseContext = false } = {}) {
      if (disposed) return;
      disposed = true;
      gl.useProgram?.(null);
      gl.bindVertexArray?.(null);
      gl.deleteVertexArray?.(vao);
      gl.detachShader?.(program, vertShader);
      gl.detachShader?.(program, fragShader);
      gl.deleteShader?.(vertShader);
      gl.deleteShader?.(fragShader);
      gl.deleteProgram?.(program);
      if (loseContext) {
        gl.getExtension?.('WEBGL_lose_context')?.loseContext?.();
      }
    },
  };
}
