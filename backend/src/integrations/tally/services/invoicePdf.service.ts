/**
 * Phase 6: invoice PDF with the e-way bill attached (mirrors the PDF 2 example:
 * page 1 = TAX INVOICE e-Invoice, page 2 = e-Way Bill).
 *
 * Zero-dependency PDF writer (raw PDF 1.4, Helvetica only) so the endpoint
 * works without new native packages. Tables use real grid lines with wrapped
 * text and right-aligned money columns. Every mock result is labelled
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
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^ -~]/g, "")
    .trim();
}

function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

const PAGE_W = 595;
const PAGE_H = 842;

/** Rough Helvetica advance: average glyph ≈ 0.52 × font size. */
function textWidth(s: string, size: number): number {
  return ascii(s).length * size * 0.52;
}

/** Wrap text to lines that fit maxW points at the given size. */
function wrapText(s: string, size: number, maxW: number): string[] {
  const words = ascii(s).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];
  const maxChars = Math.max(6, Math.floor(maxW / (size * 0.52)));
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (w.length > maxChars) {
      if (cur) {
        lines.push(cur);
        cur = "";
      }
      for (let i = 0; i < w.length; i += maxChars) lines.push(w.slice(i, i + maxChars));
      continue;
    }
    const next = cur ? `${cur} ${w}` : w;
    if (next.length > maxChars) {
      lines.push(cur);
      cur = w;
    } else {
      cur = next;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

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

  /** Right-aligned text ending at xRight, at absolute position. */
  atRight(xRight: number, yFromTop: number, str: string, size = 9, bold = false): void {
    this.at(xRight - textWidth(str, size), yFromTop, str, size, bold);
  }

  /** Centered text within [x, x+w], at absolute position. */
  atCenter(x: number, w: number, yFromTop: number, str: string, size = 9, bold = false): void {
    this.at(x + (w - textWidth(str, size)) / 2, yFromTop, str, size, bold);
  }

  gap(h: number): void {
    this.y -= h;
  }

  line(x1: number, y1Top: number, x2: number, y2Top: number, width = 0.7): void {
    this.ops.push(
      `${width} w ${x1.toFixed(1)} ${(PAGE_H - y1Top).toFixed(1)} m ${x2.toFixed(1)} ${(PAGE_H - y2Top).toFixed(1)} l S`
    );
  }

  vline(x: number, yTop: number, h: number, width = 0.5): void {
    this.line(x, yTop, x, yTop + h, width);
  }

  box(x: number, yTop: number, w: number, h: number, width = 0.7): void {
    this.ops.push(`${width} w ${x.toFixed(1)} ${(PAGE_H - yTop - h).toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)} re S`);
  }

  fillBar(x: number, yTop: number, w: number, h: number, gray: number): void {
    this.ops.push(`${gray.toFixed(2)} g ${x.toFixed(1)} ${(PAGE_H - yTop - h).toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)} re f 0 g`);
  }
}

const money = (n: number | null | undefined): string =>
  n === null || n === undefined || !Number.isFinite(Number(n))
    ? "-"
    : Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ---------------------------------------------------------------------------
// Grid table with wrapped cells, column dividers and aligned numerics
// ---------------------------------------------------------------------------

interface GridCol {
  w: number;
  head: string;
  align?: "l" | "r" | "c";
}

