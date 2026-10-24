import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { ocrAssets } from "./ocr-assets.js";

// The version a user reads in About comes from the manifest, so there is no
// second place to forget to bump. scripts/check-version.mjs holds the five
// manifests that carry it to one value.
const { version } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

// GitHub Pages serves a project site from /<repo>/, not from the root. Every
// asset path, the manifest's start_url and the service worker's scope are all
// absolute, so a build for that host has to be told where it will live or it
// 404s on its own bundle.
const base = process.env.SIGNET_BASE ?? "/";

// No @vitejs/plugin-react on purpose: its dev Fast-Refresh preamble is an inline
// <script>, which the CSP in docs/PRIVACY.md forbids. Vite's esbuild already
// transpiles .tsx using tsconfig's "jsx": "react-jsx"; we trade component HMR
// for the shipped CSP being byte-identical in dev, preview and production.
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(version),
    // SIGNET_TRIAL=1 builds the public try-it-out copy: everything works
    // except taking a file away. See apps/web/src/file-io.ts.
    __TRIAL__: JSON.stringify(process.env.SIGNET_TRIAL === "1"),
    __DOWNLOAD_URL__: JSON.stringify(
      process.env.SIGNET_DOWNLOAD_URL ?? "https://github.com/ebinrajiiit/pdf_suite/releases/latest",
    ),
  },
  base,
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
  plugins: [
    ocrAssets(),
    VitePWA({
      registerType: "autoUpdate",
      // External script, not inline — the CSP has no 'unsafe-inline'.
      injectRegister: "script",
      // Self-hosted workbox runtime inlined into sw.js: no CDN importScripts.
      workbox: {
        inlineWorkboxRuntime: true,
        // App assets only. No .pdf, no runtimeCaching: a user's document is
        // never fetched over HTTP and must never reach a cache (docs/PRIVACY.md).
        globPatterns: ["**/*.{js,css,html,svg,png,woff2,wasm,traineddata}"],
        // PDFium's wasm is 4.4 MB and workbox skips anything over 2 MB by
        // default, which would leave the engine missing offline.
        maximumFileSizeToCacheInBytes: 12 * 1024 * 1024,
        // The OCR core and language data are ~16 MB and most users never run
        // OCR, so they are fetched on first use instead of tripling first load.
        globIgnores: ["**/ocr/**"],
        navigateFallback: `${base}index.html`,
      },
      manifest: {
        name: "Signet — FACTS-H Lab",
        short_name: "Signet",
        description:
          "Privacy-preserving PDF editor from FACTS-H Lab. Read, edit, annotate, OCR, redact, convert and sign — your files never leave your computer.",
        start_url: base,
        scope: base,
        display: "standalone",
        background_color: "#ffffff",
        theme_color: "#0f172a",
        icons: [
          { src: "brand/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "brand/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
        ],
      },
    }),
  ],
});
