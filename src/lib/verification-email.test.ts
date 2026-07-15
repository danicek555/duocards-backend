import assert from "node:assert/strict";
import test from "node:test";
import {
  ResendVerificationEmailSender,
  VerificationEmailDeliveryError,
} from "./verification-email.js";

test("Resend sender uses the HTTP API with authorization and timeout", async () => {
  let capturedInput: string | URL | Request | undefined;
  let capturedInit: RequestInit | undefined;
  const fakeFetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    capturedInput = input;
    capturedInit = init;
    return new Response(null, { status: 202 });
  }) as typeof fetch;
  const sender = new ResendVerificationEmailSender({
    apiKey: "resend-test-key",
    from: "DuoCards <notifications@example.test>",
    fetchImplementation: fakeFetch,
  });

  await sender.sendVerificationCode({
    to: "user@example.test",
    code: "123456",
    expiresInMinutes: 10,
  });

  assert.equal(capturedInput, "https://api.resend.com/emails");
  assert.equal(capturedInit?.method, "POST");
  assert.ok(capturedInit?.signal instanceof AbortSignal);
  const headers = capturedInit?.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer resend-test-key");
  const body = JSON.parse(String(capturedInit?.body)) as {
    from: string;
    to: string[];
    html: string;
    text: string;
  };
  assert.equal(body.from, "DuoCards <notifications@example.test>");
  assert.deepEqual(body.to, ["user@example.test"]);
  assert.match(body.html, /123456/);
  assert.match(body.text, /123456/);
});

test("Resend sender fails closed without configuration or on HTTP errors", async () => {
  let called = false;
  const fakeFetch = (async () => {
    called = true;
    return new Response(null, { status: 400 });
  }) as typeof fetch;

  const unconfigured = new ResendVerificationEmailSender({
    apiKey: null,
    from: "DuoCards <notifications@example.test>",
    fetchImplementation: fakeFetch,
  });
  await assert.rejects(
    unconfigured.sendVerificationCode({
      to: "user@example.test",
      code: "123456",
      expiresInMinutes: 10,
    }),
    VerificationEmailDeliveryError,
  );
  assert.equal(called, false);

  const rejected = new ResendVerificationEmailSender({
    apiKey: "resend-test-key",
    from: "DuoCards <notifications@example.test>",
    fetchImplementation: fakeFetch,
  });
  await assert.rejects(
    rejected.sendVerificationCode({
      to: "user@example.test",
      code: "123456",
      expiresInMinutes: 10,
    }),
    VerificationEmailDeliveryError,
  );
});
