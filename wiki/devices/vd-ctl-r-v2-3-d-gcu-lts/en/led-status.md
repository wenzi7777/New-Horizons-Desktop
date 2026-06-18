# SK6812 Status LED Reference

The on-board SK6812 LED (GPIO 38) provides real-time system status feedback. Each state maps to a specific color and animation pattern.

## Animation Patterns

| Pattern | Description |
|---------|-------------|
| `Off` | LED is completely off |
| `Solid` | Constant, steady color |
| `Breathe` | Smooth fade in and out |
| `BlinkBurst` | Short rapid blinks then pause |

## State Reference

| Signal | Color (RGB) | Pattern | Interval | Meaning |
|--------|-------------|---------|----------|---------|
| `Boot` | Blue (0,0,16) | Breathe | 2200 ms | Firmware initializing at startup |
| `WifiSetup` | Amber (32,9,0) | Breathe | 1800 ms | WiFi setup portal is active |
| `WifiConnecting` | Yellow-amber (24,18,0) | Breathe | 1800 ms | Attempting to connect to saved WiFi |
| `FindMePending` | Cyan (0,18,24) | Breathe | 1500 ms | WiFi connected, searching for a gateway |
| `Online` | Green (0,24,0) | Solid | — | Fully operational and streaming |
| `Maintenance` | Orange (32,18,0) | Solid | — | Maintenance mode active |
| `SafeMode` | Magenta (32,0,32) | Solid | — | Safe Maintenance mode |
| `OtaActive` | Cyan (0,18,24) | Breathe | 1300 ms | OTA firmware download in progress |
| `OtaSuccess` | Green | BlinkBurst | 700 ms · 900 ms | OTA applied successfully, rebooting |
| `OtaError` | Red (32,0,0) | Solid | — | OTA download or verification failed |
| `Error` | Red (32,0,0) | Solid | — | Unrecoverable runtime error |
| `ScanWarning` | Yellow-orange (28,18,0) | Breathe | 1200 ms | Matrix scan overruns detected |
| `RamDanger` | Yellow-orange (28,18,0) | Breathe | 800 ms | Free heap critically low |
| `ChargingOrMissing` | Orange (32,18,0) | Solid | — | Battery charging, or battery not detected |
| `ChargeDone` | Teal (57,197,187) | Solid | — | Battery fully charged |
| `SoftOffCharging` | Orange | Solid | — | Soft-off while charging |
| `SoftOffChargeDone` | Teal | Solid | — | Soft-off, battery full |
| `SoftOffChargeIdle` | Off | — | — | Soft-off, not charging |
| `CommandReceived` | White (24,24,24) | Short flash | — | Control command packet received |
| `CommandSuccess` | Green | Short flash | — | Command executed successfully |
| `CommandFailed` | Red | Short flash | — | Command execution failed |

> Unlike v1.0f, this board has no physical button and no `PowerTransitionShutdown` / `PowerTransitionWake` animations — power state transitions are command-driven only.
