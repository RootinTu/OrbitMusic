import test from 'node:test';
import assert from 'node:assert/strict';
import {
  API_TOKEN_HEADER,
  SESSION_COOKIE_NAME,
  createLocalApiGuard,
  isAllowedLocalHost,
  isPrivilegedApiRoute,
  isSameLocalOrigin,
} from './local-api-guard.mjs';

function runGuard(middleware, { method = 'GET', url = '/', headers = {} } = {}) {
  return new Promise((resolve) => {
    let nextCalled = false;
    const responseHeaders = new Map();
    const res = {
      statusCode: 200,
      setHeader(name, value) {
        responseHeaders.set(String(name).toLowerCase(), value);
      },
      getHeader(name) {
        return responseHeaders.get(String(name).toLowerCase());
      },
      end(body = '') {
        let json = null;
        try { json = body ? JSON.parse(body) : null; } catch { /* ignore */ }
        resolve({ nextCalled, statusCode: this.statusCode, headers: responseHeaders, body, json });
      },
    };
    const normalizedHeaders = {};
    for (const [key, value] of Object.entries(headers)) {
      normalizedHeaders[key.toLowerCase()] = value;
    }
    const req = { method, url, originalUrl: url, headers: normalizedHeaders };
    middleware(req, res, () => {
      nextCalled = true;
      resolve({ nextCalled, statusCode: res.statusCode, headers: responseHeaders, body: '', json: null });
    });
  });
}

test('allows only loopback Host headers and blocks DNS rebinding hosts', () => {
  assert.equal(isAllowedLocalHost('127.0.0.1:45437'), true);
  assert.equal(isAllowedLocalHost('localhost:8765'), true);
  assert.equal(isAllowedLocalHost('[::1]:45437'), true);
  assert.equal(isAllowedLocalHost('127.0.0.1'), true);
  assert.equal(isAllowedLocalHost('evil.example:45437'), false);
  assert.equal(isAllowedLocalHost('127.0.0.1.evil.example:45437'), false);
  assert.equal(isAllowedLocalHost('127.0.0.1:99999'), false);
  assert.equal(isAllowedLocalHost(''), false);
});

test('validates same-origin HTTP local origins strictly including port', () => {
  assert.equal(isSameLocalOrigin('http://127.0.0.1:45437', '127.0.0.1:45437'), true);
  assert.equal(isSameLocalOrigin('http://127.0.0.1:9999', '127.0.0.1:45437'), false);
  assert.equal(isSameLocalOrigin('https://127.0.0.1:45437', '127.0.0.1:45437'), false);
  assert.equal(isSameLocalOrigin('null', '127.0.0.1:45437'), false);
  assert.equal(isSameLocalOrigin('http://attacker.com', '127.0.0.1:45437'), false);
});

test('identifies privileged cookie write routes', () => {
  assert.equal(isPrivilegedApiRoute('/api/qq/login/cookie', 'PUT'), true);
  assert.equal(isPrivilegedApiRoute('/api/qq/login/cookie', 'POST'), true);
  assert.equal(isPrivilegedApiRoute('/api/netease/login/cookie', 'PUT'), true);
  assert.equal(isPrivilegedApiRoute('/api/qq/login/status', 'GET'), false);
  assert.equal(isPrivilegedApiRoute('/api/netease/logout', 'POST'), false);
});

