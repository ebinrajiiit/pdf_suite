# Brand assets

The FACTS-H Lab roundel, as supplied by the lab. `facts-h-dark.png` is the dark
ink for light backgrounds, `facts-h-light.png` the light ink for dark ones; both
are 1000 px square with a transparent background.

Everything the apps ship is derived from these two files, so the derivation is
written down rather than remembered. Run from the repo root, with `sips`, which
is part of macOS:

```sh
# The mark in the top bar (26 px on screen) and on the opening screen (72 px).
sips -Z 96  brand/facts-h-dark.png  --out apps/web/public/brand/mark-dark.png
sips -Z 96  brand/facts-h-light.png --out apps/web/public/brand/mark-light.png
sips -Z 256 brand/facts-h-dark.png  --out apps/web/public/brand/lockup-dark.png
sips -Z 256 brand/facts-h-light.png --out apps/web/public/brand/lockup-light.png

# Favicon and PWA icons. The art is line work on transparency, which disappears
# on a dark tab strip, so the icon is flattened onto white — a round trip
# through JPEG, which has no alpha, is the shortest way to do that with sips.
sips -s format jpeg -s formatOptions 95 -Z 512 brand/facts-h-dark.png --out /tmp/icon.jpg
sips -s format png /tmp/icon.jpg --out apps/web/public/brand/icon-512.png
sips -Z 192 apps/web/public/brand/icon-512.png --out apps/web/public/brand/icon-192.png
```

The desktop icons come from the same flattened art at 1024 px, kept as
`apps/desktop/src-tauri/icons/source.png` and regenerated with
`pnpm --filter @pdf-suite/desktop exec tauri icon src-tauri/icons/source.png`.
Delete the `android/` and `ios/` sets it writes; neither is a target (ADR 0005).
