import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Loader2, RefreshCw, Send, Trash2, Sparkles, Upload } from "lucide-react";
import { toast } from "sonner";

const VOUCHER_TYPES = [
  "SALES",
  "PURCHASE",
  "RECEIPT",
  "PAYMENT",
  "JOURNAL",
  "CONTRA",
  "DEBIT_NOTE",
  "CREDIT_NOTE",
];

const STOCK_KINDS = [
  "stock_item",
  "stock_group",
  "stock_category",
  "group",
  "ledger",
  "unit",
  "godown",
  "voucher_type",
];

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function TallyPushPanel() {
  const qc = useQueryClient();
  const [connectorId, setConnectorId] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [vType, setVType] = useState("SALES");
  const [vNumber, setVNumber] = useState("");
  const [vDate, setVDate] = useState(today());
  const [vParty, setVParty] = useState("");
  const [vAmount, setVAmount] = useState("");
  const [vNarr, setVNarr] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sKind, setSKind] = useState("stock_item");
  const [sName, setSName] = useState("");
  const [sParent, setSParent] = useState("");
  const [sUnit, setSUnit] = useState("");

  const tallyStatus = useQuery({
    queryKey: ["tally-status"],
    queryFn: () => api.getTallyStatus(),
    refetchOnWindowFocus: false,
  });
  const connectors = tallyStatus.data?.connectors ?? [];
  const companies = tallyStatus.data?.companies ?? [];

  const vouchersQuery = useQuery({
    queryKey: ["push-vouchers"],
    queryFn: () => api.getPushVouchers(),
    refetchOnWindowFocus: false,
  });
  const vouchers = vouchersQuery.data?.vouchers ?? [];

  const stockQuery = useQuery({
    queryKey: ["push-stock"],
    queryFn: () => api.getPushStock(),
    refetchOnWindowFocus: false,
  });
  const stockItems = stockQuery.data?.stockItems ?? [];
  const masters = stockQuery.data?.masters ?? [];

  const commandsQuery = useQuery({
    queryKey: ["tally-commands"],
    queryFn: () => api.getTallyCommands({ limit: 10 }),
    refetchInterval: 15_000,
    refetchOnWindowFocus: false,
  });
  const commands = commandsQuery.data?.commands ?? [];

  const invalidate = () => {
    vouchersQuery.refetch();
    stockQuery.refetch();
    commandsQuery.refetch();
    qc.invalidateQueries({ queryKey: ["tally-masters"] });
  };

  const createMut = useMutation({
    mutationFn: () =>
      api.createPushVoucher({
        voucherType: vType,
        voucherNumber: vNumber.trim(),
        voucherDate: vDate,
        partyName: vParty.trim(),
        amount: Number(vAmount),
        narration: vNarr.trim(),
      }),
    onSuccess: () => {
      toast.success("Voucher draft created — ready to push");
      setVNumber("");
      setVParty("");
      setVAmount("");
      setVNarr("");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const delMut = useMutation({
    mutationFn: (id: string) => api.deletePushVoucher(id),
    onSuccess: () => {
      toast.success("Draft deleted");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const seedVMut = useMutation({
    mutationFn: () => api.seedPushVouchers(),
    onSuccess: (d) => {
      toast.success(`Sample vouchers ready: ${d.created} created, ${d.skipped} already there`);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const pushMut = useMutation({
    mutationFn: () => {
      if (!connectorId) throw new Error("Select a connector first");
      if (!companyId) throw new Error("Select a Tally company first");
      const ids = [...selected];
      if (ids.length === 0) throw new Error("Select at least one voucher");
      return api.pushPushVouchers({ connectorId, companyId, voucherIds: ids });
    },
    onSuccess: (d) => {
      toast.success(`Queued ${d.voucherCount} voucher(s) → ${d.connectorId.slice(0, 14)}…`);
      setSelected(new Set());
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const createStockMut = useMutation({
    mutationFn: () =>
      api.createPushStock({
        kind: sKind,
        name: sName.trim(),
        parent: sParent.trim(),
        unit: sUnit.trim(),
      }),
    onSuccess: () => {
      toast.success("Tally master created — ready to push");
      setSName("");
      setSParent("");
      setSUnit("");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const delStockMut = useMutation({
    mutationFn: ({ kind, id }: { kind: string; id: string }) => api.deletePushStock(kind, id),
    onSuccess: () => {
      toast.success("Master deleted");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const seedSMut = useMutation({
    mutationFn: () => api.seedPushStock(),
    onSuccess: (d) => {
      toast.success(`Sample masters ready: ${d.created} created, ${d.skipped} already there`);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="space-y-6">
      {/* Target picker */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Upload className="h-4 w-4" />
            Push to Tally
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Author Tally-shaped vouchers, stock items and groups in the cloud, then queue them.
            The connector polls and writes to Tally locally — nothing dials in.
          </p>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground">Connector:</span>
          <select value={connectorId} onChange={(e) => setConnectorId(e.target.value)} className="rounded-md border px-2 py-1">
            <option value="">Select…</option>
            {connectors.map((c) => (
              <option key={c.connectorId} value={c.connectorId}>
                {c.name} ({c.connectorId.slice(0, 14)}…)
              </option>
            ))}
          </select>
          <span className="text-muted-foreground">Company:</span>
          <select value={companyId} onChange={(e) => setCompanyId(e.target.value)} className="rounded-md border px-2 py-1">
            <option value="">Select…</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.tallyCompanyName}
              </option>
            ))}
          </select>
          <Button variant="outline" size="sm" className="ml-auto gap-1.5" onClick={invalidate}>
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </Button>
        </CardContent>
      </Card>

      {/* Vouchers */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-3">
            <CardTitle>Vouchers — sales, purchase, receipt, payment, journal…</CardTitle>
            <Button variant="outline" size="sm" className="ml-auto gap-1.5" onClick={() => seedVMut.mutate()} disabled={seedVMut.isPending}>
              {seedVMut.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
              Load sample data
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-2 md:grid-cols-7">
            <select value={vType} onChange={(e) => setVType(e.target.value)} className="rounded-md border px-2 py-1.5 text-xs">
              {VOUCHER_TYPES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
            <Input placeholder="Number (e.g. SALE-1003)" value={vNumber} onChange={(e) => setVNumber(e.target.value)} className="text-xs" />
            <Input type="date" value={vDate} onChange={(e) => setVDate(e.target.value)} className="text-xs" />
            <Input placeholder="Party ledger" value={vParty} onChange={(e) => setVParty(e.target.value)} className="text-xs" />
            <Input placeholder="Amount" type="number" min="0" step="0.01" value={vAmount} onChange={(e) => setVAmount(e.target.value)} className="text-xs" />
            <Input placeholder="Narration" value={vNarr} onChange={(e) => setVNarr(e.target.value)} className="text-xs" />
            <Button size="sm" onClick={() => createMut.mutate()} disabled={createMut.isPending || !vNumber.trim() || !vParty.trim() || !vAmount}>
              {createMut.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Add"}
            </Button>
          </div>

          {vouchersQuery.isLoading ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading drafts…</p>
          ) : vouchers.length === 0 ? (
            <p className="rounded-lg border bg-muted/30 px-3 py-4 text-center text-sm text-muted-foreground">
              No voucher drafts yet. Click “Load sample data” for 9 ready-to-push Tally vouchers, or add your own above.
            </p>
          ) : (
            <>
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b bg-muted/50 text-left">
                      <th className="px-3 py-2"></th>
                      <th className="px-3 py-2">Type</th>
                      <th className="px-3 py-2">Number</th>
                      <th className="px-3 py-2">Date</th>
                      <th className="px-3 py-2">Party</th>
                      <th className="px-3 py-2 text-right">Amount</th>
                      <th className="px-3 py-2">Status</th>
                      <th className="px-3 py-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {vouchers.map((v) => (
                      <tr key={v.id} className="border-b last:border-0">
                        <td className="px-3 py-1.5">
                          <input type="checkbox" checked={selected.has(v.id)} disabled={v.status !== "DRAFT"} onChange={() => toggle(v.id)} aria-label={`Select ${v.voucherNumber}`} />
                        </td>
                        <td className="px-3 py-1.5"><Badge variant="secondary" className="font-mono text-[10px]">{v.voucherType}</Badge></td>
                        <td className="px-3 py-1.5 font-mono font-medium">{v.voucherNumber}</td>
                        <td className="px-3 py-1.5">{v.voucherDate}</td>
                        <td className="px-3 py-1.5">{v.partyName}</td>
                        <td className="px-3 py-1.5 text-right">₹{Number(v.amount).toLocaleString("en-IN")}</td>
                        <td className="px-3 py-1.5"><Badge variant={v.status === "DRAFT" ? "outline" : "default"}>{v.status}</Badge></td>
                        <td className="px-3 py-1.5 text-right">
                          {v.status === "DRAFT" && (
                            <Button variant="ghost" size="sm" onClick={() => delMut.mutate(v.id)}>
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Button size="sm" className="gap-1.5" onClick={() => pushMut.mutate()} disabled={pushMut.isPending}>
                {pushMut.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                Push selected to Tally ({selected.size})
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      {/* Stock / groups */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-3">
            <CardTitle>Stock items, groups, ledgers, units, godowns</CardTitle>
            <Button variant="outline" size="sm" className="ml-auto gap-1.5" onClick={() => seedSMut.mutate()} disabled={seedSMut.isPending}>
              {seedSMut.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
              Load sample data
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Stock items live in products (push via Master sync → SKU). Groups, ledgers, units and godowns are shown here as Tally-ready masters.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
            <select value={sKind} onChange={(e) => setSKind(e.target.value)} className="rounded-md border px-2 py-1.5 text-xs">
              {STOCK_KINDS.map((k) => (
                <option key={k} value={k}>{k}</option>
              ))}
            </select>
            <Input placeholder="Name" value={sName} onChange={(e) => setSName(e.target.value)} className="text-xs" />
            <Input placeholder="Parent / group" value={sParent} onChange={(e) => setSParent(e.target.value)} className="text-xs" />
            <Input placeholder="Unit (items)" value={sUnit} onChange={(e) => setSUnit(e.target.value)} className="text-xs" />
            <Button size="sm" onClick={() => createStockMut.mutate()} disabled={createStockMut.isPending || !sName.trim()}>
              {createStockMut.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Add"}
            </Button>
          </div>

          {stockQuery.isLoading ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>
          ) : stockItems.length === 0 && masters.length === 0 ? (
            <p className="rounded-lg border bg-muted/30 px-3 py-4 text-center text-sm text-muted-foreground">
              No masters yet. Click “Load sample data” for groups, ledgers, stock items, units and godowns.
            </p>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b bg-muted/50 text-left">
                      <th className="px-3 py-2">Stock item</th>
                      <th className="px-3 py-2">Group</th>
                      <th className="px-3 py-2">Unit</th>
                      <th className="px-3 py-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {stockItems.map((s) => (
                      <tr key={s.id} className="border-b last:border-0">
                        <td className="px-3 py-1.5 font-medium">{s.name}</td>
                        <td className="px-3 py-1.5 text-muted-foreground">{s.group ?? "—"}</td>
                        <td className="px-3 py-1.5">{s.unit ?? "—"}</td>
                        <td className="px-3 py-1.5 text-right">
                          <Button variant="ghost" size="sm" onClick={() => delStockMut.mutate({ kind: "stock_item", id: s.id })}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b bg-muted/50 text-left">
                      <th className="px-3 py-2">Master</th>
                      <th className="px-3 py-2">Kind</th>
                      <th className="px-3 py-2">Parent</th>
                      <th className="px-3 py-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {masters.map((m) => (
                      <tr key={m.id} className="border-b last:border-0">
                        <td className="px-3 py-1.5 font-medium">{m.name}</td>
                        <td className="px-3 py-1.5"><Badge variant="secondary" className="font-mono text-[10px]">{m.kind}</Badge></td>
                        <td className="px-3 py-1.5 text-muted-foreground">{m.parent ?? "—"}</td>
                        <td className="px-3 py-1.5 text-right">
                          <Button variant="ghost" size="sm" onClick={() => delStockMut.mutate({ kind: m.kind, id: m.id })}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Recent pushes */}
      <Card>
        <CardHeader>
          <CardTitle>Recent push commands</CardTitle>
        </CardHeader>
        <CardContent>
          {commands.length === 0 ? (
            <p className="text-sm text-muted-foreground">No push commands yet.</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b bg-muted/50 text-left">
                    <th className="px-3 py-2">Command</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Items</th>
                    <th className="px-3 py-2">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {commands.map((c) => (
                    <tr key={c.id} className="border-b last:border-0 font-mono">
                      <td className="px-3 py-1.5">{c.command}</td>
                      <td className="px-3 py-1.5"><Badge variant="outline">{c.status}</Badge></td>
                      <td className="px-3 py-1.5">{c.voucherCount ?? "—"}</td>
                      <td className="px-3 py-1.5">{c.createdAt}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
