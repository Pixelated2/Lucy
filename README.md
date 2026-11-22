# Lucy Locates

Barcode-driven laboratory sample tracker. Scan samples in, log them as **received / not received**, store them in racks, and find any sample's exact location by searching its number. All users share one database that syncs live between devices.

Runs on **Android, iPhone/iPad, Windows and Chromebook** as an installable app (Progressive Web App) from a single codebase.

## Features

| Screen | What it does |
|---|---|
| **Find** | Type or scan a sample number → rack, row and slot with the slot highlighted on a rack map. Retrieve, move, edit, view history. |
| **Receive** | Pick the sample type, mark **Received** or **Not received**, scan. Racked types are assigned the next free slot automatically ("Place in Rack 4 · Row C · Slot 7"). Batch mode keeps the camera scanning. |
| **Racks** | All 20 racks with fill level; tap a rack for its 9 × 12 map. Tap a full slot to open the sample, or an empty slot to store one there. |
| **Log** | Receiving log filterable by date, type and received status, with CSV export; plus a full activity history (who did what, when). |
| **Settings** | Your name, sync server and access code, rack-type assignments, install instructions. |

### Racks and sample types

- **20 racks × 108 slots**: 9 rows (A–I, the width) × 12 slots (1–12, the length).
- Sample types and tube colors:

  | Type | Color | Storage |
  |---|---|---|
  | SureSwab | Orange | Own racks (default: racks 1–7) |
  | Pap Swab | Green | Own racks (default: racks 8–14) |
  | SST | Red | Own racks (default: racks 15–20) |
  | ThinPrep | Pink | Received log only |
  | CBC | Purple | Received log only |
  | Urine | Yellow | Received log only |

- Rack assignments can be changed in **Settings** (a rack must be empty first). Samples only go into racks of their own type.

### Scanning

- **Handheld USB/Bluetooth scanners** work everywhere: they type into the focused box and press Enter.
- **Camera scanning** uses the device's built-in barcode detector (Android, ChromeOS) or the bundled ZXing decoder (iPhone, iPad, Windows). The camera needs **HTTPS** (or `localhost`).

### Sync and offline use

- Every device keeps a full local copy, so it keeps working with no network. Changes queue up (the top bar shows "Offline · N pending") and upload on reconnect.
- Connected devices receive changes immediately (server-sent events), with a 30-second fallback poll.
- The server is authoritative, and retried uploads are never applied twice. If two offline users put different samples in the same slot, the second sample is recorded in the next free slot and that user gets a **slot conflict** alert telling them where to move the tube.

## Hosting on Google Cloud

See **[deploy/DEPLOY.md](deploy/DEPLOY.md)**. One script (`sudo bash deploy/install.sh`) sets up the app, HTTPS, auto-start and nightly backups on a Debian/Ubuntu VM.

## Running the server

Needs Node.js 22.13 or newer. There's no separate database to install (it uses the SQLite built into Node).

```bash
npm install
npm start                 # http://localhost:8080
```

Environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP port |
| `LUCY_DB` | `data/lucy.db` | SQLite database file. Back this file up. |
| `LUCY_ACCESS_CODE` | *(none)* | When set, every device must enter this code in Settings. |

For phones and tablets to use the camera and install the app, put the server behind HTTPS, for example a reverse proxy (Caddy, nginx, IIS) with a certificate, or a hosting platform that gives you HTTPS. Then open the HTTPS address on each device and install it:

- **Android**: Chrome → ⋮ → *Install app*
- **iPhone / iPad**: Safari → Share → *Add to Home Screen*
- **Windows**: Edge or Chrome → install icon in the address bar
- **Chromebook**: Chrome → install icon in the address bar

## Development

```bash
npm run dev    # restart on change
npm test       # rules + server/sync tests
```

```
public/            the app (no build step)
  shared/          inventory rules shared by app and server
  js/              UI, sync engine, scanner
server/            HTTP + sync API + SQLite storage
test/              node:test suites
```

API: `GET /api/changes?since=<rev>`, `POST /api/ops` (`{ops:[…]}`), `GET /api/stream` (SSE), `GET /api/samples/:n/history`, `GET /api/health`.
