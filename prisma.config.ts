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

if (!databaseUrl) {
  throw new Error(
    "A database URL is required for Prisma commands",
  );
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: databaseUrl,
  },
});
