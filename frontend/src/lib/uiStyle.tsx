// Which interface the Desktop draws: "modern" (the board illustration with
// callouts, the default, as in NH Studio and NH Pocket) or "classic" (the
// plain cards). Per browser, kept in localStorage and mirrored on
// <html data-ui> so CSS can tell them apart; index.html sets it before the
// first paint.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type UiStyle = "modern" | "classic";

export const UI_STYLE_KEY = "nh-ui-style";

function readStored(): UiStyle {
  try {
    return window.localStorage.getItem(UI_STYLE_KEY) === "classic" ? "classic" : "modern";
  } catch {
    return "modern";
  }
}

type UiStyleContextValue = { uiStyle: UiStyle; setUiStyle: (value: UiStyle) => void };

const UiStyleContext = createContext<UiStyleContextValue | null>(null);

export function UiStyleProvider({ children }: { children: ReactNode }) {
  const [uiStyle, setState] = useState<UiStyle>(readStored);
  useEffect(() => {
    document.documentElement.dataset.ui = uiStyle;
  }, [uiStyle]);
  const setUiStyle = useCallback((value: UiStyle) => {
    setState(value);
    try {
      window.localStorage.setItem(UI_STYLE_KEY, value);
    } catch {
      // Private mode: the choice lasts until the page is reloaded.
    }
  }, []);
  const value = useMemo(() => ({ uiStyle, setUiStyle }), [uiStyle, setUiStyle]);
  return <UiStyleContext.Provider value={value}>{children}</UiStyleContext.Provider>;
}

export function useUiStyle(): UiStyleContextValue {
  const value = useContext(UiStyleContext);
  if (!value) throw new Error("UiStyleProvider missing");
  return value;
}
