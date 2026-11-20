export type InkwireCode =
  | "invalid_payload"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "stale"
  | "too_large"
  | "rate_limited"
  | "internal";

const HTTP: Record<InkwireCode, number> = {
  invalid_payload: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  stale: 412,
  too_large: 413,
  rate_limited: 429,
  internal: 500,
};

export class InkwireError extends Error {
  constructor(public code: InkwireCode, message: string) {
    super(message);
    this.name = "InkwireError";
  }
  get httpStatus() {
    return HTTP[this.code];
  }
}
