import "dotenv/config";
import { defineConfig } from "prisma/config";

const isProduction = process.env.NODE_ENV === "production";
const databaseUrl = isProduction
  ? process.env.DATABASE_URL?.trim() ||
    process.env.PRISMA_DATABASE_URL?.trim() ||
    process.env.DIRECT_DATABASE_URL?.trim()
  : process.env.DIRECT_DATABASE_URL?.trim() ||
    process.env.DATABASE_URL?.trim() ||
    process.env.PRISMA_DATABASE_URL?.trim();

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // Client generation is a schema-only build step and must also work in
    // buildpack environments where runtime secrets are intentionally absent.
    // Commands that actually access PostgreSQL reject the empty URL, while
    // application startup independently requires a real URL in src/config.ts.
    url: databaseUrl ?? "",
  },
});
