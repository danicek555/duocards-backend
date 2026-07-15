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

test("verification email delivery defaults to Resend", () => {
  const config = loadConfig(requiredEnvironment);
  assert.equal(config.verificationEmailMode, "resend");
  assert.equal(config.resendApiKey, null);
  assert.equal(
    config.emailFrom,
    "DuoCards <notifications@duocards.xyz>",
  );
});

test("console verification emails require explicit development mode", () => {
  assert.equal(
    loadConfig({
      ...requiredEnvironment,
      NODE_ENV: "development",
      VERIFICATION_EMAIL_MODE: "console",
    }).verificationEmailMode,
    "console",
  );

  assert.throws(
    () =>
      loadConfig({
        ...requiredEnvironment,
        NODE_ENV: "production",
        VERIFICATION_EMAIL_MODE: "console",
      }),
    /allowed only in development/,
  );
});

test("production Resend delivery requires an API key", () => {
  assert.throws(
    () =>
      loadConfig({
        ...requiredEnvironment,
        NODE_ENV: "production",
      }),
    /RESEND_API_KEY is required/,
  );
});
