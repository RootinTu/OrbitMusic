// Windows 系统媒体传输控制（SMTC）与硬件媒体键适配层
// 基于标准 navigator.mediaSession：Chromium/Electron 在 Windows 上会自动将其桥接到
// 系统音量浮层、锁屏媒体卡片、蓝牙耳机按键及键盘多媒体键，且遵循系统焦点路由而不劫持其他应用。

const DEFAULT_FALLBACK_ICON = '/icons/orbit-512.png';
const DEFAULT_SEEK_OFFSET = 10;

function toAbsoluteMediaUrl(raw, baseHref) {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (/^(data:|blob:)/i.test(trimmed)) return trimmed;
  try {
    return baseHref ? new URL(trimmed, baseHref).href : new URL(trimmed).href;
  } catch {
    return '';
  }
}

export function resolveMediaArtwork(cover, { baseHref = '', fallbackIcon = DEFAULT_FALLBACK_ICON } = {}) {
  const artwork = [];
  const coverUrl = toAbsoluteMediaUrl(cover, baseHref);
  if (coverUrl) artwork.push({ src: coverUrl });
  const fallbackUrl = toAbsoluteMediaUrl(fallbackIcon, baseHref);
  if (fallbackUrl && fallbackUrl !== coverUrl) {
    artwork.push({ src: fallbackUrl, sizes: '512x512', type: 'image/png' });
  }
  return artwork;
}

export function buildMediaMetadata(track, options = {}) {
  if (!track) return null;
  const {
    baseHref = typeof window !== 'undefined' ? window.location.href : '',
    fallbackIcon = DEFAULT_FALLBACK_ICON,
    MediaMetadataCtor = typeof MediaMetadata !== 'undefined' ? MediaMetadata : null,
  } = options;
  const init = {
    title: String(track.title || 'ORBIT Music'),
    artist: String(track.artist || 'ORBIT Music'),
    album: String(track.album || ''),
    artwork: resolveMediaArtwork(track.cover, { baseHref, fallbackIcon }),
  };
  return MediaMetadataCtor ? new MediaMetadataCtor(init) : init;
}

export function clampPositionState(duration, position, playbackRate = 1) {
  const safeDuration = Number(duration);
  if (!Number.isFinite(safeDuration) || safeDuration <= 0) return null;
  const rawPosition = Number(position);
  const safePosition = Number.isFinite(rawPosition)
    ? Math.max(0, Math.min(safeDuration, rawPosition))
    : 0;
  const rawRate = Number(playbackRate);
  const safeRate = Number.isFinite(rawRate) && rawRate > 0 ? rawRate : 1;
  return {
    duration: safeDuration,
    position: safePosition,
    playbackRate: safeRate,
  };
}

export function syncMediaSessionMetadata(mediaSession, track, options = {}) {
  if (!mediaSession) return false;
  try {
    mediaSession.metadata = buildMediaMetadata(track, options);
    return true;
  } catch {
    return false;
  }
}

export function syncMediaSessionPlaybackState(mediaSession, { playing = false, hasTrack = false } = {}) {
  if (!mediaSession) return false;
  try {
    mediaSession.playbackState = hasTrack ? (playing ? 'playing' : 'paused') : 'none';
    return true;
  } catch {
    return false;
  }
}

export function syncMediaSessionPosition(mediaSession, { duration = 0, position = 0, playbackRate = 1 } = {}) {
  if (!mediaSession || typeof mediaSession.setPositionState !== 'function') return false;
  const state = clampPositionState(duration, position, playbackRate);
  try {
    if (state) mediaSession.setPositionState(state);
    else mediaSession.setPositionState();
    return true;
  } catch {
    return false;
  }
}

export function bindMediaSessionHandlers(mediaSession, handlers = {}) {
  if (!mediaSession || typeof mediaSession.setActionHandler !== 'function') {
    return () => {};
  }
  const actions = [
    ['play', () => handlers.onPlay?.()],
    ['pause', () => handlers.onPause?.()],
    ['stop', () => handlers.onStop?.()],
    ['previoustrack', () => handlers.onPrevious?.()],
    ['nexttrack', () => handlers.onNext?.()],
    ['seekto', details => {
      const target = Number(details?.seekTime);
      if (Number.isFinite(target)) handlers.onSeekTo?.(target, Boolean(details?.fastSeek));
    }],
    ['seekbackward', details => {
      const offset = Number(details?.seekOffset);
      handlers.onSeekBy?.(-(Number.isFinite(offset) && offset > 0 ? offset : DEFAULT_SEEK_OFFSET));
    }],
    ['seekforward', details => {
      const offset = Number(details?.seekOffset);
      handlers.onSeekBy?.(Number.isFinite(offset) && offset > 0 ? offset : DEFAULT_SEEK_OFFSET);
    }],
  ];

  const registered = [];
  for (const [action, callback] of actions) {
    try {
      mediaSession.setActionHandler(action, callback);
      registered.push(action);
    } catch {
      // 个别宿主/浏览器版本可能不支持某些可选 action（如 stop），忽略即可
    }
  }

  return () => {
    for (const action of registered) {
      try {
        mediaSession.setActionHandler(action, null);
      } catch {
        // ignore cleanup error
      }
    }
  };
}
