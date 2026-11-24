import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createKugouQrLogin, getKugouSessionStatus, isAllowedKugouAudioUrl, kugouSongPage,
  listKugouAccountPlaylists, listKugouAccountSongs, parseKugouCookie, pollKugouQrLogin,
  resolveKugouAudioUrl,
} from '../desktop/kugou-session.mjs';
import {
  buildKugouAudioHeaders, clearKugouAudioSourceCache, extractKugouSpecialId,
  isAllowedKugouAudioUrl as isAllowedServerKugouAudioUrl, putKugouAudioSource,
} from './kugou-music.mjs';

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

test('Cookie profile login succeeds even when legacy uc/getdata.php cancels redirects', async () => {
  const parsed = parseKugouCookie('KugooID=12345678&NickName=%u9177%u72D7%u6D4B%u8BD5&t=secret-token&Pic=https://elsewhere.test/a.png');
  assert.equal(parsed.loggedIn, true);
  assert.equal(parsed.profile.nickname, '酷狗测试');
  assert.equal(parsed.profile.avatar, '');
  assert.equal('t' in parsed.profile, false);

  const cookieSession = {
    cookies: { get: async () => [{ name: 'KuGoo', value: 'KugooID=12345678&NickName=%u9177%u72D7%u6D4B%u8BD5&t=secret-token' }] },
    fetch: async () => { throw new TypeError('Redirect was cancelled'); },
  };
  const status = await getKugouSessionStatus(cookieSession);
  assert.equal(status.ok, true);
  assert.equal(status.profile.nickname, '酷狗测试');
  assert.deepEqual(status.playlists, []);
  assert.equal(status.collectionUnavailable, true);
});

test('cloudlist gateway signs requests with KuGoo credentials and returns playlists and songs', async () => {
  const cookieSession = {
    cookies: {
      get: async filter => {
        if (filter.name === 'KuGoo') {
          return [{ name: 'KuGoo', value: 'KugooID=12345678&NickName=%u80D6%u6B21&t=token-abc' }];
        }
        return [{ name: 'kg_dfid', value: 'dfid-1' }, { name: 'kg_mid', value: 'mid-1' }];
      },
    },
    fetch: async (input, options) => {
      const url = new URL(input);
      assert.equal(url.origin, 'https://gateway.kugou.com');
      assert.equal(options.method, 'POST');
      assert.equal(options.headers['x-router'], 'cloudlist.service.kugou.com');
      assert.match(url.searchParams.get('signature') || '', /^[a-f0-9]{32}$/);
      if (url.pathname === '/v7/get_all_list') {
        return reply({
          status: 1,
          error_code: 0,
          data: { info: [{ listid: 88, name: '我喜欢', count: 1 }] },
        });
      }
      assert.equal(url.pathname, '/v4/get_list_all_file');
      return reply({
        status: 1,
        error_code: 0,
        data: {
          info: [{
            hash,
            songname: '晴天',
            singername: '周杰伦',
            album_id: '966846',
            timelen: 269000,
          }],
        },
      });
    },
  };
  const status = await getKugouSessionStatus(cookieSession);
  assert.equal(status.ok, true);
  assert.equal(status.collectionUnavailable, false);
  assert.deepEqual(status.playlists, [{ id: '88', name: '我喜欢', count: 1, cover: '', globalCollectionId: '' }]);
  const songsResult = await listKugouAccountSongs(cookieSession, '88');
  assert.equal(songsResult.songs[0].name, '晴天');
  assert.equal(songsResult.songs[0].artist, '周杰伦');
  assert.equal(songsResult.songs[0].durationMs, 269000);
});

test('extractKugouSpecialId parses numeric ids and official playlist URLs', () => {
  assert.equal(extractKugouSpecialId('125032'), '125032');
  assert.equal(extractKugouSpecialId('https://www.kugou.com/yy/special/single/125032.html'), '125032');
  assert.equal(extractKugouSpecialId('https://m.kugou.com/share/zlist.html?specialid=6409645&foo=1'), '6409645');
  assert.equal(extractKugouSpecialId('https://example.com/not-a-playlist'), '');
});

