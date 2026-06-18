# SK6812 Status LED Reference

The on-board SK6812 LED (GPIO 38) provides real-time system status feedback. Each state maps to a specific color and animation pattern.

## Animation Patterns

| Pattern | Description |
|---------|-------------|
| `Off` | LED is completely off |
| `Solid` | Constant, steady color |
| `Breathe` | Smooth fade in and out |
| `BlinkBurst` | Short rapid blinks then pause |

## Color Reference

| Name | R | G | B | Appearance |
|------|---|---|---|------------|
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

## State Reference

| Signal | Color | Pattern | Interval | Meaning |
|--------|-------|---------|----------|---------|
| `Boot` | Dim blue | Breathe | 2200 ms | Firmware initializing at startup |
| `WifiSetup` | Amber | Breathe | 1800 ms | WiFi setup portal is active |
| `WifiConnecting` | Yellow-amber | Breathe | 1800 ms | Attempting to connect to saved WiFi |
| `FindMePending` | Cyan | Breathe | 1500 ms | WiFi connected, searching for a gateway |
| `Online` | Green | Solid | — | Fully operational and streaming to gateway |
| `Maintenance` | Orange | Solid | — | Maintenance mode active |
| `SafeMode` | Magenta | Solid | — | Safe Maintenance mode |
| `OtaActive` | Cyan | Breathe | 1300 ms | OTA firmware download in progress |
| `OtaSuccess` | Green | BlinkBurst | 700 ms · 900 ms | OTA applied successfully, rebooting |
| `OtaError` | Red | Solid | — | OTA download or verification failed |
| `Error` | Red | Solid | — | Unrecoverable runtime error |
| `ScanWarning` | Yellow-orange | Breathe | 1200 ms | Matrix scan overruns detected |
| `RamDanger` | Yellow-orange | Breathe | 800 ms | Free heap critically low |
| `CommandReceived` | White | Short flash | — | A control command packet was received |
| `CommandSuccess` | Green | Short flash | — | Command executed successfully |
| `CommandFailed` | Red | Short flash | — | Command execution failed |

> This board has no BQ25180 charger, so charging-related signals (`ChargingOrMissing`, `ChargeDone`, `SoftOff*`) do not apply.
