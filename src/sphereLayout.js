const PERSPECTIVE = 1200;
const DEGREES = Math.PI / 180;
const MAX_CARD_YAW = 16;

// Fit the complete rotating surface, including tilted card corners and the
// strongest playback scale, inside the visible music area. Zoom cannot crop it.
export function fitCardSphere({ width, height, cardWidth, cardHeight, top = 12, bottom = height - 12, zoom = 1, mobile = false }) {
  const edge = 12;
  top = Math.max(edge, Math.min(height - edge, top));
  bottom = Math.max(top + 1, Math.min(height - edge, bottom));
  const availableWidth = Math.max(1, width - edge * 2);
  const availableHeight = Math.max(1, bottom - top);
  const maxPlaybackScale = 1.1;
  const sinZ = Math.sin(5 * DEGREES);
  const halfWidth = (cardWidth + cardHeight * sinZ) * maxPlaybackScale / 2;
  const halfHeight = (cardHeight + cardWidth * sinZ) * maxPlaybackScale / 2;
  const scale = Math.min(1,
    availableWidth / (halfWidth * 2 + Math.min(96, availableWidth * .35)),
    availableHeight / (halfHeight * 2 + Math.min(80, availableHeight * .3)));
  const maxDepth = Math.min(PERSPECTIVE / 2, halfWidth * scale * Math.sin(MAX_CARD_YAW * DEGREES));
  const perspective = PERSPECTIVE / (PERSPECTIVE - maxDepth);
  // Pull the bounds back through the worst perspective expansion. This also
  // accounts for the screen-relative displacement of cards at the sphere poles.
  const safeTop = height / 2 + (top - height / 2) / perspective;
  const safeBottom = height / 2 + (bottom - height / 2) / perspective;
  const maxX = Math.max(0, availableWidth / (2 * perspective) - halfWidth * scale);
  const maxY = Math.max(0, (safeBottom - safeTop) / 2 - halfHeight * scale);
  // Keep the original card size and horizontal orbit. Desktop only extends
  // vertically; its cards can continue behind the fixed player overlay.
  const preferredX = Math.max(width * (mobile ? .3 : .32), mobile ? 140 : 300) * zoom;
  const preferredY = (mobile ? Math.max((height - 130) * .3, 140) : maxY) * zoom;
  return { radiusX: Math.min(maxX, preferredX), radiusY: Math.min(maxY, preferredY),
    centerX: width / 2, centerY: (safeTop + safeBottom) / 2, scale,
    halfWidth: halfWidth * scale, halfHeight: halfHeight * scale, perspective, mobile,
    maxDepth, topProjectionRoom: (height / 2 - top) / PERSPECTIVE, verticalZoom: Math.min(zoom, 1) };
}

// Pole cards are smaller than the front card. Use their actual footprint so
// the top/bottom do not reserve the empty margin of a full-size front card.
export function projectCardY(layout, y, cardScale, yaw = MAX_CARD_YAW) {
  if (layout.mobile) return y * layout.radiusY;
  const sizeRatio = Math.min(1, cardScale / (layout.scale * 1.1));
  const pole = Math.sin(Math.max(-1, Math.min(1, y)) * Math.PI / 2);
  let radius = layout.radiusY + layout.halfHeight * (1 - sizeRatio);
  if (pole < 0) {
    // The small, nearly straight-on cards near the upper pole need less
    // perspective clearance than a full-size card at maximum tilt.
    const cardDepth = Math.min(layout.maxDepth, layout.halfWidth * sizeRatio * Math.sin(Math.abs(yaw) * DEGREES));
    radius += Math.max(0, layout.topProjectionRoom) * (layout.maxDepth - cardDepth) * layout.verticalZoom;
  }
  return pole * radius;
}
