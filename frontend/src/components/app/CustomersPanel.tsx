import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";
import { type Customer } from "@/lib/ledger";
import { Trash2 } from "lucide-react";

export function CustomersPanel() {
  const qc = useQueryClient();
  const [name, setName] = useState("");

  const { data: customers = [] } = useQuery({
    queryKey: ["customers"],
    queryFn: async () => {
      const res = await api.getCustomers();
      return res.customers as Customer[];
    },
  });

  const add = useMutation({
    mutationFn: async (n: string) => {
      await api.createCustomer(n.trim());
    },
    onSuccess: () => {
      setName("");
      qc.invalidateQueries({ queryKey: ["customers"] });
      toast.success("Customer added");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const del = useMutation({
    mutationFn: async (id: string) => {
      await api.deleteCustomer(id);
    },
    onSuccess: () => {
      qc.invalidateQueries();
      toast.success("Customer removed");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Card>
      <CardHeader><CardTitle>Customers</CardTitle></CardHeader>
      <CardContent className="space-y-6">
        <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) add.mutate(name); }} className="flex gap-2">
          <Input placeholder="Customer name" value={name} onChange={(e) => setName(e.target.value)} />
          <Button type="submit" disabled={add.isPending}>Add</Button>
        </form>
        <Table>
          <TableHeader>
            <TableRow><TableHead>Name</TableHead><TableHead className="w-20" /></TableRow>
          </TableHeader>
          <TableBody>
            {customers.length === 0 ? (
              <TableRow>
                <TableCell colSpan={2} className="text-center text-sm text-muted-foreground">No customers yet</TableCell>
              </TableRow>
            ) : customers.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="font-medium">{c.name}</TableCell>
                <TableCell className="text-right">
                  <Button variant="ghost" size="icon" onClick={() => {
                    if (confirm(`Delete "${c.name}" and all its invoices/payments?`)) del.mutate(c.id);
                  }}><Trash2 className="h-4 w-4" /></Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
