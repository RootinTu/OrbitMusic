import { useCallback, useEffect, useRef, useState } from 'react';
import { BridgeGlassButton, BridgeGlassInput } from './BridgeGlassControls.jsx';
import MusicAccountAvatar from './MusicAccountAvatar.jsx';
import { isAbortError } from './asyncSlot.js';
import { MAX_KUGOU_PLAYLISTS, MAX_KUGOU_TRACKS } from './kugouLibrary.js';
import { normalizeKugouAccountProfile } from './musicAccounts.js';

const importErrors = {
  empty: '没有可导入的歌曲',
  duplicate: '这些歌曲已在歌单里',
  'track-limit': `当前歌单最多 ${MAX_KUGOU_TRACKS} 首`,
  'playlist-limit': `酷狗最多保留 ${MAX_KUGOU_PLAYLISTS} 个歌单`,
  storage: '无法保存到本机曲库',
};

function Art({ src, title }) {
  return src
    ? <img src={src} alt={title || ''} loading="lazy" />
    : <span className="bridge-art-fallback">♫</span>;
}

export default function KugouBridge({
  open, account, onImport, onClear, importedCount,
  playlists: localPlaylists = [], activePlaylistId = null, onSwitchPlaylist,
}) {
  const updateAccount = account?.update;
  const api = window.orbitDesktop;
  const desktop = Boolean(api?.openKugouLogin);
  const [profile, setProfile] = useState(null);
  const [clientReady, setClientReady] = useState(false);
  const [accountPlaylists, setAccountPlaylists] = useState([]);
  const [collectionError, setCollectionError] = useState('');
  const [qrSession, setQrSession] = useState(null);
  const [songQuery, setSongQuery] = useState('');
  const [songResults, setSongResults] = useState([]);
  const [playlistInput, setPlaylistInput] = useState('');
  const [searchPlaylists, setSearchPlaylists] = useState([]);
  const [preview, setPreview] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const pending = useRef(null);
  const abortRef = useRef(null);
  const qrTimerRef = useRef(null);
  const loggedIn = Boolean(profile);
  const loggedInRef = useRef(false);
  loggedInRef.current = loggedIn;

  const stopQrPolling = useCallback(() => {
    if (qrTimerRef.current) {
      clearInterval(qrTimerRef.current);
      qrTimerRef.current = null;
    }
  }, []);

  const applySessionResult = useCallback(result => {
    const normalized = normalizeKugouAccountProfile(result);
    const nextProfile = normalized || result.profile || { nickname: '酷狗用户', avatar: '' };
    const nextList = Array.isArray(result.playlists) ? result.playlists : [];
    setProfile(nextProfile);
    setClientReady(Boolean(result.clientReady));
    setAccountPlaylists(nextList);
    setCollectionError(result.collectionError || '');
    updateAccount?.(normalized);
  }, [updateAccount]);

  const run = useCallback(async (action, request, onSuccess, { silentLogin = false, supersede = false } = {}) => {
    if (pending.current && !supersede) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const token = {};
    pending.current = token;
    setBusy(action);
    setNotice('');
    try {
      const result = await request(controller.signal);
      if (pending.current !== token || controller.signal.aborted) return;
      if (result?.ok) onSuccess(result);
      else if (result?.reason === 'login') {
        setProfile(null);
        setClientReady(false);
        setAccountPlaylists([]);
        setCollectionError('');
        setPreview(null);
        updateAccount?.(null);
        if (!silentLogin) setNotice('尚未检测到酷狗登录态，请先扫码登录。');
      } else setNotice(result?.message || result?.error || '酷狗请求未完成');
    } catch (error) {
      if (pending.current === token && !isAbortError(error)) setNotice('暂时无法连接酷狗服务，请稍后再试。');
    } finally {
      if (pending.current === token) {
        pending.current = null;
        if (abortRef.current === controller) abortRef.current = null;
        setBusy('');
      }
    }
  }, []);

  const refresh = useCallback((silentLogin = false) => (
    run('refresh', () => api.listKugouPlaylists(), applySessionResult, { silentLogin })
  ), [api, applySessionResult, run]);

  useEffect(() => {
    if (!open || !desktop) return;
    refresh(true);
    // 仅在尚未登录时切回窗口自动刷新，避免已登录后切回主窗口意外清空操作提示。
    function onFocus() { if (!loggedInRef.current) refresh(true); }
    const unsubscribeAuth = api?.onKugouAuth?.(result => {
      pending.current = null;
      setBusy('');
      if (result?.ok) {
        applySessionResult(result);
        setNotice(result.playlists?.length
          ? '酷狗账号已连接，已读取账号歌单。'
          : '酷狗账号已登录；可搜索歌曲、搜歌单或粘贴链接导入。');
      } else if (result?.reason === 'login') {
        setProfile(null);
        setAccountPlaylists([]);
        setCollectionError('');
        setPreview(null);
        updateAccount?.(null);
        setNotice('尚未检测到酷狗登录态，请确认已在官网登录成功。');
      } else if (result?.message) {
        setNotice(result.message);
      }
    });
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      unsubscribeAuth?.();
      stopQrPolling();
      abortRef.current?.abort();
      abortRef.current = null;
      pending.current = null;
      setBusy('');
      setNotice('');
      setProfile(null);
      setClientReady(false);
      setAccountPlaylists([]);
      setCollectionError('');
      setQrSession(null);
      setSearchPlaylists([]);
      setPreview(null);
      setConfirmClear(false);
    };
  }, [api, applySessionResult, desktop, open, refresh, stopQrPolling]);

  const startQrLogin = useCallback(async () => {
    if (!api?.createKugouQr || !api?.pollKugouQr) return;
    stopQrPolling();
    setPreview(null);
    run('qr', () => api.createKugouQr(), result => {
      setQrSession({ key: result.key, mid: result.mid, qrImg: result.qrImg, state: 'waiting' });
      let polling = false;
      qrTimerRef.current = setInterval(async () => {
        if (polling) return;
        polling = true;
        try {
          const check = await api.pollKugouQr(result.key, result.mid);
          if (!check?.ok) return;
          if (check.state === 'expired') {
            stopQrPolling();
            setQrSession(prev => (prev ? { ...prev, state: 'expired' } : null));
          } else if (check.state === 'scanned') {
            setQrSession(prev => (prev ? { ...prev, state: 'scanned', nickname: check.profile?.nickname } : null));
          } else if (check.state === 'confirmed') {
            stopQrPolling();
            setQrSession(null);
            applySessionResult(check);
            setNotice(check.playlists?.length
              ? `酷狗扫码成功，已同步 ${check.playlists.length} 个账号歌单。`
              : '酷狗扫码登录成功！');
          }
        } catch {
          // 下一轮继续轮询
        } finally {
          polling = false;
        }
      }, 1500);
    });
  }, [api, applySessionResult, run, stopQrPolling]);

  function openPreview(data) {
    setPreview(data);
    setSelected(new Set(data.songs.slice(0, MAX_KUGOU_TRACKS).map(song => song.hash)));
  }

  function searchSongs(event) {
    event.preventDefault();
    const clean = songQuery.trim();
    if (!clean) return;
    run('search', async signal => {
      const response = await fetch(`/api/kugou/search?${new URLSearchParams({ q: clean, type: 'song' })}`, { signal });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) return { ok: false, message: payload.error || '搜索酷狗歌曲失败' };
      return payload;
    }, result => {
      setSongResults(result.songs || []);
      if (!result.songs?.length) setNotice('没有搜到匹配的酷狗歌曲。');
    }, { supersede: true });
  }

  function importLooseSong(song) {
    const result = onImport([song], { id: 'loose', name: '酷狗零散导入' });
    setNotice(result.added ? `已加入「${song.name}」` : importErrors[result.reason] || '导入失败');
  }

  function inspectAccountPlaylist(id) {
    setPreview(null);
    run(`playlist:${id}`, () => api.listKugouSongs(id), result => openPreview({ ...result, id: `account:${result.id}` }), { supersede: true });
  }

  function inspectPublicPlaylist(input, name = '') {
    const clean = String(input || '').trim();
    if (!clean) { setNotice('请输入酷狗歌单链接、数字 ID 或歌单关键词。'); return; }
    setPreview(null);
    run(`playlist:${clean}`, async signal => {
      const params = new URLSearchParams({ input: clean });
      if (name) params.set('name', name);
      const response = await fetch(`/api/kugou/playlist?${params}`, { signal });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) return { ok: false, message: payload.error || '无法读取该酷狗歌单' };
      return payload;
    }, openPreview, { supersede: true });
  }

  function handlePlaylistInputSubmit(event) {
    event.preventDefault();
    const clean = playlistInput.trim();
    if (!clean) return;
    if (/^\d{1,16}$/.test(clean) || /kugou\.com/i.test(clean)) {
      inspectPublicPlaylist(clean);
      return;
    }
    run('search-playlist', async signal => {
      const response = await fetch(`/api/kugou/search?${new URLSearchParams({ q: clean, type: 'playlist' })}`, { signal });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) return { ok: false, message: payload.error || '搜索酷狗歌单失败' };
      return payload;
    }, result => {
      const list = result.playlists || [];
      setSearchPlaylists(list);
      if (!list.length) setNotice('没有搜到匹配的酷狗公开歌单。');
    }, { supersede: true });
  }

  function toggle(hash) {
    setSelected(previous => {
      const next = new Set(previous);
      if (next.has(hash)) next.delete(hash);
      else if (next.size < MAX_KUGOU_TRACKS) next.add(hash);
      return next;
    });
  }

  function importPreview() {
    const songs = preview.songs.filter(song => selected.has(song.hash));
    const result = onImport(songs, { id: preview.id, name: preview.name });
    if (result.added) {
      setNotice(`已导入 ${result.added} 首到「${result.name}」`);
      setPreview(null);
    } else {
      setNotice(importErrors[result.reason] || '导入失败');
    }
  }

  const isDirectLink = /^\d{1,16}$/.test(playlistInput.trim()) || /kugou\.com/i.test(playlistInput.trim());

  if (!open) return null;
  return (
    <>
      <div className="bridge-status">
        {profile ? <MusicAccountAvatar profile={profile} /> : <span className="bridge-pulse" />}
        <div>
          <strong title={profile?.nickname || undefined}>{profile ? (profile.nickname || '酷狗音乐账号') : '等待扫码登录'}</strong>
          <small>{!desktop ? '请在 ORBIT 桌面版登录酷狗' : clientReady ? '已登录酷狗音乐' : '打开酷狗 App 扫码后可同步「我喜欢」与我的歌单'}</small>
        </div>
        {desktop && (clientReady
          ? <BridgeGlassButton disabled={Boolean(busy)} onClick={() => {
            stopQrPolling();
            setQrSession(null);
            run('logout', () => api.clearKugouLogin(), () => {
              setProfile(null);
              setClientReady(false);
              setAccountPlaylists([]);
              setCollectionError('');
              setPreview(null);
              updateAccount?.(null);
              setNotice('已退出酷狗账号；此前导入本机的歌单仍保留。');
            });
          }}>退出</BridgeGlassButton>
          : <BridgeGlassButton disabled={Boolean(busy)} onClick={startQrLogin}>
            {busy === 'qr' ? '加载中…' : '扫码登录'}
          </BridgeGlassButton>)}
      </div>

      <div className="bridge-grid">
        <div className="bridge-pane bridge-search">
          <span className="bridge-label">搜索歌曲</span>
          <form onSubmit={searchSongs} className="bridge-input-row">
            <BridgeGlassInput value={songQuery} onChange={event => setSongQuery(event.target.value)} placeholder="歌名、歌手" aria-label="搜索酷狗音乐" />
            <BridgeGlassButton type="submit" disabled={busy === 'search'}>{busy === 'search' ? '搜索中' : '搜索'}</BridgeGlassButton>
          </form>
          <div className="bridge-results">
            {songResults.map(song => (
              <article className="bridge-song" key={song.hash}>
                <Art src={song.cover} title={song.name} />
                <div><strong>{song.name}</strong><small>{song.artist || '酷狗音乐'}{song.album ? ` · ${song.album}` : ''}</small></div>
                <button type="button" onClick={() => importLooseSong(song)} aria-label={`加入 ${song.name}`}>＋</button>
              </article>
            ))}
            {!songResults.length && <div className="bridge-empty">搜索后可逐首加入，导入结果会成为可旋转的音乐卡片。</div>}
          </div>
        </div>

        <div className="bridge-pane bridge-library">
          <div className="bridge-pane-title">
            <span className="bridge-label">导入歌单</span>
            <small>每个歌单最多 {MAX_KUGOU_TRACKS} 首</small>
          </div>
          {qrSession ? (
            <div className="bridge-preview" style={{ alignItems: 'center', justifyContent: 'center', textAlign: 'center', gap: '12px', padding: '18px 12px' }}>
              <img src={qrSession.qrImg} alt="酷狗 App 扫码登录" style={{ width: '176px', height: '176px', borderRadius: '14px', background: '#fff', padding: '8px' }} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <strong>
                  {qrSession.state === 'expired'
                    ? '二维码已过期'
                    : qrSession.state === 'scanned'
                      ? `已扫码${qrSession.nickname ? ` · ${qrSession.nickname}` : ''}`
                      : '酷狗 App 扫一扫登录'}
                </strong>
                <small style={{ opacity: 0.72 }}>
                  {qrSession.state === 'expired'
                    ? '请点击下方按钮重新获取二维码'
                    : qrSession.state === 'scanned'
                      ? '请在手机酷狗 App 上点击确认'
                      : '确认后自动同步「我喜欢」与我的歌单'}
                </small>
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <BridgeGlassButton onClick={startQrLogin} disabled={Boolean(busy)}>刷新二维码</BridgeGlassButton>
                <BridgeGlassButton onClick={() => { stopQrPolling(); setQrSession(null); }}>取消</BridgeGlassButton>
              </div>
            </div>
          ) : preview ? (
            <div className="bridge-preview">
              <div className="bridge-preview-head">
                <BridgeGlassButton className="bridge-preview-back" onClick={() => setPreview(null)} aria-label="返回歌单列表">←</BridgeGlassButton>
                <span>
                  <strong>{preview.name}</strong>
                  <small>共 {preview.songs.length} 首</small>
                </span>
              </div>
              <div className="bridge-preview-actions">
                <span>已选 {selected.size} / {MAX_KUGOU_TRACKS} 首</span>
                <BridgeGlassButton onClick={() => setSelected(new Set(preview.songs.slice(0, MAX_KUGOU_TRACKS).map(song => song.hash)))}>全选可装的</BridgeGlassButton>
                <BridgeGlassButton onClick={() => setSelected(new Set())} disabled={!selected.size}>清空</BridgeGlassButton>
              </div>
              <div className="bridge-preview-list">
                {preview.songs.map(song => (
                  <label className={`bridge-preview-row ${selected.has(song.hash) ? 'checked' : ''}`} key={song.hash}>
                    <input
                      type="checkbox"
                      checked={selected.has(song.hash)}
                      disabled={!selected.has(song.hash) && selected.size >= MAX_KUGOU_TRACKS}
                      onChange={() => toggle(song.hash)}
                    />
                    <b>{song.name}</b>
                    <small>{song.artist || '酷狗音乐'}{song.album ? ` · ${song.album}` : ''}</small>
                  </label>
                ))}
              </div>
              <BridgeGlassButton className="bridge-preview-import" disabled={!selected.size || Boolean(busy)} onClick={importPreview}>
                导入所选 {selected.size} 首
              </BridgeGlassButton>
            </div>
          ) : (
            <>
              <form className="bridge-link-import" onSubmit={handlePlaylistInputSubmit}>
                <div className="bridge-input-row">
                  <BridgeGlassInput
                    value={playlistInput}
                    onChange={event => setPlaylistInput(event.target.value)}
                    placeholder="粘贴歌单链接/ID，或搜公开歌单"
                    aria-label="酷狗歌单链接或关键词"
                  />
                  <BridgeGlassButton type="submit" disabled={Boolean(busy) || !playlistInput.trim()}>
                    {busy === 'search-playlist' ? '搜索中' : isDirectLink ? '打开' : '搜歌单'}
                  </BridgeGlassButton>
                </div>
              </form>

              <div className="bridge-playlists">
                {searchPlaylists.length > 0 ? (
                  <section className="bridge-playlist-group">
                    <h3>搜索结果 <span>{searchPlaylists.length}</span></h3>
                    {searchPlaylists.map(playlist => (
                      <button type="button" className="bridge-playlist" key={playlist.id} disabled={Boolean(busy)} onClick={() => inspectPublicPlaylist(playlist.id, playlist.name)}>
                        <Art src={playlist.cover} title={playlist.name} />
                        <span><strong>{playlist.name}</strong><small>{playlist.count || 0} 首{playlist.creator ? ` · ${playlist.creator}` : ''}</small></span>
                        <b>{busy === `playlist:${playlist.id}` ? '打开中' : '挑歌'}</b>
                      </button>
                    ))}
                  </section>
                ) : (
                  <>
                    {localPlaylists.length > 0 && (
                      <section className="bridge-playlist-group bridge-playlist-stack">
                        <h3>本机歌单 <span>{localPlaylists.length}</span></h3>
                        {localPlaylists.map(playlist => (
                          <div className={`bridge-playlist-row ${activePlaylistId === playlist.id ? 'active' : ''}`} key={playlist.id}>
                            <button type="button" className="bridge-playlist" onClick={() => onSwitchPlaylist?.(playlist.id)} title={`切换到「${playlist.name}」`}>
                              <Art src={playlist.cover} title={playlist.name} />
                              <span><strong>{playlist.name}</strong><small>{playlist.count} 首</small></span>
                              <b>{activePlaylistId === playlist.id ? '播放中' : '切换'}</b>
                            </button>
                          </div>
                        ))}
                      </section>
                    )}
                    {accountPlaylists.length > 0 && (
                      <section className="bridge-playlist-group">
                        <h3>酷狗歌单 <span>{accountPlaylists.length}</span></h3>
                        {accountPlaylists.map(playlist => (
                          <button type="button" className="bridge-playlist" key={playlist.id} disabled={Boolean(busy)} onClick={() => inspectAccountPlaylist(playlist.id)}>
                            <Art src={playlist.cover} title={playlist.name} />
                            <span><strong>{playlist.name}</strong>{playlist.count ? <small>{playlist.count} 首</small> : null}</span>
                            <b>{busy === `playlist:${playlist.id}` ? '打开中' : '挑歌'}</b>
                          </button>
                        ))}
                      </section>
                    )}
                    {!clientReady && !localPlaylists.length && (
                      <div className="bridge-empty">扫码登录后，这里会显示「我喜欢」和你的酷狗歌单。</div>
                    )}
                    {clientReady && !accountPlaylists.length && !localPlaylists.length && (
                      <div className="bridge-empty">
                        当前账号暂未返回歌单；也可以在上方粘贴歌单链接/ID，或搜索公开歌单与歌曲。
                        {collectionError ? <span className="bridge-diag">{collectionError}</span> : null}
                      </div>
                    )}
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      <footer className="bridge-foot">
        <span>{importedCount} 首歌曲 · {localPlaylists.length}/{MAX_KUGOU_PLAYLISTS} 个歌单已在本机</span>
        <BridgeGlassButton
          className={`bridge-clear ${confirmClear ? 'armed' : ''}`}
          disabled={!importedCount}
          onClick={() => {
            if (!confirmClear) {
              setConfirmClear(true);
              setNotice('再次点击“确认清空”会删除全部酷狗导入歌曲。');
              return;
            }
            onClear();
            setConfirmClear(false);
            setNotice('酷狗导入曲库已清空。');
          }}
        >
          {confirmClear ? '确认清空' : '清空导入'}
        </BridgeGlassButton>
      </footer>
      {notice && <div className="bridge-error" role="status">{notice}</div>}
    </>
  );
}
