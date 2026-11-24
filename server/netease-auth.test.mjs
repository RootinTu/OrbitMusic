import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {
  buildNeteaseAudioHeaders,
  buildNeteasePlayerUrl,
  createBoundedTtlCache,
  hasNeteaseLogin,
  hashNeteaseCookieScope,
  isAllowedNeteaseAudioUrl,
  mapNeteaseSong,
  normalizeNeteaseBitrate,
  normalizeNeteaseCookie,
  registerNeteaseMusicExpressRoutes,
} from './netease-music.mjs';

test('normalizes multiline Netease cookies and detects MUSIC_U', () => {
  const cookie = normalizeNeteaseCookie('MUSIC_U=token;\n__csrf=value;;');
  assert.equal(cookie, 'MUSIC_U=token; __csrf=value');
  assert.equal(hasNeteaseLogin(cookie), true);
  assert.equal(hasNeteaseLogin('__csrf=value'), false);
});

test('allows supported bitrates and falls back to 320k', () => {
  assert.equal(normalizeNeteaseBitrate('128000'), '128000');
  assert.equal(normalizeNeteaseBitrate('999999'), '320000');
  assert.match(buildNeteasePlayerUrl('123', '192000'), /id=123.*br=192000/);
});

test('maps both old and new Netease song payloads', () => {
  assert.deepEqual(mapNeteaseSong({ id: 7, name: '夜航', ar: [{ name: '月' }], al: { name: '轨道', picUrl: 'cover' }, dt: 215000, fee: 1 }), {
    provider: 'netease', id: '7', name: '夜航', artist: '月', album: '轨道', cover: 'cover', duration: 215000, fee: 1,
  });
});

test('audio proxy headers never include Cookie and audio URL validator blocks untrusted hosts', () => {
  const audioHeaders = buildNeteaseAudioHeaders('bytes=0-1023');
  assert.equal('Cookie' in audioHeaders, false);
  assert.equal('cookie' in audioHeaders, false);
  assert.equal(audioHeaders.Range, 'bytes=0-1023');
  assert.equal(audioHeaders.Referer, 'https://music.163.com/');

  assert.equal(isAllowedNeteaseAudioUrl('https://m701.music.126.net/20261124/song.mp3'), true);
  assert.equal(isAllowedNeteaseAudioUrl('http://m8.music.126.net/song.flac'), true);
  assert.equal(isAllowedNeteaseAudioUrl('https://126.net.evil.example/song.mp3'), false);
  assert.equal(isAllowedNeteaseAudioUrl('http://127.0.0.1:45437/api/qq/login/status'), false);
  assert.equal(isAllowedNeteaseAudioUrl('file:///C:/secret.txt'), false);
});

test('bounded TTL cache enforces capacity, LRU eviction, TTL expiration, and hashed cookie scopes', () => {
  let clock = 1000;
  const cache = createBoundedTtlCache({ maxEntries: 2, ttlMs: 500, now: () => clock });
  cache.set('a', 'url-a');
  cache.set('b', 'url-b');
  // Touch 'a' so 'b' becomes least recently used
  assert.equal(cache.get('a'), 'url-a');
  cache.set('c', 'url-c');
  assert.equal(cache.size, 2);
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('a'), 'url-a');
  assert.equal(cache.get('c'), 'url-c');

  clock += 600;
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.get('c'), undefined);

  const scope = hashNeteaseCookieScope('MUSIC_U=secret-raw-token-value; __csrf=123');
  assert.equal(scope.length, 16);
  assert.equal(scope.includes('secret-raw-token'), false);
  assert.equal(hashNeteaseCookieScope(''), 'anon');
});

test('Netease /api/netease/audio strips MUSIC_U cookie before fetching audio CDN', async () => {
  const app = express();
  app.use(express.json());
  registerNeteaseMusicExpressRoutes(app);
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const originalFetch = globalThis.fetch;
  const seenRequests = [];

  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    if (href.startsWith(baseUrl)) return originalFetch(url, options);
    seenRequests.push({ href, headers: options.headers || {} });
    if (href.includes('/api/nuser/account/get')) {
      return new Response(JSON.stringify({ profile: { userId: 42, nickname: '测试用户' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (href.includes('/api/song/enhance/player/url')) {
      return new Response(JSON.stringify({ data: [{ url: 'https://m701.music.126.net/demo/track.mp3' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (href === 'https://m701.music.126.net/demo/track.mp3') {
      return new Response(Buffer.from('ID3-AUDIO-BYTES'), {
        status: 200,
        headers: { 'Content-Type': 'audio/mpeg' },
      });
    }
    return new Response('unexpected', { status: 404 });
  };

  try {
    const loginRes = await originalFetch(`${baseUrl}/api/netease/login/cookie`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookie: 'MUSIC_U=super-secret-session; __csrf=abc' }),
    });
    assert.equal(loginRes.status, 200);

    const audioRes = await originalFetch(`${baseUrl}/api/netease/audio?id=1001&br=320000`, {
      headers: { Range: 'bytes=0-14' },
    });
    assert.equal(audioRes.status, 200);
    assert.equal(await audioRes.text(), 'ID3-AUDIO-BYTES');

    const cdnCall = seenRequests.find(item => item.href === 'https://m701.music.126.net/demo/track.mp3');
    assert.ok(cdnCall, 'expected audio CDN fetch');
    assert.equal(cdnCall.headers.Cookie, undefined);
    assert.equal(cdnCall.headers.cookie, undefined);
    assert.equal(cdnCall.headers.Range, 'bytes=0-14');

    const apiCall = seenRequests.find(item => item.href.includes('/api/song/enhance/player/url'));
    assert.ok(apiCall, 'expected Netease player URL API fetch');
    assert.match(String(apiCall.headers.Cookie || ''), /MUSIC_U=super-secret-session/);
  } finally {
    globalThis.fetch = originalFetch;
    await originalFetch(`${baseUrl}/api/netease/logout`, { method: 'POST' }).catch(() => {});
    await new Promise(resolve => server.close(resolve));
  }
});
