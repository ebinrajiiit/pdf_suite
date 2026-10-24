// The public try-it-out build, which is a different artifact from the one the
// rest of this suite exercises. It is skipped unless a trial build is being
// served, and the trial workflow is what serves one.
import { test, expect } from "@playwright/test";
import { PDFDocument, StandardFonts } from "pdf-lib";

test.skip(process.env.SIGNET_TRIAL !== "1", "needs a build made with SIGNET_TRIAL=1");

async function markSheet(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([595, 842]).drawText("Provisional Mark Sheet", { x: 60, y: 760, size: 16, font });
  return Buffer.from(await doc.save());
}

test("the trial lets you work and will not hand the file back", async ({ page }) => {
  // A download is the thing that must not happen: it would mean the trial
  // handed over a document someone should have installed the app to get.
  const downloads: string[] = [];
  page.on("download", (download) => downloads.push(download.suggestedFilename()));

  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("Ready", { timeout: 30_000 });

  // Said up front, not discovered at the last step.
  await expect(page.locator(".brand-trial")).toHaveText("Try it");

  await page.setInputFiles('[data-testid="open-input"]', {
    name: "marks.pdf",
    mimeType: "application/pdf",
    buffer: await markSheet(),
  });
  await expect(page.getByTestId("page-box")).toContainText("Page 1 of 1");

  // The work itself is not restricted — only taking it away is.
  await page.getByTestId("tool-highlight").click();
  await expect(page.getByTestId("tool-highlight")).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "Save" }).click();
  const explains = page.getByTestId("trial");
  await expect(explains.getByRole("heading")).toHaveText("Install Signet to keep your work");
  await expect(explains.getByRole("link", { name: "Download Signet" })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(explains).toBeHidden();

  // Printing is the other way a file leaves.
  await page.getByTestId("print").click();
  await expect(page.getByTestId("trial")).toBeVisible();

  await page.waitForTimeout(1000);
  expect(downloads).toEqual([]);
});
