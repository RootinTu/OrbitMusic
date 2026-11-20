// The previous keys stored list positions, so they cannot identify a song
// after a playlist changes. Keep them intact and start with named song keys.
const PROGRESS_KEY = 'orbit.playback.progress.v2';
const LAST_TRACK_KEY = 'orbit.playback.lastTrack.v2';
const RESUME_MIN = 5;
const RESUME_TAIL = 8;

function readMap(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch { /* storage may be unavailable */ }
  return {};
}

function writeMap(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage may be unavailable */ }
}

const playlistMemoryKey = playlist => playlist || 'local:default';

export function playbackTrackKey(track) {
  if (!track) return '';
  if (track.provider === 'qq') return track.mid ? `qq:${track.mid}` : '';
  if (track.provider === 'netease') return track.cloudId ? `netease:${track.cloudId}` : '';
  return track.src ? `local:${track.src.split(/[?#]/, 1)[0]}` : '';
}

export function readLastTrack(playlist, tracks) {
  const key = readMap(LAST_TRACK_KEY)[playlistMemoryKey(playlist)];
  const index = key ? tracks.findIndex(track => playbackTrackKey(track) === key) : -1;
  return Math.max(0, index);
}

export function saveLastTrack(playlist, key) {
  if (!key) return;
  const lastTracks = readMap(LAST_TRACK_KEY);
  const playlistKey = playlistMemoryKey(playlist);
  if (lastTracks[playlistKey] === key) return;
  lastTracks[playlistKey] = key;
  writeMap(LAST_TRACK_KEY, lastTracks);
}

export function forgetPlaylistPlayback(playlist) {
  const lastTracks = readMap(LAST_TRACK_KEY);
  delete lastTracks[playlistMemoryKey(playlist)];
  writeMap(LAST_TRACK_KEY, lastTracks);
}

export function clearProviderPlayback(provider) {
  const prefix = `${provider}:`;
  for (const storageKey of [PROGRESS_KEY, LAST_TRACK_KEY]) {
    const entries = readMap(storageKey);
    for (const key of Object.keys(entries)) {
      if (key.startsWith(prefix)) delete entries[key];
    }
    writeMap(storageKey, entries);
  }
}

export function saveProgress(key, time) {
  if (!key || !Number.isFinite(time) || time < 0) return;
  const progress = readMap(PROGRESS_KEY);
  if (time < RESUME_MIN) {
    if (!Object.prototype.hasOwnProperty.call(progress, key)) return;
    delete progress[key];
  } else {
    const rounded = Math.round(time * 10) / 10;
    if (progress[key] === rounded) return;
    progress[key] = rounded;
  }
  writeMap(PROGRESS_KEY, progress);
}

export function resumeAt(key, duration) {
  if (!key) return 0;
  const saved = readMap(PROGRESS_KEY)[key];
  if (!Number.isFinite(saved) || saved < RESUME_MIN) return 0;
  return duration > 0 && saved > duration - RESUME_TAIL ? 0 : saved;
}
