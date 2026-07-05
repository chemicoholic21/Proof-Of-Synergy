"use client";

import { useEffect, useRef } from "react";

/**
 * Animated film grain (React Bits "Noise" style), monochrome and GPU-cheap: we regenerate a small
 * noise tile each frame and paint it once across the viewport, throttled to ~24fps for that analog
 * cinema flicker. Fixed, pointer-events-none, very low opacity - a texture you feel more than see.
 */
export default function GrainOverlay({ opacity = 0.055, fps = 24 }: { opacity?: number; fps?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    const TILE = 128;
    const tile = document.createElement("canvas");
    tile.width = tile.height = TILE;
    const tctx = tile.getContext("2d")!;
    const image = tctx.createImageData(TILE, TILE);

    let w = 0;
    let h = 0;
    const resize = () => {
      w = canvas.width = Math.ceil(window.innerWidth);
      h = canvas.height = Math.ceil(window.innerHeight);
    };
    resize();
    window.addEventListener("resize", resize);

    let raf = 0;
    let timer: ReturnType<typeof setTimeout>;
    const interval = 1000 / fps;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    const render = () => {
      const d = image.data;
      for (let i = 0; i < d.length; i += 4) {
        const v = (Math.random() * 255) | 0;
        d[i] = d[i + 1] = d[i + 2] = v;
        d[i + 3] = 255;
      }
      tctx.putImageData(image, 0, 0);
      const pattern = ctx.createPattern(tile, "repeat");
      if (pattern) {
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = pattern;
        // random sub-pixel offset so the tile seams never sit still
        ctx.save();
        ctx.translate(-((Math.random() * TILE) | 0), -((Math.random() * TILE) | 0));
        ctx.fillRect(0, 0, w + TILE, h + TILE);
        ctx.restore();
      }
      if (!reduce) timer = setTimeout(() => (raf = requestAnimationFrame(render)), interval);
    };
    render();

    return () => {
      window.removeEventListener("resize", resize);
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
  }, [fps]);

  return (
    <canvas
      ref={ref}
      aria-hidden
      className="pointer-events-none fixed inset-0 z-[60] mix-blend-soft-light"
      style={{ opacity }}
    />
  );
}
