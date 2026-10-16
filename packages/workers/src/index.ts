export { createPdfWorker, createPdfWorkerClient } from "./client.js";
export type { OnProgress, PdfWorkerClient } from "./client.js";
export { CancelledError } from "./protocol.js";
export type {
  DocumentInfo,
  FieldValues,
  FormField,
  FormInfo,
  OcrAssets,
  RedactArea,
  RedactRect,
  SearchHit,
  WorkerRequest,
  WorkerResponse,
} from "./protocol.js";
