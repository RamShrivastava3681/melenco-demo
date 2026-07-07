import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { fmtMoney, daysBetween, type Customer, type Invoice } from "@/lib/ledger";

export function ApplyPaymentPanel() {
  const qc = useQueryClient();
  const [customerId, setCustomerId] = useState("");
  const [paymentDate, setPaymentDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState<string>("");
  const [note, setNote] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [useBalance, setUseBalance] = useState(false);
  const [creditOnly, setCreditOnly] = useState(false);
  const [autoFifo, setAutoFifo] = useState(false);
  const [closeFuture, setCloseFuture] = useState(false);

  const { data: customers = [] } = useQuery({
    queryKey: ["customers"],
    queryFn: async () => {
      const res = await api.getCustomers();
      return res.customers as Customer[];
    },
  });

  const { data: openInvoices = [] } = useQuery({
    queryKey: ["open-invoices", customerId, paymentDate],
    enabled: !!customerId && !!paymentDate && !autoFifo,
    queryFn: async () => {
      const res = await api.getInvoices({ customer_id: customerId, status: "open", due_date_lte: paymentDate });
      return res.invoices as Invoice[];
    },
  });

  const { data: allOpenInvoices = [] } = useQuery({
    queryKey: ["open-invoices-all", customerId],
    enabled: !!customerId && autoFifo,
    queryFn: async () => {
      const res = await api.getInvoices({ customer_id: customerId, status: "open" });
      return res.invoices as Invoice[];
    },
  });

  const { data: previousRemaining = 0 } = useQuery({
    queryKey: ["customer-balance", customerId],
    enabled: !!customerId,
    queryFn: async () => {
      const res = await api.getCustomerBalance(customerId);
      return res.remaining;
    },
  });

  const paymentAmount = parseFloat(amount) || 0;
  const availableAmount = paymentAmount + (useBalance ? previousRemaining : 0);

  const allocations = useMemo(() => {
    let remaining = availableAmount;
    const orderedSelected = openInvoices.filter((i) => selected.has(i.id));
    const result: { invoice: Invoice; apply: number; closes: boolean; newBalance: number }[] = [];
    for (const inv of orderedSelected) {
      if (remaining <= 0) {
        result.push({ invoice: inv, apply: 0, closes: false, newBalance: Number(inv.balance) });
        continue;
      }
      const apply = Math.min(remaining, Number(inv.balance));
      const newBalance = +(Number(inv.balance) - apply).toFixed(2);
      const closes = newBalance <= 0;
      result.push({ invoice: inv, apply: +apply.toFixed(2), closes, newBalance });
      remaining = +(remaining - apply).toFixed(2);
    }
    return { rows: result, remaining: +remaining.toFixed(2), applied: +(availableAmount - remaining).toFixed(2) };
  }, [openInvoices, selected, availableAmount]);

  // FIFO preview: two-pass logic (past invoices first, then optional future pass)
  const fifoPreview = useMemo(() => {
    if (!autoFifo) return null;
    let remaining = availableAmount;

    const pastInvoices = allOpenInvoices.filter((i) => i.due_date <= paymentDate);
    const futureInvoices = allOpenInvoices.filter((i) => i.due_date > paymentDate);

    // Pass 1: process invoices due on or before payment date — skip unpayable ones
    const pastRows: { invoice: Invoice; closes: boolean; type: 'past' | 'future' }[] = [];
    for (const inv of pastInvoices) {
      const balance = Number(inv.balance);
      if (remaining >= balance) {
        pastRows.push({ invoice: inv, closes: true, type: 'past' });
        remaining = +(remaining - balance).toFixed(2);
      } else {
        pastRows.push({ invoice: inv, closes: false, type: 'past' });
      }
    }

    // Pass 2: future-dated invoices (only if closeFuture is enabled)
    const futureRows: { invoice: Invoice; closes: boolean; type: 'past' | 'future' }[] = [];
    if (closeFuture) {
      for (const inv of futureInvoices) {
        const balance = Number(inv.balance);
        if (remaining >= balance) {
          futureRows.push({ invoice: inv, closes: true, type: 'future' });
          remaining = +(remaining - balance).toFixed(2);          } else {
            futureRows.push({ invoice: inv, closes: false, type: 'future' });
          }
      }
    } else {
      // Without closeFuture, future invoices just show as skipped
      for (const inv of futureInvoices) {
        futureRows.push({ invoice: inv, closes: false, type: 'future' });
      }
    }

    const rows = [...pastRows, ...futureRows];
    const willCloseCount = rows.filter((r) => r.closes).length;
    const futureCloseCount = futureRows.filter((r) => r.closes).length;

    return { rows, pastRows, futureRows, remaining, willCloseCount, futureCloseCount };
  }, [allOpenInvoices, availableAmount, autoFifo, paymentDate, closeFuture]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const submit = useMutation({
    mutationFn: async () => {
      if (!customerId) throw new Error("Select a customer");
      if (availableAmount <= 0) throw new Error("Enter a payment amount or use an existing balance");
      if (!creditOnly && !autoFifo && selected.size === 0) throw new Error("Select at least one invoice");

      await api.applyPayment({
        customer_id: customerId,
        payment_date: paymentDate,
        amount: paymentAmount,
        note: note || undefined,
        selected_invoice_ids: creditOnly || autoFifo ? [] : Array.from(selected),
        use_balance: useBalance,
        auto_fifo: autoFifo,
        close_future_invoices: closeFuture,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries();
      setSelected(new Set());
      setAmount("");
      setNote("");
      setUseBalance(false);
      setCreditOnly(false);
      setAutoFifo(false);
      setCloseFuture(false);
      toast.success("Payment applied");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const isOverdue = (dueDate: string) => new Date(dueDate) < new Date(paymentDate);

  return (
    <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
      <Card>
        <CardHeader><CardTitle>Bulk payment</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label>Customer</Label>
            <Select value={customerId} onValueChange={(v) => { setCustomerId(v); setSelected(new Set()); }}>
              <SelectTrigger><SelectValue placeholder="Select customer" /></SelectTrigger>
              <SelectContent>
                {customers.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pdate">Payment date</Label>
            <Input id="pdate" type="date" value={paymentDate} onChange={(e) => { setPaymentDate(e.target.value); setSelected(new Set()); }} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pamt">Payment amount</Label>
            <Input id="pamt" type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
          </div>
          {previousRemaining > 0 && (
            <div className="flex items-center gap-2 rounded-lg border bg-muted/40 p-3">
              <Checkbox
                id="useBalance"
                checked={useBalance}
                onCheckedChange={(v) => { setUseBalance(v === true); setSelected(new Set()); }}
              />
              <Label htmlFor="useBalance" className="text-sm font-normal">
                Use previous balance <span className="font-medium">{fmtMoney(previousRemaining)}</span>
              </Label>        </div>
      )}
          <div className="flex items-center gap-2 rounded-lg border bg-muted/40 p-3">
            <Checkbox
              id="creditOnly"
              checked={creditOnly}
              disabled={autoFifo}
              onCheckedChange={(v) => { setCreditOnly(v === true); if (v === true) setAutoFifo(false); setSelected(new Set()); }}
            />
            <Label htmlFor="creditOnly" className={`text-sm font-normal ${autoFifo ? 'text-muted-foreground' : ''}`}>
              Add as credit only <span className="text-xs text-muted-foreground">(carry forward to future invoices)</span>
            </Label>
          </div>
          <div className="flex items-center gap-2 rounded-lg border bg-muted/40 p-3">
            <Checkbox
              id="autoFifo"
              checked={autoFifo}
              disabled={creditOnly}
              onCheckedChange={(v) => { setAutoFifo(v === true); if (v === true) { setCreditOnly(false); } else { setCloseFuture(false); } setSelected(new Set()); }}
            />
            <Label htmlFor="autoFifo" className={`text-sm font-normal ${creditOnly ? 'text-muted-foreground' : ''}`}>
              Auto-close via FIFO <span className="text-xs text-muted-foreground">(oldest invoices first, no partials)</span>
            </Label>
          </div>
          {autoFifo && (
            <div className="flex items-center gap-2 rounded-lg border bg-muted/40 p-3">
              <Checkbox
                id="closeFuture"
                checked={closeFuture}
                onCheckedChange={(v) => setCloseFuture(v === true)}
              />
              <Label htmlFor="closeFuture" className="text-sm font-normal">
                Pre-close future invoices <span className="text-xs text-muted-foreground">(remaining balance closes future-dated invoices at their due date)</span>
              </Label>
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="note">Note (optional)</Label>
            <Textarea id="note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
          </div>
          <div className="rounded-lg border bg-muted/40 p-3 text-sm space-y-1">
            <div className="flex justify-between"><span className="text-muted-foreground">Payment amount</span><span>{fmtMoney(paymentAmount)}</span></div>
            {useBalance && previousRemaining > 0 && (
              <div className="flex justify-between"><span className="text-muted-foreground">Previous balance</span><span>+{fmtMoney(previousRemaining)}</span></div>
            )}
            <div className="flex justify-between"><span className="text-muted-foreground">Available</span><span className="font-medium">{fmtMoney(availableAmount)}</span></div>
            {autoFifo ? (
              <>
                {fifoPreview ? (
                  <>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Past invoices to close</span>
                      <span className="font-medium">{fifoPreview.willCloseCount - fifoPreview.futureCloseCount}</span>
                    </div>
                    {closeFuture && fifoPreview.futureCloseCount > 0 && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Future invoices to close</span>
                        <span className="font-medium">{fifoPreview.futureCloseCount}</span>
                      </div>
                    )}
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">To apply</span>
                      <span className="font-medium">{fmtMoney(+(availableAmount - fifoPreview.remaining).toFixed(2))}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Remaining (carry forward)</span>
                      <span className={fifoPreview.remaining > 0 ? "font-semibold text-warning" : ""}>{fmtMoney(fifoPreview.remaining)}</span>
                    </div>
                  </>
                ) : (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Available</span>
                    <span className="font-medium">{fmtMoney(availableAmount)}</span>
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="flex justify-between"><span className="text-muted-foreground">To apply</span><span className="font-medium">{fmtMoney(allocations.applied)}</span></div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Remaining</span>
                  <span className={allocations.remaining > 0 ? "font-semibold text-warning" : ""}>{fmtMoney(allocations.remaining)}</span>
                </div>
              </>
            )}
          </div>
          <Button className="w-full" disabled={submit.isPending || !customerId || availableAmount <= 0 || (!creditOnly && !autoFifo && selected.size === 0)}
            onClick={() => submit.mutate()}>
            {submit.isPending
              ? "Applying\u2026"
              : creditOnly
                ? "Add credit"
                : autoFifo
                  ? closeFuture
                    ? "Apply & close (incl. future)"
                    : "Apply & close via FIFO"
                  : "Apply payment"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            {autoFifo ? (
            closeFuture
              ? "All open invoices (FIFO + future pre-close)"
              : "All open invoices (FIFO order)"
          ) : `Invoices due / overdue as of ${paymentDate || "\u2014"}`}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {creditOnly ? (
            <p className="text-sm text-muted-foreground">Credit-only mode — the full amount will carry forward as available balance.</p>
          ) : autoFifo ? (
            !customerId ? (
              <p className="text-sm text-muted-foreground">Select a customer to see outstanding invoices.</p>
            ) : allOpenInvoices.length === 0 ? (
              <p className="text-sm text-muted-foreground">No open invoices for this customer. Payment will carry forward as available balance.</p>
            ) : (
              <div className="overflow-x-auto">
                <div className="mb-2 text-xs text-muted-foreground">
                  {fifoPreview && fifoPreview.willCloseCount > 0
                    ? `Will close ${fifoPreview.willCloseCount} invoice${fifoPreview.willCloseCount > 1 ? 's' : ''}${closeFuture && fifoPreview.futureCloseCount > 0 ? ` (${fifoPreview.futureCloseCount} future at due date)` : ''} — oldest invoices paid first.`
                    : availableAmount > 0
                      ? `Cannot close any invoice — amount is too small for all open invoice balances. Amount will carry forward.`
                      : `Enter an amount to see which invoices will be closed.`}
                </div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Invoice #</TableHead>
                      <TableHead>Issued</TableHead>
                      <TableHead>Due</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead className="text-right">Balance</TableHead>
                      <TableHead>FIFO status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {allOpenInvoices.map((inv) => {
                      const row = fifoPreview?.rows.find((r) => r.invoice.id === inv.id);
                      return (
                        <TableRow key={inv.id}>
                          <TableCell className="font-medium">{inv.invoice_number}</TableCell>
                          <TableCell>{inv.issue_date}</TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              {inv.due_date}
                              {isOverdue(inv.due_date) && <Badge variant="destructive" className="text-xs">overdue</Badge>}
                            </div>
                          </TableCell>
                          <TableCell className="text-right">{fmtMoney(Number(inv.amount))}</TableCell>
                          <TableCell className="text-right">{fmtMoney(Number(inv.balance))}</TableCell>
                          <TableCell>
                            {!row ? (
                              <span className="text-xs text-muted-foreground">pending</span>
                            ) : row.closes && row.type === 'past' ? (
                              <Badge className="bg-success text-success-foreground hover:bg-success">will close</Badge>
                            ) : row.closes && row.type === 'future' ? (
                              <Badge variant="outline" className="border-blue-500 text-blue-500">pre-close</Badge>
                            ) : (
                              <Badge variant="secondary">skipped</Badge>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )
          ) : !customerId ? (
            <p className="text-sm text-muted-foreground">Select a customer to see outstanding invoices.</p>
          ) : openInvoices.length === 0 ? (
            <p className="text-sm text-muted-foreground">No open invoices due by this date.</p>
          ) : (
            <div className="overflow-x-auto">
              <div className="flex items-center gap-2 mb-2">
                <Button variant="outline" size="sm" onClick={() => setSelected(new Set(openInvoices.map(i => i.id)))}>
                  Select all
                </Button>
                <Button variant="outline" size="sm" onClick={() => setSelected(new Set())}>
                  Clear all
                </Button>
                {selected.size > 0 && (
                  <span className="text-xs text-muted-foreground">{selected.size} selected</span>
                )}
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10" />
                    <TableHead>Invoice #</TableHead>
                    <TableHead>Issued</TableHead>
                    <TableHead>Due</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead className="text-right">Balance</TableHead>
                    <TableHead className="text-right">Will apply</TableHead>
                    <TableHead className="text-right">After</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {openInvoices.map((inv) => {
                    const row = allocations.rows.find((r) => r.invoice.id === inv.id);
                    const checked = selected.has(inv.id);
                    return (
                      <TableRow key={inv.id} data-state={checked ? "selected" : undefined}>
                        <TableCell>
                          <Checkbox checked={checked} onCheckedChange={() => toggle(inv.id)} />
                        </TableCell>
                        <TableCell className="font-medium">{inv.invoice_number}</TableCell>
                        <TableCell>{inv.issue_date}</TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            {inv.due_date}
                            {isOverdue(inv.due_date) && <Badge variant="destructive" className="text-xs">overdue</Badge>}
                          </div>
                        </TableCell>
                        <TableCell className="text-right">{fmtMoney(Number(inv.amount))}</TableCell>
                        <TableCell className="text-right">{fmtMoney(Number(inv.balance))}</TableCell>
                        <TableCell className="text-right">{row ? fmtMoney(row.apply) : "\u2014"}</TableCell>
                        <TableCell className="text-right">{row ? fmtMoney(row.newBalance) : "\u2014"}</TableCell>
                        <TableCell>
                          {row?.closes
                            ? <Badge className="bg-success text-success-foreground hover:bg-success">closes</Badge>
                            : row && row.apply > 0
                              ? <Badge variant="secondary">partial</Badge>
                              : <span className="text-xs text-muted-foreground">\u2014</span>}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
