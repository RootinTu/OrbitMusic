import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTrustedIpcRegistrar,
  isAllowedExternalWebUrl,
  isAllowedHostSuffix,
  isAllowedMainNavigationUrl,
  isAllowedMainWindowPermission,
  isTrustedMainRendererEvent,
} from '../desktop/ipc-guard.mjs';

test('trusts IPC only from the main window mainFrame on the exact app origin', () => {
  const mainFrame = { url: 'http://127.0.0.1:45437/' };
  const subFrame = { url: 'http://127.0.0.1:45437/embed' };
  const mainWebContents = { mainFrame, isDestroyed: () => false };
  const otherWebContents = { mainFrame: { url: 'https://y.qq.com/' }, isDestroyed: () => false };
  const appOrigin = 'http://127.0.0.1:45437';

  assert.equal(isTrustedMainRendererEvent({ sender: mainWebContents, senderFrame: mainFrame }, { mainWebContents, appOrigin }), true);
  assert.equal(isTrustedMainRendererEvent({ sender: mainWebContents, senderFrame: subFrame }, { mainWebContents, appOrigin }), false);
  assert.equal(isTrustedMainRendererEvent({ sender: otherWebContents, senderFrame: otherWebContents.mainFrame }, { mainWebContents, appOrigin }), false);
  assert.equal(isTrustedMainRendererEvent(
    { sender: mainWebContents, senderFrame: mainFrame },
    { mainWebContents: { mainFrame, isDestroyed: () => true }, appOrigin },
  ), false);

  const foreignMainFrame = { url: 'http://127.0.0.1:9999/' };
  const foreignContents = { mainFrame: foreignMainFrame, isDestroyed: () => false };
  assert.equal(isTrustedMainRendererEvent(
    { sender: foreignContents, senderFrame: foreignMainFrame },
    { mainWebContents: foreignContents, appOrigin },
  ), false);
});

test('createTrustedIpcRegistrar rejects unauthorized senders and runs handler for trusted senders', async () => {
  const handlers = new Map();
  const mockIpcMain = {
    handle(channel, fn) {
      handlers.set(channel, fn);
    },
  };
  const mainFrame = { url: 'http://127.0.0.1:45437/index.html' };
  const mainWebContents = { mainFrame, isDestroyed: () => false };
  const register = createTrustedIpcRegistrar({
    ipcMain: mockIpcMain,
    getMainWebContents: () => mainWebContents,
    appOrigin: 'http://127.0.0.1:45437',
  });

  let executed = 0;
  register('orbit-install-update', () => {
    executed += 1;
    return { ok: true };
  });
  register('orbit-kugou-login', () => {
    executed += 1;
    return { ok: true };
  }, { onUnauthorized: () => ({ ok: false }) });

  const untrustedEvent = { sender: { mainFrame: { url: 'https://evil.example' } }, senderFrame: { url: 'https://evil.example' } };
  await assert.rejects(() => handlers.get('orbit-install-update')(untrustedEvent), /Unauthorized IPC sender/);
  assert.deepEqual(await handlers.get('orbit-kugou-login')(untrustedEvent), { ok: false });
  assert.equal(executed, 0);

  const trustedEvent = { sender: mainWebContents, senderFrame: mainFrame };
  assert.deepEqual(await handlers.get('orbit-install-update')(trustedEvent), { ok: true });
  assert.equal(executed, 1);
});

test('restricts main window navigation and login window host suffixes without prefix/subdomain bypasses', () => {
  assert.equal(isAllowedMainNavigationUrl('http://127.0.0.1:45437/visual-lab.html', 'http://127.0.0.1:45437'), true);
  assert.equal(isAllowedMainNavigationUrl('http://127.0.0.1:8765/', 'http://127.0.0.1:45437'), false);
  assert.equal(isAllowedMainNavigationUrl('https://evil.example/', 'http://127.0.0.1:45437'), false);
  assert.equal(isAllowedMainNavigationUrl('file:///C:/Windows/win.ini', 'http://127.0.0.1:45437'), false);

  assert.equal(isAllowedHostSuffix('https://y.qq.com/n/ryqq/profile', ['qq.com']), true);
  assert.equal(isAllowedHostSuffix('https://open.weixin.qq.com/connect/qrconnect', ['qq.com']), true);
  assert.equal(isAllowedHostSuffix('https://qq.com.evil.example/login', ['qq.com']), false);
  assert.equal(isAllowedHostSuffix('http://y.qq.com/n/ryqq/profile', ['qq.com']), false);
  assert.equal(isAllowedHostSuffix('https://user:pass@y.qq.com/', ['qq.com']), false);

  assert.equal(isAllowedExternalWebUrl('https://music.163.com/#/song?id=1'), true);
  assert.equal(isAllowedExternalWebUrl('javascript:alert(1)'), false);
  assert.equal(isAllowedExternalWebUrl('file:///C:/test.exe'), false);
});

test('allows only safe same-origin permissions for the main window', () => {
  const origin = 'http://127.0.0.1:45437';
  assert.equal(isAllowedMainWindowPermission('media', { requestingUrl: `${origin}/`, mediaTypes: ['audio'] }, origin), true);
  assert.equal(isAllowedMainWindowPermission('speaker-selection', { requestingUrl: `${origin}/` }, origin), true);
  assert.equal(isAllowedMainWindowPermission('fullscreen', { requestingUrl: `${origin}/` }, origin), true);

  assert.equal(isAllowedMainWindowPermission('media', { requestingUrl: `${origin}/`, mediaTypes: ['video'] }, origin), false);
  assert.equal(isAllowedMainWindowPermission('media', { requestingUrl: `${origin}/`, mediaTypes: ['audio', 'video'] }, origin), false);
  assert.equal(isAllowedMainWindowPermission('geolocation', { requestingUrl: `${origin}/` }, origin), false);
  assert.equal(isAllowedMainWindowPermission('notifications', { requestingUrl: `${origin}/` }, origin), false);
  assert.equal(isAllowedMainWindowPermission('media', { requestingUrl: 'https://evil.example/', mediaTypes: ['audio'] }, origin), false);
});
