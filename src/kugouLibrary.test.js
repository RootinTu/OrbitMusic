import test from 'node:test';
import assert from 'node:assert/strict';
import { clearKugouTracks, importKugouTracks, listKugouPlaylists, switchKugouPlaylist } from './kugouLibrary.js';
import { playbackTrackKey } from './playbackMemory.js';

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
  assert.equal(playbackTrackKey(tracks[1]), `kugou:${songs[0].hash}`);
  assert.equal(clearKugouTracks(tracks), true);
  assert.equal(tracks.length, 1);
});
