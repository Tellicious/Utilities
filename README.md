# Electronics Toolkit

A small offline PWA hub for everyday tools, designed for iOS install. First sub-app: **Resistor** — decode colour-band values manually or scan a real resistor with the camera.

## Run locally

It's a fully static site. Serve the project root over HTTP:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000` in a browser. For the camera feature to work and for the service worker to register, you need either `localhost` or HTTPS.

## Install on iOS

Host on any HTTPS server, open the URL in Safari, then **Share → Add to Home Screen**. The app launches full-screen, works offline (service worker caches the shell), and uses the supplied icons.

## Deploy to GitHub Pages

Push to `main` and the workflow at `.github/workflows/deploy.yml` deploys automatically. One-time setup in your GitHub repo: **Settings → Pages → Build and deployment → Source: GitHub Actions**.

## Project layout

```
├── index.html                 # Hub
├── manifest.json              # PWA manifest
├── sw.js                      # Service worker (cache-first)
├── assets/
│   ├── styles.css             # Global tokens + hub styles
│   ├── app.js                 # (Reserved for shared utility code)
│   └── icons/                 # PWA + Apple-touch icons
└── apps/
    └── resistor/
        ├── index.html         # Sub-app shell (picker + camera views)
        ├── resistor.css       # Sub-app styles
        ├── resistor.js        # Picker, SVG renderer, value engine
        ├── cv.js              # Pure-JS computer-vision pipeline
        └── camera.js          # Capture + result UI
```

## Resistor sub-app

**Colour picker** — 4-band / 5-band toggle, column-per-band swatch grid, live SVG render, auto-formatted value (Ω/kΩ/MΩ/GΩ), tolerance range, nearest E24 hint. Reverse-lookup field parses `4.7k`, `4k7`, `220`, `1M`, etc.

**Camera scanner** — getUserMedia or file-picker fallback. The CV pipeline runs entirely in vanilla JS (no OpenCV): background-difference mask → largest connected component → PCA orientation → rotate flat → re-mask → crop body → sample central strip → detect band regions → classify against 12 reference colours → infer reading direction. Result screen shows the photo, a clean rendered version, the value, and per-band confidence pills (low-confidence bands flagged for review).
