import nextEnv from "@next/env";
import { assertSecureConfiguration } from "../lib/security/secrets";
import { startWebhookDeliveryWorker } from "../lib/webhook-delivery";
const { loadEnvConfig } = nextEnv;
// Load environment variables before any other imports/logic
loadEnvConfig(process.cwd());

import { createServer } from "http";
import next from "next";
import { Server } from "socket.io";
import { parse } from "url";
import pkg from "../../package.json";
import { logger } from "../lib/logger";
import { waManager } from "../modules/whatsapp/manager";
import { setupSocket } from "./socket";

const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.HOSTNAME || "localhost";
const port = parseInt(process.env.PORT || "3030", 10);

assertSecureConfiguration();

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(async () => {
  const server = createServer(async (req, res) => {
    try {
      if (!req.url) return;
      const parsedUrl = parse(req.url, true);
      await handle(req, res, parsedUrl);
    } catch (err) {
      logger.error("Server", "Error handling", req.url, err);
      res.statusCode = 500;
      res.end("internal server error");
    }
  });

  const io = new Server(server, {
    path: "/api/socket/io",
    addTrailingSlash: false,
    cors: {
      origin: new URL(process.env.BASE_URL!).origin,
      credentials: true,
      methods: ["GET", "POST"]
    },
    allowRequest: (req, callback) => {
      const origin = req.headers.origin;
      callback(null, !origin || origin === new URL(process.env.BASE_URL!).origin);
    }
  });

  setupSocket(io);
  // Optional: Global instance for Baileys to emit events
  (global).io = io;

  // Initialize WhatsApp Manager
  waManager.setup(io);
  const missing = await waManager.unreservedSessionCount();
  if (missing) throw new Error("Apply security/session-identity-migration.sql before starting the gateway");
  await waManager.loadSessions();
  startWebhookDeliveryWorker();

  // Start Scheduler
  import("../modules/whatsapp/scheduler").then(m => m.startScheduler());

  // Cloudflare 520 Fix: increase keep-alive timeout so Node doesn't kill idle connections that Cloudflare expects to reuse
  // See: https://github.com/vercel/next.js/issues/48962
  server.keepAliveTimeout = 120 * 1000; // 120 seconds
  server.headersTimeout = 120 * 1000; // 120 seconds

  server.listen(port, hostname, () => {
    logger.banner(pkg.name.toUpperCase(), pkg.version, port);

    // Telemetry is opt-in and carries version only.
    if (process.env.ENABLE_TELEMETRY === 'true') {
      const ping = () => fetch('https://api-wa-akg.aikeigroup.net/api/ping', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: pkg.version }), signal: AbortSignal.timeout(5000),
        redirect: 'error',
      }).catch(() => {});
      ping();
      setInterval(ping, 30_000).unref();
    }

  });
}).catch(error => { logger.error("Server", "Gateway startup failed", error.message); process.exit(1); });
