import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { tracks } from './tracks.js';
import { invalidateLrc, prefetchLrc, waitForLrc } from './lyrics.js';
import GlassSurface from './GlassSurface.jsx';
import GlassBackdrop from './GlassBackdrop.jsx';
import MusicBridge from './MusicBridge.jsx';
import {
  readDisplayMusicAccount, resolveActiveAccountState, saveDisplayMusicAccount,
  useKugouAccount, useLocalQQAvatar, useMusicAccount,
} from './musicAccounts.js';
import {
  clearQQTracks, importQQPlaylist, listQQPlaylists,
  getActivePlaylistId, removeQQPlaylist, switchQQPlaylist,
  QQ_QUALITY_KEY, readQQQuality,
} from './qqLibrary.js';
import {
  clearNeteaseTracks, getActiveNeteasePlaylistId, importNeteaseTracks,
  listNeteasePlaylists, switchNeteasePlaylist,
} from './neteaseLibrary.js';
import {
  clearKugouTracks, getActiveKugouPlaylistId, importKugouTracks, listKugouPlaylists, switchKugouPlaylist,
} from './kugouLibrary.js';
import {
  getActiveLocalPlaylistId, importLocalAudioFiles, listLocalPlaylists, switchLocalPlaylist,
} from './localLibrary.js';
import { BeatEngine } from './beatEngine.js';
import { applySink, listOutputs, readBeatOffset, readOutputPref, requestDeviceLabels, saveBeatOffset, saveOutputPref } from './audioOut.js';
import { clearProviderPlayback, forgetPlaylistPlayback, playbackTrackKey, readLastTrack, resumeAt, saveLastTrack, saveProgress } from './playbackMemory.js';
import { createAudioPrefetcher } from './boundedCache.js';
import {
  bindMediaSessionHandlers,
  syncMediaSessionMetadata,
  syncMediaSessionPlaybackState,
  syncMediaSessionPosition,
} from './mediaSession.js';
import { formatTime, SvgDefs } from './OrbitIcons.jsx';
import { Header, UpdateBadge, useUpdater } from './OrbitHeader.jsx';
import Universe from './Universe.jsx';
import { DetailDialog, Journal, Player } from './PlayerBar.jsx';
import { canUseTerrainGL, clamp, IS_DESKTOP_APP, isHandheld } from './runtimeEnv.js';

if (IS_DESKTOP_APP) tracks.splice(0, tracks.length);
const ACTIVE_LIBRARY_KEY = 'orbit.activePlaylist.v1';
const BACKDROP_MODE_KEY = 'orbit.backdropMode.v1';
const importedPlaylistKey = (provider, id) => (id ? `${provider}:${id}` : null);
const importedLibraries = new Map([
  ['qq', { list: listQQPlaylists, active: getActivePlaylistId, select: switchQQPlaylist }],
  ['netease', { list: listNeteasePlaylists, active: getActiveNeteasePlaylistId, select: switchNeteasePlaylist }],
  ['kugou', { list: listKugouPlaylists, active: getActiveKugouPlaylistId, select: switchKugouPlaylist }],
  ['localfile', { list: listLocalPlaylists, active: getActiveLocalPlaylistId, select: switchLocalPlaylist }],
]);
const removeImportedTracks = library => {
  for (let index = library.length - 1; index >= 0; index -= 1) {
    if (importedLibraries.has(library[index]?.provider)) library.splice(index, 1);
  }
  library.forEach((track, index) => { track.id = index; });
};

// Only one imported playlist is shown, regardless of its music provider.
function fallbackPlaylistKey(excluded) {
  for (const [provider, library] of importedLibraries) {
    if (provider === excluded) continue;
    const id = library.active() || library.list()[0]?.id;
    if (id) return importedPlaylistKey(provider, id);
  }
  return null;
}

function parsePlaylistKey(key) {
  const [provider, ...parts] = String(key || '').split(':');
  return { provider, id: parts.join(':'), library: importedLibraries.get(provider) };
}

function switchImportedTracks(key) {
  const { id, library } = parsePlaylistKey(key);
  removeImportedTracks(tracks);
  return library?.select(tracks, id);
}

let initialActiveLibrary = null;
try { initialActiveLibrary = localStorage.getItem(ACTIVE_LIBRARY_KEY); } catch { /* ignore */ }
const storedPlaylist = parsePlaylistKey(initialActiveLibrary);
if (!storedPlaylist.library?.list().some(item => item.id === storedPlaylist.id)) {
  initialActiveLibrary = fallbackPlaylistKey();
}
if (initialActiveLibrary) switchImportedTracks(initialActiveLibrary);

// 模式 4 是 GPU 地形：走独立的 WebGL 画布，前面四种仍是原来的 Canvas 2D 画法
const backdropNames = ['声波地形', '光门走廊', '镜面水波'];

function readBackdropMode() {
  try {
    const value = Number(localStorage.getItem(BACKDROP_MODE_KEY));
    return Number.isInteger(value) && value >= 0 && value < backdropNames.length ? value : 0;
  } catch {
    return 0;
  }
}

// QQ 音乐走的是本地代理地址 /api/qq/audio?mid=..&quality=xxx，音质只是 URL 上的一个参数，
// 所以切换音质改这个参数即可，不用重新导歌。
// 档位表本身放在 qqLibrary.js —— 拼播放地址时也要用它，不能两个地方各写一份。
function swapQQQuality(src, quality) {
  try {
    const url = new URL(src, location.href);
    url.searchParams.set('quality', quality);
    return `${url.pathname}${url.search}`;
  } catch { return src; }
}

// 音源是否已经有足够数据连续播放（HAVE_FUTURE_DATA 及以上）
function waitUntilPlayable(audio, timeout = 8000) {
  if (!audio || audio.readyState >= 3) return Promise.resolve();
  return new Promise(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      audio.removeEventListener('canplay', finish);
      audio.removeEventListener('canplaythrough', finish);
      audio.removeEventListener('loadedmetadata', check);
      audio.removeEventListener('error', finish);
      resolve();
    };
    const check = () => { if (audio.readyState >= 3) finish(); };
    const timer = setTimeout(finish, timeout);
    audio.addEventListener('canplay', finish);
    audio.addEventListener('canplaythrough', finish);
    audio.addEventListener('loadedmetadata', check);
    audio.addEventListener('error', finish);
  });
}

// 提前把下一首的音频拉进浏览器缓存，切歌时不用从头下；限制容量避免长时间播放内存膨胀
const audioPrefetcher = createAudioPrefetcher({ maxEntries: 3 });
function prefetchAudio(src) {
  audioPrefetcher.prefetch(src);
}

function disposeAudioAnalysis(analysis) {
  if (!analysis) return;
  try { analysis.engine?.dispose?.(); } catch { /* ignore */ }
  try { analysis.source?.disconnect?.(); } catch { /* ignore */ }
  try { analysis.analyser?.disconnect?.(); } catch { /* ignore */ }
  try { analysis.fine?.disconnect?.(); } catch { /* ignore */ }
  const context = analysis.context;
  if (context && context.state !== 'closed') {
    context.close?.().catch?.(() => {});
  }
  analysis.context = null;
  analysis.analyser = null;
  analysis.source = null;
  analysis.fine = null;
  analysis.fineBins = null;
  analysis.spectrum = null;
  analysis.engine = null;
  if (import.meta.env.DEV && typeof window !== 'undefined' && window.__orbitBeat) {
    delete window.__orbitBeat;
  }
}

