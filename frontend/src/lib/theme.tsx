import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { daylightAt } from "./sunTimes";

// Light or dark. "auto" follows the sun at the lab; the choice is remembered
// per browser, since lab accounts are shared.
export type ThemeMode = "auto" | "light" | "dark";
export type Theme = "light" | "dark";

const STORAGE_KEY = "nh-theme-mode";
// The theme last shown, read by index.html before React starts so a night
// visit does not flash white first.
const LAST_THEME_KEY = "nh-theme-last";
const MODES: ThemeMode[] = ["auto", "light", "dark"];

function readMode(): ThemeMode {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return MODES.includes(stored as ThemeMode) ? (stored as ThemeMode) : "auto";
  } catch {
    return "auto";
  }
}

type ThemeContextValue = {
  mode: ThemeMode;
  theme: Theme;
  /** In auto mode, when the theme next changes; otherwise null. */
  nextChange: Date | null;
  cycleMode: () => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>(readMode);
  const [now, setNow] = useState(() => new Date());

  // Re-check once a minute: catches sunrise/sunset on time, and a laptop
  // waking from sleep, without any timer that a long sleep could skip.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const daylight = useMemo(() => daylightAt(now), [now]);
  const theme: Theme = mode === "auto" ? (daylight.day ? "light" : "dark") : mode;

  useEffect(() => {
    const root = document.documentElement;
    // Ease a swap so a whole screen does not flash from white to black, but
    // not the first paint (index.html already set the last theme).
    const firstPaint = !root.classList.contains("theme-ready");
    root.classList.add("theme-ready");
    if (root.dataset.theme === theme) return undefined;
    if (!firstPaint) root.classList.add("theme-fading");
    root.dataset.theme = theme;
    try {
      window.localStorage.setItem(LAST_THEME_KEY, theme);
    } catch {
      // Storage may be unavailable; the first paint is then light.
    }
    const timer = window.setTimeout(() => root.classList.remove("theme-fading"), 400);
    return () => window.clearTimeout(timer);
  }, [theme]);

  const value = useMemo<ThemeContextValue>(() => ({
    mode,
    theme,
    nextChange: mode === "auto" ? daylight.nextChange : null,
    cycleMode: () => {
      const next = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
      setMode(next);
      try {
        window.localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // Private windows may refuse storage; the choice then lasts this visit.
      }
    },
  }), [daylight.nextChange, mode, theme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used inside ThemeProvider");
  return context;
}
