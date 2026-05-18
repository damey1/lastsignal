/**
 * LastSignal — Onchain notification feed
 *
 * Tracks events relevant to the connected user and displays them
 * in an in-app notification bell.
 *
 * Events indexed:
 *   MessageSealed        (you received a message)
 *   MessageUnlocked      (your message was claimed)
 *   GhostModeEntered     (you were declared ghost)
 *   StreakBroken         (your streak was broken)
 *   BackFromTheDead      (you checked in after ghost)
 */

const NOTIF_LS_KEY = "lastsignal.notifSeen";
const NOTIF_MAX = 20;

// VAPID public key for Web Push (from .env / service setup-keys.js)
const VAPID_PUBLIC_KEY = urlBase64ToUint8Array(
  "BKOH3GLLQ4mJvVA0NBgYV_IL47LEmtJYf0baHQF6gAExIOW2uNfSw-8eV_vhDko7vnn3Dmc6zSEtBliUHwc8xVg"
);

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const b64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

// ── Helpers ──

function _notifTime(ts) {
  const d = new Date(Number(ts) * 1000);
  const now = new Date();
  const diffMs = now - d;
  if (diffMs < 60000) return "just now";
  if (diffMs < 3600000) return `${Math.floor(diffMs / 60000)}m ago`;
  if (diffMs < 86400000) return `${Math.floor(diffMs / 3600000)}h ago`;
  return d.toLocaleDateString();
}

// ── Notification builder ──

function _buildNotifs(account, events) {
  const items = [];

  // MessageSealed → you are the recipient
  for (const e of (events.messageSealed || [])) {
    const args = e.args;
    items.push({
      type: "message_sealed",
      msg: `🔒 New message sealed from ${args.owner.slice(0, 6)}…${args.owner.slice(-4)}`,
      ts: Number(args.timestamp),
      tx: e.transactionHash,
      sortKey: Number(args.timestamp),
    });
  }

  // MessageUnlocked → you are the owner
  for (const e of (events.messageUnlocked || [])) {
    const args = e.args;
    items.push({
      type: "message_unlocked",
      msg: `📩 Message claimed by ${args.recipient.slice(0, 6)}…${args.recipient.slice(-4)}`,
      ts: Number(args.unlockedAt),
      tx: e.transactionHash,
      sortKey: Number(args.unlockedAt),
    });
  }

  // GhostModeEntered → you are the ghost
  for (const e of (events.ghostModeEntered || [])) {
    const args = e.args;
    items.push({
      type: "ghost_declared",
      msg: `👻 Declared ghost after ${Math.floor((Number(args.declaredAt) - Number(args.lastSeen)) / 86400)} days`,
      ts: Number(args.declaredAt),
      tx: e.transactionHash,
      sortKey: Number(args.declaredAt),
    });
  }

  // StreakBroken → you
  for (const e of (events.streakBroken || [])) {
    const args = e.args;
    items.push({
      type: "streak_broken",
      msg: `💔 ${Number(args.previousStreak)}-day streak broken`,
      ts: Number(args.brokenAt),
      tx: e.transactionHash,
      sortKey: Number(args.brokenAt),
    });
  }

  // BackFromTheDead → you
  for (const e of (events.backFromTheDead || [])) {
    const args = e.args;
    items.push({
      type: "back_from_dead",
      msg: `↺ Back from the dead after ${Math.floor(Number(args.silenceDuration) / 86400)} days`,
      ts: Number(args.checkedInAt),
      tx: e.transactionHash,
      sortKey: Number(args.checkedInAt),
    });
  }

  return items.sort((a, b) => b.sortKey - a.sortKey).slice(0, NOTIF_MAX);
}

// ── Event fetcher ──

// Chunked eth_getLogs — Ritual RPC limits to 100k blocks per call
async function _queryChunked(contract, filter, fromBlock, toBlock, chunkSize = 90000) {
  const from = Number(fromBlock);
  const to = Number(toBlock);
  const results = [];
  for (let start = from; start <= to; start += chunkSize) {
    const end = Math.min(start + chunkSize - 1, to);
    try {
      const chunk = await contract.queryFilter(filter, start, end);
      results.push(...chunk);
    } catch {
      // RPC may reject the range; skip silently
    }
  }
  return results;
}

