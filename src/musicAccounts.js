import { useCallback, useEffect, useRef, useState } from 'react';
import { proxyKugouCover } from './kugouLibrary.js';

const DISPLAY_ACCOUNT_KEY = 'orbit.displayMusicAccount';
const QQ_AVATARS_KEY = 'orbit.qq.localAccountAvatars';
export const MUSIC_PROVIDERS = ['qq', 'netease', 'kugou'];

export function readDisplayMusicAccount() {
  try {
    const saved = localStorage.getItem(DISPLAY_ACCOUNT_KEY);
    return MUSIC_PROVIDERS.includes(saved) ? saved : 'qq';
  } catch {
    return 'qq';
  }
}

export function saveDisplayMusicAccount(provider) {
  if (!MUSIC_PROVIDERS.includes(provider)) return;
  try { localStorage.setItem(DISPLAY_ACCOUNT_KEY, provider); } catch { /* active session still works */ }
}

export function normalizeKugouAccountProfile(result) {
  if (!result?.ok) return null;
  const raw = result.profile || {};
  const nickname = typeof raw.nickname === 'string' && raw.nickname.trim() ? raw.nickname.trim() : '酷狗用户';
  const avatar = proxyKugouCover(raw.avatar || '');
  return {
    loggedIn: true,
    provider: 'kugou',
    nickname,
    avatar,
    clientReady: Boolean(result.clientReady),
  };
}

/**
 * 顶部账号展示与切换归属解析：
 * - 当前激活歌单所属平台若已登录，优先展示该平台账号（歌单与头像一致）；
 * - 否则回退到上次选中的已登录平台 -> 任意已登录平台 -> 当前音乐桥标签页；
 * - 多个平台同时登录时，nextAccount 按 qq -> netease -> kugou 顺序轮换。
 */
export function resolveActiveAccountState({ activeLibrary, displayAccount, bridgeProvider = 'qq', accounts = {} } = {}) {
  const activeProvider = MUSIC_PROVIDERS.find(provider => String(activeLibrary || '').startsWith(`${provider}:`)) || null;
  const loggedInProviders = MUSIC_PROVIDERS.filter(provider => Boolean(accounts[provider]?.profile));

  let accountProvider;
  if (activeProvider && accounts[activeProvider]?.profile) {
    accountProvider = activeProvider;
  } else if (accounts[displayAccount]?.profile) {
    accountProvider = displayAccount;
  } else if (loggedInProviders.length) {
    accountProvider = loggedInProviders[0];
  } else {
    accountProvider = activeProvider || (MUSIC_PROVIDERS.includes(bridgeProvider) ? bridgeProvider : 'qq');
  }

  let nextAccount = null;
  if (loggedInProviders.length > 1) {
    const currentIndex = loggedInProviders.indexOf(accountProvider);
    nextAccount = loggedInProviders[(currentIndex + 1 + loggedInProviders.length) % loggedInProviders.length];
    if (nextAccount === accountProvider) nextAccount = null;
  }

  return { accountProvider, nextAccount, activeProvider, loggedInProviders };
}

export function useMusicAccount(provider) {
  const [profile, setProfile] = useState(null);
  const revision = useRef(0);
  const update = useCallback(next => {
    revision.current += 1;
    setProfile(next?.loggedIn ? next : null);
  }, []);

  const refresh = useCallback(async signal => {
    const request = ++revision.current;
    try {
      const response = await fetch(`/api/${provider}/login/status`, { cache: 'no-store', signal });
      if (!response.ok) return null;
      const next = await response.json();
      if (request !== revision.current || signal?.aborted) return null;
      update(next);
      return next?.loggedIn ? next : null;
    } catch {
      return null;
    }
  }, [provider, update]);

  useEffect(() => {
    const controller = new AbortController();
    refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  return { profile, refresh, update };
}

export function useKugouAccount() {
  const [profile, setProfile] = useState(null);
  const revision = useRef(0);

  const update = useCallback(next => {
    revision.current += 1;
    if (!next) {
      setProfile(null);
      return;
    }
    const normalized = next.loggedIn ? next : normalizeKugouAccountProfile(next);
    setProfile(normalized?.loggedIn ? normalized : null);
  }, []);

  const refresh = useCallback(async () => {
    const api = typeof window !== 'undefined' ? window.orbitDesktop : null;
    if (!api?.listKugouPlaylists) return null;
    const request = ++revision.current;
    try {
      const result = await api.listKugouPlaylists();
      if (request !== revision.current) return null;
      const normalized = normalizeKugouAccountProfile(result);
      update(normalized);
      return normalized;
    } catch {
      return null;
    }
  }, [update]);

  useEffect(() => {
    const api = typeof window !== 'undefined' ? window.orbitDesktop : null;
    if (!api?.listKugouPlaylists) return undefined;
    refresh();
    const unsubscribe = api.onKugouAuth?.(result => {
      if (result?.ok) update(normalizeKugouAccountProfile(result));
      else if (result?.reason === 'login') update(null);
    });
    return () => { unsubscribe?.(); };
  }, [refresh, update]);

  return { profile, refresh, update };
}

export function musicAccountName(profile, provider) {
  const nickname = typeof profile?.nickname === 'string' ? profile.nickname.trim() : '';
  if (nickname) return nickname;
  if (provider === 'netease') return '网易云音乐用户';
  if (provider === 'kugou') return '酷狗音乐用户';
  return 'QQ 音乐用户';
}

function readQQAvatars() {
  try {
    const data = JSON.parse(localStorage.getItem(QQ_AVATARS_KEY));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

export function useLocalQQAvatar(account) {
  const [avatars, setAvatars] = useState(readQQAvatars);
  const profile = account.profile;
  const accountKey = profile?.userId ? `${profile.loginMethod || 'qq'}:${profile.userId}` : '';
  const localAvatar = accountKey ? avatars[accountKey] : '';

  function setAvatar(image) {
    if (!accountKey) return;
    const next = readQQAvatars();
    if (image) next[accountKey] = image;
    else delete next[accountKey];
    localStorage.setItem(QQ_AVATARS_KEY, JSON.stringify(next));
    setAvatars(next);
  }

  return {
    ...account,
    profile: profile && localAvatar ? { ...profile, localAvatar } : profile,
    setAvatar: accountKey ? setAvatar : undefined,
  };
}
