import type { AppConfig } from "../config.js";

const RESEND_EMAILS_URL = "https://api.resend.com/emails";
const RESEND_REQUEST_TIMEOUT_MS = 10_000;

export interface VerificationEmailMessage {
  to: string;
  code: string;
  expiresInMinutes: number;
}

export interface VerificationEmailSender {
  sendVerificationCode(message: VerificationEmailMessage): Promise<void>;
}

export class VerificationEmailDeliveryError extends Error {
  constructor(message = "Verification email could not be delivered") {
    super(message);
    this.name = "VerificationEmailDeliveryError";
  }
}

interface ResendVerificationEmailSenderOptions {
  apiKey: string | null;
  from: string;
  fetchImplementation?: typeof fetch;
}

export class ResendVerificationEmailSender
  implements VerificationEmailSender
{
  private readonly apiKey: string | null;
  private readonly from: string;
  private readonly fetchImplementation: typeof fetch;

  constructor(options: ResendVerificationEmailSenderOptions) {
    this.apiKey = options.apiKey;
    this.from = options.from;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  async sendVerificationCode(
    message: VerificationEmailMessage,
  ): Promise<void> {
    if (!this.apiKey) throw new VerificationEmailDeliveryError();

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
          subject: "Verify your DuoCards account",
          html: renderVerificationHtml(message),
          text: renderVerificationText(message),
        }),
        signal: AbortSignal.timeout(RESEND_REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new VerificationEmailDeliveryError();
    }

    if (!response.ok) throw new VerificationEmailDeliveryError();
  }
}

type ConsoleEmailLogger = (message: string) => void;

export class ConsoleVerificationEmailSender
  implements VerificationEmailSender
{
  constructor(
    private readonly log: ConsoleEmailLogger = (message) =>
      console.info(message),
  ) {}

  async sendVerificationCode(
    message: VerificationEmailMessage,
  ): Promise<void> {
    this.log(
      `[development verification email] to=${message.to} code=${message.code} expiresInMinutes=${message.expiresInMinutes}`,
    );
  }
}

export function createVerificationEmailSender(
  config: AppConfig,
): VerificationEmailSender {
  if (config.verificationEmailMode === "console") {
    if (config.nodeEnv !== "development") {
      throw new Error(
        "Console verification email delivery is allowed only in development",
      );
    }
    return new ConsoleVerificationEmailSender();
  }
  return new ResendVerificationEmailSender({
    apiKey: config.resendApiKey,
    from: config.emailFrom,
  });
}

function renderVerificationHtml(message: VerificationEmailMessage): string {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
      <h1>DuoCards</h1>
      <h2>Verify your email address</h2>
      <p>Use this verification code to complete your registration:</p>
      <p style="font-size: 32px; font-weight: bold; letter-spacing: 5px;">${message.code}</p>
      <p>This code expires in ${message.expiresInMinutes} minutes.</p>
      <p>If you did not create a DuoCards account, you can ignore this email.</p>
    </div>
  `.trim();
}

function renderVerificationText(message: VerificationEmailMessage): string {
  return [
    "DuoCards - Verify your email address",
    "",
    `Verification code: ${message.code}`,
    `This code expires in ${message.expiresInMinutes} minutes.`,
    "",
    "If you did not create a DuoCards account, you can ignore this email.",
  ].join("\n");
}
