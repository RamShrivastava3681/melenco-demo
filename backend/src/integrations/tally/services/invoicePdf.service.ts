/**
 * Phase 6: invoice PDF with the e-way bill attached (mirrors the PDF 2 example:
 * page 1 = TAX INVOICE e-Invoice, page 2 = e-Way Bill).
 *
 * Zero-dependency PDF writer (raw PDF 1.4, Helvetica only) so the endpoint
 * works without new native packages. Every mock result is labelled
 * `Environment: MOCK / Legally Valid: NO` — a TEST e-way bill is never
 * presented as legally valid.
 */

export interface InvoicePdfItem {
  description: string;
  hsn: string;
  quantity: number;
  unit: string;
  rateInclTax: number;
  rate: number;
  amount: number;
}

export interface InvoiceEwbPdfData {
  sellerName: string;
  sellerGstin: string;
  sellerState: string;
  sellerEmail: string;
  buyerName: string;
  buyerAddress: string;
  buyerGstin: string;
  buyerState: string;
  invoiceNumber: string;
  invoiceDate: string;
  ewayBillNumber: string | null;
  irn: string | null;
  ackNumber: string | null;
  ackDate: string | null;
  deliveryNote: string;
  paymentTerms: string;
  dispatchedThrough: string;
  destination: string;
  items: InvoicePdfItem[];
  taxableValue: number;
  gstRate: number;
  gstAmount: number;
  invoiceTotal: number;
  transportMode: string;
  transporterId: string | null;
  transporterName: string | null;
  transportDocNumber: string | null;
  transportDocDate: string | null;
  vehicleNumber: string | null;
  distanceKm: number | null;
  generatedDate: string | null;
  validUntil: string | null;
  supplyType: string;
  transactionType: string;
  environment: string;
  legallyValid: boolean;
}

// ---------------------------------------------------------------------------
// Indian number-to-words (integer part; paise appended when present)
// ---------------------------------------------------------------------------

const ONES = [
  "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
  "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen",
  "Seventeen", "Eighteen", "Nineteen",
];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function twoDigits(n: number): string {
  if (n < 20) return ONES[n];
  return TENS[Math.floor(n / 10)] + (n % 10 ? ` ${ONES[n % 10]}` : "");
}

function threeDigits(n: number): string {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  return `${h ? `${ONES[h]} Hundred${rest ? " " : ""}` : ""}${rest ? twoDigits(rest) : ""}`.trim();
}

export function amountInWords(amount: number): string {
  const n = Math.round(Number(amount) * 100) / 100;
  const int = Math.floor(n);
  const paise = Math.round((n - int) * 100);
  const parts: string[] = [];
  const crore = Math.floor(int / 10000000);
  const lakh = Math.floor((int % 10000000) / 100000);
  const thousand = Math.floor((int % 100000) / 1000);
  const rest = int % 1000;
  if (crore) parts.push(`${threeDigits(crore)} Crore`);
  if (lakh) parts.push(`${twoDigits(lakh)} Lakh`);
  if (thousand) parts.push(`${twoDigits(thousand)} Thousand`);
  if (rest) parts.push(threeDigits(rest));
  if (parts.length === 0) parts.push("Zero");
  let words = parts.join(" ").replace(/\s+/g, " ").trim();
  if (paise) words += ` and Paise ${twoDigits(paise)}`;
  return `INR ${words} Only`;
}

// ---------------------------------------------------------------------------
// Minimal PDF writer (A4, Helvetica / Helvetica-Bold)
// ---------------------------------------------------------------------------

function ascii(s: unknown): string {
  return String(s ?? "")
    .replace(/₹/g, "Rs. ")
    .replace(/[—–]/g, "-")
    .replace(/[^ -~]/g, "")
    .trim();
}

function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

const PAGE_W = 595;
const PAGE_H = 842;

class Page {
  ops: string[] = [];
  y = PAGE_H - 36;

  text(x: number, str: string, size = 9, bold = false): void {
    const yy = this.y;
    this.ops.push(`BT /${bold ? "HB" : "H"} ${size} Tf ${x.toFixed(1)} ${yy.toFixed(1)} Td (${esc(ascii(str))}) Tj ET`);
  }

  /** Text at an absolute position (does not move the cursor). */
  at(x: number, yFromTop: number, str: string, size = 9, bold = false): void {
    const yy = PAGE_H - yFromTop;
    this.ops.push(`BT /${bold ? "HB" : "H"} ${size} Tf ${x.toFixed(1)} ${yy.toFixed(1)} Td (${esc(ascii(str))}) Tj ET`);
  }

