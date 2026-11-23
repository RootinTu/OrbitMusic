// Lyrics, public playlists and public search are public metadata.
// Account and playback operations are handled in Electron's isolated Kugou session.
const HASH = /^[a-f0-9]{32}$/i;
const SPECIAL_ID = /^\d{1,16}$/;
const KUGOU_API_ORIGIN = 'http://mobilecdnbj.kugou.com';

function safeKugouImage(value) {
  try {
    const url = new URL(String(value || '').replace('{size}', '400'));
    if (url.protocol === 'http:') url.protocol = 'https:';
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      /(?:^|\.)(?:kugou\.com|kgimg\.com)$/i.test(url.hostname)) return url.href;
  } catch { /* no usable artwork */ }
  return '';
}

function buildSongPage(hash, albumId) {
  const params = new URLSearchParams({ hash: hash.toUpperCase() });
  if (SPECIAL_ID.test(albumId || '')) params.set('album_id', albumId);
  return `https://www.kugou.com/song/#${params}`;
}

export function extractKugouSpecialId(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  if (SPECIAL_ID.test(text)) return text;
  const fromPath = text.match(/\/special\/single\/(\d{1,16})\.html/i)
    || text.match(/\/plist\/list\/(\d{1,16})(?:[/?#]|$)/i)
    || text.match(/[?&]specialid=(\d{1,16})(?:[&#]|$)/i);
  return fromPath ? fromPath[1] : '';
}

function normalizePublicSong(row) {
  const hash = String(row?.hash || row?.fileHash || '').toUpperCase();
  if (!HASH.test(hash)) return null;
  let name = String(row?.songname || row?.songname_original || '').trim();
  let artist = String(row?.singername || '').trim();
  const filename = String(row?.filename || row?.fileName || '').trim();
  if (!name && filename) {
    const dash = filename.indexOf(' - ');
    name = dash > 0 ? filename.slice(dash + 3).trim() : filename;
    if (!artist && dash > 0) artist = filename.slice(0, dash).trim();
  }
  if (!name) return null;
  const albumId = SPECIAL_ID.test(String(row?.album_id ?? '')) ? String(row.album_id) : '';
  const duration = Number(row?.duration);
  const durationMs = Number.isFinite(duration) && duration > 0 ? duration * (duration < 10000 ? 1000 : 1) : 0;
  return {
    hash,
    name: name.slice(0, 200),
    artist: artist.slice(0, 200),
    album: String(row?.album_name || row?.remark || '酷狗音乐').slice(0, 200),
    albumId,
    pageId: '',
    cover: safeKugouImage(row?.imgurl || row?.img || row?.album_img),
    durationMs,
    sourceUrl: buildSongPage(hash, albumId),
  };
}

async function resolveShortKugouUrl(raw) {
  const match = String(raw || '').match(/https?:\/\/[a-z0-9.-]+\.kugou\.com\/[^\s]+/i);
  if (!match) return '';
  try {
    const parsed = new URL(match[0]);
    if (!/(?:^|\.)kugou\.com$/i.test(parsed.hostname)) return '';
    const response = await fetch(parsed.href, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
    });
    const location = response.headers.get('location') || '';
    return extractKugouSpecialId(location) || extractKugouSpecialId(parsed.href);
  } catch {
    return '';
  }
}

export function registerKugouMusicExpressRoutes(app) {
  app.get('/api/kugou/lyric', async (req, res) => {
    const hash = typeof req.query.hash === 'string' ? req.query.hash.trim() : '';
    if (!HASH.test(hash)) return res.status(400).json({ error: '无效的酷狗歌曲编号。' });
    const duration = typeof req.query.duration === 'string' ? req.query.duration : '';
    const parameters = new URLSearchParams({ cmd: '100', hash, timelength: /^\d{1,9}$/.test(duration) ? duration : '0' });
    try {
      const response = await fetch(`https://m.kugou.com/app/i/krc.php?${parameters}`, {
        signal: AbortSignal.timeout(10000), redirect: 'error',
      });
      if (!response.ok) throw new Error('Kugou lyrics unavailable');
      const text = await response.text();
      res.type('text/plain').send(/^\s*\[\d+:\d+/m.test(text) ? text : '');
    } catch {
      if (!res.destroyed) res.status(502).json({ error: '暂时无法加载酷狗歌词。' });
    }
  });

  app.get('/api/kugou/playlist', async (req, res) => {
    const input = typeof req.query.input === 'string' ? req.query.input.trim() : '';
    const customName = typeof req.query.name === 'string' ? req.query.name.trim().slice(0, 120) : '';
    if (!input) return res.status(400).json({ error: '请输入酷狗歌单链接或歌单 ID。' });
    let specialId = extractKugouSpecialId(input);
    if (!specialId) specialId = await resolveShortKugouUrl(input);
    if (!specialId) {
      return res.status(400).json({ error: '未识别到酷狗歌单 ID。请粘贴含 specialid / special/single 的链接，或直接输入歌单关键词搜索。' });
    }
    try {
      const params = new URLSearchParams({ specialid: specialId, page: '1', pagesize: '30', plat: '0' });
      const response = await fetch(`${KUGOU_API_ORIGIN}/api/v3/special/song?${params}`, {
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error('Kugou playlist unavailable');
      const payload = await response.json();
      const rows = Array.isArray(payload?.data?.info) ? payload.data.info : [];
      const songs = [...new Map(rows.map(normalizePublicSong).filter(Boolean).map(song => [song.hash, song])).values()];
      if (!songs.length) return res.status(404).json({ error: '该酷狗歌单里没有可读取的歌曲。' });
      res.json({ ok: true, id: `special:${specialId}`, name: customName || `酷狗歌单 ${specialId}`, songs });
    } catch {
      if (!res.destroyed) res.status(502).json({ error: '暂时无法读取酷狗公开歌单，请稍后再试。' });
    }
  });

  app.get('/api/kugou/search', async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
    const type = req.query.type === 'playlist' ? 'playlist' : 'song';
    if (!q) return res.status(400).json({ error: '请输入要搜索的关键词。' });
    try {
      const endpoint = type === 'playlist' ? '/api/v3/search/special' : '/api/v3/search/song';
      const params = new URLSearchParams({ keyword: q, page: '1', pagesize: type === 'playlist' ? '15' : '30' });
      const response = await fetch(`${KUGOU_API_ORIGIN}${endpoint}?${params}`, {
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error('Kugou search unavailable');
      const payload = await response.json();
      const rows = Array.isArray(payload?.data?.info) ? payload.data.info : [];
      if (type === 'playlist') {
        const playlists = rows.flatMap(item => {
          const id = String(item?.specialid ?? '');
          const name = String(item?.specialname || '').trim().slice(0, 120);
          if (!SPECIAL_ID.test(id) || !name) return [];
          return [{
            id,
            name,
            cover: safeKugouImage(item?.imgurl),
            count: Number(item?.songcount) || 0,
            creator: String(item?.nickname || '').trim().slice(0, 80),
          }];
        });
        res.json({ ok: true, playlists });
      } else {
        const songs = [...new Map(rows.map(normalizePublicSong).filter(Boolean).map(song => [song.hash, song])).values()];
        res.json({ ok: true, songs });
      }
    } catch {
      if (!res.destroyed) res.status(502).json({ error: '暂时无法搜索酷狗曲库，请稍后再试。' });
    }
  });
}
