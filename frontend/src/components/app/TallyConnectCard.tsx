import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api, WHIZUNIK_API_URL } from "@/lib/api";
import { toast } from "sonner";
import {
  HardDrive,
  Copy,
  Unlink,
  CheckCircle2,
  XCircle,
  Loader2,
  KeyRound,
  Timer,
  Globe,
  Database,
} from "lucide-react";

interface ConnectorStatus {
  id: string;
  connectorId: string;
  name: string;
  status: string;
  online: boolean;
  deviceName: string | null;
  appVersion: string | null;
  lastHeartbeat: string | null;
  lastSync: string | null;
  lastSuccessfulSync: string | null;
  createdAt: string;
}

interface CurrentSync {
  syncId: string;
  entityType: string;
  status: string;
  totalRecords: number;
  processedRecords: number;
  totalBatches: number;
  processedBatches: number;
  failedRecords: number;
}

interface TallyStatus {
  connected: boolean;
  pairingCodeTtlMinutes: number;
  connectors: ConnectorStatus[];
  companies: Array<{ id: string; tallyCompanyGuid: string; tallyCompanyName: string }>;
  currentSync: CurrentSync | null;
  lastSync: { syncId: string; entityType: string; status: string; completedAt: string | null; successfulRecords: number; failedRecords: number } | null;
  lastConnection: {
    connectorId: string;
    connectorName: string;
    connectedAt: string;
    deviceName: string | null;
    appVersion: string | null;
  } | null;
  pendingPairing?: { active: boolean; expiresAt: string | null } | null;
}

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso.endsWith("Z") ? iso : iso + "Z").getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function TallyConnectCard() {
  const qc = useQueryClient();
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [justConnectedId, setJustConnectedId] = useState<string | null>(null);
  const prevConnectorIds = useRef<string | null>(null);
  const prevConnected = useRef(false);

  const { data: status, isLoading, refetch } = useQuery({
    queryKey: ["tally-status"],
    queryFn: () => api.getTallyStatus(),
    // While a pairing code is on screen, poll fast so the success banner
    // appears within seconds of the connector pairing. Otherwise 15s.
    refetchInterval: pairingCode ? 3_000 : 15_000,
    refetchOnWindowFocus: false,
  });

  const connected = status?.connected === true;
  const apiBase = status?.apiBaseUrl || WHIZUNIK_API_URL;

  // Receive: batches the platform got from connectors
  const { data: batchesData } = useQuery({
    queryKey: ["tally-batches"],
    queryFn: () => api.getTallyBatches({ limit: 5 }),
    refetchInterval: 15_000,
    refetchOnWindowFocus: false,
    enabled: connected,
  });
  const batches = batchesData?.batches ?? [];
  const totalReceived = batches.reduce((n, b) => n + (b.received_count || 0), 0);

  const pairingMut = useMutation({
    mutationFn: () => api.createTallyPairingCode(),
    onSuccess: (data) => {
      setPairingCode(data.code);
      setExpiresAt(data.expiresAt);
      toast.success("Pairing code generated — enter it in the Tally connector");
    },
    onError: (err: any) => toast.error(err.message || "Failed to generate pairing code"),
  });

  const disconnectMut = useMutation({
    mutationFn: (connectorId: string) => api.disconnectTallyConnector(connectorId),
    onSuccess: () => {
      refetch();
      qc.invalidateQueries({ queryKey: ["tally-batches"] });
      toast.success("Connector revoked");
    },
    onError: (err: any) => toast.error(err.message || "Failed to disconnect connector"),
  });

  // Countdown for the pairing code
  useEffect(() => {
    if (!expiresAt) return;
    const tick = () => {
      const left = Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
      setSecondsLeft(left);
      if (left === 0) {
        setPairingCode(null);
        setExpiresAt(null);
      }
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [expiresAt]);

  const connectors = status?.connectors ?? [];
  const currentSync = status?.currentSync ?? null;

  // Success response: when a new connector appears (or disconnected → connected),
  // show a toast + success banner and dismiss the pairing code UI so the card
  // flips to "Connected" instead of still showing the pairing key.
  useEffect(() => {
    const ids = connectors.map((c) => c.connectorId).sort().join(",");
    const wasConnected = prevConnected.current;
    const prevIds = prevConnectorIds.current;
    prevConnectorIds.current = ids;
    prevConnected.current = connected;
    if (!status) return;
    // First load: establish a baseline without toasting.
    if (prevIds === null) return;
    if (!connected || !ids) return;
    const prevSet = new Set(prevIds ? prevIds.split(",") : []);
    const fresh = connectors.find((c) => !prevSet.has(c.connectorId));
    if (fresh || !wasConnected) {
      const name = fresh?.name ?? status.lastConnection?.connectorName ?? "Tally connector";
      setJustConnectedId(fresh?.connectorId ?? status.lastConnection?.connectorId ?? "connected");
      // Dismiss the pairing key — the connection is now live.
      setPairingCode(null);
      setExpiresAt(null);
      toast.success(`Connected to ${name} — sync is live`, {
        description: "Your Tally connector paired successfully.",
      });
      refetch();
    } else if (pairingCode) {
      // Paired but no "fresh" diff (e.g. polling caught up) — still hide the key.
      setPairingCode(null);
      setExpiresAt(null);
    }
  }, [status?.connectors?.length, connected]);

  return (
    <Card className="overflow-hidden border-primary/10">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={`rounded-lg p-2 ${connected ? "bg-primary/10" : "bg-muted"}`}>
              <HardDrive className={`h-5 w-5 ${connected ? "text-primary" : "text-muted-foreground"}`} />
            </div>
            <div>
              <CardTitle className="text-base">TallyPrime Integration</CardTitle>
              <CardDescription>
                {connected
                  ? "Local connector paired — data syncs from your TallyPrime machine"
                  : "Pair the local Tally connector running on your Windows PC"}
              </CardDescription>
            </div>
          </div>
          {connected && (
            <div className="flex items-center gap-1.5 text-xs">
              {connectors.some((c) => c.online) ? (
                <>
                  <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                  <span className="font-medium text-emerald-600 dark:text-emerald-400">Online</span>
                </>
              ) : (
                <>
                  <XCircle className="h-4 w-4 text-amber-500" />
                  <span className="font-medium text-amber-600 dark:text-amber-400">Offline</span>
                </>
              )}
            </div>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Success response — shown right after a connector pairs */}
        {(justConnectedId || status?.lastConnection) && connected && (
          <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3.5 space-y-1">
            <p className="flex items-center gap-1.5 text-sm font-medium text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 className="h-4 w-4" />
              {justConnectedId ? "Successfully connected to Tally" : "Tally connected"}
              {justConnectedId && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto h-6 px-2 text-xs"
                  onClick={() => setJustConnectedId(null)}
                >
                  Dismiss
                </Button>
              )}
            </p>
            <p className="text-xs text-muted-foreground">
              {status?.lastConnection
                ? `${status.lastConnection.connectorName}${
                    status.lastConnection.deviceName ? ` (${status.lastConnection.deviceName})` : ""
                  } · paired ${timeAgo(status.lastConnection.connectedAt)}`
                : "Connector paired and syncing."}
              {status?.lastSync
                ? ` · Last sync: ${status.lastSync.successfulRecords} records (${status.lastSync.status})`
                : ""}
            </p>
          </div>
        )}
        {/* Canonical Cloud API address — the connector talks to this URL */}
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-xs">
          <Globe className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-muted-foreground">Cloud API:</span>
          <code className="font-mono font-medium select-all">{apiBase}</code>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => {
              navigator.clipboard.writeText(apiBase);
              toast.success("API URL copied");
            }}
          >
            <Copy className="h-3 w-3" />
          </Button>
        </div>
        {/* Pairing code display */}
        {pairingCode && (
          <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium">
              <KeyRound className="h-4 w-4 text-primary" />
              Enter this code in your Tally connector
            </div>
            <div className="flex items-center gap-3">
              <code className="rounded-md bg-background border px-3 py-1.5 font-mono text-lg tracking-widest select-all">
                {pairingCode}
              </code>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  navigator.clipboard.writeText(pairingCode);
                  toast.success("Code copied");
                }}
                className="gap-1"
              >
                <Copy className="h-3.5 w-3.5" /> Copy
              </Button>
            </div>
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Timer className="h-3 w-3" />
              Expires in {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, "0")} — single use
            </p>
          </div>
        )}

        {/* Current sync progress */}
        {currentSync && (
          <div className="rounded-lg border bg-muted/30 p-3 space-y-1.5">
            <div className="flex items-center justify-between text-xs font-medium">
              <span>
                Syncing {currentSync.entityType.replace(/_/g, " ").toLowerCase()}…
              </span>
              <span className="text-muted-foreground">
                batch {currentSync.processedBatches}/{currentSync.totalBatches || "—"}
              </span>
            </div>
            <div className="h-1.5 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full bg-primary transition-all"
                style={{
                  width: `${
                    currentSync.totalRecords > 0
                      ? Math.min(100, (currentSync.processedRecords / currentSync.totalRecords) * 100)
                      : 10
                  }%`,
                }}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {currentSync.processedRecords}/{currentSync.totalRecords || "?"} records
              {currentSync.failedRecords > 0 && ` · ${currentSync.failedRecords} failed`}
            </p>
          </div>
        )}

        {/* Connector list */}
        {isLoading ? (
          <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : connected ? (
          <div className="space-y-3">
            {connectors.map((c) => (
              <div key={c.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border p-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">
                    {c.name}
                    {c.deviceName && <span className="ml-2 text-xs text-muted-foreground">({c.deviceName})</span>}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Last heartbeat {timeAgo(c.lastHeartbeat)} · Last sync {timeAgo(c.lastSync)}
                    {c.appVersion && ` · v${c.appVersion}`}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => disconnectMut.mutate(c.connectorId)}
                  disabled={disconnectMut.isPending}
                  className="gap-1.5 text-muted-foreground"
                >
                  <Unlink className="h-4 w-4" /> Disconnect
                </Button>
              </div>
            ))}
            {/* Receive: what the platform got from connectors. Sending to the
                connector is paused for now — see the "Tally data" tab for
                incoming data. */}
            {batches.length > 0 && (
              <div className="rounded-lg border bg-muted/30 p-3 space-y-1.5">
                <p className="flex items-center gap-1.5 text-xs font-medium">
                  <Database className="h-3.5 w-3.5" />
                  Received from Tally · {totalReceived} records in last {batches.length} batch{batches.length === 1 ? "" : "es"}
                </p>
                {batches.map((b) => (
                  <p key={b.batch_id} className="text-xs text-muted-foreground font-mono truncate">
                    {b.batch_id} · {b.entity_type} · {b.received_count} records
                    {b.duplicate ? " · duplicate" : ""}
                  </p>
                ))}
              </div>
            )}
            {(status?.companies?.length ?? 0) > 0 && (
              <div className="flex flex-wrap gap-2">
                {status!.companies.map((co) => (
                  <span key={co.id} className="text-xs text-muted-foreground px-2 py-1 bg-muted rounded-md">
                    {co.tallyCompanyName}
                  </span>
                ))}
              </div>
            )}
          </div>
        ) : (
          !pairingCode && (
            <div className="space-y-2">
              <Button
                variant="default"
                onClick={() => pairingMut.mutate()}
                disabled={pairingMut.isPending}
                className="gap-2"
              >
                {pairingMut.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <KeyRound className="h-4 w-4" />
                )}
                Connect Tally
              </Button>
              <p className="text-xs text-muted-foreground">
                Generates a one-time code valid for {status?.pairingCodeTtlMinutes ?? 10} minutes. In the
                WhizUnik Tally connector enter server <span className="font-mono">{apiBase}</span> plus this
                code. No firewall changes needed — the connector talks outbound to WhizUnik only.
              </p>
            </div>
          )
        )}
      </CardContent>
    </Card>
  );
}
