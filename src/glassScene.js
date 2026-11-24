// One registry shared by the full-scene renderer and the DOM control surfaces.
const surfaces = new Set();
const subscribers = new Set();
const variants = new Set(['player', 'control', 'subtle']);

export function resolveGlassVariant({ variant, subtle, control } = {}) {
  return variants.has(variant) ? variant : subtle ? 'subtle' : control ? 'control' : 'player';
}

function invalidateLayout() {
  for (const entry of surfaces) entry.dirty = true;
  for (const notify of subscribers) notify();
}

function observeViewport(add) {
  const method = add ? 'addEventListener' : 'removeEventListener';
  window[method]('resize', invalidateLayout);
  window[method]('scroll', invalidateLayout, true);
  window.visualViewport?.[method]('resize', invalidateLayout);
  window.visualViewport?.[method]('scroll', invalidateLayout);
}

export function registerGlassSurface(element, options, onReady) {
  if (!element) return () => {};
  // Track the outer panel, not its inset span: scrolling menu contents must not
  // move the optical surface, and the border box is the actual rounded contour.
  const target = options.trackElement?.current || options.trackElement || element.parentElement || element;
  const entry = { element, target, options: { ...options, variant: resolveGlassVariant(options) }, onReady, dirty: true, ready: false };
  const resize = new ResizeObserver(invalidateLayout);
  resize.observe(target);
  const mutation = new MutationObserver(invalidateLayout);
  mutation.observe(target, { attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
  if (!surfaces.size) observeViewport(true);
  surfaces.add(entry);
  onReady(false);
  for (const notify of subscribers) notify();
  return () => {
    resize.disconnect();
    mutation.disconnect();
    surfaces.delete(entry);
    if (!surfaces.size) observeViewport(false);
    for (const notify of subscribers) notify();
  };
}

export function getGlassSurfaceLayout(entry) {
  const { target, options } = entry;
  if (!target.isConnected) return null;
  const rect = target.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0 || rect.right <= 0 || rect.bottom <= 0
    || rect.left >= innerWidth || rect.top >= innerHeight) return null;
  if (target.checkVisibility && !target.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return null;
  if (entry.dirty) {
    entry.radius = getComputedStyle(target).borderTopLeftRadius;
    entry.dirty = false;
  }
  const limit = Math.min(rect.width, rect.height) / 2;
  const cssRadius = parseFloat(entry.radius) || 0;
  const capsule = options.variant === 'control';
  const radius = options.cornerRadius ?? (capsule ? limit
    : entry.radius?.includes('%') ? cssRadius * Math.min(rect.width, rect.height) / 100 : cssRadius);
  return {
    x: rect.x, y: rect.y, width: rect.width, height: rect.height,
    cornerRadius: Math.max(0, Math.min(limit, radius)),
    cornerSmoothing: options.cornerSmoothing ?? 0.6,
  };
}
export function getGlassSurfaces() { return surfaces; }
export function observeGlassSurfaces(notify) {
  subscribers.add(notify);
  return () => subscribers.delete(notify);
}
export function setGlassSurfaceReady(entry, ready) {
  if (!surfaces.has(entry) || entry.ready === ready) return;
  entry.ready = ready;
  entry.onReady(ready);
}
