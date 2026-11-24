import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SPLASH_EXIT_MS,
  SPLASH_MIN_DISPLAY_MS,
  SPLASH_REDUCED_DISPLAY_MS,
  scheduleOrbitSplashDismiss,
} from './splashScreen.js';

function createMockEnvironment({ reducedMotion = false, visibilityState = 'visible', desktop = null } = {}) {
  const timers = [];
  let removedSplash = false;
  let removedStyle = false;
  let sparkStarted = false;
  const classes = new Set();
  const splashListeners = new Map();
  const windowListeners = new Map();
  const docListeners = new Map();

  const splash = {
    dataset: { state: 'waiting' },
    classList: {
      add: name => classes.add(name),
      has: name => classes.has(name),
    },
    addEventListener: (type, fn) => splashListeners.set(type, fn),
    removeEventListener: type => splashListeners.delete(type),
    remove: () => { removedSplash = true; },
  };
  const styleNode = { remove: () => { removedStyle = true; } };
  const sparkMotion = { beginElement: () => { sparkStarted = true; } };
  const documentRef = {
    visibilityState,
    getElementById: id => (
      id === 'orbit-splash' ? splash
        : id === 'orbit-splash-style' ? styleNode
          : id === 'orbit-splash-spark-motion' ? sparkMotion : null
    ),
    addEventListener: (type, fn) => docListeners.set(type, fn),
    removeEventListener: type => docListeners.delete(type),
  };
  const windowRef = {
    orbitDesktop: desktop,
    matchMedia: () => ({ matches: reducedMotion }),
    addEventListener: (type, fn) => windowListeners.set(type, fn),
    removeEventListener: type => windowListeners.delete(type),
  };

  const setTimer = (fn, delay) => {
    const id = timers.length + 1;
    timers.push({ id, fn, delay, cleared: false });
    return id;
  };
  const clearTimer = id => {
    const item = timers.find(entry => entry.id === id);
    if (item) item.cleared = true;
  };
  const requestFrame = fn => fn();

  return {
    splash,
    documentRef,
    windowRef,
    timers,
    classes,
    splashListeners,
    windowListeners,
    docListeners,
    setTimer,
    clearTimer,
    requestFrame,
    isSparkStarted: () => sparkStarted,
    isRemoved: () => ({ splash: removedSplash, style: removedStyle }),
  };
}

test('waits for Electron window to become visible before starting splash animation and full display timer', async () => {
  let emitShown = null;
  const desktop = {
    isDesktop: true,
    isWindowVisible: () => Promise.resolve(false),
    onWindowShown: cb => {
      emitShown = cb;
      return () => { emitShown = null; };
    },
  };
  const env = createMockEnvironment({ desktop });
  scheduleOrbitSplashDismiss(env);
  await Promise.resolve();

  // While window is still hidden, splash remains paused in waiting state
  assert.equal(env.splash.dataset.state, 'waiting');
  assert.equal(env.classes.has('is-leaving'), false);

  // Once Electron emits show, splash starts playing and schedules full display timer
  emitShown();
  assert.equal(env.splash.dataset.state, 'playing');

  const sparkTimer = env.timers.find(item => !item.cleared && item.delay === 160);
  assert.ok(sparkTimer);
  sparkTimer.fn();
  assert.equal(env.isSparkStarted(), true);

  const dismissTimer = env.timers.find(item => !item.cleared && item.delay === SPLASH_MIN_DISPLAY_MS);
  assert.ok(dismissTimer);
  dismissTimer.fn();
  assert.equal(env.classes.has('is-leaving'), true);

  const removeTimer = env.timers.find(item => !item.cleared && item.delay === SPLASH_EXIT_MS);
  assert.ok(removeTimer);
  removeTimer.fn();
  assert.deepEqual(env.isRemoved(), { splash: true, style: true });
});

test('supports immediate skip on pointerdown/keydown and shortens duration for reduced-motion', () => {
  const skipEnv = createMockEnvironment();
  scheduleOrbitSplashDismiss(skipEnv);
  assert.equal(skipEnv.splash.dataset.state, 'playing');
  assert.ok(skipEnv.splashListeners.has('pointerdown'));
  skipEnv.splashListeners.get('pointerdown')();
  assert.equal(skipEnv.classes.has('is-leaving'), true);
  assert.equal(skipEnv.splashListeners.size, 0);
  assert.equal(skipEnv.windowListeners.size, 0);

  const reducedEnv = createMockEnvironment({ reducedMotion: true });
  scheduleOrbitSplashDismiss(reducedEnv);
  assert.ok(reducedEnv.timers.some(item => !item.cleared && item.delay === SPLASH_REDUCED_DISPLAY_MS));
});
