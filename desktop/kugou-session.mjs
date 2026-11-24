import crypto from 'node:crypto';

export const KUGOU_HOME = 'https://www.kugou.com/';
const COLLECTION = new URL('uc/getdata.php', KUGOU_HOME);
const GATEWAY_ORIGIN = 'https://gateway.kugou.com';
const LOGIN_USER_ORIGIN = 'https://login-user.kugou.com';
const KUGOU_WEB_SALT = 'NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt';
const KUGOU_ANDROID_SALT = 'OIlwieks28dk2k092lksi2UIkp';
const KUGOU_QR_CREATE_APPID = '1001';
const KUGOU_CLIENT_APPID = '1005';
const KUGOU_CLIENT_VER = '20489';
const KUGOU_ANDROID_UA = 'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi';
const QR_KEY_PATTERN = /^[a-z0-9_-]{8,128}$/i;
const CLIENT_COOKIE_UID = 'orbit_kg_c1005_uid';
const CLIENT_COOKIE_TOKEN = 'orbit_kg_c1005_token';
const CLIENT_COOKIE_NICK = 'orbit_kg_c1005_nick';
const CLIENT_COOKIE_PIC = 'orbit_kg_c1005_pic';
const CLIENT_COOKIE_MID = 'orbit_kg_c1005_mid';
const HASH = /^[a-f0-9]{32}$/i;
const LIST_ID = /^[a-z0-9_-]{1,96}$/i;

function md5(value) {
  return crypto.createHash('md5').update(String(value)).digest('hex');
}

function calculateKugouMid(seed) {
  return BigInt(`0x${md5(seed)}`).toString();
}

function signKugouWeb(params, body = '') {
  const sorted = Object.keys(params).map(key => `${key}=${params[key]}`).sort().join('');
  return md5(`${KUGOU_WEB_SALT}${sorted}${body}${KUGOU_WEB_SALT}`);
}

function signKugouAndroid(params, body = '') {
  const sorted = Object.keys(params).sort()
    .map(key => `${key}=${typeof params[key] === 'object' ? JSON.stringify(params[key]) : params[key]}`)
    .join('');
  return md5(`${KUGOU_ANDROID_SALT}${sorted}${body}${KUGOU_ANDROID_SALT}`);
}

function safeImage(value) {
  try {
    const url = new URL(String(value || '').replace('{size}', '400'));
    if (url.protocol === 'http:') url.protocol = 'https:';
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      /(?:^|\.)(?:kugou\.com|kgimg\.com)$/i.test(url.hostname)) return url.href;
  } catch { /* no usable artwork */ }
  return '';
}

export function kugouSongPage(hash, albumId, pageId) {
  if (typeof hash !== 'string' || !HASH.test(hash)) return '';
  if (/^[a-z0-9]{2,24}$/i.test(pageId || '')) return new URL(`mixsong/${pageId}.html`, KUGOU_HOME).href;
  const parameters = new URLSearchParams({ hash: hash.toUpperCase() });
  if (/^\d{1,16}$/.test(albumId || '')) parameters.set('album_id', albumId);
  return `${KUGOU_HOME}song/#${parameters}`;
}

export function normalizeKugouCollectionSong(row) {
  const hash = String(row?.fileHash || row?.hash || '').toUpperCase();
  const filename = String(row?.fileName || row?.name || '').trim().slice(0, 600);
  let name = String(row?.songname || row?.song_name || '').trim().slice(0, 200);
  let artist = String(row?.singername || row?.author_name || '').trim().slice(0, 200);
  if (!name && filename) {
    const dash = filename.indexOf(' - ');
    name = (dash > 0 ? filename.slice(dash + 3) : filename).trim();
    if (!artist && dash > 0) artist = filename.slice(0, dash).trim();
  }
  if (!HASH.test(hash) || !name) return null;
  const albumId = /^\d{1,16}$/.test(row.album_id ?? row.albumid ?? row.albuminfo?.id ?? '')
    ? String(row.album_id ?? row.albumid ?? row.albuminfo?.id) : '';
  const pageId = /^[a-z0-9]{2,24}$/i.test(row.encode_album_audio_id ?? '') ? String(row.encode_album_audio_id) : '';
  const duration = Number(row.timelen ?? row.fileTimeLen ?? row.duration);
  const singerFromList = Array.isArray(row.singerinfo) ? row.singerinfo.map(s => s?.name).filter(Boolean).join(' / ') : '';
  return {
    hash,
    name,
    artist: artist || singerFromList.slice(0, 200),
    albumId,
    pageId,
    album: String(row.albumName || row.album_name || row.albuminfo?.name || '酷狗音乐').slice(0, 200),
    cover: safeImage(
      row.image || row.imgurl || row.album_img || row.sizable_cover || row.cover
      || row.albuminfo?.sizable_cover || row.albuminfo?.cover || row.trans_param?.union_cover,
    ),
    durationMs: Number.isFinite(duration) && duration > 0 ? duration * (duration < 10000 ? 1000 : 1) : 0,
    sourceUrl: kugouSongPage(hash, albumId, pageId),
  };
}

