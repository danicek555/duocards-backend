import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPasswordResetUrl,
  ConsolePasswordResetEmailSender,
  PasswordResetEmailDeliveryError,
  ResendPasswordResetEmailSender,
} from "./password-reset-email.js";

test("Resend password reset sender uses configured public HTTPS URL", async () => {
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
  const sender = new ResendPasswordResetEmailSender({
    apiKey: "resend-test-key",
    from: "DuoCards <notifications@example.test>",
    publicAppUrl: "https://app.example.test",
    fetchImplementation: fakeFetch,
  });

  await sender.sendPasswordReset({
    to: "user@example.test",
    token: "token_with-url-safe.characters",
    expiresInMinutes: 30,
  });

  assert.equal(capturedInput, "https://api.resend.com/emails");
  assert.equal(capturedInit?.method, "POST");
  assert.ok(capturedInit?.signal instanceof AbortSignal);
  const headers = capturedInit?.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer resend-test-key");
  const body = JSON.parse(String(capturedInit?.body)) as {
    from: string;
    to: string[];
    subject: string;
    html: string;
    text: string;
  };
  const resetUrl =
    "https://app.example.test/reset-password#token=token_with-url-safe.characters";
  assert.equal(body.from, "DuoCards <notifications@example.test>");
  assert.deepEqual(body.to, ["user@example.test"]);
  assert.equal(body.subject, "Reset your DuoCards password");
  assert.match(body.html, /Reset your password/u);
  assert.equal(body.html.includes(resetUrl), true);
  assert.equal(body.text.includes(resetUrl), true);
  assert.equal(body.text.includes("30 minutes"), true);
});

test("password reset sender fails closed on config, network, and HTTP errors", async () => {
  let called = false;
  const fakeFetch = (async () => {
    called = true;
    return new Response(null, { status: 400 });
  }) as typeof fetch;
  const unconfigured = new ResendPasswordResetEmailSender({
    apiKey: null,
    from: "DuoCards <notifications@example.test>",
    publicAppUrl: "https://app.example.test",
    fetchImplementation: fakeFetch,
  });
  await assert.rejects(
    unconfigured.sendPasswordReset({
      to: "user@example.test",
      token: "token",
      expiresInMinutes: 30,
    }),
    PasswordResetEmailDeliveryError,
  );
  assert.equal(called, false);

  const rejected = new ResendPasswordResetEmailSender({
    apiKey: "resend-test-key",
    from: "DuoCards <notifications@example.test>",
    publicAppUrl: "https://app.example.test",
    fetchImplementation: fakeFetch,
  });
  await assert.rejects(
    rejected.sendPasswordReset({
      to: "user@example.test",
      token: "token",
      expiresInMinutes: 30,
    }),
    PasswordResetEmailDeliveryError,
  );

  const networkFailure = new ResendPasswordResetEmailSender({
    apiKey: "resend-test-key",
    from: "DuoCards <notifications@example.test>",
    publicAppUrl: "https://app.example.test",
    fetchImplementation: (async () => {
      throw new TypeError("network unavailable");
    }) as typeof fetch,
  });
  await assert.rejects(
    networkFailure.sendPasswordReset({
      to: "user@example.test",
      token: "token",
      expiresInMinutes: 30,
    }),
    PasswordResetEmailDeliveryError,
  );
});

test("console reset sender prints the link only in its explicit development sink", async () => {
  const messages: string[] = [];
  const sender = new ConsolePasswordResetEmailSender(
    "http://localhost:3000",
    (message) => messages.push(message),
  );
  await sender.sendPasswordReset({
    to: "user@example.test",
    token: "development-token",
    expiresInMinutes: 30,
  });

  assert.equal(messages.length, 1);
  assert.equal(
    messages[0]?.includes(
      buildPasswordResetUrl("http://localhost:3000", "development-token"),
    ),
    true,
  );
});