test('QR client login stores isolated HttpOnly cookies and fetches cloudlist playlists', async () => {
  const jar = new Map();
  const cookieSession = {
    cookies: {
      get: async filter => {
        if (filter?.name) {
          const v = jar.get(filter.name);
          return v ? [{ name: filter.name, value: v }] : [];
        }
        return [...jar.entries()].map(([name, value]) => ({ name, value }));
      },
      set: async item => {
        assert.equal(item.httpOnly, true);
        assert.equal(item.secure, true);
        jar.set(item.name, item.value);
      },
    },
    fetch: async (input, options) => {
      const url = new URL(input);
      if (url.pathname === '/v2/qrcode') {
        return reply({ status: 1, data: { qrcode: 'qrkey12345678', qrcode_img: 'data:image/png;base64,AAAA' } });
      }
      if (url.pathname === '/v2/get_userinfo_qrcode') {
        return reply({ status: 1, data: { status: 4, userid: 98765432, token: 'client-token-xyz', nickname: '胖次', pic: '' } });
      }
      if (url.pathname === '/v7/get_all_list') {
        assert.equal(url.searchParams.get('appid'), '1005');
        assert.equal(url.searchParams.get('clientver'), '20489');
        assert.equal(options.headers['x-router'], 'cloudlist.service.kugou.com');
        return reply({ status: 1, error_code: 0, data: { info: [{ listid: 2, global_collection_id: 'collection_3_98765432_2_0', name: '我喜欢', count: 12 }] } });
      }
      if (url.pathname === '/pubsongs/v2/get_other_list_file_nofilt') {
        assert.equal(url.searchParams.get('global_collection_id'), 'collection_3_98765432_2_0');
        return reply({ status: 1, error_code: 0, data: { songs: [{ hash, name: '周杰伦 - 晴天', timelen: 269000 }] } });
      }
      throw new Error(`unexpected request: ${input}`);
    },
  };
  const qr = await createKugouQrLogin(cookieSession);
  assert.equal(qr.ok, true);
  assert.equal(qr.key, 'qrkey12345678');
  const polled = await pollKugouQrLogin(cookieSession, qr.key, qr.mid);
  assert.equal(polled.ok, true);
  assert.equal(polled.state, 'confirmed');
  assert.equal(polled.clientReady, true);
  assert.equal(polled.profile.nickname, '胖次');
  assert.deepEqual(polled.playlists, [{
    id: 'collection_3_98765432_2_0',
    name: '我喜欢',
    count: 12,
    cover: '',
    globalCollectionId: 'collection_3_98765432_2_0',
  }]);
  const songs = await listKugouAccountSongs(cookieSession, 'collection_3_98765432_2_0');
  assert.equal(songs.songs[0].name, '晴天');
  assert.equal(songs.songs[0].artist, '周杰伦');
});

test('Kugou audio CDN allowlist and proxy headers block untrusted hosts and strip cookies', () => {
  assert.equal(isAllowedKugouAudioUrl('https://webfs.tx.kugou.com/20261124/demo.mp3'), true);
  assert.equal(isAllowedKugouAudioUrl('http://fs.ios.kugou.com/demo.mp3'), true);
  assert.equal(isAllowedServerKugouAudioUrl('https://bssdlbig.kugou.com/a.flac'), true);
  assert.equal(isAllowedKugouAudioUrl('https://evil.example/a.mp3'), false);
  assert.equal(isAllowedKugouAudioUrl('https://user:pass@webfs.tx.kugou.com/a.mp3'), false);
  assert.equal(isAllowedKugouAudioUrl('file:///C:/music.mp3'), false);

  const headers = buildKugouAudioHeaders('bytes=0-1023');
  assert.equal(headers.Range, 'bytes=0-1023');
  assert.equal('Cookie' in headers, false);
  assert.equal('cookie' in headers, false);

  clearKugouAudioSourceCache();
  assert.equal(putKugouAudioSource({ hash, url: 'https://evil.example/a.mp3' }), null);
  const saved = putKugouAudioSource({
    hash,
    url: 'https://webfs.tx.kugou.com/main.mp3',
    backupUrls: ['https://evil.example/bad.mp3', 'https://fs.ios.kugou.com/backup.mp3'],
    isFreePart: true,
    durationMs: 60000,
  });
  assert.deepEqual(saved, {
    hash,
    url: 'https://webfs.tx.kugou.com/main.mp3',
    backupUrls: ['https://fs.ios.kugou.com/backup.mp3'],
    isFreePart: true,
    durationMs: 60000,
  });
  clearKugouAudioSourceCache();
});

