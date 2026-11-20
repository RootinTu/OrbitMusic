export const KUGOU_HOME = 'https://www.kugou.com/';
const COLLECTION = new URL('uc/getdata.php', KUGOU_HOME);
const HASH = /^[a-f0-9]{32}$/i;
const LIST_ID = /^[a-z0-9_-]{1,64}$/i;

function safeImage(value) {
  try {
    const url = new URL(String(value || '').replace('{size}', '400'));
    if (url.protocol === 'http:') url.protocol = 'https:';
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      /(?:^|\.)(?:kugou\.com|kgimg\.com)$/i.test(url.hostname)) return url.href;
  } catch { /* no usable artwork */ }
  return '';
}

export function kugouSongPage(hash, albumId, pageId) {
  if (typeof hash !== 'string' || !HASH.test(hash)) return '';
  if (/^[a-z0-9]{2,24}$/i.test(pageId || '')) return new URL(`mixsong/${pageId}.html`, KUGOU_HOME).href;
  const parameters = new URLSearchParams({ hash: hash.toUpperCase() });
  if (/^\d{1,16}$/.test(albumId || '')) parameters.set('album_id', albumId);
  return `${KUGOU_HOME}song/#${parameters}`;
}

export function normalizeKugouCollectionSong(row) {
  const hash = String(row?.fileHash || '').toUpperCase();
  const filename = String(row?.fileName || '').trim().slice(0, 600);
  if (!HASH.test(hash) || !filename) return null;
  const dash = filename.indexOf(' - ');
  const name = dash > 0 ? filename.slice(dash + 3).trim() : filename;
  if (!name) return null;
  const artist = dash > 0 ? filename.slice(0, dash) : '';
  const albumId = /^\d{1,16}$/.test(row.album_id ?? '') ? String(row.album_id) : '';
  const pageId = /^[a-z0-9]{2,24}$/i.test(row.encode_album_audio_id ?? '') ? String(row.encode_album_audio_id) : '';
  const duration = Number(row.fileTimeLen);
  return {
    hash, name, artist, albumId, pageId,
    album: String(row.albumName || '酷狗网络收藏').slice(0, 200),
    cover: safeImage(row.image || row.imgurl),
    durationMs: Number.isFinite(duration) && duration > 0 ? duration * (duration < 10000 ? 1000 : 1) : 0,
    sourceUrl: kugouSongPage(hash, albumId, pageId),
  };
}

async function readCollection(cookieSession, type, id) {
  const url = new URL(COLLECTION);
  url.searchParams.set('type', type);
  if (id) url.searchParams.set('listid', id);
  // Keep credentials in Chromium's isolated cookie jar. Never serialize them
  // to the renderer or the loopback music server.
  const response = await cookieSession.fetch(url.href, {
    method: 'POST',
    body: new URLSearchParams({ n: String(Math.random()) }),
    credentials: 'include',
    redirect: 'manual',
    signal: AbortSignal.timeout(10000),
  });
  if ([301, 302, 303, 307, 308, 401, 403].includes(response.status) || response.type === 'opaqueredirect') {
    return { ok: false, reason: 'login' };
  }
  if (!response.ok) throw new Error('酷狗暂时无法读取网络收藏');
  return { ok: true, data: await response.json() };
}

export async function listKugouAccountPlaylists(cookieSession) {
  // The official web page uses this cookie to identify a session. Its value
  // is not trusted as validation: the collection request must also succeed.
  if (!(await cookieSession.cookies.get({ url: COLLECTION.href, name: 'KuGoo' })).length) {
    return { ok: false, reason: 'login' };
  }
  const result = await readCollection(cookieSession, '16');
  if (!result.ok) return result;
  if (!Array.isArray(result.data?.list)) throw new Error('酷狗没有返回可读取的账号歌单');
  const lists = result.data.list.flatMap(row => {
    const id = String(row?.listID ?? '');
    const name = String(row?.listName || '').trim().slice(0, 200);
    return LIST_ID.test(id) && name ? [{ id, name }] : [];
  });
  return { ok: true, playlists: [...new Map(lists.map(item => [item.id, item])).values()] };
}

export async function listKugouAccountSongs(cookieSession, id) {
  if (typeof id !== 'string' || !LIST_ID.test(id)) throw new Error('无效的酷狗歌单编号');
  const account = await listKugouAccountPlaylists(cookieSession);
  if (!account.ok) return account;
  const playlist = account.playlists.find(row => row.id === id);
  if (!playlist) throw new Error('当前账号找不到这份酷狗歌单');
  const result = await readCollection(cookieSession, '17', id);
  if (!result.ok) return result;
  if (!Array.isArray(result.data)) throw new Error('酷狗没有返回可读取的歌曲');
  const songs = result.data.map(normalizeKugouCollectionSong).filter(Boolean);
  return { ok: true, ...playlist, songs: [...new Map(songs.map(song => [song.hash, song])).values()] };
}
