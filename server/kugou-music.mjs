// Lyrics, public playlists and public search are public metadata.
// Account and playback operations are handled in Electron's isolated Kugou session.
import { Readable } from 'node:stream';
import { classifyUpstreamError, fetchStreamWithTimeout, fetchWithTimeout } from './http-client.mjs';
import { createBoundedTtlCache } from './netease-music.mjs';

const HASH = /^[a-f0-9]{32}$/i;
const SPECIAL_ID = /^\d{1,16}$/;
const KUGOU_API_ORIGIN = 'http://mobilecdnbj.kugou.com';
const KUGOU_AUDIO_CDN_SUFFIXES = ['kugou.com', 'kugou.net', 'kgimg.com', 'kugoucdn.com'];
const KUGOU_AUDIO_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36';
const KUGOU_AUDIO_CACHE_TTL_MS = 8 * 60 * 1000;
const audioSourceCache = createBoundedTtlCache({ maxEntries: 120, ttlMs: KUGOU_AUDIO_CACHE_TTL_MS });

export function isAllowedKugouAudioUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || '').trim());
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    if (parsed.username || parsed.password || parsed.port) return false;
    const host = parsed.hostname.toLowerCase();
    return KUGOU_AUDIO_CDN_SUFFIXES.some(suffix => host === suffix || host.endsWith(`.${suffix}`));
  } catch {
    return false;
  }
}

export function buildKugouAudioHeaders(range) {
  const headers = {
    Accept: '*/*',
    Referer: 'https://www.kugou.com/',
    'User-Agent': KUGOU_AUDIO_USER_AGENT,
  };
  if (range) headers.Range = range;
  return headers;
}

export function putKugouAudioSource(entry) {
  const hash = String(entry?.hash || '').trim().toUpperCase();
  const primary = String(entry?.url || '').trim();
  if (!HASH.test(hash) || !isAllowedKugouAudioUrl(primary)) return null;
  const backups = Array.isArray(entry?.backupUrls)
    ? entry.backupUrls.map(item => String(item || '').trim()).filter(item => item && item !== primary && isAllowedKugouAudioUrl(item))
    : [];
  const normalized = {
    hash,
    url: primary,
    backupUrls: [...new Set(backups)].slice(0, 4),
    isFreePart: Boolean(entry?.isFreePart),
    durationMs: Math.max(0, Number(entry?.durationMs) || 0),
  };
  audioSourceCache.set(hash, normalized);
  return normalized;
}

export function clearKugouAudioSourceCache() {
  audioSourceCache.clear();
}

async function resolvePublicKugouAudio(hash) {
  try {
    const response = await fetchWithTimeout(`https://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=${hash}`, {
      headers: { Referer: 'https://m.kugou.com/', 'User-Agent': KUGOU_AUDIO_USER_AGENT },
    }, { timeoutMs: 8000, label: '酷狗公开音源' });
    if (!response.ok) return null;
    const payload = await response.json().catch(() => ({}));
    const candidates = [
      payload?.url,
      ...(Array.isArray(payload?.backup_url) ? payload.backup_url : []),
    ].map(item => String(item || '').trim()).filter(isAllowedKugouAudioUrl);
    if (!candidates.length) return null;
    return putKugouAudioSource({
      hash,
      url: candidates[0],
      backupUrls: candidates.slice(1),
      isFreePart: false,
      durationMs: (Number(payload?.timeLength) || 0) * 1000,
    });
  } catch {
    return null;
  }
}

async function streamKugouAudio(request, response, upstream, { isFreePart = false } = {}) {
  response.status(upstream.status);
  response.setHeader('Content-Type', upstream.headers.get('content-type') || 'audio/mpeg');
  response.setHeader('Accept-Ranges', upstream.headers.get('accept-ranges') || 'bytes');
  response.setHeader('Cache-Control', 'no-store');
  if (isFreePart) response.setHeader('X-Orbit-Kugou-Trial', '1');
  const length = upstream.headers.get('content-length');
  const range = upstream.headers.get('content-range');
  if (length) response.setHeader('Content-Length', length);
  if (range) response.setHeader('Content-Range', range);
  if (!upstream.body) return response.end();
  const stream = Readable.fromWeb(upstream.body);
  request.on('close', () => stream.destroy());
  await new Promise((resolve, reject) => {
    stream.on('error', reject);
    response.on('finish', resolve);
    response.on('close', resolve);
    stream.pipe(response);
  });
}

