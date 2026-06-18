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

The external WS2812B strip (3 pixels, GPIO 12) operates independently and can be set to modes `off`, `on`, or `auto` via the `set_indicators` command. In `auto` mode the `stream_health` preset reflects UDP stream health using the same Online / Warning / Error color semantics.
