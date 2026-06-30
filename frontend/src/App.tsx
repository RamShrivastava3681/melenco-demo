import { createBrowserRouter, redirect } from "react-router-dom";
import { getToken } from "@/lib/auth";
import { Landing } from "@/pages/Landing";
import { AuthPage } from "@/pages/Auth";
import { DashboardLayout } from "@/pages/Layout";
import { Dashboard } from "@/pages/Dashboard";

function authGuard() {
  const token = getToken();
  if (!token) throw redirect("/auth");
  return null;
}

function guestGuard() {
  const token = getToken();
  if (token) throw redirect("/app");
  return null;
}

export const router = createBrowserRouter([
  {
    path: "/",
    element: <Landing />,
  },
  {
    path: "/auth",
    loader: guestGuard,
    element: <AuthPage />,
  },
  {
    path: "/app",
    loader: authGuard,
    element: <DashboardLayout />,
    children: [
      {
        index: true,
        element: <Dashboard />,
      },
    ],
  },
]);
