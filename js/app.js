const CHECKIN_ABI = [
  "function checkIn() external",
  "function migrateMySignal() external",
  "function declareGhost(address user) external returns (bool)",
  "function mySignal() external view returns (uint256 lastCheckIn,uint256 totalCheckIns,uint256 currentStreak,uint256 longestStreak,uint256 joinedAt,bool exists)",
  "function getSignal(address user) external view returns (uint256 lastCheckIn,uint256 totalCheckIns,uint256 currentStreak,uint256 longestStreak,uint256 joinedAt,bool exists)",
  "function canCheckIn(address user) external view returns (bool)",
  "function isGhost(address user,uint256 threshold) external view returns (bool)",
  "function silenceDuration(address user) external view returns (uint256)",
  "function signalLevel(address user) external view returns (uint8)",
  "function ghostRisk(address user) external view returns (uint8)",
  "function signalScore(address user) external view returns (uint256)",
  "function signalPoints(address user) external view returns (uint256)",
  "function ghostsCalled(address user) external view returns (uint256)",
  "function nextCheckInTime(address user) external view returns (uint256)",
  "function previousCheckIn() external view returns (address)",
  "error AlreadyCheckedIn()",
  "error UserNotFound()",
  "error AlreadyMigrated()",
  "error MigrationUnavailable()",
  "error CannotDeclareSelf()"
];

const VAULT_ABI = [
  "function sealMessage(address recipient,string encryptedContent,uint256 inactivityUnlock) external returns (bytes32)",
  "function getMyMessages() external view returns (bytes32[])",
  "function getMessagesForMe() external view returns (bytes32[])",
  "function getMessageInfo(bytes32 messageId) external view returns (address owner,address recipient,uint256 inactivityUnlock,uint256 createdAt,uint256 lastOwnerHeartbeat,bool unlocked,bool canceled,uint256 silenceRemaining)",
  "function readOwnMessage(bytes32 messageId) external view returns (string)",
  "function updateMessageContent(bytes32 messageId,string encryptedContent) external",
  "function updateInactivityUnlock(bytes32 messageId,uint256 inactivityUnlock) external",
  "function cancelMessage(bytes32 messageId) external",
  "function isUnlockable(bytes32 messageId) external view returns (bool)",
  "function claimMessage(bytes32 messageId) external",
  "function readMessage(bytes32 messageId) external view returns (string)",
  "event MessageSealed(bytes32 indexed messageId,address indexed owner,address indexed recipient,uint256 unlockAfter,uint256 timestamp)"
];

const BADGE_ABI = [
  "function hasBadge(address user,uint8 badgeType) external view returns (bool)",
  "function tokenOf(address user,uint8 badgeType) external view returns (uint256)",
  "function balanceOf(address user) external view returns (uint256)",
  "function tokenURI(uint256 tokenId) external view returns (string)",
  "event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)"
];

const RITUAL_CHAIN_ID = 1979;
const RITUAL_CHAIN_HEX = "0x7BB";

const levelLabels = ["None", "New", "Stable", "Strong", "Legendary"];
const riskLabels = ["Unknown", "Active", "Watch", "Ghost"];
const daySeconds = 24 * 60 * 60;
const ENC_VERSION = 1;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const badgeCatalog = [
  { type: 1, icon: "01", title: "First Signal", desc: "Send your first heartbeat" },
  { type: 2, icon: "03", title: "3 Day Signal", desc: "Keep a 3 day streak alive" },
  { type: 3, icon: "07", title: "7 Day Signal", desc: "Hold the line for a full week" },
  { type: 4, icon: "14", title: "14 Day Signal", desc: "Build a two week rhythm" },
  { type: 5, icon: "30", title: "30 Day Legend", desc: "Reach a legendary month" },
  { type: 6, icon: "↺", title: "Comeback Signal", desc: "Return after a broken streak" },
  { type: 7, icon: "◇", title: "Vault Sealer", desc: "Seal your first protected message" },
  { type: 8, icon: "◆", title: "Guardian", desc: "Claim a message meant for you" },
  { type: 9, icon: "GC", title: "Ghost Caller", desc: "Be first to confirm a ghost signal" },
  { type: 10, icon: "BD", title: "Back From The Dead", desc: "Return after the community called ghost" },
];

// ── ENCODING HELPERS (browser-native, no nacl.util dependency) ──
const _textEnc = new TextEncoder();
const _textDec = new TextDecoder();
const _toBytes = (s) => _textEnc.encode(s);
const _fromBytes = (a) => _textDec.decode(a);

