import { describe, expect, it } from "vitest";
import {
  BAStampConflictError,
  BAStampError,
  BAStampInvalidRequestError,
  BAStampNoCreditsError,
  BAStampNotFoundError,
  BAStampRateLimitedError,
  BAStampUnauthorizedError,
} from "../src/errors.js";

describe("error class hierarchy", () => {
  it("BAStampError is an instance of Error", () => {
    const e = new BAStampError("boom", 500, "internal", null);
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe("boom");
    expect(e.status).toBe(500);
    expect(e.type).toBe("internal");
  });

  it.each([
    { ctor: BAStampInvalidRequestError, status: 400, type: "invalid_request", name: "BAStampInvalidRequestError" },
    { ctor: BAStampUnauthorizedError, status: 401, type: "unauthorized", name: "BAStampUnauthorizedError" },
    { ctor: BAStampNoCreditsError, status: 402, type: "no_credits", name: "BAStampNoCreditsError" },
    { ctor: BAStampNotFoundError, status: 404, type: "not_found", name: "BAStampNotFoundError" },
    { ctor: BAStampRateLimitedError, status: 429, type: "rate_limited", name: "BAStampRateLimitedError" },
  ])("$name carries status $status and type $type", ({ ctor, status, type, name }) => {
    const e = new ctor("msg", { error: { type, message: "msg" } });
    expect(e).toBeInstanceOf(BAStampError);
    expect(e).toBeInstanceOf(Error);
    expect(e.status).toBe(status);
    expect(e.type).toBe(type);
    expect(e.name).toBe(name);
  });

  it("BAStampConflictError preserves the server's narrow `type` so callers can distinguish idempotency_conflict from not_anchored", () => {
    const idem = new BAStampConflictError("dup", "idempotency_conflict", null);
    const notAnchored = new BAStampConflictError("not yet", "not_anchored", null);
    expect(idem.type).toBe("idempotency_conflict");
    expect(notAnchored.type).toBe("not_anchored");
    expect(idem.status).toBe(409);
    expect(notAnchored.status).toBe(409);
  });

  it("preserves the raw response body in `.body`", () => {
    const body = { error: { type: "invalid_request", message: "bad hash" }, extra: "context" };
    const e = new BAStampInvalidRequestError("bad hash", body);
    expect(e.body).toEqual(body);
  });

  it("subclasses can be caught as BAStampError", () => {
    try {
      throw new BAStampNoCreditsError("topup needed", null);
    } catch (err) {
      expect(err).toBeInstanceOf(BAStampError);
      expect(err).toBeInstanceOf(BAStampNoCreditsError);
    }
  });
});
