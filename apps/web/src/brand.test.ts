import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

// The product name is written in five places that nothing links together: the
// document title, the PWA manifest, the header on screen, and the desktop
// shell's bundle name, binary name and window title. Renaming all but one of
// them is the failure this catches — the app would answer to two names at once.
const NAME = "Signet";

test("every surface shows the same product name", () => {
  const surfaces: [string, string | undefined][] = [
    ["index.html <title>", /<title>([^<]+)<\/title>/.exec(read("../index.html"))?.[1]],
    ["manifest name", /\bname: "([^"]+)"/.exec(read("../vite.config.ts"))?.[1]],
    ["manifest short_name", /short_name: "([^"]+)"/.exec(read("../vite.config.ts"))?.[1]],
    ["the header on screen", /className="brand-name">([^<]+)</.exec(read("./App.tsx"))?.[1]],
  ];

  const tauri = JSON.parse(read("../../desktop/src-tauri/tauri.conf.json")) as {
    productName: string;
    mainBinaryName: string;
    app: { windows: { title: string }[] };
  };
  surfaces.push(["tauri productName", tauri.productName]);
  surfaces.push(["tauri window title", tauri.app.windows[0]?.title]);
  // The crate is still pdf-suite, so without this the process in Activity
  // Monitor and in a crash report carries the codename.
  surfaces.push(["tauri mainBinaryName", tauri.mainBinaryName]);

  for (const [where, found] of surfaces) {
    expect(found, `no product name found in ${where}`).toBeTruthy();
    expect(found, `${where} does not carry the product name`).toContain(NAME);
  }
});

// The lab's name belongs on the window and the installer, not only in the repo.
test("the lab is credited where the name is shown in full", () => {
  expect(read("../index.html")).toContain("FACTS-H Lab");
  expect(read("../vite.config.ts")).toContain("FACTS-H Lab");
  expect(read("../../desktop/src-tauri/tauri.conf.json")).toContain("FACTS-H Lab");
});