// Chunk-safe base64 — avoids spread-operator argument limit
function _toB64(a) {
  const bytes = new Uint8Array(a);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function _fromB64(s) {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ── ENCRYPTION (tweetnacl + native encoding) ──

// Deterministic key derived from a personal_sign signature.
// Same account + same message = same key every time.
const OWNER_SIGN_MSG = "LastSignal heartbeat encryption key";

async function _deriveOwnerKey() {
  if (!state.signer) throw new Error("Connect wallet first");
  if (state.ownerKey) return state.ownerKey;
  // signMessage uses personal_sign (EIP-191), deterministic per RFC 6979
  const sig = await state.signer.signMessage(OWNER_SIGN_MSG);
  // Hash the raw signature bytes (65 bytes) to get a 32-byte key
  const hash = ethers.keccak256(sig);
  state.ownerKey = new Uint8Array(ethers.getBytes(hash).slice(0, nacl.secretbox.keyLength));
  return state.ownerKey;
}

// PBKDF2-SHA512 · 210 000 iterations (same tier as MetaMask)
const PBKDF2_ITER = 210000;

async function _deriveKeyPbkdf2(passphrase, salt) {
  const pwEnc = new TextEncoder().encode(passphrase);
  const baseKey = await crypto.subtle.importKey(
    "raw", pwEnc, { name: "PBKDF2" }, false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITER, hash: "SHA-512" },
    baseKey, 256 // 32 bytes
  );
  return new Uint8Array(bits);
}

function _deriveKeyLegacy(passphrase) {
  // Old-style key (backward compat — SHA-512 hash, no salt)
  const pw = _toBytes(passphrase);
  return nacl.hash(pw).slice(0, nacl.secretbox.keyLength);
}

async function encryptForOwner(plaintext) {
  const key = await _deriveOwnerKey();
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const msg = _toBytes(plaintext);
  const ct = nacl.secretbox(msg, nonce, key);
  return {
    nonce: _toB64(nonce),
    ciphertext: _toB64(ct),
  };
}

async function decryptForOwner(payload) {
  const key = await _deriveOwnerKey();
  const nonce = _fromB64(payload.nonce);
  const ct = _fromB64(payload.ciphertext);
  const plain = nacl.secretbox.open(ct, nonce, key);
  if (!plain) throw new Error("Decryption failed — wrong account or corrupted message");
  return _fromBytes(plain);
}

async function encryptForRecipient(plaintext, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await _deriveKeyPbkdf2(passphrase, salt);
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const msg = _toBytes(plaintext);
  const ct = nacl.secretbox(msg, nonce, key);
  return {
    v: 2, // PBKDF2 version
    nonce: _toB64(nonce),
    ciphertext: _toB64(ct),
    salt: _toB64(salt),
  };
}

async function decryptWithPassphrase(payload, passphrase) {
  const nonce = _fromB64(payload.nonce);
  const ct = _fromB64(payload.ciphertext);

  let key;
  if (payload.salt) {
    // v2 — PBKDF2
    const salt = _fromB64(payload.salt);
    key = await _deriveKeyPbkdf2(passphrase, salt);
  } else {
    // v1 legacy — SHA-512 hash
    key = _deriveKeyLegacy(passphrase);
  }

  const plain = nacl.secretbox.open(ct, nonce, key);
  if (!plain) throw new Error("Wrong passphrase or corrupted message");
  return _fromBytes(plain);
}

function isEncryptedPayload(str) {
  try {
    const p = JSON.parse(str);
    return p && p.v === ENC_VERSION && p.o && p.r;
  } catch { return false; }
}

const state = {
  provider: null,
  signer: null,
  account: null,
  checkIn: null,
  vault: null,
  legacyVault: null,
  badges: null,
  ownerKey: null,
};

const $ = (id) => document.getElementById(id);

const ui = {
  connect: $("connect-wallet"),
  network: $("network-label"),
  wallet: $("wallet-pill"),
  checkInAddress: $("checkin-address"),
  vaultAddress: $("vault-address"),
  legacyVaultAddress: $("legacy-vault-address"),
  badgesAddress: $("badges-address"),
  saveContracts: $("save-contracts"),
  configStatus: $("config-status"),
  refreshSignal: $("refresh-signal"),
  checkInButton: $("check-in"),
  migrateSignal: $("migrate-signal"),
  signalScore: $("signal-score"),
  signalLevel: $("signal-level"),
  currentStreak: $("current-streak"),
  longestStreak: $("longest-streak"),
  totalCheckIns: $("total-checkins"),
  ghostRisk: $("ghost-risk"),
  signalPoints: $("signal-points"),
  ghostsCalled: $("ghosts-called"),
  signalStatus: $("signal-status"),
  refreshBadges: $("refresh-badges"),
  badgesGrid: $("badges-grid"),
  badgesStatus: $("badges-status"),
  recipientAddress: $("recipient-address"),
  unlockDays: $("unlock-days"),
  plaintextMessage: $("plaintext-message"),
  sealPassphrase: $("seal-passphrase"),
  sealMessage: $("seal-message"),
  sealStatus: $("seal-status"),
  manageMessageId: $("manage-message-id"),
  updatedContent: $("updated-content"),
  updatedUnlockDays: $("updated-unlock-days"),
  readOwnMessage: $("read-own-message"),
  updateContent: $("update-content"),
  updateDelay: $("update-delay"),
  cancelMessage: $("cancel-message"),
  manageStatus: $("manage-status"),
  refreshMessages: $("refresh-messages"),
  ownedMessages: $("owned-messages"),
  recipientMessages: $("recipient-messages"),
  legacyMessagesPanel: $("legacy-messages-panel"),
  refreshLegacyMessages: $("refresh-legacy-messages"),
  legacyOwnedMessages: $("legacy-owned-messages"),
  legacyRecipientMessages: $("legacy-recipient-messages"),
  ghostAddress: $("ghost-address"),
  checkGhost: $("check-ghost"),
  declareGhost: $("declare-ghost"),
  ghostStatus: $("ghost-status")
};

function shortAddress(address) {
  if (!address) return "--";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function asNumber(value) {
  return Number(value ?? 0n);
}

function daysToSeconds(days) {
  return BigInt(Math.max(Number(days || 0), 0) * daySeconds);
}

function secondsToDays(seconds) {
  return Math.floor(asNumber(seconds) / daySeconds);
}

function formatDate(timestamp) {
  let value = asNumber(timestamp);
  if (!value) return "--";
  // Auto-detect ms vs seconds (seconds are < 1e12 for ~33,000 years)
  if (value > 1e12) value = Math.floor(value / 1000);
  return new Date(value * 1000).toLocaleString();
}

function explorerTxUrl(txHash) {
  return `https://explorer.ritualfoundation.org/tx/${txHash}`;
}

function explorerAddressUrl(addr) {
  return `https://explorer.ritualfoundation.org/address/${addr}`;
}

function copyToClipboard(text) {
  navigator.clipboard?.writeText(text).catch(() => {});
  return text;
}

async function gasEstimateLabel() {
  const fee = await state.provider.getFeeData();
  if (!fee.gasPrice) return "";
  const gwei = ethers.formatUnits(fee.gasPrice, "gwei");
  return `[${Number(gwei).toFixed(1)} gwei]`;
}

function setText(node, text) {
  if (node) node.textContent = text;
}

function setBusy(button, busy) {
  if (!button) return;
  button.classList.toggle("is-loading", busy);
  if (!busy) return; // don't re-enable — caller decides disabled state
  button.disabled = true;
}

function setStatus(node, text) {
  setText(node, text);
}

function sameAddress(a, b) {
  return String(a || "").toLowerCase() === String(b || "").toLowerCase();
}

let _configReady = null; // promise that resolves when loadConfig finishes

async function loadConfig() {
  _configReady = (async () => {
  // Source 1: deployed.json (written by deploy script)
  let deployed = {};
  try {
    const res = await fetch("deployed.json");
    if (res.ok) deployed = await res.json();
  } catch {}

  // Source 2: localStorage (user-saved via Save button)
  const savedCheckIn = localStorage.getItem("lastsignal.checkIn");
  const savedVault = localStorage.getItem("lastsignal.vault");
  const savedLegacyVault = localStorage.getItem("lastsignal.legacyVault");
  const savedBadges = localStorage.getItem("lastsignal.badges");

  // Priority: deployed.json wins on page load. User-saved only applies after clicking Save.
  const defaultCheckIn = deployed.checkIn || "";
  const defaultVault = deployed.messageVault || "";
  const defaultLegacyVault = deployed.legacyMessageVault || "";
  const defaultBadges = deployed.badges || "";

  ui.checkInAddress.value = defaultCheckIn || savedCheckIn || "";
  ui.vaultAddress.value = defaultVault || savedVault || "";
  ui.legacyVaultAddress.value = defaultLegacyVault || savedLegacyVault || "";
  ui.badgesAddress.value = defaultBadges || savedBadges || "";
  configureContracts();
  })().catch(() => {});
}

function configureContracts() {
  const checkInAddress = ui.checkInAddress.value.trim();
  const vaultAddress = ui.vaultAddress.value.trim();
  const legacyVaultAddress = ui.legacyVaultAddress.value.trim();
  const badgesAddress = ui.badgesAddress.value.trim();

  state.checkIn = null;
  state.vault = null;
  state.legacyVault = null;
  state.badges = null;

  if (!state.signer) {
    setStatus(ui.configStatus, "Connect wallet before loading contracts");
    return;
  }

  if (!ethers.isAddress(checkInAddress) || !ethers.isAddress(vaultAddress)) {
    setStatus(ui.configStatus, "Enter valid CheckIn and MessageVault addresses");
    return;
  }

  state.checkIn = new ethers.Contract(checkInAddress, CHECKIN_ABI, state.signer);
  state.vault = new ethers.Contract(vaultAddress, VAULT_ABI, state.signer);
  if (ethers.isAddress(legacyVaultAddress) && !sameAddress(legacyVaultAddress, vaultAddress)) {
    state.legacyVault = new ethers.Contract(legacyVaultAddress, VAULT_ABI, state.signer);
  }
  if (ethers.isAddress(badgesAddress)) {
    state.badges = new ethers.Contract(badgesAddress, BADGE_ABI, state.signer);
  }
  if (ui.legacyMessagesPanel) {
    ui.legacyMessagesPanel.style.display = state.legacyVault ? "block" : "none";
  }
  setStatus(ui.configStatus, state.legacyVault
    ? "Contracts, badges, and legacy vault loaded"
    : state.badges ? "Contracts and badges loaded" : "Contracts loaded — badges not configured");
}

function saveContracts() {
  const checkInAddress = ui.checkInAddress.value.trim();
  const vaultAddress = ui.vaultAddress.value.trim();
  const legacyVaultAddress = ui.legacyVaultAddress.value.trim();
  const badgesAddress = ui.badgesAddress.value.trim();
  localStorage.setItem("lastsignal.checkIn", checkInAddress);
  localStorage.setItem("lastsignal.vault", vaultAddress);
  localStorage.setItem("lastsignal.legacyVault", legacyVaultAddress);
  localStorage.setItem("lastsignal.badges", badgesAddress);
  configureContracts();
}

function requireContracts() {
  if (!state.signer) throw new Error("Connect wallet first");
  if (!state.checkIn || !state.vault) throw new Error("Load contract addresses first");
}

function requireVault(vault = state.vault) {
  if (!state.signer) throw new Error("Connect wallet first");
  if (!vault) throw new Error("Load vault address first");
  return vault;
}

async function switchToRitualChain() {
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: RITUAL_CHAIN_HEX }],
    });
  } catch (switchError) {
    // 4902 = chain not added yet
    if (switchError.code === 4902) {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: RITUAL_CHAIN_HEX,
          chainName: "Ritual Chain",
          nativeCurrency: { name: "RITUAL", symbol: "RITUAL", decimals: 18 },
          rpcUrls: ["https://rpc.ritualfoundation.org"],
          blockExplorerUrls: ["https://explorer.ritualfoundation.org"],
        }],
      });
    } else {
      throw switchError;
    }
  }
}