async function readCollection(cookieSession, type, id) {
  const url = new URL(COLLECTION);
  url.searchParams.set('type', type);
  if (id) url.searchParams.set('listid', id);
  // Keep credentials in Chromium's isolated cookie jar. Never serialize them
  // to the renderer or the loopback music server.
  let response;
  try {
    response = await cookieSession.fetch(url.href, {
      method: 'POST',
      body: new URLSearchParams({ n: String(Math.random()) }),
      credentials: 'include',
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
    });
  } catch (error) {
    // Electron session.fetch throws "Redirect was cancelled" on 302 with redirect: 'manual'.
    if (/redirect/i.test(String(error?.message || ''))) return { ok: false, reason: 'login' };
    throw error;
  }
  if ([301, 302, 303, 307, 308, 401, 403].includes(response.status) || response.type === 'opaqueredirect') {
    return { ok: false, reason: 'login' };
  }
  if (!response.ok) throw new Error(`酷狗暂时无法读取网络收藏 (HTTP ${response.status})`);
  const text = await response.text();
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch {
    throw new Error(`酷狗返回了非 JSON 响应 (HTTP ${response.status}, 长度 ${text.length})`);
  }
}

const KUGOU_AUTH_COOKIES = new Set(['KuGoo', 'KugooID', 'userid', 't', 'token']);

