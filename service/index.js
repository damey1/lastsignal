/**
 * LastSignal Notification Service
 * 
 * Indexes on-chain events from Ritual Chain and delivers
 * push notifications to subscribed users.
 * 
 * Events tracked:
 *   - MessageSealed (MessageVault) → notify recipient
 *   - MessageUnlocked (MessageVault) → notify owner
 *   - GhostModeEntered (CheckIn) → notify ghost user
 *   - StreakBroken (CheckIn) → notify user
 *   - BackFromTheDead (CheckIn) → notify user
 */

import { ethers } from "ethers";
import dotenv from "dotenv";
import webpush from "web-push";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join, resolve, extname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

dotenv.config();
dotenv.config({ path: join(__dirname, ".env") }); // also load service/.env

// VAPID keys for Web Push
webpush.setVapidDetails(
  process.env.VAPID_SUBJECT || "mailto:lastsignal@example.com",
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

const WSS_URL = process.env.RITUAL_WSS_URL || "wss://rpc.ritualfoundation.org/ws";

// Email transport — generic SMTP (configurable) / Ethereal (dev)
import nodemailer from "nodemailer";
let _mailer = null;
let _etherealUrl = null;

async function getMailer() {
  if (_mailer) return _mailer;

  const host = process.env.SMTP_HOST;

  if (host) {
    // Generic SMTP — works with SMTP2GO, Mailgun, Mailjet, SendGrid, etc.
    _mailer = nodemailer.createTransport({
      host,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === "true",
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
    console.log(`  Email:    SMTP (${host})`);
    return _mailer;
  }

  // Backward compat: SendGrid
  const sgKey = process.env.SENDGRID_API_KEY;
  if (sgKey && sgKey !== "__REPLACE_WITH_YOUR_SENDGRID_API_KEY__") {
    _mailer = nodemailer.createTransport({
      host: "smtp.sendgrid.net",
      port: 587,
      secure: false,
      auth: { user: "apikey", pass: sgKey },
    });
    console.log(`  Email:    SendGrid`);
    return _mailer;
  }

  // Dev mode: Ethereal Email (fake SMTP, no real sending)
  try {
    const testAccount = await nodemailer.createTestAccount();
    _mailer = nodemailer.createTransport({
      host: "smtp.ethereal.email",
      port: 587,
      secure: false,
      auth: { user: testAccount.user, pass: testAccount.pass },
    });
    _etherealUrl = "https://ethereal.email";
    console.log(`  Email:    Ethereal (dev mode)`);
    console.log(`  Web UI:   ${_etherealUrl}`);
    console.log(`  Login:    ${testAccount.user}`);
    console.log(`  Pass:     ${testAccount.pass}`);
  } catch (err) {
    console.warn(`  Email:    Ethereal setup failed — logging to console`);
    _mailer = nodemailer.createTransport({ jsonTransport: true });
  }

  return _mailer;
}

// ── Config ──

const RPC_URL = process.env.RITUAL_RPC_URL || "https://rpc.ritualfoundation.org";
const DEPLOYED_PATH = join(__dirname, "..", "deployed.json");

function loadDeployed() {
  try {
    return JSON.parse(readFileSync(DEPLOYED_PATH, "utf8"));
  } catch {
    console.error("❌ deployed.json not found. Run the deploy script first.");
    process.exit(1);
  }
}

const deployed = loadDeployed();

// ── Active message tracking (off-chain fallback for scheduler) ──
const activeMessages = new Map(); // messageId → { owner, recipient, inactivityUnlock, warned }

const CHECKIN_READ_ABI = [
  "function lastSeen(address user) view returns (uint256)",
];

// ── Minimal ABIs (events only) ──

const CHECKIN_EVENTS = [
  "event StreakBroken(address indexed user, uint256 brokenAt, uint256 previousStreak)",
  "event GhostModeEntered(address indexed user, uint256 lastSeen, uint256 declaredAt)",
  "event BackFromTheDead(address indexed user, uint256 checkedInAt, uint256 silenceDuration)",
];

const VAULT_EVENTS = [
  "event MessageSealed(bytes32 indexed messageId, address indexed owner, address indexed recipient, uint256 unlockAfter, uint256 timestamp)",
  "event MessageUnlocked(bytes32 indexed messageId, address indexed owner, address indexed recipient, uint256 inactiveDuration, uint256 unlockedAt)",
];

const SCHEDULER_EVENTS = [
  "event MessageLockWarning(bytes32 indexed messageId, address indexed owner, address indexed recipient, uint256 unlockAt)",
  "event MessageUnlockable(bytes32 indexed messageId, address indexed owner, address indexed recipient, uint256 inactiveDuration)",
];

// ── Provider & Contracts (reconnectable) ──

let provider = null;
let checkIn = null;
let vault = null;
let checkInRead = null;
let schedulerNotifications = null;
let _reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 30_000; // 30s cap

function onReconnect() {
  const delay = Math.min(1000 * Math.pow(2, _reconnectAttempts), MAX_RECONNECT_DELAY);
  _reconnectAttempts++;
  console.log(`  ⚡ WebSocket reconnecting in ${delay}ms (attempt ${_reconnectAttempts})...`);
  setTimeout(createConnection, delay);
}

async function createConnection() {
  // Close old provider cleanly if it exists
  if (provider) {
    try { provider.websocket.close(); } catch {}
  }

  provider = new ethers.WebSocketProvider(WSS_URL);

  provider.websocket.on("open", () => {
    _reconnectAttempts = 0;
    console.log(`  WebSocket:  ${WSS_URL} ✅`);
  });
  provider.websocket.on("close", (code) => {
    console.warn(`  WebSocket:  closed (code ${code}) — reconnecting...`);
    onReconnect();
  });
  provider.websocket.on("error", (err) => {
    console.error(`  WebSocket:  error — ${err.message?.slice(0, 60)}`);
  });

  checkIn = new ethers.Contract(deployed.checkIn, CHECKIN_EVENTS, provider);
  vault = new ethers.Contract(deployed.messageVault, VAULT_EVENTS, provider);
  checkInRead = new ethers.Contract(deployed.checkIn, CHECKIN_READ_ABI, provider);
  schedulerNotifications = deployed.schedulerNotifications
    ? new ethers.Contract(deployed.schedulerNotifications, SCHEDULER_EVENTS, provider)
    : null;

  // Attach event listeners
  const contracts = [
    { name: "CheckIn", contract: checkIn, events: ["StreakBroken", "GhostModeEntered", "BackFromTheDead"] },
    { name: "Vault", contract: vault, events: ["MessageSealed", "MessageUnlocked"] },
  ];
  if (schedulerNotifications) {
    contracts.push({
      name: "SchedulerNotifications",
      contract: schedulerNotifications,
      events: ["MessageLockWarning", "MessageUnlockable"],
    });
  }

  for (const { name, contract, events } of contracts) {
    for (const eventName of events) {
      contract.off(eventName); // clear any stale listeners
      contract.on(eventName, async (...args) => {
        const event = args[args.length - 1];
        const txHash = event?.transactionHash || event?.log?.transactionHash;
        const notif = formatEvent(eventName, event.args);
        if (!notif) return;

        console.log(`\n[${eventName}] ${notif.msg}`);
        console.log(`  Target: ${notif.target}`);
        console.log(`  Tx:     ${txHash}`);

        const subs = loadSubs();
        await deliver(notif, subs, txHash);

        if (eventName === "MessageSealed") {
          activeMessages.set(event.args.messageId, {
            owner: event.args.owner,
            recipient: event.args.recipient,
            inactivityUnlock: Number(event.args.unlockAfter),
            warned: false,
          });
          console.log(`  Tracked: ${activeMessages.size} active messages`);
        }
        if (eventName === "MessageUnlocked") {
          activeMessages.delete(event.args.messageId);
          console.log(`  Removed: ${activeMessages.size} active messages`);
        }
      });
      console.log(`  Listening: ${name}.${eventName}`);
    }
  }
}

// ── Subscription Store ──

const SUBS_PATH = join(__dirname, "subscriptions.json");
const EMAIL_PATH = join(__dirname, "emails.json");

function loadSubs() {
  try { return JSON.parse(readFileSync(SUBS_PATH, "utf8")); } catch { return {}; }
}
function saveSubs(subs) {
  writeFileSync(SUBS_PATH, JSON.stringify(subs, null, 2));
}
function loadEmails() {
  try { return JSON.parse(readFileSync(EMAIL_PATH, "utf8")); } catch { return {}; }
}
function saveEmails(emails) {
  writeFileSync(EMAIL_PATH, JSON.stringify(emails, null, 2));
}

// ── HTTP server (frontend + API) ──

import { createServer } from "http";

const MIME = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".ico": "image/x-icon",
};

const WWW_ROOT = join(__dirname, "..");
const SUB_PORT = 3002;

// ── Rate limiter (in-memory, per IP) ──

const RATE_LIMIT_WINDOW_MS = 60_000;  // 1 minute
const RATE_LIMIT_MAX = 10;            // requests per window
const rateLimitMap = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const window = rateLimitMap.get(ip) || [];
  const recent = window.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_MAX) return true;
  recent.push(now);
  rateLimitMap.set(ip, recent);
  return false;
}

