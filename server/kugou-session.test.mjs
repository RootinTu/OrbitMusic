import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createKugouQrLogin, getKugouSessionStatus, kugouSongPage, listKugouAccountPlaylists,
  listKugouAccountSongs, parseKugouCookie, pollKugouQrLogin,
} from '../desktop/kugou-session.mjs';
import { extractKugouSpecialId } from './kugou-music.mjs';

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