async function fetchNotifs(checkIn, vault, account) {
  if (!checkIn || !vault || !account) return [];

  const lastQueried = Number(localStorage.getItem("lastsignal.notifLastBlock") || "0");
  const latest = await checkIn.runner.provider.getBlockNumber().catch(() => 0);
  if (latest < 1) return [];

  // First query: scan last 500k blocks (~6 days at 1s/block) to catch all testnet history.
  // Subsequent queries: only scan new blocks since last fetch.
  const from = lastQueried > 0 ? lastQueried + 1 : Math.max(1, latest - 500000);
  const to = latest;

  const [sealed, unlocked, ghosted, broken, back] = await Promise.all([
    _queryChunked(vault, vault.filters.MessageSealed(null, null, account), from, to),
    _queryChunked(vault, vault.filters.MessageUnlocked(null, account), from, to),
    _queryChunked(checkIn, checkIn.filters.GhostModeEntered(account), from, to),
    _queryChunked(checkIn, checkIn.filters.StreakBroken(account), from, to),
    _queryChunked(checkIn, checkIn.filters.BackFromTheDead(account), from, to),
  ]);

  localStorage.setItem("lastsignal.notifLastBlock", String(latest));

  return _buildNotifs(account, {
    messageSealed: sealed,
    messageUnlocked: unlocked,
    ghostModeEntered: ghosted,
    streakBroken: broken,
    backFromTheDead: back,
  });
}

// ── UI ──

function renderNotifBell(notifs, seenTs) {
  const bell = document.getElementById("notif-bell");
  const dot = document.getElementById("notif-dot");
  const list = document.getElementById("notif-list");
  const count = document.getElementById("notif-count");
  if (!bell || !list) return;

  const newCount = notifs.filter(n => n.sortKey > seenTs).length;
  if (dot) dot.style.display = newCount > 0 ? "flex" : "none";
  if (count) count.textContent = newCount > 99 ? "99+" : String(newCount);

  list.innerHTML = "";
  if (notifs.length === 0) {
    list.innerHTML = '<div class="notif-empty">No notifications</div>';
  } else {
    for (const n of notifs) {
    const el = document.createElement("a");
    el.className = "notif-item";
    el.href = n.tx ? `https://explorer.ritualfoundation.org/tx/${n.tx}` : "#";
    el.target = "_blank";
    el.rel = "noopener";
    el.innerHTML = `<span class="notif-text">${n.msg}</span><span class="notif-time">${_notifTime(n.ts)}</span>`;
    if (n.sortKey > seenTs) el.classList.add("notif-new");
    list.appendChild(el);
  }
  } // end else

  // Append push toggle below notifications
  const toggleContainer = document.createElement("div");
  toggleContainer.className = "notif-push-toggle";
  const toggleBtn = document.createElement("button");
  toggleBtn.id = "enable-push";
  toggleBtn.className = "push-btn";
  const sub = localStorage.getItem("lastsignal.pushSub");
  if (sub) {
    toggleBtn.textContent = "✅ Push enabled";
    toggleBtn.disabled = true;
  } else {
    toggleBtn.textContent = "🔔 Enable push";
    _wirePushToggle(toggleBtn);
  }
  toggleContainer.appendChild(toggleBtn);
  list.appendChild(toggleContainer);
}

// ── Initialise ──

async function initNotifs(checkIn, vault, account) {
  const seenRaw = localStorage.getItem(NOTIF_LS_KEY);
  const seenTs = seenRaw ? Number(seenRaw) : Math.floor(Date.now() / 1000);
  const list = document.getElementById("notif-list");
  if (list) list.innerHTML = '<div class="notif-empty">Loading...</div>';

  const notifs = await fetchNotifs(checkIn, vault, account);
  renderNotifBell(notifs, seenTs);

  const bell = document.getElementById("notif-bell");
  if (bell) {
    bell.addEventListener("click", () => {
      const latest = notifs.length > 0 ? notifs[0].sortKey : Math.floor(Date.now() / 1000);
      localStorage.setItem(NOTIF_LS_KEY, String(latest));
      const dot = document.getElementById("notif-dot");
      if (dot) dot.style.display = "none";
    });
  }
}

// ── Push Notifications ──

function _wirePushToggle(toggle) {
  toggle.addEventListener("click", async () => {
    toggle.textContent = "⏳ Subscribing...";
    try {
      if (typeof Notification === "undefined") {
        toggle.textContent = "❌ Notifications not supported";
        return;
      }
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        toggle.textContent = "⚠️ Permission denied";
        return;
      }
      const reg = await navigator.serviceWorker.register("/sw.js");
      toggle.textContent = "✅ Push enabled";
      toggle.disabled = true;
      const pushSub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: VAPID_PUBLIC_KEY,
      });
      localStorage.setItem("lastsignal.pushSub", JSON.stringify(pushSub));
      // Send subscription to the notification service
      try {
        await fetch("/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ address: window._state?.account, subscription: pushSub.toJSON() }),
        });
      } catch {}
    } catch (err) {
      toggle.textContent = "❌ Push not available";
      console.warn("Push setup failed:", err);
    }
  });
}

async function refreshNotifs(checkIn, vault, account) {
  if (!checkIn || !vault || !account) return;
  const seenRaw = localStorage.getItem(NOTIF_LS_KEY);
  const seenTs = seenRaw ? Number(seenRaw) : Math.floor(Date.now() / 1000);
  const notifs = await fetchNotifs(checkIn, vault, account);
  renderNotifBell(notifs, seenTs);
}

// Boot: show empty bell immediately, no wallet needed
renderNotifBell([], 0);
