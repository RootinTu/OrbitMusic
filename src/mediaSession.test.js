import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bindMediaSessionHandlers,
  buildMediaMetadata,
  clampPositionState,
  resolveMediaArtwork,
  syncMediaSessionMetadata,
  syncMediaSessionPlaybackState,
  syncMediaSessionPosition,
} from './mediaSession.js';

test('resolveMediaArtwork resolves relative covers and appends app icon fallback', () => {
  const artwork = resolveMediaArtwork('/api/qq/cover?id=1', {
    baseHref: 'http://127.0.0.1:45437/',
  });
  assert.deepEqual(artwork, [
    { src: 'http://127.0.0.1:45437/api/qq/cover?id=1' },
    { src: 'http://127.0.0.1:45437/icons/orbit-512.png', sizes: '512x512', type: 'image/png' },
  ]);

  const fallbackOnly = resolveMediaArtwork('', { baseHref: 'http://127.0.0.1:45437/' });
  assert.deepEqual(fallbackOnly, [
    { src: 'http://127.0.0.1:45437/icons/orbit-512.png', sizes: '512x512', type: 'image/png' },
  ]);
});

test('buildMediaMetadata formats track metadata using MediaMetadata constructor when provided', () => {
  class FakeMediaMetadata {
    constructor(init) {
      Object.assign(this, init);
    }
  }
  const meta = buildMediaMetadata(
    { title: '富士山下', artist: '陈奕迅', album: "What's Going On...?", cover: 'https://cdn.example/c.jpg' },
    { baseHref: 'http://127.0.0.1:45437/', MediaMetadataCtor: FakeMediaMetadata },
  );
  assert.ok(meta instanceof FakeMediaMetadata);
  assert.equal(meta.title, '富士山下');
  assert.equal(meta.artist, '陈奕迅');
  assert.equal(meta.album, "What's Going On...?");
  assert.equal(meta.artwork[0].src, 'https://cdn.example/c.jpg');
  assert.equal(buildMediaMetadata(null), null);
});

test('clampPositionState prevents invalid Chromium MediaSession errors', () => {
  assert.equal(clampPositionState(0, 10), null);
  assert.equal(clampPositionState(Number.NaN, 10), null);
  assert.deepEqual(clampPositionState(240, 300, 1), { duration: 240, position: 240, playbackRate: 1 });
  assert.deepEqual(clampPositionState(240, -5, 0), { duration: 240, position: 0, playbackRate: 1 });
  assert.deepEqual(clampPositionState(240, 62.5, 1.25), { duration: 240, position: 62.5, playbackRate: 1.25 });
});

test('sync helpers update playbackState, metadata and positionState safely', () => {
  const positionCalls = [];
  const session = {
    metadata: null,
    playbackState: 'none',
    setPositionState(state) {
      positionCalls.push(state);
    },
  };

  assert.equal(syncMediaSessionMetadata(session, { title: 'Song', artist: 'Singer' }, { baseHref: 'http://127.0.0.1/' }), true);
  assert.equal(session.metadata.title, 'Song');

  assert.equal(syncMediaSessionPlaybackState(session, { playing: true, hasTrack: true }), true);
  assert.equal(session.playbackState, 'playing');

  assert.equal(syncMediaSessionPlaybackState(session, { playing: false, hasTrack: true }), true);
  assert.equal(session.playbackState, 'paused');

  assert.equal(syncMediaSessionPlaybackState(session, { playing: false, hasTrack: false }), true);
  assert.equal(session.playbackState, 'none');

  assert.equal(syncMediaSessionPosition(session, { duration: 180, position: 45 }), true);
  assert.equal(syncMediaSessionPosition(session, { duration: 0, position: 0 }), true);
  assert.deepEqual(positionCalls, [
    { duration: 180, position: 45, playbackRate: 1 },
    undefined,
  ]);
});

test('bindMediaSessionHandlers wires all SMTC actions and cleans up on unmount', () => {
  const registered = new Map();
  const events = [];
  const session = {
    setActionHandler(action, fn) {
      if (action === 'stop') throw new TypeError('unsupported action');
      registered.set(action, fn);
    },
  };

  const cleanup = bindMediaSessionHandlers(session, {
    onPlay: () => events.push('play'),
    onPause: () => events.push('pause'),
    onPrevious: () => events.push('prev'),
    onNext: () => events.push('next'),
    onSeekTo: (time, fast) => events.push(['seekto', time, fast]),
    onSeekBy: delta => events.push(['seekby', delta]),
  });

  registered.get('play')();
  registered.get('pause')();
  registered.get('previoustrack')();
  registered.get('nexttrack')();
  registered.get('seekto')({ seekTime: 88.5, fastSeek: true });
  registered.get('seekbackward')({ seekOffset: 15 });
  registered.get('seekforward')({});

  assert.deepEqual(events, [
    'play',
    'pause',
    'prev',
    'next',
    ['seekto', 88.5, true],
    ['seekby', -15],
    ['seekby', 10],
  ]);

  cleanup();
  for (const [, fn] of registered) {
    assert.equal(fn, null);
  }
});
