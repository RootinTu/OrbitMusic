import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  UpstreamRequestError,
  classifyUpstreamError,
  fetchStreamWithTimeout,
  fetchWithTimeout,
} from './http-client.mjs';

test('fetchWithTimeout converts hung upstream requests into 504 UpstreamRequestError', async t => {
  t.mock.method(globalThis, 'fetch', (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      const error = new Error('timed out');
      error.name = 'TimeoutError';
      reject(error);
    }, { once: true });
  }));

  await assert.rejects(
    () => fetchWithTimeout('https://music.163.com/api/test', {}, { timeoutMs: 500, label: '网易云音乐' }),
    error => error instanceof UpstreamRequestError && error.status === 504 && error.code === 'UPSTREAM_TIMEOUT' && error.isTimeout,
  );
});

test('fetchWithTimeout converts network failures into 502 UpstreamRequestError', async t => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new TypeError('fetch failed');
  });

  await assert.rejects(
    () => fetchWithTimeout('https://u.y.qq.com/cgi-bin/musicu.fcg', {}, { timeoutMs: 1000, label: 'QQ 音乐' }),
    error => error instanceof UpstreamRequestError && error.status === 502 && error.code === 'UPSTREAM_NETWORK_ERROR',
  );
});

test('fetchStreamWithTimeout enforces connect timeout and aborts when client closes', async t => {
  let capturedSignal = null;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    capturedSignal = options.signal;
    return new Response('audio-stream', { status: 200 });
  });

  const clientRequest = new EventEmitter();
  const res = await fetchStreamWithTimeout('https://m701.music.126.net/song.mp3', {}, {
    connectTimeoutMs: 1000,
    label: '网易云音源',
    clientRequest,
  });
  assert.equal(res.status, 200);
  assert.equal(capturedSignal.aborted, false);
  clientRequest.emit('close');
  assert.equal(capturedSignal.aborted, true);
});

test('classifyUpstreamError maps timeout and custom UpstreamRequestError cleanly', () => {
  const timeout = classifyUpstreamError(new UpstreamRequestError('请求超时', { status: 504, code: 'UPSTREAM_TIMEOUT', isTimeout: true }));
  assert.deepEqual(timeout, { status: 504, code: 'UPSTREAM_TIMEOUT', message: '请求超时' });

  const abortErr = new Error('aborted');
  abortErr.name = 'AbortError';
  assert.equal(classifyUpstreamError(abortErr, '读取失败').status, 504);

  assert.deepEqual(
    classifyUpstreamError(new Error('bad payload'), '读取失败'),
    { status: 502, code: 'UPSTREAM_ERROR', message: 'bad payload' },
  );
});
