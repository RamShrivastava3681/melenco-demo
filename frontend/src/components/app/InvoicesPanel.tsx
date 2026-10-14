import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { fmtMoney, fmtDate, dedupeInvoices, sortInvoicesByDue, normInvoiceNumber, type Customer, type Invoice } from "@/lib/ledger";
import { Trash2, Upload, Download, FileDown, AlertTriangle, CheckCircle2, XCircle, Sparkles, FileCheck, Truck, Printer } from "lucide-react";
import Papa from "papaparse";
import * as XLSX from "xlsx";

// Types for the import result
interface ImportResult {
  importedCount: number;
  skippedCount: number;
  skipped: Array<{ invoice_number: string; customer_id: string; reason: string }>;
  errors: Array<{ invoice_number: string; error: string }>;
}

type Row = { invoice_number: string; issue_date: string; due_date: string; amount: number };

function parseDate(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m) {
    const [, d, mo, y] = m;
    const yr = y.length === 2 ? `20${y}` : y;
    return `${yr}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  const dt = new Date(s);
  if (!isNaN(dt.getTime())) return dt.toISOString().slice(0, 10);
  throw new Error(`Invalid date: ${s}`);
}

function normalizeRows(raw: Record<string, unknown>[]): Row[] {
  return raw.map((r, i) => {
    const lower: Record<string, unknown> = {};
    for (const k of Object.keys(r)) lower[k.toLowerCase().trim().replace(/\s+/g, "_")] = r[k];
    const inv = lower.invoice_number ?? lower.invoice ?? lower.invoice_no ?? lower["invoice#"];
    const issue = lower.issue_date ?? lower.invoice_date ?? lower.date;
    const due = lower.due_date ?? lower.duedate;
    const amt = lower.amount ?? lower.total;
    if (!inv || !issue || !due || amt == null) throw new Error(`Row ${i + 2}: missing required fields`);
    const amount = typeof amt === "number" ? amt : parseFloat(String(amt).replace(/[^\d.-]/g, ""));
    if (!isFinite(amount) || amount <= 0) throw new Error(`Row ${i + 2}: invalid amount`);
    return { invoice_number: String(inv).trim(), issue_date: parseDate(issue), due_date: parseDate(due), amount };
  });
}

export function InvoicesPanel() {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [customerId, setCustomerId] = useState<string>("");
  const [filterStatus, setFilterStatus] = useState<"all" | "open" | "closed" | "COMPLETED">("all");
  const [search, setSearch] = useState("");
  const [irnPendingId, setIrnPendingId] = useState<string | null>(null);
  const [ewbPendingId, setEwbPendingId] = useState<string | null>(null);
  const [dispatchFor, setDispatchFor] = useState<Invoice | null>(null);
  const [dispatchForm, setDispatchForm] = useState<Record<string, string>>({});

  const { data: customers = [] } = useQuery({
    queryKey: ["customers"],
    queryFn: async () => {
      const res = await api.getCustomers();
      return res.customers as Customer[];
    },
  });

  const { data: invoices = [] } = useQuery({
    queryKey: ["invoices", customerId, filterStatus],
    queryFn: async () => {
      const params: { customer_id?: string; status?: string } = {};
      if (customerId) params.customer_id = customerId;
      if (filterStatus !== "all") params.status = filterStatus;
      const res = await api.getInvoices(params);
      return res.invoices as Invoice[];
    },
  });

  // Exact, duplicate-free, properly arranged rows: dedupe → search → sort.
  const visibleInvoices = useMemo(() => {
    const q = search.trim().toLowerCase();
    const unique = dedupeInvoices(invoices);
    const filtered = q
      ? unique.filter(
          (i) =>
            normInvoiceNumber(i.invoice_number).includes(q) ||
            String(i.issue_date || "").includes(q) ||
            String(i.due_date || "").includes(q)
        )
      : unique;
    return sortInvoicesByDue(filtered);
  }, [invoices, search]);

  const totals = useMemo(
    () => ({
      count: visibleInvoices.length,
      amount: visibleInvoices.reduce((s, i) => s + Number(i.amount || 0), 0),
      balance: visibleInvoices.reduce((s, i) => s + Number(i.balance || 0), 0),
    }),
    [visibleInvoices]
  );

  const [importResult, setImportResult] = useState<ImportResult | null>(null);

  // NOTE: sending invoices to Tally is paused for now (receive-only mode).

  const importMut = useMutation({
    mutationFn: async (rows: Row[]) => {
      if (!customerId) throw new Error("Pick a customer first");
      const payload = rows.map((r) => ({
        customer_id: customerId,
        invoice_number: r.invoice_number,
        issue_date: r.issue_date,
        due_date: r.due_date,
        amount: r.amount,
      }));
      const res = await api.createInvoices(payload);
      return res;
    },
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      setImportResult({
        importedCount: res.importedCount,
        skippedCount: res.skippedCount,
        skipped: res.skipped,
        errors: res.errors,
      });

      // Build a summary toast
      const parts: string[] = [];
      if (res.importedCount > 0) parts.push(`${res.importedCount} imported`);
      if (res.skippedCount > 0) parts.push(`${res.skippedCount} skipped (already exist)`);
      if (res.errorCount > 0) parts.push(`${res.errorCount} errored`);

      if (parts.length > 0) {
        toast.success(`Import complete: ${parts.join(", ")}`);
      } else {
        toast.success("No invoices were imported");
      }
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function clearImportResult() {
    setImportResult(null);
  }

  const del = useMutation({
    mutationFn: async (id: string) => {
      await api.deleteInvoice(id);
    },
    onSuccess: () => {
      qc.invalidateQueries();
      toast.success("Invoice deleted");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // ── Phase 5 demo: posted invoices + one-click IRN ──
  const seedIrn = useMutation({
    mutationFn: () => api.seedIrnDemo(),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["customers"] });
      if (res.created > 0) {
        toast.success(`Demo ready: ${res.created} Tally-posted invoice(s) — click Request IRN`);
      } else {
        toast.success("Demo invoices already exist — click Request IRN");
      }
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const irnMut = useMutation({
    mutationFn: async (inv: Invoice) => {
      const st = String(inv.irnStatus ?? "IRN_PENDING");
      if (st === "IRN_FAILED" || st === "IRN_RETRYABLE" || st === "IRN_SUBMITTED") {
        return api.retryIrn({ invoiceId: inv.id });
      }
      return api.requestIrn({ invoiceId: inv.id });
    },
    onMutate: (inv) => setIrnPendingId(inv.id),
    onSettled: () => setIrnPendingId(null),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      if (res.irnStatus === "IRN_GENERATED") {
        toast.success(
          res.duplicate
            ? `IRN already exists: ${res.irn} (no duplicate created)`
            : `IRN generated: ${res.irn} — mock test result, not a legal IRN`
        );
      } else {
        toast.error(`${res.irnStatus}: ${res.errorMessage ?? res.errorCode ?? "no IRN generated"}`);
      }
    },
    onError: (e: Error) => {
      const d = (e as ApiError).details;
      const missing = d?.missingField ? ` Missing field: ${d.missingField}.` : "";
      const action = d?.action ? ` ${d.action}` : "";
      toast.error(`${e.message}${missing}${action}`, { duration: 6000 });
    },
  });

  function irnBadge(inv: Invoice) {    const st = String(inv.irnStatus ?? "IRN_PENDING");
    if (st === "IRN_GENERATED" && inv.irn) {
      return (
        <div className="flex flex-col items-start gap-0.5" title={`Tally voucher ${inv.tally_voucher_number ?? ""} · ref ${inv.tally_reference ?? ""}`}>
          <Badge className="bg-success text-success-foreground hover:bg-success font-mono">{inv.irn}</Badge>
          <span className="text-[10px] text-muted-foreground">test IRN · Tally {inv.tally_voucher_number ?? "—"}</span>
          <span className="text-[10px] tabular-nums text-muted-foreground">Ack {inv.acknowledgementNumber ?? "—"}{inv.acknowledgementDate ? ` · ${inv.acknowledgementDate}` : ""}</span>
        </div>
      );
    }
    if (st === "IRN_FAILED") return <Badge variant="destructive">Failed</Badge>;
    if (st === "IRN_RETRYABLE") return <Badge className="bg-amber-500 text-white hover:bg-amber-500">Retryable</Badge>;
    if (st === "IRN_SUBMITTED" || st === "IRN_REQUEST_READY") return <Badge variant="secondary">Submitted</Badge>;
    return <span className="text-muted-foreground">—</span>;
  }

  // ── Phase 6: dispatch + e-way bill (mock adapter — test results only) ──
  const seedEwb = useMutation({
    mutationFn: () => api.seedEwbDemo(),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["customers"] });
      if (res.created > 0) {
        toast.success(`EWB demo ready: ${res.created} Tally-posted invoice(s) — Request IRN first, then Request EWB`);
      } else {
        toast.success("EWB demo invoices already exist — Request IRN first, then Request EWB");
      }
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const seedFresh = useMutation({
    mutationFn: () => api.seedEwbFreshFlow(),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["customers"] });
      if (res.created > 0) {
        toast.success(`Flow ready: ${res.created} new OPEN invoice(s) — post to Tally, then IRN, then EWB`);
      } else {
        toast.success("Flow invoices already exist — post to Tally, then IRN, then EWB");
      }
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const simPost = useMutation({
    mutationFn: (inv: Invoice) => api.simulateEwbPost({ invoiceId: inv.id }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      toast.success(`Posted to Tally (simulated): voucher ${res.tallyVoucherNumber} — now Request IRN`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const DISPATCH_DEFAULTS: Record<string, string> = {
    dispatchWarehouse: "Main Warehouse",
    originAddress: "101 MG Road, Bengaluru, Karnataka 560001",
    originPin: "560001",
    destinationAddress: "201 Andheri West, Mumbai, Maharashtra 400072",
    destinationPin: "400072",
    transporterName: "Delhivery",
    transporterId: "214243",
    transportMode: "Road",
    vehicleNumber: "",
    transportDocNumber: "LR-1001",
    transportDocDate: new Date().toISOString().slice(0, 10),
    distanceKm: "23",
    packageCount: "10",
    packageType: "Boxes",
    expectedDispatchDate: new Date().toISOString().slice(0, 10),
  };

  function openDispatch(inv: Invoice) {
    setDispatchForm({ ...DISPATCH_DEFAULTS, packageCount: String((inv as any).quantity ?? "10") });
    setDispatchFor(inv);
  }

  const ewbMut = useMutation({
    mutationFn: async ({ inv, dispatch }: { inv: Invoice; dispatch?: Record<string, unknown> }) => {
      const st = String(inv.ewayBillStatus ?? "EWB_PENDING");
      if (st === "EWB_FAILED" || st === "EWB_RETRYABLE" || st === "EWB_SUBMITTED") {
        return api.retryEwb({ invoiceId: inv.id });
      }
      const payload: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(dispatch ?? {})) {
        if (v === "" || v === null || v === undefined) continue;
        payload[k] = k === "distanceKm" || k === "packageCount" ? Number(v) : v;
      }
      return api.requestEwb({ invoiceId: inv.id, dispatch: payload });
    },
    onMutate: ({ inv }) => setEwbPendingId(inv.id),
    onSettled: () => setEwbPendingId(null),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      setDispatchFor(null);
      if (res.ewayBillStatus === "EWB_GENERATED") {
        toast.success(
          res.duplicate
            ? `E-way bill already exists: ${res.ewayBillNumber} (no duplicate created)`
            : `E-way bill generated: ${res.ewayBillNumber} — MOCK test result, not legally valid`
        );
      } else {
        toast.error(`${res.ewayBillStatus} · dispatch ${res.dispatchStatus}: ${res.errorMessage ?? res.errorCode ?? "no e-way bill generated"}`);
      }
    },
    onError: (e: Error) => {
      const d = (e as ApiError).details;
      const missing = d?.missingField ? ` Missing field: ${d.missingField}.` : "";
      const action = d?.action ? ` ${d.action}` : "";
      toast.error(`${e.message}${missing}${action}`, { duration: 6000 });
    },
  });

  const pdfMut = useMutation({
    mutationFn: (inv: Invoice) => api.downloadEwbPdf(inv.id),
    onSuccess: ({ blob, filename }) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("Invoice + e-way bill PDF downloaded (MOCK — not legally valid)");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function ewbBadge(inv: Invoice) {
    const st = String(inv.ewayBillStatus ?? "EWB_PENDING");
    if (st === "EWB_GENERATED" && inv.ewayBillNumber) {
      return (
        <div className="flex flex-col items-start gap-0.5" title={`Dispatch ${inv.dispatchStatus ?? ""} · inventory ${inv.inventoryStatus ?? ""}`}>
          <Badge className="bg-success text-success-foreground hover:bg-success font-mono">{inv.ewayBillNumber}</Badge>
          <span className="text-[10px] text-muted-foreground">test EWB · {inv.dispatchStatus === "DISPATCH_RELEASED" ? "dispatched" : inv.dispatchStatus ?? ""}</span>
        </div>
      );
    }
    if (st === "EWB_FAILED") return <Badge variant="destructive">Failed</Badge>;
    if (st === "EWB_RETRYABLE") return <Badge className="bg-amber-500 text-white hover:bg-amber-500">Retryable</Badge>;
    if (st === "EWB_SUBMITTED" || st === "EWB_REQUEST_READY") return <Badge variant="secondary">Submitted</Badge>;
    return <span className="text-muted-foreground">—</span>;
  }

  async function handleFile(file: File) {
    clearImportResult();
    if (!customerId) { toast.error("Select a customer first"); return; }
    try {
      let rows: Row[];
      if (file.name.toLowerCase().endsWith(".csv")) {
        const text = await file.text();
        const parsed = Papa.parse<Record<string, unknown>>(text, { header: true, skipEmptyLines: true });
        rows = normalizeRows(parsed.data);
      } else {
        const buf = await file.arrayBuffer();
        const wb = XLSX.read(buf, { type: "array", cellDates: true });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { raw: false, defval: "" });
        rows = normalizeRows(json);
      }
      if (rows.length === 0) throw new Error("File is empty");
      importMut.mutate(rows);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not parse file");
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const exportMut = useMutation({
    mutationFn: async () => {
      const params: { customer_id?: string; status?: string } = {};
      if (customerId) params.customer_id = customerId;
      if (filterStatus !== "all") params.status = filterStatus;
      const res = await api.exportInvoices(params);
      return res.rows;
    },
    onSuccess: (rows) => {
      if (rows.length === 0) {
        toast.error("No invoices to export");
        return;
      }

      // Derive sheet name and filename from filters
      const statusLabel = filterStatus === "all" ? "All" : filterStatus.charAt(0).toUpperCase() + filterStatus.slice(1);
      const customerLabel = customerId
        ? customers.find((c) => c.id === customerId)?.name?.replace(/\s+/g, "-") ?? "customer"
        : "all-customers";
      const sheetName = `${statusLabel} Invoices`;
      const fileName = `${customerLabel}-${statusLabel.toLowerCase().replace(/\s+/g, "-")}-invoices-${new Date().toISOString().slice(0, 10)}.xlsx`;

      // Map to flat export-friendly format
      const data = rows.map((r: any) => ({
        "Invoice #": r.invoice_number,
        "Customer": r.customer_name,
        "Issue Date": r.issue_date,
        "Due Date": r.due_date,
        "Amount": Number(r.amount),
        "Balance": Number(r.balance),
        "Status": r.status ?? "",
        "Closed Date": r.closed_date ?? "",
        "Payment Days": r.payment_days ?? "",
        "Late Payment Days": r.late_payment_days ?? "",
        "Payment Date": r.payment_date ?? "",
        "Payment Amount": r.payment_amount != null ? Number(r.payment_amount) : "",
        "Amount Applied": r.amount_applied != null ? Number(r.amount_applied) : "",
        "Applied Date": r.applied_date ?? "",
        "Closed by Allocation": r.closed_invoice ? "Yes" : "No",
        "Payment Note": r.payment_note ?? "",
      }));

      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.json_to_sheet(data);
      XLSX.utils.book_append_sheet(wb, ws, sheetName);
      const wbout = XLSX.write(wb, { bookType: "xlsx", type: "array" });
      const blob = new Blob([wbout], { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`Exported ${rows.length} row${rows.length > 1 ? "s" : ""}`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function downloadTemplate() {
    const csv = "invoice_number,issue_date,due_date,amount\nINV-001,2025-01-15,2025-02-14,1500.00\nINV-002,2025-01-20,2025-02-19,2750.50\n";
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "invoice-template.csv"; a.click();
    URL.revokeObjectURL(url);
  }

  const customerName = (id: string) => customers.find((c) => c.id === id)?.name ?? "\u2014";

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-3">
          <CardTitle>Invoices</CardTitle>
          <span className="text-xs text-muted-foreground">
            {totals.count} invoice{totals.count !== 1 ? "s" : ""} · Amount {fmtMoney(totals.amount)} · Balance {fmtMoney(totals.balance)}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Customer (for import & filter)</label>
            <Select value={customerId} onValueChange={(v) => { setCustomerId(v); clearImportResult(); }}>
              <SelectTrigger className="w-64"><SelectValue placeholder="Select customer" /></SelectTrigger>
              <SelectContent>
                {customers.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Status</label>
            <Select value={filterStatus} onValueChange={(v) => setFilterStatus(v as "all" | "open" | "closed" | "COMPLETED")}>
              <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="open">Open</SelectItem>
                <SelectItem value="closed">Closed</SelectItem>
                <SelectItem value="COMPLETED">Posted to Tally</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Search</label>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Invoice #, date…"
              className="h-9 w-52 rounded-md border bg-background px-3 text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
          <div className="ml-auto flex gap-2">
            <Button variant="secondary" onClick={() => seedIrn.mutate()} disabled={seedIrn.isPending}>
              <Sparkles className="mr-2 h-4 w-4" />{seedIrn.isPending ? "Seeding..." : "Seed IRN demo"}
            </Button>
            <Button variant="secondary" onClick={() => seedEwb.mutate()} disabled={seedEwb.isPending}>
              <Truck className="mr-2 h-4 w-4" />{seedEwb.isPending ? "Seeding..." : "Seed EWB demo"}
            </Button>
            <Button variant="secondary" onClick={() => seedFresh.mutate()} disabled={seedFresh.isPending} title="New customers + OPEN invoices: push → IRN → EWB">
              <Sparkles className="mr-2 h-4 w-4" />{seedFresh.isPending ? "Seeding..." : "Seed flow demo"}
            </Button>
            <Button variant="outline" onClick={() => exportMut.mutate()} disabled={exportMut.isPending}>
              <FileDown className="mr-2 h-4 w-4" />{exportMut.isPending ? "Exporting..." : `Export ${filterStatus === "all" ? "All" : filterStatus.charAt(0).toUpperCase() + filterStatus.slice(1)}`}
            </Button>
            <Button variant="outline" onClick={downloadTemplate}><Download className="mr-2 h-4 w-4" />Template</Button>
            <Button onClick={() => fileRef.current?.click()} disabled={importMut.isPending || !customerId}>
              <Upload className="mr-2 h-4 w-4" />Import CSV/XLSX
            </Button>
            <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
          </div>
        </div>

        {/* Import Result Panel */}
        {importResult && (
          <div className="rounded-lg border bg-card text-card-foreground shadow-sm">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <h4 className="text-sm font-semibold">Import Results</h4>
              <Button variant="ghost" size="sm" onClick={clearImportResult} className="h-6 text-xs">
                Dismiss
              </Button>
            </div>
            <div className="divide-y">
              {/* Imported count */}
              <div className="flex items-center gap-3 px-4 py-3">
                <CheckCircle2 className="h-5 w-5 shrink-0 text-success" />
                <div className="flex-1">
                  <p className="text-sm font-medium">{importResult.importedCount} invoice{importResult.importedCount !== 1 ? "s" : ""} imported successfully</p>
                  <p className="text-xs text-muted-foreground">These invoices were added to the platform.</p>
                </div>
              </div>

              {/* Skipped */}
              {importResult.skippedCount > 0 && (
                <div className="px-4 py-3">
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
                    <div className="flex-1">
                      <p className="text-sm font-medium">{importResult.skippedCount} invoice{importResult.skippedCount !== 1 ? "s" : ""} skipped (already in platform)</p>
                      <p className="text-xs text-muted-foreground mb-2">These invoice numbers already exist for the selected customer and were not imported.</p>
                      <div className="max-h-40 overflow-y-auto rounded border">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="bg-muted/50">
                              <th className="px-3 py-1.5 text-left font-medium text-muted-foreground">Invoice #</th>
                              <th className="px-3 py-1.5 text-left font-medium text-muted-foreground">Reason</th>
                            </tr>
                          </thead>
                          <tbody>
                            {importResult.skipped.map((s, i) => (
                              <tr key={i} className="border-t">
                                <td className="px-3 py-1.5 font-mono">{s.invoice_number}</td>
                                <td className="px-3 py-1.5 text-muted-foreground">{s.reason}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Errors */}
              {importResult.errors.length > 0 && (
                <div className="px-4 py-3">
                  <div className="flex items-start gap-3">
                    <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
                    <div className="flex-1">
                      <p className="text-sm font-medium">{importResult.errors.length} invoice{importResult.errors.length !== 1 ? "s" : ""} had errors</p>
                      <p className="text-xs text-muted-foreground mb-2">These rows had missing or invalid data and were skipped.</p>
                      <div className="max-h-32 overflow-y-auto rounded border">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="bg-muted/50">
                              <th className="px-3 py-1.5 text-left font-medium text-muted-foreground">Invoice #</th>
                              <th className="px-3 py-1.5 text-left font-medium text-muted-foreground">Error</th>
                            </tr>
                          </thead>
                          <tbody>
                            {importResult.errors.map((e, i) => (
                              <tr key={i} className="border-t">
                                <td className="px-3 py-1.5 font-mono">{e.invoice_number}</td>
                                <td className="px-3 py-1.5 text-muted-foreground">{e.error}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/50">
                <TableHead>Invoice #</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Issued</TableHead>
                <TableHead>Due</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="text-right">Balance</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Paid on</TableHead>
                <TableHead className="text-right">Pay days</TableHead>
                <TableHead className="text-right">Late days</TableHead>
                <TableHead>IRN</TableHead>
                <TableHead>E-Way Bill</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleInvoices.length === 0 ? (
                <TableRow><TableCell colSpan={13} className="py-8 text-center text-sm text-muted-foreground">
                  No invoices{search.trim() ? " match this search" : " yet — click “Seed IRN demo” above for Tally-posted test invoices"}
                </TableCell></TableRow>
              ) : visibleInvoices.map((i) => (
                <TableRow key={i.id}>
                  <TableCell className="font-medium font-mono">{String(i.invoice_number).trim()}</TableCell>
                  <TableCell>{customerName(i.customer_id)}</TableCell>
                  <TableCell className="whitespace-nowrap">{fmtDate(i.issue_date)}</TableCell>
                  <TableCell className="whitespace-nowrap">{fmtDate(i.due_date)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtMoney(Number(i.amount))}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtMoney(Number(i.balance))}</TableCell>
                  <TableCell>
                    {i.status === "closed"
                      ? <Badge className="bg-success text-success-foreground hover:bg-success">Closed</Badge>
                      : i.status === "COMPLETED"
                        ? <Badge variant="outline" title={`Tally voucher ${i.tally_voucher_number ?? ""}`}>Posted to Tally</Badge>
                        : <Badge variant="secondary">Open</Badge>}
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap">{i.closed_date ? fmtDate(i.closed_date) : "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{i.payment_days ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{i.late_payment_days ?? "—"}</TableCell>
                  <TableCell>{irnBadge(i)}</TableCell>
                  <TableCell>{ewbBadge(i)}</TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    {String(i.status ?? "") !== "COMPLETED" && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="mr-1"
                        disabled={simPost.isPending}
                        title="Simulate the connector ack (marks Tally-posted) — use a live push instead when Tally is connected"
                        onClick={() => simPost.mutate(i)}
                      >
                        Simulate post
                      </Button>
                    )}
                    {String(i.irnStatus ?? "IRN_PENDING") === "IRN_GENERATED" ? (
                      <span className="mr-1 inline-flex items-center gap-1 text-xs text-muted-foreground">
                        <FileCheck className="h-4 w-4" />Done
                      </span>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        className="mr-1"
                        disabled={irnPendingId === i.id || irnMut.isPending}
                        onClick={() => irnMut.mutate(i)}
                      >
                        {irnPendingId === i.id
                          ? "Requesting..."
                          : ["IRN_FAILED", "IRN_RETRYABLE", "IRN_SUBMITTED"].includes(String(i.irnStatus ?? ""))
                            ? "Retry IRN"
                            : "Request IRN"}
                      </Button>
                    )}
                    {String(i.ewayBillStatus ?? "EWB_PENDING") === "EWB_GENERATED" ? (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          className="mr-1"
                          disabled={pdfMut.isPending}
                          title="Download TAX INVOICE + e-Way Bill PDF (MOCK — not legally valid)"
                          onClick={() => pdfMut.mutate(i)}
                        >
                          <Printer className="mr-1 h-4 w-4" />PDF
                        </Button>
                        <span className="mr-1 inline-flex items-center gap-1 text-xs text-muted-foreground">
                          {i.dispatchStatus === "DISPATCH_RELEASED" ? "Dispatched" : i.dispatchStatus ?? ""}
                        </span>
                      </>
                    ) : String(i.irnStatus ?? "") === "IRN_GENERATED" ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="mr-1"
                        disabled={ewbPendingId === i.id || ewbMut.isPending}
                        onClick={() => {
                          const st = String(i.ewayBillStatus ?? "EWB_PENDING");
                          if (st === "EWB_FAILED" || st === "EWB_RETRYABLE" || st === "EWB_SUBMITTED") {
                            ewbMut.mutate({ inv: i });
                          } else {
                            openDispatch(i);
                          }
                        }}
                      >
                        {ewbPendingId === i.id
                          ? "Requesting..."
                          : ["EWB_FAILED", "EWB_RETRYABLE", "EWB_SUBMITTED"].includes(String(i.ewayBillStatus ?? ""))
                            ? "Retry EWB"
                            : "Request EWB"}
                      </Button>
                    ) : null}
                    <Button variant="ghost" size="icon" onClick={() => {
                      if (confirm(`Delete ${i.invoice_number}?`)) del.mutate(i.id);
                    }}><Trash2 className="h-4 w-4" /></Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        {visibleInvoices.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Showing {visibleInvoices.length} unique invoice{visibleInvoices.length !== 1 ? "s" : ""} · sorted by due date, then invoice # · duplicates hidden automatically.
          </p>
        )}

        {/* Phase 6: dispatch details for the e-way bill request */}
        {dispatchFor && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
            <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-lg border bg-card p-5 shadow-lg">
              <h4 className="text-sm font-semibold">
                Dispatch details — {dispatchFor.invoice_number}
              </h4>
              <p className="mb-4 mt-1 text-xs text-muted-foreground">
                Tally voucher {dispatchFor.tally_voucher_number ?? "—"} · IRN {dispatchFor.irn ? `${String(dispatchFor.irn).slice(0, 12)}…` : "—"} ·
                dispatch is released only after the e-way bill is generated (mock test result, not legally valid).
              </p>
              <div className="grid grid-cols-2 gap-3">
                {[
                  ["dispatchWarehouse", "Dispatch warehouse"],
                  ["transportMode", "Transport mode (Road/Rail/Air/Ship)"],
                  ["originAddress", "Origin address"],
                  ["originPin", "Origin PIN (6 digits)"],
                  ["destinationAddress", "Destination address"],
                  ["destinationPin", "Destination PIN (6 digits)"],
                  ["transporterName", "Transporter name"],
                  ["transporterId", "Transporter ID"],
                  ["vehicleNumber", "Vehicle number"],
                  ["transportDocNumber", "Transport document no."],
                  ["transportDocDate", "Transport document date"],
                  ["distanceKm", "Distance (km)"],
                  ["packageCount", "Package count"],
                  ["packageType", "Package type"],
                  ["expectedDispatchDate", "Expected dispatch date"],
                ].map(([key, label]) => (
                  <div key={key} className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground">{label}</label>
                    <input
                      value={dispatchForm[key] ?? ""}
                      onChange={(e) => setDispatchForm((f) => ({ ...f, [key]: e.target.value }))}
                      className="h-9 w-full rounded-md border bg-background px-3 text-sm outline-none"
                    />
                  </div>
                ))}
              </div>
              <div className="mt-4 flex justify-end gap-2">
                <Button variant="outline" onClick={() => setDispatchFor(null)}>Cancel</Button>
                <Button
                  disabled={ewbMut.isPending}
                  onClick={() => dispatchFor && ewbMut.mutate({ inv: dispatchFor, dispatch: dispatchForm })}
                >
                  <Truck className="mr-2 h-4 w-4" />{ewbMut.isPending ? "Submitting..." : "Submit e-way bill request"}
                </Button>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
