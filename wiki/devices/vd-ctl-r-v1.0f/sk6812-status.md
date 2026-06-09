# Board SK6812 Status Map

The built-in `SK6812` LED is the quickest board-side status hint during boot, control actions, soft power transitions, and runtime health changes.

| SK6812 pattern | Device state / meaning |
| --- | --- |
| Off | Soft-off, deep idle, or indicators disabled |
| White short pulse then fade | Entering soft-off shutdown transition |
| White rise then handoff | Waking from soft-off and resuming runtime |
| White command flash | A control command reached the board |
| Online status color | Normal runtime and transport attached |
| Warning state color / pulse | Degraded runtime state, warning indicator preset, or health warning |
| Error / failure pattern | OTA failure, unrecoverable runtime error, or boot issue requiring attention |

## Related Device States
- `normal`: runtime services active, scan and transport running.
- `maintenance` / `safe_maintenance`: interactive service/config state for calibration, files, and diagnostics.
- `soft_off_*`: low-power soft-off family, including wake via action button.
- `booting`: temporary startup phase before normal runtime or maintenance state is declared.

## Notes
- The board `SK6812` meaning is separate from the external `WS2812B` presets.
- If OLED is enabled, shutdown and wake transitions also show matching on-screen animation cues.