const MAX_BODY_SIZE = 10_240; // 10 KB

createServer((req, res) => {
  // CORS headers for localhost frontend
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if (req.method === "POST" && req.url === "/subscribe") {
    if (isRateLimited(req.socket.remoteAddress)) {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Too many requests" }));
      return;
    }
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > MAX_BODY_SIZE) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Request too large" }));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        const { address, subscription } = JSON.parse(body);
        if (!address || !subscription) throw new Error("Missing fields");
        const addr = address.toLowerCase();
        const subs = loadSubs();
        if (!subs[addr]) subs[addr] = [];
        // Dedup by endpoint
        const exists = subs[addr].some(s => s.endpoint === subscription.endpoint);
        if (!exists) {
          subs[addr].push(subscription);
          console.log(`  ✓ Subscription saved for ${address.slice(0, 6)}…`);
        }
        saveSubs(subs);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  } else if (req.method === "POST" && req.url === "/subscribe-email") {
    if (isRateLimited(req.socket.remoteAddress)) {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Too many requests" }));
      return;
    }
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > MAX_BODY_SIZE) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Request too large" }));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        const { address, email, signature, message } = JSON.parse(body);
        if (!address || !email || !email.includes("@") || !signature || !message) {
          throw new Error("Invalid request — address, email, signature, and message are required");
        }
        // Recover signer from signature and verify it matches the claimed address
        const recovered = ethers.verifyMessage(message, signature);
        if (recovered.toLowerCase() !== address.toLowerCase()) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Signature does not match the claimed address" }));
          return;
        }
        const addr = address.toLowerCase();
        const normalizedEmail = email.toLowerCase().trim();
        const emails = loadEmails();
        if (!emails[addr]) emails[addr] = [];
        if (!emails[addr].includes(normalizedEmail)) {
          emails[addr].push(normalizedEmail);
          console.log(`  ✓ Email registered ${normalizedEmail} for ${addr.slice(0, 6)}…`);
        }
        saveEmails(emails);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  } else {
    // Serve static files (frontend)
    const filePath = req.url === "/" ? "/app.html" : req.url.split("?")[0];
    const fullPath = resolve(WWW_ROOT + filePath);
    if (fullPath.startsWith(WWW_ROOT) && existsSync(fullPath)) {
      const ext = extname(filePath);
      res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
      res.end(readFileSync(fullPath));
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  }
}).listen(SUB_PORT, () => {
  console.log(`  Frontend:    http://localhost:${SUB_PORT}/`);
  console.log(`  Subscribe:   http://localhost:${SUB_PORT}/subscribe (POST)`);
});

