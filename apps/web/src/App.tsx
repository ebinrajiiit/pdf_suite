import { useState } from "react";
import type { PdfEngine } from "@pdf-suite/engine";

export function App() {
  // Set once the Phase 0 spike picks an adapter (ADR 0002).
  const [engine] = useState<PdfEngine | null>(null);

  return (
    <main>
      <h1>PDF Suite</h1>
      <p>
        Every operation runs on this device. Phase 0 — foundations. Engine:{" "}
        <code>{engine ? "loaded" : "not selected yet (ADR 0002)"}</code>.
      </p>
    </main>
  );
}
