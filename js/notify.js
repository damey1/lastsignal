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

async function fetchNotifs(checkIn, vault, account, fromBlock) {
  if (!checkIn || !vault || !account) return [];

  const filter = { address: account };

  const [sealed, unlocked, ghosted, broken, back] = await Promise.all([
    vault.queryFilter(vault.filters.MessageSealed(null, null, account), fromBlock).catch(() => []),
    vault.queryFilter(vault.filters.MessageUnlocked(null, account), fromBlock).catch(() => []),
    checkIn.queryFilter(checkIn.filters.GhostModeEntered(account), fromBlock).catch(() => []),
    checkIn.queryFilter(checkIn.filters.StreakBroken(account), fromBlock).catch(() => []),
    checkIn.queryFilter(checkIn.filters.BackFromTheDead(account), fromBlock).catch(() => []),
  ]);

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
    return;
  }

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
}

// ── Initialise ──

async function initNotifs(checkIn, vault, account) {
  const seenRaw = localStorage.getItem(NOTIF_LS_KEY);
  const seenBlock = 0; // start from block 0 on first load

  const notifs = await fetchNotifs(checkIn, vault, account, seenBlock);
  const seenTs = seenRaw ? Number(seenRaw) : Date.now() / 1000;
  renderNotifBell(notifs, seenTs);

  // Mark as seen on bell click
  const bell = document.getElementById("notif-bell");
  if (bell) {
    bell.onclick = () => {
      const latest = notifs.length > 0 ? notifs[0].sortKey : Math.floor(Date.now() / 1000);
      localStorage.setItem(NOTIF_LS_KEY, String(latest));
      const dot = document.getElementById("notif-dot");
      if (dot) dot.style.display = "none";
    };
  }
}
