export function normalizeAppOrigin(appUrl) {
  const parsed = new URL(String(appUrl || ''));
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error(`Invalid app URL: ${appUrl}`);
  }
  return parsed.origin;
}

export function isTrustedMainRendererEvent(event, { mainWebContents, appOrigin } = {}) {
  if (!event || !mainWebContents || mainWebContents.isDestroyed?.()) return false;
  if (event.sender !== mainWebContents) return false;
  const senderFrame = event.senderFrame;
  if (!senderFrame || senderFrame !== mainWebContents.mainFrame) return false;
  const frameUrl = senderFrame.url;
  if (!frameUrl) return false;
  try {
    const parsed = new URL(frameUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return false;
    return parsed.origin === normalizeAppOrigin(appOrigin);
  } catch {
    return false;
  }
}

export function isAllowedMainNavigationUrl(rawUrl, appOrigin) {
  try {
    const parsed = new URL(String(rawUrl || ''));
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return false;
    return parsed.origin === normalizeAppOrigin(appOrigin);
  } catch {
    return false;
  }
}

export function isAllowedExternalWebUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || ''));
    return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

export function isAllowedHostSuffix(rawUrl, suffixes = [], { allowHttp = false } = {}) {
  try {
    const parsed = new URL(String(rawUrl || ''));
    const allowedProtocols = allowHttp ? ['https:', 'http:'] : ['https:'];
    if (!allowedProtocols.includes(parsed.protocol) || parsed.username || parsed.password) return false;
    const hostname = parsed.hostname.toLowerCase();
    return suffixes.some((suffix) => {
      const clean = String(suffix || '').replace(/^\./, '').toLowerCase();
      return Boolean(clean) && (hostname === clean || hostname.endsWith(`.${clean}`));
    });
  } catch {
    return false;
  }
}

export function isAllowedMainWindowPermission(permission, details, appOrigin) {
  const expectedOrigin = normalizeAppOrigin(appOrigin);
  const candidateUrl = details?.requestingUrl || details?.securityOrigin || '';
  if (!candidateUrl) return false;
  try {
    const parsed = new URL(candidateUrl);
    if (parsed.origin !== expectedOrigin) return false;
  } catch {
    return false;
  }
  if (permission === 'fullscreen' || permission === 'speaker-selection') return true;
  // 音频输出设备名称查询（src/audioOut.js requestDeviceLabels）仅需纯音频权限，拒绝摄像头视频权限
  if (permission === 'media') {
    const types = Array.isArray(details?.mediaTypes) ? details.mediaTypes : [];
    return types.length > 0 && types.every(type => type === 'audio');
  }
  return false;
}

export function createTrustedIpcRegistrar({ ipcMain, getMainWebContents, appOrigin, getAppOrigin }) {
  const resolveOrigin = () => normalizeAppOrigin(
    typeof getAppOrigin === 'function' ? getAppOrigin() : appOrigin,
  );
  return function handleTrusted(channel, fn, options = {}) {
    ipcMain.handle(channel, async (event, ...args) => {
      const trusted = isTrustedMainRendererEvent(event, {
        mainWebContents: getMainWebContents(),
        appOrigin: resolveOrigin(),
      });
      if (!trusted) {
        if (typeof options.onUnauthorized === 'function') return options.onUnauthorized(event);
        throw new Error(`Unauthorized IPC sender for channel: ${channel}`);
      }
      if (typeof options.onError === 'function') {
        try {
          return await fn(event, ...args);
        } catch (error) {
          return options.onError(error);
        }
      }
      return fn(event, ...args);
    });
  };
}