  gap(h: number): void {
    this.y -= h;
  }

  hline(x1: number, x2: number, width = 0.7): void {
    this.ops.push(`${width} w ${x1.toFixed(1)} ${this.y.toFixed(1)} m ${x2.toFixed(1)} ${this.y.toFixed(1)} l S`);
  }

  line(x1: number, y1Top: number, x2: number, y2Top: number, width = 0.7): void {
    this.ops.push(
      `${width} w ${x1.toFixed(1)} ${(PAGE_H - y1Top).toFixed(1)} m ${x2.toFixed(1)} ${(PAGE_H - y2Top).toFixed(1)} l S`
    );
  }

  box(x: number, yTop: number, w: number, h: number, width = 0.7): void {
    this.ops.push(`${width} w ${x.toFixed(1)} ${(PAGE_H - yTop - h).toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)} re S`);
  }

  fillBar(x: number, yTop: number, w: number, h: number, gray: number): void {
    this.ops.push(`${gray.toFixed(2)} g ${x.toFixed(1)} ${(PAGE_H - yTop - h).toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)} re f 0 g`);
  }
}

function kvRow(p: Page, label: string, value: string, x: number, labelW: number, size = 8.5): void {
  p.text(x, label, size, true);
  const v = ascii(value) || "-";
  // crude two-column: value after label width
  const maxChars = 88;
  p.at(x + labelW, PAGE_H - p.y, v.slice(0, maxChars), size, false);
  p.gap(12);
}

const money = (n: number | null | undefined): string =>
  n === null || n === undefined || !Number.isFinite(Number(n))
    ? "-"
    : Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ---------------------------------------------------------------------------
// Page 1: TAX INVOICE
// ---------------------------------------------------------------------------

