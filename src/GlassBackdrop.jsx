import { useEffect, useRef } from 'react';
import { getGlassSurfaceLayout, getGlassSurfaces, observeGlassSurfaces, setGlassSceneActive } from './glassScene.js';
import { createGlassPresentation } from './glassPresentation.js';

/** Upstream's HTML-in-Canvas path: the live scene, not a canvas-only reconstruction. */
export default function GlassBackdrop({ children, soundfield }) {
  const mountRef = useRef(null);
  const contentRef = useRef(null);
  useEffect(() => {
    const mount = mountRef.current, content = contentRef.current;
    const root = document.documentElement;
    const media = matchMedia('(min-width: 901px)');
    const transparency = matchMedia('(prefers-reduced-transparency: reduce)');
    let disposed = false, generation = 0, release = () => {};
    const start = async () => {
      const token = ++generation;
      release(); release = () => {};
      setGlassSceneActive(false);
      const supported = navigator.gpu && globalThis.GPUQueue?.prototype?.copyElementImageToTexture
        && HTMLCanvasElement.prototype.requestPaint;
      root.dataset.glassRenderer = supported ? 'initializing' : 'css-fallback';
      if (!media.matches || transparency.matches || !supported) {
        root.dataset.glassRenderer = 'css-fallback';
        return;
      }
      let device, core, source, canvas, frame, unsubscribe, presentation;
      let lastBackdropCanvas, backdropOpacity = 0;
      const layouts = [];
      let failed = false, active = false, inFlight = false;
      const nodes = new Map();
      const cleanup = () => {
        cancelAnimationFrame(frame);
        unsubscribe?.();
        // Restore React's source node before the content source removes its hosts.
        if (content.parentNode !== mount) mount.append(content);
        content.classList.remove('is-canvas-content');
        mount.classList.remove('is-full-dom');
        setGlassSceneActive(false);
        presentation?.destroy(); source?.destroy(); core?.destroy(); canvas?.remove(); device?.destroy();
      };
      const fail = error => {
        if (failed || disposed || token !== generation) return;
        failed = true;
        cleanup(); release = () => {};
        root.dataset.glassRenderer = 'css-fallback';
        console.warn('Full DOM glass unavailable:', error);
      };
      try {
        const { Scene, Html, Glass, Container, WebGpuGlassCore, WebGpuDomContentSource } = await import('@liquid-dom/core');
        const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'low-power' });
        if (disposed || token !== generation) return;
        if (!adapter) throw new Error('No WebGPU adapter available');
        device = await adapter.requestDevice();
        if (disposed || token !== generation) { device.destroy(); return; }
        release = cleanup;
        canvas = document.createElement('canvas');
        canvas.className = 'full-dom-glass-canvas';
        canvas.dataset.source = 'complete-live-dom';
        mount.append(canvas);
        mount.classList.add('is-full-dom');
        content.classList.add('is-canvas-content');
        const context = canvas.getContext('webgpu');
        if (!context) throw new Error('WebGPU context unavailable');
        const format = navigator.gpu.getPreferredCanvasFormat();
        if (soundfield) presentation = createGlassPresentation(device, format);
        const scene = new Scene();
        const background = new Html({ element: content, width: innerWidth, height: innerHeight, zIndex: -100 });
        scene.add(background);
        core = new WebGpuGlassCore({ device, format });
        let dpr = 1, width = 0, height = 0;
        source = new WebGpuDomContentSource({ targetCanvas: canvas, scene, getCurrentDpr: () => dpr });
        source.setDevice(device, format);
        const CONTAINER_PRESETS = {
          player: {
            zIndex: 1,
            spacing: 0,
            blur: 5,
            bezelWidth: 16,
            thickness: 68,
            displacementFactor: 0.96,
            displacementBlur: 4,
            dispersion: 0.24,
            // Keep tint alpha low so underlying album cards and terrain remain crystal-clear and transparent.
            ior: 1.56,
            tint: { r: 0.92, g: 0.96, b: 1, a: 0.028 },
            specularOpacity: 0.92,
            specularStrength: 1.35,
            specularWidth: 1.6,
            specularSharpness: 3.4,
            oppositeSpecularStrength: 0.85,
            reflectionOffset: 22,
            shadowColor: { r: 0, g: 0, b: 0, a: 0.2 },
            shadowOffsetY: 12,
            shadowBlur: 28,
          },
          control: {
            zIndex: 2,
            spacing: 0,
            blur: 4,
            bezelWidth: 11,
            thickness: 44,
            displacementFactor: 0.92,
            displacementBlur: 3.5,
            dispersion: 0.16,
            ior: 1.54,
            tint: { r: 0.94, g: 0.97, b: 1, a: 0.025 },
            specularOpacity: 0.92,
            specularStrength: 1.3,
            specularWidth: 1.15,
            specularSharpness: 4.5,
            oppositeSpecularStrength: 0.8,
            reflectionOffset: 16,
            shadowColor: { r: 0, g: 0, b: 0, a: 0.15 },
            shadowOffsetY: 7,
            shadowBlur: 18,
          },
          subtle: {
            zIndex: 3,
            spacing: 0,
            blur: 3,
            bezelWidth: 6,
            thickness: 28,
            displacementFactor: 0.72,
            displacementBlur: 2.5,
            dispersion: 0.05,
            ior: 1.48,
            tint: { r: 0.92, g: 0.96, b: 1, a: 0.02 },
            specularOpacity: 0.55,
            specularStrength: 0.9,
            specularWidth: 'hairline',
            specularSharpness: 3.5,
            oppositeSpecularStrength: 0.4,
            reflectionOffset: 12,
            shadowColor: { r: 0, g: 0, b: 0, a: 0.08 },
            shadowOffsetY: 4,
            shadowBlur: 12,
          },
        };
        const containers = Object.fromEntries(
          Object.entries(CONTAINER_PRESETS).map(([key, preset]) => {
            const container = new Container(preset);
            scene.add(container);
            return [key, container];
          }),
        );
        const syncSurfaces = () => {
          const entries = getGlassSurfaces();
          for (const [entry, glass] of nodes) {
            if (!entries.has(entry)) { glass.remove(); nodes.delete(entry); }
          }
        };
        unsubscribe = observeGlassSurfaces(syncSurfaces);
        syncSurfaces();
        device.addEventListener('uncapturederror', event => fail(event.error));
        device.lost.then(info => fail(info.message));
        const started = performance.now();
        const tick = time => {
          if (failed || disposed || token !== generation) return;
          frame = requestAnimationFrame(tick);
          // Do not queue whole-scene frames faster than the GPU can present them.
          // Otherwise old covers/text can remain on screen behind a long GPU queue.
          if (document.hidden || inFlight) return;
          inFlight = true;
          try {
            const nextDpr = Math.min(devicePixelRatio || 1, 1.5);
            const w = Math.max(1, Math.round(innerWidth * nextDpr));
            const h = Math.max(1, Math.round(innerHeight * nextDpr));
            if (width !== w || height !== h || dpr !== nextDpr) {
              dpr = nextDpr; width = canvas.width = w; height = canvas.height = h;
              context.configure({ device, format, alphaMode: presentation ? 'premultiplied' : 'opaque' });
              presentation?.resize(w, h);
              background.width = innerWidth; background.height = innerHeight;
            }
            layouts.length = 0;
            for (const entry of getGlassSurfaces()) {
              const layout = getGlassSurfaceLayout(entry);
              let glass = nodes.get(entry);
              if (!layout) {
                // A hidden/collapsed control must leave the SDF entirely. A
                // zero-size shape can still affect nearby fusion and highlights.
                if (glass) { glass.remove(); nodes.delete(entry); }
                continue;
              }
              layouts.push(layout);
              if (!glass) {
                glass = new Glass({ ...layout, pointerEvents: false });
                containers[entry.options.variant].add(glass);
                nodes.set(entry, glass);
              } else {
                for (const [key, value] of Object.entries(layout)) {
                  if (glass[key] !== value) glass[key] = value;
                }
              }
            }
            // Request a fresh snapshot of the cards and lyrics. The independent
            // soundfield is sampled separately for the glass panes.
            canvas.requestPaint();
            const layers = source.sync();
            const snapshot = source.getSceneHtmlEntry(background);
            const frameOptions = { layers, width, height, dpr, contentSource: source };
            if (presentation && snapshot?.copiedDeviceWidth > 0) {
              const terrain = soundfield.glCanvasRef.current;
              const backdrop = terrain?.style.display === 'block' ? terrain : soundfield.canvasRef.current;
              if (backdrop !== lastBackdropCanvas) {
                backdropOpacity = backdrop ? Number(getComputedStyle(backdrop).opacity) : 0;
                lastBackdropCanvas = backdrop;
              }
              core.render({ ...frameOptions, ...presentation.prepare(backdrop, backdropOpacity) });
              presentation.present(snapshot, context.getCurrentTexture(), layouts, dpr);
            } else if (!presentation) {
              core.render({ ...frameOptions, outputTexture: context.getCurrentTexture() });
            }
            device.queue.onSubmittedWorkDone().then(() => { inFlight = false; }, fail);
            if (!active && snapshot?.copiedDeviceWidth > 0) {
              active = true; root.dataset.glassRenderer = 'full-dom';
              setGlassSceneActive(true);
            }
            if (!active && time - started > 4000) {
              throw new Error('HTML-in-Canvas did not produce a complete backdrop texture');
            }
          } catch (error) { fail(error); }
        };
        frame = requestAnimationFrame(tick);
      } catch (error) { fail(error); }
    };
    media.addEventListener('change', start);
    transparency.addEventListener('change', start);
    start();
    return () => {
      disposed = true; generation++;
      media.removeEventListener('change', start);
      transparency.removeEventListener('change', start);
      release();
      delete document.documentElement.dataset.glassRenderer;
    };
  }, [soundfield]);
  return <div className="glass-backdrop-mount" ref={mountRef}>
    <div className={`glass-scene-content${soundfield ? ' has-native-backdrop' : ''}`} ref={contentRef}>{children}</div>
  </div>;
}
