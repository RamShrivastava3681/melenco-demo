import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { FileText, Receipt, Wallet } from "lucide-react";

export function Landing() {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2 font-semibold">
            <Receipt className="h-5 w-5 text-primary" />
            <span>Ledgerly</span>
          </div>
          <div className="flex gap-2">
            <Button asChild variant="ghost"><Link to="/auth">Sign in</Link></Button>
            <Button asChild><Link to="/auth">Get started</Link></Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-20">
        <h1 className="text-5xl font-semibold tracking-tight text-foreground">
          Reconcile bulk payments against your invoices in seconds.
        </h1>
        <p className="mt-6 max-w-2xl text-lg text-muted-foreground">
          Import invoices from CSV or Excel. Record bulk payments per customer, select which dues to close, and let Ledgerly calculate balances, payment days, and late days automatically.
        </p>
        <div className="mt-8">
          <Button asChild size="lg"><Link to="/auth">Open the app</Link></Button>
        </div>
        <div className="mt-20 grid gap-6 md:grid-cols-3">
          {[
            { icon: FileText, title: "Import invoices", body: "Upload CSV or XLSX with invoice number, issue date, due date, and amount." },
            { icon: Wallet, title: "Apply bulk payments", body: "Enter payment amount and date. See every invoice due/overdue and pick what to close." },
            { icon: Receipt, title: "Track aging", body: "Each closed invoice records payment days and late payment days automatically." },
          ].map((f) => (
            <div key={f.title} className="rounded-xl border bg-card p-6">
              <f.icon className="h-6 w-6 text-primary" />
              <h3 className="mt-4 font-semibold">{f.title}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{f.body}</p>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
