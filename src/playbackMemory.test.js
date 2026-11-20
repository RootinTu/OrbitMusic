import assert from 'node:assert/strict';
import test from 'node:test';
import { clearProviderPlayback, forgetPlaylistPlayback, playbackTrackKey, readLastTrack, resumeAt, saveLastTrack, saveProgress } from './playbackMemory.js';

function mockStorage(t, initial = []) {
  const entries = new Map(initial);
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value) },
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete globalThis.localStorage;
  });
}

const qq = { id: 0, provider: 'qq', mid: '12345678', src: '/api/qq/audio?quality=standard' };
const netease = { id: 0, provider: 'netease', cloudId: '12345678' };

test('playlist selection follows song identity across reordering and removal', t => {
  mockStorage(t);
  const qqKey = playbackTrackKey(qq);
  const neteaseKey = playbackTrackKey(netease);
  saveLastTrack('qq:road', qqKey);
  saveLastTrack('netease:road', neteaseKey);
  saveProgress(qqKey, 42.13);
  saveProgress(neteaseKey, 61);

  assert.equal(readLastTrack('qq:road', [netease, { ...qq, id: 1 }]), 1);
  assert.equal(readLastTrack('netease:road', [qq, netease]), 1);
  assert.equal(readLastTrack('qq:road', [netease]), 0);
  assert.equal(resumeAt(playbackTrackKey({ ...qq, src: '/api/qq/audio?quality=flac' }), 150), 42.1);
  assert.equal(resumeAt(neteaseKey, 150), 61);

  forgetPlaylistPlayback('qq:road');
  assert.equal(readLastTrack('qq:road', [netease, qq]), 0);
  assert.equal(resumeAt(qqKey, 150), 42.1);
  saveLastTrack('qq:road', qqKey);
  clearProviderPlayback('qq');
  assert.equal(readLastTrack('qq:road', [netease, qq]), 0);
  assert.equal(resumeAt(qqKey, 150), 0);
  assert.equal(readLastTrack('netease:road', [qq, netease]), 1);
  assert.equal(resumeAt(neteaseKey, 150), 61);
});

test('legacy indexes do not assign progress to a different song', t => {
  mockStorage(t, [['aimusic.lastTrack', '1'], ['aimusic.progress', '{"0":77,"1":42}']]);
  assert.equal(readLastTrack('qq:road', [netease, qq]), 0);
  assert.equal(resumeAt(playbackTrackKey(qq), 180), 0);
  assert.equal(localStorage.getItem('aimusic.lastTrack'), '1');
});

test('local song identity ignores asset versions and rewinding clears saved progress', t => {
  mockStorage(t);
  const key = playbackTrackKey({ id: 0, src: 'assets/song.mp3?v=old' });
  saveProgress(key, 51);
  assert.equal(resumeAt(playbackTrackKey({ id: 3, src: 'assets/song.mp3?v=new' }), 100), 51);
  saveProgress(key, 97);
  assert.equal(resumeAt(key, 100), 0);
  saveProgress(key, 3);
  assert.equal(resumeAt(key, 100), 0);
});