function renderInvoicePage(d: InvoiceEwbPdfData): Page {
  const p = new Page();
  const L = 36;
  const R = PAGE_W - 36;
  const W = R - L;

  if (d.environment === "MOCK") {
    p.fillBar(L, 28, W, 16, 0.9);
    p.at(L + 6, 32, "TEST DOCUMENT - MOCK E-WAY BILL WORKFLOW - NOT LEGALLY VALID", 8.5, true);
    p.y = PAGE_H - 52;
  }

  // Title bar
  p.fillBar(L, PAGE_H - p.y - 20, W, 20, 0.88);
  p.at(L + W / 2 - 52, PAGE_H - p.y - 6, "TAX INVOICE", 13, true);
  p.at(R - 52, PAGE_H - p.y - 4, "e-Invoice", 8, true);
  p.gap(26);

  p.box(L, PAGE_H - p.y - 46, W, 46);
  kvRow(p, "IRN  : ", d.irn ?? "-", L + 4, 200, 7.5);
  kvRow(p, "Ack No. : ", d.ackNumber ?? "-", L + 4, 200, 7.5);
  kvRow(p, "Ack Date : ", d.ackDate ?? d.invoiceDate, L + 4, 200, 7.5);
  p.gap(2);
  p.box(R - 74, PAGE_H - p.y - 18, 62, 52);
  p.at(R - 66, PAGE_H - p.y - 6, "QR", 9, true);
  p.gap(58);

  // Seller (left) + invoice meta (right)
  const metaX = L + 300;
  const metaTop = PAGE_H - p.y;
  p.box(L, metaTop, 290, 62);
  p.at(L + 4, metaTop + 4, d.sellerName, 9, true);
  p.at(L + 4, metaTop + 16, `GSTIN/UIN: ${d.sellerGstin || "-"}`, 7.5, false);
  p.at(L + 4, metaTop + 27, `State Name : ${d.sellerState}`, 7.5, false);
  p.at(L + 4, metaTop + 38, `E-Mail : ${d.sellerEmail || "-"}`, 7.5, false);

  const meta: Array<[string, string]> = [
    ["Invoice No.", d.invoiceNumber],
    ["e-Way Bill No.", d.ewayBillNumber ?? "PENDING"],
    ["Dated", d.invoiceDate],
    ["Delivery Note", d.deliveryNote || "-"],
    ["Mode/Terms of Payment", d.paymentTerms || "-"],
    ["Dispatched through", d.dispatchedThrough || "-"],
    ["Destination", d.destination || "-"],
  ];
  let my = metaTop;
  p.box(metaX, my, W - 300, meta.length * 13 + 4);
  meta.forEach(([k, v]) => {
    p.at(metaX + 4, my + 3, k, 7, true);
    p.at(metaX + 118, my + 3, ascii(v).slice(0, 34), 7.5, false);
    my += 13;
  });
  p.y = PAGE_H - (my + 6);

  // Consignee + Buyer
  const cbTop = PAGE_H - p.y;
  p.box(L, cbTop, W, 76);
  p.at(L + 4, cbTop + 3, "Consignee (Ship to)", 8, true);
  p.at(L + 4, cbTop + 15, d.buyerName, 8, true);
  p.at(L + 4, cbTop + 27, ascii(d.buyerAddress).slice(0, 95), 7.5, false);
  p.at(L + 4, cbTop + 39, `GSTIN/UIN : ${d.buyerGstin || "-"}`, 7.5, false);
  p.at(L + 4, cbTop + 51, `State Name : ${d.buyerState}`, 7.5, false);
  p.at(L + 4, cbTop + 63, "Buyer (Bill to)  —  same as consignee", 7, false);
  p.y = PAGE_H - (cbTop + 82);

  // Items table
  const cols = [28, 220, 62, 52, 62, 52, 34, 62]; // Sl, Desc, HSN, Qty, RateIncl, Rate, per, Amount
  const tTop = PAGE_H - p.y;
  const head = ["Sl No.", "Description of Goods", "HSN/SAC", "Quantity", "Rate (Incl. of Tax)", "Rate", "per", "Amount"];
  let cx = L;
  p.fillBar(L, tTop, W, 24, 0.88);
  head.forEach((h, i) => {
    p.at(cx + 2, tTop + 5, h, 6.5, true);
    cx += cols[i];
  });
  let ry = tTop + 24;
  const rowH = 26;
  d.items.forEach((it, idx) => {
    p.box(L, ry, W, rowH, 0.5);
    let x = L;
    const cells = [
      String(idx + 1),
      ascii(it.description).slice(0, 52),
      ascii(it.hsn),
      `${it.quantity} ${ascii(it.unit)}`,
      money(it.rateInclTax),
      money(it.rate),
      ascii(it.unit),
      money(it.amount),
    ];
    cells.forEach((c, i) => {
      p.at(x + 2, ry + 6, c, i === 1 ? 6.5 : 7.5, false);
      x += cols[i];
    });
    ry += rowH;
  });
  // totals
  p.box(L, ry, W, 16, 0.5);
  p.at(L + cols[0] + cols[1] + cols[2] + cols[3] + 2, ry + 3, "IGST OUTPUT TAX", 7.5, true);
  p.at(L + W - 60, ry + 3, money(d.gstAmount), 7.5, true);
  ry += 16;
  p.fillBar(L, ry, W, 16, 0.88);
  p.at(L + 4, ry + 3, "Total", 8, true);
  p.at(L + W - 60, ry + 3, money(d.invoiceTotal), 8, true);
  ry += 16;
  p.y = PAGE_H - (ry + 4);

  p.text(L, `Amount Chargeable (in words): ${amountInWords(d.invoiceTotal)}`, 7.5, true);
  p.gap(14);
  p.text(L, `HSN ${d.items[0]?.hsn ?? "-"}  Taxable ${money(d.taxableValue)}  Rate ${d.gstRate}%  IGST ${money(d.gstAmount)}`, 7.5, false);
  p.gap(13);
  p.text(L, `Tax Amount (in words) : ${amountInWords(d.gstAmount)}`, 7.5, true);
  p.gap(14);
  const dTop = PAGE_H - p.y;
  p.box(L, dTop, W, 40);
  p.at(L + 4, dTop + 3, "Declaration / Company's Bank Details", 7.5, true);
  p.at(R - 120, dTop + 20, `for ${d.sellerName}`, 8, true);
  p.at(R - 118, dTop + 32, "Authorised Signatory", 7, false);
  p.y = PAGE_H - (dTop + 46);
  p.text(L, "This is a Computer Generated Invoice", 7.5, false);
  p.gap(10);
  if (d.environment === "MOCK") {
    p.text(L, `Environment: MOCK   Legally Valid: NO   IRN: ${d.irn ?? "-"}`, 7.5, true);
    p.gap(12);
  }
  p.text(L, "Page 1 of 2 - TAX INVOICE", 7, false);
  return p;
}

// ---------------------------------------------------------------------------
// Page 2: e-Way Bill
// ---------------------------------------------------------------------------

