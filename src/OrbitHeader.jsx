import { useCallback, useEffect, useRef, useState } from 'react';
import { tracks } from './tracks.js';
import GlassSurface from './GlassSurface.jsx';
import MusicAccountAvatar from './MusicAccountAvatar.jsx';
import { musicAccountName } from './musicAccounts.js';
import { Icon } from './OrbitIcons.jsx';

// 切歌单是下拉列表：头部横排放不下几个歌单名，而且截图里一排 chips 太挤。
export function PlaylistSwitch({ playlists, activePlaylist, onSwitchPlaylist }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const active = playlists.find(playlist => playlist.id === activePlaylist);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = event => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    const onKey = event => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!playlists.length) return null;
  return (
    <div className="playlist-switch" ref={rootRef}>
      <button className="playlist-toggle glass liquid-control" onClick={() => setOpen(value => !value)} aria-expanded={open} aria-haspopup="listbox" title={active?.name || '选择歌单'}>
        <GlassSurface control />
        <span className="playlist-toggle-label">{active?.name || '选择歌单'}</span>
        <span className="playlist-toggle-count">{active?.count ?? 0} 首</span>
        <svg className={`playlist-chev ${open ? 'open' : ''}`} viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
      </button>
      {open && (
        <div className="playlist-menu glass liquid-panel" role="listbox" aria-label="歌单列表">
          <GlassSurface variant="player" />
          <div className="playlist-menu-content">
            {playlists.map(playlist => (
              <button
                key={playlist.id}
                role="option"
                aria-selected={playlist.id === activePlaylist}
                className={`playlist-option ${playlist.id === activePlaylist ? 'active' : ''}`}
                onClick={() => { setOpen(false); if (playlist.id !== activePlaylist) onSwitchPlaylist(playlist.id); }}
              >
                <span className="playlist-option-main">
                  <strong>{playlist.name}</strong>
                  <small>{playlist.count} 首</small>
                </span>
                {playlist.id === activePlaylist && <b>播放中</b>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// 只在鼠标悬停时露出具体状态，平时界面上就一个小图标，尽量不打扰。
const UPDATE_HINT = {
  checking: '正在检查更新…',
  available: '正在准备更新…',
  downloading: '正在下载更新',
  downloaded: '更新已就绪，点击安装',
};

function UpdateSpin() {
  return (
    <svg className="update-spin" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="none" stroke="#ffffff2e" strokeWidth="2.4" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

function UpdateDownload({ percent }) {
  const radius = 10.4;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - percent / 100);
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <circle cx="12" cy="12" r={radius} fill="none" stroke="#ffffff24" strokeWidth="1.5" />
      <circle
        className="update-ring"
        cx="12" cy="12" r={radius} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
        strokeDasharray={circumference} strokeDashoffset={offset} transform="rotate(-90 12 12)"
      />
      <path d="M12 7v7.2" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="m9 11.4 3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function UpdateReady() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
      <path d="m7.6 12.6 3.1 3.1 5.7-6.1" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function UpdateBadge({ updater }) {
  const { state, supported, install } = updater;
  const [render, setRender] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const phase = state?.phase;
  const percent = Math.min(100, Math.max(0, Number(state?.percent || 0)));
  const [snap, setSnap] = useState(null);

  const pending = phase === 'checking' || phase === 'available';
  const [pendingVisible, setPendingVisible] = useState(false);
  useEffect(() => {
    if (!pending) { setPendingVisible(false); return undefined; }
    const timer = setTimeout(() => setPendingVisible(true), 700);
    return () => clearTimeout(timer);
  }, [pending]);

  const meaningful = Boolean(supported && phase && phase !== 'idle' && phase !== 'error');
  const active = meaningful && (phase === 'downloading' || phase === 'downloaded' || pendingVisible);

  useEffect(() => {
    if (active) {
      setLeaving(false);
      setRender(true);
      setSnap({ phase, percent });
      return undefined;
    }
    if (!render) return undefined;
    setLeaving(true);
    const timer = setTimeout(() => { setRender(false); setLeaving(false); }, 420);
    return () => clearTimeout(timer);
    // 刻意不依赖 render：否则淡出计时器会自我重启
  }, [active, phase, percent]);

  if (!supported || !render || !snap) return null;

  const shown = snap.phase;
  const done = shown === 'downloaded';
  const Tag = done ? 'button' : 'div';

  return (
    <Tag
      className={`update-badge${done ? ' is-ready' : ''}`}
      data-leaving={leaving ? 'true' : undefined}
      role="status"
      aria-live="polite"
      title={UPDATE_HINT[shown] || ''}
      onClick={done ? () => install().catch(() => {}) : undefined}
    >
      {shown === 'downloading' ? <UpdateDownload percent={snap.percent} /> : null}
      {shown === 'downloaded' ? <UpdateReady /> : null}
      {shown === 'checking' || shown === 'available' ? <UpdateSpin /> : null}
    </Tag>
  );
}

export function useUpdater() {
  const api = typeof window !== 'undefined' ? window.orbitDesktop : null;
  const supported = Boolean(api?.isDesktop && api.onUpdateState && api.checkUpdate);
  const [state, setState] = useState(null);
  const [version, setVersion] = useState('');

  useEffect(() => {
    if (!supported) return undefined;
    let alive = true;
    api.appVersion().then(info => { if (alive) setVersion(info?.version || ''); }).catch(() => {});
    const off = api.onUpdateState(next => setState(next));
    return () => { alive = false; off?.(); };
  }, [supported]);

  const check = useCallback(() => (supported ? api.checkUpdate() : Promise.resolve()), [supported]);
  const download = useCallback(() => (supported ? api.downloadUpdate() : Promise.resolve()), [supported]);
  const install = useCallback(() => (supported ? api.installUpdate() : Promise.resolve()), [supported]);
  const dismiss = useCallback(() => setState(null), []);

  return { supported, state, version, check, download, install, dismiss };
}

const PROVIDER_LABELS = {
  qq: 'QQ 音乐',
  netease: '网易云音乐',
  kugou: '酷狗音乐',
};

export function Header({
  journal, onChangeView, onOpenBridge, bridgeOpen, profile, accountProvider, nextAccount,
  onSwitchAccount, playlists, activePlaylist, onSwitchPlaylist, updater,
}) {
  const accountName = profile ? musicAccountName(profile, accountProvider) : '';
  const manageLabel = profile ? '管理音乐账号' : '打开音乐桥';
  const switchLabel = nextAccount ? `切换到${PROVIDER_LABELS[nextAccount] || nextAccount}歌单` : '';
  const dialogProps = { 'aria-haspopup': 'dialog', 'aria-expanded': bridgeOpen, 'aria-controls': 'music-bridge' };
  return (
    <header>
      {window.orbitDesktop?.platform !== 'win32' ? (
        <a className="brand" href="./" aria-label="ORBIT 首页">
          <Icon name="orbit" />ORBIT<span className="brand-note">私人音乐频率</span>
        </a>
      ) : <span className="brand-spacer" aria-hidden="true" />}
      <nav className="glass liquid-control" aria-label="视图切换">
        <GlassSurface control />
        <button className={journal ? '' : 'active'} onClick={() => onChangeView(false)}>音乐宇宙</button>
        <button className={journal ? 'active' : ''} onClick={() => onChangeView(true)}>听觉手记 <span>{tracks.length}</span></button>
      </nav>
      <div className="header-right">
        <PlaylistSwitch playlists={playlists} activePlaylist={activePlaylist} onSwitchPlaylist={onSwitchPlaylist} />
        <div className="edition">
          <div className="bridge-account-controls">
            <button type="button" className="bridge-launch liquid-control" onClick={nextAccount ? onSwitchAccount : onOpenBridge}
              {...(nextAccount ? {} : dialogProps)}
              title={switchLabel || accountName || manageLabel}
              aria-label={accountName ? `${accountName} · ${switchLabel || manageLabel}` : manageLabel}>
              <GlassSurface control />
              {profile && <MusicAccountAvatar profile={profile} />}
              <span className="bridge-launch-label">{accountName || '音乐桥'}</span>
              {nextAccount && <Icon name="account-switch" className="bridge-account-switch-icon" />}
            </button>
            {nextAccount && (
              <button type="button" className="bridge-account-manage liquid-control" onClick={onOpenBridge}
                {...dialogProps} title={manageLabel} aria-label={manageLabel}>
                <GlassSurface control />
                <Icon name="more" />
              </button>
            )}
          </div>
          {updater.supported && <button className="version-chip liquid-control" onClick={updater.check} title="检查更新"><GlassSurface control />{updater.version ? `v${updater.version}` : '更新'}</button>}
        </div>
      </div>
    </header>
  );
}
