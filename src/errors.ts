/**
 * Base error for any non-2xx response from the BA Stamp API. Subclasses
 * narrow on the response code (401 → Unauthorized, 402 → NoCredits, etc.).
 */
export class BAStampError extends Error {
  /** HTTP status code. */
  readonly status: number;
  /** Machine-readable code from the API's error envelope (snake_case). */
  readonly type: string;
  /** Raw response body (parsed when JSON, otherwise the string). */
  readonly body: unknown;

  constructor(message: string, status: number, type: string, body: unknown) {
    super(message);
    this.name = "BAStampError";
    this.status = status;
    this.type = type;
    this.body = body;
  }
}

/** 400 — payload, hash, or parameter failed validation. */
export class BAStampInvalidRequestError extends BAStampError {
  constructor(message: string, body: unknown) {
    super(message, 400, "invalid_request", body);
    this.name = "BAStampInvalidRequestError";
  }
}

/** 401 — missing or wrong Authorization header. */
export class BAStampUnauthorizedError extends BAStampError {
  constructor(message: string, body: unknown) {
    super(message, 401, "unauthorized", body);
    this.name = "BAStampUnauthorizedError";
  }
}

/** 402 — account credits don't cover the request. Top up at bastamp.com/#pricing. */
export class BAStampNoCreditsError extends BAStampError {
  constructor(message: string, body: unknown) {
    super(message, 402, "no_credits", body);
    this.name = "BAStampNoCreditsError";
  }
}

/** 404 — no stamp exists for the requested hash. */
export class BAStampNotFoundError extends BAStampError {
  constructor(message: string, body: unknown) {
    super(message, 404, "not_found", body);
    this.name = "BAStampNotFoundError";
  }
}

/** 409 — Idempotency-Key reused with a different payload, or stamp not anchored yet for certificate. */
export class BAStampConflictError extends BAStampError {
  constructor(message: string, type: string, body: unknown) {
    super(message, 409, type, body);
    this.name = "BAStampConflictError";
  }
}

/** 429 — rate-limited. SDK retries automatically; surfaced only if retries exhaust. */
export class BAStampRateLimitedError extends BAStampError {
  constructor(message: string, body: unknown) {
    super(message, 429, "rate_limited", body);
    this.name = "BAStampRateLimitedError";
  }
}
