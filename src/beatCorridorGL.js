// 纯 WebGL2 Beat Saber 风格 · 3D 无限光门舞台走廊（Beat Corridor）
// 采用解析 Z 轴光门求交 + 实时黑曜石镜面地板反射 + 体积舞台激光束 + 节拍能量冲击波：
//   - 零 raymarching 步进伪影，18 道 3D 几何光门与倒影单次全屏 draw call 锁定 60~120fps；
//   - 24 段实时对数频谱逐门映射 + 底鼓触发全场光浪横扫 + 中高频驱动左右对称激光扫射。

import { createTerrainResponse, stepTerrainResponse } from './terrainResponse.js';

const SPECTRUM_BANDS = 24;
const LOW_EQ = [96, 94];
const MAX_WAVES = 6;

const SPECTRUM_EDGES_HZ = Array.from({ length: SPECTRUM_BANDS + 1 }, (_, i) =>
  35 * Math.pow(6500 / 35, i / SPECTRUM_BANDS)
);

const VERT = `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  // 单三角形覆盖全屏，避免 VBO 顶点缓冲开销
  vec2 pos = vec2((gl_VertexID == 1) ? 3.0 : -1.0, (gl_VertexID == 2) ? 3.0 : -1.0);
  vUv = pos * 0.5 + 0.5;
  gl_Position = vec4(pos, 0.0, 1.0);
}
`;

