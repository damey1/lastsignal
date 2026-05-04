const CHECKIN_ABI = [
  "function checkIn() external",
  "function mySignal() external view returns (uint256 lastCheckIn,uint256 totalCheckIns,uint256 currentStreak,uint256 longestStreak,uint256 joinedAt,bool exists)",
  "function canCheckIn(address user) external view returns (bool)",
  "function signalLevel(address user) external view returns (uint8)",
  "function ghostRisk(address user) external view returns (uint8)",
  "function signalScore(address user) external view returns (uint256)"
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

const RITUAL_CHAIN_ID = 1979;
const RITUAL_CHAIN_HEX = "0x7BB";

const levelLabels = ["None", "New", "Stable", "Strong", "Legendary"];
const riskLabels = ["Unknown", "Active", "Watch", "Ghost"];
const daySeconds = 24 * 60 * 60;
const ENC_VERSION = 1;

// ── ENCRYPTION (tweetnacl) ──

async function getEncryptionPubKey() {
  if (!window.ethereum || !state.account) throw new Error("Connect wallet first");
  if (state.encPubKey) return state.encPubKey;
  state.encPubKey = await window.ethereum.request({
    method: "eth_getEncryptionPublicKey",
    params: [state.account],
  });
  return state.encPubKey;
}

function _deriveKey(passphrase) {
  const pw = nacl.util.decodeUTF8(passphrase);
  return nacl.hash(pw).slice(0, nacl.secretbox.keyLength);
}

function encryptForOwner(plaintext, pubKeyB64) {
  const theirPub = nacl.util.decodeBase64(pubKeyB64);
  const ephem = nacl.box.keyPair();
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const msg = nacl.util.decodeUTF8(plaintext);
  const ct = nacl.box(msg, nonce, theirPub, ephem.secretKey);
  return {
    version: "x25519-xsalsa20-poly1305",
    nonce: nacl.util.encodeBase64(nonce),
    ephemPublicKey: nacl.util.encodeBase64(ephem.publicKey),
    ciphertext: nacl.util.encodeBase64(ct),
  };
}

function encryptForRecipient(plaintext, passphrase) {
  const key = _deriveKey(passphrase);
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const msg = nacl.util.decodeUTF8(plaintext);
  const ct = nacl.secretbox(msg, nonce, key);
  return {
    nonce: nacl.util.encodeBase64(nonce),
    ciphertext: nacl.util.encodeBase64(ct),
  };
}

function decryptWithPassphrase(payload, passphrase) {
  const key = _deriveKey(passphrase);
  const nonce = nacl.util.decodeBase64(payload.nonce);
  const ct = nacl.util.decodeBase64(payload.ciphertext);
  const plain = nacl.secretbox.open(ct, nonce, key);
  if (!plain) throw new Error("Wrong passphrase or corrupted message");
  return nacl.util.encodeUTF8(plain);
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
  encPubKey: null,
};

const $ = (id) => document.getElementById(id);

const ui = {
  connect: $("connect-wallet"),
  network: $("network-label"),
  wallet: $("wallet-pill"),
  checkInAddress: $("checkin-address"),
  vaultAddress: $("vault-address"),
  saveContracts: $("save-contracts"),
  configStatus: $("config-status"),
  refreshSignal: $("refresh-signal"),
  checkInButton: $("check-in"),
  signalScore: $("signal-score"),
  signalLevel: $("signal-level"),
  currentStreak: $("current-streak"),
  longestStreak: $("longest-streak"),
  totalCheckIns: $("total-checkins"),
  ghostRisk: $("ghost-risk"),
  signalStatus: $("signal-status"),
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
  recipientMessages: $("recipient-messages")
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
  const value = asNumber(timestamp);
  if (!value) return "--";
  return new Date(value * 1000).toLocaleString();
}

function explorerTxUrl(txHash) {
  return `https://explorer.ritualfoundation.org/tx/${txHash}`;
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
  button.disabled = busy;
  button.classList.toggle("is-loading", busy);
}

function setStatus(node, text) {
  setText(node, text);
}

async function loadConfig() {
  // Try fetching deployed.json (generated by deploy script)
  let deployed = {};
  try {
    const res = await fetch("deployed.json");
    if (res.ok) deployed = await res.json();
  } catch { /* file missing — use defaults */ }

  const defaults = deployed.checkIn
    ? { checkIn: deployed.checkIn, vault: deployed.messageVault }
    : { checkIn: "0x2a19C36007194005146D40E80886C9007ed4971F", vault: "0x3C7a639926031E3DcC61f9F8666d792fCC71E73A" };

  ui.checkInAddress.value = localStorage.getItem("lastsignal.checkIn") || defaults.checkIn;
  ui.vaultAddress.value = localStorage.getItem("lastsignal.vault") || defaults.vault;
  configureContracts();
}

function configureContracts() {
  const checkInAddress = ui.checkInAddress.value.trim();
  const vaultAddress = ui.vaultAddress.value.trim();

  localStorage.setItem("lastsignal.checkIn", checkInAddress);
  localStorage.setItem("lastsignal.vault", vaultAddress);

  state.checkIn = null;
  state.vault = null;

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
  setStatus(ui.configStatus, "Contracts loaded");
}

function requireContracts() {
  if (!state.signer) throw new Error("Connect wallet first");
  if (!state.checkIn || !state.vault) throw new Error("Load contract addresses first");
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
  state.encPubKey = null; // clear cached encryption key for new account

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

  configureContracts();
  await refreshAll();
}

async function refreshSignal() {
  requireContracts();

  try {
    const [signal, canCheckIn, level, risk, score] = await Promise.all([
      state.checkIn.mySignal(),
      state.checkIn.canCheckIn(state.account),
      state.checkIn.signalLevel(state.account),
      state.checkIn.ghostRisk(state.account),
      state.checkIn.signalScore(state.account)
    ]);

    setText(ui.signalScore, asNumber(score).toString());
    setText(ui.signalLevel, levelLabels[asNumber(level)] || "Unknown");
    setText(ui.currentStreak, asNumber(signal.currentStreak).toString());
    setText(ui.longestStreak, asNumber(signal.longestStreak).toString());
    setText(ui.totalCheckIns, asNumber(signal.totalCheckIns).toString());
    setText(ui.ghostRisk, riskLabels[asNumber(risk)] || "Unknown");
    if (canCheckIn) {
      setStatus(ui.signalStatus, "Ready for today's heartbeat");
    } else {
      const nextTime = (asNumber(signal.lastCheckIn) + daySeconds) * 1000;
      const remaining = Math.max(0, nextTime - Date.now());

      if (remaining > 0) {
        const hours = Math.floor(remaining / 3600000);
        const minutes = Math.floor((remaining % 3600000) / 60000);
        setStatus(ui.signalStatus, `Next check-in in ${hours}h ${minutes}m`);
        // Auto-refresh when countdown expires
        setTimeout(() => { try { refreshSignal(); } catch {} }, remaining + 1000);
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
    ui.checkInButton.disabled = false;
    setStatus(ui.signalStatus, "No heartbeat recorded");
  }
}

async function sendCheckIn() {
  requireContracts();
  setBusy(ui.checkInButton, true);
  try {
    const gas = await gasEstimateLabel();
    setStatus(ui.signalStatus, `Sending heartbeat ${gas}`.trim());
    const tx = await state.checkIn.checkIn();
    const receipt = await tx.wait();
    const link = explorerTxUrl(receipt.hash);
    setStatus(ui.signalStatus, `Heartbeat confirmed — ${link}`);
    await refreshAll();
  } catch (error) {
    setStatus(ui.signalStatus, readableError(error));
  } finally {
    setBusy(ui.checkInButton, false);
  }
}

async function sealMessage() {
  requireContracts();
  const recipient = ui.recipientAddress.value.trim();
  const plaintext = ui.plaintextMessage.value.trim();
  const passphrase = ui.sealPassphrase.value.trim();

  if (!ethers.isAddress(recipient)) throw new Error("Enter a valid recipient address");
  if (!plaintext) throw new Error("Write a message to seal");
  if (!passphrase) throw new Error("Set a passphrase — share this with the recipient off-chain");

  setBusy(ui.sealMessage, true);

  try {
    // Step 1 — get owner's encryption public key (MetaMask popup)
    setStatus(ui.sealStatus, "Requesting encryption key from MetaMask...");
    const pubKey = await getEncryptionPubKey();

    // Step 2 — encrypt both copies
    const ownerEnc = encryptForOwner(plaintext, pubKey);
    const recipientEnc = encryptForRecipient(plaintext, passphrase);

    // Step 3 — package as JSON blob
    const payload = JSON.stringify({ v: ENC_VERSION, o: ownerEnc, r: recipientEnc });

    // Step 4 — seal on-chain
    const gas = await gasEstimateLabel();
    setStatus(ui.sealStatus, `Sealing encrypted message ${gas}`.trim());
    const tx = await state.vault.sealMessage(recipient, payload, daysToSeconds(ui.unlockDays.value));
    const receipt = await tx.wait();
    const messageId = findMessageId(receipt);
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
  requireContracts();
  const [ownedIds, recipientIds] = await Promise.all([
    state.vault.getMyMessages(),
    state.vault.getMessagesForMe()
  ]);

  await renderMessages(ui.ownedMessages, ownedIds, "owner");
  await renderMessages(ui.recipientMessages, recipientIds, "recipient");
}

async function renderMessages(container, ids, mode) {
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
      state.vault.getMessageInfo(id),
      state.vault.isUnlockable(id)
    ]);
    container.appendChild(messageCard(id, info, unlockable, mode));
  }
}

function messageCard(id, info, unlockable, mode) {
  const item = document.createElement("article");
  item.className = "message-item";
  if (unlockable) item.classList.add("unlockable");
  if (info.canceled) item.classList.add("canceled");

  const messageId = document.createElement("div");
  messageId.className = "message-id";
  messageId.textContent = id;
  item.appendChild(messageId);

  const meta = document.createElement("div");
  meta.className = "message-meta";
  meta.innerHTML = `
    <span>Recipient: ${shortAddress(info.recipient)}</span>
    <span>Owner: ${shortAddress(info.owner)}</span>
    <span>Delay: ${secondsToDays(info.inactivityUnlock)} days</span>
    <span>Remaining: ${secondsToDays(info.silenceRemaining)} days</span>
    <span>Unlocked: ${info.unlocked ? "yes" : "no"}</span>
    <span>Canceled: ${info.canceled ? "yes" : "no"}</span>
  `;
  item.appendChild(meta);

  const actions = document.createElement("div");
  actions.className = "message-actions";

  const select = actionButton("Select", () => {
    ui.manageMessageId.value = id;
    setStatus(ui.manageStatus, `Selected ${id}`);
  });
  actions.appendChild(select);

  if (mode === "owner") {
    actions.appendChild(actionButton("Read own", () => readOwnMessage(id)));
    if (!info.unlocked && !info.canceled) {
      actions.appendChild(actionButton("Cancel", () => cancelMessage(id)));
    }
  }

  if (mode === "recipient") {
    if (unlockable && !info.unlocked && !info.canceled) {
      actions.appendChild(actionButton("Claim", () => claimMessage(id)));
    }
    if (info.unlocked && !info.canceled) {
      actions.appendChild(actionButton("Read", () => readUnlockedMessage(id)));
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

async function readOwnMessage(messageId = ui.manageMessageId.value.trim()) {
  requireContracts();
  try {
    const raw = await state.vault.readOwnMessage(messageId);

    if (!isEncryptedPayload(raw)) {
      // Legacy — unencrypted content, show as-is
      ui.updatedContent.value = raw;
      setStatus(ui.manageStatus, "Content loaded (legacy, not encrypted)");
      return;
    }

    const parsed = JSON.parse(raw);

    // Decrypt owner's copy via MetaMask
    const plain = await window.ethereum.request({
      method: "eth_decrypt",
      params: [JSON.stringify(parsed.o), state.account],
    });

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

    const pubKey = await getEncryptionPubKey();
    const ownerEnc = encryptForOwner(plaintext, pubKey);
    const recipientEnc = encryptForRecipient(plaintext, newPass);
    const payload = JSON.stringify({ v: ENC_VERSION, o: ownerEnc, r: recipientEnc });

    const gas = await gasEstimateLabel();
    setStatus(ui.manageStatus, `Rotating content ${gas}`.trim());
    const tx = await state.vault.updateMessageContent(messageId, payload);
    const receipt = await tx.wait();
    const link = explorerTxUrl(receipt.hash);
    setStatus(ui.manageStatus, `Content updated — ${link}`);
    await refreshMessages();
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
    await refreshMessages();
  } catch (error) {
    setStatus(ui.manageStatus, readableError(error));
  } finally {
    setBusy(ui.updateDelay, false);
  }
}

async function cancelMessage(messageId = ui.manageMessageId.value.trim()) {
  requireContracts();
  if (!messageId) throw new Error("Message ID required");

  setBusy(ui.cancelMessage, true);
  try {
    const gas = await gasEstimateLabel();
    setStatus(ui.manageStatus, `Canceling message ${gas}`.trim());
    const tx = await state.vault.cancelMessage(messageId);
    const receipt = await tx.wait();
    const link = explorerTxUrl(receipt.hash);
    setStatus(ui.manageStatus, `Message canceled — ${link}`);
    await refreshMessages();
  } catch (error) {
    setStatus(ui.manageStatus, readableError(error));
  } finally {
    setBusy(ui.cancelMessage, false);
  }
}

async function claimMessage(messageId) {
  requireContracts();
  try {
    const gas = await gasEstimateLabel();
    setStatus(ui.manageStatus, `Claiming message ${gas}`.trim());
    const tx = await state.vault.claimMessage(messageId);
    const receipt = await tx.wait();
    const link = explorerTxUrl(receipt.hash);
    setStatus(ui.manageStatus, `Message claimed — ${link}`);
    await refreshMessages();
  } catch (error) {
    setStatus(ui.manageStatus, readableError(error));
  }
}

async function readUnlockedMessage(messageId) {
  requireContracts();
  try {
    const raw = await state.vault.readMessage(messageId);

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

    const plain = decryptWithPassphrase(parsed.r, passphrase);
    setStatus(ui.manageStatus, `📩 ${plain}`);
  } catch (error) {
    setStatus(ui.manageStatus, readableError(error));
  }
}

async function refreshAll() {
  if (!state.checkIn || !state.vault) return;
  await Promise.allSettled([refreshSignal(), refreshMessages()]);
}

function readableError(error) {
  const msg = error?.shortMessage || error?.reason || error?.message || "Transaction failed";

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
    configureContracts();
    await refreshAll();
  });
  bind("refresh-signal", refreshSignal);
  bind("check-in", sendCheckIn);
  bind("seal-message", sealMessage);
  bind("refresh-messages", refreshMessages);
  bind("read-own-message", readOwnMessage);
  bind("update-content", updateContent);
  bind("update-delay", updateDelay);
  bind("cancel-message", cancelMessage);
  bind("switch-chain", switchToRitualChain);
  bind("network-label", switchToRitualChain);

  if (window.ethereum) {
    window.ethereum.on("accountsChanged", () => window.location.reload());
    window.ethereum.on("chainChanged", (chainId) => {
      if (String(chainId).toLowerCase() !== String(RITUAL_CHAIN_HEX).toLowerCase()) {
        const warning = document.getElementById("chain-warning");
        if (warning) warning.style.display = "flex";
        setText(ui.network, "Wrong network");
        setStatus(ui.signalStatus, "Switch to Ritual Chain (ID 1979) in your wallet");
      } else {
        window.location.reload();
      }
    });
  }
}

loadConfig();
bindEvents();
