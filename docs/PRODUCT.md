# Product brief — Signet

## One line
A complete PDF suite where your files never leave your computer.

## Who it is for
Universities, IIITs/NITs, hospitals, exam cells and government offices in India that handle sensitive documents (student records, results, patient files, confidential correspondence) and cannot send them to a foreign cloud.

## Why it wins against Adobe Acrobat
1. **Zero upload, verifiable.** Everything runs on the device. Users can switch off Wi-Fi and every feature except timestamps/eSign keeps working. The core is open source, so anyone can audit the claim.
2. **No data-processor role.** We never receive user data, which simplifies DPDP Act compliance for customers.
3. **Indic OCR.** Malayalam, Hindi and other Indian scripts are first-class. Sequencing note (2026-10-16): feature parity is being built in English first, with vernacular languages following — see the priority decision in `docs/ROADMAP.md`. What exists already works (Malayalam extraction is verified on real documents, and search matches either chillu spelling); the deferral is on further Indic-specific work, not on removing it.
4. **Indian signatures.** Class 3 DSC (USB token) and Aadhaar eSign.
5. **Institutional pricing.** A campus or site licence instead of per-seat subscriptions. Offline, machine-bound licensing (reuse the Ed25519 scheme from the lab's Exam Seating tool).
6. **Lab integration.** Batch workflows for grade cards, certificates and result sheets.

## Editions
| Edition | Includes | Licence |
| --- | --- | --- |
| Community | View, annotate, organize, compress, password protect (web + desktop) | Open source |
| Institution | Indic OCR, forms, redaction, DSC/PAdES signing, Office→PDF, batch folder processing | Commercial, site licence |
| Enterprise | Local AI, PDF/A + PDF/UA validation, priority support, custom workflows | Commercial |

## Explicit non-goals
- Cloud storage, cloud sync, online sharing links.
- Real-time multi-user collaboration.
- XFA forms (legacy; revisit only on customer demand).

## Branding rule
Never use "Adobe" or "Acrobat" in the product name, UI or marketing claims.

## Success measures (first 6 months)
- Renders the 1,000-file institutional corpus with no regressions.
- Live in 3 offices at IIIT Kottayam.
- First external institution signed.
