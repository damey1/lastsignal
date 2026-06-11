const { ethers } = require("hardhat");
const deployed = require("../deployed.json");

const CHECKIN_ABI = [
  "function previousCheckIn() view returns (address)",
  "function totalUsers() view returns (uint256)",
  "function canCheckIn(address user) view returns (bool)",
  "function signalPoints(address user) view returns (uint256)",
  "function ghostsCalled(address user) view returns (uint256)",
];

const BADGE_ABI = [
  "function minters(address user) view returns (bool)",
  "function balanceOf(address user) view returns (uint256)",
];

const VAULT_ABI = [
  "function checkInContract() view returns (address)",
  "function badgeContract() view returns (address)",
  "function pendingCheckInContract() view returns (address)",
  "function pendingUpdateTimestamp() view returns (uint256)",
];

const ADAPTER_ABI = [
  "function primaryCheckIn() view returns (address)",
  "function fallbackCheckIn() view returns (address)",
  "function legacyVault() view returns (address)",
  "function validationTimestamp() view returns (uint256)",
  "function lastSeen(address user) view returns (uint256)",
];

async function main() {
  const [deployer] = await ethers.getSigners();
  const checkIn = new ethers.Contract(deployed.checkIn, CHECKIN_ABI, deployer);
  const badges = new ethers.Contract(deployed.badges, BADGE_ABI, deployer);
  const vault = new ethers.Contract(deployed.messageVault, VAULT_ABI, deployer);
  const legacyVault = deployed.legacyMessageVault
    ? new ethers.Contract(deployed.legacyMessageVault, VAULT_ABI, deployer)
    : null;
  const adapter = deployed.checkInAdapter
    ? new ethers.Contract(deployed.checkInAdapter, ADAPTER_ABI, deployer)
    : null;

  for (const [label, address] of Object.entries({
    badges: deployed.badges,
    checkIn: deployed.checkIn,
    messageVault: deployed.messageVault,
    legacyMessageVault: deployed.legacyMessageVault,
    checkInAdapter: deployed.checkInAdapter,
  })) {
    if (!address) continue;
    const code = await ethers.provider.getCode(address);
    console.log(`${label}: ${address} (${code === "0x" ? "NO CODE" : "code ok"})`);
  }

  console.log(`previousCheckIn: ${await checkIn.previousCheckIn()}`);
  console.log(`vault.checkInContract: ${await vault.checkInContract()}`);
  console.log(`vault.badgeContract: ${await vault.badgeContract()}`);
  console.log(`checkIn is minter: ${await badges.minters(deployed.checkIn)}`);
  console.log(`vault is minter: ${await badges.minters(deployed.messageVault)}`);
  console.log(`totalUsers: ${(await checkIn.totalUsers()).toString()}`);
  console.log(`deployer canCheckIn: ${await checkIn.canCheckIn(deployer.address)}`);
  console.log(`deployer points: ${(await checkIn.signalPoints(deployer.address)).toString()}`);
  console.log(`deployer ghost calls: ${(await checkIn.ghostsCalled(deployer.address)).toString()}`);

  if (legacyVault) {
    console.log(`legacy.pendingCheckIn: ${await legacyVault.pendingCheckInContract()}`);
    console.log(`legacy.pendingEffectiveAt: ${(await legacyVault.pendingUpdateTimestamp()).toString()}`);
  }

  if (adapter) {
    console.log(`adapter.primaryCheckIn: ${await adapter.primaryCheckIn()}`);
    console.log(`adapter.fallbackCheckIn: ${await adapter.fallbackCheckIn()}`);
    console.log(`adapter.legacyVault: ${await adapter.legacyVault()}`);
    console.log(`adapter.lastSeen(legacyVault): ${(await adapter.lastSeen(deployed.legacyMessageVault)).toString()}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