function renderEwbPage(d: InvoiceEwbPdfData): Page {
  const p = new Page();
  const L = 36;
  const R = PAGE_W - 36;
  const W = R - L;

  if (d.environment === "MOCK") {
    p.fillBar(L, 28, W, 16, 0.9);
    p.at(L + 6, 32, "TEST E-WAY BILL - MOCK - NOT LEGALLY VALID", 8.5, true);
    p.y = PAGE_H - 52;
  }

  p.fillBar(L, PAGE_H - p.y - 20, W, 20, 0.88);
  p.at(L + W / 2 - 42, PAGE_H - p.y - 6, "e-Way Bill", 13, true);
  p.at(R - 52, PAGE_H - p.y - 4, "e-Way Bill", 8, true);
  p.gap(26);

  const head: Array<[string, string]> = [
    ["Doc No.", `Tax Invoice - ${d.invoiceNumber}`],
    ["Date", d.invoiceDate],
    ["IRN", d.irn ?? "-"],
    ["Ack Date", d.ackDate ?? d.invoiceDate],
  ];
  head.forEach(([k, v]) => {
    p.text(L, `${k} : ${ascii(v).slice(0, 80)}`, 8, false);
    p.gap(12);
  });
  p.gap(2);

  // 1. e-Way Bill Details
  p.fillBar(L, PAGE_H - p.y - 16, W, 16, 0.88);
  p.at(L + 4, PAGE_H - p.y - 12, "1. e-Way Bill Details", 8.5, true);
  p.gap(18);
  const det: Array<[string, string, string, string]> = [
    ["e-Way Bill No.", d.ewayBillNumber ?? "PENDING", "Mode", d.transportMode],
    [`Generated Date`, d.generatedDate ?? "-", "Approx Distance", d.distanceKm != null ? `${d.distanceKm} KM` : "-"],
    ["Generated By", d.sellerName.slice(0, 30), "Valid Upto", d.validUntil ?? "-"],
    ["Supply Type", d.supplyType, "Transaction Type", d.transactionType],
  ];
  det.forEach(([k1, v1, k2, v2]) => {
    p.at(L + 4, PAGE_H - p.y - 9, k1, 7.5, true);
    p.at(L + 92, PAGE_H - p.y - 9, ascii(v1).slice(0, 26), 7.5, false);
    p.at(L + 250, PAGE_H - p.y - 9, k2, 7.5, true);
    p.at(L + 340, PAGE_H - p.y - 9, ascii(v2).slice(0, 26), 7.5, false);
    p.gap(13);
  });
  p.gap(2);

  // 2. Address Details
  p.fillBar(L, PAGE_H - p.y - 16, W, 16, 0.88);
  p.at(L + 4, PAGE_H - p.y - 12, "2. Address Details", 8.5, true);
  p.gap(18);
  const aTop = PAGE_H - p.y;
  p.box(L, aTop, W / 2, 52);
  p.box(L + W / 2, aTop, W / 2, 52);
  p.at(L + 4, aTop + 3, "From", 8, true);
  p.at(L + 4, aTop + 15, ascii(d.sellerName).slice(0, 40), 7.5, false);
  p.at(L + 4, aTop + 27, `GSTIN : ${d.sellerGstin || "-"}`, 7.5, false);
  p.at(L + 4, aTop + 39, "Dispatch From", 7.5, false);
  p.at(L + W / 2 + 4, aTop + 3, "To", 8, true);
  p.at(L + W / 2 + 4, aTop + 15, ascii(d.buyerName).slice(0, 40), 7.5, false);
  p.at(L + W / 2 + 4, aTop + 27, `GSTIN : ${d.buyerGstin || "-"}`, 7.5, false);
  p.at(L + W / 2 + 4, aTop + 39, ascii(d.buyerAddress).slice(0, 44), 7.5, false);
  p.y = PAGE_H - (aTop + 58);

  // 3. Goods Details
  p.fillBar(L, PAGE_H - p.y - 16, W, 16, 0.88);
  p.at(L + 4, PAGE_H - p.y - 12, "3. Goods Details", 8.5, true);
  p.gap(18);
  const gcols = [70, 255, 70, 80, 48];
  const gTop = PAGE_H - p.y;
  p.fillBar(L, gTop, W, 22, 0.9);
  const ghead = ["HSN Code", "Product Name & Desc", "Quantity", "Taxable Amt", "Tax Rate"];
  let gx = L;
  ghead.forEach((h, i) => {
    p.at(gx + 2, gTop + 5, h, 6.5, true);
    gx += gcols[i];
  });
  let gy = gTop + 22;
  d.items.forEach((it) => {
    p.box(L, gy, W, 24, 0.5);
    let x = L;
    const cells = [
      ascii(it.hsn),
      ascii(it.description).slice(0, 60),
      `${it.quantity} ${ascii(it.unit)}`,
      money(it.amount),
      String(d.gstRate),
    ];
    cells.forEach((c, i) => {
      p.at(x + 2, gy + 5, c, 7, false);
      x += gcols[i];
    });
    gy += 24;
  });
  p.at(L + 4, gy + 3, `Tot.Taxable Amt : ${money(d.taxableValue)}  Other Amt : 0  Total Inv Amt : ${money(d.invoiceTotal)}`, 7.5, true);
  gy += 14;
  p.at(L + 4, gy + 3, `IGST Amt : ${money(d.gstAmount)}`, 7.5, true);
  gy += 16;
  p.y = PAGE_H - (gy + 2);

  // 4. Transportation Details
  p.fillBar(L, PAGE_H - p.y - 16, W, 16, 0.88);
  p.at(L + 4, PAGE_H - p.y - 12, "4. Transportation Details", 8.5, true);
  p.gap(18);
  p.at(L + 4, PAGE_H - p.y - 9, "Transporter ID", 7.5, true);
  p.at(L + 100, PAGE_H - p.y - 9, ascii(d.transporterId ?? "-"), 7.5, false);
  p.at(L + 250, PAGE_H - p.y - 9, "Doc No.", 7.5, true);
  p.at(L + 340, PAGE_H - p.y - 9, ascii(d.transportDocNumber ?? "-"), 7.5, false);
  p.gap(13);
  p.at(L + 4, PAGE_H - p.y - 9, "Name", 7.5, true);
  p.at(L + 100, PAGE_H - p.y - 9, ascii(d.transporterName ?? "-").slice(0, 26), 7.5, false);
  p.at(L + 250, PAGE_H - p.y - 9, "Date", 7.5, true);
  p.at(L + 340, PAGE_H - p.y - 9, ascii(d.transportDocDate ?? "-"), 7.5, false);
  p.gap(16);

  // 5. Vehicle Details
  p.fillBar(L, PAGE_H - p.y - 16, W, 16, 0.88);
  p.at(L + 4, PAGE_H - p.y - 12, "5. Vehicle Details", 8.5, true);
  p.gap(18);
  p.at(L + 4, PAGE_H - p.y - 9, "Vehicle No.", 7.5, true);
  p.at(L + 100, PAGE_H - p.y - 9, ascii(d.vehicleNumber ?? "-"), 7.5, false);
  p.gap(16);

  if (d.environment === "MOCK") {
    p.fillBar(L, PAGE_H - p.y - 18, W, 18, 0.9);
    p.at(L + 6, PAGE_H - p.y - 13, "Environment: MOCK    Legally Valid: NO", 8, true);
    p.gap(22);
  }
  p.text(L, "Page 2 of 2 - e-Way Bill", 7, false);
  return p;
}

