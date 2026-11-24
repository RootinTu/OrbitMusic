const QQ_COOKIE_HEADER = 'x-qq-music-cookie';
const QQ_AVATAR_URL = 'https://q.qlogo.cn/headimg_dl';

let qqCookie = '';
let qqProfileSession = null;

export function parseCookieString(cookieText) {
  const out = {};
  String(cookieText || '').split(/[;\n\r]+/).forEach((part) => {
    const raw = String(part || '').trim();
    if (!raw) return;
    const index = raw.indexOf('=');
    if (index <= 0) return;
    const key = raw.slice(0, index).trim();
    const value = raw.slice(index + 1).trim().replace(/;+$/, '');
    if (key && value) out[key] = value;
  });
  return out;
}

export function serializeCookieObject(cookie) {
  return Object.entries(cookie || {})
    .filter(([key, value]) => key && value != null && String(value) !== '')
    .map(([key, value]) => `${key}=${String(value)}`)
    .join('; ');
}

export function normalizeQQUin(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  return digits.replace(/^0+/, '') || digits;
}

export function normalizeQQCookieInput(cookieText) {
  const cookie = parseCookieString(cookieText);
  if (Number(cookie.login_type) === 2 && cookie.wxuin && !cookie.uin) cookie.uin = cookie.wxuin;
  if (!cookie.uin && (cookie.qqmusic_uin || cookie.p_uin)) cookie.uin = cookie.qqmusic_uin || cookie.p_uin;
  if (cookie.uin) cookie.uin = normalizeQQUin(cookie.uin);
  return serializeCookieObject(cookie);
}

export function getQQCookie() {
  return qqCookie;
}

export function qqCookieObject(cookieText = qqCookie) {
  return parseCookieString(normalizeQQCookieInput(cookieText));
}

export function qqCookieUin(cookie = qqCookieObject()) {
  const raw = Number(cookie.login_type) === 2
    ? (cookie.wxuin || cookie.uin || cookie.p_uin)
    : (cookie.uin || cookie.qqmusic_uin || cookie.wxuin || cookie.p_uin);
  return normalizeQQUin(raw);
}

export function qqCookieMusicKey(cookie = qqCookieObject()) {
  return cookie.qm_keyst
    || cookie.qqmusic_key
    || cookie.music_key
    || cookie.p_skey
    || cookie.skey
    || cookie.psrf_qqaccess_token
    || cookie.psrf_qqrefresh_token
    || cookie.wxrefresh_token
    || cookie.wxskey
    || '';
}

export function qqCookiePlaybackKey(cookie = qqCookieObject()) {
  return cookie.qm_keyst || cookie.qqmusic_key || cookie.music_key || cookie.wxskey || '';
}

export function qqCookiePlaybackKeyName(cookie = qqCookieObject()) {
  return ['qm_keyst', 'qqmusic_key', 'music_key', 'wxskey'].find((key) => cookie[key]) || '';
}

export function inspectQQAuth(cookieText = qqCookie) {
  const cookie = qqCookieObject(cookieText);
  const userId = qqCookieUin(cookie);
  const accountKey = qqCookieMusicKey(cookie);
  const playbackKey = qqCookiePlaybackKey(cookie);
  return {
    userId,
    accountReady: Boolean(userId && accountKey),
    playbackReady: Boolean(userId && playbackKey),
    playbackKeyName: qqCookiePlaybackKeyName(cookie),
  };
}

function decodeCookieValue(value) {
  try {
    return decodeURIComponent(String(value || '').replace(/\+/g, '%20')).trim();
  } catch {
    return String(value || '').trim();
  }
}

function qqCookieNickname(cookie, uin) {
  const padded = uin ? `0${uin}` : '';
  const keys = [
    uin && `ptnick_${uin}`,
    padded && `ptnick_${padded}`,
    'ptnick',
    'nick',
    'nickname',
    'qq_nickname',
  ].filter(Boolean);
  for (const key of keys) {
    if (cookie[key]) return decodeCookieValue(cookie[key]);
  }
  return '';
}

