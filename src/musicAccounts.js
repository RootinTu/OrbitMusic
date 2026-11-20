import { useCallback, useEffect, useRef, useState } from 'react';

const DISPLAY_ACCOUNT_KEY = 'orbit.displayMusicAccount';
const QQ_AVATARS_KEY = 'orbit.qq.localAccountAvatars';

export function readDisplayMusicAccount() {
  try {
    return localStorage.getItem(DISPLAY_ACCOUNT_KEY) === 'netease' ? 'netease' : 'qq';
  } catch {
    return 'qq';
  }
}

export function saveDisplayMusicAccount(provider) {
  try { localStorage.setItem(DISPLAY_ACCOUNT_KEY, provider); } catch { /* active session still works */ }
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

export function musicAccountName(profile, provider) {
  const nickname = typeof profile?.nickname === 'string' ? profile.nickname.trim() : '';
  return nickname || (provider === 'qq' ? 'QQ 音乐用户' : '网易云音乐用户');
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
