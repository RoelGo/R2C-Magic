import pino from "pino";
import PinoPretty from "pino-pretty";
import { config } from "./config";

/**
 * Structured logger.
 *
 * In development we want readable, colourised output — but pino's `transport`
 * option runs the pretty-printer in a **worker thread**, which Next.js's dev
 * server tears down on reload. That leaves subsequent `logger.*` calls throwing
 * "the worker has exited". To avoid that, we run `pino-pretty` as a plain
 * synchronous stream (no worker) instead of a transport. In production we emit
 * newline-delimited JSON to stdout with no transport at all.
 */
function createLogger(): pino.Logger {
  if (config.NODE_ENV === "development") {
    const stream = PinoPretty({ colorize: true, translateTime: "HH:MM:ss" });
    return pino({ level: config.LOG_LEVEL }, stream);
  }
  return pino({ level: config.LOG_LEVEL });
}

export const logger = createLogger();