async function connectWallet() {
  if (!window.ethereum) {
    setStatus(ui.signalStatus, "No EVM wallet detected");
    return;
  }

  state.provider = new ethers.BrowserProvider(window.ethereum);
  await state.provider.send("eth_requestAccounts", []);
  state.signer = await state.provider.getSigner();
  state.account = await state.signer.getAddress();
  state.ownerKey = null; // clear cached owner key for new account

  const network = await state.provider.getNetwork();
  const onCorrectChain = Number(network.chainId) === RITUAL_CHAIN_ID;

  setText(ui.wallet, shortAddress(state.account));
  setText(ui.network, onCorrectChain ? "Ritual Chain" : `Wrong chain (${network.chainId})`);
  setText(ui.connect, "Connected");

  const warning = document.getElementById("chain-warning");
  if (warning) {
    warning.style.display = onCorrectChain ? "none" : "flex";
  }

  if (!onCorrectChain) {
    setStatus(ui.signalStatus, "Wrong network — click the 'Switch →' button or switch in your wallet");
    return;
  }

  // Wait for deployed.json to load before configuring contracts
  if (_configReady) await _configReady;
  configureContracts();
  await refreshAll();
}

async function refreshSignal() {
  // Clear any stale countdown timer
  if (window._cdTimer) { clearInterval(window._cdTimer); window._cdTimer = null; }

  requireContracts();

  try {
    // Individual calls so one RPC error doesn't wipe everything
    let signal, canCheckIn, level, risk, score, points, calls;
    try { signal = await state.checkIn.mySignal(); } catch {}
    try { canCheckIn = await state.checkIn.canCheckIn(state.account); } catch {}
    try { level = await state.checkIn.signalLevel(state.account); } catch {}
    try { risk = await state.checkIn.ghostRisk(state.account); } catch {}
    try { score = await state.checkIn.signalScore(state.account); } catch {}
    try { points = await state.checkIn.signalPoints(state.account); } catch {}
    try { calls = await state.checkIn.ghostsCalled(state.account); } catch {}

    if (!signal) throw new Error("No signal data");

    // Positional access (Result[0..5]) avoids any named-access quirks in ethers v6
    const lastCheckIn = signal[0], totalCheckIns = signal[1], currentStreak = signal[2],
          longestStreak = signal[3], joinedAt = signal[4], exists = signal[5];

    // Normalise timestamps — contract may return ms or seconds
    const _normTs = (v) => { const n = asNumber(v); return n > 1e12 ? Math.floor(n / 1000) : n; };

    setText(ui.signalScore, asNumber(score).toString());
    setText(ui.signalLevel, levelLabels[asNumber(level)] || "Unknown");
    setText(ui.currentStreak, asNumber(currentStreak).toString());
    setText(ui.longestStreak, asNumber(longestStreak).toString());
    setText(ui.totalCheckIns, asNumber(totalCheckIns).toString());
    setText(ui.ghostRisk, riskLabels[asNumber(risk)] || "Unknown");
    setText(ui.signalPoints, asNumber(points).toString());
    setText(ui.ghostsCalled, asNumber(calls).toString());
    if (ui.migrateSignal) ui.migrateSignal.style.display = "none";
    if (canCheckIn) {
      setStatus(ui.signalStatus, "Ready for today's heartbeat");
    } else {
      // Compute next check-in timestamp; fall back to lastCheckIn + 24h
      const nxt = _normTs(lastCheckIn) + daySeconds;
      const remaining = Math.max(0, nxt - Math.floor(Date.now() / 1000));

      // Sanity check — if remaining exceeds 30 days something is off
      if (remaining > 30 * daySeconds) {
        setStatus(ui.signalStatus, `Last seen ${formatDate(lastCheckIn)}`);
      } else if (remaining > 0) {
        // Clear any previous countdown timer before starting a new one
        if (window._cdTimer) clearInterval(window._cdTimer);
        const _updateCountdown = () => {
          const s = Math.max(0, Math.floor(nxt - Date.now() / 1000));
          const h = Math.floor(s / 3600);
          const m = Math.floor((s % 3600) / 60);
          setStatus(ui.signalStatus, `Next check-in in ${h > 0 ? `${h}h ${m}m` : `${m}m`}`);
        };
        _updateCountdown();
        window._cdTimer = setInterval(() => {
          if (Date.now() / 1000 >= nxt) {
            clearInterval(window._cdTimer);
            window._cdTimer = null;
            try { refreshSignal(); } catch {}
          } else {
            _updateCountdown();
          }
        }, 30000);
      } else {
        setStatus(ui.signalStatus, "Ready for today's heartbeat");
      }
    }
    ui.checkInButton.disabled = !canCheckIn;
  } catch (error) {
    setText(ui.signalScore, "0");
    setText(ui.signalLevel, "None");
    setText(ui.currentStreak, "0");
    setText(ui.longestStreak, "0");
    setText(ui.totalCheckIns, "0");
    setText(ui.ghostRisk, "Unknown");
    setText(ui.signalPoints, "0");
    setText(ui.ghostsCalled, "0");
    setStatus(ui.signalStatus, "No heartbeat recorded");
    await updateMigrationState();
    // Don't enable the button — leave it in the last known state
  }
}