const firstText = values => values.find(value => typeof value === 'string' && value.trim())?.trim() || '';

function qqProfileAvatar(info) {
  const values = [info?.Avatar, info?.avatar, info?.avatarUrl, info?.avatar_url, info?.HeadUrl,
    info?.headurl, info?.headUrl, info?.headPic, info?.headpic, info?.headPicUrl, info?.headimgurl, info?.picurl];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    try {
      const raw = value.trim();
      const url = new URL(raw.startsWith('//') ? `https:${raw}` : raw);
      if (url.protocol === 'https:' && !url.username && !url.password) return url.href;
    } catch { /* An empty field or a provider image ID is not an avatar URL. */ }
  }
  return '';
}

function qqProfileName(info) {
  return firstText([info?.nick, info?.nickname, info?.NickName, info?.Name]);
}

export function setQQCookie(cookieText) {
  qqCookie = normalizeQQCookieInput(cookieText);
  const cookie = qqCookieObject();
  const playbackKey = qqCookiePlaybackKey(cookie);
  const userId = qqCookieUin(cookie);
  if (!playbackKey || !userId) {
    qqProfileSession = null;
    return;
  }
  const identity = JSON.stringify([cookie.login_type, userId, playbackKey, cookie.eas_sid]);
  if (qqProfileSession?.identity !== identity) {
    qqProfileSession = { identity, details: null, expiresAt: 0, pending: null };
  }
}

export function readHeaderCookie(req) {
  const raw = req.headers?.[QQ_COOKIE_HEADER];
  return normalizeQQCookieInput(Array.isArray(raw) ? raw[0] : raw);
}

export function currentCookie(req) {
  return readHeaderCookie(req) || qqCookie;
}

export function qqGtk(cookieText = qqCookie) {
  const cookie = qqCookieObject(cookieText);
  const key = cookie.skey || cookie.p_skey || cookie.qqmusic_key || cookie.qm_keyst || '';
  let hash = 5381;
  for (let index = 0; index < key.length; index += 1) hash += (hash << 5) + key.charCodeAt(index);
  return hash & 0x7fffffff;
}

export function normalizeQQProfile(cookieText = qqCookie) {
  const cookie = qqCookieObject(cookieText);
  const userId = qqCookieUin(cookie);
  const musicKey = qqCookieMusicKey(cookie);
  const playbackKey = qqCookiePlaybackKey(cookie);
  const nickname = qqCookieNickname(cookie, userId);
  const loginMethod = Number(cookie.login_type) === 2 ? 'wechat' : 'qq';
  const qqNumber = cookie.uin;
  const avatar = loginMethod === 'qq' && playbackKey && /^[1-9]\d*$/.test(qqNumber)
    ? `${QQ_AVATAR_URL}?dst_uin=${qqNumber}&spec=640`
    : '';
  return {
    provider: 'qq',
    loggedIn: Boolean(userId && playbackKey),
    accountLoggedIn: Boolean(userId && musicKey),
    userId,
    nickname: nickname || (loginMethod === 'qq' && userId ? `QQ ${userId}` : 'QQ 音乐'),
    nicknameAvailable: Boolean(nickname),
    loginMethod,
    avatar,
    hasCookie: Boolean(cookieText),
    playbackKeyReady: Boolean(userId && playbackKey),
    playbackKeyName: qqCookiePlaybackKeyName(cookie),
  };
}

export function currentQQProfile() {
  const profile = normalizeQQProfile();
  const details = qqProfileSession?.details;
  if (!details) return profile;
  return {
    ...profile,
    nickname: details.nickname || profile.nickname,
    nicknameAvailable: Boolean(details.nickname) || profile.nicknameAvailable,
    avatar: profile.avatar || details.avatar || '',
    avatarFallback: profile.avatar && details.avatar !== profile.avatar ? details.avatar || '' : '',
  };
}

