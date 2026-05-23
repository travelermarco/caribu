# ⚡ Caribù

Unified camper dashboard — controls all 4 systems from one beautiful app.

| System | Protocol | Status |
|---|---|---|
| 🔥 Diesel Heater (Vevor/Hcalory) | BLE UART | Full control |
| 🔋 XiaoXiang BMS | BLE GATT | Full monitoring |
| ☀️ Victron SmartSolar MPPT ×2 | BLE Advertisement | Read-only |
| 📷 Imou Cameras | Cloud API | Snapshots |

## Stack

- Vanilla PWA (no framework, no build step)
- Web Bluetooth API (Chrome Android)
- Imou Open Platform REST API
- Hosted on Vercel — auto-updates on every push

## Install on Android

1. Open Chrome → navigate to the app URL
2. Tap ⋮ → **Add to Home Screen**
3. Done — works like a native app

## Victron encryption key

VictronConnect → device → ⋮ → **Show encryption data** → copy the 32-char hex key → paste in app Settings.

## Imou setup

Register at [open.imoulife.com](https://open.imoulife.com), create an app, paste App ID + App Secret in the Cameras tab.

## Update

Push to `main` → Vercel deploys automatically → app on phone updates on next open.
