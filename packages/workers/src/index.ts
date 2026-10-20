export { createPdfWorker, createPdfWorkerClient } from "./client.js";
export type { OnProgress, PdfWorkerClient } from "./client.js";
export { CancelledError } from "./protocol.js";
export type {
  DocumentInfo,
  FieldValues,
  FormField,
  FormInfo,
  OcrAssets,
  EditableText,
  RedactArea,
  RedactRect,
  TextEdit,
  SearchHit,
  NumberFormat,
  Slots,
  StampOptions,
  WorkerRequest,
  WorkerResponse,
} from "./protocol.js";
