# Privacy model

## The promise
**Your files never leave your device.** Every feature runs locally. Switch off your network and the app keeps working, except the few features below that, by their nature, need a third party, and even those send only a fingerprint (hash) of the document, never the document.

## What may cross the network

| Call | When | What is sent | What is never sent |
| --- | --- | --- | --- |
| App load / update (web) | Opening the PWA | Request for the app's own static files | Anything about documents |
| Update check (desktop) | Opt-in, at launch | App version, OS | Documents, usage |
| Language pack / AI model download | User clicks "Download" | Request for the file | Documents |
| Trusted timestamp (RFC 3161) | User signs with timestamp | SHA-256 hash of the signature | The document |
| Aadhaar eSign | User chooses eSign | Document hash, Aadhaar auth via ESP | The document |

Nothing else. Any new network call requires an ADR and an update to this table.

## What is never done
- No analytics, telemetry, crash reporting or usage pings.
- No third-party scripts, fonts or CDNs at runtime.
- No document content in logs. Logs stay local and are off by default.
- No caching of documents in the PWA service worker.

## How this is enforced
1. **CSP:** `default-src 'self'; connect-src 'self'; script-src 'self' 'wasm-unsafe-eval'; img-src 'self' blob: data:; worker-src 'self' blob:`.
2. **Offline e2e test** (`e2e/offline.spec.ts`): exercises open, render, merge and save, and fails on any request to a non-self origin.
3. **Desktop:** Tauri capability allow-list grants no HTTP scope except the timestamp/eSign endpoints, used only from signing commands.
4. **Open-source core:** anyone can audit the claim.

## Legal positioning (to confirm with counsel)
Because we never receive or process users' documents, we are not a data processor for that content under India's DPDP Act. Customers keep full control. Have a lawyer confirm this wording before using it in marketing.
