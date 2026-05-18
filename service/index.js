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

dotenv.config();

// VAPID keys for Web Push
webpush.setVapidDetails(
  process.env.VAPID_SUBJECT || "mailto:lastsignal@example.com",
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

const WSS_URL = process.env.RITUAL_WSS_URL || "wss://rpc.ritualfoundation.org/ws";

const __dirname = dirname(fileURLToPath(import.meta.url));

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

// ── Provider & Contracts ──

const provider = new ethers.WebSocketProvider(WSS_URL);
console.log(`  WebSocket:  ${WSS_URL}`);
const checkIn = new ethers.Contract(deployed.checkIn, CHECKIN_EVENTS, provider);
const vault = new ethers.Contract(deployed.messageVault, VAULT_EVENTS, provider);

// ── Subscription Store ──

const SUBS_PATH = join(__dirname, "subscriptions.json");

function loadSubs() {
  try {
    return JSON.parse(readFileSync(SUBS_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveSubs(subs) {
  writeFileSync(SUBS_PATH, JSON.stringify(subs, null, 2));
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
createServer((req, res) => {
  // CORS headers for localhost frontend
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if (req.method === "POST" && req.url === "/subscribe") {
    let body = "";
    req.on("data", (c) => (body += c));
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
    default:
      return null;
  }
}

// ── Delivery ──

async function deliver(notif, subs, txHash) {
  const key = Object.keys(subs).find(k => k.toLowerCase() === notif.target.toLowerCase());
  if (!key) return;

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
      console.log(`  ✓ Push sent to ${notif.target.slice(0, 6)}…`);
      valid.push(sub);
    } catch (err) {
      const status = err.statusCode;
      if (status === 410 || status === 404 || status === 403) {
        console.log(`  ✗ Removing stale subscription for ${notif.target.slice(0, 6)}… (${status})`);
        changed = true;
      } else {
        console.error(`  ✗ Push failed for ${notif.target.slice(0, 6)}…: ${err.message}`);
        valid.push(sub); // keep — transient error
      }
    }
  }
  if (changed) {
    subs[key] = valid;
    saveSubs(subs);
  }
}

// ── Indexer ──

async function run() {
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  LastSignal Notification Service");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`  CheckIn:      ${deployed.checkIn}`);
  console.log(`  MessageVault: ${deployed.messageVault}`);
  console.log(`  Network:      ${deployed.network}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  const contracts = [
    { name: "CheckIn", contract: checkIn, events: ["StreakBroken", "GhostModeEntered", "BackFromTheDead"] },
    { name: "Vault", contract: vault, events: ["MessageSealed", "MessageUnlocked"] },
  ];

  for (const { name, contract, events } of contracts) {
    for (const eventName of events) {
      contract.on(eventName, async (...args) => {
        const event = args[args.length - 1]; // last arg is the EventLog
        const txHash = event?.transactionHash || event?.log?.transactionHash;
        const notif = formatEvent(eventName, event.args);
        if (!notif) return;

        console.log(`\n[${eventName}] ${notif.msg}`);
        console.log(`  Target: ${notif.target}`);
        console.log(`  Tx:     ${txHash}`);

        const subs = loadSubs();
        await deliver(notif, subs, txHash);
      });
      console.log(`  Listening: ${name}.${eventName}`);
    }
  }

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
        await webpush.sendNotification(sub, JSON.stringify({
          title: "LastSignal", body: "🔔 Heartbeat — subscription active",
        }));
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

run().catch(console.error);
