// 地形专用低频包络。BeatEngine.hit 是检测强度，不能直接当成原作的 kickEnvelope：
// 它一触发就有 0.45~1，再乘低频 EQ 会把所有拍子压成同一个最大柱高。
export const LOW_BAND_LIMITS = [1.2, 1.15];

export const TERRAIN_RESPONSE_PROFILES = {
  default: {
    attackRate: 42,
    releaseRate: 11.5,
    baseGain: [0.22, 0.2],
    energyPower: 1.4,
    floorRise: 1.15,
    floorFall: 0.35,
    onsetScale: 1,
    pulseGain: 0.85,
    pulseCurve: 2,
  },
  // 面向柔和/抒情曲目的低频慢波：更平缓的起振与更长释放尾音，
  // 强化持续低频呼吸感、弱化瞬态尖峰，让无重鼓点的慢歌也能顺滑起伏。
  gentle: {
    attackRate: 7.5,
    releaseRate: 2.6,
    baseGain: [0.46, 0.42],
    energyPower: 1.08,
    floorRise: 0.65,
    floorFall: 0.22,
    onsetScale: 0.36,
    pulseGain: 0.58,
    pulseCurve: 1.45,
  },
};

const finite = value => Number.isFinite(value) ? value : 0;
const unit = value => Math.max(0, Math.min(1, finite(value)));

export function createTerrainResponse() {
  return { noiseFloor: 0, impulse: 0, envelope: 0 };
}

export function stepTerrainResponse(state, {
  subBass = 0, bass = 0, onset = 0, playing = false, dt = 1 / 60,
  eq = [90, 92], profile = 'default',
} = {}) {
  const cfg = TERRAIN_RESPONSE_PROFILES[profile] || TERRAIN_RESPONSE_PROFILES.default;
  const delta = Math.max(0, finite(dt));
  const energies = playing ? [unit(subBass), unit(bass)] : [0, 0];
  const lowLevel = energies[0] * 0.6 + energies[1] * 0.4;
  const kickLevel = Math.max(0, lowLevel - state.noiseFloor - 0.025);
  const floorRate = lowLevel > state.noiseFloor ? cfg.floorRise : cfg.floorFall;
  state.noiseFloor += (lowLevel - state.noiseFloor) * (1 - Math.exp(-floorRate * delta));

  // 新拍只是激励，不是最终柱高。实际频谱电平决定冲击大小，检测强度只作权重；
  // 持续的低音仍通过下方 baseline 呼吸，但不会每帧重新激励鼓点。
  const impulseStrength = playing && onset > 0
    ? unit(onset) * (0.12 + 0.55 * lowLevel ** 2 + 0.3 * kickLevel) * cfg.onsetScale
    : 0;
  state.impulse = Math.max(state.impulse, impulseStrength);

  // 使用连续时间双包络的解析解：即使掉到 30fps，峰值也不会因为「onset 只亮一帧」而失真。
  const attack = Math.exp(-cfg.attackRate * delta);
  const release = Math.exp(-cfg.releaseRate * delta);
  state.envelope = state.envelope * attack
    + state.impulse * cfg.attackRate / (cfg.attackRate - cfg.releaseRate) * (release - attack);
  state.impulse *= release;

  // EQ 只增强持续低频；冲击使用 EQ 后剩下的高度空间，避免再被 EQ 放大、硬截顶。
  // 软肩部保留重拍余量，弱拍/中拍/强拍有不同高度，而不是单纯把所有柱子调矮。
  const pulseMix = cfg.pulseGain * (1 - Math.exp(-cfg.pulseCurve * state.envelope));
  const bands = energies.map((energy, index) => {
    const setting = Number.isFinite(eq[index]) ? Math.max(0, Math.min(100, eq[index])) : 50;
    const eqDelta = (setting - 50) / 50;
    const input = energy ** cfg.energyPower * cfg.baseGain[index];
    const baseline = eqDelta >= 0
      ? input * (1 + eqDelta * 1.8)
      : Math.max(0, input - Math.abs(eqDelta) * 0.35) * (1 - Math.abs(eqDelta) * 0.35);
    const limit = LOW_BAND_LIMITS[index];
    // EQ=0 仍保持静音语义；默认 90/92 不会对瞬态二次放大。
    const enabled = Math.min(1, setting / 50);
    return baseline + (limit - baseline) * pulseMix * enabled;
  });

  return { subBass: bands[0], bass: bands[1], kickEnvelope: state.envelope, impulseStrength };
}
