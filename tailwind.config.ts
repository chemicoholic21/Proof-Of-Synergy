import type { Config } from "tailwindcss";

// Minimal editorial palette: a quiet, warm monochrome with two desaturated semantic scales
// (emerald = positive/strong, amber = needs-attention/developing).

// Desaturated sage for "good / strong / demonstrated".
const sage = {
  50: "#eef2ec",
  100: "#dde5d9",
  200: "#c1d0bc",
  300: "#a1b69b",
  400: "#7f9a78",
  500: "#647e5d",
  600: "#4e6449",
  700: "#3c4d38",
  800: "#293527",
  900: "#1b241a",
  950: "#111710",
};

// Muted ochre for "attention / developing / practice next".
const ochre = {
  50: "#f5f0e4",
  100: "#ebe1c9",
  200: "#ddcaa2",
  300: "#ccb07f",
  400: "#b8965c",
  500: "#9d7d47",
  600: "#7e6339",
  700: "#5e4a2b",
  800: "#40331f",
  900: "#2b2215",
  950: "#1a150c",
};

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#ece9e3",
        "ink-soft": "#8f887b",
        accent: "#c8beac",
        background: "#0e0d0b",
        surface: "#16140f",
        "surface-2": "#1b1813",
        line: "#2a2620",
        "line-strong": "#3a352c",
        emerald: sage,
        amber: ochre,
      },
      fontFamily: {
        display: ["var(--font-display)", "Georgia", "ui-serif", "serif"],
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
};
export default config;
