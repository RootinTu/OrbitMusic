import test from 'node:test';
import assert from 'node:assert/strict';
import {
  kugouSongPage, listKugouAccountPlaylists, listKugouAccountSongs,
} from '../desktop/kugou-session.mjs';

const hash = '48C685F679FFC7CF08B8A8341CA9DB44';
const reply = payload => Response.json(payload);
const rejected = { ok: false, reason: 'login' };

test('missing or stale credentials do not grant Kugou account access', async () => {
  let requests = 0;
  const cookieSession = {
    cookies: { get: async () => [] },
    fetch: async () => { requests++; return new Response(null, { status: 302 }); },
  };
  assert.deepEqual(await listKugouAccountPlaylists(cookieSession), rejected);
  assert.equal(requests, 0);
  cookieSession.cookies.get = async () => [{ name: 'KuGoo' }];
  assert.deepEqual(await listKugouAccountPlaylists(cookieSession), rejected);
  assert.equal(requests, 1);
});

test('verified account playlist and song requests stay in the session and return only display data', async () => {
  const cookieSession = {
    cookies: { get: async filter => {
      assert.equal(filter.name, 'KuGoo');
      assert.equal(new URL(filter.url).hostname, 'www.kugou.com');
      return [{ name: 'KuGoo', value: 'session-only' }];
    } },
    fetch: async (input, options) => {
      const url = new URL(input);
      assert.equal(url.origin + url.pathname, 'https://www.kugou.com/uc/getdata.php');
      assert.equal(options.method, 'POST');
      assert.equal(options.credentials, 'include');
      assert.equal(options.redirect, 'manual');
      assert.equal(options.headers, undefined);
      if (url.searchParams.get('type') === '16') {
        return reply({ list: [{ listID: '126', listName: '我喜欢', privateField: 'do-not-return' }] });
      }
      assert.equal(url.searchParams.get('listid'), '126');
      assert.equal(url.searchParams.get('type'), '17');
      return reply([{ fileName: '歌手 - 歌名', fileHash: hash, fileTimeLen: 176, imgurl: 'https://elsewhere.test/image.png' }]);
    },
  };
  assert.deepEqual(await listKugouAccountPlaylists(cookieSession), { ok: true, playlists: [{ id: '126', name: '我喜欢' }] });
  const result = await listKugouAccountSongs(cookieSession, '126');
  assert.equal(result.songs[0].name, '歌名');
  assert.equal(result.songs[0].artist, '歌手');
  assert.equal(result.songs[0].hash, hash);
  assert.equal(result.songs[0].cover, '');
  assert.equal(result.songs[0].durationMs, 176000);
  assert.equal(result.songs[0].sourceUrl, `https://www.kugou.com/song/#hash=${hash}`);
  await assert.rejects(listKugouAccountSongs(cookieSession, 'other'), /当前账号/);
});

test('playback takes an official song identity, never a caller-supplied URL', () => {
  assert.equal(kugouSongPage('https://example.com'), '');
  assert.equal(kugouSongPage(hash, '42', '/evil?url=https://example.com'), `https://www.kugou.com/song/#hash=${hash}&album_id=42`);
  assert.equal(kugouSongPage(hash, '42', 'kugou1'), 'https://www.kugou.com/mixsong/kugou1.html');
});