async function updateMigrationState() {
  if (!ui.migrateSignal || !state.checkIn || !state.signer || !state.account) return;

  ui.migrateSignal.style.display = "none";
  ui.migrateSignal.disabled = true;

  let previousAddress = ZERO_ADDRESS;
  try {
    previousAddress = await state.checkIn.previousCheckIn();
  } catch {
    return;
  }

  if (!previousAddress || sameAddress(previousAddress, ZERO_ADDRESS)) return;

  try {
    const previousCheckIn = new ethers.Contract(previousAddress, CHECKIN_ABI, state.signer);
    const previousSignal = await previousCheckIn.getSignal(state.account);
    if (!previousSignal?.[5]) return;

    ui.migrateSignal.style.display = "inline-flex";
    ui.migrateSignal.disabled = false;
    setStatus(ui.signalStatus, "Previous signal found — migrate to preserve your streak");
  } catch {
    // No previous signal for this wallet.
  }
}

async function earnedBadgeTypes() {
  if (!state.badges || !state.account) return new Set();

  const checks = await Promise.allSettled(
    badgeCatalog.map((badge) => state.badges.hasBadge(state.account, badge.type))
  );

  return new Set(
    badgeCatalog
      .filter((_, index) => checks[index].status === "fulfilled" && checks[index].value)
      .map((badge) => badge.type)
  );
}

