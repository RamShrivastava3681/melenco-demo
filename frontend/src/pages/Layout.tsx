import { Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Receipt, LogOut, Sun, Moon } from "lucide-react";
import { useTheme } from "@/lib/useTheme";

export function DashboardLayout() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { user, signout } = useAuth();
  const { theme, toggleTheme } = useTheme();

  function handleSignOut() {
    qc.cancelQueries();
    qc.clear();
    signout();
    navigate("/auth", { replace: true });
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-3">
          <div className="flex items-center gap-2 font-semibold">
            <Receipt className="h-5 w-5 text-primary" />
            <span>Ledgerly</span>
          </div>
          <div className="flex items-center gap-1 text-sm">
            <span className="hidden text-muted-foreground sm:inline">{user?.email}</span>
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleTheme}
              title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
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
    </div>
  );
}
