import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BridgeGlassButton, BridgeGlassInput } from './BridgeGlassControls.jsx';
import MusicAccountAvatar from './MusicAccountAvatar.jsx';
import { createAsyncSlot, isAbortError } from './asyncSlot.js';
import { musicAccountName } from './musicAccounts.js';
import { MAX_NETEASE_IMPORTS } from './neteaseLibrary.js';

async function requestJson(url, options) {
  const response = await fetch(url, { cache: 'no-store', ...options });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || payload.error || `请求失败（${response.status}）`);
  return payload;
}

function Art({ src, title }) {
  return src ? <img src={src} alt={`${title} 封面`} draggable="false" /> : <span className="bridge-art-fallback">♫</span>;
}

export default function NeteaseBridge({ open, account, browseAccountPlaylists, onClose, onImport, onClear, importedCount }) {
  const { profile, refresh, update } = account;
  const [playlists, setPlaylists] = useState([]);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [preview, setPreview] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const playlistsSlotRef = useRef(null);
  const searchSlotRef = useRef(null);
  const previewSlotRef = useRef(null);
  if (!playlistsSlotRef.current) playlistsSlotRef.current = createAsyncSlot();
  if (!searchSlotRef.current) searchSlotRef.current = createAsyncSlot();
  if (!previewSlotRef.current) previewSlotRef.current = createAsyncSlot();
  const desktop = Boolean(window.orbitDesktop?.isDesktop);
  const selectedSongs = useMemo(() => preview?.songs?.filter(song => selected.has(song.id)) || [], [preview, selected]);

  const cancelPendingRequests = useCallback(() => {
    playlistsSlotRef.current.cancel();
    searchSlotRef.current.cancel();
    previewSlotRef.current.cancel();
  }, []);

  const loadPlaylists = useCallback(async () => {
    const task = playlistsSlotRef.current.start();
    setBusy('playlists');
    try {
      const payload = await requestJson('/api/netease/user/playlists', { signal: task.signal });
      if (!task.isCurrent()) return;
      setPlaylists(payload.playlists || []);
    } catch (reason) {
      if (!task.isCurrent() || isAbortError(reason)) return;
      setError(reason.message);
    } finally {
      if (task.finish()) setBusy(current => (current === 'playlists' ? '' : current));
    }
  }, []);

  useEffect(() => {
    if (!open) {
      cancelPendingRequests();
      setBusy('');
      return undefined;
    }
    setError('');
    if (browseAccountPlaylists) {
      previewSlotRef.current.cancel();
      setPreview(null);
      setSelected(new Set());
    }
    const controller = new AbortController();
    refresh(controller.signal).then(next => { if (next?.loggedIn && !controller.signal.aborted) loadPlaylists(); });
    return () => {
      controller.abort();
      cancelPendingRequests();
    };
  }, [browseAccountPlaylists, cancelPendingRequests, loadPlaylists, open, refresh]);

  const login = async () => {
    if (!desktop) return setError('扫码登录仅在 ORBIT 桌面应用中开放。');
    setBusy('login'); setError('');
    try {
      const result = await window.orbitDesktop.openNeteaseLogin();
      if (!result?.ok) throw new Error(result?.message || result?.error || '扫码登录未完成');
      if (result.profile) update(result.profile);
      else await refresh();
      await loadPlaylists();
    } catch (reason) { setError(reason.message); }
    finally { setBusy(current => (current === 'login' ? '' : current)); }
  };

  const logout = async () => {
    cancelPendingRequests();
    setBusy('logout'); setError('');
    try {
      if (desktop) await window.orbitDesktop.clearNeteaseLogin();
      else await requestJson('/api/netease/logout', { method: 'POST' });
      update(null); setPlaylists([]); setPreview(null); setSelected(new Set());
    } catch (reason) { setError(reason.message); }
    finally { setBusy(current => (current === 'logout' ? '' : current)); }
  };

  const search = async event => {
    event.preventDefault();
    const clean = query.trim();
    if (!clean) return;
    const task = searchSlotRef.current.start();
    setBusy('search'); setError('');
    try {
      const payload = await requestJson(`/api/netease/search?keywords=${encodeURIComponent(clean)}&limit=20`, { signal: task.signal });
      if (!task.isCurrent()) return;
      setResults(payload.songs || []);
    } catch (reason) {
      if (!task.isCurrent() || isAbortError(reason)) return;
      setError(reason.message);
    } finally {
      if (task.finish()) setBusy(current => (current === 'search' ? '' : current));
    }
  };

  const openPlaylist = async playlist => {
    const busyKey = `playlist:${playlist.id}`;
    const task = previewSlotRef.current.start();
    setBusy(busyKey); setError('');
    try {
      const payload = await requestJson(`/api/netease/playlist/tracks?id=${encodeURIComponent(playlist.id)}&limit=all`, { signal: task.signal });
      if (!task.isCurrent()) return;
      const songs = payload.songs || [];
      setPreview({ ...playlist, ...(payload.playlist || {}), songs });
      setSelected(new Set(songs.slice(0, MAX_NETEASE_IMPORTS).map(song => song.id)));
    } catch (reason) {
      if (!task.isCurrent() || isAbortError(reason)) return;
      setError(reason.message);
    } finally {
      if (task.finish()) setBusy(current => (current === busyKey ? '' : current));
    }
  };

  const closePreview = () => {
    previewSlotRef.current.cancel();
    setBusy(current => (current.startsWith('playlist:') ? '' : current));
    setPreview(null);
    setSelected(new Set());
  };

  const toggle = id => setSelected(previous => {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id);
    else if (next.size < MAX_NETEASE_IMPORTS) next.add(id);
    return next;
  });

  const importPreview = () => {
    const count = onImport(selectedSongs, { id: preview.id, name: preview.name, cover: preview.cover, replace: true });
    if (!count) setError('没有可导入的新歌曲。');
    else onClose();
  };

  if (!open) return null;
  return (
      <>
        <div className="bridge-status">
          {profile ? <MusicAccountAvatar profile={profile} /> : <span className="bridge-pulse" />}
          <div><strong title={profile ? musicAccountName(profile, 'netease') : undefined}>{profile ? musicAccountName(profile, 'netease') : '等待扫码登录'}</strong><small>{profile ? '已登录网易云音乐' : '扫码后可读取账号歌单'}</small></div>
          <BridgeGlassButton onClick={profile ? logout : login} disabled={Boolean(busy)}>{busy === 'login' ? '等待扫码…' : profile ? '退出登录' : '扫码登录'}</BridgeGlassButton>
        </div>
        <div className="bridge-grid">
          <div className="bridge-pane">
            <span className="bridge-label">搜索网易云</span>
            <form className="bridge-input-row" onSubmit={search}>
              <BridgeGlassInput value={query} onChange={event => setQuery(event.target.value)} placeholder="歌曲 / 歌手 / 专辑" aria-label="搜索网易云音乐" />
              <BridgeGlassButton type="submit" disabled={busy === 'search'}>{busy === 'search' ? '搜索中' : '搜索'}</BridgeGlassButton>
            </form>
            <div className="bridge-results">
              {results.map(song => <div className="bridge-song" key={song.id}>
                <Art src={song.cover} title={song.name} />
                <div><strong>{song.name}</strong><small>{song.artist} · {song.album}</small></div>
                <button onClick={() => { const count = onImport([song], { name: '网易云零散导入' }); if (!count) setError('这首歌已经导入或曲库已满。'); }}>＋</button>
              </div>)}
              {!results.length && <div className="bridge-empty">扫码后可读取账号歌单；也可以直接搜索歌曲。</div>}
            </div>
          </div>
          <div className="bridge-pane bridge-library">
            {preview ? <>
              <div className="bridge-preview-head"><BridgeGlassButton className="bridge-preview-back" onClick={closePreview} aria-label="返回歌单列表">←</BridgeGlassButton><span><strong>{preview.name}</strong><small>已选 {selected.size} / {MAX_NETEASE_IMPORTS} · 共 {preview.songs.length} 首</small></span></div>
              <div className="bridge-preview-actions"><span>选择要放进音乐宇宙的歌曲</span><BridgeGlassButton onClick={() => setSelected(new Set(preview.songs.slice(0, MAX_NETEASE_IMPORTS).map(song => song.id)))}>前 {MAX_NETEASE_IMPORTS} 首</BridgeGlassButton><BridgeGlassButton onClick={() => setSelected(new Set())}>清空</BridgeGlassButton></div>
              <div className="bridge-preview-list">{preview.songs.map(song => <label className={`bridge-preview-row ${selected.has(song.id) ? 'checked' : ''}`} key={song.id}><input type="checkbox" checked={selected.has(song.id)} onChange={() => toggle(song.id)} /><b>{song.name}</b><small>{song.artist} · {song.album}</small></label>)}</div>
              <BridgeGlassButton className="bridge-preview-import" disabled={!selected.size} onClick={importPreview}>导入 {selected.size} 首到音乐宇宙</BridgeGlassButton>
            </> : <>
              <div className="bridge-pane-title"><span className="bridge-label">我的歌单</span><small>{profile ? `${playlists.length} 个歌单` : '扫码后读取'}</small></div>
              <div className="bridge-playlists">{playlists.map(playlist => <button className="bridge-playlist" key={playlist.id} onClick={() => openPlaylist(playlist)} disabled={Boolean(busy)}><Art src={playlist.cover} title={playlist.name} /><span><strong>{playlist.name}</strong><small>{playlist.trackCount} 首{playlist.subscribed ? ' · 收藏' : ''}</small></span><b>{busy === `playlist:${playlist.id}` ? '读取中' : '打开'}</b></button>)}{!playlists.length && <div className="bridge-empty">完成扫码后，这里会显示账号中的歌单和「我喜欢的音乐」。</div>}</div>
            </>}
          </div>
        </div>
        <div className="bridge-foot"><span>每个歌单最多 {MAX_NETEASE_IMPORTS} 首 · 不保存账号密码</span><span>本机歌单共 {importedCount} 首</span>{importedCount > 0 && <BridgeGlassButton className="bridge-clear" onClick={onClear}>清空网易云曲库</BridgeGlassButton>}</div>
        {error && <div className="bridge-error">{error}</div>}
      </>
  );
}
