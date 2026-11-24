import { useEffect, useMemo, useRef } from 'react';
import { tracks } from './tracks.js';
import { createTerrainGL } from './terrainGL.js';
import { fitCardSphere, projectCardY } from './sphereLayout.js';
import { CardArtistTicker, Icon, LiquidArt } from './OrbitIcons.jsx';
import LyricsPanel from './LyricsPanel.jsx';
import { canUseTerrainGL, clamp, IS_DESKTOP_APP } from './runtimeEnv.js';

function makeCardCoordinates() {
  let rowCounts;
  if (tracks.length === 19) rowCounts = [3, 4, 5, 4, 3];
  else if (tracks.length <= 30) rowCounts = [4, 7, 8, 7, 4].map((amount, index, rows) => {
    const used = rows.slice(0, index).reduce((sum, value) => sum + value, 0);
    return Math.max(0, Math.min(amount, tracks.length - used));
  });
  else {
    const weights = [0.13, 0.22, 0.3, 0.22];
    const firstFour = weights.map(weight => Math.floor(tracks.length * weight));
    rowCounts = [...firstFour, tracks.length - firstFour.reduce((sum, value) => sum + value, 0)];
  }
  const result = [];
  let cardIndex = 0;
  rowCounts.forEach((amount, rowIndex) => {
    const lat = (rowIndex - (rowCounts.length - 1) / 2) * 0.52;
    for (let column = 0; column < amount && cardIndex < tracks.length; column += 1) {
      result.push({
        track: tracks[cardIndex],
        lat,
        lon: column / amount * Math.PI * 2 + rowIndex * 0.27,
      });
      cardIndex += 1;
    }
  });
  return result;
}

