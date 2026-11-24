import { useLayoutEffect, useRef, useState } from 'react';

export function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '0:00';
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

export function SvgDefs() {
  return (
    <svg className="svgdefs" aria-hidden="true">
      <defs>
        <symbol id="i-play" viewBox="0 0 24 24"><path d="m9 5 11 7-11 7Z" fill="currentColor" stroke="none" /></symbol>
        <symbol id="i-pause" viewBox="0 0 24 24"><path d="M8 5v14M16 5v14" strokeWidth="4" /></symbol>
        <symbol id="i-next" viewBox="0 0 24 24"><path d="m5 5 10 7-10 7Z" fill="currentColor" stroke="none" /><path d="M18 5v14" strokeWidth="2" /></symbol>
        <symbol id="i-vol" viewBox="0 0 24 24"><path d="m11 5-5 4H3v6h3l5 4Z" /><path d="M15 8q5 4 0 8m3-11q8 7 0 14" /></symbol>
        <symbol id="i-heart" viewBox="0 0 24 24"><path d="M20.5 5.5C17 2 12 6 12 6S7 2 3.5 5.5C-1 10 12 20 12 20S25 10 20.5 5.5Z" /></symbol>
        <symbol id="i-speaker" viewBox="0 0 24 24"><path d="M4 9h4l4-3v12l-4-3H4Z" fill="currentColor" stroke="none" /><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 6a9 9 0 0 1 0 12" /></symbol>
        <symbol id="i-orbit" viewBox="0 0 40 40"><ellipse cx="20" cy="20" rx="18" ry="8" transform="rotate(-35 20 20)" /><circle cx="20" cy="20" r="5" fill="currentColor" stroke="none" /></symbol>
        <symbol id="i-shuffle" viewBox="0 0 24 24"><path d="M3 6h3c5 0 7 12 12 12h3m-4-4 4 4-4 4M3 18h3c2 0 4-3 5-5m3-4c1-2 2-3 4-3h3m-4-4 4 4-4 4" /></symbol>
        <symbol id="i-chevron" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6" strokeWidth="2" /></symbol>
        <symbol id="i-account-switch" viewBox="0 0 24 24"><path d="M4 8h15m-4-4 4 4-4 4M20 16H5m4-4-4 4 4 4" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></symbol>
        <symbol id="i-more" viewBox="0 0 24 24"><path d="M5 12h.01M12 12h.01M19 12h.01" strokeWidth="3" strokeLinecap="round" /></symbol>
        <symbol id="i-pulse" viewBox="0 0 24 24"><path d="M4 10v4M8 6.5v11M12 3.5v17M16 8v8M20 11v2" strokeWidth="2" strokeLinecap="round" /></symbol>
      </defs>
    </svg>
  );
}

export function Icon({ name, className = '' }) {
  return <svg className={className}><use href={`#i-${name}`} /></svg>;
}

export function LiquidArt({ src, alt = '', className = '' }) {
  // 空地址必须整体不渲染 img：<img src=""> 会让浏览器把当前页面再请求一遍，
  // 控制台刷屏不说，还会平白吃掉一次文档请求。没有封面就只留 .liquid-art 的底色。
  const hasArt = Boolean(src);
  return (
    <span className={`liquid-art ${className}`}>
      {hasArt && <img className="art-blur" src={src} alt="" aria-hidden="true" draggable="false" />}
      {hasArt && <img className="art-image" src={src} alt={alt} draggable="false" />}
    </span>
  );
}

export function CardArtistTicker({ artist }) {
  const containerRef = useRef(null);
  const textRef = useRef(null);
  const [scrolling, setScrolling] = useState(false);

  useLayoutEffect(() => {
    const measure = () => {
      const container = containerRef.current;
      const text = textRef.current;
      if (!container || !text) return;
      setScrolling(text.scrollWidth > container.clientWidth + 1);
    };
    measure();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    if (containerRef.current) observer?.observe(containerRef.current);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [artist]);

  return (
    <small ref={containerRef} className={scrolling ? 'is-scrolling' : ''} title={artist}>
      <span className="artist-ticker">
        <span ref={textRef}>{artist}</span>
        {scrolling ? <span aria-hidden="true">{artist}</span> : null}
      </span>
    </small>
  );
}
