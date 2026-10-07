import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CustomersPanel } from "@/components/app/CustomersPanel";
import { InvoicesPanel } from "@/components/app/InvoicesPanel";
import { PaymentsPanel } from "@/components/app/PaymentsPanel";
import { ApplyPaymentPanel } from "@/components/app/ApplyPaymentPanel";
import { TallyDataPanel } from "@/components/app/TallyDataPanel";
import { TallyMasterPanel } from "@/components/app/TallyMasterPanel";
import { XeroConnectCard } from "@/components/app/XeroConnectCard";
import { TallyConnectCard } from "@/components/app/TallyConnectCard";

export function Dashboard() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">Manage customers, invoices, and reconcile bulk payments.</p>
      </div>

      {/* Integrations */}
      <XeroConnectCard />
      <TallyConnectCard />

      <Tabs defaultValue="apply" className="w-full">
        <TabsList>
          <TabsTrigger value="apply">Apply payment</TabsTrigger>
          <TabsTrigger value="invoices">Invoices</TabsTrigger>
          <TabsTrigger value="payments">Payments</TabsTrigger>
          <TabsTrigger value="customers">Customers</TabsTrigger>
          <TabsTrigger value="tally">Tally data</TabsTrigger>
          <TabsTrigger value="masters">Master sync</TabsTrigger>
        </TabsList>
        <TabsContent value="apply" className="mt-6"><ApplyPaymentPanel /></TabsContent>
        <TabsContent value="invoices" className="mt-6"><InvoicesPanel /></TabsContent>
        <TabsContent value="payments" className="mt-6"><PaymentsPanel /></TabsContent>
        <TabsContent value="customers" className="mt-6"><CustomersPanel /></TabsContent>
        <TabsContent value="tally" className="mt-6"><TallyDataPanel /></TabsContent>
        <TabsContent value="masters" className="mt-6"><TallyMasterPanel /></TabsContent>
      </Tabs>
    </div>
  );
}
