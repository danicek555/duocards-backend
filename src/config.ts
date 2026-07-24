import "dotenv/config";

export type NodeEnvironment = "development" | "test" | "production";
export type VerificationEmailMode = "resend" | "console";

export interface AppConfig {
  nodeEnv: NodeEnvironment;
  host: string;
  port: number;
  logLevel: string;
  trustProxy: boolean | number | string;
  databaseUrl: string;
  authSecret: string;
  redisUrl: string | null;
  corsOrigins: string[];
  cookieSecure: boolean;
  verificationEmailMode: VerificationEmailMode;
  resendApiKey: string | null;
  emailFrom: string;
  publicAppUrl: string;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`Invalid boolean environment value: ${value}`);
}

// Behind a reverse proxy (Cloud Run, load balancer) the client IP must be read
// from X-Forwarded-For, otherwise per-IP rate limiting keys every request to the
// proxy address. A bare boolean is unsafe here: `true` trusts a client-supplied
// forwarded chain, letting a caller spoof its rate-limit bucket. Prefer a hop
// count (Cloud Run puts the real client IP one hop away → `1`) or an explicit
// list of trusted proxy IPs/CIDR subnets, which Fastify passes to proxy-addr.
function parseTrustProxy(
  value: string | undefined,
): boolean | number | string {
  const normalized = value?.trim();
  if (!normalized) return false;
  const lower = normalized.toLowerCase();
  if (["true", "yes", "on"].includes(lower)) return true;
  if (["false", "no", "off"].includes(lower)) return false;
  if (/^\d+$/.test(normalized)) {
    return Number.parseInt(normalized, 10);
  }
  return normalized;
}

function parsePort(value: string | undefined): number {
  if (!value) return 4000;
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  return port;
}

function parseNodeEnvironment(value: string | undefined): NodeEnvironment {
  if (!value) return "development";
  if (value === "development" || value === "test" || value === "production") {
    return value;
  }
  throw new Error("NODE_ENV must be development, test, or production");
}

function requireValue(value: string | undefined, label: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function parseVerificationEmailMode(
  value: string | undefined,
): VerificationEmailMode {
  if (value === undefined || value.trim() === "") return "resend";
  const normalized = value.trim().toLowerCase();
  if (normalized === "resend" || normalized === "console") {
    return normalized;
  }
  throw new Error("VERIFICATION_EMAIL_MODE must be resend or console");
}

function formatEmailFrom(value: string | undefined): string {
  const normalized = value?.trim() || "notifications@duocards.xyz";
  return normalized.includes("<") && normalized.includes(">")
    ? normalized
    : `DuoCards <${normalized}>`;
}

function parsePublicAppUrl(
  value: string | undefined,
  nodeEnv: NodeEnvironment,
  emailMode: VerificationEmailMode,
): string {
  const rawValue = requireValue(value, "PUBLIC_APP_URL");
  let url: URL;
  try {
    url = new URL(rawValue);
  } catch {
    throw new Error("PUBLIC_APP_URL must be a valid absolute URL");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("PUBLIC_APP_URL must be an HTTP(S) origin without a path");
  }
  if (
    (nodeEnv === "production" || emailMode === "resend") &&
    url.protocol !== "https:"
  ) {
    throw new Error(
      "PUBLIC_APP_URL must use HTTPS in production or Resend mode",
    );
  }
  return url.origin;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = parseNodeEnvironment(env.NODE_ENV);
  const selectedDatabaseUrl =
    nodeEnv === "production"
      ? env.DATABASE_URL || env.PRISMA_DATABASE_URL || env.DIRECT_DATABASE_URL
      : env.DIRECT_DATABASE_URL || env.DATABASE_URL || env.PRISMA_DATABASE_URL;
  const databaseUrl = requireValue(
    selectedDatabaseUrl,
    "DATABASE_URL, PRISMA_DATABASE_URL, or DIRECT_DATABASE_URL",
  );
  const authSecret = requireValue(
    env.AUTH_SECRET || env.NEXTAUTH_SECRET,
    "AUTH_SECRET (or NEXTAUTH_SECRET)",
  );

  if (Buffer.byteLength(authSecret, "utf8") < 32) {
    throw new Error("AUTH_SECRET must contain at least 32 bytes");
  }

  const corsOrigins = (env.CORS_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean);

  if (nodeEnv === "production" && corsOrigins.includes("*")) {
    throw new Error("Wildcard CORS origin is not allowed in production");
  }

  const verificationEmailMode = parseVerificationEmailMode(
    env.VERIFICATION_EMAIL_MODE,
  );
  if (verificationEmailMode === "console" && nodeEnv !== "development") {
    throw new Error(
      "VERIFICATION_EMAIL_MODE=console is allowed only in development",
    );
  }
  const resendApiKey = env.RESEND_API_KEY?.trim() || null;
  if (
    nodeEnv === "production" &&
    verificationEmailMode === "resend" &&
    !resendApiKey
  ) {
    throw new Error(
      "RESEND_API_KEY is required for production email verification",
    );
  }

  return {
    nodeEnv,
    host: env.HOST?.trim() || "0.0.0.0",
    port: parsePort(env.PORT),
    logLevel: env.LOG_LEVEL?.trim() || "info",
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    databaseUrl,
    authSecret,
    redisUrl: env.REDIS_URL?.trim() || null,
    corsOrigins,
    cookieSecure:
      nodeEnv === "production"
        ? true
        : parseBoolean(env.COOKIE_SECURE, false),
    verificationEmailMode,
    resendApiKey,
    emailFrom: formatEmailFrom(env.FROM_EMAIL),
    publicAppUrl: parsePublicAppUrl(
      env.PUBLIC_APP_URL,
      nodeEnv,
      verificationEmailMode,
    ),
  };
}
