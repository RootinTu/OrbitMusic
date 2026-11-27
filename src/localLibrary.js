// 本地音频拖放曲库：仅存于当前会话内存（ObjectURL 跨重启失效），
// 支持直接拖入任意 .mp3 / .flac / .wav / .m4a / .ogg / .aac / .opus / .webm 音频，
// 若同批拖入同名 .lrc 歌词文件会自动配对挂载。

export const LOCAL_PLAYLIST_ID = 'dropped';
export const LOCAL_PLAYLIST_NAME = '本地拖入';
export const MAX_LOCAL_TRACKS = 300;

const AUDIO_EXT_RE = /\.(mp3|flac|wav|m4a|aac|ogg|opus|webm)$/i;
const LRC_EXT_RE = /\.lrc$/i;

let localSongs = [];
let active = false;

export function isSupportedAudioFile(file) {
  const name = String(file?.name || '').trim();
  const type = String(file?.type || '').toLowerCase();
  if (AUDIO_EXT_RE.test(name)) return true;
  return type.startsWith('audio/');
}

export function isLrcFile(file) {
  return LRC_EXT_RE.test(String(file?.name || '').trim());
}

export function stripFileExtension(filename) {
  return String(filename || '').trim().replace(/\.[^.]+$/, '');
}

export function parseLocalAudioFilename(filename) {
  const stem = stripFileExtension(filename) || '未知曲目';
  const match = stem.match(/^(.+?)\s*[-–—]\s*(.+)$/);
  if (match && match[1].trim() && match[2].trim()) {
    return { artist: match[1].trim(), title: match[2].trim() };
  }
  return { artist: '本地音频', title: stem };
}

function revokeSongUrls(song) {
  if (typeof URL === 'undefined' || typeof URL.revokeObjectURL !== 'function') return;
  try { if (song?.src?.startsWith('blob:')) URL.revokeObjectURL(song.src); } catch { /* ignore */ }
  try { if (song?.lyrics?.startsWith('blob:')) URL.revokeObjectURL(song.lyrics); } catch { /* ignore */ }
}

function toOrbitLocalTrack(song, id) {
  return {
    ...song,
    id,
    provider: 'localfile',
    genre: 'LOCAL',
    cover: song.cover || '/icons/orbit-512.png',
    note: `${song.title} · ${song.artist}。通过本地音频拖放导入，仅在当前会话有效。`,
  };
}

export function listLocalPlaylists() {
  if (!localSongs.length) return [];
  return [{ id: LOCAL_PLAYLIST_ID, name: LOCAL_PLAYLIST_NAME, count: localSongs.length }];
}

export function getActiveLocalPlaylistId() {
  return active && localSongs.length ? LOCAL_PLAYLIST_ID : null;
}

export function importLocalAudioFiles(fileList, { createObjectURL = file => URL.createObjectURL(file) } = {}) {
  const files = Array.from(fileList || []).filter(Boolean);
  if (!files.length) return { added: 0, total: localSongs.length, skipped: 0, matchedLyrics: 0 };

  const lrcByStem = new Map();
  for (const file of files) {
    if (isLrcFile(file)) {
      const stem = stripFileExtension(file.name).toLowerCase();
      if (stem && !lrcByStem.has(stem)) lrcByStem.set(stem, file);
    }
  }

  const audioFiles = files.filter(isSupportedAudioFile);
  if (!audioFiles.length) return { added: 0, total: localSongs.length, skipped: files.length, matchedLyrics: 0 };

  let added = 0;
  let matchedLyrics = 0;
  const existingKeys = new Set(localSongs.map(item => item.fileKey));
  for (const file of audioFiles) {
    if (localSongs.length >= MAX_LOCAL_TRACKS) break;
    const fileKey = `${file.name}:${file.size || 0}:${file.lastModified || 0}`;
    if (existingKeys.has(fileKey)) continue;
    const { artist, title } = parseLocalAudioFilename(file.name);
    const stem = stripFileExtension(file.name).toLowerCase();
    const lrcFile = lrcByStem.get(stem);
    const src = createObjectURL(file);
    const lyrics = lrcFile ? createObjectURL(lrcFile) : '';
    if (lyrics) matchedLyrics += 1;
    localSongs.push({
      fileKey,
      title,
      artist,
      album: LOCAL_PLAYLIST_NAME,
      src,
      lyrics,
      duration: 0,
      cover: '/icons/orbit-512.png',
    });
    existingKeys.add(fileKey);
    added += 1;
  }

  if (localSongs.length) active = true;
  return {
    added,
    total: localSongs.length,
    skipped: Math.max(0, audioFiles.length - added),
    matchedLyrics,
    id: LOCAL_PLAYLIST_ID,
    name: LOCAL_PLAYLIST_NAME,
  };
}

export function switchLocalPlaylist(tracks, playlistId = LOCAL_PLAYLIST_ID) {
  for (let i = tracks.length - 1; i >= 0; i -= 1) {
    if (tracks[i]?.provider === 'localfile') tracks.splice(i, 1);
  }
  if (playlistId !== LOCAL_PLAYLIST_ID || !localSongs.length) {
    tracks.forEach((item, index) => { item.id = index; });
    return { id: null, count: 0 };
  }
  active = true;
  const startId = tracks.length;
  localSongs.forEach((song, index) => {
    tracks.push(toOrbitLocalTrack(song, startId + index));
  });
  tracks.forEach((item, index) => { item.id = index; });
  return { id: LOCAL_PLAYLIST_ID, name: LOCAL_PLAYLIST_NAME, count: localSongs.length };
}

export function clearLocalTracks(tracks = []) {
  localSongs.forEach(revokeSongUrls);
  localSongs = [];
  active = false;
  for (let i = tracks.length - 1; i >= 0; i -= 1) {
    if (tracks[i]?.provider === 'localfile') tracks.splice(i, 1);
  }
  tracks.forEach((item, index) => { item.id = index; });
  return true;
}