function gridTable(
  p: Page,
  x: number,
  yTop: number,
  cols: GridCol[],
  rows: string[][],
  opts: { size?: number; headSize?: number; lineH?: number; pad?: number } = {}
): number {
  const size = opts.size ?? 7.5;
  const headSize = opts.headSize ?? 7;
  const lineH = opts.lineH ?? size + 3.5;
  const pad = opts.pad ?? 3;
  const totalW = cols.reduce((s, c) => s + c.w, 0);

  // Header (auto-sized for wrapped headings)
  const headWrapped = cols.map((c) => wrapText(c.head, headSize, c.w - pad * 2).slice(0, 3));
  const headH = Math.max(1, ...headWrapped.map((w) => w.length)) * lineH + pad;
  p.fillBar(x, yTop, totalW, headH, 0.88);
  let cx = x;
  cols.forEach((c, ci) => {
    headWrapped[ci].forEach((ln, li) => {
      if (c.align === "r") p.atRight(cx + c.w - pad, yTop + 3 + li * lineH, ln, headSize, true);
      else if (c.align === "c") p.atCenter(cx, c.w, yTop + 3 + li * lineH, ln, headSize, true);
      else p.at(cx + pad, yTop + 3 + li * lineH, ln, headSize, true);
    });
    cx += c.w;
  });
  let ry = yTop + headH;

  // Body rows
  rows.forEach((row) => {
    const wrapped = row.map((cell, i) => wrapText(cell, size, cols[i].w - pad * 2));
    const maxLines = Math.max(1, ...wrapped.map((w) => w.length));
    const rowH = maxLines * lineH + pad;
    // vertical dividers (span header + all rows: drawn per row segment)
    let vx = x;
    cols.forEach((c) => {
      p.vline(vx, ry, rowH, 0.5);
      vx += c.w;
    });
    p.vline(vx, ry, rowH, 0.5);
    wrapped.forEach((lines, i) => {
      lines.forEach((ln, li) => {
        if (cols[i].align === "r") p.atRight(x + colX(cols, i) + cols[i].w - pad, ry + 2 + li * lineH, ln, size, false);
        else if (cols[i].align === "c") p.atCenter(x + colX(cols, i), cols[i].w, ry + 2 + li * lineH, ln, size, false);
        else p.at(x + colX(cols, i) + pad, ry + 2 + li * lineH, ln, size, false);
      });
    });
    // row bottom line
    p.line(x, ry + rowH, x + totalW, ry + rowH, 0.5);
    ry += rowH;
  });

  // header vertical dividers + top/bottom frame lines
  let hx = x;
  cols.forEach((c) => {
    p.vline(hx, yTop, headH, 0.5);
    hx += c.w;
  });
  p.vline(hx, yTop, headH, 0.5);
  p.line(x, yTop, x + totalW, yTop, 0.7);
  return ry;
}

function colX(cols: GridCol[], i: number): number {
  let s = 0;
  for (let k = 0; k < i; k++) s += cols[k].w;
  return s;
}

/** Label + wrapped value row inside a bordered box; returns new yTop. */
function fieldBox(
  p: Page,
  x: number,
  yTop: number,
  w: number,
  fields: Array<[string, string]>,
  opts: { size?: number; labelW?: number } = {}
): number {
  const size = opts.size ?? 7.5;
  const labelW = opts.labelW ?? 118;
  const lineH = size + 3.5;
  const pad = 4;
  let ry = yTop + pad;
  // measure
  const blocks = fields.map(([k, v]) => ({ k, lines: wrapText(v || "-", size, w - labelW - pad * 2) }));
  const totalH = blocks.reduce((s, b) => s + Math.max(1, b.lines.length) * lineH, 0) + pad * 2;
  p.box(x, yTop, w, totalH, 0.7);
  p.vline(x + labelW, yTop, totalH, 0.5);
  blocks.forEach((b) => {
    p.at(x + pad, ry + 1, b.k, size, true);
    b.lines.forEach((ln, li) => {
      p.at(x + labelW + pad, ry + 1 + li * lineH, ln, size, false);
    });
    ry += Math.max(1, b.lines.length) * lineH;
  });
  return yTop + totalH;
}

/** Mock banner strip; returns height consumed. */
function mockBanner(p: Page, x: number, yTop: number, w: number, text: string): number {
  p.fillBar(x, yTop, w, 17, 0.82);
  p.box(x, yTop, w, 17, 0.7);
  p.atCenter(x, w, yTop + 4.5, text, 8, true);
  return 17;
}

/** Title bar; returns height consumed. */
function titleBar(p: Page, x: number, yTop: number, w: number, title: string, right: string): number {
  p.fillBar(x, yTop, w, 22, 0.88);
  p.box(x, yTop, w, 22, 0.7);
  p.atCenter(x, w, yTop + 5, title, 13, true);
  p.atRight(x + w - 6, yTop + 7, right, 8, true);
  return 22;
}

