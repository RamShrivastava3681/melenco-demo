import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CustomersPanel } from "@/components/app/CustomersPanel";
import { InvoicesPanel } from "@/components/app/InvoicesPanel";
import { PaymentsPanel } from "@/components/app/PaymentsPanel";
import { ApplyPaymentPanel } from "@/components/app/ApplyPaymentPanel";

export function Dashboard() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">Manage customers, invoices, and reconcile bulk payments.</p>
      </div>
      <Tabs defaultValue="apply" className="w-full">
        <TabsList>
          <TabsTrigger value="apply">Apply payment</TabsTrigger>
          <TabsTrigger value="invoices">Invoices</TabsTrigger>
          <TabsTrigger value="payments">Payments</TabsTrigger>
          <TabsTrigger value="customers">Customers</TabsTrigger>
        </TabsList>
        <TabsContent value="apply" className="mt-6"><ApplyPaymentPanel /></TabsContent>
        <TabsContent value="invoices" className="mt-6"><InvoicesPanel /></TabsContent>
        <TabsContent value="payments" className="mt-6"><PaymentsPanel /></TabsContent>
        <TabsContent value="customers" className="mt-6"><CustomersPanel /></TabsContent>
      </Tabs>
    </div>
  );
}
