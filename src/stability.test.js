import test from 'node:test';
import assert from 'node:assert/strict';
import { createAudioPrefetcher } from './boundedCache.js';
import { createAsyncSlot, isAbortError } from './asyncSlot.js';
import { createTerrainGL } from './terrainGL.js';
import { createGlassFrameScheduler } from './glassFrameScheduler.js';

test('audio prefetcher bounds probe count and releases evicted and cleared probes', () => {
  const created = [];
  const prefetcher = createAudioPrefetcher({
    maxEntries: 2,
    createAudio() {
      const probe = {
        preload: '',
        src: '',
        paused: false,
        removedSrc: false,
        loadCalls: 0,
        pause() { this.paused = true; },
        removeAttribute(attr) { if (attr === 'src') this.removedSrc = true; },
        load() { this.loadCalls += 1; },
      };
      created.push(probe);
      return probe;
    },
  });

  prefetcher.prefetch('/api/qq/audio?mid=1');
  prefetcher.prefetch('/api/qq/audio?mid=2');
  assert.equal(prefetcher.size, 2);
  // Touching mid=1 refreshes its LRU position so mid=2 is evicted next
  prefetcher.prefetch('/api/qq/audio?mid=1');
  prefetcher.prefetch('/api/qq/audio?mid=3');

  assert.equal(prefetcher.size, 2);
  assert.equal(prefetcher.has('/api/qq/audio?mid=1'), true);
  assert.equal(prefetcher.has('/api/qq/audio?mid=2'), false);
  assert.equal(prefetcher.has('/api/qq/audio?mid=3'), true);
  assert.equal(created[1].paused, true);
  assert.equal(created[1].removedSrc, true);
  assert.equal(created[1].src, '');

  prefetcher.clear();
  assert.equal(prefetcher.size, 0);
  assert.equal(created[0].paused, true);
  assert.equal(created[2].paused, true);
});

test('async slot aborts superseded requests and ignores out-of-order completions', () => {
  const slot = createAsyncSlot();
  const first = slot.start();
  assert.equal(first.signal.aborted, false);
  assert.equal(first.isCurrent(), true);

  const second = slot.start();
  assert.equal(first.signal.aborted, true);
  assert.equal(first.isCurrent(), false);
  assert.equal(first.finish(), false);
  assert.equal(second.signal.aborted, false);
  assert.equal(second.isCurrent(), true);

  slot.cancel();
  assert.equal(second.signal.aborted, true);
  assert.equal(second.isCurrent(), false);
  assert.equal(second.finish(), false);

  const abortErr = new Error('aborted');
  abortErr.name = 'AbortError';
  assert.equal(isAbortError(abortErr), true);
  assert.equal(isAbortError(new Error('network')), false);
});

test('terrainGL dispose releases all buffers, shaders, VAO, program, and optionally loses WebGL context', () => {
  function runCase(loseContext) {
    const counts = {
      createdBuffers: 0,
      deletedBuffers: 0,
      createdShaders: 0,
      detachedShaders: 0,
      deletedShaders: 0,
      deletedVaos: 0,
      deletedPrograms: 0,
      lostContexts: 0,
    };
    const gl = new Proxy({
      getShaderParameter: () => true,
      getProgramParameter: () => true,
      getAttribLocation: () => 0,
      getUniformLocation: (_, name) => name,
      createBuffer: () => ({ id: ++counts.createdBuffers }),
      deleteBuffer: () => { counts.deletedBuffers += 1; },
      createShader: () => ({ id: ++counts.createdShaders }),
      detachShader: () => { counts.detachedShaders += 1; },
      deleteShader: () => { counts.deletedShaders += 1; },
      deleteVertexArray: () => { counts.deletedVaos += 1; },
      deleteProgram: () => { counts.deletedPrograms += 1; },
      getExtension: (name) => (name === 'WEBGL_lose_context' ? { loseContext: () => { counts.lostContexts += 1; } } : null),
    }, { get: (target, name) => (name in target ? target[name] : (/^[A-Z_]+$/.test(name) ? 0 : () => ({}))) });

    const canvas = { width: 800, height: 600, getContext: () => gl };
    const renderer = createTerrainGL(canvas, { gridSize: 8 });
    renderer.dispose({ loseContext });
    // Second dispose call must be idempotent
    renderer.dispose({ loseContext: true });
    return counts;
  }

  const keepContext = runCase(false);
  assert.equal(keepContext.createdBuffers, 4);
  assert.equal(keepContext.deletedBuffers, 4);
  assert.equal(keepContext.createdShaders, 2);
  assert.equal(keepContext.detachedShaders, 2);
  assert.equal(keepContext.deletedShaders, 2);
  assert.equal(keepContext.deletedVaos, 1);
  assert.equal(keepContext.deletedPrograms, 1);
  assert.equal(keepContext.lostContexts, 0);

  const dropContext = runCase(true);
  assert.equal(dropContext.deletedBuffers, 4);
  assert.equal(dropContext.deletedShaders, 2);
  assert.equal(dropContext.lostContexts, 1);
});

test('glass frame scheduler throttles idle frames, pauses when occluded, and wakes on activity', () => {
  const scheduler = createGlassFrameScheduler({ idleIntervalMs: 125, interactionGraceMs: 500 });

  // Initial frame renders immediately even when idle
  assert.equal(scheduler.shouldRender(100, { active: false, initialized: false }), true);
  scheduler.markRendered(100);

  // While active (playing), renders every frame
  assert.equal(scheduler.shouldRender(116, { active: true, initialized: true }), true);
  scheduler.markRendered(116);

  // Idle beyond interaction grace: skips intermediate 16ms frames until 125ms elapsed
  assert.equal(scheduler.shouldRender(132, { active: false, initialized: true }), false);
  assert.equal(scheduler.shouldRender(200, { active: false, initialized: true }), false);
  assert.equal(scheduler.shouldRender(245, { active: false, initialized: true }), true);
  scheduler.markRendered(245);

  // User interaction wakes full-rate rendering during grace window
  scheduler.markActivity(260);
  assert.equal(scheduler.shouldRender(276, { active: false, initialized: true }), true);
  scheduler.markRendered(276);

  // Modal occlusion (paused) halts redraws once clean and initialized
  assert.equal(scheduler.shouldRender(900, { active: true, paused: true, initialized: true }), false);
  // Structural surface change triggers one sync render even if paused, then halts again
  scheduler.markDirty(910);
  assert.equal(scheduler.shouldRender(920, { active: false, paused: true, initialized: true }), true);
  scheduler.markRendered(920);
  assert.equal(scheduler.shouldRender(1200, { active: false, paused: true, initialized: true }), false);
});
