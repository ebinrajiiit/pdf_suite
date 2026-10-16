// Typed worker protocol: every request carries an id so it can be cancelled and
// report progress. Request/response payloads grow as ops land in Phase 1.

export type WorkerRequest = { id: number } & (
  { kind: "open"; bytes: ArrayBuffer } | { kind: "cancel" }
);

export type WorkerResponse = { id: number } & (
  | { kind: "progress"; done: number; total: number }
  | { kind: "error"; message: string }
  | { kind: "cancelled" }
);
