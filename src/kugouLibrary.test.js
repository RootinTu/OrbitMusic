import test from 'node:test';
import assert from 'node:assert/strict';
import { clearKugouTracks, importKugouTracks, listKugouPlaylists, proxyKugouCover, switchKugouPlaylist } from './kugouLibrary.js';
import { playbackTrackKey } from './playbackMemory.js';
import { musicAccountName, normalizeKugouAccountProfile, resolveActiveAccountState } from './musicAccounts.js';

test('stores distinct, deduplicated Kugou playlists and restores the selected one only', () => {
  const store = new Map();
  globalThis.localStorage = { getItem: key => store.get(key) || null, setItem: (key, value) => store.set(key, value) };
  const songs = Array.from({ length: 31 }, (_, i) => ({ hash: i.toString(16).padStart(32, '0'), name: `Song ${i}`, durationMs: 176000 }));
  const tracks = [{ id: 0, provider: 'local' }];
  assert.equal(importKugouTracks(songs, { id: 'first', name: 'First' }).added, 30);
  assert.equal(importKugouTracks([songs[30]], { id: 'first' }).reason, 'track-limit');
  assert.equal(importKugouTracks([songs[0], songs[0]], { id: 'second', name: 'Second' }).added, 1);
  assert.equal(importKugouTracks([songs[0]], { id: 'second' }).reason, 'duplicate');
  assert.deepEqual(listKugouPlaylists().map(item => [item.id, item.count]), [['first', 30], ['second', 1]]);
  assert.equal(switchKugouPlaylist(tracks, 'first').count, 30);
  assert.equal(switchKugouPlaylist(tracks, 'second').count, 1);
  assert.equal(tracks.length, 2);
  assert.equal(tracks[1].duration, 176);
  assert.equal(tracks[1].src, `/api/kugou/audio?hash=${songs[0].hash}`);
  assert.equal(playbackTrackKey(tracks[1]), `kugou:${songs[0].hash}`);
  assert.equal(clearKugouTracks(tracks), true);
  assert.equal(tracks.length, 1);
});

test('wraps external Kugou covers through same-origin proxy for WebGPU canvas compatibility', () => {
  const store = new Map();
  globalThis.localStorage = { getItem: key => store.get(key) || null, setItem: (key, value) => store.set(key, value) };
  const rawCover = 'https://imge.kugou.com/stdmusic/400/demo.jpg';
  const songs = [{ hash: 'a'.repeat(32), name: '葡萄成熟时', cover: rawCover, durationMs: 277000 }];
  const tracks = [];
  importKugouTracks(songs, { id: 'eason', name: '陈奕迅' });
  switchKugouPlaylist(tracks, 'eason');
  assert.equal(tracks[0].cover, `/api/kugou/cover?url=${encodeURIComponent(rawCover)}`);
  assert.equal(proxyKugouCover(tracks[0].cover), tracks[0].cover);
});

test('switches top-bar account avatar to Kugou when active playlist belongs to Kugou and cycles 3 accounts', () => {
  const accounts = {
    qq: { profile: { loggedIn: true, nickname: 'Ri兔' } },
    netease: { profile: { loggedIn: true, nickname: '云村用户' } },
    kugou: { profile: normalizeKugouAccountProfile({ ok: true, clientReady: true, profile: { nickname: '酷狗听众', avatar: 'https://imge.kugou.com/avatar.jpg' } }) },
  };
  assert.equal(accounts.kugou.profile.avatar, `/api/kugou/cover?url=${encodeURIComponent('https://imge.kugou.com/avatar.jpg')}`);
  assert.equal(musicAccountName(null, 'kugou'), '酷狗音乐用户');

  const kugouActive = resolveActiveAccountState({
    activeLibrary: 'kugou:account:eason',
    displayAccount: 'qq',
    bridgeProvider: 'qq',
    accounts,
  });
  assert.equal(kugouActive.accountProvider, 'kugou');
  assert.equal(kugouActive.nextAccount, 'qq');

  const qqActive = resolveActiveAccountState({
    activeLibrary: 'qq:12345',
    displayAccount: 'kugou',
    bridgeProvider: 'kugou',
    accounts,
  });
  assert.equal(qqActive.accountProvider, 'qq');
  assert.equal(qqActive.nextAccount, 'netease');

  // If active playlist is Kugou but Kugou is not logged in, fall back to logged-in displayAccount
  const fallback = resolveActiveAccountState({
    activeLibrary: 'kugou:special:123',
    displayAccount: 'qq',
    bridgeProvider: 'kugou',
    accounts: { qq: accounts.qq, netease: { profile: null }, kugou: { profile: null } },
  });
  assert.equal(fallback.accountProvider, 'qq');
  assert.equal(fallback.nextAccount, null);
});