function renderBadgeCards(earned) {
  if (!ui.badgesGrid) return;
  ui.badgesGrid.innerHTML = "";

  for (const badge of badgeCatalog) {
    const isEarned = earned.has(badge.type);
    const card = document.createElement("article");
    card.className = `badge-card${isEarned ? " earned" : ""}`;
    card.innerHTML = `
      <div class="badge-icon">${badge.icon}</div>
      <div>
        <div class="badge-title">${badge.title}</div>
        <div class="badge-desc">${badge.desc}</div>
      </div>
      <span class="badge-state">${isEarned ? "earned" : "locked"}</span>
    `;
    ui.badgesGrid.appendChild(card);
  }
}

async function refreshBadges() {
  if (!ui.badgesGrid) return;

  if (!state.badges || !state.account) {
    renderBadgeCards(new Set());
    setStatus(ui.badgesStatus, state.account ? "Deploy or paste a badges address to load collectibles" : "Connect wallet to load badges");
    return new Set();
  }

  try {
    const earned = await earnedBadgeTypes();
    renderBadgeCards(earned);
    setStatus(ui.badgesStatus, `${earned.size}/${badgeCatalog.length} badges earned`);
    return earned;
  } catch (error) {
    renderBadgeCards(new Set());
    setStatus(ui.badgesStatus, readableError(error));
    return new Set();
  }
}

async function withBadgeCelebration(action, statusNode) {
  const before = await earnedBadgeTypes();
  const result = await action();
  const after = await refreshBadges();
  const unlocked = badgeCatalog.filter((badge) => after.has(badge.type) && !before.has(badge.type));
  if (unlocked.length) {
    setStatus(statusNode || ui.badgesStatus, `Badge unlocked: ${unlocked.map((badge) => badge.title).join(", ")}`);
  }
  return result;
}

async function sendCheckIn() {
  requireContracts();
  setBusy(ui.checkInButton, true);
  try {
    const gas = await gasEstimateLabel();
    setStatus(ui.signalStatus, `Sending heartbeat ${gas}`.trim());
    const receipt = await withBadgeCelebration(async () => {
      const tx = await state.checkIn.checkIn();
      return tx.wait();
    }, ui.signalStatus);
    const link = explorerTxUrl(receipt.hash);
    setStatus(ui.signalStatus, `Heartbeat confirmed — ${link}`);
    setBusy(ui.checkInButton, false);
    await refreshAll();
  } catch (error) {
    setStatus(ui.signalStatus, readableError(error));
    // Refresh first to re-compute disabled state, then re-enable
    try { await refreshSignal(); } catch {}
    setBusy(ui.checkInButton, false);
  }
}

async function migrateSignal() {
  requireContracts();
  setBusy(ui.migrateSignal, true);
  try {
    const gas = await gasEstimateLabel();
    setStatus(ui.signalStatus, `Migrating previous signal ${gas}`.trim());
    const receipt = await withBadgeCelebration(async () => {
      const tx = await state.checkIn.migrateMySignal();
      return tx.wait();
    }, ui.signalStatus);
    const link = explorerTxUrl(receipt.hash);
    setStatus(ui.signalStatus, `Signal migrated — ${link}`);
    if (ui.migrateSignal) ui.migrateSignal.style.display = "none";
    await refreshAll();
  } catch (error) {
    setStatus(ui.signalStatus, readableError(error));
  } finally {
    setBusy(ui.migrateSignal, false);
    if (ui.migrateSignal?.style.display !== "none") ui.migrateSignal.disabled = false;
  }
}

async function checkGhostStatus() {
  try {
    requireContracts();
    const target = ui.ghostAddress.value.trim();
    if (!ethers.isAddress(target)) {
      setStatus(ui.ghostStatus, "Enter a valid wallet address");
      return;
    }

    const [isGhost, silence] = await Promise.all([
      state.checkIn.isGhost(target, 0),
      state.checkIn.silenceDuration(target),
    ]);
    const daysSilent = Math.floor(asNumber(silence) / daySeconds);
    setStatus(ui.ghostStatus, isGhost
      ? `${shortAddress(target)} is ghost eligible — ${daysSilent} days silent`
      : `${shortAddress(target)} is not ghost yet — ${daysSilent} days silent`);
  } catch (error) {
    const msg = readableError(error);
    // Map contract errors to user-friendly messages
    if (msg.includes("UserNotFound")) {
      setStatus(ui.ghostStatus, "No heartbeat found for this address");
    } else if (msg.includes("already checked in")) {
      setStatus(ui.ghostStatus, "This user is active — no ghost declaration needed");
    } else {
      setStatus(ui.ghostStatus, msg);
    }
  }
}

async function declareGhost() {
  requireContracts();
  const target = ui.ghostAddress.value.trim();
  if (!ethers.isAddress(target)) throw new Error("Enter a valid wallet address");
  if (sameAddress(target, state.account)) throw new Error("You cannot declare yourself ghost");

  setBusy(ui.declareGhost, true);
  try {
    const gas = await gasEstimateLabel();
    setStatus(ui.ghostStatus, `Declaring ghost ${gas}`.trim());
    const receipt = await withBadgeCelebration(async () => {
      const tx = await state.checkIn.declareGhost(target);
      return tx.wait();
    }, ui.ghostStatus);
    const link = explorerTxUrl(receipt.hash);
    setStatus(ui.ghostStatus, `Ghost declared — +25 points — ${link}`);
    await refreshSignal();
  } catch (error) {
    setStatus(ui.ghostStatus, readableError(error));
  } finally {
    setBusy(ui.declareGhost, false);
  }
}

