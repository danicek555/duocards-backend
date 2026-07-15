import "dotenv/config";

export type NodeEnvironment = "development" | "test" | "production";

export interface AppConfig {
  nodeEnv: NodeEnvironment;
  host: string;
  port: number;
  logLevel: string;
  trustProxy: boolean;
  databaseUrl: string;
  authSecret: string;
  corsOrigins: string[];
  cookieSecure: boolean;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`Invalid boolean environment value: ${value}`);
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

  return {
    nodeEnv,
    host: env.HOST?.trim() || "0.0.0.0",
    port: parsePort(env.PORT),
    logLevel: env.LOG_LEVEL?.trim() || "info",
    trustProxy: parseBoolean(env.TRUST_PROXY, false),
    databaseUrl,
    authSecret,
    corsOrigins,
    cookieSecure:
      nodeEnv === "production"
        ? true
        : parseBoolean(env.COOKIE_SECURE, false),
  };
}
