const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('orbitDesktop', {
  isDesktop: true,
  platform: process.platform,
  openQQLogin: () => ipcRenderer.invoke('orbit-open-qq-login'),
  refreshQQLogin: () => ipcRenderer.invoke('orbit-refresh-qq-login'),
  clearQQLogin: () => ipcRenderer.invoke('orbit-clear-qq-login'),
  openNeteaseLogin: () => ipcRenderer.invoke('orbit-open-netease-login'),
  refreshNeteaseLogin: () => ipcRenderer.invoke('orbit-refresh-netease-login'),
  clearNeteaseLogin: () => ipcRenderer.invoke('orbit-clear-netease-login'),
  openKugouLogin: () => ipcRenderer.invoke('orbit-kugou-login'),
  createKugouQr: () => ipcRenderer.invoke('orbit-kugou-qr-create'),
  pollKugouQr: (key, mid) => ipcRenderer.invoke('orbit-kugou-qr-poll', key, mid),
  listKugouPlaylists: () => ipcRenderer.invoke('orbit-kugou-playlists'),
  listKugouSongs: id => ipcRenderer.invoke('orbit-kugou-songs', id),
  openKugouPlayer: (hash, albumId, pageId) => ipcRenderer.invoke('orbit-kugou-play', hash, albumId, pageId),
  stopKugouPlayer: () => ipcRenderer.invoke('orbit-kugou-stop'),
  clearKugouLogin: () => ipcRenderer.invoke('orbit-kugou-logout'),
  onKugouAuth: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('orbit-kugou-auth', listener);
    return () => ipcRenderer.removeListener('orbit-kugou-auth', listener);
  },
  setKeepAwake: enabled => ipcRenderer.invoke('orbit-set-keep-awake', Boolean(enabled)),
  // 远程更新
  appVersion: () => ipcRenderer.invoke('orbit-app-version'),
  checkUpdate: () => ipcRenderer.invoke('orbit-check-update'),
  downloadUpdate: () => ipcRenderer.invoke('orbit-download-update'),
  installUpdate: () => ipcRenderer.invoke('orbit-install-update'),
  onUpdateState: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('orbit-update-state', listener);
    return () => ipcRenderer.removeListener('orbit-update-state', listener);
  },
  onVisualActivity: callback => {
    const listener = (_event, active) => callback(Boolean(active));
    ipcRenderer.on('orbit-visual-activity', listener);
    return () => ipcRenderer.removeListener('orbit-visual-activity', listener);
  },
});

window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.classList.add('desktop-shell-root');
  if (process.platform === 'win32') document.documentElement.classList.add('windows-custom-title');
  document.body.classList.add('desktop-shell');
});