async function sealMessage() {
  requireContracts();
  const recipient = ui.recipientAddress.value.trim();
  const plaintext = ui.plaintextMessage.value.trim();
  const passphrase = ui.sealPassphrase.value.trim();

  const unlockDays = Number(ui.unlockDays.value);
  if (!ethers.isAddress(recipient)) throw new Error("Enter a valid recipient address");
  if (!plaintext) throw new Error("Write a message to seal");
  if (!passphrase) throw new Error("Set a passphrase — share this with the recipient off-chain");
  if (unlockDays < 2 || !Number.isFinite(unlockDays)) throw new Error("Minimum unlock delay is 2 days");

  setBusy(ui.sealMessage, true);

  try {
    // Step 1 — sign message to derive encryption key (MetaMask popup)
    setStatus(ui.sealStatus, "Sign message to encrypt...");

    // Step 2 — encrypt both copies
    const ownerEnc = await encryptForOwner(plaintext);
    const recipientEnc = await encryptForRecipient(plaintext, passphrase);

    // Step 3 — package as JSON blob
    const payload = JSON.stringify({ v: ENC_VERSION, o: ownerEnc, r: recipientEnc });

    // Step 4 — seal on-chain
    const gas = await gasEstimateLabel();
    setStatus(ui.sealStatus, `Sealing encrypted message ${gas}`.trim());
    const receipt = await withBadgeCelebration(async () => {
      const tx = await state.vault.sealMessage(recipient, payload, daysToSeconds(ui.unlockDays.value));
      return tx.wait();
    }, ui.sealStatus);
    const messageId = findMessageId(receipt);
    // Store tx hash in localStorage so message cards can link to the explorer
    if (messageId) {
      try {
        const map = JSON.parse(localStorage.getItem("lastsignal.txByMsg") || "{}");
        map[messageId.toLowerCase()] = receipt.hash;
        localStorage.setItem("lastsignal.txByMsg", JSON.stringify(map));
      } catch {}
    }
    const link = explorerTxUrl(receipt.hash);
    ui.manageMessageId.value = messageId || "";
    setStatus(ui.sealStatus, messageId
      ? `Sealed ${shortAddress(messageId)} — ${link}`
      : `Message sealed — ${link}`);
    ui.plaintextMessage.value = "";
    ui.sealPassphrase.value = "";
    await refreshMessages();
  } catch (error) {
    setStatus(ui.sealStatus, readableError(error));
  } finally {
    setBusy(ui.sealMessage, false);
  }
}

function findMessageId(receipt) {
  const vaultAddr = state.vault.target?.toLowerCase();
  for (const log of receipt.logs) {
    if (log.address?.toLowerCase() !== vaultAddr) continue;
    try {
      const parsed = state.vault.interface.parseLog(log);
      if (parsed && parsed.name === "MessageSealed") return parsed.args.messageId;
    } catch (_) {
      // Skip logs we can't parse.
    }
  }
  return "";
}

async function refreshMessages() {
  requireVault();
  await refreshVaultMessages(state.vault, ui.ownedMessages, ui.recipientMessages, "new");
}

async function refreshLegacyMessages() {
  if (!state.legacyVault) return;
  await refreshVaultMessages(state.legacyVault, ui.legacyOwnedMessages, ui.legacyRecipientMessages, "legacy");
}

async function refreshVaultMessages(vault, ownedContainer, recipientContainer, source) {
  const [ownedIds, recipientIds] = await Promise.all([
    vault.getMyMessages(),
    vault.getMessagesForMe()
  ]);

  await renderMessages(vault, ownedContainer, ownedIds, "owner", source);
  await renderMessages(vault, recipientContainer, recipientIds, "recipient", source);
}

async function renderMessages(vault, container, ids, mode, source) {
  container.innerHTML = "";

  if (!ids.length) {
    const empty = document.createElement("p");
    empty.className = "muted-line";
    empty.textContent = "No messages";
    container.appendChild(empty);
    return;
  }

  for (const id of ids) {
    const [info, unlockable] = await Promise.all([
      vault.getMessageInfo(id),
      vault.isUnlockable(id)
    ]);
    container.appendChild(messageCard(vault, id, info, unlockable, mode, source));
  }
}

