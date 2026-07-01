import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { fmtMoney, type Customer, type Invoice } from "@/lib/ledger";
import { Trash2, Upload, Download } from "lucide-react";
import Papa from "papaparse";
import * as XLSX from "xlsx";

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
  const [filterStatus, setFilterStatus] = useState<"all" | "open" | "closed">("all");

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
      return res.count;
    },
    onSuccess: (n) => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      toast.success(`Imported ${n} invoices`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

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

  async function handleFile(file: File) {
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
        <CardTitle>Invoices</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Customer (for import & filter)</label>
            <Select value={customerId} onValueChange={setCustomerId}>
              <SelectTrigger className="w-64"><SelectValue placeholder="Select customer" /></SelectTrigger>
              <SelectContent>
                {customers.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Status</label>
            <Select value={filterStatus} onValueChange={(v) => setFilterStatus(v as "all" | "open" | "closed")}>
              <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="open">Open</SelectItem>
                <SelectItem value="closed">Closed</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="ml-auto flex gap-2">
            <Button variant="outline" onClick={downloadTemplate}><Download className="mr-2 h-4 w-4" />Template</Button>
            <Button onClick={() => fileRef.current?.click()} disabled={importMut.isPending || !customerId}>
              <Upload className="mr-2 h-4 w-4" />Import CSV/XLSX
            </Button>
            <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
          </div>
        </div>

        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
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
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {invoices.length === 0 ? (
                <TableRow><TableCell colSpan={11} className="text-center text-sm text-muted-foreground">No invoices</TableCell></TableRow>
              ) : invoices.map((i) => (
                <TableRow key={i.id}>
                  <TableCell className="font-medium">{i.invoice_number}</TableCell>
                  <TableCell>{customerName(i.customer_id)}</TableCell>
                  <TableCell>{i.issue_date}</TableCell>
                  <TableCell>{i.due_date}</TableCell>
                  <TableCell className="text-right">{fmtMoney(Number(i.amount))}</TableCell>
                  <TableCell className="text-right">{fmtMoney(Number(i.balance))}</TableCell>
                  <TableCell>
                    {i.status === "closed"
                      ? <Badge className="bg-success text-success-foreground hover:bg-success">Closed</Badge>
                      : <Badge variant="secondary">Open</Badge>}
                  </TableCell>
                  <TableCell className="text-right">{i.closed_date ?? "\u2014"}</TableCell>
                  <TableCell className="text-right">{i.payment_days ?? "\u2014"}</TableCell>
                  <TableCell className="text-right">{i.late_payment_days ?? "\u2014"}</TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="icon" onClick={() => {
                      if (confirm(`Delete ${i.invoice_number}?`)) del.mutate(i.id);
                    }}><Trash2 className="h-4 w-4" /></Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
