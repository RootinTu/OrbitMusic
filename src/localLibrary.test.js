import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearLocalTracks,
  getActiveLocalPlaylistId,
  importLocalAudioFiles,
  isSupportedAudioFile,
  listLocalPlaylists,
  LOCAL_PLAYLIST_ID,
  parseLocalAudioFilename,
  switchLocalPlaylist,
} from './localLibrary.js';

test('parseLocalAudioFilename extracts artist and title cleanly', () => {
  assert.deepEqual(parseLocalAudioFilename('陈奕迅 - 富士山下.flac'), { artist: '陈奕迅', title: '富士山下' });
  assert.deepEqual(parseLocalAudioFilename('Nightcall.mp3'), { artist: '本地音频', title: 'Nightcall' });
  assert.equal(isSupportedAudioFile({ name: 'demo.flac', type: '' }), true);
  assert.equal(isSupportedAudioFile({ name: 'notes.txt', type: 'text/plain' }), false);
});

test('importLocalAudioFiles pairs matching .lrc files, deduplicates, and switches tracks', () => {
  clearLocalTracks();
  let seq = 0;
  const fakeUrl = file => `blob:test/${++seq}/${encodeURIComponent(file.name)}`;
  const files = [
    { name: '陈奕迅 - 富士山下.flac', size: 1024, lastModified: 1, type: 'audio/flac' },
    { name: '陈奕迅 - 富士山下.lrc', size: 200, lastModified: 1, type: 'text/plain' },
    { name: 'Solo Track.mp3', size: 512, lastModified: 2, type: 'audio/mpeg' },
    { name: 'readme.txt', size: 10, lastModified: 3, type: 'text/plain' },
  ];

  const first = importLocalAudioFiles(files, { createObjectURL: fakeUrl });
  assert.equal(first.added, 2);
  assert.equal(first.matchedLyrics, 1);
  assert.equal(getActiveLocalPlaylistId(), LOCAL_PLAYLIST_ID);
  assert.deepEqual(listLocalPlaylists(), [{ id: LOCAL_PLAYLIST_ID, name: '本地拖入', count: 2 }]);

  // Re-dropping identical files does not duplicate entries
  const dup = importLocalAudioFiles(files, { createObjectURL: fakeUrl });
  assert.equal(dup.added, 0);
  assert.equal(dup.total, 2);

  const tracks = [];
  const switched = switchLocalPlaylist(tracks, LOCAL_PLAYLIST_ID);
  assert.equal(switched.count, 2);
  assert.equal(tracks[0].title, '富士山下');
  assert.equal(tracks[0].artist, '陈奕迅');
  assert.ok(tracks[0].lyrics.startsWith('blob:test/'));
  assert.equal(tracks[1].title, 'Solo Track');
  assert.equal(tracks[1].lyrics, '');

  clearLocalTracks(tracks);
  assert.equal(tracks.length, 0);
  assert.deepEqual(listLocalPlaylists(), []);
});
