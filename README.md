# PDF Suite (codename) — FACTS-H Lab, IIIT Kottayam

A complete PDF suite where your files never leave your computer. All viewing, editing, OCR, conversion and signing run on your device.

## Status
Phase 0 — foundations. See `docs/ROADMAP.md`.

## Getting started (macOS)

```bash
# Prerequisites
brew install node pnpm          # Node 20+, pnpm 9+
# Later, for the desktop app (Phase 2):
# xcode-select --install && curl https://sh.rustup.rs -sSf | sh

git init && git add . && git commit -m "Project scaffold"
claude                          # start Claude Code in this folder
```

Then paste the prompt from `KICKOFF.md` into Claude Code.

## Docs
- `CLAUDE.md` — rules for Claude Code (privacy, licences, conventions)
- `docs/PRODUCT.md` — who it's for and why it wins
- `docs/ARCHITECTURE.md` — zero-upload design and package layout
- `docs/ROADMAP.md` — phases and checklists
- `docs/PRIVACY.md` — what may and may not cross the network
- `docs/LICENSE-POLICY.md` — dependency allow-list
- `docs/adr/` — architecture decision records
