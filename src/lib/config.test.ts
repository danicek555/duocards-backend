import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../config.js";

const requiredEnvironment = {
  DATABASE_URL: "postgresql://user:password@example.test:5432/duocards",
  AUTH_SECRET: "test-secret-with-at-least-thirty-two-bytes",
};

test("proxy headers are not trusted unless explicitly enabled", () => {
  assert.equal(loadConfig(requiredEnvironment).trustProxy, false);
  assert.equal(
    loadConfig({ ...requiredEnvironment, TRUST_PROXY: "true" }).trustProxy,
    true,
  );
});

test("configuration rejects a short auth secret", () => {
  assert.throws(
    () => loadConfig({ ...requiredEnvironment, AUTH_SECRET: "too-short" }),
    /at least 32 bytes/,
  );
});
