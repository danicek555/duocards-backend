import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../config.js";

const requiredEnvironment = {
  DATABASE_URL: "postgresql://user:password@example.test:5432/duocards",
  AUTH_SECRET: "test-secret-with-at-least-thirty-two-bytes",
  PUBLIC_APP_URL: "https://app.example.test",
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

test("public app URL is explicit and HTTPS in production or Resend mode", () => {
  assert.throws(
    () =>
      loadConfig({
        DATABASE_URL: requiredEnvironment.DATABASE_URL,
        AUTH_SECRET: requiredEnvironment.AUTH_SECRET,
      }),
    /PUBLIC_APP_URL is required/,
  );
  assert.throws(
    () =>
      loadConfig({
        ...requiredEnvironment,
        NODE_ENV: "production",
        RESEND_API_KEY: "resend-test-key",
        PUBLIC_APP_URL: "http://app.example.test",
      }),
    /must use HTTPS/,
  );
  assert.throws(
    () =>
      loadConfig({
        ...requiredEnvironment,
        NODE_ENV: "development",
        PUBLIC_APP_URL: "http://localhost:3000",
      }),
    /production or Resend mode/,
  );
  assert.equal(
    loadConfig({
      ...requiredEnvironment,
      NODE_ENV: "development",
      VERIFICATION_EMAIL_MODE: "console",
      PUBLIC_APP_URL: "http://localhost:3000",
    }).publicAppUrl,
    "http://localhost:3000",
  );
  assert.equal(
    loadConfig({
      ...requiredEnvironment,
      PUBLIC_APP_URL: "https://app.example.test/",
    }).publicAppUrl,
    "https://app.example.test",
  );
});
