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

## Magnetometer

Boards with a magnetometer (v1.5.F, v2.0.F, GCU LTS) have it **off** by default, including after a firmware update. Its chip rate follows the scan rate, like the IMU's.

- Switch it on in **Streaming**: pick **On** and press **Apply**. The calibration opens straight away; cancelling it switches the magnetometer off again. If the device already has a calibration that has not expired, you can keep it.
- The calibration asks you to slowly turn the device through every direction for about a minute. A sphere fills in as directions are covered; press **Compute** when the ring is full, check the result (before/after, field strength, residual) and **Apply**.
- Calibrate with the device as it is used (enclosure closed, battery in), away from laptops, steel desks, motors and magnets.
- Redo it after changing the enclosure, battery or metal parts, or after a strong magnet came close. Moving to another room does not need it: fields from the room cannot be calibrated away.
- A reminder (every 7, 14, 30 or 90 days, or never) shows a badge on Home and a dot on **Maintenance** when the calibration is due. The device also flags a calibration that no longer seems to fit (the field strength drifts more than 20% for 5 minutes). Neither stops anything.

## Updating firmware

In **Update**, check for an update and apply it. The device restarts when it is done.

**Stable** gets normal releases. **Beta** gets test releases first. Stay on stable unless you were asked to test something.
