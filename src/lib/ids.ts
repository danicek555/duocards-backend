import { ApiError } from "./errors.js";

const POSTGRES_INTEGER_MAX = 2_147_483_647;

export function parsePositiveIntId(raw: string, label: string): number {
  const value = Number(raw);
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > POSTGRES_INTEGER_MAX
  ) {
    throw new ApiError(400, "INVALID_ID", `Invalid ${label} ID`);
  }
  return value;
}