// ColorOS/老 WebView 对刚加载的 MP3 偶尔会先给 Infinity 或按已下载字节估算出错误时长。
// 优先使用可信的原生时长；偏差明显时退回 tracks.js 里从文件元数据读取的真实时长。
function resolveMediaDuration(audio, expected = 0) {
  const fallback = Number(expected);
  const nativeDuration = Number(audio?.duration);
  const tolerance = fallback > 0 ? Math.max(3, fallback * 0.025) : Infinity;
  if (Number.isFinite(nativeDuration) && nativeDuration > 0) {
    if (!(fallback > 0) || Math.abs(nativeDuration - fallback) <= tolerance) return nativeDuration;
  }
  try {
    if (audio?.seekable?.length) {
      const seekableEnd = Number(audio.seekable.end(audio.seekable.length - 1));
      if (Number.isFinite(seekableEnd) && seekableEnd > 0) {
        if (!(fallback > 0) || Math.abs(seekableEnd - fallback) <= tolerance) return seekableEnd;
      }
    }
  } catch { /* 某些内核在 metadata 未稳定时读取 seekable 会抛异常 */ }
  if (Number.isFinite(fallback) && fallback > 0) return fallback;
  return Number.isFinite(nativeDuration) && nativeDuration > 0 ? nativeDuration : 0;
}