test('resolveKugouAudioUrl uses gateway /v5/url with client credentials and falls back cleanly', async () => {
  const seen = [];
  const cookieSession = {
    cookies: {
      get: async filter => {
        if (filter.name === 'KuGoo') return [];
        if (filter.url) {
          return [
            { name: 'orbit_kg_c1005_uid', value: '98765432' },
            { name: 'orbit_kg_c1005_token', value: 'client-token-xyz' },
            { name: 'orbit_kg_c1005_mid', value: '12345678901234567890' },
          ];
        }
        return [];
      },
    },
    fetch: async (input, options) => {
      const url = new URL(input);
      seen.push({ pathname: url.pathname, router: options?.headers?.['x-router'], freePart: url.searchParams.get('IsFreePart') });
      assert.equal(url.origin, 'https://gateway.kugou.com');
      assert.equal(url.pathname, '/v5/url');
      assert.equal(options.headers['x-router'], 'trackercdn.kugou.com');
      assert.match(url.searchParams.get('key') || '', /^[a-f0-9]{32}$/);
      assert.match(url.searchParams.get('signature') || '', /^[a-f0-9]{32}$/);
      return reply({
        status: 1,
        url: ['https://webfs.tx.kugou.com/full-song.mp3', 'https://evil.example/ignored.mp3'],
        backupUrl: ['https://fs.ios.kugou.com/full-song-bak.mp3'],
        timeLength: 277,
        privilege: 10,
      });
    },
  };
  const resolved = await resolveKugouAudioUrl(cookieSession, { hash, albumId: '968210', albumAudioId: '32113016' });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.source, 'gateway-v5');
  assert.equal(resolved.url, 'https://webfs.tx.kugou.com/full-song.mp3');
  assert.deepEqual(resolved.backupUrls, ['https://fs.ios.kugou.com/full-song-bak.mp3']);
  assert.equal(resolved.isFreePart, false);
  assert.equal(resolved.durationMs, 277000);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].freePart, '0');
});

test('resolveKugouAudioUrl falls back to web /play/songinfo and signals hidden web fallback when logged in', async () => {
  const webSession = {
    cookies: {
      get: async filter => {
        if (filter.name === 'KuGoo') {
          return [{ name: 'KuGoo', value: 'KugooID=12345678&NickName=%u80D6%u6B21&t=web-token-1' }];
        }
        return [{ name: 'kg_dfid', value: 'dfid-real-1234' }, { name: 'kg_mid', value: '0123456789abcdef0123456789abcdef' }];
      },
    },
    fetch: async (input) => {
      const url = new URL(input);
      if (url.pathname === '/v5/url') return reply({ status: 2, errcode: 20028 });
      if (url.pathname === '/play/songinfo') {
        assert.match(url.searchParams.get('signature') || '', /^[a-f0-9]{32}$/);
        return reply({
          status: 1,
          data: {
            play_url: 'https://webfs.ali.kugou.com/web-song.mp3',
            play_backup_url: 'https://webfs.tx.kugou.com/web-song-bak.mp3',
            is_free_part: 0,
            timelength: 277000,
          },
        });
      }
      return reply({ status: 0 });
    },
  };
  const webResolved = await resolveKugouAudioUrl(webSession, { hash, albumId: '968210', pageId: 'abc123' });
  assert.equal(webResolved.ok, true);
  assert.equal(webResolved.source, 'web-songinfo');
  assert.equal(webResolved.url, 'https://webfs.ali.kugou.com/web-song.mp3');

  const fallbackSession = {
    cookies: webSession.cookies,
    fetch: async () => reply({ status: 0, data: {} }),
  };
  const fallback = await resolveKugouAudioUrl(fallbackSession, { hash, albumId: '968210' });
  assert.equal(fallback.ok, false);
  assert.equal(fallback.reason, 'unavailable');
  assert.equal(fallback.needsWebFallback, true);

  const guestSession = {
    cookies: { get: async () => [] },
    fetch: async () => reply({ status: 0, data: {} }),
  };
  const guest = await resolveKugouAudioUrl(guestSession, { hash });
  assert.deepEqual(guest, { ok: false, reason: 'login' });
});
