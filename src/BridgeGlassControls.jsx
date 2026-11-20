import GlassSurface from './GlassSurface.jsx';

export function BridgeGlassButton({ children, className = '', type = 'button', ...props }) {
  return (
    <button {...props} type={type} className={`liquid-control bridge-glass-button ${className}`}>
      <GlassSurface variant="dialog-control" />
      {children}
    </button>
  );
}

export function BridgeGlassInput(props) {
  return (
    <div className="liquid-control bridge-glass-input">
      <GlassSurface variant="dialog-control" />
      <input {...props} />
    </div>
  );
}