test('Electron mode: does not issue session cookie over HTTP and blocks unauthenticated API calls', async () => {
  const guard = createLocalApiGuard({
    apiToken: 'api-secret-token',
    sessionToken: 'session-secret-token',
    issueSessionCookie: false,
  });

  const page = await runGuard(guard, {
    url: '/',
    headers: { host: '127.0.0.1:45437', 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate' },
  });
  assert.equal(page.nextCalled, true);
  assert.equal(page.headers.get('set-cookie'), undefined);

  const unauthPlaylists = await runGuard(guard, {
    url: '/api/qq/user/playlists',
    headers: { host: '127.0.0.1:45437' },
  });
  assert.equal(unauthPlaylists.nextCalled, false);
  assert.equal(unauthPlaylists.statusCode, 401);

  const unauthAudio = await runGuard(guard, {
    url: '/api/netease/audio?id=123',
    headers: { host: '127.0.0.1:45437', 'sec-fetch-site': 'same-origin' },
  });
  assert.equal(unauthAudio.nextCalled, false);
  assert.equal(unauthAudio.statusCode, 401);
});

test('allows same-origin session cookie for regular API and playback, but requires X-Orbit-Token for cookie writes', async () => {
  const guard = createLocalApiGuard({
    apiToken: 'api-secret-token',
    sessionToken: 'session-secret-token',
    issueSessionCookie: false,
  });

  const audio = await runGuard(guard, {
    url: '/api/netease/audio?id=123',
    headers: {
      host: '127.0.0.1:45437',
      'sec-fetch-site': 'same-origin',
      cookie: `${SESSION_COOKIE_NAME}=session-secret-token`,
    },
  });
  assert.equal(audio.nextCalled, true);
  assert.equal(audio.headers.get('cache-control'), 'no-store');

  const logout = await runGuard(guard, {
    method: 'POST',
    url: '/api/qq/logout',
    headers: {
      host: '127.0.0.1:45437',
      origin: 'http://127.0.0.1:45437',
      'sec-fetch-site': 'same-origin',
      cookie: `${SESSION_COOKIE_NAME}=session-secret-token`,
    },
  });
  assert.equal(logout.nextCalled, true);

  // Even with valid browser session cookie, renderer cannot overwrite backend account cookies
  const cookieWriteWithSessionOnly = await runGuard(guard, {
    method: 'PUT',
    url: '/api/netease/login/cookie',
    headers: {
      host: '127.0.0.1:45437',
      origin: 'http://127.0.0.1:45437',
      'sec-fetch-site': 'same-origin',
      cookie: `${SESSION_COOKIE_NAME}=session-secret-token`,
    },
  });
  assert.equal(cookieWriteWithSessionOnly.nextCalled, false);
  assert.equal(cookieWriteWithSessionOnly.statusCode, 401);

  // Electron main process with X-Orbit-Token succeeds
  const cookieWriteWithToken = await runGuard(guard, {
    method: 'PUT',
    url: '/api/netease/login/cookie',
    headers: {
      host: '127.0.0.1:45437',
      [API_TOKEN_HEADER]: 'api-secret-token',
    },
  });
  assert.equal(cookieWriteWithToken.nextCalled, true);
});

test('blocks cross-site, cross-port, DNS rebinding, and CSRF write requests', async () => {
  const guard = createLocalApiGuard({
    apiToken: 'api-secret-token',
    sessionToken: 'session-secret-token',
    issueSessionCookie: false,
  });

  const rebinding = await runGuard(guard, {
    url: '/api/qq/login/status',
    headers: {
      host: 'attacker.example:45437',
      [API_TOKEN_HEADER]: 'api-secret-token',
    },
  });
  assert.equal(rebinding.statusCode, 403);

  const crossOrigin = await runGuard(guard, {
    url: '/api/qq/login/status',
    headers: {
      host: '127.0.0.1:45437',
      origin: 'https://evil.example',
      cookie: `${SESSION_COOKIE_NAME}=session-secret-token`,
    },
  });
  assert.equal(crossOrigin.statusCode, 403);

  const crossPortFetchSite = await runGuard(guard, {
    url: '/api/qq/audio?mid=abc',
    headers: {
      host: '127.0.0.1:45437',
      'sec-fetch-site': 'same-site',
      cookie: `${SESSION_COOKIE_NAME}=session-secret-token`,
    },
  });
  assert.equal(crossPortFetchSite.statusCode, 403);

  const csrfLogoutWithoutSameOriginProof = await runGuard(guard, {
    method: 'POST',
    url: '/api/netease/logout',
    headers: {
      host: '127.0.0.1:45437',
      cookie: `${SESSION_COOKIE_NAME}=session-secret-token`,
    },
  });
  assert.equal(csrfLogoutWithoutSameOriginProof.statusCode, 403);
});

test('browser dev mode issues HttpOnly SameSite=Strict session cookie only on safe top-level navigation', async () => {
  const guard = createLocalApiGuard({
    apiToken: 'api-secret-token',
    sessionToken: 'dev-session-token',
    issueSessionCookie: true,
  });

  const subresourceLoad = await runGuard(guard, {
    url: '/',
    headers: { host: '127.0.0.1:8765', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' },
  });
  assert.equal(subresourceLoad.nextCalled, true);
  assert.equal(subresourceLoad.headers.get('set-cookie'), undefined);

  const navigation = await runGuard(guard, {
    url: '/',
    headers: { host: '127.0.0.1:8765', 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate' },
  });
  assert.equal(navigation.nextCalled, true);
  const setCookie = String(navigation.headers.get('set-cookie') || '');
  assert.match(setCookie, /orbit_session=dev-session-token/);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
});
