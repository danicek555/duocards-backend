import type { AppConfig } from "../config.js";

const RESEND_EMAILS_URL = "https://api.resend.com/emails";
const RESEND_REQUEST_TIMEOUT_MS = 10_000;

export interface PasswordResetEmailMessage {
  to: string;
  token: string;
  expiresInMinutes: number;
}

export interface PasswordResetEmailSender {
  sendPasswordReset(message: PasswordResetEmailMessage): Promise<void>;
}

export class PasswordResetEmailDeliveryError extends Error {
  constructor(message = "Password reset email could not be delivered") {
    super(message);
    this.name = "PasswordResetEmailDeliveryError";
  }
}

interface ResendPasswordResetEmailSenderOptions {
  apiKey: string | null;
  from: string;
  publicAppUrl: string;
  fetchImplementation?: typeof fetch;
}

export class ResendPasswordResetEmailSender
  implements PasswordResetEmailSender
{
  private readonly apiKey: string | null;
  private readonly from: string;
  private readonly publicAppUrl: string;
  private readonly fetchImplementation: typeof fetch;

  constructor(options: ResendPasswordResetEmailSenderOptions) {
    this.apiKey = options.apiKey;
    this.from = options.from;
    this.publicAppUrl = options.publicAppUrl;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  async sendPasswordReset(
    message: PasswordResetEmailMessage,
  ): Promise<void> {
    if (!this.apiKey) throw new PasswordResetEmailDeliveryError();
    const resetUrl = buildPasswordResetUrl(
      this.publicAppUrl,
      message.token,
    );

    let response: Response;
    try {
      response = await this.fetchImplementation(RESEND_EMAILS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: this.from,
          to: [message.to],
          subject: "Reset your DuoCards password",
          html: renderPasswordResetHtml(message, resetUrl),
          text: renderPasswordResetText(message, resetUrl),
        }),
        signal: AbortSignal.timeout(RESEND_REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new PasswordResetEmailDeliveryError();
    }

    if (!response.ok) throw new PasswordResetEmailDeliveryError();
  }
}

type ConsoleEmailLogger = (message: string) => void;

export class ConsolePasswordResetEmailSender
  implements PasswordResetEmailSender
{
  constructor(
    private readonly publicAppUrl: string,
    private readonly log: ConsoleEmailLogger = (message) =>
      console.info(message),
  ) {}

  async sendPasswordReset(
    message: PasswordResetEmailMessage,
  ): Promise<void> {
    const resetUrl = buildPasswordResetUrl(
      this.publicAppUrl,
      message.token,
    );
    this.log([
      "[development password reset email]",
      `to=${message.to}`,
      `resetUrl=${resetUrl}`,
      `expiresInMinutes=${message.expiresInMinutes}`,
    ].join(" "));
  }
}

export function createPasswordResetEmailSender(
  config: AppConfig,
): PasswordResetEmailSender {
  if (config.verificationEmailMode === "console") {
    if (config.nodeEnv !== "development") {
      throw new Error(
        "Console password reset delivery is allowed only in development",
      );
    }
    return new ConsolePasswordResetEmailSender(config.publicAppUrl);
  }
  return new ResendPasswordResetEmailSender({
    apiKey: config.resendApiKey,
    from: config.emailFrom,
    publicAppUrl: config.publicAppUrl,
  });
}

export function buildPasswordResetUrl(
  publicAppUrl: string,
  token: string,
): string {
  const url = new URL("/reset-password", publicAppUrl);
  // Fragments are not sent in HTTP requests or Referer headers. The web and
  // native clients move this one-time capability into memory immediately.
  url.hash = new URLSearchParams({ token }).toString();
  return url.toString();
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderPasswordResetHtml(
  message: PasswordResetEmailMessage,
  resetUrl: string,
): string {
  const safeResetUrl = escapeHtml(resetUrl);
  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
      <h1>DuoCards</h1>
      <h2>Reset your password</h2>
      <p>We received a request to reset your DuoCards password.</p>
      <p><a href="${safeResetUrl}">Choose a new password</a></p>
      <p>This link expires in ${message.expiresInMinutes} minutes.</p>
      <p>If you did not request this, you can ignore this email.</p>
      <p style="word-break: break-all;">${safeResetUrl}</p>
    </div>
  `.trim();
}

function renderPasswordResetText(
  message: PasswordResetEmailMessage,
  resetUrl: string,
): string {
  return [
    "DuoCards - Reset your password",
    "",
    "Open this link to choose a new password:",
    resetUrl,
    "",
    `This link expires in ${message.expiresInMinutes} minutes.`,
    "If you did not request this, you can ignore this email.",
  ].join("\n");
}
