import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, RefreshCw, Database, FileJson } from "lucide-react";

export function TallyDataPanel() {
  const [entityType, setEntityType] = useState<string>("");
  const [limit, setLimit] = useState(25);
  const [offset, setOffset] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const batchesQuery = useQuery({
    queryKey: ["tally-batches-all", entityType],
    queryFn: () =>
      api.getTallyBatches({
        entityType: entityType || undefined,
        limit: 25,
      }),
    refetchOnWindowFocus: false,
  });

  const recordsQuery = useQuery({
    queryKey: ["tally-records", entityType, limit, offset],
    queryFn: () =>
      api.getReceivedRecords({
        entityType: entityType || undefined,
        limit,
        offset,
      }),
    refetchOnWindowFocus: false,
  });

  const batches = batchesQuery.data?.batches ?? [];
  const records = recordsQuery.data?.records ?? [];

  const refresh = () => {
    setOffset(0);
    batchesQuery.refetch();
    recordsQuery.refetch();
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-3">
          <CardTitle className="flex items-center gap-2">
            <Database className="h-4 w-4" />
            Tally data
          </CardTitle>
          <span className="text-xs text-muted-foreground">
            Raw data received from the connector (read-only)
          </span>
          <Button
            variant="outline"
            size="sm"
            className="ml-auto gap-1.5"
            onClick={refresh}
            disabled={batchesQuery.isFetching || recordsQuery.isFetching}
          >
            {(batchesQuery.isFetching || recordsQuery.isFetching) ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Filters */}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground">Entity:</span>
          <select
            value={entityType}
            onChange={(e) => {
              setEntityType(e.target.value);
              setOffset(0);
            }}
            className="rounded-md border bg-background px-2 py-1 text-xs"
          >
            <option value="">All</option>
            {[
              "sales_voucher",
              "purchase_voucher",
              "receipt_voucher",
              "payment_voucher",
              "journal_voucher",
              "ledger",
              "stock_item",
              "day_book",
            ].map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
          <span className="text-muted-foreground">Page size:</span>
          <select
            value={limit}
            onChange={(e) => {
              setLimit(Number(e.target.value));
              setOffset(0);
            }}
            className="rounded-md border bg-background px-2 py-1 text-xs"
          >
            {[10, 25, 50, 100].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>

        {/* Batches */}
        <div className="space-y-2">
          <h4 className="text-sm font-medium">
            Batches{" "}
            <span className="text-xs font-normal text-muted-foreground">
              ({batches.length} recent)
            </span>
          </h4>
          {batchesQuery.isLoading ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading batches…
            </p>
          ) : batches.length === 0 ? (
            <p className="rounded-lg border bg-muted/30 px-3 py-4 text-center text-sm text-muted-foreground">
              No batches received yet. Pair the connector and sync from Tally —
              batches will appear here.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-muted/50 text-left">
                    <th className="px-3 py-2 font-medium">Batch</th>
                    <th className="px-3 py-2 font-medium">Entity</th>
                    <th className="px-3 py-2 font-medium">Records</th>
                    <th className="px-3 py-2 font-medium">Connector</th>
                    <th className="px-3 py-2 font-medium">Received</th>
                    <th className="px-3 py-2 font-medium">Dup</th>
                  </tr>
                </thead>
                <tbody>
                  {batches.map((b) => (
                    <tr key={b.batch_id} className="border-t font-mono">
                      <td className="px-3 py-1.5 truncate" title={b.batch_id}>
                        {b.batch_id.slice(0, 18)}…
                      </td>
                      <td className="px-3 py-1.5">
                        <Badge variant="secondary" className="font-mono text-[10px]">
                          {b.entity_type}
                        </Badge>
                      </td>
                      <td className="px-3 py-1.5">{b.received_count}</td>
                      <td className="px-3 py-1.5 truncate" title={b.connector_id}>
                        {String(b.connector_id).slice(0, 16)}…
                      </td>
                      <td className="px-3 py-1.5 whitespace-nowrap">{b.created_at}</td>
                      <td className="px-3 py-1.5">{b.duplicate ? "yes" : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Records (raw JSON) */}
        <div className="space-y-2">
          <h4 className="flex items-center gap-1.5 text-sm font-medium">
            <FileJson className="h-4 w-4" />
            Records
            <span className="text-xs font-normal text-muted-foreground">
              (raw JSON exactly as sent by the connector)
            </span>
          </h4>
          {recordsQuery.isLoading ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading records…
            </p>
          ) : records.length === 0 ? (
            <p className="rounded-lg border bg-muted/30 px-3 py-4 text-center text-sm text-muted-foreground">
              No records yet for this filter.
            </p>
          ) : (
            <div className="space-y-2">
              {records.map((r) => {
                const open = expandedId === r.id;
                return (
                  <div key={r.id} className="rounded-lg border">
                    <button
                      className="flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left text-xs"
                      onClick={() => setExpandedId(open ? null : r.id)}
                    >
                      <Badge variant="secondary" className="font-mono text-[10px]">
                        {r.entity_type}
                      </Badge>
                      <span className="font-mono text-muted-foreground">
                        {r.source_voucher_number || r.source_object_id || r.id.slice(0, 8)}
                      </span>
                      {r.source_voucher_date && (
                        <span className="text-muted-foreground">{r.source_voucher_date}</span>
                      )}
                      <span className="ml-auto font-mono text-muted-foreground">
                        batch {String(r.batch_id).slice(0, 12)}… · {open ? "hide JSON" : "view JSON"}
                      </span>
                    </button>
                    {open && (
                      <pre className="max-h-96 overflow-auto border-t bg-muted/30 p-3 text-[11px] leading-relaxed">
                        {JSON.stringify(r.payload, null, 2)}
                      </pre>
                    )}
                  </div>
                );
              })}
              <div className="flex items-center gap-2 pt-1 text-xs">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - limit))}
                >
                  ← Prev
                </Button>
                <span className="text-muted-foreground">
                  offset {offset} · showing {records.length}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={records.length < limit}
                  onClick={() => setOffset(offset + limit)}
                >
                  Next →
                </Button>
              </div>
            </div>
          )}
          {recordsQuery.isError && (
            <p className="text-xs text-destructive">
              Failed to load records. Is Tally connected?
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
