import { Outlet, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { useQueryClient, useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Receipt, LogOut, Sun, Moon, ExternalLink, RefreshCw, Unlink } from "lucide-react";
import { useTheme } from "@/lib/useTheme";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { useEffect, useState } from "react";
import { XeroSyncDialog } from "@/components/app/XeroSyncDialog";

export function DashboardLayout() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const qc = useQueryClient();
  const { user, signout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const [syncDialogOpen, setSyncDialogOpen] = useState(false);

  // Xero connection status
  const { data: xeroStatus, refetch: refetchXeroStatus } = useQuery({
    queryKey: ["xero-status"],
    queryFn: () => api.getXeroStatus(),
    retry: false,
    refetchOnWindowFocus: false,
  });

  // Handle Xero callback params
  useEffect(() => {
    const xeroConnected = searchParams.get("xero_connected");
    const xeroError = searchParams.get("xero_error");

    if (xeroConnected === "true") {
      toast.success("Connected to Xero successfully!");
      refetchXeroStatus();
    }

    if (xeroError) {
      toast.error(`Xero connection failed: ${xeroError}`);
    }

    // Clean up search params
    if (xeroConnected || xeroError) {
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, refetchXeroStatus, setSearchParams]);

  // Xero disconnect mutation
  const disconnectMut = useMutation({
    mutationFn: () => api.disconnectXero(),
    onSuccess: () => {
      refetchXeroStatus();
      toast.success("Disconnected from Xero");
    },
    onError: () => {
      toast.error("Failed to disconnect from Xero");
    },
  });

  // Xero connect handler
  async function handleConnect() {
    try {
      const { url } = await api.getXeroAuthUrl();
      // Redirect to Xero's consent page
      window.location.href = url;
    } catch (err: any) {
      toast.error(err.message || "Failed to initiate Xero connection");
    }
  }

  function handleSignOut() {
    qc.cancelQueries();
    qc.clear();
    signout();
    navigate("/auth", { replace: true });
  }

  const isXeroConnected = xeroStatus?.connected === true;

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-3">
          <div className="flex items-center gap-2 font-semibold">
            <Receipt className="h-5 w-5 text-primary" />
            <span>Ledgerly</span>
          </div>
          <div className="flex items-center gap-1.5 text-sm">
            {/* Xero connection */}
            {isXeroConnected ? (
              <>
                <span className="hidden text-xs text-muted-foreground sm:inline">
                  Xero: {xeroStatus.tenantName || "Connected"}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setSyncDialogOpen(true)}
                  title="Sync data from Xero"
                  className="gap-1.5"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Sync
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => disconnectMut.mutate()}
                  disabled={disconnectMut.isPending}
                  title="Disconnect from Xero"
                  className="h-8 w-8"
                >
                  <Unlink className="h-3.5 w-3.5 text-muted-foreground" />
                </Button>
              </>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={handleConnect}
                className="gap-1.5"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                Connect Xero
              </Button>
            )}

            <span className="hidden text-muted-foreground sm:inline">{user?.email}</span>
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleTheme}
              title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
              className="h-8 w-8"
            >
              {theme === "dark" ? (
                <Sun className="h-4 w-4" />
              ) : (
                <Moon className="h-4 w-4" />
              )}
            </Button>
            <Button variant="ghost" size="sm" onClick={handleSignOut}>
              <LogOut className="mr-1 h-4 w-4" /> Sign out
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-6 py-8">
        <Outlet />
      </main>

      {/* Xero sync dialog */}
      <XeroSyncDialog
        open={syncDialogOpen}
        onClose={() => setSyncDialogOpen(false)}
      />
    </div>
  );
}
