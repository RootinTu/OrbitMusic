import { useEffect, useRef } from 'react';
import { BridgeGlassButton } from './BridgeGlassControls.jsx';
import QQBridge from './QQBridge.jsx';
import NeteaseBridge from './NeteaseBridge.jsx';
import KugouBridge from './KugouBridge.jsx';

const platforms = [
  { id: 'qq', name: 'QQ 音乐' },
  { id: 'netease', name: '网易云音乐' },
  { id: 'kugou', name: '酷狗音乐' },
];

export default function MusicBridge({ open, provider, onProviderChange, browseAccountPlaylists, onClose, qq, netease, kugou }) {
  const dialogRef = useRef(null);
  const tabsRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const previous = document.activeElement;
    dialogRef.current.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, [open]);

  function onDialogKeyDown(event) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
    }
    if (event.key !== 'Tab') return;
    const controls = [...dialogRef.current.querySelectorAll('button:not(:disabled), input:not(:disabled), a[href]')]
      .filter(control => control.tabIndex >= 0 && control.getClientRects().length);
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }

  function onTabKeyDown(event) {
    const current = platforms.findIndex(item => item.id === provider);
    const next = {
      ArrowLeft: (current + platforms.length - 1) % platforms.length,
      ArrowRight: (current + 1) % platforms.length,
      Home: 0,
      End: platforms.length - 1,
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    onProviderChange(platforms[next].id);
    tabsRef.current.children[next].focus();
  }

  return (
    <div className="bridge-backdrop" hidden={!open} onMouseDown={event => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="qq-bridge" ref={dialogRef} id="music-bridge" tabIndex={-1}
        role="dialog" aria-modal="true" aria-labelledby="music-bridge-title" onKeyDown={onDialogKeyDown}>
        <div className="bridge-head">
          <h2 id="music-bridge-title">{({ qq, netease, kugou }[provider]?.account?.profile ? '音乐账号' : '登录')}</h2>
          <div className="bridge-provider-tabs" role="tablist" aria-label="音乐平台" ref={tabsRef} onKeyDown={onTabKeyDown}>
            {platforms.map(({ id, name }) => (
              <BridgeGlassButton key={id} id={`bridge-tab-${id}`} role="tab"
                aria-selected={provider === id} aria-controls={`bridge-panel-${id}`}
                tabIndex={provider === id ? 0 : -1} onClick={() => onProviderChange(id)}>
                {name}
              </BridgeGlassButton>
            ))}
          </div>
          <BridgeGlassButton className="bridge-close" onClick={onClose} aria-label="关闭音乐桥">×</BridgeGlassButton>
        </div>
        <div className="bridge-provider-panel" id="bridge-panel-qq" role="tabpanel"
          aria-labelledby="bridge-tab-qq" hidden={provider !== 'qq'}>
          <QQBridge {...qq} open={open && provider === 'qq'} browseAccountPlaylists={browseAccountPlaylists} />
        </div>
        <div className="bridge-provider-panel netease-bridge" id="bridge-panel-netease" role="tabpanel"
          aria-labelledby="bridge-tab-netease" hidden={provider !== 'netease'}>
          <NeteaseBridge {...netease} open={open && provider === 'netease'} browseAccountPlaylists={browseAccountPlaylists} onClose={onClose} />
        </div>
        <div className="bridge-provider-panel kugou-bridge" id="bridge-panel-kugou" role="tabpanel"
          aria-labelledby="bridge-tab-kugou" hidden={provider !== 'kugou'}>
          <KugouBridge {...kugou} open={open && provider === 'kugou'} />
        </div>
      </section>
    </div>
  );
}
