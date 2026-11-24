export function BridgeGlassButton({ children, className = '', type = 'button', ...props }) {
  return (
    <button {...props} type={type} className={`bridge-glass-button ${className}`}>
      {children}
    </button>
  );
}

export function BridgeGlassInput(props) {
  return (
    <div className="bridge-glass-input">
      <input {...props} />
    </div>
  );
}
