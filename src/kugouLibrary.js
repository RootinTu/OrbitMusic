const KEY = 'orbit.kugou.library.v1';
const HASH = /^[a-f0-9]{32}$/i;
export const MAX_KUGOU_TRACKS = 150;
export const MAX_KUGOU_PLAYLISTS = 8;

function uniqueSongs(songs) {
  const unique = new Map();
  for (const song of Array.isArray(songs) ? songs : []) {
    const hash = String(song?.hash || '').toUpperCase();
    const name = String(song?.name || '').trim();
    if (HASH.test(hash) && name && !unique.has(hash)) unique.set(hash, { ...song, hash, name });
  }
  return [...unique.values()];
}

function read() {
  try {
    const value = JSON.parse(localStorage.getItem(KEY));
    if (Array.isArray(value?.playlists)) {
      const playlists = value.playlists.filter(item => item?.id).map(item => ({
        ...item, songs: uniqueSongs(item.songs).slice(0, MAX_KUGOU_TRACKS),
      })).filter(item => item.songs.length).slice(0, MAX_KUGOU_PLAYLISTS);
      return { playlists, activeId: playlists.some(item => item.id === value.activeId) ? value.activeId : playlists[0]?.id ?? null };
    }
  } catch { /* start with an empty library */ }
  return { playlists: [], activeId: null };
}

function save(library) {
  try { localStorage.setItem(KEY, JSON.stringify(library)); } catch { return false; }
  return true;
}

export const listKugouPlaylists = () => read().playlists.map(({ id, name, songs }) => ({ id, name, cover: songs[0].cover, count: songs.length }));
export const getActiveKugouPlaylistId = () => read().activeId;

export function importKugouTracks(songs, meta = {}) {
  const incoming = uniqueSongs(songs);
  if (!incoming.length) return { added: 0, reason: 'empty' };
  const stored = read();
  const id = meta.id || 'loose';
  let playlist = stored.playlists.find(item => item.id === id);
  if (!playlist) {
    if (stored.playlists.length >= MAX_KUGOU_PLAYLISTS) return { added: 0, reason: 'playlist-limit' };
    playlist = { id, name: meta.name || '酷狗零散导入', songs: [] };
    stored.playlists.push(playlist);
  }
  const known = new Set(playlist.songs.map(song => song.hash));
  const fresh = incoming.filter(song => !known.has(song.hash));
  if (!fresh.length) return { added: 0, reason: 'duplicate' };
  const selected = fresh.slice(0, MAX_KUGOU_TRACKS - playlist.songs.length);
  if (!selected.length) return { added: 0, reason: 'track-limit' };
  playlist.songs.push(...selected);
  stored.activeId = id;
  if (!save(stored)) return { added: 0, reason: 'storage' };
  return { id, name: playlist.name, added: selected.length, count: playlist.songs.length };
}

function removeTracks(library) {
  for (let i = library.length - 1; i >= 0; i--) {
    if (library[i]?.provider === 'kugou') library.splice(i, 1);
  }
  library.forEach((track, index) => { track.id = index; });
}

export function proxyKugouCover(rawCover) {
  const value = String(rawCover || '').trim();
  if (!value) return '';
  if (value.startsWith('/api/kugou/cover?')) return value;
  if (/^https?:\/\//i.test(value)) return `/api/kugou/cover?url=${encodeURIComponent(value)}`;
  return value;
}

export function switchKugouPlaylist(library, id) {
  const stored = read();
  const playlist = stored.playlists.find(item => item.id === id);
  if (!playlist) return { id: null, count: 0 };
  stored.activeId = id;
  save(stored);
  removeTracks(library);
  for (const song of playlist.songs) {
    const durationMs = Math.max(0, Math.round(Number(song.durationMs) || 0));
    library.push({
      ...song,
      cover: proxyKugouCover(song.cover),
      id: library.length, title: song.name, artist: song.artist || '酷狗音乐', provider: 'kugou',
      duration: durationMs / 1000, genre: 'KUGOU MUSIC',
      src: `/api/kugou/audio?hash=${song.hash}`,
      lyrics: `/api/kugou/lyric?hash=${song.hash}&duration=${durationMs}`,
      note: '从酷狗音乐导入。在 ORBIT 内通过本地音频流代理原生播放。',
    });
  }
  return { id, count: playlist.songs.length };
}

export function clearKugouTracks(library) {
  if (!save({ playlists: [], activeId: null })) return false;
  removeTracks(library);
  return true;
}
