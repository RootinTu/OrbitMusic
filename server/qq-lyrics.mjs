import { decodeQQCloudLyrics } from './qq-lyrics-codec.mjs';

export function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ');
}

export function decodeQQLyricText(text) {
  let raw = String(text || '').trim();
  if (raw.includes('LyricContent')) return raw;
  raw = decodeHtmlEntities(raw);
  const compact = raw.replace(/\s+/g, '');
  const looksBase64 = compact.length >= 8 && compact.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(compact);
  if (looksBase64 && !/^[\da-f]+$/i.test(compact) && !/^\s*\[/.test(raw)) {
    try {
      raw = Buffer.from(compact, 'base64').toString('utf8').replace(/^\uFEFF/, '');
    } catch {
      // Keep the original response when it is not actually base64.
    }
  }
  raw = decodeQQCloudLyrics(raw);
  return (raw.includes('LyricContent') ? raw : decodeHtmlEntities(raw)).replace(/\r\n/g, '\n').trim();
}

export async function fetchQQLyric(mid, id, cookieText, { qqMusicRequest }) {
  const songMID = String(mid || '').trim();
  const songID = Number(String(id || '').replace(/\D/g, '')) || 0;
  if (!songMID && !songID) return { provider: 'qq', error: 'Missing QQ song mid or id', lyric: '' };

  const param = {
    crypt: 1, lrc_t: 0, qrc_t: 0, trans: 1, trans_t: 0,
    roma: 0, roma_t: 0, type: 1,
  };
  if (songMID) param.songMid = songMID;
  else param.songId = songID;
  const request = qrc => ({
    module: 'music.musichallSong.PlayLyricInfo',
    method: 'GetPlayLyricInfo', param: { ...param, qrc },
  });
  const data = await qqMusicRequest({
    comm: { ct: 24, cv: 4747474 },
    lyric: request(0),
    wordLyric: request(1),
  }, cookieText, true);
  const lyricData = data?.lyric?.data || {};
  const wordData = data?.wordLyric?.data || {};
  if (!data?.lyric?.data && !data?.wordLyric?.data) throw new Error('QQ 音乐暂未返回歌词数据');
  const decode = raw => {
    try { return decodeQQLyricText(raw); }
    catch { return ''; } // A damaged QRC must not suppress an available LRC.
  };
  return {
    provider: 'qq',
    id: songID || '',
    mid: songMID,
    lyric: decode(lyricData.lyric),
    tlyric: decode(lyricData.trans || wordData.trans),
    qrc: decode(wordData.lyric || lyricData.qrc),
  };
}
