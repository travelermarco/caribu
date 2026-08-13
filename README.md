# ⚡ Caribù

[![CI](https://github.com/travelermarco/caribu/actions/workflows/ci.yml/badge.svg)](https://github.com/travelermarco/caribu/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?logo=open-source-initiative&logoColor=white)](LICENSE)

Caribù is a unified dashboard for a camper van — an installable, dependency-free PWA that connects directly to onboard hardware over Bluetooth and pulls in weather, camping, and document data, all from one app.

## Features

| Area | Source | Notes |
|---|---|---|
| 🔥 Diesel heater (Vevor / Hcalory / generic UART-over-BLE) | Web Bluetooth (GATT UART) | On/off, target temp, power level, scheduling |
| 🔋 XiaoXiang / JBD BMS | Web Bluetooth (GATT) | Full monitoring: SoC, voltage, current, per-cell data |
| ☀️ Victron SmartSolar MPPT ×2 | Web Bluetooth (BLE advertisements, AES-128-CTR decrypt) | Read-only, needs the device's encryption key |
| 📷 Imou cameras | Imou Open Platform REST API | Live snapshots |
| 🌤 Weather | Open-Meteo API | Forecast + automatic severe-weather (hail/wind) alerts |
| 📍 Campsite log | Geolocation API | Auto-logs a stop once the van is stationary for 10+ minutes |
| 📂 Van documents | IndexedDB | Stores license, registration, insurance, etc. as files/photos on-device |
| 🔧 Maintenance reminders | localStorage | Tracks service, gas bottle, tires, brakes, etc. with configurable intervals |
| 🔔 Push notifications | Notification API | Configurable thresholds (low SoC, full charge, low temp, weather alerts) |
| 🔐 App lock | Web Crypto (SHA-256) + WebAuthn | Optional PIN and/or biometric lock screen |
| ⚡ Energy balance & 24h history | localStorage snapshots | Rolling SoC/PV/battery charts on the dashboard |
| 🚗 Android Auto bridge | `localhost:8888` HTTP POST | Pushes live state to the companion [caribu-android](https://github.com/travelermarco/caribu-android) app for the car screen; silent no-op if that app isn't running |

## Stack

- Vanilla JS PWA — no framework, no build step, plain ES modules
- Web Bluetooth API (works in Chrome on Android; that's the primary target)
- Open-Meteo API for weather/alerts, Imou Open Platform REST API for cameras
- IndexedDB (documents) and localStorage (history, settings, maintenance, notifications)
- Service worker (`sw.js`) for offline asset caching
- Hosted on Vercel — every push to `main` auto-deploys
- GitHub Actions CI checks JS syntax and validates `manifest.json` on every push/PR

## Structure

```
index.html          Shell: screens/tabs, dock nav, splash screen
manifest.json        PWA manifest (icons, shortcuts, theme)
sw.js                 Service worker (offline caching)
styles.css            All styling
js/
  app.js              Entry point: state, rendering, tab switching, init
  heater.js            Diesel heater BLE control
  bms.js                BMS BLE monitoring
  victron.js            Victron MPPT BLE advertisement decoding
  imou.js               Imou camera REST client
  chart.js              Dependency-free SVG line chart component
  history.js            Rolling snapshot storage + 24h charts
  weather.js            Open-Meteo forecast/coords
  alerts.js             Severe weather alert checks
  campsites.js          Geolocation-based campsite auto-logging
  documents.js          IndexedDB document storage
  maintenance.js         Maintenance reminder tracking
  notifications.js       Push notification thresholds
  lock.js                PIN/biometric app lock
icons/icon.svg        App icon
release-notes/         Dated changelog entries (one file per change)
```

## Install on Android

1. Open Chrome and navigate to the app URL.
2. Tap ⋮ → **Add to Home Screen**.
3. Done — it runs like a native app, offline-capable via the service worker.

## Victron encryption key

VictronConnect → device → ⋮ → **Show encryption data** → copy the 32-char hex key → paste into the app's Settings.

## Imou setup

Register at [open.imoulife.com](https://open.imoulife.com), create an app, then paste the App ID + App Secret into the Cameras tab.

## Android Auto companion

If the [caribu-android](https://github.com/travelermarco/caribu-android) app is installed and running on the same device, this web app posts a small JSON snapshot (SoC, heater temp/state, solar power) to `http://localhost:8888/state` so it can be mirrored on the car's Android Auto screen. Without the companion app installed, this call simply fails silently and has no effect on the PWA.

## Deploy

Push to `main` → Vercel builds and deploys automatically → the app updates on the phone the next time it's opened (via the service worker).