export default function App() {
  const audioRef = useRef(null);
  const canvasRef = useRef(null);
  const glCanvasRef = useRef(null);
  const soundfield = useMemo(() => ({ canvasRef, glCanvasRef }), []);
  const toastTimer = useRef(null);
  const analysisRef = useRef({
    context: null, analyser: null, spectrum: null, source: null,
    fine: null, fineBins: null, engine: null,
    energy: 0, beat: 0, bass: 0, treble: 0, beatHigh: 0, lowLatency: false,
  });
  const [journal, setJournal] = useState(false);
  const [bridgeOpen, setBridgeOpen] = useState(false);
  const [bridgeProvider, setBridgeProvider] = useState(() => parsePlaylistKey(initialActiveLibrary).provider || 'qq');
  const [browseAccountPlaylists, setBrowseAccountPlaylists] = useState(false);
  const [displayAccount, setDisplayAccount] = useState(readDisplayMusicAccount);
  const chooseDisplayAccount = useCallback(provider => {
    setDisplayAccount(provider);
    saveDisplayMusicAccount(provider);
  }, []);
  const openBridge = useCallback((provider, browsePlaylists = false) => {
    if (provider) setBridgeProvider(provider);
    setBrowseAccountPlaylists(browsePlaylists);
    setBridgeOpen(true);
  }, []);
  const closeBridge = useCallback(() => setBridgeOpen(false), []);
  const qqProfileAccount = useMusicAccount('qq');
  const qqAccount = useLocalQQAvatar(qqProfileAccount);
  const neteaseAccount = useMusicAccount('netease');
  const kugouAccount = useKugouAccount();
  const updateQQAccount = qqAccount.update;
  const updateNeteaseAccount = neteaseAccount.update;
  const updater = useUpdater();
  // 导入的歌单列表 + 当前生效的那个（null 表示「全部」）
  const [qqPlaylists, setQQPlaylists] = useState(listQQPlaylists);
  const [activePlaylist, setActivePlaylist] = useState(getActivePlaylistId);
  const [neteasePlaylists, setNeteasePlaylists] = useState(listNeteasePlaylists);
  const [kugouPlaylists, setKugouPlaylists] = useState(listKugouPlaylists);
  const [localPlaylists, setLocalPlaylists] = useState(listLocalPlaylists);
  const [dragActive, setDragActive] = useState(false);
  const [activeLibrary, setActiveLibrary] = useState(initialActiveLibrary);
  const combinedPlaylists = useMemo(() => [
    ...qqPlaylists.map(item => ({ ...item, id: importedPlaylistKey('qq', item.id), rawId: item.id, provider: 'qq' })),
    ...neteasePlaylists.map(item => ({ ...item, id: importedPlaylistKey('netease', item.id), rawId: item.id, provider: 'netease' })),
    ...kugouPlaylists.map(item => ({ ...item, id: importedPlaylistKey('kugou', item.id), rawId: item.id, provider: 'kugou' })),
    ...localPlaylists.map(item => ({ ...item, id: importedPlaylistKey('localfile', item.id), rawId: item.id, provider: 'localfile' })),
  ], [kugouPlaylists, localPlaylists, neteasePlaylists, qqPlaylists]);
  // 曲库版本号：只要重建过 tracks 就自增。不能用 tracks.length——
  // 两个歌单都是 30 首时长度不变，依赖它的 useMemo 不会重算，卡片就不跟着切。
  const [libraryVersion, setLibraryVersion] = useState(0);
  const [current, setCurrent] = useState(() => readLastTrack(initialActiveLibrary, tracks));
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  // 首屏先用文件元数据中的真实时长，避免移动端要等整个 MP3 元数据稳定后才出现进度条。
  const [duration, setDuration] = useState(() => tracks[current]?.duration || 0);
  const [random, setRandom] = useState(false);
  const [repeat, setRepeat] = useState(false);
  const [liked, setLiked] = useState(() => new Set());
  const [volume, setVolume] = useState(0.65);
  const [muted, setMuted] = useState(false);
  const [selected, setSelected] = useState(null);
  const [toastText, setToastText] = useState('');
  // 记忆上次选择的 3D 律动背景，点击右下角 ✦ 在三套 3D 律动背景间轮换。
  const [backdropMode, setBackdropMode] = useState(readBackdropMode);
  const [zoom, setZoom] = useState(1);
  const [preparing, setPreparing] = useState(false);
  const [lyricsVersion, setLyricsVersion] = useState(0);
  const [outputPref, setOutputPref] = useState(readOutputPref);
  const [beatOffset, setBeatOffset] = useState(readBeatOffset);
  const [outputs, setOutputs] = useState([]);
  const [outputMenu, setOutputMenu] = useState(false);
  const [qqQuality, setQQQuality] = useState(readQQQuality);
  const [qualityBusy, setQualityBusy] = useState(false);
  const [playerHidden, setPlayerHidden] = useState(false);
  const currentRef = useRef(current);
  const mediaRef = useRef(null);
  const preparingRef = useRef(null);
  // QQ 音源报错只提示一次（同一首歌反复点播放不重复弹）
  const qqErrorShownRef = useRef(null);
  const slowHintTimer = useRef(null);
  const outputPrefRef = useRef(outputPref);
  outputPrefRef.current = outputPref;
  const playingRef = useRef(false);
  playingRef.current = playing;
  const mediaSessionSyncedAtRef = useRef(0);
  const mediaActionsRef = useRef(null);
  const syncMediaPosition = useCallback((audio, force = false) => {
    if (typeof navigator === 'undefined' || !navigator.mediaSession) return;
    const now = performance.now();
    if (!force && now - mediaSessionSyncedAtRef.current < 900) return;
    mediaSessionSyncedAtRef.current = now;
    const media = mediaRef.current;
    const total = audio ? resolveMediaDuration(audio, media?.duration) : 0;
    const pos = media?.pendingPosition !== undefined ? media.pendingPosition : (audio?.currentTime || 0);
    syncMediaSessionPosition(navigator.mediaSession, {
      duration: total,
      position: pos,
      playbackRate: audio?.playbackRate || 1,
    });
  }, []);
  const syncDuration = useCallback(audio => {
    const media = mediaRef.current;
    if (!media || audio.currentSrc !== media.src) return 0;
    const next = resolveMediaDuration(audio, media.duration);
    if (next > 0) {
      setDuration(next);
      syncMediaPosition(audio, true);
    }
    return next;
  }, [syncMediaPosition]);

  const showToast = useCallback(message => {
    setToastText(message);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastText(''), 2200);
  }, []);

  useEffect(() => () => { clearTimeout(toastTimer.current); clearTimeout(slowHintTimer.current); }, []);

  const persistPlayback = useCallback((audio, force = false) => {
    const media = mediaRef.current;
    if (!media || media.pendingPosition !== undefined || audio.readyState < 1 || audio.currentSrc !== media.src) return;
    const now = performance.now();
    if (!force && now - media.savedAt < 2000) return;
    saveProgress(media.key, audio.ended ? 0 : audio.currentTime);
    media.savedAt = now;
  }, []);

  const loadTrackAudio = useCallback((track, playlist) => {
    const audio = audioRef.current;
    // The track list may already have been rebuilt. Save against the audio's
    // own identity, which still belongs to the outgoing song.
    persistPlayback(audio, true);
    setCurrentTime(0);
    setDuration(track?.duration || 0);
    if (!track?.src) {
      mediaRef.current = null;
      audio.removeAttribute('src');
    } else if (track.provider === 'kugou' && window.orbitDesktop?.resolveKugouAudio) {
      // 桌面端酷狗音源需在点播时由主进程按当前登录态解析并注册到本地代理，
      // 选歌阶段先记录曲目上下文，避免未解析前预拉 /api/kugou/audio 触发 404 误报。
      const resolvedSrc = new URL(track.src, document.baseURI).href;
      audio.removeAttribute('src');
      mediaRef.current = {
        key: playbackTrackKey(track),
        playlist,
        src: resolvedSrc,
        duration: track.duration,
        pendingPosition: null,
        savedAt: 0,
      };
    } else {
      audio.src = track.src;
      mediaRef.current = {
        key: playbackTrackKey(track),
        playlist,
        src: audio.src,
        duration: track.duration,
        pendingPosition: null,
        savedAt: 0,
      };
    }
    audio.load();
    prefetchLrc(track?.lyrics);
  }, [persistPlayback]);

  const restorePosition = useCallback(audio => {
    const duration = syncDuration(audio);
    const media = mediaRef.current;
    if (!media || media.pendingPosition === undefined || audio.readyState < 1 || audio.currentSrc !== media.src) return;
    const position = media.pendingPosition ?? resumeAt(media.key, duration);
    if (position > 0) audio.currentTime = duration > 0 ? Math.min(position, duration) : position;
    media.pendingPosition = undefined;
    setCurrentTime(audio.currentTime);
  }, [syncDuration]);

  const reloadTrackAudio = useCallback((audio, media, src = media.src) => {
    persistPlayback(audio, true);
    if (media.pendingPosition === undefined) media.pendingPosition = audio.ended ? 0 : audio.currentTime;
    if (src !== audio.src) audio.src = src;
    media.src = audio.src;
    audio.load();
  }, [persistPlayback]);

  const cancelPlaybackPreparation = useCallback(() => {
    preparingRef.current = null;
    clearTimeout(slowHintTimer.current);
    setPreparing(false);
  }, []);

  useEffect(() => {
    const audio = audioRef.current;
    const initial = currentRef.current;
    if (!tracks[initial]) return;
    loadTrackAudio(tracks[initial], initialActiveLibrary);
    audio.volume = 0.65;
    // 首屏就把当前歌词和下一首准备好，点播放时基本不用再等
    prefetchLrc(tracks[(initial + 1) % tracks.length].lyrics);
    // 上次选了具体输出设备的话，启动时就把它接回去（此时还没被 Web Audio 接管，元素级即可）
    if (outputPrefRef.current.deviceId) {
      applySink(audio, null, outputPrefRef.current.deviceId).then(ok => {
        if (!ok) showToast('上次的输出设备不可用，已回到系统默认');
      });
    }
  }, [loadTrackAudio, showToast]);

  useEffect(() => {
    const audio = audioRef.current;
    const save = () => persistPlayback(audio, true);
    const onVisibilityChange = () => { if (document.hidden) save(); };
    window.addEventListener('pagehide', save);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('pagehide', save);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [persistPlayback]);

  // 音源中断后自动重连：蓝牙/外接设备回来、文件未就绪时兜底重新拉取
  const reconnect = useCallback(() => {
    const audio = audioRef.current;
    const media = mediaRef.current;
    if (!playingRef.current || !media || media.pendingPosition !== undefined) return;
    reloadTrackAudio(audio, media);
    waitUntilPlayable(audio).then(() => {
      if (mediaRef.current !== media || audio.readyState < 3) return;
      restorePosition(audio);
      audio.play().then(() => showToast(`已从 ${formatTime(audio.currentTime)} 继续播放`)).catch(() => {});
    });
  }, [reloadTrackAudio, restorePosition, showToast]);

  // 外接设备插拔变化时：如果之前选中的设备没了（蓝牙断开），自动退回系统默认，
  // 否则会卡在一个已经不存在的输出口上，整页都没声音。
  useEffect(() => {
    if (!navigator.mediaDevices?.addEventListener) return;
    const sync = async () => {
      const devices = await listOutputs();
      setOutputs(devices);
      if (!outputPrefRef.current.deviceId) return;
      if (devices.some(item => item.id === outputPrefRef.current.deviceId)) return;
      const next = { ...outputPrefRef.current, deviceId: '' };
      saveOutputPref(next);
      setOutputPref(next);
      await applySink(audioRef.current, analysisRef.current.context, '');
      showToast('原来的输出设备已断开，已切回系统默认');
    };
    navigator.mediaDevices.addEventListener('devicechange', sync);
    return () => navigator.mediaDevices.removeEventListener('devicechange', sync);
  }, [showToast]);

  // 安卓特性：切到后台（来电话、切 App、锁屏）时系统会掐掉音频渲染线程，
  // 回到前台后 AudioContext 常常停在 suspended，表现为「进度在走、画面不动、也没声」。
  // 这里在页面重新可见时补一次 resume。
  useEffect(() => {
    const wake = () => {
      const context = analysisRef.current.context;
      if (context && context.state !== 'running' && !audioRef.current.paused) {
        context.resume?.().catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('focus', wake);
    return () => {
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('focus', wake);
    };
  }, []);

  // 应用卸载时释放 Web Audio 上下文与预加载音频探测实例
  useEffect(() => () => {
    disposeAudioAnalysis(analysisRef.current);
    audioPrefetcher.clear();
  }, []);

  // 播放期间保持屏幕常亮：桌面应用走 Electron 的系统级阻止息屏，
  // 浏览器和安卓车机走 Screen Wake Lock，并在页面重新可见时自动补领。
  useEffect(() => {
    let wakeLock = null;
    let cancelled = false;
    const desktopKeepAwake = window.orbitDesktop?.setKeepAwake;
    if (desktopKeepAwake) {
      desktopKeepAwake(playing).catch(() => {});
      return () => { desktopKeepAwake(false).catch(() => {}); };
    }

    const requestWakeLock = async () => {
      if (cancelled || !playing || document.visibilityState !== 'visible' || !navigator.wakeLock?.request || wakeLock) return;
      try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; }, { once: true });
      } catch { /* 系统省电模式或内核不支持时保持正常播放 */ }
    };
    const onVisibility = () => { if (document.visibilityState === 'visible') requestWakeLock(); };
    requestWakeLock();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      wakeLock?.release?.().catch(() => {});
      wakeLock = null;
    };
  }, [playing]);

  useEffect(() => {
    document.body.classList.toggle('player-collapsed', playerHidden);
    return () => document.body.classList.remove('player-collapsed');
  }, [playerHidden]);

  const openOutputMenu = async () => {
    const nextOpen = !outputMenu;
    setOutputMenu(nextOpen);
    if (!nextOpen) return;
    let devices = await listOutputs();
    // Chrome 不给标签就拿不到设备名，先申请一次麦克风权限（拿完立刻停掉录音）
    if (devices.every(item => /未命名|^\s*$/.test(item.label))) {
      await requestDeviceLabels();
      devices = await listOutputs();
    }
    setOutputs(devices);
  };

  // 蓝牙耳机那段延迟 Web Audio 看不见，画面和鼓点对不上时靠这里手动补
  const adjustBeatOffset = delta => {
    const next = clamp(Math.round((beatOffset + delta) * 1000) / 1000, -0.3, 0.3);
    setBeatOffset(next);
    saveBeatOffset(next);
    analysisRef.current.engine?.setManualOffset(next);
    showToast(next === 0 ? '律动同步已复位' : `画面${next > 0 ? '延后' : '提前'} ${Math.round(Math.abs(next) * 1000)} 毫秒`);
  };

  const chooseOutput = async patch => {
    setOutputMenu(false);
    const next = { ...outputPref, ...patch };
    if (next.mode === outputPref.mode && next.deviceId === outputPref.deviceId) return;
    saveOutputPref(next);
    const taken = Boolean(analysisRef.current.context);
    // 音频被接管之后没法原地还原成原生路由（浏览器限制），这里刻意不 reload：
    // 强制刷新会打断外接音箱和蓝牙的连接。模式本来就不持久化，刷新后自然回到律动。
    if (next.mode === 'direct' && taken) {
      showToast('音频已被律动接管，刷新页面后可按原生输出播放');
      return;
    }
    setOutputPref(next);
    if (next.mode === 'direct') {
      showToast('已切到原生输出，律动暂停；刷新页面后恢复默认律动');
      return;
    }
    if (next.mode === 'viz' && !outputPref.deviceId) {
      showToast('已恢复律动可视化，下次播放生效');
      return;
    }
    const ok = await applySink(audioRef.current, analysisRef.current.context, next.deviceId);
    if (!ok) {
      const fallback = { ...next, deviceId: '' };
      saveOutputPref(fallback);
      setOutputPref(fallback);
      applySink(audioRef.current, analysisRef.current.context, '');
      showToast('这个设备切不过去，已保持系统默认');
      return;
    }
    const picked = outputs.find(item => item.id === next.deviceId);
    showToast(picked ? `输出到「${picked.label}」` : '已跟随系统默认设备');
  };

  const ensureAudioAnalysis = useCallback(async () => {
    const audio = audioRef.current;
    const analysis = analysisRef.current;
    // 原生输出模式：绝不接管音频。外接音箱/蓝牙的路由交给浏览器，音质优先。
    if (outputPrefRef.current.mode === 'direct') return;
    const AudioEngine = window.AudioContext || window.webkitAudioContext;
    // 内核不支持或之前接管失败过：直接按原生输出放，别把播放一起拖死
    if (!AudioEngine || analysis.takeoverFailed) return;
    if (!analysis.context) {
      try {
        // latencyHint 决定输出缓冲大小，直接决定「听到的声音」和「画面」差多少：
        //   playback    —— 大缓冲（桌面可达 0.5~1s）。抗 buffer underrun，外接音箱/蓝牙不断续，
        //                  但代价是画面明显快过声音，手机上体感就是律动对不上。
        //   interactive —— 约 128 帧的小缓冲，延迟最低。
        // 所以：手机上没明确指定外接设备时一律用小缓冲保低延迟；
        //       桌面或用户挑了外接设备时再用大缓冲换稳定（外接设备更容易 underrun）。
        const lowLatency = isHandheld() && !outputPrefRef.current.deviceId;
        try {
          analysis.context = new AudioEngine({ latencyHint: lowLatency ? 'interactive' : 'playback' });
        } catch {
          analysis.context = new AudioEngine();
        }
        // 平滑系数是频谱滞后的第二大来源：analyser 会拿历史帧做指数平均，
        // 0.6 在 60fps 下等效约 40ms、手机掉到 30fps 时翻倍到近 100ms。移动端压到 0.2 出头。
        const smooth = lowLatency ? 0.2 : 0.5;
        analysis.analyser = analysis.context.createAnalyser();
        analysis.analyser.fftSize = 128;
        analysis.analyser.smoothingTimeConstant = smooth;
        analysis.spectrum = new Uint8Array(analysis.analyser.frequencyBinCount);
        analysis.source = analysis.context.createMediaElementSource(audio);
        analysis.source.connect(analysis.analyser);
        analysis.analyser.connect(analysis.context.destination);
        // 地形背景需要更细的频谱：单独挂一个高分辨率 analyser。
        // 注意它不再承担节拍检测 —— 检测走 BeatEngine，两条链互不影响。
        analysis.fine = analysis.context.createAnalyser();
        analysis.fine.fftSize = 1024;
        analysis.fine.smoothingTimeConstant = lowLatency ? 0.3 : 0.55;
        analysis.fineBins = new Uint8Array(analysis.fine.frequencyBinCount);
        analysis.source.connect(analysis.fine);
        // 记下是不是低延迟档，后面能量爬升和节拍判定的快慢都按它分档
        analysis.lowLatency = lowLatency;
        // 节拍 / 低频检测引擎：优先 AudioWorklet（音频线程逐块算），不支持时退回 AnalyserNode
        analysis.engine = new BeatEngine(analysis.context, analysis.source, { lowLatency });
        analysis.engine.setManualOffset(readBeatOffset());
        // 开发期调试把手：方便在真机上确认检测链走的是 worklet 还是兜底、延迟补了多少
        if (import.meta.env.DEV) window.__orbitBeat = analysis.engine;
        // 只有在菜单里明确挑了设备才去改输出口，否则一律不碰，
        // 免得每次开播都把外接音箱/蓝牙的链路重新协商一遍。
        if (outputPrefRef.current.deviceId) applySink(audio, analysis.context, outputPrefRef.current.deviceId);
        // 不阻塞播放：addModule 一般几毫秒就回来，万一卡住也先让声音出去，
        // 引擎初始化完成后会自己在下一帧接管。
        await Promise.race([
          analysis.engine.start(),
          new Promise(resolve => setTimeout(resolve, 400))
        ]);
      } catch {
        // 部分移动端内核（老 WebView / WeChat X5）createMediaElementSource 会抛异常，
        // 之前这里直接把 startPlayback 一起 catch 掉了，表现是根本不出声。
        // 现在兜底：完整释放已创建的节点与 AudioContext，标记失败并退回原生输出。
        disposeAudioAnalysis(analysis);
        analysis.takeoverFailed = true;
        setOutputPref(previous => (previous.mode === 'direct' ? previous : { ...previous, mode: 'direct' }));
        showToast('当前浏览器不支持律动接管，已用原生输出播放');
        return;
      }
    }
    if (analysis.context.state === 'suspended') await analysis.context.resume();
  }, [setOutputPref, showToast]);

  // 播放前先把歌词和音源都等齐：歌词最慢等 2.6s，音源最慢等 8s，
  // 超时就直接开播，宁可歌词晚一点到，也不能卡住不出声。
  const startPlayback = useCallback(async () => {
    const currentTrack = tracks[currentRef.current];
    const media = mediaRef.current;
    if (preparingRef.current || !currentTrack) {
      if (!currentTrack) openBridge();
      return;
    }
    if (!media) return;
    window.orbitDesktop?.stopKugouPlayer?.().catch(() => {});
    const request = {};
    const isCurrent = () => preparingRef.current === request && mediaRef.current === media;
    preparingRef.current = request;
    setPreparing(true);
    clearTimeout(slowHintTimer.current);
    slowHintTimer.current = setTimeout(() => showToast('正在准备歌词与音源…'), 700);
    try {
      if (currentTrack.provider === 'qq' && window.orbitDesktop?.refreshQQLogin) {
        // 每次播放前从 Electron 的持久会话同步最新 qm_keyst/qqmusic_key。
        // QQ 可能在网页会话里刷新播放凭据，只在扫码完成时同步一次会让 VIP
        // 账号过一段时间后退化成试听或无地址。
        const auth = await window.orbitDesktop.refreshQQLogin();
        if (!isCurrent()) return;
        if (!auth?.ok || !auth?.playbackKeyReady) {
          updateQQAccount(null);
          showToast('QQ 播放授权未完成，请重新连接 QQ 音乐');
          openBridge('qq');
          return;
        }
        if (auth.profile) updateQQAccount(auth.profile);
        // 选歌时 audio 可能已经用旧凭据请求失败；同步后强制重新加载。
        reloadTrackAudio(audioRef.current, media);
      }
      if (currentTrack.provider === 'netease' && window.orbitDesktop?.refreshNeteaseLogin) {
        const auth = await window.orbitDesktop.refreshNeteaseLogin();
        if (!isCurrent()) return;
        if (!auth?.ok) {
          updateNeteaseAccount(null);
          showToast('网易云登录已失效，请重新扫码登录');
          openBridge('netease');
          return;
        }
        if (auth.profile) updateNeteaseAccount(auth.profile);
        reloadTrackAudio(audioRef.current, media);
      }
      if (currentTrack.provider === 'kugou' && window.orbitDesktop?.resolveKugouAudio) {
        const audioEl = audioRef.current;
        const alreadyLoaded = audioEl.currentSrc === media.src && audioEl.readyState >= 2 && !audioEl.error;
        if (!alreadyLoaded) {
          const resolved = await window.orbitDesktop.resolveKugouAudio(
            currentTrack.hash,
            currentTrack.albumId,
            currentTrack.pageId,
            currentTrack.albumAudioId,
          );
          if (!isCurrent()) return;
          if (!resolved?.ok) {
            if (resolved?.reason === 'login') {
              showToast('请先登录酷狗账号');
              openBridge('kugou');
            } else if (resolved?.reason !== 'superseded') {
              showToast(resolved?.message || '酷狗暂未返回可播放音源（可能受会员或版权限制）');
            }
            return;
          }
          if (resolved.durationMs > 0 && (!media.duration || resolved.isFreePart)) {
            media.duration = resolved.durationMs / 1000;
            setDuration(media.duration);
          }
          if (resolved.isFreePart) {
            showToast('只拿到试听片段 · 完整播放需要酷狗对应会员权限');
          }
          reloadTrackAudio(audioEl, media, currentTrack.src);
        }
      }
      if (currentTrack.provider === 'qq' || currentTrack.provider === 'netease') {
        // Login/permission refresh can expose word lyrics that the pre-login
        // prefetch did not have. Reload both the cache and the visible panel.
        invalidateLrc(currentTrack.lyrics);
        setLyricsVersion(value => value + 1);
      }
      // 探测服务端是不是只拿到了试听片段（响应头里带标记）。
      // 只探测 1 个字节，不会真把整首歌拉一遍。
      if (currentTrack.provider === 'qq') {
        fetch(currentTrack.src, { headers: { Range: 'bytes=0-0' }, cache: 'no-store' })
          .then(response => {
            if (mediaRef.current === media && response.headers.get('x-orbit-qq-trial')) showToast('只拿到试听片段（约 60 秒）· 完整播放需要对应会员权限');
          })
          .catch(() => { /* 探测失败不影响正式播放 */ });
      }
      await ensureAudioAnalysis();
      if (!isCurrent()) return;
      await waitForLrc(currentTrack.lyrics, 2600);
      if (!isCurrent()) return;
      await waitUntilPlayable(audioRef.current, 8000);
      if (!isCurrent()) return;
      restorePosition(audioRef.current);
      await audioRef.current.play();
    } catch (error) {
      if (!isCurrent()) return;
      // 安卓 Chrome 在等待音源期间可能丢掉用户激活态，play() 直接被拒。
      // 这时别静默失败，让用户再点一下播放键就行。
      if (error?.name === 'NotAllowedError') showToast('浏览器拦下了自动播放，请再点一次播放');
      else showToast('本地音源暂时无法播放');
    } finally {
      if (isCurrent()) cancelPlaybackPreparation();
    }
  }, [cancelPlaybackPreparation, ensureAudioAnalysis, openBridge, reloadTrackAudio, restorePosition, showToast, updateNeteaseAccount, updateQQAccount]);

  const selectTrack = useCallback((id, shouldPlay = false) => {
    if (!tracks.length) {
      openBridge();
      return;
    }
    const next = (id + tracks.length) % tracks.length;
    const audio = audioRef.current;
    const nextTrack = tracks[next];
    const intendedSource = nextTrack.src ? new URL(nextTrack.src, document.baseURI).href : '';
    if (next !== currentRef.current || audio.src !== intendedSource) {
      cancelPlaybackPreparation();
      setCurrent(next);
      currentRef.current = next;
      loadTrackAudio(nextTrack, activeLibrary);
    }
    saveLastTrack(activeLibrary, playbackTrackKey(nextTrack));
    // 选歌的那一刻就开始拉歌词，真正点播放时通常已经就绪
    prefetchLrc(tracks[next].lyrics);
    if (shouldPlay) startPlayback();
  }, [activeLibrary, cancelPlaybackPreparation, loadTrackAudio, openBridge, startPlayback]);

  // 切换 QQ 音质。自带地址是本地代理 /api/qq/audio?...&quality=xxx，音质就是 URL 上的一个参数，
  // 改掉重新加载即可。难点是换 src 会把播放位置清零，所以要把进度记下来，加载完再 seek 回去。
  const applyQQQuality = useCallback(async (quality) => {
    const track = tracks[currentRef.current];
    const audio = audioRef.current;
    if (!track || track.provider !== 'qq' || !audio) return;
    // 已经在这一档了就别重来：换 src 会让正在播的歌断一下，重复点同一档体验很差
    if (quality === qqQuality) return;
    const media = mediaRef.current;
    if (!media) return;
    const wasPlaying = !audio.paused;
    setQualityBusy(true);
    try {
      // 整个列表一起改：只改当前这首的话，切到下一首就退回旧档了
      tracks.forEach(item => {
        if (item.provider === 'qq' && item.src) item.src = swapQQQuality(item.src, quality);
      });
      const nextSrc = track.src;
      setQQQuality(quality);
      try { localStorage.setItem(QQ_QUALITY_KEY, quality); } catch { /* 隐私模式下记不住，仅本次会话生效 */ }
      reloadTrackAudio(audio, media, nextSrc);
      await waitUntilPlayable(audio);
      if (mediaRef.current !== media) return;
      restorePosition(audio);
      if (wasPlaying) await audio.play().catch(() => showToast('浏览器拦下了自动播放，点一下播放键继续'));
      // 探一下有没有被降级成试听片段（服务端会在响应头里打标记）
      fetch(nextSrc, { headers: { Range: 'bytes=0-0' }, cache: 'no-store' })
        .then(response => {
          if (response.headers.get('x-orbit-qq-trial')) showToast('这档音质只给到试听片段，已自动降级到可用规格');
        })
        .catch(() => {});
    } catch {
      showToast('切换音质失败，仍在用原来的音源');
    } finally {
      setQualityBusy(false);
    }
  }, [qqQuality, reloadTrackAudio, restorePosition, showToast]);

  // Restore this playlist's most recent song even when its list index matches
  // the outgoing song. Source loading, rather than index changes, drives seek.
  const applyPlaylistChange = useCallback((nextActiveKey, toastText) => {
    setActiveLibrary(nextActiveKey);
    const nextProvider = parsePlaylistKey(nextActiveKey).provider;
    if (nextProvider && importedLibraries.has(nextProvider)) {
      chooseDisplayAccount(nextProvider);
    }
    try {
      if (nextActiveKey) localStorage.setItem(ACTIVE_LIBRARY_KEY, nextActiveKey);
      else localStorage.removeItem(ACTIVE_LIBRARY_KEY);
    } catch { /* privacy mode */ }
    setActivePlaylist(getActivePlaylistId());
    setQQPlaylists(listQQPlaylists());
    setNeteasePlaylists(listNeteasePlaylists());
    setKugouPlaylists(listKugouPlaylists());
    setLocalPlaylists(listLocalPlaylists());
    setLibraryVersion(version => version + 1);
    setJournal(false);
    setSelected(null);
    cancelPlaybackPreparation();
    window.orbitDesktop?.stopKugouPlayer?.().catch(() => {});
    audioRef.current.pause();
    setPlaying(false);
    const next = readLastTrack(nextActiveKey, tracks);
    currentRef.current = next;
    setCurrent(next);
    loadTrackAudio(tracks[next], nextActiveKey);
    if (tracks.length > 1) prefetchLrc(tracks[(next + 1) % tracks.length].lyrics);
    if (toastText) showToast(toastText);
  }, [cancelPlaybackPreparation, chooseDisplayAccount, loadTrackAudio, showToast]);

  const handleQQImport = useCallback((songs, meta) => {
    const result = importQQPlaylist(tracks, meta, songs);
    if (!result.added) return 0;
    // 导入的是某个歌单时，顺手把它设为当前歌单——刚导完就想听它，这是最自然的预期。
    // 零散添加（搜索结果逐首＋）不动当前歌单，免得听一半被切走。
    // 生效歌单以存储层的最终状态为准：activeId 现在永远指向某个真实歌单，
    // 用 React 里的旧值会跟存储脱节（比如首次零散导入会落回第一个歌单）。
    const targetId = meta?.id || result.playlist?.id || getActivePlaylistId();
    removeImportedTracks(tracks);
    const switched = switchQQPlaylist(tracks, targetId);
    applyPlaylistChange(importedPlaylistKey('qq', switched.id), `已导入 ${result.added} 首${result.playlist ? ` · 当前歌单「${result.playlist.name}」` : ''}`);
    return result.added;
  }, [applyPlaylistChange]);

  const handleSwitchPlaylist = useCallback(playlistKey => {
    if (!playlistKey || playlistKey === activeLibrary) return;
    const { id, library } = parsePlaylistKey(playlistKey);
    const playlist = library?.list().find(item => item.id === id);
    if (!playlist) return;
    const result = switchImportedTracks(playlistKey);
    applyPlaylistChange(playlistKey, `已切换到「${playlist.name}」· ${result.count} 首`);
  }, [activeLibrary, applyPlaylistChange]);

  const handleRemovePlaylist = useCallback(playlistId => {
    const name = qqPlaylists.find(item => item.id === playlistId)?.name || '歌单';
    const removingActive = activeLibrary === importedPlaylistKey('qq', playlistId);
    const result = removeQQPlaylist(removingActive ? tracks : [], playlistId);
    if (!result.removed) return;
    forgetPlaylistPlayback(importedPlaylistKey('qq', playlistId));
    const nextName = qqPlaylists.find(item => item.id === result.activeId)?.name;
    if (removingActive) {
      const nextKey = importedPlaylistKey('qq', result.activeId) || fallbackPlaylistKey('qq');
      switchImportedTracks(nextKey);
      applyPlaylistChange(nextKey, `已移除歌单「${name}」${nextName ? ` · 当前「${nextName}」` : ''}`);
    } else {
      setQQPlaylists(listQQPlaylists());
      showToast(`已移除歌单「${name}」`);
    }
  }, [activeLibrary, applyPlaylistChange, qqPlaylists, showToast]);

  const handleQQClear = useCallback(() => {
    clearQQTracks(tracks);
    setQQPlaylists([]);
    setActivePlaylist(null);
    setLibraryVersion(version => version + 1);
    setSelected(null);
    if (activeLibrary?.startsWith('qq:')) {
      const nextKey = fallbackPlaylistKey('qq');
      switchImportedTracks(nextKey);
      applyPlaylistChange(nextKey, '已清空 QQ 导入曲库');
    } else {
      showToast('已清空 QQ 导入曲库');
    }
    clearProviderPlayback('qq');
  }, [activeLibrary, applyPlaylistChange, showToast]);

  const handleNeteaseImport = useCallback((songs, meta) => {
    const result = importNeteaseTracks(tracks, songs, meta);
    if (!result.added) return 0;
    removeImportedTracks(tracks);
    const switched = switchNeteasePlaylist(tracks, result.playlist.id);
    applyPlaylistChange(importedPlaylistKey('netease', switched.id), `已新建/更新网易云歌单「${result.name}」· ${switched.count} 首`);
    return result.added;
  }, [applyPlaylistChange]);

  const handleNeteaseClear = useCallback(() => {
    const currentWasNetease = activeLibrary?.startsWith('netease:');
    clearNeteaseTracks(tracks);
    if (currentWasNetease) {
      const nextKey = fallbackPlaylistKey('netease');
      switchImportedTracks(nextKey);
      applyPlaylistChange(nextKey, '已清空网易云导入曲库');
    } else {
      setNeteasePlaylists([]);
      setLibraryVersion(version => version + 1);
      showToast('已清空网易云导入曲库');
    }
    clearProviderPlayback('netease');
  }, [activeLibrary, applyPlaylistChange, showToast]);

  const handleKugouImport = useCallback((songs, meta) => {
    const result = importKugouTracks(songs, meta);
    if (result.added) {
      const nextKey = importedPlaylistKey('kugou', result.id);
      switchImportedTracks(nextKey);
      applyPlaylistChange(nextKey, `已导入酷狗歌单「${result.name}」· ${result.count} 首`);
    }
    return result;
  }, [applyPlaylistChange]);

  const handleKugouClear = useCallback(() => {
    if (!clearKugouTracks(tracks)) return showToast('无法清空酷狗导入曲库');
    window.orbitDesktop?.stopKugouPlayer?.().catch(() => {});
    clearProviderPlayback('kugou');
    if (activeLibrary?.startsWith('kugou:')) {
      const nextKey = fallbackPlaylistKey('kugou');
      switchImportedTracks(nextKey);
      applyPlaylistChange(nextKey, '已清空酷狗导入曲库');
    } else {
      setKugouPlaylists([]);
      showToast('已清空酷狗导入曲库');
    }
  }, [activeLibrary, applyPlaylistChange, showToast]);

  const seekTo = useCallback(value => {
    const audio = audioRef.current;
    const media = mediaRef.current;
    if (!audio || !media) return;
    const total = resolveMediaDuration(audio, media.duration) || duration;
    const clamped = total > 0 ? clamp(value, 0, total) : Math.max(0, value);
    if (media.pendingPosition !== undefined) media.pendingPosition = clamped;
    else {
      audio.currentTime = clamped;
      persistPlayback(audio, true);
    }
    setCurrentTime(clamped);
    syncMediaPosition(audio, true);
  }, [duration, persistPlayback, syncMediaPosition]);

  const step = useCallback(direction => {
    if (!tracks.length) return;
    const next = random && tracks.length > 1
      ? (currentRef.current + 1 + Math.floor(Math.random() * (tracks.length - 1))) % tracks.length
      : currentRef.current + direction;
    selectTrack(next, !audioRef.current.paused || Boolean(preparingRef.current));
  }, [random, selectTrack]);

  const track = tracks[current];

  mediaActionsRef.current = {
    onPlay: () => {
      if (audioRef.current?.paused) startPlayback();
    },
    onPause: () => {
      cancelPlaybackPreparation();
      audioRef.current?.pause();
    },
    onStop: () => {
      cancelPlaybackPreparation();
      const audio = audioRef.current;
      if (!audio) return;
      audio.pause();
      seekTo(0);
    },
    onPrevious: () => step(-1),
    onNext: () => step(1),
    onSeekTo: target => seekTo(target),
    onSeekBy: delta => {
      const audio = audioRef.current;
      const media = mediaRef.current;
      const base = media?.pendingPosition !== undefined ? media.pendingPosition : (audio?.currentTime || 0);
      seekTo(base + delta);
    },
  };

  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.mediaSession) return undefined;
    return bindMediaSessionHandlers(navigator.mediaSession, {
      onPlay: () => mediaActionsRef.current?.onPlay(),
      onPause: () => mediaActionsRef.current?.onPause(),
      onStop: () => mediaActionsRef.current?.onStop(),
      onPrevious: () => mediaActionsRef.current?.onPrevious(),
      onNext: () => mediaActionsRef.current?.onNext(),
      onSeekTo: (target, fastSeek) => mediaActionsRef.current?.onSeekTo(target, fastSeek),
      onSeekBy: delta => mediaActionsRef.current?.onSeekBy(delta),
    });
  }, []);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.mediaSession) return;
    syncMediaSessionMetadata(navigator.mediaSession, track);
    syncMediaPosition(audioRef.current, true);
  }, [track?.id, track?.title, track?.artist, track?.album, track?.cover, libraryVersion, syncMediaPosition]);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.mediaSession) return;
    syncMediaSessionPlaybackState(navigator.mediaSession, {
      playing,
      hasTrack: Boolean(track),
    });
    syncMediaPosition(audioRef.current, true);
  }, [playing, track, syncMediaPosition]);

  // 系统托盘状态双向同步与菜单动作响应
  useEffect(() => {
    if (!window.orbitDesktop?.onTrayAction) return undefined;
    return window.orbitDesktop.onTrayAction(action => {
      if (action === 'toggle') {
        if (audioRef.current?.paused) mediaActionsRef.current?.onPlay();
        else mediaActionsRef.current?.onPause();
      } else if (action === 'prev') {
        mediaActionsRef.current?.onPrevious();
      } else if (action === 'next') {
        mediaActionsRef.current?.onNext();
      }
    });
  }, []);

  useEffect(() => {
    window.orbitDesktop?.syncTrayState?.({
      playing,
      title: track?.title || '',
      artist: track?.artist || '',
      hasTrack: Boolean(track),
    })?.catch?.(() => {});
  }, [playing, track?.title, track?.artist, Boolean(track)]);

  // 本地音频文件拖放导入（支持同步拖入同名 .lrc 歌词）
  useEffect(() => {
    let dragDepth = 0;
    const hasFiles = event => Array.from(event.dataTransfer?.types || []).includes('Files');
    const onDragEnter = event => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth += 1;
      setDragActive(true);
    };
    const onDragOver = event => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    };
    const onDragLeave = event => {
      if (!hasFiles(event)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) setDragActive(false);
    };
    const onDrop = event => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth = 0;
      setDragActive(false);
      const files = event.dataTransfer?.files;
      if (!files?.length) return;
      const result = importLocalAudioFiles(files);
      if (!result.added && !result.total) {
        showToast('未识别到可播放的音频文件（支持 MP3 / FLAC / WAV / M4A / OGG）');
        return;
      }
      const nextKey = importedPlaylistKey('localfile', result.id);
      switchImportedTracks(nextKey);
      const lrcNote = result.matchedLyrics ? ` · 已配对 ${result.matchedLyrics} 份歌词` : '';
      applyPlaylistChange(
        nextKey,
        result.added
          ? `已导入 ${result.added} 首本地音频${lrcNote}（共 ${result.total} 首）`
          : `已切换到「${result.name}」· ${result.total} 首`,
      );
    };
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [applyPlaylistChange, showToast]);
  const qqCount = qqPlaylists.reduce((total, item) => total + item.count, 0);
  const neteaseCount = neteasePlaylists.reduce((total, item) => total + item.count, 0);
  const kugouCount = kugouPlaylists.reduce((total, item) => total + item.count, 0);
  const accounts = { qq: qqAccount, netease: neteaseAccount, kugou: kugouAccount };
  const { accountProvider, nextAccount } = resolveActiveAccountState({
    activeLibrary,
    displayAccount,
    bridgeProvider,
    accounts,
  });
  const switchAccount = () => {
    if (!nextAccount) return;
    const id = nextAccount === 'qq'
      ? getActivePlaylistId()
      : nextAccount === 'netease'
        ? getActiveNeteasePlaylistId()
        : getActiveKugouPlaylistId();
    const targetPlaylist = importedPlaylistKey(nextAccount, id);
    chooseDisplayAccount(nextAccount);
    if (!targetPlaylist) openBridge(nextAccount, true);
    else if (targetPlaylist === activeLibrary) setJournal(false);
    else handleSwitchPlaylist(targetPlaylist);
  };
  return (
    <>
      <SvgDefs />
      {window.orbitDesktop?.platform === 'win32' && (
        <div className="desktop-titlebar">
          <GlassSurface variant="subtle" />
          <img src="/icons/orbit-32.png" alt="" draggable="false" />
          <span>ORBIT</span>
          <span className="desktop-brand-note">私人音乐频率</span>
          <span className="desktop-title-track">{track ? `${track.title} · ${track.artist}` : '音乐宇宙'}</span>
        </div>
      )}
      <Header
        journal={journal}
        onChangeView={setJournal}
        onOpenBridge={() => openBridge(accountProvider)}
        bridgeOpen={bridgeOpen}
        profile={accounts[accountProvider]?.profile}
        accountProvider={accountProvider}
        nextAccount={nextAccount}
        onSwitchAccount={switchAccount}
        playlists={combinedPlaylists}
        activePlaylist={activeLibrary}
        onSwitchPlaylist={handleSwitchPlaylist}
        updater={updater}
      />
      <UpdateBadge updater={updater} />
      {!journal && (
        <div className="native-soundfield" aria-hidden="true">
          <canvas ref={glCanvasRef} id="gpufield" />
          <canvas ref={canvasRef} id="soundfield" />
        </div>
      )}
      <GlassBackdrop soundfield={journal ? null : soundfield} active={playing} paused={bridgeOpen}>{journal ? <Journal onOpen={setSelected} /> : (
        <Universe
          current={current}
          playing={playing}
          currentTime={currentTime}
          duration={duration}
          onSelect={selectTrack}
          onSeek={seekTo}
          zoom={zoom}
          backdropMode={backdropMode}
          onRotateToast={showToast}
          analysisRef={analysisRef}
          audioRef={audioRef}
          soundfield={soundfield}
          libraryVersion={libraryVersion}
          lyricsVersion={lyricsVersion}
          onOpenBridge={() => openBridge(accountProvider)}
        />
      )}</GlassBackdrop>
      {!journal && (
        <>
          <div className="universe-footer">
            <div className="drag-hint"><span>↔</span> 拖动漫游 <i /> 点击即播</div>
          </div>
          <div className="view-controls glass liquid-control">
            <GlassSurface variant="control" />
            <button onClick={() => {
              const next = (backdropMode + 1) % backdropNames.length;
              setBackdropMode(next);
              try { localStorage.setItem(BACKDROP_MODE_KEY, String(next)); } catch { /* ignore */ }
              showToast(`背景已切换为「${backdropNames[next]}」`);
            }} aria-label={`切换律动背景：${backdropNames[backdropMode]}`} title={`切换律动背景：${backdropNames[backdropMode]}`}>✦</button>
          </div>
        </>
      )}
      {track && <Player
        track={track}
        current={current}
        playing={playing}
        preparing={preparing}
        currentTime={currentTime}
        duration={duration}
        random={random}
        repeat={repeat}
        liked={liked.has(current)}
        volume={volume}
        muted={muted}
        outputPref={outputPref}
        outputs={outputs}
        outputMenu={outputMenu}
        beatOffset={beatOffset}
        hidden={playerHidden}
        onQuality={applyQQQuality}
        qqQuality={qqQuality}
        qualityBusy={qualityBusy}
        onHiddenChange={hidden => {
          setPlayerHidden(hidden);
          if (hidden) setOutputMenu(false);
        }}
        onBeatOffset={adjustBeatOffset}
        onOutputToggle={openOutputMenu}
        onOutputPick={chooseOutput}
        onPlay={() => {
          if (audioRef.current.paused) startPlayback();
          else audioRef.current.pause();
        }}
        onStep={step}
        onSeek={seekTo}
        onShuffle={() => { setRandom(value => !value); showToast(random ? '按顺序播放' : '随机漫游已开启'); }}
        onRepeat={() => { setRepeat(value => !value); showToast(repeat ? '播放结束后自动切歌' : '单曲循环'); }}
        onFavorite={() => setLiked(value => {
          const next = new Set(value);
          next.has(current) ? next.delete(current) : next.add(current);
          showToast(next.has(current) ? '已收藏这首歌曲' : '已取消收藏');
          return next;
        })}
        onVolume={value => { setVolume(value); setMuted(false); audioRef.current.volume = value; audioRef.current.muted = false; }}
        onMute={() => { const value = !muted; setMuted(value); audioRef.current.muted = value; }}
        onOpen={() => setSelected(current)}
      />}
      {selected !== null && <DetailDialog track={tracks[selected]} onClose={() => setSelected(null)} onPlay={id => { selectTrack(id, true); setSelected(null); }} />}
      <MusicBridge
        open={bridgeOpen}
        provider={bridgeProvider}
        onProviderChange={setBridgeProvider}
        browseAccountPlaylists={browseAccountPlaylists}
        onClose={closeBridge}
        qq={{
          account: qqAccount, onImport: handleQQImport, onClear: handleQQClear, importedCount: qqCount, playlists: qqPlaylists,
          activePlaylistId: activeLibrary?.startsWith('qq:') ? activePlaylist : null,
          onSwitchPlaylist: id => handleSwitchPlaylist(importedPlaylistKey('qq', id)),
          onRemovePlaylist: handleRemovePlaylist,
          sampleSongs: tracks.filter(item => item.provider === 'qq' && item.mid).slice(0, 8)
            .map(item => ({ mid: item.mid, mediaMid: item.mediaMid, title: item.title })),
        }}
        netease={{ account: neteaseAccount, onImport: handleNeteaseImport, onClear: handleNeteaseClear, importedCount: neteaseCount }}
        kugou={{
          account: kugouAccount,
          onImport: handleKugouImport,
          onClear: handleKugouClear,
          importedCount: kugouCount,
          playlists: kugouPlaylists,
          activePlaylistId: activeLibrary?.startsWith('kugou:') ? activeLibrary.slice(6) : null,
          onSwitchPlaylist: id => handleSwitchPlaylist(importedPlaylistKey('kugou', id)),
        }}
      />
      {dragActive && (
        <div className="drop-overlay" aria-hidden="true">
          <div className="drop-overlay-card">
            <strong>松开以导入本地音频</strong>
            <span>支持 MP3 / FLAC / WAV / M4A / OGG · 同名 .lrc 歌词将自动配对</span>
          </div>
        </div>
      )}
      <div id="toast" className={toastText ? 'show' : ''} role="status">{toastText}</div>
      <audio
        ref={audioRef}
        preload="auto"
        onPlay={() => {
          setPlaying(true);
          const media = mediaRef.current;
          if (media) saveLastTrack(media.playlist, media.key);
          // iOS 上 AudioContext 的 resume 必须贴近用户手势，播放事件里再兜一次底，
          // 否则会出现「进度在走但没有声音」的假播放状态。
          analysisRef.current.context?.resume?.().catch(() => {});
        }}
        onPause={event => {
          setPlaying(false);
          persistPlayback(event.currentTarget, true);
        }}
        onTimeUpdate={event => {
          const audio = event.currentTarget;
          const media = mediaRef.current;
          if (!media || media.pendingPosition !== undefined || audio.currentSrc !== media.src) return;
          setCurrentTime(audio.currentTime || 0);
          if (!audio.paused) {
            persistPlayback(audio);
            syncMediaPosition(audio);
          }
        }}
        onLoadedMetadata={event => restorePosition(event.currentTarget)}
        onDurationChange={event => syncDuration(event.currentTarget)}
        onLoadedData={event => syncDuration(event.currentTarget)}
        onProgress={event => syncDuration(event.currentTarget)}
        onCanPlay={event => {
          syncDuration(event.currentTarget);
          // 当前这首已经能播了，顺手把下一首的歌词和音频一并预热
          if (!tracks.length) return;
          const next = tracks[(currentRef.current + 1) % tracks.length];
          prefetchLrc(next.lyrics);
          if (next.provider !== 'kugou') prefetchAudio(next.src);
        }}
        onEnded={event => {
          const audio = event.currentTarget;
          const media = mediaRef.current;
          if (!tracks.length || !media || audio.currentSrc !== media.src || !audio.ended) return;
          saveProgress(media.key, 0);
          if (repeat) startPlayback();
          else {
            const next = random ? (current + 1 + Math.floor(Math.random() * (tracks.length - 1))) % tracks.length : current + 1;
            selectTrack(next, true);
          }
        }}
        // 蓝牙/外接设备断开或切换时音源会被掐掉，等它回来自动接上
        onEmptied={() => { if (playingRef.current) showToast('音源已断开，等待重连…'); }}
        onStalled={() => { if (playingRef.current) reconnect(); }}
        onWaiting={() => { if (playingRef.current) showToast('正在缓冲音源…'); }}
        onError={() => {
          const track = tracks[currentRef.current];
          // QQ 音源 404 = QQ 没给播放地址（版权/会员限制），重连一百次也不会有，
          // 把上游的真实原因取出来给用户看，别让"播不了"显得像玄学。
          if (track?.provider === 'qq') {
            if (qqErrorShownRef.current === track.id) return;
            qqErrorShownRef.current = track.id;
            fetch(track.src, { cache: 'no-store' })
              .then(response => response.json().catch(() => ({})))
              .then(payload => showToast(payload.message || payload.error || 'QQ 音乐没有返回播放地址'))
              .catch(() => showToast('QQ 音乐没有返回播放地址'));
            return;
          }
          if (track?.provider === 'netease') {
            fetch(track.src, { cache: 'no-store' })
              .then(response => response.json().catch(() => ({})))
              .then(payload => showToast(payload.message || payload.error || '网易云没有返回可播放地址'))
              .catch(() => showToast('网易云没有返回可播放地址'));
            return;
          }
          if (track?.provider === 'kugou') {
            if (!audioRef.current?.currentSrc || preparingRef.current) return;
            fetch(track.src, { cache: 'no-store' })
              .then(response => response.json().catch(() => ({})))
              .then(payload => showToast(payload.message || payload.error || '酷狗音乐暂无法播放这首歌'))
              .catch(() => showToast('酷狗音乐暂无法播放这首歌'));
            return;
          }
          if (!track?.src) return;
          showToast('音源中断，正在重连…');
          reconnect();
        }}
      />
    </>
  );
}