// ── Notifications ──

function formatEvent(eventName, args) {
  switch (eventName) {
    case "MessageSealed":
      return {
        type: "message_sealed",
        msg: `🔒 New message from ${args.owner.slice(0, 6)}…${args.owner.slice(-4)}`,
        target: args.recipient.toLowerCase(),
      };
    case "MessageUnlocked":
      return {
        type: "message_unlocked",
        msg: `📩 Message claimed by ${args.recipient.slice(0, 6)}…${args.recipient.slice(-4)}`,
        target: args.owner.toLowerCase(),
      };
    case "GhostModeEntered":
      return {
        type: "ghost_declared",
        msg: `👻 Declared ghost after ${Math.floor((Number(args.declaredAt) - Number(args.lastSeen)) / 86400)} days`,
        target: args.user.toLowerCase(),
      };
    case "StreakBroken":
      return {
        type: "streak_broken",
        msg: `💔 ${Number(args.previousStreak)}-day streak broken`,
        target: args.user.toLowerCase(),
      };
    case "BackFromTheDead":
      return {
        type: "back_from_dead",
        msg: `↺ Back from the dead after ${Math.floor(Number(args.silenceDuration) / 86400)} days`,
        target: args.user.toLowerCase(),
      };
    case "MessageLockWarning":
      return {
        type: "message_lock_warning",
        msg: `Locked message warning — unlockable ${new Date(Number(args.unlockAt) * 1000).toLocaleString()}`,
        target: args.owner.toLowerCase(),
      };
    case "MessageUnlockable":
      return {
        type: "message_unlockable",
        msg: `Message is unlockable from ${args.owner.slice(0, 6)}…${args.owner.slice(-4)}`,
        target: args.recipient.toLowerCase(),
      };
    default:
      return null;
  }
}

// ── Delivery ──

