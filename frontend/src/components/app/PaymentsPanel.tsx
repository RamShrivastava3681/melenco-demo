import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtMoney, type Customer, type Payment, type Allocation, type Invoice } from "@/lib/ledger";
import { Badge } from "@/components/ui/badge";

export function PaymentsPanel() {
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
            </TableRow>
          </TableHeader>
          <TableBody>
            {payments.length === 0 ? (
              <TableRow><TableCell colSpan={6} className="text-center text-sm text-muted-foreground">No payments yet</TableCell></TableRow>
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
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
