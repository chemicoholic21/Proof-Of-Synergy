"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * "True Focus" text animation (React Bits style, dependency-free): every word sits slightly
 * blurred except the focused one, and a camera-style focus frame - four glowing corner
 * brackets - glides from word to word. Framer-motion is replaced with plain CSS transitions
 * so it adds zero dependencies. Honors prefers-reduced-motion by rendering static text.
 */
export default function TrueFocus({
  sentence,
  blurAmount = 4,
  borderColor = "#c8beac",
  glowColor = "rgba(200, 190, 172, 0.55)",
  animationDuration = 0.5,
  pauseBetweenAnimations = 0.9,
  className = "",
}: {
  sentence: string;
  blurAmount?: number;
  borderColor?: string;
  glowColor?: string;
  animationDuration?: number;
  pauseBetweenAnimations?: number;
  className?: string;
}) {
  const words = sentence.split(" ");
  const [current, setCurrent] = useState(0);
  const [reduceMotion, setReduceMotion] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const wordRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const [frame, setFrame] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  useEffect(() => {
    setReduceMotion(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
  }, []);

  // Cycle the focused word.
  useEffect(() => {
    if (reduceMotion || words.length < 2) return;
    const interval = setInterval(
      () => setCurrent((c) => (c + 1) % words.length),
      (animationDuration + pauseBetweenAnimations) * 1000
    );
    return () => clearInterval(interval);
  }, [reduceMotion, words.length, animationDuration, pauseBetweenAnimations]);

  // Measure the focused word relative to the container and move the frame there.
  const measure = useCallback(() => {
    const container = containerRef.current;
    const word = wordRefs.current[current];
    if (!container || !word) return;
    const c = container.getBoundingClientRect();
    const w = word.getBoundingClientRect();
    const pad = Math.max(6, w.height * 0.14);
    setFrame({ x: w.left - c.left - pad, y: w.top - c.top - pad, w: w.width + pad * 2, h: w.height + pad * 2 });
  }, [current]);

  useEffect(() => {
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);

  if (reduceMotion) {
    return <span className={className}>{sentence}</span>;
  }

  const corner = (pos: "tl" | "tr" | "bl" | "br") => {
    const base: React.CSSProperties = {
      position: "absolute",
      width: "0.9rem",
      height: "0.9rem",
      borderStyle: "solid",
      borderColor,
      borderWidth: 0,
      filter: `drop-shadow(0 0 6px ${glowColor})`,
      borderRadius: 3,
    };
    if (pos === "tl") return { ...base, top: 0, left: 0, borderTopWidth: 3, borderLeftWidth: 3 };
    if (pos === "tr") return { ...base, top: 0, right: 0, borderTopWidth: 3, borderRightWidth: 3 };
    if (pos === "bl") return { ...base, bottom: 0, left: 0, borderBottomWidth: 3, borderLeftWidth: 3 };
    return { ...base, bottom: 0, right: 0, borderBottomWidth: 3, borderRightWidth: 3 };
  };

  return (
    <div ref={containerRef} className={`relative inline-flex flex-wrap gap-x-[0.28em] gap-y-1 ${className}`}>
      {words.map((word, i) => (
        <span
          key={i}
          ref={(el) => {
            wordRefs.current[i] = el;
          }}
          style={{
            filter: i === current ? "blur(0px)" : `blur(${blurAmount}px)`,
            opacity: i === current ? 1 : 0.75,
            transition: `filter ${animationDuration}s ease, opacity ${animationDuration}s ease`,
          }}
        >
          {word}
        </span>
      ))}

      {/* The gliding focus frame */}
      {frame && (
        <span
          aria-hidden
          style={{
            position: "absolute",
            pointerEvents: "none",
            top: 0,
            left: 0,
            width: frame.w,
            height: frame.h,
            transform: `translate(${frame.x}px, ${frame.y}px)`,
            transition: `transform ${animationDuration}s cubic-bezier(0.4, 0, 0.2, 1), width ${animationDuration}s cubic-bezier(0.4, 0, 0.2, 1), height ${animationDuration}s cubic-bezier(0.4, 0, 0.2, 1)`,
          }}
        >
          <span style={corner("tl")} />
          <span style={corner("tr")} />
          <span style={corner("bl")} />
          <span style={corner("br")} />
        </span>
      )}
    </div>
  );
}