async function deliver(notif, subs, txHash) {
  const addr = notif.target.toLowerCase();
  const key = Object.keys(subs).find(k => k.toLowerCase() === addr);

  // Push delivery
  if (key) {
    let changed = false;
    const valid = [];
    for (const sub of subs[key]) {
      try {
        await webpush.sendNotification(sub, JSON.stringify({
          title: "LastSignal",
          body: notif.msg,
          icon: "/favicon.ico",
          data: { type: notif.type, tx: txHash || "" },
        }));
        console.log(`  ✓ Push sent to ${addr.slice(0, 6)}…`);
        valid.push(sub);
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404 || err.statusCode === 403) {
          console.log(`  ✗ Removing stale sub for ${addr.slice(0, 6)}… (${err.statusCode})`);
          changed = true;
        } else {
          console.error(`  ✗ Push failed for ${addr.slice(0, 6)}…: ${err.message}`);
          valid.push(sub);
        }
      }
    }
    if (changed) { subs[key] = valid; saveSubs(subs); }
  }

  // Email delivery
  const mailer = await getMailer();
  if (!mailer) return;
  const emails = loadEmails();
  const emailList = emails[addr];
  if (!emailList?.length) return;

  const txLink = txHash ? `https://explorer.ritualfoundation.org/tx/${txHash}` : "";
  const html = `<p>${notif.msg}</p>${txLink ? `<p><a href="${txLink}">View transaction</a></p>` : ""}<p style="color:#888;font-size:12px;">LastSignal — your EchoLife onchain</p>`;

  for (const email of emailList) {
    try {
      await mailer.sendMail({
        from: process.env.SMTP_FROM || "noreply@lastsignal.xyz",
        to: email,
        subject: `LastSignal – ${notif.msg.replace(/<[^>]+>/g, "").slice(0, 60)}`,
        html,
      });
      console.log(`  ✓ Email sent to ${email}`);
    } catch (err) {
      console.error(`  ✗ Email failed for ${email}: ${err.message}`);
    }
  }
}

// ── Indexer ──

async function run() {
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  LastSignal Notification Service");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`  CheckIn:      ${deployed.checkIn}`);
  console.log(`  MessageVault: ${deployed.messageVault}`);
  if (deployed.schedulerNotifications) {
    console.log(`  Scheduler:    ${deployed.schedulerNotifications}`);
  }
  console.log(`  Network:      ${deployed.network}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  await createConnection();

  console.log("\n✅ Indexer running. Waiting for events...\n");
}

// Periodic stale subscription cleanup (every hour)
async function cleanupStaleSubs() {
  const subs = loadSubs();
  let changed = false;
  for (const [addr, list] of Object.entries(subs)) {
    const valid = [];
    for (const sub of list) {
      try {
        // Send empty payload to check if subscription is still valid.
        // The service worker skips notifications with no body — user sees nothing.
        await webpush.sendNotification(sub, JSON.stringify({ ping: true }));
        valid.push(sub);
      } catch (err) {
        const status = err.statusCode;
        if (status === 410 || status === 404 || status === 403) {
          console.log(`  Cleanup: removed stale sub for ${addr.slice(0, 6)}… (${status})`);
          changed = true;
        } else {
          valid.push(sub);
        }
      }
    }
    subs[addr] = valid;
  }
  if (changed) saveSubs(subs);
  console.log("  Cleanup: done");
}

setInterval(cleanupStaleSubs, 3600000); // every hour

// ── Periodic off-chain message scan (fallback when scheduler is unfunded/unavailable) ──

async function scanActiveMessages() {
  if (activeMessages.size === 0) return;

  const subs = loadSubs();
  const now = Math.floor(Date.now() / 1000);
  let warned = 0, unlocked = 0;

  for (const [messageId, msg] of activeMessages) {
    try {
      const lastSeen = Number(await checkInRead.lastSeen(msg.owner));
      if (lastSeen === 0) continue; // user not found

      const silence = now - lastSeen;

      // Warning at 80% of unlock threshold
      const warningThreshold = msg.inactivityUnlock * 0.8;
      if (!msg.warned && silence >= warningThreshold && silence < msg.inactivityUnlock) {
        msg.warned = true;
        const unlockAt = lastSeen + msg.inactivityUnlock;
        const notif = {
          type: "message_lock_warning",
          msg: `Locked message warning — unlockable ${new Date(unlockAt * 1000).toLocaleString()}`,
          target: msg.owner.toLowerCase(),
        };
        await deliver(notif, subs, "");
        warned++;
      }

      // Unlock threshold reached
      if (silence >= msg.inactivityUnlock) {
        const notif = {
          type: "message_unlockable",
          msg: `Message is unlockable from ${msg.owner.slice(0, 6)}…${msg.owner.slice(-4)}`,
          target: msg.recipient.toLowerCase(),
        };
        await deliver(notif, subs, "");
        activeMessages.delete(messageId);
        unlocked++;
      }
    } catch (err) {
      console.warn(`  ⏰ Scan error: ${messageId.slice(0, 10)}… ${err.message}`);
    }
  }

  if (warned || unlocked) {
    console.log(`  ⏰ Scan: ${warned} warnings, ${unlocked} unlock notifications`);
  }
}

// Run every 2 hours as a fallback for missed scheduler events
setInterval(scanActiveMessages, 2 * 3600_000);

run().catch(console.error);
