# Connecting devices

A device never talks to this app directly. It goes through one of two relays:

| | Gateway | Hub |
| --- | --- | --- |
| What it is | Software on a computer | A small board |
| How the device connects | Wi-Fi, same network as the computer | ESP-NOW, no Wi-Fi needed on the device |
| Good for | Devices on a lab network | Wearables, places without usable Wi-Fi |

Both appear on the **Relays** page once they are connected. The setup steps are also at the bottom of that page.

## Setting up a Gateway

1. On **Relays**, click **Download** under Gateway and unzip it on a computer on the same Wi-Fi as the devices.
2. Run `python3 scripts/start.py`. The first run creates its settings.
3. Open `http://127.0.0.1:5052` on that computer, set a Gateway ID and turn it on.

## Setting up a Hub

1. Power on the Hub. On a phone or computer, join the Wi-Fi network named `NHHub-…`.
2. Open `http://nhos.hub` and enter your Wi-Fi and which server to use.
3. The Hub restarts and appears on **Relays**. Click **Manage** on its card to rename it, update it or change its settings.

## Pointing a device at a relay

A new or reset device starts its own setup network named `NHOS-…`.

1. Join `NHOS-…` and open `http://nhos.os`.
2. Under **Connect through**, choose **A Gateway on your Wi-Fi** (then pick the Wi-Fi and enter its password) or **A nearby Hub**.
3. Press **Connect**. The device restarts and shows up on **Home** within a few seconds.

To move a device to a different Wi-Fi later, open its settings and use **Reboot into Wi-Fi setup**.

## If a device does not show up

- Gateway: check that the Gateway's card on **Relays** is online and that the computer and the device are on the same network.
- Hub: check that the Hub is online and the device is within a few meters of it.
- Both: restart the device. If it still does not appear, rejoin its `NHOS-…` network and check the settings.
