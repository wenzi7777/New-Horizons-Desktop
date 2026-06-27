# SK6812 Status LED Reference

The on-board SK6812 LED (GPIO 11) provides real-time system status feedback. Each state maps to a specific color and animation pattern.

## Animation Patterns

| Pattern | Description |
|---------|-------------|
| `Off` | LED is completely off |
| `Solid` | Constant, steady color |
| `Breathe` | Smooth fade in and out |
| `BlinkBurst` | Short rapid blinks then pause |
| `AlternateBurst` | Alternates between two states in bursts |

## Color Palette (RGB)

| Name | R | G | B | Appearance |
|------|---|---|---|------------|
| Off | 0 | 0 | 0 | Dark |
| Boot | 0 | 0 | 16 | Dim blue |
| WifiSetup | 32 | 9 | 0 | Amber |
| WifiConnecting | 24 | 18 | 0 | Yellow-amber |
| FindMePending | 0 | 18 | 24 | Cyan |
| Online | 0 | 24 | 0 | Green |
| Maintenance | 32 | 18 | 0 | Orange |
| SafeMode | 32 | 0 | 32 | Magenta |
| Ota | 0 | 18 | 24 | Cyan |
| Error | 32 | 0 | 0 | Red |
| Warning | 28 | 18 | 0 | Yellow-orange |
| White | 24 | 24 | 24 | Neutral white |
| ChargeDone | 57 | 197 | 187 | Teal |

## State Reference

| Signal | Color | Pattern | Interval | Meaning |
|--------|-------|---------|----------|---------|
| `Boot` | Dim blue | Breathe | 2200 ms | Firmware initializing at startup |
| `WifiSetup` | Amber | Breathe | 1800 ms | WiFi setup portal is active (`newhorizons.os`) |
| `WifiConnecting` | Yellow-amber | Breathe | 1800 ms | Attempting to connect to saved WiFi network |
| `FindMePending` | Cyan | Breathe | 1500 ms | Connected to WiFi, searching for a gateway |
| `Online` | Green | Solid | — | Fully operational and streaming to gateway |
| `Maintenance` | Orange | Solid | — | Maintenance mode active |
| `SafeMode` | Magenta | Solid | — | Safe Maintenance mode (triggered after repeated boot failures) |
| `OtaActive` | Cyan | Breathe | 1300 ms | OTA firmware download in progress |
| `OtaSuccess` | Green | BlinkBurst | 700 ms · 900 ms | OTA applied successfully, rebooting |
| `OtaError` | Red | Solid | — | OTA download or verification failed |
| `Error` | Red | Solid | — | Unrecoverable runtime error or critical boot failure |
| `ScanWarning` | Yellow-orange | Breathe | 1200 ms | Matrix scan overruns detected — degraded performance |
| `RamDanger` | Yellow-orange | Breathe | 800 ms | Free heap critically low |
| `ChargingOrMissing` | Orange | Solid | — | Battery is charging, or battery not detected |
| `ChargeDone` | Teal | Solid | — | Battery fully charged |
| `SoftOffTransition` | White | Short pulse then fade | — | Entering soft-off (shutdown animation) |
| `SoftOffCharging` | Orange | Solid | — | In soft-off state while charging |
| `SoftOffChargeDone` | Teal | Solid | — | In soft-off state, battery full |
| `SoftOffChargeIdle` | Off | — | — | In soft-off state, not charging |
| `PowerTransitionShutdown` | White | Fade out | — | Shutdown animation playing before soft-off |
| `PowerTransitionWake` | White | Rise then handoff | — | Wake animation playing after soft-on |
| `CommandReceived` | White | Short flash | — | A control command packet was received |
| `CommandSuccess` | Green | Short flash | — | Command executed successfully |
| `CommandFailed` | Red | Short flash | — | Command execution failed |

## External LED Strip

The external WS2812B strip (3 pixels, GPIO 12) operates independently from the on-board SK6812 status LED. It is configured through `set_indicators.external_led` and only supports modes `off` / `enabled`.

| Field | Default | Options / Range | Description |
|------|---------|-----------------|-------------|
| `mode` | `"off"` | `off`, `enabled` | Turns the strip off completely or lets the selected preset run |
| `preset` | `"system_status"` | `system_status`, `connectivity`, `pressure_meter`, `stream_heartbeat`, `calibration_auto`, `solid_marker`, `identify`, `off` | Selects the strip behavior |
| `color` | `"teal"` | `teal`, `green`, `blue`, `purple`, `amber`, `red`, `white` | Marker color used by `solid_marker` |
| `brightness` | `0.35` | `0.0`–`1.0` | Global strip brightness |

### Preset Reference

| Preset | Behavior | Notes |
|--------|----------|-------|
| `system_status` | All 3 pixels act as one status lamp. `Error`, `OtaError`, and `RamDanger` use a double red pulse; `Maintenance` and `SafeMode` use an orange pulse; `WifiSetup`, `WifiConnecting`, `FindMePending`, `ChargeDone`, and `ChargingOrMissing` map to their matching palette colors. | `Online` is solid green, but recent UDP send failures or scan overruns temporarily shift it to Warning yellow-orange. |
| `connectivity` | Pixel 0 shows Wi-Fi state, pixel 1 shows gateway attachment, pixel 2 shows live stream activity. | Wi-Fi busy uses Warning, disconnected uses Error, and stream idle shows Warning only when a gateway is already attached. |
| `pressure_meter` | Lights 0-3 pixels from the current normalized pressure level. | The lit pixels blend from Online green toward Error red as the meter fills. |
| `stream_heartbeat` | Brief cyan heartbeat when frames were sent recently. | Turns fully off when streaming is idle. |
| `calibration_auto` | Slow orange pulse while automatic calibration is active. | Turns off when calibration is not running. |
| `solid_marker` | All 3 pixels stay solid in the selected `color`. | Available colors are `teal`, `green`, `blue`, `purple`, `amber`, `red`, and `white`. |
| `identify` | White chase across the 3 pixels. | Used both as a persistent preset and for one-shot identify/test flashes. |
| `off` | Keeps the strip dark. | Stored as a preset even while mode remains `enabled`. |

### Priority Overrides

- Soft-off sleep forces the strip off until the board wakes again.
- Power transition animations override the preset: shutdown plays a white step/fade sequence and wake plays a cyan fill handoff.
- A one-shot `identify` trigger temporarily overrides the current preset, then returns to the configured preset when the chase finishes.

### Design Notes

- Severe errors and maintenance warnings are intentionally concentrated in `system_status`; the other presets each focus on one job.
- The on-board SK6812 status LED still reports core errors as a fallback, so the board LED and the external strip remain separate status surfaces.
