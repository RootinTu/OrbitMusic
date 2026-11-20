import { useCallback, useEffect, useRef, useState } from 'react';
import GlassSurface from './GlassSurface.jsx';
import { BridgeGlassButton } from './BridgeGlassControls.jsx';
import { MAX_KUGOU_PLAYLISTS, MAX_KUGOU_TRACKS } from './kugouLibrary.js';

const importErrors = {
  empty: '没有可导入的歌曲',
  duplicate: '这些歌曲已在歌单里',
  'track-limit': `当前歌单最多 ${MAX_KUGOU_TRACKS} 首`,
  'playlist-limit': `酷狗最多保留 ${MAX_KUGOU_PLAYLISTS} 个歌单`,
  storage: '无法保存到本机曲库',
};

export default function KugouBridge({ open, onImport, onClear, importedCount }) {
  const api = window.orbitDesktop;
  const desktop = Boolean(api?.openKugouLogin);
  const [playlists, setPlaylists] = useState(null);
  const [preview, setPreview] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const pending = useRef(null);

  const run = useCallback(async (action, request, onSuccess) => {
    if (pending.current) return;
    const token = {};
    pending.current = token;
    setBusy(action);
    setNotice('');
    try {
      const result = await request();
      if (pending.current !== token) return;
      if (result?.ok) onSuccess(result);
      else if (result?.reason === 'login') {
        setPlaylists(null);
        setPreview(null);
        if (action !== 'refresh') setNotice('请先在酷狗官网登录，再回到这里读取歌单。');
      } else setNotice(result?.message || '酷狗请求未完成');
    } catch {
      if (pending.current === token) setNotice('暂时无法读取酷狗账号，请稍后再试。');
    } finally {
      if (pending.current === token) {
        pending.current = null;
        setBusy('');
      }
    }
  }, []);

  const refresh = useCallback(() => run('refresh', () => api.listKugouPlaylists(), result => setPlaylists(result.playlists)), [api, run]);

  useEffect(() => {
    if (!open || !desktop) return;
    refresh();
    function onFocus() { refresh(); }
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      pending.current = null;
      setBusy('');
      setPlaylists(null);
      setPreview(null);
      setConfirmClear(false);
    };
  }, [desktop, open, refresh]);

  function inspect(id) {
    setPreview(null);
    run('playlist', () => api.listKugouSongs(id), result => {
      setPreview(result);
      setSelected(new Set(result.songs.slice(0, MAX_KUGOU_TRACKS).map(song => song.hash)));
    });
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
    const result = onImport(songs, { id: `account:${preview.id}`, name: preview.name });
    setNotice(result.added ? `已导入 ${result.added} 首到「${result.name}」` : importErrors[result.reason] || '导入失败');
  }

  if (!open) return null;
  return (
    <>
      <div className="bridge-status">
        <GlassSurface variant="dialog-pane" />
        <span className={playlists ? 'bridge-pulse online' : 'bridge-pulse'} />
        <div><strong>{playlists ? '酷狗账号已登录' : '连接酷狗账号'}</strong>
          <small>{!desktop ? '请在 ORBIT 桌面版登录酷狗' : playlists ? '使用账号的网络收藏和官网播放权限' : '在酷狗官网完成登录，ORBIT 不读取你的密码'}</small></div>
        {desktop && (playlists
          ? <BridgeGlassButton disabled={Boolean(busy)} onClick={() => run('logout', () => api.clearKugouLogin(), () => {
            setPlaylists(null);
            setPreview(null);
            setNotice('已退出酷狗账号；此前导入本机的歌单仍保留。');
          })}>退出登录</BridgeGlassButton>
          : <BridgeGlassButton disabled={Boolean(busy)} onClick={() => run('login', () => api.openKugouLogin(), () => {
            setNotice('请在官网点右上角「登录」。完成后关闭官网窗口，或回到这里点「读取歌单」。');
          })}>官网登录</BridgeGlassButton>)}
      </div>
      <div className="bridge-grid">
        <div className="bridge-pane">
          <GlassSurface variant="dialog-pane" />
          <div className="bridge-pane-title"><span className="bridge-label">我的网络收藏</span>
            {desktop && <BridgeGlassButton disabled={Boolean(busy)} onClick={refresh}>
              {busy === 'refresh' ? '读取中…' : '读取歌单'}
            </BridgeGlassButton>}</div>
          <div className="bridge-playlists">
            {playlists?.map(playlist => (
              <button type="button" className="bridge-playlist" key={playlist.id} disabled={Boolean(busy)} onClick={() => inspect(playlist.id)}>
                <span className="bridge-art-fallback">♫</span><span><strong>{playlist.name}</strong></span><b>查看</b>
              </button>
            ))}
            {!playlists?.length && <div className="bridge-empty">{playlists ? '酷狗没有返回网络收藏歌单。' : '登录后在这里读取账号歌单。'}</div>}
          </div>
        </div>
        <div className="bridge-pane bridge-library">
          <GlassSurface variant="dialog-pane" />
          <span className="bridge-label">歌单预览</span>
          {!preview && <div className="bridge-empty">选择一个账号歌单查看歌曲。播放由酷狗官方窗口接管。</div>}
          {preview && <>
            <div className="bridge-preview-head"><span>
              <strong>{preview.name}</strong><small>已选 {selected.size} / {MAX_KUGOU_TRACKS} · 共 {preview.songs.length} 首</small>
            </span></div>
            <div className="bridge-preview-list">
              {preview.songs.map(song => <label className={`bridge-preview-row ${selected.has(song.hash) ? 'checked' : ''}`} key={song.hash}>
                <input type="checkbox" checked={selected.has(song.hash)} disabled={!selected.has(song.hash) && selected.size >= MAX_KUGOU_TRACKS}
                  onChange={() => toggle(song.hash)} /><b>{song.name}</b><small>{song.artist}</small>
              </label>)}
            </div>
            <BridgeGlassButton className="bridge-preview-import" disabled={!selected.size || Boolean(busy)} onClick={importPreview}>
              导入 {selected.size} 首到音乐宇宙
            </BridgeGlassButton>
          </>}
        </div>
      </div>
      <div className="bridge-foot">
        <span>每个歌单最多 {MAX_KUGOU_TRACKS} 首 · 本机酷狗曲库 {importedCount} 首</span>
        {importedCount > 0 && <BridgeGlassButton className="bridge-clear" onClick={() => {
          if (!confirmClear) { setConfirmClear(true); return; }
          onClear();
          setConfirmClear(false);
          setNotice('');
        }}>{confirmClear ? '确认清空本机酷狗曲库' : '清空本机酷狗曲库'}</BridgeGlassButton>}
      </div>
      {notice && <div className="bridge-error" role="status">{notice}</div>}
    </>
  );
}