// ---------------------------------------------------------------------------
// Page 1: TAX INVOICE
// ---------------------------------------------------------------------------

function renderInvoicePage(d: InvoiceEwbPdfData): Page {
  const p = new Page();
  const L = 36;
  const R = PAGE_W - 36;
  const W = R - L;
  let y = 28;

  if (d.environment === "MOCK") {
    y += mockBanner(p, L, y, W, "TEST DOCUMENT - MOCK E-WAY BILL WORKFLOW - NOT LEGALLY VALID") + 4;
  }
  y += titleBar(p, L, y, W, "TAX INVOICE", "e-Invoice") + 4;

  // IRN block (full width, QR box docked right)
  const irnFields: Array<[string, string]> = [
    ["IRN", d.irn ?? "-"],
    ["Ack No.", d.ackNumber ?? "-"],
    ["Ack Date", d.ackDate ?? d.invoiceDate],
  ];
  const qrW = 66;
  const irnBoxY = y;
  // measure IRN block height without drawing first
  const size = 7.5;
  const lineH = size + 3.5;
  const irnLines = irnFields.map(([, v]) => wrapText(v, size, W - qrW - 130));
  const irnH = irnLines.reduce((s, l) => s + Math.max(1, l.length) * lineH, 0) + 10;
  const boxH = Math.max(irnH, 52);
  p.box(L, irnBoxY, W, boxH, 0.7);
  let iy = irnBoxY + 5;
  irnFields.forEach(([k], fi) => {
    p.at(L + 5, iy + 1, `${k} :`, size, true);
    irnLines[fi].forEach((ln, li) => {
      p.at(L + 62, iy + 1 + li * lineH, ln, size, false);
    });
    iy += Math.max(1, irnLines[fi].length) * lineH;
  });
  // QR placeholder docked right
  const qrX = R - qrW - 5;
  const qrY = irnBoxY + (boxH - 44) / 2;
  p.box(qrX, qrY, qrW - 10, 44, 0.5);
  p.atCenter(qrX, qrW - 10, qrY + 8, "QR", 10, true);
  p.atCenter(qrX, qrW - 10, qrY + 24, "mock", 7, false);
  y = irnBoxY + boxH + 4;

  // Seller (left) + invoice meta (right)
  const leftW = 296;
  const metaFields: Array<[string, string]> = [
    ["Invoice No.", d.invoiceNumber],
    ["e-Way Bill No.", d.ewayBillNumber ?? "PENDING"],
    ["Dated", d.invoiceDate],
    ["Delivery Note", d.deliveryNote || "-"],
    ["Mode/Terms of Payment", d.paymentTerms || "-"],
    ["Dispatched through", d.dispatchedThrough || "-"],
    ["Destination", d.destination || "-"],
  ];
  const sellerLines = [
    d.sellerName,
    `GSTIN/UIN: ${d.sellerGstin || "-"}`,
    `State Name : ${d.sellerState}`,
    `E-Mail : ${d.sellerEmail || "-"}`,
  ];
  const sellerH = sellerLines.length * (8 + 4) + 12;
  const metaSize = 7;
  const metaLineH = metaSize + 3.5;
  const metaWrapped = metaFields.map(([, v]) => wrapText(v, metaSize, W - leftW - 4 - 122));
  const metaH = metaWrapped.reduce((s, l) => s + Math.max(1, l.length) * metaLineH, 0) + 10;
  const rowH = Math.max(sellerH, metaH);
  p.box(L, y, leftW, rowH, 0.7);
  let sy = y + 5;
  p.at(L + 5, sy, sellerLines[0], 9.5, true);
  sy += 13;
  sellerLines.slice(1).forEach((ln) => {
    wrapText(ln, 7.5, leftW - 12).forEach((wl) => {
      p.at(L + 5, sy, wl, 7.5, false);
      sy += 11;
    });
  });
  const mx = L + leftW;
  const mw = W - leftW;
  p.box(mx, y, mw, rowH, 0.7);
  p.vline(mx + 116, y, rowH, 0.5);
  let my = y + 5;
  metaFields.forEach(([k], fi) => {
    p.at(mx + 5, my, k, metaSize, true);
    metaWrapped[fi].forEach((ln, li) => {
      p.at(mx + 121, my + li * metaLineH, ln, metaSize, false);
    });
    my += Math.max(1, metaWrapped[fi].length) * metaLineH;
  });
  y += rowH + 4;

  // Consignee (Ship to) + Buyer (Bill to), stacked full width like the example
  const party = (title: string, name: string, addr: string, gstin: string, state: string, yy: number): number => {
    const lines = [name, addr, `GSTIN/UIN : ${gstin || "-"}`, `State Name : ${state}`];
    const wrapped = lines.map((ln) => wrapText(ln, 7.5, W - 14));
    const h = 15 + wrapped.reduce((s, l) => s + Math.max(1, l.length) * 11, 0) + 5;
    p.box(L, yy, W, h, 0.7);
    p.at(L + 5, yy + 3, title, 8, true);
    let ly = yy + 15;
    wrapped.forEach((wl, idx) => {
      wl.forEach((ln) => {
        p.at(L + 5, ly, ln, 7.5, idx === 0);
        ly += 11;
      });
    });
    return yy + h;
  };
  y = party("Consignee (Ship to)", d.buyerName, d.buyerAddress, d.buyerGstin, d.buyerState, y) + 4;
  y = party("Buyer (Bill to)", d.buyerName, d.buyerAddress, d.buyerGstin, d.buyerState, y) + 4;

  // Items grid
  const itemCols: GridCol[] = [
    { w: 30, head: "Sl No.", align: "c" },
    { w: 188, head: "Description of Goods", align: "l" },
    { w: 54, head: "HSN/SAC", align: "c" },
    { w: 56, head: "Quantity", align: "r" },
    { w: 62, head: "Rate Incl. Tax", align: "r" },
    { w: 56, head: "Rate", align: "r" },
    { w: 30, head: "per", align: "c" },
    { w: 62, head: "Amount", align: "r" },
  ];
  const itemRows = d.items.map((it, idx) => [
    String(idx + 1),
    it.description,
    it.hsn,
    `${it.quantity} ${it.unit}`,
    money(it.rateInclTax),
    money(it.rate),
    it.unit,
    money(it.amount),
  ]);
  y = gridTable(p, L, y, itemCols, itemRows, { size: 7.5 });

  // IGST + Total rows (aligned to the grid's right edge)
  const amtX = L + W;
  const igstY = y;
  p.box(L, igstY, W, 16, 0.5);
  p.at(L + 5, igstY + 3.5, "IGST OUTPUT TAX @ 18%", 7.5, true);
  p.atRight(amtX - 4, igstY + 3.5, money(d.gstAmount), 7.5, true);
  const totY = igstY + 16;
  p.fillBar(L, totY, W, 17, 0.88);
  p.box(L, totY, W, 17, 0.7);
  p.at(L + 5, totY + 4, "Total", 8.5, true);
  const totQty = d.items.reduce((s, it) => s + Number(it.quantity || 0), 0);
  const totUnit = d.items[0]?.unit ?? "";
  p.at(L + 200, totY + 4, `${totQty} ${totUnit}`, 8, true);
  p.atRight(amtX - 4, totY + 4, money(d.invoiceTotal), 8.5, true);
  y = totY + 17 + 3;

  // Amount in words
  y = fieldBox(p, L, y, W, [["Amount Chargeable (in words)", amountInWords(d.invoiceTotal)]], { labelW: 170 }) + 3;

  // HSN tax grid
  const taxCols: GridCol[] = [
    { w: 105, head: "HSN/SAC", align: "c" },
    { w: 130, head: "Taxable Value", align: "r" },
    { w: 80, head: "Rate", align: "c" },
    { w: 105, head: "IGST Amount", align: "r" },
    { w: 103, head: "Total Tax Amount", align: "r" },
  ];
  y = gridTable(
    p, L, y, taxCols,
    [
      [d.items[0]?.hsn ?? "-", money(d.taxableValue), `${d.gstRate}%`, money(d.gstAmount), money(d.gstAmount)],
      ["Total", money(d.taxableValue), "", money(d.gstAmount), money(d.gstAmount)],
    ],
    { size: 7.5 }
  ) + 3;
  y = fieldBox(p, L, y, W, [["Tax Amount (in words)", amountInWords(d.gstAmount)]], { labelW: 170 }) + 3;

  // Declaration + Bank details + signatory
  const declH = 52;
  p.box(L, y, W, declH, 0.7);
  p.vline(L + W / 2, y, declH, 0.5);
  p.at(L + 5, y + 3, "Declaration", 7.5, true);
  p.at(L + 5, y + 15, "Company's Bank Details", 7.5, false);
  p.at(L + 5, y + 27, "We declare that this invoice shows the actual price", 7, false);
  p.at(L + 5, y + 37, "of the goods described and all particulars are true.", 7, false);
  p.atCenter(L + W / 2, W / 2, y + 6, `for ${d.sellerName}`, 8.5, true);
  p.atCenter(L + W / 2, W / 2, y + 36, "Authorised Signatory", 7.5, false);
  y += declH + 6;

  p.atCenter(L, W, y, "This is a Computer Generated Invoice", 7.5, false);
  y += 13;
  if (d.environment === "MOCK") {
    p.atCenter(L, W, y, `Environment: MOCK    Legally Valid: NO    IRN: ${d.irn ?? "-"}`, 7.5, true);
    y += 13;
  }
  p.atCenter(L, W, y, "Page 1 of 2 - TAX INVOICE", 7, false);
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
  let y = 28;

  if (d.environment === "MOCK") {
    y += mockBanner(p, L, y, W, "TEST E-WAY BILL - MOCK - NOT LEGALLY VALID") + 4;
  }
  y += titleBar(p, L, y, W, "e-Way Bill", "e-Way Bill") + 4;

  y = fieldBox(
    p, L, y, W,
    [
      ["Doc No.", `Tax Invoice - ${d.invoiceNumber}`],
      ["Date", d.invoiceDate],
      ["IRN", d.irn ?? "-"],
      ["Ack Date", d.ackDate ?? d.invoiceDate],
    ],
    { labelW: 70 }
  ) + 4;

  // 1. e-Way Bill Details
  p.fillBar(L, y, W, 17, 0.88);
  p.box(L, y, W, 17, 0.7);
  p.at(L + 5, y + 4, "1. e-Way Bill Details", 8.5, true);
  y += 17;
  const detRows: Array<[[string, string], [string, string]]> = [
    [["e-Way Bill No.", d.ewayBillNumber ?? "PENDING"], ["Mode", d.transportMode]],
    [["Generated Date", d.generatedDate ?? "-"], ["Approx Distance", d.distanceKm != null ? `${d.distanceKm} KM` : "-"]],
    [["Generated By", d.sellerName], ["Valid Upto", d.validUntil ?? "-"]],
    [["Supply Type", d.supplyType], ["Transaction Type", d.transactionType]],
  ];
  const size = 7.5;
  const lineH = size + 3.5;
  const detH = detRows.length * lineH + 8;
  p.box(L, y, W, detH, 0.7);
  p.vline(L + W / 2, y, detH, 0.7);
  let dy = y + 4;
  detRows.forEach(([a, b]) => {
    p.at(L + 5, dy, a[0], size, true);
    wrapText(a[1], size, W / 2 - 105).slice(0, 1).forEach((ln) => p.at(L + 96, dy, ln, size, false));
    p.at(L + W / 2 + 5, dy, b[0], size, true);
    wrapText(b[1], size, W / 2 - 118).slice(0, 1).forEach((ln) => p.at(L + W / 2 + 96, dy, ln, size, false));
    dy += lineH;
  });
  y += detH + 4;

  // 2. Address Details
  p.fillBar(L, y, W, 17, 0.88);
  p.box(L, y, W, 17, 0.7);
  p.at(L + 5, y + 4, "2. Address Details", 8.5, true);
  y += 17;
  const fromLines = [d.sellerName, `GSTIN : ${d.sellerGstin || "-"}`, "Dispatch From", d.sellerState];
  const toLines = [d.buyerName, `GSTIN : ${d.buyerGstin || "-"}`, "Ship To", d.buyerAddress];
  const halfW = W / 2;
  const fromWrapped = fromLines.map((ln) => wrapText(ln, 7.5, halfW - 12));
  const toWrapped = toLines.map((ln) => wrapText(ln, 7.5, halfW - 12));
  const addrH =
    Math.max(
      14 + fromWrapped.reduce((s, l) => s + Math.max(1, l.length) * 11, 0),
      14 + toWrapped.reduce((s, l) => s + Math.max(1, l.length) * 11, 0)
    ) + 6;
  p.box(L, y, halfW, addrH, 0.7);
  p.box(L + halfW, y, halfW, addrH, 0.7);
  p.at(L + 5, y + 3, "From", 8, true);
  p.at(L + halfW + 5, y + 3, "To", 8, true);
  let fy = y + 15;
  const fromFlat = fromWrapped.map((wl, idx) => ({ wl, bold: idx === 0 }));
  fromFlat.forEach(({ wl, bold }) => {
    wl.forEach((ln) => {
      p.at(L + 5, fy, ln, 7.5, bold);
      fy += 11;
    });
  });
  let ty = y + 15;
  toWrapped.forEach((wl, idx) => {
    wl.forEach((ln) => {
      p.at(L + halfW + 5, ty, ln, 7.5, idx === 0);
      ty += 11;
    });
  });
  y += addrH + 4;

  // 3. Goods Details
  p.fillBar(L, y, W, 17, 0.88);
  p.box(L, y, W, 17, 0.7);
  p.at(L + 5, y + 4, "3. Goods Details", 8.5, true);
  y += 17;
  const goodsCols: GridCol[] = [
    { w: 62, head: "HSN Code", align: "c" },
    { w: 248, head: "Product Name & Desc", align: "l" },
    { w: 68, head: "Quantity", align: "r" },
    { w: 82, head: "Taxable Amt", align: "r" },
    { w: 63, head: "Tax Rate %", align: "c" },
  ];
  y = gridTable(
    p, L, y, goodsCols,
    d.items.map((it) => [it.hsn, it.description, `${it.quantity} ${it.unit}`, money(it.amount), String(d.gstRate)]),
    { size: 7.5 }
  );
  y = fieldBox(
    p, L, y, W,
    [
      ["Totals", `Taxable: ${money(d.taxableValue)}   Other: 0.00   Invoice: ${money(d.invoiceTotal)}`],
      ["IGST Amt", money(d.gstAmount)],
    ],
    { labelW: 70 }
  ) + 4;

  // 4. Transportation Details
  p.fillBar(L, y, W, 17, 0.88);
  p.box(L, y, W, 17, 0.7);
  p.at(L + 5, y + 4, "4. Transportation Details", 8.5, true);
  y += 17;
  y = fieldBox(
    p, L, y, W,
    [
      ["Transporter", `${d.transporterName ?? "-"}${d.transporterId ? `  (ID: ${d.transporterId})` : ""}`],
      ["Transport Doc", `${d.transportDocNumber ?? "-"}${d.transportDocDate ? `  dated ${d.transportDocDate}` : ""}`],
    ],
    { labelW: 110 }
  ) + 4;

  // 5. Vehicle Details
  p.fillBar(L, y, W, 17, 0.88);
  p.box(L, y, W, 17, 0.7);
  p.at(L + 5, y + 4, "5. Vehicle Details", 8.5, true);
  y += 17;
  y = fieldBox(
    p, L, y, W,
    [
      ["Vehicle No.", d.vehicleNumber ?? "-"],
      ["Distance", d.distanceKm != null ? `${d.distanceKm} KM` : "-"],
    ],
    { labelW: 110 }
  ) + 6;

  if (d.environment === "MOCK") {
    p.fillBar(L, y, W, 18, 0.82);
    p.box(L, y, W, 18, 0.7);
    p.atCenter(L, W, y + 5, "Environment: MOCK    Legally Valid: NO", 8, true);
    y += 24;
  }
  p.atCenter(L, W, y, "Page 2 of 2 - e-Way Bill", 7, false);
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
