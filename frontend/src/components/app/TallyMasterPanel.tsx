import { useState, Fragment } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, RefreshCw, Send, FileJson, ArrowUpRight } from "lucide-react";
import { toast } from "sonner";

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  SYNCED: "default",
  FAILED: "destructive",
  NEEDS_REVIEW: "outline",
  QUEUED: "secondary",
  SENDING: "secondary",
  NOT_SYNCED: "outline",
};

export function TallyMasterPanel() {
  const qc = useQueryClient();
  const [kind, setKind] = useState<string>("");
  const [status, setStatus] = useState<string>("");
  const [connectorId, setConnectorId] = useState<string>("");
  const [companyId, setCompanyId] = useState<string>("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const tallyStatus = useQuery({
    queryKey: ["tally-status"],
    queryFn: () => api.getTallyStatus(),
    refetchOnWindowFocus: false,
  });
  const connectors = tallyStatus.data?.connectors ?? [];
  const companies = tallyStatus.data?.companies ?? [];

  const mastersQuery = useQuery({
    queryKey: ["tally-masters", kind, status],
    queryFn: () =>
      api.getMasterStatus({
        kind: kind || undefined,
        status: status || undefined,
        limit: 100,
      }),
    refetchInterval: 15_000,
    refetchOnWindowFocus: false,
  });
  const masters = mastersQuery.data?.masters ?? [];

  const attemptsQuery = useQuery({
    queryKey: ["tally-master-attempts", expandedId],
    queryFn: () => {
      const [k, id] = (expandedId ?? "").split("|");
      return api.getMasterAttempts(k, id);
    },
    enabled: !!expandedId,
    refetchOnWindowFocus: false,
  });

  const pushMut = useMutation({
    mutationFn: (items: Array<{ kind: string; id: string }>) => {
      if (!connectorId) throw new Error("Select a connector first");
      if (!companyId) throw new Error("Select a Tally company first");
      return api.pushMasters({ connectorId, companyId, items });
    },
    onSuccess: (data) => {
      if (data.queuedCount > 0) toast.success(`Queued ${data.queuedCount} master(s) for Tally`);
      for (const r of data.rejected) toast.error(`${r.kind} ${r.id}: ${r.reason}`);
      mastersQuery.refetch();
      qc.invalidateQueries({ queryKey: ["tally-batches"] });
    },
    onError: (err: Error) => toast.error(err.message || "Failed to queue masters"),
  });

  const toggle = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const queueSelected = () => {
    const items = masters
      .filter((m) => selected.has(`${m.kind}|${m.id}`))
      .map((m) => ({ kind: m.kind, id: m.id }));
    if (items.length === 0) {
      toast.error("Select at least one master record");
      return;
    }
    pushMut.mutate(items);
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-3">
          <CardTitle className="flex items-center gap-2">
            <ArrowUpRight className="h-4 w-4" />
            Master sync
          </CardTitle>
          <span className="text-xs text-muted-foreground">
            WhizUnik customers, suppliers and SKUs → Tally ledgers and stock items (dummy/test data only)
          </span>
          <Button
            variant="outline"
            size="sm"
            className="ml-auto gap-1.5"
            onClick={() => mastersQuery.refetch()}
            disabled={mastersQuery.isFetching}
          >
            {mastersQuery.isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Target + filters */}
        <div className="flex flex-wrap items-center gap-2 text-xs">
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
          <span className="text-muted-foreground">Kind:</span>
          <select value={kind} onChange={(e) => setKind(e.target.value)} className="rounded-md border px-2 py-1">
            <option value="">All</option>
            <option value="customer">Customers</option>
            <option value="supplier">Suppliers</option>
            <option value="sku">SKUs</option>
          </select>
          <span className="text-muted-foreground">Status:</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)} className="rounded-md border px-2 py-1">
            <option value="">All</option>
            {["NOT_SYNCED", "QUEUED", "SENDING", "SYNCED", "FAILED", "NEEDS_REVIEW"].map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <Button size="sm" className="gap-1.5" onClick={queueSelected} disabled={pushMut.isPending}>
            {pushMut.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
            Send selected to Tally
          </Button>
        </div>

        {/* Master table */}
        {mastersQuery.isLoading ? (
          <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : masters.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No master records yet. Seed Phase 3 dummy data, then queue records for the connector.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b bg-muted/50 text-left">
                  <th className="px-3 py-2"></th>
                  <th className="px-3 py-2">Kind</th>
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Tally record</th>
                  <th className="px-3 py-2">Attempts</th>
                  <th className="px-3 py-2">Error</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {masters.map((m) => {
                  const key = `${m.kind}|${m.id}`;
                  return (
                    <Fragment key={key}>
                      <tr className="border-b last:border-0">
                        <td className="px-3 py-1.5">
                          <input
                            type="checkbox"
                            checked={selected.has(key)}
                            onChange={() => toggle(key)}
                            aria-label={`Select ${m.displayName}`}
                          />
                        </td>
                        <td className="px-3 py-1.5 text-muted-foreground">{m.kind}</td>
                        <td className="px-3 py-1.5 font-medium">{m.displayName} <span className="text-muted-foreground font-normal">v{m.version}</span></td>
                        <td className="px-3 py-1.5"><Badge variant={STATUS_VARIANT[m.status] ?? "outline"}>{m.status}</Badge></td>
                        <td className="px-3 py-1.5">{m.tallyName ?? "—"}</td>
                        <td className="px-3 py-1.5">{m.attempts}</td>
                        <td className="px-3 py-1.5 max-w-55 truncate text-muted-foreground" title={m.lastError ?? ""}>{m.lastError ?? "—"}</td>
                        <td className="px-3 py-1.5">
                          <Button variant="ghost" size="sm" onClick={() => setExpandedId(expandedId === key ? null : key)}>
                            <FileJson className="h-3.5 w-3.5" />
                          </Button>
                        </td>
                      </tr>
                      {expandedId === key && (
                        <tr className="border-b bg-muted/20">
                          <td colSpan={8} className="px-3 py-2">
                            {attemptsQuery.isLoading ? (
                              <span className="text-muted-foreground">Loading evidence…</span>
                            ) : (attemptsQuery.data?.attempts.length ?? 0) === 0 ? (
                              <span className="text-muted-foreground">No attempts recorded yet.</span>
                            ) : (
                              <div className="space-y-2">
                                {attemptsQuery.data!.attempts.map((a) => (
                                  <div key={a.id} className="rounded border bg-background p-2">
                                    <p className="font-mono">
                                      {a.requested_at} → {a.responded_at ?? "…"} · {a.tally_status} · retries {a.retry_count}
                                      {a.error_message && <span className="text-destructive"> · {a.error_message}</span>}
                                    </p>
                                    <details className="mt-1">
                                      <summary className="cursor-pointer text-muted-foreground">Request / response payloads</summary>
                                      <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap text-[11px]">
                                        {JSON.stringify({ request: a.requestPayload, response: a.responsePayload }, null, 2)}
                                      </pre>
                                    </details>
                                  </div>
                                ))}
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
