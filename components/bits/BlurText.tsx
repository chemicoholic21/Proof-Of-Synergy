"use client";

import { CSSProperties } from "react";

/**
 * Blur-in text reveal (React Bits "BlurText" style): each word rises and sharpens from a blur, on a
 * gentle stagger. Pure CSS so it's dependency-free and never janks. Words wrap naturally; the whole
 * headline can be multi-line via `\n`.
 */
export default function BlurText({
  text,
  className = "",
  delay = 60,
  start = 0,
  as: Tag = "span",
}: {
  text: string;
  className?: string;
  delay?: number; // ms between words
  start?: number; // ms before the first word
  as?: keyof JSX.IntrinsicElements;
}) {
  const lines = text.split("\n");
  let idx = 0;
  return (
    <Tag className={className}>
      {lines.map((line, li) => (
        <span key={li} style={{ display: "block" }}>
          {line.split(" ").map((word, wi) => {
            const i = idx++;
            const style: CSSProperties = {
              display: "inline-block",
              whiteSpace: "pre",
              animation: `blurReveal 0.85s cubic-bezier(0.2, 0.8, 0.2, 1) both`,
              animationDelay: `${start + i * delay}ms`,
              willChange: "transform, filter, opacity",
            };
            return (
              <span key={wi} style={style}>
                {word}
                {wi < line.split(" ").length - 1 ? " " : ""}
              </span>
            );
          })}
        </span>
      ))}
    </Tag>
  );
}
