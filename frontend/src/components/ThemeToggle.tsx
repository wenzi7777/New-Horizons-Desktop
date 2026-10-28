import { Moon, Sun, SunMoon } from "lucide-react";

import { useI18n } from "../i18n";
import { useTheme } from "../lib/theme";

// One button that steps Auto -> Light -> Dark. The icon shows the current
// choice; the tooltip says what it means right now.
export function ThemeToggle() {
  const { t } = useI18n();
  const { mode, theme, nextChange, cycleMode } = useTheme();

  const modeLabel = mode === "auto" ? t("themeAuto") : mode === "light" ? t("themeLight") : t("themeDark");
  const time = nextChange?.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const detail = mode === "auto" && time
    ? (theme === "light" ? t("themeNextDark") : t("themeNextLight")).replace("{time}", time)
    : "";
  const label = `${t("themeLabel")}: ${modeLabel}${detail ? ` · ${detail}` : ""}`;
  const Icon = mode === "auto" ? SunMoon : mode === "light" ? Sun : Moon;

  return (
    <button
      className="button ghost icon-button topbar-icon-button"
      type="button"
      onClick={cycleMode}
      title={label}
      aria-label={label}
    >
      <Icon size={17} strokeWidth={1.8} />
    </button>
  );
}
