import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// No @vitejs/plugin-react on purpose: its dev Fast-Refresh preamble is an inline
// <script>, which the CSP in docs/PRIVACY.md forbids. Vite's esbuild already
// transpiles .tsx using tsconfig's "jsx": "react-jsx"; we trade component HMR
// for the shipped CSP being byte-identical in dev, preview and production.
export default defineConfig({
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
  plugins: [
    VitePWA({
      registerType: "autoUpdate",
      // External script, not inline — the CSP has no 'unsafe-inline'.
      injectRegister: "script",
      // Self-hosted workbox runtime inlined into sw.js: no CDN importScripts.
      workbox: {
        inlineWorkboxRuntime: true,
        // App assets only. No .pdf, no runtimeCaching: a user's document is
        // never fetched over HTTP and must never reach a cache (docs/PRIVACY.md).
        globPatterns: ["**/*.{js,css,html,svg,woff2,wasm,traineddata}"],
        navigateFallback: "index.html",
      },
      manifest: {
        name: "PDF Suite",
        short_name: "PDF Suite",
        description: "A complete PDF suite where your files never leave your computer.",
        start_url: "/",
        display: "standalone",
        background_color: "#ffffff",
        theme_color: "#0f172a",
        icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
      },
    }),
  ],
});
