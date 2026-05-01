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

const levelLabels = ["None", "New", "Stable", "Strong", "Legendary"];
const riskLabels = ["Unknown", "Active", "Watch", "Ghost"];
const daySeconds = 24 * 60 * 60;

const state = {
  provider: null,
  signer: null,
  account: null,
  checkIn: null,
  vault: null
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
  encryptedContent: $("encrypted-content"),
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
  return Math.ceil(asNumber(seconds) / daySeconds);
}

function formatDate(timestamp) {
  const value = asNumber(timestamp);
  if (!value) return "--";
  return new Date(value * 1000).toLocaleString();
}

function setText(node, text) {
  if (node) node.textContent = text;
}

function setBusy(button, busy) {
  if (button) button.disabled = busy;
}

function setStatus(node, text) {
  setText(node, text);
}

function loadConfig() {
  ui.checkInAddress.value = localStorage.getItem("lastsignal.checkIn") || "";
  ui.vaultAddress.value = localStorage.getItem("lastsignal.vault") || "";
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

async function connectWallet() {
  if (!window.ethereum) {
    setStatus(ui.signalStatus, "No EVM wallet detected");
    return;
  }

  state.provider = new ethers.BrowserProvider(window.ethereum);
  await state.provider.send("eth_requestAccounts", []);
  state.signer = await state.provider.getSigner();
  state.account = await state.signer.getAddress();

  const network = await state.provider.getNetwork();
  setText(ui.wallet, shortAddress(state.account));
  setText(ui.network, `chain ${network.chainId.toString()}`);
  setText(ui.connect, "Connected");

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
    setStatus(ui.signalStatus, canCheckIn ? "Ready for today's heartbeat" : `Last seen ${formatDate(signal.lastCheckIn)}`);
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
  setStatus(ui.signalStatus, "Sending heartbeat...");
  try {
    const tx = await state.checkIn.checkIn();
    await tx.wait();
    setStatus(ui.signalStatus, "Heartbeat confirmed");
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
  const content = ui.encryptedContent.value.trim();

  if (!ethers.isAddress(recipient)) throw new Error("Enter a valid recipient");
  if (!content) throw new Error("Encrypted content is required");

  setBusy(ui.sealMessage, true);
  setStatus(ui.sealStatus, "Sealing message...");

  try {
    const tx = await state.vault.sealMessage(recipient, content, daysToSeconds(ui.unlockDays.value));
    const receipt = await tx.wait();
    const messageId = findMessageId(receipt);
    ui.manageMessageId.value = messageId || "";
    setStatus(ui.sealStatus, messageId ? `Sealed ${messageId}` : "Message sealed");
    ui.encryptedContent.value = "";
    await refreshMessages();
  } catch (error) {
    setStatus(ui.sealStatus, readableError(error));
  } finally {
    setBusy(ui.sealMessage, false);
  }
}

function findMessageId(receipt) {
  for (const log of receipt.logs) {
    try {
      const parsed = state.vault.interface.parseLog(log);
      if (parsed && parsed.name === "MessageSealed") return parsed.args.messageId;
    } catch (_) {
      // Ignore logs from other contracts.
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
    const content = await state.vault.readOwnMessage(messageId);
    ui.updatedContent.value = content;
    setStatus(ui.manageStatus, "Owner content loaded");
  } catch (error) {
    setStatus(ui.manageStatus, readableError(error));
  }
}

async function updateContent() {
  requireContracts();
  const messageId = ui.manageMessageId.value.trim();
  const content = ui.updatedContent.value.trim();
  if (!messageId || !content) throw new Error("Message ID and content required");

  setBusy(ui.updateContent, true);
  setStatus(ui.manageStatus, "Rotating content...");
  try {
    const tx = await state.vault.updateMessageContent(messageId, content);
    await tx.wait();
    setStatus(ui.manageStatus, "Content updated");
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
  setStatus(ui.manageStatus, "Updating delay...");
  try {
    const tx = await state.vault.updateInactivityUnlock(messageId, daysToSeconds(ui.updatedUnlockDays.value));
    await tx.wait();
    setStatus(ui.manageStatus, "Delay updated");
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
  setStatus(ui.manageStatus, "Canceling message...");
  try {
    const tx = await state.vault.cancelMessage(messageId);
    await tx.wait();
    setStatus(ui.manageStatus, "Message canceled");
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
    const tx = await state.vault.claimMessage(messageId);
    await tx.wait();
    setStatus(ui.manageStatus, "Message claimed");
    await refreshMessages();
  } catch (error) {
    setStatus(ui.manageStatus, readableError(error));
  }
}

async function readUnlockedMessage(messageId) {
  requireContracts();
  try {
    const content = await state.vault.readMessage(messageId);
    setStatus(ui.manageStatus, content);
  } catch (error) {
    setStatus(ui.manageStatus, readableError(error));
  }
}

async function refreshAll() {
  if (!state.checkIn || !state.vault) return;
  await Promise.allSettled([refreshSignal(), refreshMessages()]);
}

function readableError(error) {
  const reason = error?.shortMessage || error?.reason || error?.message || "Transaction failed";
  return reason.replace(/^execution reverted: /, "");
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

  if (window.ethereum) {
    window.ethereum.on("accountsChanged", () => window.location.reload());
    window.ethereum.on("chainChanged", () => window.location.reload());
  }
}

loadConfig();
bindEvents();
