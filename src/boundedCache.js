export function releaseAudioProbe(probe) {
  if (!probe) return;
  try {
    probe.pause?.();
    probe.removeAttribute?.('src');
    if ('src' in probe) probe.src = '';
    probe.load?.();
  } catch { /* ignore media element cleanup error */ }
}

/**
 * 有界音频预加载缓存：仅保留最近 maxEntries 首，淘汰或清空时主动释放底层音频缓冲与网络流。
 */
export function createAudioPrefetcher({
  maxEntries = 3,
  createAudio = () => (typeof Audio === 'function' ? new Audio() : null),
} = {}) {
  const limit = Math.max(1, Number(maxEntries) || 1);
  const probes = new Map();

  function prefetch(src) {
    if (!src) return;
    if (probes.has(src)) {
      const existing = probes.get(src);
      probes.delete(src);
      probes.set(src, existing);
      return;
    }
    while (probes.size >= limit) {
      const oldestSrc = probes.keys().next().value;
      if (oldestSrc === undefined) break;
      const oldestProbe = probes.get(oldestSrc);
      probes.delete(oldestSrc);
      releaseAudioProbe(oldestProbe);
    }
    const probe = createAudio();
    if (!probe) return;
    probe.preload = 'auto';
    probe.src = src;
    probe.load?.();
    probes.set(src, probe);
  }

  function clear() {
    for (const probe of probes.values()) releaseAudioProbe(probe);
    probes.clear();
  }

  return {
    prefetch,
    clear,
    has: src => probes.has(src),
    get size() {
      return probes.size;
    },
  };
}

export function setBoundedMapEntry(map, key, value, maxEntries = 120) {
  const limit = Math.max(1, Number(maxEntries) || 1);
  map.delete(key);
  while (map.size >= limit) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
  map.set(key, value);
}