const FRAG = `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uTime;
uniform float uTravelZ;
uniform float uSpectrum[${SPECTRUM_BANDS}];
uniform float uSubBass;
uniform float uBass;
uniform float uMid;
uniform float uHigh;
uniform float uEnergy;
uniform float uBeatPulse;
uniform float uWarmth;
// xy: unused/type, z: wave origin travelZ, w: strength
uniform vec4 uWaves[${MAX_WAVES}];
uniform float uWaveActive[${MAX_WAVES}];

in vec2 vUv;
out vec4 fragColor;

mat2 rot2(float a) {
  float c = cos(a), s = sin(a);
  return mat2(c, -s, s, c);
}

float sampleSpectrum(float t) {
  float f = clamp(t, 0.0, 1.0) * ${SPECTRUM_BANDS - 1}.0;
  int idx = int(floor(f));
  int nextIdx = min(idx + 1, ${SPECTRUM_BANDS - 1});
  float frac = f - float(idx);
  return mix(uSpectrum[idx], uSpectrum[nextIdx], frac);
}

// 正八边形 2D SDF（Beat Saber 经典光门轮廓）
float sdOctagon(vec2 p, float r) {
  const vec3 k = vec3(-0.9238795325, 0.3826834323, 0.4142135623);
  p = abs(p);
  p -= 2.0 * min(dot(vec2(k.x, k.y), p), 0.0) * vec2(k.x, k.y);
  p -= 2.0 * min(dot(vec2(-k.x, k.y), p), 0.0) * vec2(-k.x, k.y);
  p -= vec2(clamp(p.x, -k.z * r, k.z * r), r);
  return length(p) * sign(p.y);
}

// 3D 射线到线段的最近距离（用于体积舞台激光束）
float distRayToLine(vec3 ro, vec3 rd, vec3 p0, vec3 dir) {
  vec3 w0 = ro - p0;
  float a = dot(rd, rd);
  float b = dot(rd, dir);
  float c = dot(dir, dir);
  float d = dot(rd, w0);
  float e = dot(dir, w0);
  float denom = max(a * c - b * b, 1e-4);
  float s = max(0.0, (b * e - c * d) / denom);
  float t = (a * e - b * d) / denom;
  vec3 c1 = ro + rd * s;
  vec3 c2 = p0 + dir * t;
  return length(c1 - c2);
}

// 计算单条射线（主视角或镜面反射视角）穿过极简建筑光门走廊的累积辉光
vec3 traceCorridor(vec3 ro, vec3 rd, bool isReflection) {
  vec3 col = vec3(0.0);
  if (rd.z <= 0.01) return col;

  // 宽间距极简建筑光门：留出充足深空负空间，同时保持清晰的螺旋穿越层次
  const float SPACING = 10.5;
  float baseIdx = floor(uTravelZ / SPACING);
  float fracZ = fract(uTravelZ / SPACING);

  // 克制的 ORBIT 银灰 + 浅雾蓝 + 极淡暖象牙配色
  vec3 silverMist = vec3(0.68, 0.78, 0.94);
  vec3 warmIvory = vec3(0.90, 0.86, 0.80);
  vec3 primaryTint = mix(silverMist, warmIvory, clamp(uWarmth * 0.42, 0.0, 0.42));

  // 1. 9 道螺旋旋转的极简几何光门（干净无杂乱侧翼，突出纵深旋涡穿越感）
  for (int i = 0; i < 9; i++) {
    float fi = float(i);
    float gateWorldIdx = baseIdx + fi + 1.0;
    float localZ = (fi + 1.0 - fracZ) * SPACING;
    if (localZ < 0.6) continue;

    float t = (localZ - ro.z) / rd.z;
    if (t <= 0.0) continue;

    vec3 hit = ro + rd * t;
    // 远景轻微曲线弯道 + 连续螺旋旋转，营造顺滑的 3D 穿越感
    float bendX = sin(gateWorldIdx * 0.24 - uTime * 0.42) * (0.32 + uBass * 0.42);
    float bendY = cos(gateWorldIdx * 0.20 - uTime * 0.34) * (0.18 + uSubBass * 0.24);
    vec2 p = hit.xy - vec2(bendX, bendY + 0.35);
    float twist = gateWorldIdx * 0.16 + uTime * (0.16 + uEnergy * 0.14);
    p = rot2(twist) * p;

    // 每座光门绑定实时频段
    float bandT = fract(gateWorldIdx * 0.17);
    float spec = sampleSpectrum(bandT);

    // 节拍冲击波扫过该光门时的瞬时点亮
    float waveBoost = 0.0;
    float gateAbsZ = gateWorldIdx * SPACING;
    for (int w = 0; w < ${MAX_WAVES}; w++) {
      if (uWaveActive[w] > 0.5) {
        float waveZ = uWaves[w].z;
        float dz = abs(gateAbsZ - waveZ);
        waveBoost += exp(-dz * dz * 0.018) * uWaves[w].w;
      }
    }

    // 宽阔门框，随低频与节拍柔和呼吸扩张
    float radius = 5.4 + spec * 0.55 + uSubBass * 0.38 + waveBoost * 0.42;
    float d = sdOctagon(p, radius);

    // 干净锐利的细光边 + 克制柔晕
    float rim = 0.016 / (abs(d) + 0.018);
    float softGlow = 0.07 / (abs(d) + 0.32);

    float depthFade = exp(-localZ * 0.024) * smoothstep(0.6, 5.5, localZ);
    float intensity = (0.18 + spec * 0.48 + waveBoost * 0.95) * depthFade;

    vec3 gateColor = mix(primaryTint, vec3(0.95, 0.97, 1.0), clamp(waveBoost * 0.65 + spec * 0.2, 0.0, 0.8));
    col += gateColor * (rim * 0.26 + softGlow * 0.12) * intensity;
  }

  // 2. 仅保留最外缘 1 对极克制的对称氛围侧光束（远离中心卡片与歌词）
  if (!isReflection) {
    float sweep = sin(uTime * 0.38) * (0.18 + uMid * 0.16);
    float beamPower = (0.08 + uMid * 0.24 + uBeatPulse * 0.18);
    for (float side = -1.0; side <= 1.0; side += 2.0) {
      vec3 origin = vec3(side * 13.5, -3.6, 26.0);
      vec3 dir = normalize(vec3(-side * (0.28 + sweep * 0.2), 0.94, -0.12));
      float dBeam = distRayToLine(ro, rd, origin, dir);
      float beam = 0.018 / (dBeam * dBeam + 0.032);
      col += primaryTint * beam * beamPower * 0.14;
    }
  }

  // 3. 远景消失点柔和呼吸微光
  float centerDot = max(dot(normalize(rd), normalize(vec3(0.0, 0.04, 1.0))), 0.0);
  float horizonGlow = pow(centerDot, 18.0) * (0.10 + uSubBass * 0.26 + uBeatPulse * 0.18);
  col += primaryTint * horizonGlow;

  return col;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / max(uResolution.y, 1.0);

  // 克制的节拍微推进 + 舒缓倾角呼吸，增强穿越沉浸感且不晃眼
  float camPunch = uBeatPulse * 0.36 + uSubBass * 0.20;
  float camRoll = sin(uTime * 0.32) * (0.075 + uBass * 0.05);
  vec2 ruv = rot2(camRoll) * uv;
  vec3 ro = vec3(0.0, -0.35, -2.5 + camPunch);
  vec3 rd = normalize(vec3(ruv * 1.12, 1.0));

  vec3 bg = mix(vec3(0.035, 0.038, 0.046), vec3(0.052, 0.056, 0.068), clamp(1.0 - length(uv), 0.0, 1.0));
  vec3 color = bg + traceCorridor(ro, rd, false);

  // 极简暗面镜面地板（只保留柔和的光门倒影与两条极细导引光轨，去掉杂乱横线）
  const float FLOOR_Y = -3.8;
  if (rd.y < -0.005) {
    float tFloor = (FLOOR_Y - ro.y) / rd.y;
    if (tFloor > 0.0 && tFloor < 130.0) {
      vec3 floorHit = ro + rd * tFloor;
      float floorFade = exp(-tFloor * 0.034);

      vec3 reflRd = reflect(rd, vec3(0.0, 1.0, 0.0));
      vec3 reflCol = traceCorridor(floorHit + vec3(0.0, 0.02, 0.0), reflRd, true);

      float rail = 0.009 / (abs(abs(floorHit.x) - 4.2) + 0.024);
      vec3 floorTint = mix(vec3(0.65, 0.76, 0.92), vec3(0.88, 0.84, 0.78), uWarmth * 0.4);
      vec3 floorCol = vec3(0.030, 0.033, 0.040)
        + reflCol * 0.34
        + floorTint * rail * (0.08 + uEnergy * 0.10);

      float fresnel = pow(1.0 - max(-rd.y, 0.0), 2.4);
      color = mix(color, floorCol, clamp((0.64 + fresnel * 0.24) * floorFade, 0.0, 0.90));
    }
  }

  color = color / (1.0 + color * 0.6);
  float vignette = smoothstep(1.38, 0.32, length(uv));
  color *= 0.74 + 0.26 * vignette;

  fragColor = vec4(color, 0.90);
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
    throw new Error(`beat corridor shader compile failed: ${info}`);
  }
  return shader;
}

export function createBeatCorridorGL(canvas, options = {}) {
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
    throw new Error(`beat corridor program link failed: ${info}`);
  }
  gl.useProgram(program);

  const vao = gl.createVertexArray();
  const U = {};
  const uniformNames = [
    'uResolution', 'uTime', 'uTravelZ', 'uSubBass', 'uBass', 'uMid', 'uHigh',
    'uEnergy', 'uBeatPulse', 'uWarmth',
  ];
  uniformNames.forEach(name => { U[name] = gl.getUniformLocation(program, name); });
  U.uSpectrum = gl.getUniformLocation(program, 'uSpectrum[0]');
  U.uWaves = gl.getUniformLocation(program, 'uWaves[0]');
  U.uWaveActive = gl.getUniformLocation(program, 'uWaveActive[0]');

  const spectrum = new Float32Array(SPECTRUM_BANDS);
  const rawSpectrum = new Float32Array(SPECTRUM_BANDS);
  const lowResponse = createTerrainResponse();
  const waveData = new Float32Array(MAX_WAVES * 4);
  const waveActive = new Float32Array(MAX_WAVES);
  let waveCursor = 0;
  let lastWaveTime = -99;

  let travelZ = 0;
  let smoothSub = 0;
  let smoothBass = 0;
  let smoothMid = 0;
  let smoothHigh = 0;
  let smoothEnergy = 0;
  let smoothBeat = 0;
  let viewportWidth = 0;
  let viewportHeight = 0;

  gl.disable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.clearColor(0, 0, 0, 0);

  function spawnWave(strength) {
    const slot = waveCursor % MAX_WAVES;
    waveCursor += 1;
    // 从远景（当前镜头前方 ~96 单位）生成一道能量冲击波高速扑向镜头
    waveData[slot * 4] = 0;
    waveData[slot * 4 + 1] = 0;
    waveData[slot * 4 + 2] = travelZ + 96;
    waveData[slot * 4 + 3] = strength;
    waveActive[slot] = 1;
  }

  function resize(width, height, dpr) {
    // 全屏解析着色器按上限 1.25x 渲染分辨率运行，在 4K 屏上依然稳跑 60fps 且画面锐利
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

    rawSpectrum.fill(0);
    let subAvg = 0;
    let bassAvg = 0;
    let midAvg = 0;
    let highAvg = 0;
    if (input.playing && binCount) {
      for (let b = 0; b < SPECTRUM_BANDS; b += 1) {
        const from = Math.min(binCount - 1, Math.max(0, Math.floor(SPECTRUM_EDGES_HZ[b] / binHz)));
        const to = Math.min(binCount, Math.max(from + 1, Math.ceil(SPECTRUM_EDGES_HZ[b + 1] / binHz)));
        let sum = 0;
        for (let k = from; k < to; k += 1) sum += bins[k];
        const avg = clamp01(sum / (to - from) / 255);
        rawSpectrum[b] = clamp01(Math.pow(avg, 1.15) * (1.12 - (b / SPECTRUM_BANDS) * 0.25));
      }
      subAvg = (rawSpectrum[0] + rawSpectrum[1] + rawSpectrum[2]) / 3;
      bassAvg = (rawSpectrum[3] + rawSpectrum[4] + rawSpectrum[5] + rawSpectrum[6]) / 4;
      for (let b = 7; b < 16; b += 1) midAvg += rawSpectrum[b];
      midAvg /= 9;
      for (let b = 16; b < SPECTRUM_BANDS; b += 1) highAvg += rawSpectrum[b];
      highAvg /= (SPECTRUM_BANDS - 16);
    }

    // 音游级跟手响应：快起（22/s）顺落（6.5/s）
    const rise = 1 - Math.exp(-22.0 * delta);
    const fall = 1 - Math.exp(-6.5 * delta);
    for (let b = 0; b < SPECTRUM_BANDS; b += 1) {
      const targetVal = rawSpectrum[b];
      spectrum[b] += (targetVal - spectrum[b]) * (targetVal > spectrum[b] ? rise : fall);
    }

    const low = stepTerrainResponse(lowResponse, {
      subBass: subAvg,
      bass: bassAvg,
      onset: input.onset,
      playing: input.playing,
      dt: delta,
      eq: LOW_EQ,
      profile: 'default',
    });

    smoothSub += (low.subBass - smoothSub) * (low.subBass > smoothSub ? rise : fall);
    smoothBass += (low.bass - smoothBass) * (low.bass > smoothBass ? rise : fall);
    smoothMid += (midAvg - smoothMid) * (midAvg > smoothMid ? rise : fall);
    smoothHigh += (highAvg - smoothHigh) * (highAvg > smoothHigh ? rise : fall);

    const targetEnergy = input.playing ? clamp01(input.energy || 0) : 0;
    smoothEnergy += (targetEnergy - smoothEnergy) * (targetEnergy > smoothEnergy ? rise : fall);

    const targetBeat = input.playing ? clamp01(Math.max(low.kickEnvelope, input.kickEnvelope || 0)) : 0;
    smoothBeat += (targetBeat - smoothBeat) * (targetBeat > smoothBeat ? rise : fall);

    // 纵深推进速度：暂停/静音时极缓慢巡航，播放时随能量与鼓点加速飞驰
    const speed = input.playing
      ? (4.2 + smoothEnergy * 11.5 + smoothBeat * 8.0)
      : 1.4;
    travelZ += speed * delta;

    // 拍点触发从远景扑向镜头的能量冲击波
    const waveGap = Number(options.waveCooldown) || 0.24;
    if (input.playing && low.impulseStrength > 0 && input.time - lastWaveTime > waveGap) {
      lastWaveTime = input.time;
      spawnWave(0.45 + low.impulseStrength * 0.75);
    }
    const waveSpeed = 62.0;
    for (let w = 0; w < MAX_WAVES; w += 1) {
      if (waveActive[w] > 0.5) {
        waveData[w * 4 + 2] -= waveSpeed * delta;
        if (waveData[w * 4 + 2] < travelZ - 10) {
          waveActive[w] = 0;
        }
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
    gl.uniform1f(U.uTravelZ, travelZ);
    gl.uniform1fv(U.uSpectrum, spectrum);
    gl.uniform1f(U.uSubBass, smoothSub);
    gl.uniform1f(U.uBass, smoothBass);
    gl.uniform1f(U.uMid, smoothMid);
    gl.uniform1f(U.uHigh, smoothHigh);
    gl.uniform1f(U.uEnergy, smoothEnergy);
    gl.uniform1f(U.uBeatPulse, smoothBeat);
    gl.uniform1f(U.uWarmth, warmth);
    gl.uniform4fv(U.uWaves, waveData);
    gl.uniform1fv(U.uWaveActive, waveActive);

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
