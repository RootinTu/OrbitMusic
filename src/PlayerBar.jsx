import { useEffect, useRef, useState } from 'react';
import { tracks } from './tracks.js';
import GlassSurface from './GlassSurface.jsx';
import { QQ_QUALITY_OPTIONS } from './qqLibrary.js';
import { OUTPUT_MODES } from './audioOut.js';
import { formatTime, Icon, LiquidArt } from './OrbitIcons.jsx';

export function Journal({ onOpen }) {
  return (
    <section id="journal-view">
      <div className="journal-heading"><span className="eyebrow">NOTES BETWEEN TRACKS</span><h1>声音之外，<br />留下一点什么。</h1><p>{tracks.length} 首完整本地歌曲，音源、歌词与封面逐首对应。</p></div>
      <div id="journal-grid">
        {tracks.map(track => (
          <button className="journal-card" onClick={() => onOpen(track.id)} key={track.id}>
            <LiquidArt src={track.cover} alt={`${track.album} 专辑封面`} className="journal-art" />
            <span>{track.genre} / TRACK {String(track.id + 1).padStart(2, '0')}</span>
            <h2>{track.title}</h2><p>{track.artist} · {track.album}</p>
          </button>
        ))}
      </div>
    </section>
  );
}

export function Player({
  track, current, playing, preparing, currentTime, duration, random, repeat, liked, volume, muted,
  outputPref, outputs, outputMenu, beatOffset, hidden, qqQuality, qualityBusy, onQuality,
  onHiddenChange, onBeatOffset, onOutputToggle, onOutputPick, onPlay, onStep, onSeek,
  onShuffle, onRepeat, onFavorite, onVolume, onMute, onOpen,
}) {
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const [scrub, setScrub] = useState(null);
  const isQQ = track?.provider === 'qq';
  const [qualityOpen, setQualityOpen] = useState(false);
  const qualityOption = QQ_QUALITY_OPTIONS.find(item => item.value === qqQuality);
  const shownTime = scrub ?? Math.min(currentTime, safeDuration || currentTime);
  const progress = safeDuration ? Math.min(shownTime, safeDuration) / safeDuration * 100 : 0;
  const commitScrub = () => {
    if (scrub !== null) {
      onSeek(scrub);
      setScrub(null);
    }
  };
  if (hidden) {
    return (
      <button className="player-reveal glass liquid-control" onClick={() => onHiddenChange(false)} aria-label="展开播放栏" title="展开播放栏">
        <GlassSurface variant="control" />
        <Icon name="chevron" className="reveal-chev" /><small>{playing ? '播放中' : '播放栏'}</small>
      </button>
    );
  }
  return (
    <footer className="player glass refractive-player">
      <GlassSurface variant="player" />
      <div className="now">
        <LiquidArt src={track.cover} alt={`${track.album} 专辑封面`} className="now-art" />
        <div className="now-copy">
          <div className="now-title">{track.title}</div>
          <div className={`now-sub ${preparing ? 'is-preparing' : ''}`}>{preparing ? '正在准备歌词与音源…' : `${track.artist} · ${track.album}`}</div>
        </div>
        <button className={`icon favorite ${liked ? 'liked' : ''}`} onClick={onFavorite} aria-label={liked ? '取消收藏当前歌曲' : '收藏当前歌曲'} aria-pressed={liked}><Icon name="heart" /></button>
      </div>
      <div className="playback">
        <div className="transport">
          <button className="icon secondary" onClick={onShuffle} aria-label="随机播放" aria-pressed={random}><Icon name="shuffle" /></button>
          <button className="icon" onClick={() => onStep(-1)} aria-label="上一首"><Icon name="next" className="flip" /></button>
          <button
            className="icon"
            onClick={onPlay}
            disabled={preparing}
            aria-busy={preparing}
            aria-label={preparing ? '正在准备歌词与音源' : playing ? '暂停' : '播放'}
          >
            <Icon name={playing ? 'pause' : 'play'} />
          </button>
          <button className="icon" onClick={() => onStep(1)} aria-label="下一首"><Icon name="next" /></button>
          <button className="icon secondary" onClick={onRepeat} aria-label="循环播放" aria-pressed={repeat}>↻</button>
        </div>
        <div className="timeline">
          <time>{formatTime(shownTime)}</time>
          <input
            type="range"
            min="0"
            max={safeDuration || 1}
            step="0.1"
            disabled={!safeDuration}
            aria-label="播放进度"
            style={{ '--fill': `${progress}%` }}
            value={scrub ?? shownTime}
            onChange={event => {
              const value = Number(event.target.value);
              if (Number.isFinite(value)) {
                setScrub(value);
                onSeek(value);
              }
            }}
            onPointerUp={commitScrub}
            onTouchEnd={commitScrub}
            onMouseUp={commitScrub}
            onKeyUp={commitScrub}
            onBlur={commitScrub}
          />
          <time>{formatTime(safeDuration)}</time>
        </div>
      </div>
      <div className="player-right">
        <span>TRACK / {String(current + 1).padStart(2, '0')}</span>
        <button className="icon" onClick={onMute} aria-label={muted ? '取消静音' : '静音'} style={{ opacity: muted ? 0.4 : 1 }}><Icon name="vol" /></button>
        <input type="range" min="0" max="1" step=".01" value={volume} aria-label="音量" style={{ '--fill': `${volume * 100}%` }} onChange={event => onVolume(Number(event.target.value))} />
        <div className="output-wrap">
          <button className={`icon output-btn ${outputMenu ? 'on' : ''}`} onClick={onOutputToggle} aria-label="律动与音频输出设置" aria-expanded={outputMenu} title="律动 / 输出"><Icon name="pulse" /></button>
          {outputMenu && (
            <div className="output-menu glass liquid-panel" role="menu">
              <GlassSurface variant="player" />
              <div className="output-menu-content">
                <div className="output-head">音频输出</div>
                {Object.entries(OUTPUT_MODES).map(([mode, info]) => (
                  <button key={mode} className={`output-item ${outputPref.mode === mode ? 'on' : ''}`} role="menuitemradio" aria-checked={outputPref.mode === mode} onClick={() => onOutputPick({ mode })}>
                    <strong>{info.label}</strong>
                    <small>{info.hint}</small>
                  </button>
                ))}
                <div className="output-sep">指定输出设备（律动保持开启）</div>
                <button className={`output-item ${!outputPref.deviceId ? 'on' : ''}`} role="menuitemradio" aria-checked={!outputPref.deviceId} onClick={() => onOutputPick({ deviceId: '' })}>
                  <strong>跟随系统默认</strong>
                  <small>接了外接音箱却很小声时，先试这个</small>
                </button>
                {outputs.map(device => (
                  <button key={device.id} className={`output-item ${outputPref.deviceId === device.id ? 'on' : ''}`} role="menuitemradio" aria-checked={outputPref.deviceId === device.id} onClick={() => onOutputPick({ deviceId: device.id })}>
                    <strong>{device.label}</strong>
                  </button>
                ))}
                {!outputs.length && <div className="output-empty">当前浏览器不支持列出输出设备，可在系统音量里切换默认设备</div>}
                <div className="output-sep">律动同步校准</div>
                <div className="beat-sync">
                  <button onClick={() => onBeatOffset(-0.02)} aria-label="画面提前 20 毫秒">−</button>
                  <strong>{beatOffset === 0 ? '默认' : `${beatOffset > 0 ? '+' : '−'}${Math.round(Math.abs(beatOffset) * 1000)}ms`}</strong>
                  <button onClick={() => onBeatOffset(0.02)} aria-label="画面延后 20 毫秒">+</button>
                </div>
                <div className="output-empty">画面比鼓点早就把 ＋ 点几下；画面慢半拍就点 −。蓝牙耳机通常要补 100~200ms。</div>
              </div>
            </div>
          )}
        </div>
        {isQQ ? (
          <div className="output-wrap">
            <button
              className={`quality-btn ${qualityOpen ? 'on' : ''}`}
              onClick={() => setQualityOpen(value => !value)}
              aria-label="选择 QQ 音乐音质"
              aria-expanded={qualityOpen}
              title="QQ 音质"
            >
              {qualityOption?.short || '音质'}
            </button>
            {qualityOpen && (
              <div className="output-menu quality-menu glass liquid-panel" role="menu">
                <GlassSurface variant="player" />
                <div className="output-menu-content">
                  <div className="output-head">QQ 音质</div>
                  {QQ_QUALITY_OPTIONS.map(option => (
                    <button
                      key={option.value}
                      className={`output-item ${qqQuality === option.value ? 'on' : ''}`}
                      role="menuitemradio"
                      aria-checked={qqQuality === option.value}
                      disabled={qualityBusy}
                      onClick={() => { setQualityOpen(false); onQuality(option.value); }}
                    >
                      <strong>{option.label}</strong>
                      <small>{option.hint}</small>
                    </button>
                  ))}
                  <div className="output-empty">高规格需要对应会员权限，拿不到时会自动降级到可用的一档。</div>
                </div>
              </div>
            )}
          </div>
        ) : null}
        <button className="icon note-icon" onClick={onOpen} aria-label="阅读当前歌曲手记">☷</button>
        <button className="icon collapse-btn" onClick={() => onHiddenChange(true)} aria-label="收起播放栏" title="收起播放栏"><Icon name="chevron" /></button>
      </div>
    </footer>
  );
}

export function DetailDialog({ track, onClose, onPlay }) {
  const dialogRef = useRef(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog.open) dialog.showModal();
    return () => { if (dialog.open) dialog.close(); };
  }, []);
  return (
    <dialog
      ref={dialogRef}
      id="detail"
      onCancel={event => { event.preventDefault(); onClose(); }}
      onClick={event => {
        if (event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
      }}
    >
      <button className="close" onClick={onClose} aria-label="关闭">×</button>
      <LiquidArt src={track.cover} alt={`${track.album} 专辑封面`} className="detail-art" />
      <div className="detail-copy">
        <span className="eyebrow">TRACK {String(track.id + 1).padStart(2, '0')} / {track.genre}</span>
        <h2>{track.title}</h2><p>{track.note}</p>
        <div className="detail-meta"><span>{track.artist}</span><span>·</span><a href={track.sourceUrl} target="_blank" rel="noreferrer">查看歌曲来源 ↗</a></div>
        <button className="listen" onClick={() => onPlay(track.id)}>播放歌曲 <Icon name="play" /></button>
        <small>音源、歌词与封面来自本地 assets 目录</small>
      </div>
    </dialog>
  );
}
