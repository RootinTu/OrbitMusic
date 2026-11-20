// Lyrics are public metadata. Account and playback operations are handled
// in Electron's isolated Kugou session, not by the HTTP bridge.
export function registerKugouMusicExpressRoutes(app) {
  app.get('/api/kugou/lyric', async (req, res) => {
    const hash = typeof req.query.hash === 'string' ? req.query.hash.trim() : '';
    if (!/^[a-f0-9]{32}$/i.test(hash)) return res.status(400).json({ error: '无效的酷狗歌曲编号。' });
    const duration = typeof req.query.duration === 'string' ? req.query.duration : '';
    const parameters = new URLSearchParams({ cmd: '100', hash, timelength: /^\d{1,9}$/.test(duration) ? duration : '0' });
    try {
      const response = await fetch(`https://m.kugou.com/app/i/krc.php?${parameters}`, {
        signal: AbortSignal.timeout(10000), redirect: 'error',
      });
      if (!response.ok) throw new Error('Kugou lyrics unavailable');
      const text = await response.text();
      res.type('text/plain').send(/^\s*\[\d+:\d+/m.test(text) ? text : '');
    } catch {
      if (!res.destroyed) res.status(502).json({ error: '暂时无法加载酷狗歌词。' });
    }
  });
}
