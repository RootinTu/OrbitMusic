import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { startLocalServer } from '../local-server.mjs';

test('startLocalServer falls back to the next free port on EADDRINUSE', async () => {
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const blockedPort = blocker.address().port;

  let started = null;
  try {
    started = await startLocalServer({
      port: blockedPort,
      maxPortRetries: 10,
      guardOptions: {
        apiToken: 'test-api-token',
        sessionToken: 'test-session-token',
        issueSessionCookie: false,
      },
    });
    assert.notEqual(started.port, blockedPort);
    assert.equal(started.url, `http://127.0.0.1:${started.port}`);

    const unauth = await fetch(`${started.url}/api/qq/login/status`);
    assert.equal(unauth.status, 401);

    const auth = await fetch(`${started.url}/api/qq/login/status`, {
      headers: { Cookie: 'orbit_session=test-session-token', 'Sec-Fetch-Site': 'same-origin' },
    });
    assert.equal(auth.status, 200);
  } finally {
    if (started?.server) await new Promise(resolve => started.server.close(resolve));
    await new Promise(resolve => blocker.close(resolve));
  }
});
