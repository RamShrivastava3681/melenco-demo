import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fmtMoney, type Customer, type Payment, type Allocation, type Invoice } from "@/lib/ledger";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";

export function PaymentsPanel() {
  const qc = useQueryClient();
  const [adjustingId, setAdjustingId] = useState<string | null>(null);
  const [adjustAmount, setAdjustAmount] = useState<string>("");

  const adjustRemaining = useMutation({
    mutationFn: async ({ paymentId, amount }: { paymentId: string; amount: number }) => {
      await api.subtractRemaining(paymentId, amount);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["payments"] });
      qc.invalidateQueries({ queryKey: ["customer-balance"] });
      setAdjustingId(null);
      setAdjustAmount("");
      toast.success("Remaining balance adjusted");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const { data: customers = [] } = useQuery({
    queryKey: ["customers"],
    queryFn: async () => {
      const res = await api.getCustomers();
      return res.customers as Customer[];
    },
  });

  const { data: payments = [] } = useQuery({
    queryKey: ["payments"],
    queryFn: async () => {
      const res = await api.getPayments();
      return res.payments as Payment[];
    },
  });

  const { data: allocations = [] } = useQuery({
    queryKey: ["allocations"],
    queryFn: async () => {
      const res = await api.getAllocations();
      return res.allocations as Allocation[];
    },
  });

  const { data: invoices = [] } = useQuery({
    queryKey: ["invoices-all"],
    queryFn: async () => {
      const res = await api.getInvoices();
      return res.invoices as Pick<Invoice, "id" | "invoice_number">[];
    },
  });

  const cName = (id: string) => customers.find((c) => c.id === id)?.name ?? "\u2014";
  const iNum = (id: string) => invoices.find((i) => i.id === id)?.invoice_number ?? "\u2014";

  return (
    <Card>
      <CardHeader><CardTitle>Payment history</CardTitle></CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead className="text-right">Applied</TableHead>
              <TableHead className="text-right">Remaining</TableHead>
              <TableHead>Closed invoices</TableHead>
              <TableHead className="w-28">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {payments.length === 0 ? (
              <TableRow><TableCell colSpan={7} className="text-center text-sm text-muted-foreground">No payments yet</TableCell></TableRow>
            ) : payments.map((p) => {
              const allocs = allocations.filter((a) => a.payment_id === p.id);
              return (
                <TableRow key={p.id}>
                  <TableCell>{p.payment_date}</TableCell>
                  <TableCell>{cName(p.customer_id)}</TableCell>
                  <TableCell className="text-right">{fmtMoney(Number(p.amount))}</TableCell>
                  <TableCell className="text-right">{fmtMoney(Number(p.applied_amount))}</TableCell>
                  <TableCell className="text-right">
                    {Number(p.remaining) > 0
                      ? <Badge className="bg-warning text-warning-foreground hover:bg-warning">{fmtMoney(Number(p.remaining))}</Badge>
                      : <span className="text-muted-foreground">0.00</span>}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {allocs.length === 0
                        ? <span className="text-xs text-muted-foreground">none</span>
                        : allocs.map((a) => (
                          <Badge key={a.id} variant="outline" className="text-xs">
                            {iNum(a.invoice_id)} \u00B7 {fmtMoney(Number(a.amount_applied))}{a.closed_invoice ? " \u2713" : ""}
                          </Badge>
                        ))}
                    </div>
                  </TableCell>
                  <TableCell>
                    {Number(p.remaining) > 0 && (
                      <div className="flex items-center gap-1">
                        {adjustingId === p.id ? (
                          <div className="flex items-center gap-1">
                            <Input
                              type="number"
                              min="0.01"
                              max={String(Number(p.remaining))}
                              step="0.01"
                              value={adjustAmount}
                              onChange={(e) => setAdjustAmount(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  const amt = parseFloat(adjustAmount);
                                  if (amt > 0 && amt <= Number(p.remaining) && !adjustRemaining.isPending) {
                                    adjustRemaining.mutate({ paymentId: p.id, amount: amt });
                                  }
                                }
                              }}
                              placeholder="Amount"
                              className="h-8 w-20 text-xs"
                              autoFocus
                            />
                            <Button
                              size="sm"
                              variant="default"
                              className="h-8 text-xs"
                              disabled={adjustRemaining.isPending || !adjustAmount || parseFloat(adjustAmount) <= 0 || parseFloat(adjustAmount) > Number(p.remaining)}
                              onClick={() => {
                                const amt = parseFloat(adjustAmount);
                                if (amt > 0 && amt <= Number(p.remaining)) {
                                  adjustRemaining.mutate({ paymentId: p.id, amount: amt });
                                }
                              }}
                            >
                              Subtract
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-8 text-xs"
                              onClick={() => { setAdjustingId(null); setAdjustAmount(""); }}
                            >
                              Cancel
                            </Button>
                          </div>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8 text-xs"
                            onClick={() => { setAdjustingId(p.id); setAdjustAmount(""); }}
                          >
                            Adjust
                          </Button>
                        )}
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
