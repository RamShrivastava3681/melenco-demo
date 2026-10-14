export type Customer = { id: string; name: string; created_at?: string };

export type Invoice = {
  id: string;
  user_id: string;
  customer_id: string;
  invoice_number: string;
  issue_date: string;
  due_date: string;
  amount: number;
  balance: number;
  status: "open" | "closed" | string;
  closed_date: string | null;
  payment_days: number | null;
  late_payment_days: number | null;
  created_at: string;
  // Phase 4 Tally posting refs + Phase 5 IRN fields (present once posted).
  tally_voucher_number?: string | null;
  tally_reference?: string | null;
  irn?: string | null;
  acknowledgementNumber?: string | null;
  acknowledgementDate?: string | null;
  irnStatus?: string | null;
  irnErrorMessage?: string | null;
};

export type Payment = {
  id: string;
  user_id: string;
  customer_id: string;
  payment_date: string;
  amount: number;
  applied_amount: number;
  remaining: number;
  note: string | null;
  created_at: string;
};

export type Allocation = {
  id: string;
  user_id: string;
  payment_id: string;
  invoice_id: string;
  amount_applied: number;
  applied_date: string;
  closed_invoice: boolean;
  created_at: string;
};

export function daysBetween(a: string, b: string) {
  const ms = new Date(b).getTime() - new Date(a).getTime();
  return Math.round(ms / 86400000);
}

export function fmtMoney(n: number) {
  return new Intl.NumberFormat(undefined, {
    style: "decimal",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

// --- Display helpers: one tidy, exact, duplicate-free view everywhere ---
export function normName(v: unknown): string {
  return String(v ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

export function normInvoiceNumber(v: unknown): string {
  return String(v ?? "").trim().toLowerCase();
}

/** Keep first occurrence of each key (stable, exact, no duplications). */
export function dedupeBy<T>(rows: T[], keyOf: (r: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of rows) {
    const k = keyOf(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

export function dedupeInvoices<T extends { id: string; customer_id: string; invoice_number: string }>(rows: T[]): T[] {
  return dedupeBy(rows, (r) => `${String(r.customer_id)}|${normInvoiceNumber(r.invoice_number)}`);
}

export function dedupeCustomers<T extends { id: string; name: string }>(rows: T[]): T[] {
  return dedupeBy(rows, (r) => normName((r as { name: string }).name) || String(r.id));
}

export function sortInvoicesByDue<T extends { due_date: string; invoice_number: string; issue_date?: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const d = String(a.due_date || "").localeCompare(String(b.due_date || ""));
    if (d !== 0) return d;
    const n = normInvoiceNumber(a.invoice_number).localeCompare(normInvoiceNumber(b.invoice_number));
    if (n !== 0) return n;
    return String((a as { issue_date?: string }).issue_date || "").localeCompare(
      String((b as { issue_date?: string }).issue_date || "")
    );
  });
}

export function sortByName<T extends { name?: string; displayName?: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) =>
    normName((a as { name?: string }).name ?? (a as { displayName?: string }).displayName).localeCompare(
      normName((b as { name?: string }).name ?? (b as { displayName?: string }).displayName)
    )
  );
}

/** YYYY-MM-DD → 15 Jan 2025 (falls back to the raw value when unparseable). */
export function fmtDate(v: unknown): string {
  const s = String(v ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return String(v ?? "—");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (!m || m < 1 || m > 12 || !d || d < 1 || d > 31) return s;
  return `${d} ${months[m - 1]} ${y}`;
}

/** sales_voucher → Sales voucher · LEDGER → Ledger (tidy labels). */
export function fmtEntity(v: unknown): string {
  const s = String(v ?? "").trim();
  if (!s) return "—";
  return s.toLowerCase().split(/[_\s]+/).map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");
}