function messageCard(vault, id, info, unlockable, mode, source) {
  const item = document.createElement("article");
  item.className = "message-item";
  if (unlockable) item.classList.add("unlockable");
  if (info.canceled) item.classList.add("canceled");

  const messageId = document.createElement("div");
  messageId.className = "message-id clickable";
  // Look up tx hash from localStorage
  let txHash;
  try { const map = JSON.parse(localStorage.getItem("lastsignal.txByMsg") || "{}"); txHash = map[id.toLowerCase()]; } catch {}
  const msgLabel = id.length > 66 ? id.slice(0, 66) + "…" : id;
  messageId.title = txHash ? "View sealing transaction in new tab" : "Click to copy";
  if (txHash) {
    const link = document.createElement("a");
    link.href = explorerTxUrl(txHash);
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = `🔗 ${msgLabel}`;
    link.style.color = "var(--purple-light)";
    link.style.textDecoration = "none";
    messageId.appendChild(link);
  } else {
    messageId.textContent = msgLabel;
    messageId.addEventListener("click", () => {
      navigator.clipboard?.writeText(id).catch(() => {});
      setStatus(ui.manageStatus, "Message ID copied");
    });
  }
  item.appendChild(messageId);

  const addrTag = (label, addr) =>
    `<span><a class="addr-link" href="${explorerAddressUrl(addr)}" target="_blank" rel="noopener" title="View on explorer (click to copy)">${label}: ${shortAddress(addr)}</a></span>`;

  const meta = document.createElement("div");
  meta.className = "message-meta";
  meta.innerHTML = `
    ${addrTag("Recipient", info.recipient)}
    ${addrTag("Owner", info.owner)}
    <span>Delay: ${secondsToDays(info.inactivityUnlock)} days</span>
    <span>Remaining: ${secondsToDays(info.silenceRemaining)} days</span>
    <span>Unlocked: ${info.unlocked ? "yes" : "no"}</span>
    <span>Canceled: ${info.canceled ? "yes" : "no"}</span>
  `;
  // Clicking an address link also copies to clipboard
  meta.querySelectorAll("a.addr-link").forEach(a => {
    a.addEventListener("click", (e) => {
      e.stopPropagation();
      navigator.clipboard?.writeText(a.href.split("/address/")[1]).catch(() => {});
    });
  });
  item.appendChild(meta);

  const actions = document.createElement("div");
  actions.className = "message-actions";

  const select = actionButton("Select", () => {
    ui.manageMessageId.value = id;
    setStatus(ui.manageStatus, `Selected ${source === "legacy" ? "legacy " : ""}${id}`);
  });
  actions.appendChild(select);

  if (mode === "owner") {
    actions.appendChild(actionButton("Read own", () => readOwnMessage(id, vault)));
    if (!info.unlocked && !info.canceled) {
      actions.appendChild(actionButton("Cancel", () => cancelMessage(id, vault)));
    }
  }

  if (mode === "recipient") {
    if (unlockable && !info.unlocked && !info.canceled) {
      actions.appendChild(actionButton("Claim", () => claimMessage(id, vault)));
    }
    if (info.unlocked && !info.canceled) {
      actions.appendChild(actionButton("Read", () => readUnlockedMessage(id, vault)));
    }
  }

  item.appendChild(actions);
  return item;
}