async function loadQQMusicProfile(cookieText, { qqMusicRequest, qqGetJSON }) {
  const cookie = qqCookieObject(cookieText);
  const userId = qqCookieUin(cookie);
  const comm = { uin: Number(userId), ct: 24, cv: 0, format: 'json' };
  const options = { timeoutMs: 4500, redirect: 'error' };
  const request = methods => qqMusicRequest({ comm, ...methods }, cookieText, true, options);
  const serviceData = service => service?.code === 0 ? service.data : null;

  const self = await request({
    account: { module: 'music.UserInfo.userInfoServer', method: 'GetLoginUserInfo', param: {} },
    legacy: { module: 'QQMusic.UserLoginServer', method: 'GetUserInfo', param: {} },
  }).catch(() => ({}));
  const account = serviceData(self.account)?.info;
  const legacy = serviceData(self.legacy);
  let nickname = qqProfileName(account) || qqProfileName(legacy);
  let avatar = qqProfileAvatar(account) || qqProfileAvatar(legacy);
  const encryptedUin = firstText([account?.EncryptedUin, account?.encryptUin, account?.encuin,
    legacy?.encryptUin, legacy?.encuin, cookie.encrypt_uin, cookie.encryptUin, cookie.euin]);
  if (encryptedUin && !/^\d+$/.test(encryptedUin)) {
    // The music profile may use a different avatar from the login account.
    const { homepage } = await request({
      homepage: {
        module: 'music.UnifiedHomepage.UnifiedHomepageSrv', method: 'GetHomepageHeader',
        param: { uin: encryptedUin, IsQueryTabDetail: 1 },
      },
    }).catch(() => ({}));
    const base = serviceData(homepage)?.Info?.BaseInfo;
    if (base?.EncryptedUin === encryptedUin) {
      nickname = qqProfileName(base) || nickname;
      avatar = qqProfileAvatar(base) || avatar;
    }
  }
  if (!avatar) {
    const [{ created }, home] = await Promise.all([
      request({
        created: { module: 'music.musicasset.PlaylistBaseRead', method: 'GetPlaylistByUin', param: { uin: userId } },
      }).catch(() => ({})),
      Number(cookie.login_type) === 2 ? null : qqGetJSON('https://c.y.qq.com/rsc/fcgi-bin/fcg_get_profile_homepage.fcg', {
        cid: 205360838, reqfrom: 1, userid: userId, format: 'json', g_tk: qqGtk(cookieText),
      }, cookieText, { ...options, headers: { Referer: 'https://y.qq.com/n/ryqq/profile' } }).catch(() => null),
    ]);
    const profile = home?.code === 0 ? home.data?.profile : null;
    if (profile && (!profile.uin || normalizeQQUin(profile.uin) === userId)) {
      avatar = qqProfileAvatar(profile);
      nickname ||= qqProfileName(profile);
    }
    const playlists = serviceData(created)?.v_playlist;
    if (!avatar && Array.isArray(playlists)) {
      // Use only the owner avatar of this account's own playlists.
      const owner = playlists.find(item => String(item?.uin) === userId && qqProfileAvatar({ avatar: item.avatar }));
      avatar = qqProfileAvatar({ avatar: owner?.avatar });
      nickname ||= qqProfileName(owner);
    }
  }
  return { nickname, avatar };
}

export async function refreshQQProfile(deps) {
  const session = qqProfileSession;
  if (!session || session.expiresAt > Date.now()) return currentQQProfile();
  if (!session.pending) {
    session.pending = loadQQMusicProfile(qqCookie, deps).then(({ nickname, avatar }) => {
      if (nickname || avatar) {
        session.details = {
          nickname: nickname || session.details?.nickname,
          avatar: avatar || session.details?.avatar,
        };
      }
      session.expiresAt = Date.now() + (nickname && avatar ? 15 * 60_000 : 60_000);
    }).catch(() => {
      session.expiresAt = Date.now() + 30_000;
    }).finally(() => { session.pending = null; });
  }
  await session.pending;
  return currentQQProfile();
}
