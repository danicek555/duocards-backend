import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = await buildApp({ config });

let isClosing = false;
async function shutdown(signal: string): Promise<void> {
  if (isClosing) return;
  isClosing = true;
  app.log.info({ signal }, "Shutting down");
  try {
    await app.close();
    process.exitCode = 0;
  } catch (error) {
    app.log.error({ err: error }, "Graceful shutdown failed");
    process.exitCode = 1;
  }
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    { host: config.host, port: config.port },
    "DuoCards backend listening",
  );
} catch (error) {
  app.log.fatal({ err: error }, "Backend failed to start");
  await app.close();
  process.exitCode = 1;
}
