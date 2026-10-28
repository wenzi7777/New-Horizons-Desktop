# Devices and settings

## Home

**Home** lists every device that has connected, in folders: **Online**, **Offline**, and one folder for each group you set. Click a folder to see its devices, then click a device to open its settings.

Each device card also has buttons for **Visualize** (its live data), **Device Files** (files stored on the device), **Advanced Commands** (send commands by hand) and **Device Wiki** (documents for that board).

## Device settings

The settings page has a list of sections on the left.

| Section | What is there |
| --- | --- |
| Overview | Name, group, firmware version, battery, how it is connected |
| Maintenance | Calibration |
| Apps | Apps installed on the device |
| Hardware | LEDs, display, battery capacity and charging, and the Action Button (v1.5.F boards only) |
| Streaming | Scan rate, streaming, IMU, and where the device gets its time from |
| Update | Firmware updates and the update channel |
| Diagnostics | Health counters, scan and stream statistics, memory |
| Files | Files and logs on the device |
| Experimental | Settings for testing; leave them off normally |

To put several devices in their own folder on Home, give them the same group in **Overview**.

## Calibration

Calibration is in **Maintenance**. There are three ways to do it:

- **Zero**: take every load off the sensors and press zero. Readings then start from 0, in mV.
- **Point-by-point calibration**: capture a no-load baseline, then add known pressures one at a time (for example with weights). Readings are then in kPa. Each sensor needs at least three pressure levels.
- **Air-pressure calibration**: the lab's pressure chamber steps through the levels and calibrates all sensors at once.

**Calibration data and settings** at the bottom lets you turn calibration on or off, export it, or clear it.

## Updating firmware

In **Update**, check for an update and apply it. The device restarts when it is done.

**Stable** gets normal releases. **Beta** gets test releases first. Stay on stable unless you were asked to test something.