function decodeKugouText(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  try {
    // 酷狗 KuGoo Cookie 的 NickName 常见 %uXXXX 编码格式
    const unicodeFixed = text.replace(/%u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    return decodeURIComponent(unicodeFixed).trim().slice(0, 80);
  } catch {
    return text.slice(0, 80);
  }
}

export function parseKugouCookie(cookieValue) {
  const fields = new Map();
  for (const part of String(cookieValue || '').split('&')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    fields.set(part.slice(0, idx).trim(), part.slice(idx + 1).trim());
  }
  const kugouId = /^\d{4,20}$/.test(fields.get('KugooID') || '') ? fields.get('KugooID') : '';
  const token = String(fields.get('t') || fields.get('token') || '').trim();
  const nickname = decodeKugouText(fields.get('NickName') || fields.get('UserName') || '');
  const avatar = safeImage(decodeKugouText(fields.get('Pic') || ''));
  return {
    loggedIn: Boolean(kugouId || token),
    userid: kugouId,
    token,
    profile: {
      nickname: nickname || (kugouId ? `酷狗用户 ${kugouId.slice(-4)}` : '酷狗用户'),
      avatar,
    },
  };
}

async function readClientSessionCookie(cookieSession) {
  const cookies = await cookieSession.cookies.get({ url: KUGOU_HOME });
  if (!Array.isArray(cookies)) return null;
  const map = new Map(cookies.filter(item => item?.name).map(item => [item.name, String(item.value || '')]));
  const userid = map.get(CLIENT_COOKIE_UID) || '';
  const token = map.get(CLIENT_COOKIE_TOKEN) || '';
  if (!/^\d{4,20}$/.test(userid) || !token) return null;
  return {
    userid,
    token,
    mid: map.get(CLIENT_COOKIE_MID) || calculateKugouMid(userid),
    dfid: map.get('kg_dfid') || '-',
    appid: KUGOU_CLIENT_APPID,
    clientver: KUGOU_CLIENT_VER,
    profile: {
      nickname: decodeKugouText(map.get(CLIENT_COOKIE_NICK) || '') || `酷狗用户 ${userid.slice(-4)}`,
      avatar: safeImage(decodeKugouText(map.get(CLIENT_COOKIE_PIC) || '')),
    },
  };
}

async function saveClientSessionCookie(cookieSession, { userid, token, nickname, avatar, mid }) {
  const expires = Math.floor(Date.now() / 1000) + 86400 * 30;
  const entries = [
    [CLIENT_COOKIE_UID, String(userid)],
    [CLIENT_COOKIE_TOKEN, String(token)],
    [CLIENT_COOKIE_NICK, encodeURIComponent(String(nickname || '').slice(0, 80))],
    [CLIENT_COOKIE_PIC, encodeURIComponent(safeImage(avatar))],
    [CLIENT_COOKIE_MID, String(mid || calculateKugouMid(userid))],
  ];
  for (const [name, value] of entries) {
    await cookieSession.cookies.set({
      url: KUGOU_HOME,
      name,
      value,
      httpOnly: true,
      secure: true,
      expirationDate: expires,
    });
  }
}

export async function createKugouQrLogin(cookieSession) {
  const mid = calculateKugouMid(`orbit-kugou-${Date.now()}-${Math.random()}`);
  const params = {
    appid: KUGOU_QR_CREATE_APPID,
    clienttime: String(Math.floor(Date.now() / 1000)),
    clientver: KUGOU_CLIENT_VER,
    dfid: '-',
    mid,
    plat: '4',
    qrcode_txt: `https://h5.kugou.com/apps/loginQRCode/html/index.html?appid=${KUGOU_CLIENT_APPID}&`,
    srcappid: '2919',
    type: '1',
    uuid: '-',
  };
  params.signature = signKugouWeb(params);
  const response = await cookieSession.fetch(`${LOGIN_USER_ORIGIN}/v2/qrcode?${new URLSearchParams(params)}`, {
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`无法获取酷狗登录二维码 (HTTP ${response.status})`);
  const payload = await response.json();
  const key = String(payload?.data?.qrcode || '').trim();
  const qrImg = String(payload?.data?.qrcode_img || '').trim();
  if (!QR_KEY_PATTERN.test(key) || !qrImg.startsWith('data:image/')) {
    throw new Error(payload?.errmsg || '酷狗未返回有效二维码');
  }
  return { ok: true, key, qrImg, mid };
}

export async function pollKugouQrLogin(cookieSession, key, mid = '') {
  if (typeof key !== 'string' || !QR_KEY_PATTERN.test(key)) throw new Error('无效的酷狗二维码编号');
  const deviceMid = /^\d{10,45}$/.test(mid || '') ? mid : calculateKugouMid(key);
  const params = {
    appid: KUGOU_CLIENT_APPID,
    clienttime: String(Math.floor(Date.now() / 1000)),
    clientver: KUGOU_CLIENT_VER,
    dfid: '-',
    mid: deviceMid,
    plat: '4',
    qrcode: key,
    srcappid: '2919',
    uuid: '-',
  };
  params.signature = signKugouWeb(params);
  const response = await cookieSession.fetch(`${LOGIN_USER_ORIGIN}/v2/get_userinfo_qrcode?${new URLSearchParams(params)}`, {
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`检查酷狗扫码状态失败 (HTTP ${response.status})`);
  const payload = await response.json();
  const data = payload?.data || {};
  const qrStatus = Number(data.status);
  if (qrStatus === 0) return { ok: true, state: 'expired' };
  if (qrStatus === 1) return { ok: true, state: 'waiting' };
  if (qrStatus === 2) {
    return {
      ok: true,
      state: 'scanned',
      profile: {
        nickname: decodeKugouText(data.nickname || '') || '酷狗用户',
        avatar: safeImage(data.pic || ''),
      },
    };
  }
  if (qrStatus === 4 && data.userid && data.token) {
    await saveClientSessionCookie(cookieSession, {
      userid: data.userid,
      token: data.token,
      nickname: data.nickname || '',
      avatar: data.pic || '',
      mid: deviceMid,
    });
    const sessionStatus = await getKugouSessionStatus(cookieSession);
    return { ok: true, state: 'confirmed', ...sessionStatus };
  }
  return { ok: true, state: 'waiting' };
}

async function readKugouCredentials(cookieSession) {
  const direct = await cookieSession.cookies.get({ url: KUGOU_HOME, name: 'KuGoo' });
  const directCookie = direct.find(item => item?.value);
  const directParsed = directCookie ? parseKugouCookie(directCookie.value) : null;
  // 兼容仅存在占位 KuGoo Cookie（如测试替身）的场景，避免多余的域级 Cookie 查询。
  if (directCookie && !directParsed?.loggedIn) {
    return { userid: '', token: '', dfid: '-', mid: md5('orbit-music'), appid: '1014', clientver: '20000', profile: directParsed?.profile || null };
  }
  const client = await readClientSessionCookie(cookieSession);
  if (client) return client;
  const domainCookies = await cookieSession.cookies.get({ domain: 'kugou.com' });
  const allCookies = Array.isArray(domainCookies) ? domainCookies : [];
  const kugouCookie = directCookie || allCookies.find(item => item?.name === 'KuGoo' && item?.value);
  const parsed = kugouCookie ? parseKugouCookie(kugouCookie.value) : { loggedIn: false, userid: '', token: '', profile: null };
  const userid = parsed.userid || String(allCookies.find(item => item?.name === 'userid')?.value || '').trim();
  const token = parsed.token || String(allCookies.find(item => (item?.name === 't' || item?.name === 'token') && item?.value)?.value || '').trim();
  const dfid = String(allCookies.find(item => item?.name === 'kg_dfid' && item?.value)?.value || '-').trim();
  const mid = String(allCookies.find(item => item?.name === 'kg_mid' && item?.value)?.value || md5(userid || 'orbit-music')).trim();
  return {
    userid: /^\d{4,20}$/.test(userid) ? userid : '',
    token,
    dfid,
    mid,
    appid: '1014',
    clientver: '20000',
    profile: parsed.profile,
  };
}

async function requestAndroidGateway(cookieSession, { pathname, method = 'GET', query = {}, bodyObj = null, headers = {} }, creds) {
  const clienttime = String(Math.floor(Date.now() / 1000));
  const mid = creds.mid || calculateKugouMid(creds.userid || 'orbit-music');
  const dfid = creds.dfid || '-';
  const params = {
    dfid,
    mid,
    uuid: '-',
    appid: creds.appid || KUGOU_CLIENT_APPID,
    clientver: creds.clientver || KUGOU_CLIENT_VER,
    clienttime,
    ...(creds.token ? { token: creds.token } : {}),
    ...(creds.userid ? { userid: String(Number(creds.userid)) } : {}),
    ...query,
  };
  const body = bodyObj ? JSON.stringify(bodyObj) : '';
  params.signature = signKugouAndroid(params, body);
  const requestHeaders = {
    'User-Agent': KUGOU_ANDROID_UA,
    dfid,
    clienttime,
    mid,
    'kg-rc': '1',
    'kg-thash': '5d816a0',
    'kg-rec': '1',
    'kg-rf': 'B9EDA08A64250DEFFBCADDEE00F8F25F',
    ...(body ? { 'Content-Type': 'application/json' } : {}),
    ...headers,
  };
  const response = await cookieSession.fetch(`${GATEWAY_ORIGIN}${pathname}?${new URLSearchParams(params)}`, {
    method,
    headers: requestHeaders,
    ...(body ? { body } : {}),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`酷狗云歌单服务暂时不可用 (HTTP ${response.status})`);
  const payload = await response.json();
  if (payload?.error_code === 20006 || payload?.error_code === 20018) return { ok: false, reason: 'login' };
  if (payload?.status !== 1) {
    throw new Error(payload?.errmsg || `酷狗云歌单返回异常 (code: ${payload?.error_code ?? 'unknown'})`);
  }
  return { ok: true, data: payload.data };
}

export async function readKugouSessionProfile(cookieSession) {
  const client = await readClientSessionCookie(cookieSession);
  const direct = await cookieSession.cookies.get({ url: KUGOU_HOME, name: 'KuGoo' });
  const kugouCookie = direct.find(item => item?.value);
  const webParsed = kugouCookie ? parseKugouCookie(kugouCookie.value) : null;
  const webLoggedIn = Boolean(webParsed?.loggedIn);
  if (client) {
    return { ok: true, profile: client.profile, clientReady: true, webPlaybackReady: webLoggedIn };
  }
  if (webLoggedIn) {
    return { ok: true, profile: webParsed.profile, clientReady: false, webPlaybackReady: true };
  }
  const domainCookies = await cookieSession.cookies.get({ domain: 'kugou.com' });
  if (Array.isArray(domainCookies)) {
    const fallbackKugou = domainCookies.find(item => item?.name === 'KuGoo' && item?.value);
    if (fallbackKugou) {
      const parsed = parseKugouCookie(fallbackKugou.value);
      if (parsed.loggedIn) return { ok: true, profile: parsed.profile, clientReady: false, webPlaybackReady: true };
    }
    const hasAlt = domainCookies.some(item => KUGOU_AUTH_COOKIES.has(item?.name) && item?.value && item.name !== 'KuGoo');
    if (hasAlt) return { ok: true, profile: { nickname: '酷狗用户', avatar: '' }, clientReady: false, webPlaybackReady: true };
  }
  return { ok: false, reason: 'login' };
}

export async function getKugouSessionStatus(cookieSession) {
  const sessionInfo = await readKugouSessionProfile(cookieSession);
  if (!sessionInfo.ok) return sessionInfo;
  let collectionError = '';
  try {
    const creds = await readKugouCredentials(cookieSession);
    const account = await listKugouAccountPlaylists(cookieSession);
    if (account.ok) {
      return {
        ok: true,
        profile: sessionInfo.profile,
        clientReady: sessionInfo.clientReady,
        webPlaybackReady: sessionInfo.webPlaybackReady,
        playlists: account.playlists,
        collectionUnavailable: false,
        collectionError: '',
      };
    }
    if (!sessionInfo.clientReady) collectionError = '官网网页登录无法拉取私有歌单，请点「扫码同步歌单」用酷狗 App 扫码';
    else if (!creds.token) collectionError = '未获取到酷狗客户端云歌单令牌，请重新扫码';
    else collectionError = account.reason === 'login' ? '酷狗客户端登录已过期，请重新扫码' : (account.message || '账号歌单暂不可用');
  } catch (error) {
    collectionError = error?.message || '云歌单读取失败';
  }
  return {
    ok: true,
    profile: sessionInfo.profile,
    clientReady: sessionInfo.clientReady,
    webPlaybackReady: sessionInfo.webPlaybackReady,
    playlists: [],
    collectionUnavailable: true,
    collectionError,
  };
}

async function hasKugouAuthCookie(cookieSession) {
  const direct = await cookieSession.cookies.get({ url: COLLECTION.href, name: 'KuGoo' });
  if (direct.length) return true;
  if (await readClientSessionCookie(cookieSession)) return true;
  const domainCookies = await cookieSession.cookies.get({ domain: 'kugou.com' });
  return Array.isArray(domainCookies) && domainCookies.some(cookie => KUGOU_AUTH_COOKIES.has(cookie?.name) && cookie?.value);
}

export async function listKugouAccountPlaylists(cookieSession) {
  // The official web page uses this cookie to identify a session. Its value
  // is not trusted as validation: the collection request must also succeed.
  if (!(await hasKugouAuthCookie(cookieSession))) {
    return { ok: false, reason: 'login' };
  }
  const creds = await readKugouCredentials(cookieSession);
  if (creds.userid && creds.token) {
    const cloud = await requestAndroidGateway(cookieSession, {
      pathname: '/v7/get_all_list',
      method: 'POST',
      query: { plat: '1', userid: String(Number(creds.userid)), token: creds.token },
      bodyObj: {
        userid: Number(creds.userid),
        token: creds.token,
        total_ver: 979,
        type: 2,
        page: 1,
        pagesize: 50,
      },
      headers: { 'x-router': 'cloudlist.service.kugou.com' },
    }, creds);
    if (!cloud.ok) return cloud;
    const rows = Array.isArray(cloud.data?.info) ? cloud.data.info : Array.isArray(cloud.data?.list) ? cloud.data.list : [];
    const lists = rows.flatMap(row => {
      const globalCollectionId = String(row?.global_collection_id || '').trim();
      const rawListId = String(row?.listid ?? row?.listID ?? '').trim();
      const id = LIST_ID.test(globalCollectionId) ? globalCollectionId : rawListId;
      const name = String(row?.name || row?.listName || '').trim().slice(0, 200);
      if (!LIST_ID.test(id) || !name) return [];
      return [{ id, name, count: Number(row?.count) || 0, cover: safeImage(row?.pic), globalCollectionId }];
    });
    return { ok: true, playlists: [...new Map(lists.map(item => [item.id, item])).values()] };
  }

  const result = await readCollection(cookieSession, '16');
  if (!result.ok) return result;
  if (!Array.isArray(result.data?.list)) {
    if (result.data && (result.data.status === 0 || result.data.error_code || result.data.errcode)) {
      return { ok: false, reason: 'login' };
    }
    const keys = result.data && typeof result.data === 'object' ? Object.keys(result.data).slice(0, 6).join(',') : typeof result.data;
    throw new Error(`酷狗没有返回可读取的账号歌单 (字段: ${keys || 'empty'})`);
  }
  const lists = result.data.list.flatMap(row => {
    const id = String(row?.listID ?? '');
    const name = String(row?.listName || '').trim().slice(0, 200);
    return LIST_ID.test(id) && name ? [{ id, name }] : [];
  });
  return { ok: true, playlists: [...new Map(lists.map(item => [item.id, item])).values()] };
}

export async function listKugouAccountSongs(cookieSession, id) {
  if (typeof id !== 'string' || !LIST_ID.test(id)) throw new Error('无效的酷狗歌单编号');
  const account = await listKugouAccountPlaylists(cookieSession);
  if (!account.ok) return account;
  const playlist = account.playlists.find(row => row.id === id);
  if (!playlist) throw new Error('当前账号找不到这份酷狗歌单');
  const creds = await readKugouCredentials(cookieSession);
  if (creds.userid && creds.token) {
    const collectionId = playlist.globalCollectionId || (/^(?:collection_|gcid_)/i.test(id) ? id : '');
    const cloud = collectionId
      ? await requestAndroidGateway(cookieSession, {
        pathname: '/pubsongs/v2/get_other_list_file_nofilt',
        method: 'GET',
        query: {
          area_code: '1',
          begin_idx: '0',
          plat: '1',
          type: '1',
          mode: '1',
          personal_switch: '1',
          extend_fields: 'abtags,hot_cmt,popularization',
          pagesize: '50',
          global_collection_id: collectionId,
        },
      }, creds)
      : await requestAndroidGateway(cookieSession, {
        pathname: '/v4/get_list_all_file',
        method: 'POST',
        bodyObj: {
          userid: Number(creds.userid),
          token: creds.token,
          listid: /^\d+$/.test(id) ? Number(id) : id,
          page: 1,
          pagesize: 50,
          type: 0,
        },
        headers: { 'x-router': 'cloudlist.service.kugou.com' },
      }, creds);
    if (!cloud.ok) return cloud;
    const rows = Array.isArray(cloud.data?.songs)
      ? cloud.data.songs
      : Array.isArray(cloud.data?.info)
        ? cloud.data.info
        : Array.isArray(cloud.data?.list) ? cloud.data.list : [];
    const songs = rows.map(normalizeKugouCollectionSong).filter(Boolean);
    return { ok: true, ...playlist, songs: [...new Map(songs.map(song => [song.hash, song])).values()] };
  }
  const result = await readCollection(cookieSession, '17', id);
  if (!result.ok) return result;
  if (!Array.isArray(result.data)) throw new Error('酷狗没有返回可读取的歌曲');
  const songs = result.data.map(normalizeKugouCollectionSong).filter(Boolean);
  return { ok: true, ...playlist, songs: [...new Map(songs.map(song => [song.hash, song])).values()] };
}
