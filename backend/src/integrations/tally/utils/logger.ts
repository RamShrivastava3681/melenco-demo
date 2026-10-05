import type { Request } from "express";

/** Per-request logging that never dumps sensitive payloads. */

export function newRequestId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function requestIdOf(req: Request): string {
  return (req.headers["x-request-id"] as string) || (req as any).requestId || "-";
}

export function logInfo(scope: string, req: Request | null, message: string): void {
  const rid = req ? requestIdOf(req) : "-";
  console.log(`[tally][${scope}][${rid}] ${message}`);
}

export function logWarn(scope: string, req: Request | null, message: string): void {
  const rid = req ? requestIdOf(req) : "-";
  console.warn(`[tally][${scope}][${rid}] ${message}`);
}

export function logError(scope: string, req: Request | null, message: string, err?: unknown): void {
  const rid = req ? requestIdOf(req) : "-";
  const detail =
    err instanceof Error ? `${err.name}: ${err.message}` : err ? String(err) : "";
  // Never include request bodies/payloads in logs — financial data must stay out of app logs.
  console.error(`[tally][${scope}][${rid}] ${message}${detail ? ` — ${detail}` : ""}`);
}
