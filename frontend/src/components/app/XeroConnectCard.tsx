import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ExternalLink, RefreshCw, Unlink, CheckCircle2, XCircle, Cloud } from "lucide-react";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { useState } from "react";
import { XeroSyncDialog } from "./XeroSyncDialog";

export function XeroConnectCard() {
  const qc = useQueryClient();
  const [syncDialogOpen, setSyncDialogOpen] = useState(false);

  const { data: xeroStatus, refetch: refetchXeroStatus } = useQuery({
    queryKey: ["xero-status"],
    queryFn: () => api.getXeroStatus(),
    retry: false,
    refetchOnWindowFocus: false,
  });

  const disconnectMut = useMutation({
    mutationFn: () => api.disconnectXero(),
    onSuccess: () => {
      refetchXeroStatus();
      qc.invalidateQueries({ queryKey: ["customers"] });
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["payments"] });
      toast.success("Disconnected from Xero");
    },
    onError: () => {
      toast.error("Failed to disconnect from Xero");
    },
  });

  async function handleConnect() {
    try {
      const { url } = await api.getXeroAuthUrl();
      window.location.href = url;
    } catch (err: any) {
      toast.error(err.message || "Failed to initiate Xero connection");
    }
  }

  const isConnected = xeroStatus?.connected === true;
  const isExpired = xeroStatus?.tokenExpired === true;

  return (
    <Card className="overflow-hidden border-primary/10">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={`rounded-lg p-2 ${isConnected ? "bg-primary/10" : "bg-muted"}`}>
              <Cloud className={`h-5 w-5 ${isConnected ? "text-primary" : "text-muted-foreground"}`} />
            </div>
            <div>
              <CardTitle className="text-base">Xero Integration</CardTitle>
              <CardDescription>
                {isConnected
                  ? isExpired
                    ? "Token expired — reconnect to continue syncing"
                    : "Connected and ready to sync"
                  : "Sync your accounting data automatically"}
              </CardDescription>
            </div>
          </div>
          {isConnected && (
            <div className="flex items-center gap-1.5 text-xs">
              {isExpired ? (
                <XCircle className="h-4 w-4 text-destructive" />
              ) : (
                <CheckCircle2 className="h-4 w-4 text-emerald-500" />
              )}
              <span className={isExpired ? "text-destructive font-medium" : "text-emerald-600 dark:text-emerald-400 font-medium"}>
                {isExpired ? "Expired" : "Active"}
              </span>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {isConnected ? (
          <div className="flex flex-wrap items-center gap-3">
            {xeroStatus?.tenantName && (
              <span className="text-sm text-muted-foreground px-2 py-1 bg-muted rounded-md">
                {xeroStatus.tenantName}
              </span>
            )}
            <Button
              variant="default"
              size="sm"
              onClick={() => setSyncDialogOpen(true)}
              disabled={isExpired}
              className="gap-1.5"
            >
              <RefreshCw className="h-4 w-4" />
              Sync Contacts
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => disconnectMut.mutate()}
              disabled={disconnectMut.isPending}
              className="gap-1.5 text-muted-foreground"
            >
              <Unlink className="h-4 w-4" />
              Disconnect
            </Button>
          </div>
        ) : (
          <Button
            variant="default"
            size="default"
            onClick={handleConnect}
            className="gap-2"
          >
            <ExternalLink className="h-4 w-4" />
            Connect to Xero
          </Button>
        )}
      </CardContent>

      {/* Sync dialog */}
      <XeroSyncDialog
        open={syncDialogOpen}
        onClose={() => setSyncDialogOpen(false)}
      />
    </Card>
  );
}