// ---------------------------------------------------------------------------
// Assemble + serialize
// ---------------------------------------------------------------------------

function serialize(pages: Page[]): Buffer {
  // Object numbering: 1=catalog, 2=pages, 3=Helvetica, 4=Helvetica-Bold,
  // then one page + content pair per page.
  const objs: string[] = [];
  const pNums: number[] = [];
  const cNums: number[] = [];
  for (let i = 0; i < pages.length; i++) {
    pNums.push(5 + i * 2);
    cNums.push(6 + i * 2);
  }
  objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objs[2] = `<< /Type /Pages /Kids [${pNums.map((n) => `${n} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objs[3] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;
  objs[4] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>`;
  pages.forEach((pg, i) => {
    const stream = pg.ops.join("\n");
    const len = Buffer.byteLength(stream, "utf8");
    objs[cNums[i]] = `<< /Length ${len} >>\nstream\n${stream}\nendstream`;
    objs[pNums[i]] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
      `/Resources << /Font << /H 3 0 R /HB 4 0 R >> >> /Contents ${cNums[i]} 0 R >>`;
  });

  const max = 4 + pages.length * 2;
  let out = `%PDF-1.4\n`;
  const offsets: number[] = [0];
  for (let n = 1; n <= max; n++) {
    offsets[n] = Buffer.byteLength(out, "utf8");
    out += `${n} 0 obj\n${objs[n]}\nendobj\n`;
  }
  const xrefAt = Buffer.byteLength(out, "utf8");
  out += `xref\n0 ${max + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= max; n++) {
    out += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${max + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF`;
  return Buffer.from(out, "utf8");
}

export function buildInvoiceEwayPdf(data: InvoiceEwbPdfData): Buffer {
  return serialize([renderInvoicePage(data), renderEwbPage(data)]);
}