export function safeKugouImage(value) {
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
  const albumAudioId = SPECIAL_ID.test(String(row?.album_audio_id ?? row?.mixsongid ?? ''))
    ? String(row.album_audio_id ?? row.mixsongid) : '';
  const duration = Number(row?.duration);
  const durationMs = Number.isFinite(duration) && duration > 0 ? duration * (duration < 10000 ? 1000 : 1) : 0;
  return {
    hash,
    name: name.slice(0, 200),
    artist: artist.slice(0, 200),
    album: String(row?.album_name || row?.remark || '酷狗音乐').slice(0, 200),
    albumId,
    albumAudioId,
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
    const response = await fetchWithTimeout(parsed.href, {
      method: 'GET',
      redirect: 'manual',
    }, { timeoutMs: 8000, label: '酷狗音乐' });
    const location = response.headers.get('location') || '';
    return extractKugouSpecialId(location) || extractKugouSpecialId(parsed.href);
  } catch {
    return '';
  }
}

export function registerKugouMusicExpressRoutes(app) {
  app.get('/api/kugou/cover', async (req, res) => {
    const rawUrl = typeof req.query.url === 'string' ? req.query.url.trim() : '';
    const targetUrl = safeKugouImage(rawUrl);
    if (!targetUrl) return res.status(400).json({ error: '无效的酷狗封面地址。' });
    try {
      const fetchRes = await fetchWithTimeout(targetUrl, {
        headers: { Referer: 'https://www.kugou.com/' },
      }, { timeoutMs: 10000, label: '酷狗封面' });
      if (!fetchRes.ok) return res.status(fetchRes.status).json({ error: '无法加载酷狗封面。' });
      const contentType = String(fetchRes.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
      if (!/^image\//i.test(contentType)) return res.status(502).json({ error: '酷狗封面返回了非图片内容。' });
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'private, max-age=86400');
      const buffer = await fetchRes.arrayBuffer();
      res.end(Buffer.from(buffer));
    } catch (error) {
      if (!res.destroyed) {
        const info = classifyUpstreamError(error, '暂时无法加载酷狗封面。');
        res.status(info.status).json({ error: info.message, message: info.message, code: info.code });
      }
    }
  });

  app.put('/api/kugou/audio/source', (req, res) => {
    const saved = putKugouAudioSource(req.body);
    if (!saved) {
      return res.status(400).json({ ok: false, error: '无效的酷狗音源地址或歌曲编号。' });
    }
    res.json({ ok: true, hash: saved.hash, isFreePart: saved.isFreePart, durationMs: saved.durationMs });
  });

  app.delete('/api/kugou/audio/source', (_req, res) => {
    clearKugouAudioSourceCache();
    res.json({ ok: true });
  });

  app.get('/api/kugou/audio', async (req, res) => {
    const hash = typeof req.query.hash === 'string' ? req.query.hash.trim().toUpperCase() : '';
    if (!HASH.test(hash)) return res.status(400).json({ error: '无效的酷狗歌曲编号。', message: '无效的酷狗歌曲编号。' });
    try {
      let entry = audioSourceCache.get(hash);
      if (!entry) entry = await resolvePublicKugouAudio(hash);
      if (!entry) {
        return res.status(404).json({
          error: '酷狗暂未返回可播放音源，歌曲可能受会员或版权限制。',
          message: '酷狗暂未返回可播放音源，歌曲可能受会员或版权限制。',
        });
      }
      const candidates = [entry.url, ...entry.backupUrls].filter(isAllowedKugouAudioUrl);
      if (!candidates.length) {
        return res.status(502).json({ error: '酷狗返回了不受信任的音源地址。', message: '酷狗返回了不受信任的音源地址。' });
      }
      const upstreamHeaders = buildKugouAudioHeaders(req.headers.range);
      let lastStatus = 502;
      let lastError = null;
      for (const targetUrl of candidates) {
        try {
          const upstream = await fetchStreamWithTimeout(targetUrl, { headers: upstreamHeaders, redirect: 'error' }, {
            connectTimeoutMs: 15000,
            label: '酷狗音源',
            clientRequest: req,
          });
          if (upstream.ok || upstream.status === 206) {
            await streamKugouAudio(req, res, upstream, { isFreePart: entry.isFreePart });
            return;
          }
          lastStatus = upstream.status;
          upstream.body?.cancel?.().catch(() => {});
        } catch (error) {
          lastError = error;
          if (req.destroyed || res.destroyed) return;
        }
      }
      if (!res.headersSent) {
        if (lastError) {
          const info = classifyUpstreamError(lastError, '酷狗音源代理请求失败。');
          res.status(info.status).json({ error: info.message, message: info.message, code: info.code });
        } else {
          res.status(lastStatus).json({ error: '酷狗音源流加载失败，请稍后重试。', message: '酷狗音源流加载失败，请稍后重试。' });
        }
      }
    } catch (error) {
      if (!res.headersSent) {
        const info = classifyUpstreamError(error, '酷狗音源代理失败。');
        res.status(info.status).json({ error: info.message, message: info.message, code: info.code });
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  });

  app.get('/api/kugou/lyric', async (req, res) => {
    const hash = typeof req.query.hash === 'string' ? req.query.hash.trim() : '';
    if (!HASH.test(hash)) return res.status(400).json({ error: '无效的酷狗歌曲编号。' });
    const duration = typeof req.query.duration === 'string' ? req.query.duration : '';
    const parameters = new URLSearchParams({ cmd: '100', hash, timelength: /^\d{1,9}$/.test(duration) ? duration : '0' });
    try {
      const response = await fetchWithTimeout(`https://m.kugou.com/app/i/krc.php?${parameters}`, {
        redirect: 'error',
      }, { timeoutMs: 10000, label: '酷狗歌词' });
      if (!response.ok) throw new Error('Kugou lyrics unavailable');
      const text = await response.text();
      res.type('text/plain').send(/^\s*\[\d+:\d+/m.test(text) ? text : '');
    } catch (error) {
      if (!res.destroyed) {
        const info = classifyUpstreamError(error, '暂时无法加载酷狗歌词。');
        res.status(info.status).json({ error: info.message, message: info.message, code: info.code });
      }
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
      const response = await fetchWithTimeout(`${KUGOU_API_ORIGIN}/api/v3/special/song?${params}`, {}, {
        timeoutMs: 10000,
        label: '酷狗歌单',
      });
      if (!response.ok) throw new Error('Kugou playlist unavailable');
      const payload = await response.json();
      const rows = Array.isArray(payload?.data?.info) ? payload.data.info : [];
      const songs = [...new Map(rows.map(normalizePublicSong).filter(Boolean).map(song => [song.hash, song])).values()];
      if (!songs.length) return res.status(404).json({ error: '该酷狗歌单里没有可读取的歌曲。' });
      res.json({ ok: true, id: `special:${specialId}`, name: customName || `酷狗歌单 ${specialId}`, songs });
    } catch (error) {
      if (!res.destroyed) {
        const info = classifyUpstreamError(error, '暂时无法读取酷狗公开歌单，请稍后再试。');
        res.status(info.status).json({ error: info.message, message: info.message, code: info.code });
      }
    }
  });

  app.get('/api/kugou/search', async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
    const type = req.query.type === 'playlist' ? 'playlist' : 'song';
    if (!q) return res.status(400).json({ error: '请输入要搜索的关键词。' });
    try {
      const endpoint = type === 'playlist' ? '/api/v3/search/special' : '/api/v3/search/song';
      const params = new URLSearchParams({ keyword: q, page: '1', pagesize: type === 'playlist' ? '15' : '30' });
      const response = await fetchWithTimeout(`${KUGOU_API_ORIGIN}${endpoint}?${params}`, {}, {
        timeoutMs: 10000,
        label: '酷狗搜索',
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
    } catch (error) {
      if (!res.destroyed) {
        const info = classifyUpstreamError(error, '暂时无法搜索酷狗曲库，请稍后再试。');
        res.status(info.status).json({ error: info.message, message: info.message, code: info.code });
      }
    }
  });
}