export default function Universe({ current, playing, currentTime, duration, onSelect, zoom, backdropMode, onRotateToast, analysisRef, audioRef, libraryVersion, lyricsVersion, onOpenBridge, soundfield }) {
  const universeRef = useRef(null);
  const { canvasRef, glCanvasRef } = soundfield;
  const glTerrainRef = useRef(null);
  const cardRefs = useRef([]);
  const ignoreDragClick = useRef(false);
  const propsRef = useRef({ current, playing, zoom, backdropMode });
  const coordinates = useMemo(makeCardCoordinates, [libraryVersion]);

  useEffect(() => {
    propsRef.current = { current, playing, zoom, backdropMode };
  }, [current, playing, zoom, backdropMode]);

  // GPU 地形（模式 4）只在 PC 端启用。移动设备直接跳过创建，避免 2.4 万个
  // 实例化方块持续占用 GPU，旧的轻量背景模式仍可正常使用。
  useEffect(() => {
    const glCanvas = glCanvasRef.current;
    if (!glCanvas) return undefined;
    const gpuAllowed = canUseTerrainGL();
    if (backdropMode !== 4 || !gpuAllowed) {
      glCanvas.style.display = 'none';
      return undefined;
    }
    if (!glTerrainRef.current) {
      try {
        glTerrainRef.current = createTerrainGL(glCanvas, { mobile: false });
      } catch (error) {
        console.warn('GPU 地形初始化失败，回落到轻量点阵背景', error);
        glTerrainRef.current = null;
      }
    }
    glCanvas.style.display = glTerrainRef.current ? 'block' : 'none';
    return undefined;
  }, [backdropMode, glCanvasRef]);

  useEffect(() => () => {
    if (glTerrainRef.current) {
      glTerrainRef.current.dispose();
      glTerrainRef.current = null;
    }
  }, []);

  useEffect(() => {
    const universe = universeRef.current;
    const canvas = canvasRef.current;
    const context = canvas.getContext('2d');
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
    const tiltLimit = 1.08;
    let rotation = -0.1;
    let tilt = 0.1;
    let autoRotate = !reducedMotion.matches;
    let dragging = false;
    let pointerId = null;
    let captureTarget = null;
    let lastX = 0;
    let lastY = 0;
    let lastPointerTime = 0;
    let moved = 0;
    let velocityX = 0;
    let velocityY = 0;
    let focusRotation = rotation;
    let focusTilt = tilt;
    let focusing = false;
    let focusedTrack = -1;
    let lastFrame = 0;
    let animationFrame = 0;
    let desktopVisualActive = true;
    let visualsActive = !document.hidden;
    let refocusTimer = 0;
    let wasPlaying = false;
    let revealCardsUntil = 0;
    let viewportWidth = Math.max(1, universe.clientWidth);
    let viewportHeight = Math.max(1, universe.clientHeight);
    let sphereLayoutDirty = true;
    let sphereLayout;
    let sphereAnchorX = 0, sphereAnchorY = 0;
    let layoutZoom;
    const cardFrameCache = [];
    const resizeObserver = new ResizeObserver(entries => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      viewportWidth = Math.max(1, rect.width);
      viewportHeight = Math.max(1, rect.height);
      sphereLayoutDirty = true;
    });
    resizeObserver.observe(universe);
    const layoutObserver = new MutationObserver(() => { sphereLayoutDirty = true; });
    layoutObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });

    const focusTrack = id => {
      const card = coordinates.find(item => item.track.id === id);
      if (!card) return;
      const exactRotation = -card.lon;
      focusRotation = rotation + Math.atan2(Math.sin(exactRotation - rotation), Math.cos(exactRotation - rotation));
      focusTilt = clamp(card.lat, -tiltLimit, tiltLimit);
      velocityX = 0;
      velocityY = 0;
      focusing = true;
    };

    let beatPulse = 0;
    let lyricsPanel = null;
    let lastBeatValue = -1;

    // 每帧只采一次细频谱：地形要用，节拍引擎的兜底分支也可能要用。
    // 之前地形和节拍各调一次 getByteFrequencyData，同一帧读两遍纯属浪费。
    const sampleFine = () => {
      const analysis = analysisRef.current;
      if (analysis.fine && analysis.fineBins) analysis.fine.getByteFrequencyData(analysis.fineBins);
    };

    // 能量与打击值统一从 BeatEngine 取。引擎内部已经做了三件事：
    //   · 自动增益 —— 母带响度不同的歌也能把律动幅度撑到满量程，手机小屏上看得出来
    //   · 输出延迟补偿 —— 画面按「此刻听到的声音」对齐，不再比声音早半拍
    //   · 音频线程 onset —— 掉帧时也不会漏掉起振点
    let energySmooth = 0;
    const readAudio = (dt, time) => {
      const analysis = analysisRef.current;
      const playing = propsRef.current.playing;
      const engine = analysis.engine;
      let bass = 0;
      let treble = 0;
      let hit = 0;
      let hitHigh = 0;
      let onset = 0;
      let onsetHigh = 0;
      let target = 0;
      if (playing && engine && engine.mode !== 'none') {
        const frame = engine.sample(analysis.context ? analysis.context.currentTime : time, dt);
        bass = frame.bass;
        treble = frame.treble;
        hit = frame.hit;
        hitHigh = frame.hitHigh;
        onset = frame.onset || 0;
        onsetHigh = frame.onsetHigh || 0;
        target = frame.level;
      } else if (playing) {
        // 原生输出模式 / 内核不支持接管：用一段缓慢的假呼吸顶上，画面不至于彻底死掉
        target = 0.2 + Math.sin(time * 1.1) * 0.07 + Math.sin(time * 0.37) * 0.05;
        bass = 0.18 + Math.sin(time * 1.3) * 0.05;
        treble = 0.16 + Math.sin(time * 1.9) * 0.05;
      }
      // 快起慢落：鼓点一上来就顶上去，收得慢一些。
      // 上升系数就是「打击感迟到多久」——0.45 约 3 帧才到位，手机 30fps 下就是 100ms，
      // 低延迟档提到 0.75，一帧就基本顶满。
      const attack = analysis.lowLatency ? 0.75 : 0.45;
      energySmooth += (target - energySmooth) * (target > energySmooth ? attack : 0.07);
      analysis.energy = energySmooth;
      analysis.bass = bass;
      analysis.treble = treble;
      analysis.beat = hit;
      analysis.beatHigh = hitHigh;
      analysis.onset = onset;
      analysis.onsetHigh = onsetHigh;
      return { energy: energySmooth, bass, treble, hit, hitHigh, onset, onsetHigh };
    };

    const dot = (x, y, radius, alpha) => {
      context.globalAlpha = alpha;
      context.beginPath();
      context.arc(x, y, radius, 0, Math.PI * 2);
      context.fill();
    };

    // ---------- 背景模式 3：律动地形 ----------
    // 一块倾斜的棋盘，柱子高度由 6 个频段分区驱动：低频抬中心、中低频走慢波、中频方向流动、
    // 中高频点尖峰、高频闪光、空气段撒颗粒。冲击力大时从中心扩散一圈涟漪。
    // 一律灰阶 + 半透明：低处的柱子几乎融进 #101113 底色，只有被音乐顶起来的那些才显形。
    const TOPO_PITCH = 0.92, TOPO_CAMD = 1500, TOPO_BANDS = 32;
    const topoLut = [];
    (function buildTopoLut() {
      const stops = [
        [0.00, 40, 42, 48],
        [0.30, 90, 93, 102],
        [0.55, 145, 149, 160],
        [0.78, 199, 203, 213],
        [1.00, 246, 248, 253]
      ];
      for (let i = 0; i < 256; i += 1) {
        const tv = i / 255;
        let s = 0;
        while (s < stops.length - 2 && tv > stops[s + 1][0]) s += 1;
        const p = stops[s];
        const q = stops[s + 1];
        const f = clamp((tv - p[0]) / (q[0] - p[0]), 0, 1);
        topoLut.push([
          Math.round(p[1] + (q[1] - p[1]) * f),
          Math.round(p[2] + (q[2] - p[2]) * f),
          Math.round(p[3] + (q[3] - p[3]) * f)
        ]);
      }
    })();
    const topoBands = new Float32Array(TOPO_BANDS);
    // 每段频带换算好的柱高系数（0~1），画的时候直接插值取用
    const topoNorm = new Float32Array(TOPO_BANDS);
    // 频谱瀑布：每 30ms 存一帧，地形的深度方向就是时间轴，远处那几行放的是稍早的频谱。
    // 只做横向频段的话，同一行的柱子高度全都一样，看上去就是一条跑道、分不出高频低频；
    // 加上时间轴之后每根柱子的高度都不同，鼓点走过的轨迹也留在地形上了。
    const TOPO_HISTORY = 32;
    const TOPO_HIST_LAG = 6;   // 地形最远那一行比最近一行晚多少帧
    const topoHist = new Float32Array(TOPO_BANDS * TOPO_HISTORY);
    let topoHistHead = 0;
    let topoHistLast = -1;
    // 全场峰值的慢速参考线。不同歌的母带响度差很多，用它统一增益，
    // 柱高才不会「这首歌全部顶满、那首歌全部贴地」。
    let topoGlobal = 0.6;
    let topoRipples = [];
    // 每首歌的鼓组母带、力度差异都很大。用近期起振点做自适应基线，
    // 只有明显高于常态的重击才算“特殊鼓点”；普通四拍不会反复冒水波。
    let topoAccentMean = 0.64;
    let topoAccentSpread = 0.08;
    let topoAccentSamples = 0;
    let topoLastRipple = -99;
    let topoClimax = 0;

    // ---------- 地面 EQ（结构参考 Sonic Topography 的 8 段地面混音台）----------
    // 原来只有一条对数频谱 + 几个写死的权重，调一次就要动一堆系数。
    // 现在拆成 8 段，每段一个推子（0~100，50 中性），各自负责一种地形性格：
    //   SUB BASS 中心抬升 / BASS 成块顶起 / LOW MID 全场慢波 / MID 斜向河流
    //   HIGH MID 外圈散落尖峰 / PRESENCE 闪光触发 / BRILLIANCE 边缘微闪 / AIR 空气颗粒
    // 默认和 Sonic Topography 一致：低频两段给到 90/92（地形主要靠低频撑起来），
    // 空气段压到 48（颗粒感太强会变成满屏噪点）。
    const GROUND_EQ_BANDS = [90, 92, 50, 50, 50, 50, 50, 48];
    const GROUND_EQ_NEUTRAL = 50;
    // 频段边界（Hz）。Sonic Topography 在 44.1kHz / fftSize 1024 下是按 bin 切
    // （1/3/7/18/46/93/186/372），这里改成按 Hz 算，采样率不是 44.1k 时也不会错位。
    const GROUND_EQ_HZ = [[0, 86], [86, 172], [172, 344], [344, 774], [774, 1978], [1978, 4000], [4000, 8000], [8000, 16000]];
    // 整体起伏幅度（0~100，50 为 1 倍）。往上不是线性放大，平方曲线更接近手感。
    const GROUND_AMPLITUDE = 55;
    const groundAmpScale = GROUND_AMPLITUDE <= 50
      ? GROUND_AMPLITUDE / 50
      : 1 + Math.pow((GROUND_AMPLITUDE - 50) / 50, 2) * 4;
    // 地形层的像素高度：1 个归一化单位对应的柱高（近排 1:1 像素）
    const GROUND_UNIT_PX = 200;
    // 进 EQ 之前的输入增益。低频两段的频谱值天生接近满格（母带里低频能量本来就大），
    // 直接进推子的话 90 这一档会把它乘到 1 以上被截断，中心抬升就变成一个不动的鼓包，
    // 看不出鼓点。先压到 0.45 / 0.55，推子 90 之后刚好还有动态余量。
    const GROUND_EQ_INPUT_GAIN = [0.45, 0.55, 1, 1, 1, 1, 1, 1];
    // 平滑后的八段能量（已过 EQ 推子）
    const topoEq = new Float32Array(8);

    // 推子映射（Sonic Topography 的 applyGroundEqBandValue）：
    // 推子往上 = 乘性放大；往下 = 先削掉一部分底噪再整体压暗。
    // 这样"调低"是真的变闷，而不是简单乘个小数。
    const applyGroundEq = (value, eq) => {
      const delta = (eq - GROUND_EQ_NEUTRAL) / GROUND_EQ_NEUTRAL;
      if (delta >= 0) return clamp(value * (1 + delta * 1.8), 0, 1);
      const dullness = Math.abs(delta);
      return clamp(Math.max(0, value - dullness * 0.35) * (1 - dullness * 0.35), 0, 1);
    };

    const sampleTopo = (time, engineBass = 0, engineHigh = 0, energy = 0, onset = 0, onsetHigh = 0) => {
      const analysis = analysisRef.current;
      let bass = 0;
      if (analysis.fine && propsRef.current.playing) {
        // 频谱已经在 sampleFine() 里采过一遍了，这里直接用，别再读一次
        const bins = analysis.fineBins;
        const usable = Math.floor(bins.length * 0.62);
        for (let i = 0; i < TOPO_BANDS; i += 1) {
          const lo = Math.floor(Math.pow(i / TOPO_BANDS, 1.7) * usable);
          const hi = Math.max(lo + 1, Math.floor(Math.pow((i + 1) / TOPO_BANDS, 1.7) * usable));
          let sum = 0;
          for (let k = lo; k < hi; k += 1) sum += bins[k];
          // 频谱平均值偏小，统一抬增益，柱子才顶得起来。
          const value = clamp(sum / (hi - lo) / 255 * 1.25, 0, 1);
          // 快起快落：柱子要跟着鼓点一根一根地跳，回落慢了就糊成一片高低不分的墙。
          topoBands[i] += (value - topoBands[i]) * (value > topoBands[i] ? 0.72 : 0.2);
        }
        // 地面 EQ 的 8 段按 Hz 直接切，和上面 32 段的对数瀑布分开：
        // 对数分段适合画频谱轮廓，但没法对应"低频/中低频/中频…"这种音乐上的分法。
        const sampleRate = analysis.context?.sampleRate || 44100;
        const perBin = sampleRate / (bins.length * 2);
        for (let b = 0; b < 8; b += 1) {
          // 半开区间 [lo, hi)，两端都用 ceil。
          // 用 floor 会让相邻两段压到同一批 bin 上：86Hz 在 44.1k / fftSize 1024 下是
          // 86/43.07 = 1.997，floor 出 1，于是 SUB BASS 读到 bin 1~2、BASS 又从 bin 1
          // 读到 3 —— 两段共用 bin，推子怎么拉都是同一条曲线，低频重量等于没做。
          // ceil 之后是 [0,2) / [2,4) / [4,8)…，和 Sonic Topography 的 bin 划分逐段对齐。
          const lo = Math.ceil(GROUND_EQ_HZ[b][0] / perBin);
          const hi = Math.min(bins.length, Math.max(lo + 1, Math.ceil(GROUND_EQ_HZ[b][1] / perBin)));
          let sum = 0;
          for (let k = lo; k < hi; k += 1) sum += bins[k];
          const raw = clamp(sum / (hi - lo) / 255 * 1.25 * GROUND_EQ_INPUT_GAIN[b], 0, 1);
          const shaped = applyGroundEq(raw, GROUND_EQ_BANDS[b]);
          // 地形层的起伏要比音柱慢一档：快起慢落，看得出大块地貌在推
          topoEq[b] += (shaped - topoEq[b]) * (shaped > topoEq[b] ? 0.35 : 0.08);
        }
        for (let i = 0; i < 4; i += 1) bass += topoBands[i];
        bass /= 4;
      } else {
        // 没在播放时缓慢回落，最后只剩一层静态的矮格子
        for (let i = 0; i < TOPO_BANDS; i += 1) topoBands[i] += (0 - topoBands[i]) * 0.04;
        for (let i = 0; i < 8; i += 1) topoEq[i] += (0 - topoEq[i]) * 0.04;
      }
      // 全场峰值只跟最响的那一段走，慢慢升、慢慢退
      let loudest = 0;
      for (let i = 0; i < TOPO_BANDS; i += 1) if (topoBands[i] > loudest) loudest = topoBands[i];
      topoGlobal = loudest > topoGlobal
        ? topoGlobal + (loudest - topoGlobal) * 0.12
        : topoGlobal * 0.999;
      // 开方（0.72 次幂）把频段落差拉开：低频 0.77、中频 0.5、镲那片 0.02，
      // 直接按绝对值画，中高频全部贴地一片；开方之后是 0.82 / 0.61 / 0.06，
      // 各段的柱子都在自己的尺度上跳，而「中间高、两侧矮」的轮廓还留着。
      // 幂次越大落差越明显，但也越压高频的动态，0.7 上下是个平衡点。
      const gain = 1 / Math.max(0.45, topoGlobal);
      for (let i = 0; i < TOPO_BANDS; i += 1) {
        topoNorm[i] = Math.pow(clamp(topoBands[i] * gain, 0, 1), 0.72);
      }
      // 按固定时间间隔推帧，不跟帧率绑定：手机掉到 30fps 时历史节奏才不会跟着变慢。
      // 30ms 一帧 = 整片地形摊开约 1 秒，柱子原地跳动的节奏感还在；
      // 拉长到 2 秒以上，看到的就是一片缓慢流动的地形，跳动感会被摊平。
      if (time - topoHistLast >= 0.03) {
        topoHistLast = time;
        topoHistHead = (topoHistHead + 1) % TOPO_HISTORY;
        const base = topoHistHead * TOPO_BANDS;
        for (let i = 0; i < TOPO_BANDS; i += 1) topoHist[base + i] = topoNorm[i];
      }
      // 引擎的自动增益结果已经是归一化的，不同母带响度的歌隆起幅度才一致；
      // 地形带的原始低频值只作为下限兜底。
      const shaped = propsRef.current.playing && engineBass ? Math.max(bass, engineBass * 0.85) : bass;
      // 燃点：整段音量和低频同时压在高位才算高潮。它只用来给柱子加一点整体高度，
      // 不再是涟漪的触发条件 —— 高潮段每一拍都放水波的话，画面上永远有新圈在扩散。
      const hot = propsRef.current.playing && engineBass > 0.7 && energy > 0.66;
      topoClimax += ((hot ? 1 : 0) - topoClimax) * (hot ? 0.05 : 0.014);

      // 起振点是单帧事件，不会把上一拍的衰减尾巴重复算成新鼓点。
      // 低频重击、军鼓重击，或低高频同时落下的组合拍会触发水波；
      // 其余稳定节拍只留给频谱音柱表达。
      const accent = Math.max(onset, onsetHigh * 0.92);
      if (propsRef.current.playing && accent > 0) {
        const threshold = clamp(
          topoAccentMean + Math.max(0.1, topoAccentSpread * 1.35),
          0.74,
          0.94
        );
        const layered = onset > 0.54 && onsetHigh > 0.52;
        const lowAccent = onset >= threshold && engineBass > 0.44;
        const highAccent = onsetHigh >= threshold && engineHigh > 0.46;
        const warmedUp = topoAccentSamples >= 4;
        const special = (warmedUp && (lowAccent || highAccent)) || (layered && accent >= 0.72);

        // 水波结束后必须留出一段纯音柱时间。否则密集鼓组里上一圈还没散，
        // 下一圈又进来，视觉上会永远停在“特殊鼓点”，失去两种状态的区分。
        if (special && time - topoLastRipple > 2.1) {
          topoLastRipple = time;
          const contrast = clamp((accent - threshold + 0.08) / 0.28, 0, 1);
          const amp = 0.82 + contrast * 0.46 + (layered ? 0.16 : 0);
          topoRipples.push({ t0: time, amp, speed: 620, width: 92, life: 1.35 });
          // 低频和军鼓一起砸下时补一道更轻的内圈，组合重拍会比单独底鼓更有层次。
          if (layered) topoRipples.push({ t0: time + 0.09, amp: amp * 0.55, speed: 550, width: 64, life: 1.15 });
        }

        // 特殊重击对基线只做截断后的更新，避免一次 drop 把阈值永久抬高。
        const baselineSample = Math.min(accent, threshold + 0.04);
        const delta = baselineSample - topoAccentMean;
        const rate = topoAccentSamples < 8 ? 0.16 : 0.075;
        topoAccentMean += delta * rate;
        topoAccentSpread += (Math.abs(delta) - topoAccentSpread) * rate;
        topoAccentSamples += 1;
      }

      while (topoRipples.length && time - topoRipples[0].t0 > topoRipples[0].life) topoRipples.shift();
      return shaped;
    };

    const drawTopography = (width, height, time, engineBass = 0, engineHigh = 0) => {
      const mobile = width < 600;
      // 横向每一列就是一段频率：正中间那列最低频（底鼓），越往两侧越高频（军鼓、镲）。
      // 柱子高度只由「自己这一列」的频段能量决定，不再是全场一起抬，
      // 所以哪一段在响、响多重，直接看柱高轮廓就分得出来。
      //
      // 网格参数全部按屏幕反推，而不是写死世界坐标尺寸 —— 这是两端观感一致的关键。
      // 旧写法固定 cell 和 maxR，焦距由屏宽反算，结果桌面（1440 宽）的近排投影比例
      // s 是手机的近两倍，整片地形纵向被拉到 1300px（屏高才 900），柱子越过屏幕顶部，
      // 看着就是一层白色竖条纹，完全没有柱状感。
      // 现在改成：先定「最近一排 1:1 像素」（s近 = 1），再让屏幕间距落在固定像素值上，
      // 于是柱子在世界坐标里的尺寸就等于它在屏幕上的尺寸，手机和桌面看到的是同一套比例。
      // 桌面端把视角压低，让地面明显向远处倾斜，柱体的顶面、侧面和高度差都能看清；
      // 同时把纵深延伸到画面外：最远一排抵达顶部，最近一排落到播放器后方。
      // 移动端保留原来的短纵深，避免小屏需要绘制过多柱子而掉帧。
      const pitch = mobile ? TOPO_PITCH : 0.82;
      const cosP = Math.cos(pitch);
      const sinP = Math.sin(pitch);
      // 透视会把远端横向压窄，桌面端必须多铺一圈，最远一排才能仍然盖满左右边缘。
      const maxX = width * (mobile ? 1.5 : 2.06) / 2;
      // 桌面扩大覆盖后把间距同步放大，柱子总数维持在约 2400 根以内，避免铺满后掉帧。
      const spacing = mobile ? 24 : 46;
      const cols = Math.max(10, Math.round(maxX * 2 / spacing));
      const cellX = maxX * 2 / (cols - 1);
      // 桌面纵深覆盖 1.84 个屏高，配合较低的观察角仍能铺满上下边缘。
      const maxZ = height * (mobile ? 0.3 : 0.92);
      const rows = Math.max(8, Math.round(maxZ * 2 / spacing));
      const cellZ = maxZ * 2 / (rows - 1);
      const halfX = (cols - 1) / 2;
      const halfZ = (rows - 1) / 2;
      // 柱子宽度取间距的一半：一半实一半空，才看得出是一根根的柱子，
      // 而不是一条连续的墙。之前取 0.3，间隙只剩十来个像素，整片糊在屏幕上。
      const q = cellX * 0.25;
      const cx = width * 0.5;
      // PC 球面圆心落在当前歌曲卡片附近；移动端维持原来的位置。
      const cy = height * (mobile ? 0.62 : 0.46);
      const sphereRadius = Math.min(width, height) * 0.52;
      // 水波纹只在重拍和高潮段放出来，圆心回到地形正中，和中间那列低频柱对齐
      const beatX = 0;
      const beatZ = 0;
      // 高屏桌面同步拉长镜头距离，避免屏幕越高、远端反而越缩在中间。
      // 焦距仍锁在「最近一排」上：s = fov / (rz + camDistance)，近排正好 1:1。
      const camDistance = mobile ? TOPO_CAMD : Math.max(TOPO_CAMD, height * 1.9);
      const fov = camDistance - maxZ * cosP;
      const bandAvg = (lo, hi) => {
        let sum = 0;
        for (let i = lo; i <= hi; i += 1) sum += topoBands[i];
        return sum / (hi - lo + 1);
      };
      const subBass = bandAvg(0, 2);
      // 地面 EQ 的八段（已过推子）
      const eqSub = topoEq[0];
      const eqBass = topoEq[1];
      const eqLowMid = topoEq[2];
      const eqMid = topoEq[3];
      const eqHighMid = topoEq[4];
      const eqPresence = topoEq[5];
      const eqBrilliance = topoEq[6];
      const eqAir = topoEq[7];
      // 便宜的二维噪声（Sonic Topography 用的是 simplex，这里用两组交叉正弦近似，
      // 视觉上够用，省掉一层噪声表）。返回值大致落在 -1~1。
      const snoise2 = (a, b) =>
        Math.sin(a * 1.7 + Math.cos(b * 1.3) * 1.9) * 0.5 +
        Math.sin(b * 2.1 - Math.cos(a * 1.1) * 1.4) * 0.5;
      // 每格固定的随机数：同一根柱子每帧拿到同一个值，尖峰才不会闪成噪点
      const cellRand = (a, b) => {
        const v = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
        return v - Math.floor(v);
      };
      const smoothstepLocal = (edge0, edge1, v) => {
        const t = clamp((v - edge0) / (edge1 - edge0), 0, 1);
        return t * t * (3 - 2 * t);
      };
      const proj = (x, y, z) => {
        const ry = y * cosP + z * sinP;
        const rz = -y * sinP + z * cosP;
        const s = fov / (rz + camDistance);
        return [cx + x * s, cy - ry * s];
      };

      // 底盘只做极轻的压暗，避免变成一块挡住页面底色的实心板
      const gA = proj(-maxX - cellX, 0, -maxZ - cellZ);
      const gB = proj(maxX + cellX, 0, -maxZ - cellZ);
      const gC = proj(maxX + cellX, 0, maxZ + cellZ);
      const gD = proj(-maxX - cellX, 0, maxZ + cellZ);
      context.beginPath();
      context.moveTo(gA[0], gA[1]);
      context.lineTo(gB[0], gB[1]);
      context.lineTo(gC[0], gC[1]);
      context.lineTo(gD[0], gD[1]);
      context.closePath();
      context.fillStyle = 'rgba(12,13,16,0.30)';
      context.fill();

      // 从远到近画，保证近处的柱子盖住远处的（画家算法）
      for (let row = rows - 1; row >= 0; row -= 1) {
        const z = (row - halfZ) * cellZ;
        // 这一行取瀑布里的哪一帧：越远 = 越早。
        // 时间差只留 6 帧（约 0.2 秒）：整片柱子基本同步地原地升高回落，只带一点
        // 从远到近的流动感。摊到一两秒就成了缓慢滚动的地形，反而看不出柱子在跳。
        const age = Math.round(row / (rows - 1) * TOPO_HIST_LAG);
        const base = (((topoHistHead - age) % TOPO_HISTORY) + TOPO_HISTORY) % TOPO_HISTORY * TOPO_BANDS;
        const near = 1 - age / TOPO_HIST_LAG;
        // PC 端按这一帧内部的频段强弱重新拉开范围。母带很满的歌曲里各频段绝对值
        // 都接近 1，只看绝对值会整面一起升高；相对范围才能保留真正的高低轮廓。
        let rowMin = 1;
        let rowMax = 0;
        if (!mobile) {
          for (let band = 2; band <= 16; band += 1) {
            const value = topoHist[base + band];
            if (value < rowMin) rowMin = value;
            if (value > rowMax) rowMax = value;
          }
        }
        const rowSpan = Math.max(0.08, rowMax - rowMin);
        for (let col = 0; col < cols; col += 1) {
          // PC 每隔一排错开半格，打断从底部一直贯穿顶部的纵向栅栏；
          // 手机维持原网格，避免触碰已经稳定的小屏构图。
          const rowOffset = mobile || row % 2 === 0 ? 0 : cellX * 0.5;
          const x = (col - halfX) * cellX + rowOffset;
          // 频率位置：0 = 正中间那列（最低频），1 = 最外侧（最高频）
          const fpos = Math.min(1, Math.abs(col - halfX) / halfX);
          // PC 端按投影后的屏幕距离划正圆，而不是用 x / z 比例切椭圆。
          // 圆只负责分配中高频，不再裁掉外部音柱：圆外整片继续显示低频。
          const groundPoint = mobile ? null : proj(x, 0, z);
          const screenDx = mobile ? 0 : groundPoint[0] - cx;
          const screenDy = mobile ? 0 : groundPoint[1] - cy;
          const radialRaw = mobile
            ? 0
            : Math.hypot(screenDx, screenDy) / sphereRadius;
          const radialNorm = mobile ? 0 : clamp(radialRaw, 0, 1);
          // 用一段宽过渡把圆形声场融进全屏低频底盘，避免边界变成两堵直墙。
          const circleMix = mobile ? 1 : clamp((1.08 - radialRaw) / 0.24, 0, 1);
          // 圆内用二维缓波分散中高频。极坐标扇区在透视后会变成贯穿画面的直条，
          // 改用屏幕 x/y 的交叉波后，频段会形成连续的小丘而不是放射状沟槽。
          const fieldX = mobile ? 0 : screenDx / sphereRadius;
          const fieldY = mobile ? 0 : screenDy / sphereRadius;
          const frequencyLobe = mobile
            ? 0
            : clamp(
              0.5
                + Math.sin(fieldX * 4.1 + fieldY * 3.2) * 0.24
                + Math.cos(fieldX * 2.3 - fieldY * 4.6) * 0.24,
              0,
              1
            );
          const innerFrequency = mobile
            ? 0
            : clamp(0.3 + radialNorm * 0.32 + frequencyLobe * 0.3, 0.28, 0.94);
          const frequencyPos = mobile
            ? fpos
            : innerFrequency * circleMix;
          const spatialEdge = mobile ? fpos : radialNorm;
          // 这一列对应的频段，做线性插值，柱高才不会一格一格地跳。
          // 从 idx2 起步：idx0 只盖住 0~47Hz 一个 bin，能量天生偏低，
          // 落在正中间会挖出一条莫名其妙的沟；idx16 到头，再往上基本是空气。
          // 圆边只混合柱高和颜色，采样频段保持连续；否则频率在边界被拉回 0，
          // 仍会生成一圈突兀的低频高柱。
          const sampleFrequency = mobile ? frequencyPos : innerFrequency;
          const bandAt = 2 + sampleFrequency * 14;
          const bi = bandAt | 0;
          const bf = bandAt - bi;
          const bj = Math.min(TOPO_BANDS - 1, bi + 1);
          const centerBand = topoHist[base + bi] * (1 - bf) + topoHist[base + bj] * bf;
          const lowerBand = topoHist[base + Math.max(2, bi - 1)];
          const upperBand = topoHist[base + Math.min(17, bj + 1)];
          const bandVal = centerBand * 0.62 + lowerBand * 0.19 + upperBand * 0.19;
          // 再压一点点外圈，轮廓更清楚：中间那几列低频柱最高，越往两侧越低
          const absoluteBand = clamp(bandVal, 0, 1) * (1 - spatialEdge * 0.12);
          const relativeBand = clamp((bandVal - rowMin) / rowSpan, 0, 1)
            * (0.34 + bandVal * 0.66)
            * (1 - spatialEdge * 0.08);
          // 保留一部分绝对能量，避免相对归一化把相邻频段切成黑色沟槽。
          const bandShaped = mobile ? absoluteBand : relativeBand * 0.45 + absoluteBand * 0.55;
          // 低频带 / 高频带的权重：底鼓只管中间那几列，镲只管外圈
          const wLow = Math.exp(-(frequencyPos * frequencyPos) / 0.16);
          const wHigh = 1 - Math.exp(-(frequencyPos * frequencyPos) / 0.3);
          // 引擎归一化后的量做增益，不同母带响度的歌柱高才一致
          const gain = 0.82
            + engineBass * 0.16 * wLow
            + engineHigh * (mobile ? 0.22 : 0.3) * wHigh;
          const dxr = x - beatX;
          const dzr = z - beatZ;
          // 圆外保持低矮但可见的律动，进入圆内后连续抬升，避免形成左右高墙。
          // 移动端继续使用原来的固定响应。
          const motionFocus = mobile
            ? 1
            : 0.44 + circleMix * (0.44 + Math.pow(1 - radialNorm, 0.72) * 0.12);
          // PC 端以靠近播放器的底部音柱为主：近排响应放大，越往顶部越安静。
          // 移动端保持 1，不改变原来的纵深动态。
          const depthMotion = mobile
            ? 1
            : 0.3 + Math.pow(near, 0.72) * 1.05;
          // 涟漪按「屏幕上看起来的距离」往外推：横向 1 单位 = s 像素，
          // 深度方向 1 单位只投影出 sinP×s 像素。先把 z 压一下，
          // 圈在屏幕上才是圆的；不压的话深度方向会被拉成一条长椭圆。
          const bd = Math.sqrt(dxr * dxr + dzr * dzr * sinP * sinP);
          // 主驱动就是柱高本身：自己这一列的频段能量。
          // 高潮段整体再抬一点，副歌进来时地形会明显「长高」一截。
          // 高度不再分端：两端最近一排的投影比例都是 1:1 像素，
          // 同一个 h 值在手机和桌面上就是同样的屏幕高度。
          // PC 端需要更大的动态落差：先滤掉很弱的底噪，再把强频段拉高。
          // 这样安静频段仍贴近地面，主鼓和主旋律能恢复最初版本那种明显的高柱，
          // 而不是把整片地形一起等比例抬高。移动端沿用原来的 132 高度，完全不变。
          const desktopBand = Math.pow(clamp((bandShaped - 0.05) / 0.95, 0, 1), 1.18);
          const lowBandVal = mobile ? 0 : topoHist[base + 2];
          const outerLowEnergy = mobile
            ? 0
            : clamp(0.04 + Math.pow(lowBandVal, 1.8) * 0.2 + engineBass * 0.1, 0.04, 0.34);
          const barEnergy = mobile
            ? bandShaped
            : outerLowEnergy * (1 - circleMix) + desktopBand * circleMix;
          const highPulse = mobile ? 0 : engineHigh * wHigh * circleMix * (22 + barEnergy * 38);
          const spectral = (barEnergy * (mobile ? 132 : 300) * gain + highPulse)
            * (1 + topoClimax * 0.22);
          // 底鼓：中间那条低频带整条窜起来，打一下窜一下
          const swellLow = subBass * (mobile ? 16 : 28) * wLow;
          // 深度方向留一点起伏，同一列不至于长得一模一样
          const depth = (Math.sin(z * 0.021 + time * 0.5 + fpos * 4) * 0.5 + 0.5) * barEnergy * (mobile ? 16 : 24);
          // ---------- 地面 EQ 的地形层 ----------
          // 这一段是 Sonic Topography 的核心：8 段不是一起把地面抬高，
          // 而是各管一片地形性格。先算归一化单位，最后统一乘像素高度。
          const rnd = cellRand(col, row);
          // 半径代理：桌面用投影后的屏幕半径；移动端没走球面投影，radialNorm 恒为 0，
          // 直接拿它做区域判定会让中心抬升铺满整块地面、外圈尖峰永远不出现，
          // 移动端八段里等于只吃到两段。小屏退化成用频率轴 fpos（中列=0，边列=1），
          // 语义一致：低频在中间、高频在外圈。
          const radialProxy = mobile ? fpos : radialNorm;
          // SUB BASS / 中心抬升：只有中心区域整块隆起，慢而厚
          const subRegion = 1 - smoothstepLocal(0.06, 0.42, radialProxy);
          const subLift = eqSub * subRegion * 0.5;
          // BASS / 低频重量：被噪声切成一块一块，成片地顶起来
          const bassNoise = snoise2(x * 0.0016, z * 0.0016 - time * 0.2);
          const bassRegion = 1 - smoothstepLocal(0.05, 0.5, radialProxy + bassNoise * 0.12);
          const bassLift = eqBass * bassRegion * smoothstepLocal(0, 1, rnd * 0.7 + 0.45) * 0.4;
          // LOW MID / 慢波流动：全场缓慢起伏的一大片波
          const lowMidLift = eqLowMid * (snoise2(x * 0.0009 + time * 0.1, z * 0.0009) * 0.5 + 0.5) * 0.25;
          // MID / 方向流：斜着穿过画面的河流，只取正半波才不会变成对称的沟
          const river = Math.sin(x * 0.0022 + z * 0.0022 + snoise2(x * 0.0013, z * 0.0013) * 2 - time * 2);
          const midLift = eqMid * Math.max(0, river) * 0.3;
          // HIGH MID / 尖峰：外圈随机散落的个别高柱
          const highRegion = smoothstepLocal(0.34, 0.78, radialProxy);
          const spikeGate = cellRand(col * 3 + 1, row * 5 + 2) > 0.8 ? 1 : 0;
          const highMidLift = eqHighMid * highRegion * spikeGate * cellRand(col * 7 + 3, row * 11 + 5) * 0.25;
          // AIR / 空气颗粒：只抖一点点，给静止段一点活的质感
          const airGrain = eqAir * 0.07 * (snoise2(x * 0.02 + time * 3, z * 0.02) * 0.5 + 0.5);
          // 噪声门：低于阈值的部分直接归零。安静段落地面是平的，
          // 不让底噪把整片地形轻轻浮起来（Sonic Topography 的做法）。
          const gated = Math.max(0, subLift + bassLift + lowMidLift + midLift + highMidLift + airGrain - 0.2);
          // 移动端按 0.5 缩放：这一层是叠在音柱之上的，而小屏音柱基准只有 132（桌面 300），
          // 不缩的话 EQ 层会占掉大半个屏高，把之前「柱子缩小一点、融入主站」的调整全顶回去。
          const eqHeight = gated * GROUND_UNIT_PX * groundAmpScale * (mobile ? 0.5 : 1);
          // PRESENCE / BRILLIANCE 不抬地形，只管亮部：闪光触发 + 边缘微闪。
          // 颜色保持灰阶，所以它们体现为"顶面更亮"，不是换色。
          const sparkle = eqPresence * (rnd > 0.985 ? 0.45 : 0)
            + eqBrilliance * highRegion * (cellRand(col * 13 + 7, row * 17 + 3) > 0.94 ? 0.3 : 0);

          // 水波纹只承接被判定为“特殊鼓点”的事件；普通律动全部由 spectral 音柱表达。
          let rip = 0;
          for (let ri = 0; ri < topoRipples.length; ri += 1) {
            const r = topoRipples[ri];
            const age = time - r.t0;
            if (age < 0) continue;
            const d = Math.abs(bd - age * r.speed);
            if (d < r.width) rip += Math.cos(d / r.width * Math.PI / 2) * r.amp * (mobile ? 84 : 128) * Math.max(0, 1 - age / r.life);
          }
          // 静止时也留一层极缓的呼吸，画面不至于完全死掉。
          // 用归一化坐标而不是绝对坐标：两端的地形世界尺寸差三倍，
          // 写死频率会让桌面的呼吸波密得像噪点、手机却几乎看不到。
          const idle = 5 * (Math.sin(x / maxX * 1.8 + time * 0.35) * Math.cos(z / maxZ * 1.2 - time * 0.28) * 0.5 + 0.5);
          const focusedRipple = mobile ? rip : rip * (0.42 + (1 - radialNorm) * 0.58);
          const rawHeight = 5
            + (spectral + swellLow + depth + eqHeight) * motionFocus * depthMotion
            + focusedRipple * depthMotion
            + idle * (mobile ? 1 : 0.58);
          // 高潮段用柔性上限压住极端尖柱，仍保留低段的真实比例和重拍的快速变化。
          const h = mobile
            ? rawHeight
            : 5 + 225 * (1 - Math.exp(-Math.max(0, rawHeight - 5) / 225));
          const tt = clamp(h / 250, 0, 1);
          // 闪光只加到取色用的色阶上，不动透明度：柱子亮一下，但不会突然变实
          const ttColor = clamp(tt + sparkle, 0, 1);
          const c = topoLut[(ttColor * 255) | 0];
          // 低频柱偏暖（琥珀）、高频柱偏冷（青蓝）。
          // 原来的 ±24 太含蓄，各段都落回同一个灰白，扫一眼分不出是哪一段在响。
          const warm = 1 - frequencyPos * 2;
          const cr = clamp(c[0] + warm * 52, 0, 255) | 0;
          const cg = clamp(c[1] + warm * 10, 0, 255) | 0;
          const cb = clamp(c[2] - warm * 40, 0, 255) | 0;
          // 远处的柱子按深度淡出（雾效）：不加这层，前后排一样实，
          // 整片柱子会连成一道平齐的「墙头」，看不出哪一根在自己跳。
          // 顶部按纵深渐隐，底部维持完整亮度。移动端仍用原来的雾化曲线。
          const fieldOpacity = mobile ? 1 : 0.24 + circleMix * 0.44;
          const fog = (mobile
            ? 0.35 + 0.65 * near
            : 0.06 + 0.94 * Math.pow(near, 0.82)) * fieldOpacity;

          // 轻微抬起中心底面形成球冠；每根柱子的顶端再沿半径向中心偏移，
          // 外圈倾斜更大，整体看上去像包在一个球面上，而不是一片竖直栅栏。
          const surfaceY = mobile ? 0 : Math.pow(1 - radialNorm, 1.7) * height * 0.055;
          const radialWorld = Math.hypot(x, z) || 1;
          const inward = mobile ? 0 : h * (0.16 + radialNorm * 0.24);
          const topX = x - x / radialWorld * inward;
          const topZ = z - z / radialWorld * inward;
          const topY = surfaceY + h;

          const t0 = proj(topX - q, topY, topZ - q);
          const t1 = proj(topX + q, topY, topZ - q);
          const t2 = proj(topX + q, topY, topZ + q);
          const t3 = proj(topX - q, topY, topZ + q);
          const f0 = proj(x - q, surfaceY, z - q);
          const f1 = proj(x + q, surfaceY, z - q);

          // 侧面只画朝向视轴的那一侧
          if (x > cellX * 0.5) {
            const sA = proj(x - q, surfaceY, z + q);
            const sB = proj(topX - q, topY, topZ + q);
            context.fillStyle = 'rgba(' + (cr * 0.42 | 0) + ',' + (cg * 0.42 | 0) + ',' + (cb * 0.42 | 0) + ',' + ((0.03 + tt * 0.24) * fog) + ')';
            context.beginPath();
            context.moveTo(f0[0], f0[1]);
            context.lineTo(sA[0], sA[1]);
            context.lineTo(sB[0], sB[1]);
            context.lineTo(t0[0], t0[1]);
            context.closePath();
            context.fill();
          } else if (x < -cellX * 0.5) {
            const sC = proj(x + q, surfaceY, z + q);
            const sD = proj(topX + q, topY, topZ + q);
            context.fillStyle = 'rgba(' + (cr * 0.42 | 0) + ',' + (cg * 0.42 | 0) + ',' + (cb * 0.42 | 0) + ',' + ((0.03 + tt * 0.24) * fog) + ')';
            context.beginPath();
            context.moveTo(f1[0], f1[1]);
            context.lineTo(sC[0], sC[1]);
            context.lineTo(sD[0], sD[1]);
            context.lineTo(t1[0], t1[1]);
            context.closePath();
            context.fill();
          }

          // 正面
          context.fillStyle = 'rgba(' + (cr * 0.58 | 0) + ',' + (cg * 0.58 | 0) + ',' + (cb * 0.58 | 0) + ',' + ((0.05 + tt * 0.34) * fog) + ')';
          context.beginPath();
          context.moveTo(f0[0], f0[1]);
          context.lineTo(f1[0], f1[1]);
          context.lineTo(t1[0], t1[1]);
          context.lineTo(t0[0], t0[1]);
          context.closePath();
          context.fill();

          // 顶面：越高的柱子越实
          context.fillStyle = 'rgba(' + cr + ',' + cg + ',' + cb + ',' + ((0.06 + tt * 0.44) * fog) + ')';
          context.beginPath();
          context.moveTo(t0[0], t0[1]);
          context.lineTo(t1[0], t1[1]);
          context.lineTo(t2[0], t2[1]);
          context.lineTo(t3[0], t3[1]);
          context.closePath();
          context.fill();
        }
      }

      // 特殊鼓点只让一圈柱高向外传递，不再额外描绘圆形亮边。
    };

    const drawSoundfield = (timestamp, dtSeconds) => {
      const width = viewportWidth;
      const height = viewportHeight;
      // 手机 GPU 扛不住 1.5 倍像素，掉到 20~30fps 时每帧间隔变大，
      // 节拍采样变稀、画面看着就「慢半拍」。移动端把像素量压下来换帧率。
      const dpr = Math.min(devicePixelRatio || 1, width < 600 ? 1.25 : 1.5);
      const time = timestamp * 0.001;
      const mobile = width < 600;
      sampleFine();
      let energy = 0;
      let bassLevel = 0;
      let trebleLevel = 0;
      let hit = 0;
      let hitHigh = 0;
      let onset = 0;
      let onsetHigh = 0;
      if (!reducedMotion.matches) {
        const frame = readAudio(dtSeconds, time);
        energy = frame.energy;
        bassLevel = frame.bass;
        trebleLevel = frame.treble;
        hit = frame.hit;
        hitHigh = frame.hitHigh;
        onset = frame.onset;
        onsetHigh = frame.onsetHigh;
      }
      // 底鼓给主打击感，镲和军鼓补一层碎拍，低频量和整体音量打底。
      // 高频只占小头：它触发得密，权重给大了画面会一直顶在半高，反而看不出重拍。
      // 前端的缩放/发光补偿在 CSS 里按屏幕尺寸分档（小屏的同一个数值看着就是「没动静」），
      // 这里不再重复分端，免得桌面端被压掉一截。
      beatPulse = clamp(
        (hit * 0.54 + hitHigh * 0.18 + bassLevel * 0.2 + trebleLevel * 0.08 + energy * 0.24) * 1.2,
        0, 1
      );
      // 只在幅度真变了的时候写 CSS 变量：安卓上每帧改自定义属性会触发整棵子树重算样式
      const quantized = Math.round(beatPulse * 100) / 100;
      if (quantized !== lastBeatValue) {
        lastBeatValue = quantized;
        const beatText = quantized.toFixed(2);
        if (!lyricsPanel) lyricsPanel = document.getElementById('lyrics-panel');
        lyricsPanel?.style.setProperty('--beat', beatText);
      }

      // GPU 地形模式：24k 个实例化立方体交给 WebGL，2D 画布只保留上面的 UI 层。
      const gpuAllowed = canUseTerrainGL();
      const gpuMode = propsRef.current.backdropMode === 4 && gpuAllowed;
      const gpuActive = gpuMode && !!glTerrainRef.current;
      if (gpuActive) {
        const analysis = analysisRef.current;
        // 地形继续逐帧律动；交互时降低 WebGL 内部像素密度与实例网格，
        // 把合成预算优先留给卡片层。频谱和坐标仍由 CPU 做轻量计算。
        const terrainDpr = dragging ? Math.min(dpr, 1) : dpr;
        glTerrainRef.current.resize(width, height, terrainDpr);
        glTerrainRef.current.frame({
          time,
          bins: analysis.fineBins,
          sampleRate: analysis.context?.sampleRate || 44100,
          energy,
          kickEnvelope: hit,
          onset,
          onsetHigh,
          playing: propsRef.current.playing,
          dt: dtSeconds,
          interacting: dragging
        });
        // GPU 模式无需再逐帧清空另一张全屏 2D 画布。
        if (canvas.width !== 1 || canvas.height !== 1) {
          canvas.width = 1;
          canvas.height = 1;
        }
        return;
      }

      const pixelWidth = Math.round(width * dpr);
      const pixelHeight = Math.round(height * dpr);
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      }
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);
      context.fillStyle = '#fff';
      // WebGL2 不可用时退回轻量点阵；不在移动端重复绘制重型 Canvas 地形。
      const drawMode = propsRef.current.backdropMode === 4 ? 0 : propsRef.current.backdropMode;

      if (drawMode === 0) {
        const step = width < 600 ? 34 : 42;
        const centerX = width * 0.52;
        const centerY = height * 0.43;
        const maxDistance = Math.hypot(width, height) * 0.58;
        for (let y = step * 0.5; y < height; y += step) {
          for (let x = step * 0.5; x < width; x += step) {
            const distance = Math.hypot(x - centerX, y - centerY);
            const falloff = Math.max(0, 1 - distance / maxDistance);
            const wave = Math.sin(distance * 0.04 - time * 3.2) * 0.5 + 0.5;
            dot(x, y, 0.42 + wave * 0.32 + (energy * 2.4 + beatPulse * 1.5) * falloff, 0.045 + falloff * 0.055 + (energy * 0.24 + beatPulse * 0.2) * falloff);
          }
        }
      } else if (drawMode === 1) {
        const centerX = width * 0.52;
        const centerY = height * 0.43;
        for (let ring = 1; ring <= 9; ring += 1) {
          const amount = 18 + ring * 8;
          const radiusX = ring / 9 * width * 0.56;
          const radiusY = ring / 9 * height * 0.44;
          for (let index = 0; index < amount; index += 1) {
            const angle = index / amount * Math.PI * 2 + time * (0.012 + ring * 0.001) * (ring % 2 ? 1 : -1);
            const lift = Math.sin(angle * 3 - time * 2.4) * (energy * 10 + beatPulse * 6);
            dot(centerX + Math.cos(angle) * radiusX, centerY + Math.sin(angle) * radiusY + lift, 0.45 + energy * 1.7 + beatPulse * 1.1, 0.05 + energy * 0.2 + beatPulse * 0.15);
          }
        }
      } else if (drawMode === 3) {
        sampleTopo(time, bassLevel, Math.max(trebleLevel * 0.6, hitHigh), energy, onset, onsetHigh);
        canvas.dataset.rhythm = topoRipples.length ? 'ripple' : 'bars';
        drawTopography(
          width, height, reducedMotion.matches ? 0 : time,
          bassLevel,
          Math.max(trebleLevel * 0.6, hitHigh)
        );
      } else {
        const amount = width < 600 ? 150 : 280;
        for (let index = 0; index < amount; index += 1) {
          const seedX = ((Math.sin(index * 91.417) * 43758.5453) % 1 + 1) % 1;
          const seedY = ((Math.sin(index * 47.853 + 2) * 24634.6345) % 1 + 1) % 1;
          const shimmer = Math.sin(time * (1.1 + seedX) + index) * 0.5 + 0.5;
          const drift = reducedMotion.matches ? 0 : Math.sin(time * 0.35 + index) * (2 + energy * 7 + beatPulse * 5);
          dot(seedX * width + drift, seedY * height, 0.4 + shimmer * 0.65 + energy * 1.8 + beatPulse * 1.2, 0.035 + shimmer * 0.08 + energy * 0.15 + beatPulse * 0.11);
        }
      }
      context.globalAlpha = 1;
    };

    const drawSphere = () => {
      const width = viewportWidth;
      const height = viewportHeight;
      const mobile = width < 600;
      const currentTrack = propsRef.current.current;
      const isPlaying = propsRef.current.playing;
      const revealingCards = dragging || performance.now() < revealCardsUntil;
      const gpuBackdrop = propsRef.current.backdropMode === 4 && !mobile;
      if (sphereLayoutDirty || layoutZoom !== propsRef.current.zoom) {
        const rect = universe.getBoundingClientRect();
        const firstCard = cardRefs.current.find(Boolean);
        const header = document.querySelector('header')?.getBoundingClientRect();
        const titlebar = document.querySelector('.desktop-titlebar')?.getBoundingClientRect();
        const player = document.querySelector('.player, .player-reveal')?.getBoundingClientRect();
        sphereLayout = fitCardSphere({ width, height,
          cardWidth: firstCard?.offsetWidth || 194, cardHeight: firstCard?.offsetHeight || 233,
          top: mobile ? Math.max(0, (header?.bottom || rect.top) - rect.top) + 12
            : Math.max(12, (titlebar?.bottom ?? rect.top) - rect.top + 4),
          bottom: mobile ? Math.min(height, (player?.top ?? rect.bottom) - rect.top) - 12 : height - 12,
          zoom: propsRef.current.zoom, mobile,
        });
        sphereAnchorX = firstCard?.offsetLeft ?? width / 2;
        sphereAnchorY = firstCard?.offsetTop ?? height * .42;
        layoutZoom = propsRef.current.zoom;
        sphereLayoutDirty = false;
      }
      const { radiusX } = sphereLayout;
      coordinates.forEach((card, index) => {
        const element = cardRefs.current[index];
        if (!element) return;
        const cache = cardFrameCache[index] || (cardFrameCache[index] = {});
        const setStyle = (key, value) => {
          if (cache[key] === value) return;
          cache[key] = value;
          element.style[key] = value;
        };
        const angle = card.lon + rotation;
        const x = Math.cos(card.lat) * Math.sin(angle);
        const z = Math.cos(card.lat) * Math.cos(angle);
        const y = Math.sin(card.lat);
        const projectedY = y * Math.cos(tilt) - z * Math.sin(tilt);
        const depth = y * Math.sin(tilt) + z * Math.cos(tilt);
        const active = card.track.id === currentTrack && isPlaying;
        // 正在播的那张卡片跟着节拍一起呼吸
        const scale = (0.36 + (depth + 1) * 0.31) * (active ? 1.05 + beatPulse * 0.045 : 1) * sphereLayout.scale;
        const yaw = x * -16;
        const cardY = projectCardY(sphereLayout, projectedY, scale, yaw);
        setStyle('transform', `translate3d(-50%,-50%,0) translate3d(${(x * radiusX + sphereLayout.centerX - sphereAnchorX).toFixed(2)}px,${(cardY + sphereLayout.centerY - sphereAnchorY).toFixed(2)}px,0) scale(${scale.toFixed(4)}) rotateY(${yaw.toFixed(2)}deg) rotateZ(${(x * projectedY * 5).toFixed(2)}deg)`);
        if (active && !dragging) {
          setStyle('boxShadow', `0 12px 35px #0008, 0 0 0 2px #ffffff3d, 0 0 ${(16 + beatPulse * 34).toFixed(1)}px rgba(255,255,255,${(0.06 + beatPulse * 0.2).toFixed(3)})`);
          element.dataset.glow = '1';
        } else if (element.dataset.glow) {
          setStyle('boxShadow', '');
          delete element.dataset.glow;
        }
        // 背面卡片直接淡到不可见，避免在正面卡片后面堆成一列。
        // 移动端卡片更密、屏幕更小，用更陡的三次方曲线：只有最前一层保持清晰，
        // 后面的卡片大幅透明，不然整个画面糊成一团。
        const fade = Math.max(0, Math.min(1, (depth + 0.5) / 1.5));
        // GPU 地形模式的背景又亮又有纹理，原本 0.05 起步的透明度会让其他卡片几乎看不见，
        // 所以这条分支里整体抬高下限、放缓衰减；其余模式维持原来的景深淡出。
        let alpha;
        if (gpuBackdrop) {
          const floor = mobile ? 0.3 : 0.38;
          alpha = floor + Math.pow(fade, 1.4) * (1 - floor);
        } else {
          alpha = mobile ? 0.04 + fade * fade * fade * 0.96 : 0.05 + fade * fade * 0.85;
        }
        // 播放时当前卡片保持突出，其余卡片只降低不透明度并保留原有景深，
        // 让用户仍能看见完整的歌曲球面分布。
        if (isPlaying && !revealingCards) alpha = active ? 0.74 : 0.08 + alpha * 0.16;
        setStyle('opacity', alpha.toFixed(3));
        setStyle('visibility', (!active && !isPlaying && fade <= 0.002) ? 'hidden' : 'visible');
        const brightFloor = gpuBackdrop ? (mobile ? 0.55 : 0.62) : (mobile ? 0.4 : 0.45);
        setStyle('filter', dragging ? '' : `brightness(${(brightFloor + (depth + 1) * (mobile ? 0.25 : 0.3)).toFixed(2)})`);
        // Browse in depth order rather than letting a playing card on the
        // back of the sphere cover a new track that has rotated in front.
        setStyle('zIndex', String(active && !revealingCards ? 90 : Math.round((depth + 1) * 30) + 1));
        const interactive = (active && !revealingCards) || depth >= -0.3;
        setStyle('pointerEvents', interactive ? 'auto' : 'none');
        const tabIndex = interactive ? 0 : -1;
        if (cache.tabIndex !== tabIndex) {
          cache.tabIndex = tabIndex;
          element.tabIndex = tabIndex;
        }
      });
    };

    const animate = timestamp => {
      animationFrame = 0;
      if (!visualsActive) return;
      const dt = Math.min(timestamp - lastFrame || 16, 32);
      lastFrame = timestamp;
      // 直接点播放（没换歌）也要把镜头转到正在播的那首，否则按了播放却看不见它在哪。
      if (propsRef.current.playing && !wasPlaying && !dragging) {
        focusedTrack = propsRef.current.current;
        focusTrack(focusedTrack);
      }
      wasPlaying = propsRef.current.playing;
      // 播放时也允许自由拖着浏览：只在「换歌」的瞬间自动对焦，
      // 不再每帧把镜头硬拽回当前曲目（那样一松手就被拉回去，等于没法翻）。
      if (focusedTrack !== propsRef.current.current) {
        focusedTrack = propsRef.current.current;
        if (!dragging) focusTrack(focusedTrack);
      }
      if (!dragging) {
        if (focusing) {
          const easing = 1 - Math.pow(0.001, dt / 420);
          rotation += (focusRotation - rotation) * easing;
          tilt += (focusTilt - tilt) * easing;
          if (Math.abs(focusRotation - rotation) < 0.001 && Math.abs(focusTilt - tilt) < 0.001) focusing = false;
        } else if (autoRotate && !propsRef.current.playing) {
          rotation += dt * 0.000022;
        }
        if (!focusing && (Math.abs(velocityX) > 0.000001 || Math.abs(velocityY) > 0.000001)) {
          rotation += velocityX * dt;
          tilt = clamp(tilt + velocityY * dt, -tiltLimit, tiltLimit);
          const friction = Math.pow(0.91, dt / 16.67);
          velocityX *= friction;
          velocityY *= friction;
        }
      }
      // 卡片与地形都保持逐帧更新；交互期的 GPU 预算由地形内部动态降级承担。
      drawSoundfield(timestamp, dt / 1000);
      drawSphere();
      if (visualsActive) animationFrame = requestAnimationFrame(animate);
    };

    const syncVisualActivity = () => {
      const next = desktopVisualActive && !document.hidden;
      if (next === visualsActive) return;
      visualsActive = next;
      if (!visualsActive) {
        if (animationFrame) cancelAnimationFrame(animationFrame);
        animationFrame = 0;
        return;
      }
      lastFrame = performance.now();
      if (!animationFrame) animationFrame = requestAnimationFrame(animate);
    };
    const onVisibilityChange = () => syncVisualActivity();
    const stopDesktopVisualListener = window.orbitDesktop?.onVisualActivity?.(active => {
      desktopVisualActive = active;
      syncVisualActivity();
    });

    const startDrag = event => {
      if (event.button !== 0 || event.target.closest('.view-controls')) return;
      ignoreDragClick.current = false;
      dragging = true;
      pointerId = event.pointerId;
      lastX = event.clientX;
      lastY = event.clientY;
      lastPointerTime = event.timeStamp;
      moved = 0;
      velocityX = 0;
      velocityY = 0;
      focusing = false;
      revealCardsUntil = Infinity;
      // 又上手拖了，取消上一次的「转回当前歌曲」倒计时
      clearTimeout(refocusTimer);
      universe.classList.add('dragging');
      captureTarget = event.target.closest('.card') || universe;
      captureTarget.setPointerCapture(event.pointerId);
    };
    const moveDrag = event => {
      if (!dragging || event.pointerId !== pointerId) return;
      // 高频触摸屏一次事件可能塞进十几个历史采样；逐个重算会挤占渲染帧。
      // 旋转只需要最新位置，速度也用整段位移计算，手感保持一致但工作量固定。
      const samples = event.getCoalescedEvents?.();
      const sample = samples?.length ? samples[samples.length - 1] : event;
      const dx = sample.clientX - lastX;
      const dy = sample.clientY - lastY;
      const dt = Math.max(1, sample.timeStamp - lastPointerTime);
      moved += Math.hypot(dx, dy);
      rotation += dx * 0.004;
      tilt = clamp(tilt - dy * 0.002, -tiltLimit, tiltLimit);
      velocityX = velocityX * 0.68 + dx / dt * 0.004 * 0.32;
      velocityY = velocityY * 0.68 - dy / dt * 0.002 * 0.32;
      lastX = sample.clientX;
      lastY = sample.clientY;
      lastPointerTime = sample.timeStamp;
    };
    const endDrag = event => {
      if (!dragging || event.pointerId !== pointerId) return;
      dragging = false;
      ignoreDragClick.current = moved > 7 || event.type === 'pointercancel';
      if (reducedMotion.matches) {
        velocityX = 0;
        velocityY = 0;
      }
      universe.classList.remove('dragging');
      revealCardsUntil = performance.now() + 2200;
      try { captureTarget?.releasePointerCapture(event.pointerId); } catch { /* pointer already released */ }
      captureTarget = null;
      pointerId = null;
      // 播放中松手后先让你随便看，3 秒内没拖到别的歌（也没点开别的卡）
      // 就平滑转回正在播的那首；中途切了歌则以新的当前曲目为准。
      clearTimeout(refocusTimer);
      if (propsRef.current.playing) {
        refocusTimer = setTimeout(() => {
          if (dragging) return;
          focusedTrack = propsRef.current.current;
          focusTrack(propsRef.current.current);
        }, 3000);
      }
    };
    const preventSelection = event => event.preventDefault();
    const onKeyDown = event => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault();
      rotation += event.key === 'ArrowLeft' ? -0.15 : event.key === 'ArrowRight' ? 0.15 : 0;
      focusing = false;
      tilt = clamp(tilt + (event.key === 'ArrowUp' ? -0.1 : event.key === 'ArrowDown' ? 0.1 : 0), -tiltLimit, tiltLimit);
    };
    const toggleRotate = event => {
      autoRotate = !autoRotate;
      event.currentTarget.style.opacity = autoRotate ? 1 : 0.4;
      event.currentTarget.setAttribute('aria-label', autoRotate ? '暂停自动旋转' : '开启自动旋转');
      onRotateToast(autoRotate ? '自动旋转已开启' : '自动旋转已暂停');
    };

    universe.addEventListener('pointerdown', startDrag);
    universe.addEventListener('pointermove', moveDrag);
    universe.addEventListener('pointerup', endDrag);
    universe.addEventListener('pointercancel', endDrag);
    universe.addEventListener('selectstart', preventSelection);
    universe.addEventListener('dragstart', preventSelection);
    universe.addEventListener('keydown', onKeyDown);
    document.getElementById('rotate')?.addEventListener('click', toggleRotate);
    document.addEventListener('visibilitychange', onVisibilityChange);
    if (visualsActive) animationFrame = requestAnimationFrame(animate);
    return () => {
      cancelAnimationFrame(animationFrame);
      clearTimeout(refocusTimer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      stopDesktopVisualListener?.();
      resizeObserver.disconnect();
      layoutObserver.disconnect();
      // 离开宇宙视图时把节拍值归零，免得停在某一帧的亮度上
      document.getElementById('lyrics-panel')?.style.setProperty('--beat', '0');
      universe.removeEventListener('pointerdown', startDrag);
      universe.removeEventListener('pointermove', moveDrag);
      universe.removeEventListener('pointerup', endDrag);
      universe.removeEventListener('pointercancel', endDrag);
      universe.removeEventListener('selectstart', preventSelection);
      universe.removeEventListener('dragstart', preventSelection);
      universe.removeEventListener('keydown', onKeyDown);
      document.getElementById('rotate')?.removeEventListener('click', toggleRotate);
    };
  }, [analysisRef, canvasRef, coordinates, onRotateToast]);

  return (
    <main ref={universeRef} id="universe" aria-label="拖动旋转歌单宇宙" tabIndex="0">
      <div className="ambient" /><div className="orbit-line one" /><div className="orbit-line two" />
      {tracks[current] ? (
        <LyricsPanel track={tracks[current]} trackNumber={current + 1} currentTime={currentTime} duration={duration} playing={playing} audioRef={audioRef} analysisRef={analysisRef} lyricsVersion={lyricsVersion} />
      ) : (
        <div className="empty-universe">
          <span className="eyebrow">ORBIT DESKTOP / EMPTY LIBRARY</span>
          <h1>你的音乐宇宙，<br />从第一首导入开始。</h1>
          <p>从 QQ 音乐、网易云音乐或酷狗音乐搜索歌曲、导入歌单。</p>
          <button className="empty-import" onClick={onOpenBridge}>登录或导入歌曲 <span>↗</span></button>
        </div>
      )}
      <div id="sphere">
        {coordinates.map(({ track }, index) => (
          <button
            className={`card ${track.id === current && playing ? 'active' : ''}`}
            type="button"
            data-track={track.id}
            aria-label={`播放歌曲：${track.title}`}
            key={track.id}
            ref={element => { cardRefs.current[index] = element; }}
            onClick={event => {
              if (event.detail > 0 && ignoreDragClick.current) {
                event.preventDefault();
                return;
              }
              if (!playing || track.id !== current) onSelect(track.id, true);
            }}
          >
            <LiquidArt src={track.cover} className="card-art" />
            <span className="card-play"><Icon name="play" /></span>
            <span className="caption"><strong>{track.title}</strong><CardArtistTicker artist={track.artist || '未知歌手'} /></span>
          </button>
        ))}
      </div>
      <div className="side-label">ORBIT · USER IMPORTED MUSIC ARCHIVE</div>
      <div className="coordinates">{IS_DESKTOP_APP ? 'USER IMPORTED AUDIO' : 'FULL LOCAL AUDIO'}<br />{tracks.length} TRACKS</div>
    </main>
  );
}
