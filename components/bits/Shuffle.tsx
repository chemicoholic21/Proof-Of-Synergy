"use client";

import { useEffect, useState } from "react";

/**
 * Shuffle — the React Bits scramble/shuffle text reveal (https://reactbits.dev/text-animations/shuffle),
 * reimplemented dependency-free. Each glyph cycles through random characters and locks into place on
 * a left-to-right stagger. Scrambling glyphs are dimmed so the settle reads clearly. Respects
 * prefers-reduced-motion and preserves the final text for screen readers.
 */

const GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789#%&/<>";

type Cell = { c: string; done: boolean };

export default function Shuffle({
  text,
  className = "",
  as: Tag = "span",
  stagger = 42,
  scrambleMs = 260,
  start = 120,
  tick = 38,
}: {
  text: string;
  className?: string;
  as?: keyof JSX.IntrinsicElements;
  stagger?: number; // ms between each glyph locking
  scrambleMs?: number; // baseline scramble time before the first glyph locks
  start?: number; // ms before anything starts
  tick?: number; // ms between scramble frames
}) {
  const chars = Array.from(text);
  const finalCells = (): Cell[] => chars.map((c) => ({ c, done: true }));
  const [cells, setCells] = useState<Cell[]>(finalCells);

  useEffect(() => {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      setCells(finalCells());
      return;
    }
    const startedAt = performance.now();
    const lockAt = (i: number) => start + scrambleMs + i * stagger;
    const id = setInterval(() => {
      const el = performance.now() - startedAt;
      let allDone = true;
      const next: Cell[] = chars.map((c, i) => {
        if (c === "\n" || c === " ") return { c, done: true };
        const done = el >= lockAt(i);
        if (!done) allDone = false;
        return { c: done ? c : GLYPHS[(Math.random() * GLYPHS.length) | 0], done };
      });
      setCells(next);
      if (allDone) clearInterval(id);
    }, tick);
    return () => clearInterval(id);
    // Re-run only when the target text changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  return (
    <Tag className={className} aria-label={text.replace(/\n/g, " ")}>
      <span aria-hidden="true">
        {cells.map((cell, i) =>
          cell.c === "\n" ? (
            <br key={i} />
          ) : (
            <span key={i} style={cell.done ? undefined : { color: "var(--ink-soft)", opacity: 0.85 }}>
              {cell.c}
            </span>
          )
        )}
      </span>
    </Tag>
  );
}
