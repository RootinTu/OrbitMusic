import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectQQAuth, normalizeQQCookieInput, registerQQMusicViteMiddlewares } from './qq-music.mjs';

test('普通网页登录凭据不能冒充 QQ 音乐播放授权', () => {
  assert.deepEqual(inspectQQAuth('uin=o0012345; p_skey=web-only'), {
    userId: '12345',
    accountReady: true,
    playbackReady: false,
    playbackKeyName: '',
  });
});

test('qm_keyst 被识别为 QQ 音乐播放授权', () => {
  assert.deepEqual(inspectQQAuth('uin=o0012345; p_skey=web; qm_keyst=play'), {
    userId: '12345',
    accountReady: true,
    playbackReady: true,
    playbackKeyName: 'qm_keyst',
  });
});

test('微信登录的 wxuin 与 wxskey 可以组成播放授权', () => {
  assert.deepEqual(inspectQQAuth('login_type=2; wxuin=0012345; wxskey=play'), {
    userId: '12345',
    accountReady: true,
    playbackReady: true,
    playbackKeyName: 'wxskey',
  });
});

test('Cookie 归一化保留播放凭据并清理 UIN 前导零', () => {
  assert.equal(
    normalizeQQCookieInput(' uin=o0012345; qm_keyst=abc;;\nqqmusic_key=def; '),
    'uin=12345; qm_keyst=abc; qqmusic_key=def',
  );
});

test('微信会话从 QQ 音乐读取当前账号资料，并在切号后隔离缓存', async t => {
  let middleware;
  let calls = 0;
  registerQQMusicViteMiddlewares({ middlewares: { use: handler => { middleware = handler; } } },
    (response, status, payload) => Object.assign(response, { status, payload }));

  const request = async (url, method = 'GET', body) => {
    const response = {};
    await middleware({ url, method, body }, response, () => assert.fail('Missing route'));
    assert.equal(response.status, 200);
    return response.payload;
  };

  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://u.y.qq.com/cgi-bin/musicu.fcg');
    calls += 1;
    const { comm, account, created } = JSON.parse(options.body);
    if (created) {
      assert.equal(created.param.uin, '67890');
      return Response.json({ created: { code: 0, data: { v_playlist: [
        { uin: '12345', avatar: 'https://example.com/other-avatar.png' },
        { uin: '67890', picurl: 'https://example.com/playlist-cover.png' },
      ] } } });
    }
    assert.equal(account.method, 'GetLoginUserInfo');
    if (comm.uin !== 12345) return Response.json({ account: { code: 1000 } });
    assert.match(options.headers.Cookie, /eas_sid=test-session/);
    return Response.json({
      account: { code: 0, data: { info: { nick: '测试昵称', headurl: 'https://example.com/avatar.png' } } },
    });
  });

  await request('/api/qq/login/cookie', 'PUT', { cookie: 'login_type=2; wxuin=12345; wxskey=test; eas_sid=test-session' });
  const [first, concurrent] = await Promise.all([request('/api/qq/login/status'), request('/api/qq/login/status')]);
  assert.equal(first.nickname, '测试昵称');
  assert.equal(first.avatar, 'https://example.com/avatar.png');
  assert.equal(first.nicknameAvailable, true);
  assert.deepEqual(first, concurrent);
  assert.equal(calls, 1);

  const next = await request('/api/qq/login/cookie', 'PUT', { cookie: 'login_type=2; wxuin=67890; wxskey=other' });
  assert.equal(next.avatar, '');
  const unavailable = await request('/api/qq/login/status');
  assert.equal(unavailable.loggedIn, true);
  assert.equal(unavailable.nicknameAvailable, false);
  assert.equal(unavailable.nickname, 'QQ 音乐');
  assert.equal(unavailable.avatar, '');
  assert.equal(calls, 3);

  await request('/api/qq/logout', 'POST');
  const signedOut = await request('/api/qq/login/status');
  assert.equal(signedOut.loggedIn, false);
  assert.equal(calls, 3);
});

test('QQ 登录按当前 QQ 号加载公开头像，并保留音乐主页头像作为回退', async t => {
  let middleware;
  registerQQMusicViteMiddlewares({ middlewares: { use: handler => { middleware = handler; } } },
    (response, _status, payload) => { response.profile = payload; });
  const request = async (url, method = 'GET', body) => {
    const response = {};
    await middleware({ url, method, body }, response, () => assert.fail('Missing route'));
    return response.profile;
  };
  const encrypted = 'current-encrypted-user';
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.homepage) {
      assert.equal(body.homepage.param.uin, encrypted);
      return Response.json({ homepage: { code: 0, data: { Info: { BaseInfo: {
        EncryptedUin: encrypted, Name: '音乐主页昵称', Avatar: '//example.com/music-avatar.png',
      } } } } });
    }
    return Response.json({ account: { code: 0, data: { info: {
      nick: '登录昵称', EncryptedUin: encrypted, headurl: 'https://example.com/login-avatar.png',
    } } } });
  });
  const initial = await request('/api/qq/login/cookie', 'PUT', { cookie: 'uin=o0043210; qm_keyst=test; avatar=https://example.com/stale-avatar.png' });
  assert.equal(initial.avatar, 'https://q.qlogo.cn/headimg_dl?dst_uin=43210&spec=640');
  const profile = await request('/api/qq/login/status');
  assert.equal(profile.nickname, '音乐主页昵称');
  assert.equal(profile.avatar, initial.avatar);
  assert.equal(profile.avatarFallback, 'https://example.com/music-avatar.png');

  const switched = await request('/api/qq/login/cookie', 'PUT', { cookie: 'login_type=2; wxuin=43210; wxskey=next' });
  assert.equal(switched.loginMethod, 'wechat');
  assert.equal(switched.avatar, '');
  const wechatProfile = await request('/api/qq/login/status');
  assert.equal(wechatProfile.avatar, 'https://example.com/music-avatar.png');
  await request('/api/qq/logout', 'POST');
  assert.equal((await request('/api/qq/login/status')).avatar, '');
});

test('QQ 音乐登录资料缺少头像时，保留授权账号的旧版资料页头像作为回退', async t => {
  let middleware;
  registerQQMusicViteMiddlewares({ middlewares: { use: handler => { middleware = handler; } } },
    (response, _status, payload) => { response.profile = payload; });
  const request = async (url, method = 'GET', body) => {
    const response = {};
    await middleware({ url, method, body }, response, () => assert.fail('Missing route'));
    return response.profile;
  };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const target = new URL(url);
    if (target.hostname === 'c.y.qq.com') {
      assert.equal(target.searchParams.get('userid'), '43210');
      assert.match(options.headers.Cookie, /qm_keyst=test/);
      return Response.json({ code: 0, data: { profile: { uin: '43210', headimgurl: '//example.com/profile.jpg' } } });
    }
    return Response.json({});
  });
  await request('/api/qq/login/cookie', 'PUT', { cookie: 'uin=43210; qm_keyst=test; nick=test-name' });
  const profile = await request('/api/qq/login/status');
  assert.equal(profile.nickname, 'test-name');
  assert.equal(profile.avatar, 'https://q.qlogo.cn/headimg_dl?dst_uin=43210&spec=640');
  assert.equal(profile.avatarFallback, 'https://example.com/profile.jpg');
  await request('/api/qq/logout', 'POST');
});
