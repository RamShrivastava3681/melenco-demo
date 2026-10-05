import { Response } from "express";

/**
 * Structured error codes for the Tally integration API.
 * Every error response has the shape: { success: false, error: { code, message } }
 */
export const ERROR_CODES = {
  AUTHENTICATION_FAILED: 401,
  AUTHORIZATION_FAILED: 403,
  INVALID_PAYLOAD: 400,
  INVALID_COMPANY: 400,
  INVALID_BATCH: 400,
  DUPLICATE_BATCH: 409,
  DUPLICATE_RECORD: 409,
  TALLY_DATA_INVALID: 422,
  NORMALIZATION_FAILED: 422,
  DATABASE_ERROR: 500,
  RATE_LIMITED: 429,
  SERVER_ERROR: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export class ApiError extends Error {
  code: ErrorCode;
  status: number;
  details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = ERROR_CODES[code];
    this.details = details;
  }
}

/** Send a structured error response (safe, non-sensitive message). */
export function sendError(
  res: Response,
  code: ErrorCode,
  message: string,
  details?: unknown,
  requestId?: string
): void {
  const status = ERROR_CODES[code];
  res.status(status).json({
    success: false,
    error: { code, message, ...(details !== undefined ? { details } : {}) },
    ...(requestId ? { requestId } : {}),
  });
}

/** Central error-handling middleware for the tally module. */
export function errorHandler(
  err: unknown,
  req: { requestId?: string },
  res: Response
): void {
  if (err instanceof ApiError) {
    sendError(res, err.code, err.message, err.details, req.requestId);
    return;
  }
  console.error("[tally] Unhandled error:", err);
  sendError(res, "SERVER_ERROR", "An internal error occurred", undefined, req.requestId);
}
