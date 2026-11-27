import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ensureLrc, findLrcIndex } from './lyrics.js';
import LrcLine from './LrcLine.jsx';
import { formatTime } from './OrbitIcons.jsx';

const TRANSLATION_PREF_KEY = 'orbit.lyricsTranslation.v1';

function readTranslationPref() {
  try {
    return localStorage.getItem(TRANSLATION_PREF_KEY) !== '0';
  } catch {
    return true;
  }
}

function useMobile() {
  const [mobile, setMobile] = useState(() => window.innerWidth < 600);
  useEffect(() => {
    const onResize = () => setMobile(window.innerWidth < 600);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return mobile;
}

export default function LyricsPanel({ track, trackNumber, currentTime, duration, playing, audioRef, analysisRef, lyricsVersion, onSeek }) {
  const [rows, setRows] = useState([]);
  const [state, setState] = useState('loading');
  const [showTranslation, setShowTranslation] = useState(readTranslationPref);
  const mobile = useMobile();

  useEffect(() => {
    let alive = true;
    setRows([]);
    setState('loading');
    // 复用 App 里的加载结果：播放前已经等过一次，这里通常是命中缓存
    ensureLrc(track.lyrics).then(parsed => {
      if (!alive) return;
      if (parsed?.rows.some(row => row.lines.length)) {
        setRows(parsed.rows);
        setState('ready');
      } else {
        setState('missing');
      }
    }).catch(() => {
      if (!alive) return;
      setState('error');
    });
    return () => { alive = false; };
  }, [track, lyricsVersion]);

  const visibleRows = rows;
  const fallbackIndex = useMemo(() => {
    const engine = analysisRef?.current?.engine;
    const latency = engine && engine.mode !== 'none' ? engine.autoLatency : 0;
    return findLrcIndex(visibleRows, Math.max(0, currentTime - (latency || 0)));
  }, [currentTime, visibleRows, analysisRef]);

  // timeupdate 只有约 4Hz，切换会慢半拍；播放时改为逐帧采样，定位更跟手
  const [liveIndex, setLiveIndex] = useState(null);
  useEffect(() => {
    const audio = audioRef?.current;
    if (!audio || !playing) {
      setLiveIndex(null);
      return undefined;
    }
    let frame = 0;
    const tick = () => {
      const engine = analysisRef?.current?.engine;
      const latency = engine && engine.mode !== 'none' ? engine.autoLatency : 0;
      const time = Math.max(0, (audio.currentTime || 0) - (latency || 0));
      const index = findLrcIndex(visibleRows, time);
      setLiveIndex(previous => (previous === index ? previous : index));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [audioRef, analysisRef, playing, visibleRows]);

  const activeIndex = liveIndex !== null && liveIndex < visibleRows.length ? liveIndex : fallbackIndex;

  const headRef = useRef(null);
  const trackRef = useRef(null);
  const rowRefs = useRef([]);
  const [shift, setShift] = useState(0);
  useLayoutEffect(() => {
    const measure = () => {
      const target = rowRefs.current[activeIndex] || headRef.current;
      const trackEl = trackRef.current;
      const viewport = trackEl?.parentElement;
      if (!target || !trackEl || !viewport) return;
      const center = viewport.clientHeight / 2;
      const raw = center - (target.offsetTop + target.offsetHeight / 2);
      const aligned = activeIndex <= 0 ? 0 : raw;
      const min = Math.min(0, viewport.clientHeight - trackEl.offsetHeight);
      setShift(Math.max(min, Math.min(0, aligned)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (trackRef.current) observer.observe(trackRef.current);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [activeIndex, visibleRows, mobile]);

  const providerName = track.provider === 'qq' ? 'QQ 音乐'
    : track.provider === 'netease' ? '网易云音乐' : track.provider === 'kugou' ? '酷狗音乐' : track.provider === 'local' ? '本地文件' : '本地 LRC';
  const wordSynced = rows.some(row => row.wordLines.some(Boolean));
  const hasTranslations = rows.some(row => row.translations?.length > 0);
  const source = state === 'ready' ? `${providerName} · ${wordSynced ? '逐字歌词' : '逐行歌词'}`
    : state === 'loading' ? '正在载入同步歌词' : state === 'missing' ? '暂无同步歌词' : '同步歌词读取失败';

  const toggleTranslation = event => {
    event.stopPropagation();
    setShowTranslation(previous => {
      const next = !previous;
      try { localStorage.setItem(TRANSLATION_PREF_KEY, next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  };

  return (
    <div className={`intro ${playing ? 'is-playing' : ''}`} id="lyrics-panel" aria-live="polite">
      <span className="eyebrow">{playing ? 'NOW PLAYING' : 'READY TO PLAY'} · TRACK {String(trackNumber).padStart(2, '0')}</span>
      <div className="lyrics-viewport">
        <div className="lyrics-track" ref={trackRef} style={{ transform: `translate3d(0,${shift}px,0)` }}>
          <div className="lyrics-head" ref={headRef}>
            <h1 className="lyrics-title">{track.title}</h1>
          </div>
          {visibleRows.map((row, index) => (
            <div
              className={`lyric-row ${row.meta ? 'meta' : ''} ${index === activeIndex ? 'active' : ''} ${Math.abs(index - activeIndex) === 1 ? 'near' : ''} ${onSeek ? 'seekable' : ''}`}
              key={`${row.time}-${index}`}
              ref={element => { rowRefs.current[index] = element; }}
              role={onSeek ? 'button' : undefined}
              tabIndex={onSeek ? 0 : undefined}
              title={onSeek ? `点击跳转到 ${formatTime(Math.max(0, row.time))}` : undefined}
              onPointerDown={event => { if (onSeek) event.stopPropagation(); }}
              onClick={event => {
                if (!onSeek) return;
                event.stopPropagation();
                onSeek(Math.max(0, row.time));
              }}
              onKeyDown={event => {
                if (!onSeek) return;
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  event.stopPropagation();
                  onSeek(Math.max(0, row.time));
                }
              }}
            >
              {row.lines.map((text, lineIndex) => (
                <LrcLine key={lineIndex} text={text} words={row.wordLines[lineIndex]}
                  active={index === activeIndex} playing={playing} currentTime={currentTime}
                  audioRef={audioRef} analysisRef={analysisRef} />
              ))}
              {showTranslation && row.translations.map((text, lineIndex) => <span className="lyric-translation" key={lineIndex}>{text}</span>)}
            </div>
          ))}
        </div>
      </div>
      <div className="lyrics-meta-bar">
        <span className="lyrics-note">{playing ? `${source} · ${formatTime(currentTime)} / ${formatTime(duration)}` : source}</span>
        {hasTranslations && (
          <button
            type="button"
            className={`lyrics-trans-toggle ${showTranslation ? 'on' : ''}`}
            onPointerDown={event => event.stopPropagation()}
            onClick={toggleTranslation}
            aria-pressed={showTranslation}
            title={showTranslation ? '隐藏译文歌词' : '显示双语译文'}
          >译</button>
        )}
      </div>
    </div>
  );
}
