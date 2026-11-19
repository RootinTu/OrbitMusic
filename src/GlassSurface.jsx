import { memo, useEffect, useRef, useState } from 'react';
import { registerGlassSurface, resolveGlassVariant } from './glassScene.js';

// The optical layer is rendered once, together with the complete live backdrop.
export default memo(function GlassSurface({ subtle = false, control = false, variant, trackElement, cornerRadius, cornerSmoothing = 0.6 }) {
  const host = useRef(null);
  const [ready, setReady] = useState(false);
  const resolvedVariant = resolveGlassVariant({ variant, subtle, control });
  useEffect(() => registerGlassSurface(host.current, {
    subtle: resolvedVariant === 'subtle',
    control: resolvedVariant === 'control',
    variant: resolvedVariant,
    trackElement, cornerRadius, cornerSmoothing,
  }, setReady), [resolvedVariant, trackElement, cornerRadius, cornerSmoothing]);
  return (
    <span
      ref={host}
      aria-hidden="true"
      data-glass-variant={resolvedVariant}
      className={`orbit-glass-surface is-${resolvedVariant}${ready ? ' is-liquid-dom' : ''}`}
    />
  );
});
