# Security

Caribù is a client-side PWA with no backend of its own:

- All device control (heater, BMS, Victron MPPT) happens over **Web Bluetooth**, directly between the browser and the physical device — nothing is proxied through a server.
- The Imou camera integration calls Imou's cloud API directly from the browser using credentials you configure yourself; they are stored locally (browser storage) and never sent anywhere else.
- The app is served as static files (see `vercel.json`); there is no server-side code that could be compromised.

## Reporting a vulnerability

If you find a security issue (e.g. a way to leak stored credentials, or a Bluetooth interaction that could affect a device unsafely), please open a GitHub issue or contact the maintainer directly rather than disclosing it publicly first.