function actionButton(label, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "app-button app-button-secondary";
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

async function readOwnMessage(messageId = ui.manageMessageId.value.trim(), vault = state.vault) {
  vault = requireVault(vault);
  try {
    const raw = await vault.readOwnMessage(messageId);

    if (!isEncryptedPayload(raw)) {
      // Legacy — unencrypted content, show as-is
      ui.updatedContent.value = raw;
      setStatus(ui.manageStatus, "Content loaded (legacy, not encrypted)");
      return;
    }

    const parsed = JSON.parse(raw);

    // Decrypt owner's copy using signature-derived key
    const plain = await decryptForOwner(parsed.o);

    ui.updatedContent.value = plain;
    setStatus(ui.manageStatus, "Message decrypted");
  } catch (error) {
    setStatus(ui.manageStatus, readableError(error));
  }
}

async function updateContent() {
  requireContracts();
  const messageId = ui.manageMessageId.value.trim();
  const plaintext = ui.updatedContent.value.trim();
  if (!messageId || !plaintext) throw new Error("Message ID and plaintext required");

  setBusy(ui.updateContent, true);
  try {
    // Ask for a new passphrase for the recipient
    const newPass = prompt("Set a new passphrase for the recipient (share this off-chain):");
    if (!newPass) {
      setStatus(ui.manageStatus, "Rotation cancelled — passphrase required");
      return;
    }

    const ownerEnc = await encryptForOwner(plaintext);
    const recipientEnc = await encryptForRecipient(plaintext, newPass);
    const payload = JSON.stringify({ v: ENC_VERSION, o: ownerEnc, r: recipientEnc });

    const gas = await gasEstimateLabel();
    setStatus(ui.manageStatus, `Rotating content ${gas}`.trim());
    const tx = await state.vault.updateMessageContent(messageId, payload);
    const receipt = await tx.wait();
    const link = explorerTxUrl(receipt.hash);
    setStatus(ui.manageStatus, `Content updated — ${link}`);
    await refreshAllMessages();
  } catch (error) {
    setStatus(ui.manageStatus, readableError(error));
  } finally {
    setBusy(ui.updateContent, false);
  }
}

async function updateDelay() {
  requireContracts();
  const messageId = ui.manageMessageId.value.trim();
  if (!messageId) throw new Error("Message ID required");

  setBusy(ui.updateDelay, true);
  try {
    const gas = await gasEstimateLabel();
    setStatus(ui.manageStatus, `Updating delay ${gas}`.trim());
    const tx = await state.vault.updateInactivityUnlock(messageId, daysToSeconds(ui.updatedUnlockDays.value));
    const receipt = await tx.wait();
    const link = explorerTxUrl(receipt.hash);
    setStatus(ui.manageStatus, `Delay updated — ${link}`);
    await refreshAllMessages();
  } catch (error) {
    setStatus(ui.manageStatus, readableError(error));
  } finally {
    setBusy(ui.updateDelay, false);
  }
}

async function cancelMessage(messageId = ui.manageMessageId.value.trim(), vault = state.vault) {
  vault = requireVault(vault);
  if (!messageId) throw new Error("Message ID required");

  setBusy(ui.cancelMessage, true);
  try {
    const gas = await gasEstimateLabel();
    setStatus(ui.manageStatus, `Canceling message ${gas}`.trim());
    const tx = await vault.cancelMessage(messageId);
    const receipt = await tx.wait();
    const link = explorerTxUrl(receipt.hash);
    setStatus(ui.manageStatus, `Message canceled — ${link}`);
    await refreshAllMessages();
  } catch (error) {
    setStatus(ui.manageStatus, readableError(error));
  } finally {
    setBusy(ui.cancelMessage, false);
  }
}

async function claimMessage(messageId, vault = state.vault) {
  vault = requireVault(vault);
  try {
    const gas = await gasEstimateLabel();
    setStatus(ui.manageStatus, `Claiming message ${gas}`.trim());
    const receipt = await withBadgeCelebration(async () => {
      const tx = await vault.claimMessage(messageId);
      return tx.wait();
    }, ui.manageStatus);
    const link = explorerTxUrl(receipt.hash);
    setStatus(ui.manageStatus, `Message claimed — ${link}`);
    await refreshAllMessages();
  } catch (error) {
    setStatus(ui.manageStatus, readableError(error));
  }
}

async function readUnlockedMessage(messageId, vault = state.vault) {
  vault = requireVault(vault);
  try {
    const raw = await vault.readMessage(messageId);

    if (!isEncryptedPayload(raw)) {
      // Legacy — unencrypted content, show as-is
      setStatus(ui.manageStatus, raw);
      return;
    }

    const parsed = JSON.parse(raw);

    // Prompt for the passphrase the owner shared off-chain
    const passphrase = prompt("Enter the secret passphrase (shared by the message owner):");
    if (!passphrase) {
      setStatus(ui.manageStatus, "Decryption cancelled");
      return;
    }

    const plain = await decryptWithPassphrase(parsed.r, passphrase);
    setStatus(ui.manageStatus, `📩 ${plain}`);
  } catch (error) {
    setStatus(ui.manageStatus, readableError(error));
  }
}

async function refreshAllMessages() {
  await Promise.allSettled([refreshMessages(), refreshLegacyMessages()]);
}

async function refreshAll() {
  if (!state.checkIn || !state.vault) return;
  await Promise.allSettled([refreshSignal(), refreshAllMessages(), refreshBadges()]);
}

function readableError(error) {
  const msg = error?.shortMessage || error?.reason || error?.message || "Transaction failed";

  // Custom errors from CheckIn.sol
  if (msg.includes("AlreadyCheckedIn")) {
    return "Already checked in today — wait for the countdown to end";
  }
  if (msg.includes("UserNotFound")) {
    return "No heartbeat found for this address";
  }
  if (msg.includes("NotGhostYet")) {
    return "30 days of silence required before ghost declaration";
  }
  if (msg.includes("AlreadyMigrated")) {
    return "Signal already migrated";
  }
  if (msg.includes("MigrationUnavailable")) {
    return "Migration not available — previous CheckIn not configured";
  }
  if (msg.includes("CannotDeclareSelf")) {
    return "You cannot declare yourself as ghost";
  }
  if (msg.includes("unknown custom error")) {
    return "Transaction reverted — check wallet and try again";
  }

  // Catch insufficient funds and surface a clear message
  if (msg.includes("insufficient funds") || msg.includes("gas required exceeds")) {
    return "⚠️ Insufficient RITUAL balance for gas — fund your wallet and try again";
  }

  return msg.replace(/^execution reverted: /, "");
}

function bind(id, handler) {
  const node = $(id);
  if (!node) return;
  node.addEventListener("click", async () => {
    try {
      await handler();
    } catch (error) {
      setStatus(ui.manageStatus, readableError(error));
    }
  });
}

function bindEvents() {
  bind("connect-wallet", connectWallet);
  bind("save-contracts", async () => {
    saveContracts();
    await refreshAll();
  });
  bind("refresh-signal", async () => {
    try { await refreshSignal(); } catch {}
  });
  bind("check-in", sendCheckIn);
  bind("migrate-signal", migrateSignal);
  bind("seal-message", sealMessage);
  bind("refresh-messages", refreshMessages);
  bind("refresh-legacy-messages", refreshLegacyMessages);
  bind("refresh-badges", refreshBadges);
  bind("read-own-message", readOwnMessage);
  bind("update-content", updateContent);
  bind("update-delay", updateDelay);
  bind("cancel-message", cancelMessage);
  bind("check-ghost", checkGhostStatus);
  bind("declare-ghost", declareGhost);
  bind("switch-chain", switchToRitualChain);
  bind("network-label", switchToRitualChain);
  bind("reset-contracts", async () => {
    localStorage.removeItem("lastsignal.checkIn");
    localStorage.removeItem("lastsignal.vault");
    localStorage.removeItem("lastsignal.legacyVault");
    localStorage.removeItem("lastsignal.badges");
    // Wait a tick for UI, then reload from deployed.json
    setStatus(ui.configStatus, "Resetting to deployed defaults...");
    await loadConfig();
    await refreshAll();
  });

  if (window.ethereum) {
    window.ethereum.on("accountsChanged", () => window.location.reload());
    window.ethereum.on("chainChanged", (chainId) => {
      if (String(chainId).toLowerCase() !== String(RITUAL_CHAIN_HEX).toLowerCase()) {
        const warning = document.getElementById("chain-warning");
        if (warning) warning.style.display = "flex";
        setText(ui.network, "Wrong network");
        setStatus(ui.signalStatus, "Switch to Ritual Chain (ID 1979) in your wallet");
      } else if (state.signer) {
        // Already on correct chain — just refresh data
        try { refreshAll(); } catch {}
      } else {
        window.location.reload();
      }
    });
  }

  // Show/hide passphrase
  const togglePw = document.getElementById("toggle-passphrase");
  const pwInput = document.getElementById("seal-passphrase");
  if (togglePw && pwInput) {
    togglePw.addEventListener("click", () => {
      const isPassword = pwInput.type === "password";
      pwInput.type = isPassword ? "text" : "password";
      togglePw.textContent = isPassword ? "🙈" : "👁";
    });
  }

  // Live warning on unlock days input
  const unlockInput = ui.unlockDays;
  const unlockWarn = document.getElementById("unlock-days-warn");
  if (unlockInput && unlockWarn) {
    unlockInput.addEventListener("input", () => {
      const val = Number(unlockInput.value);
      unlockWarn.style.display = (val < 2 || !Number.isFinite(val)) ? "block" : "none";
    });
  }
}

loadConfig();
bindEvents();
