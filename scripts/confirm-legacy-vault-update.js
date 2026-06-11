const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const LEGACY_VAULT_ABI = [
  "function checkInContract() view returns (address)",
  "function pendingCheckInContract() view returns (address)",
  "function pendingUpdateTimestamp() view returns (uint256)",
  "function confirmCheckInContractUpdate() external",
];

async function main() {
  const outPath = path.join(__dirname, "..", "deployed.json");
  const deployed = JSON.parse(fs.readFileSync(outPath, "utf8"));
  const legacyVault = process.env.LEGACY_VAULT_ADDRESS || deployed.legacyMessageVault;

  if (!legacyVault) throw new Error("LEGACY_VAULT_ADDRESS or deployed.legacyMessageVault is required");

  const [deployer] = await ethers.getSigners();
  const vault = new ethers.Contract(legacyVault, LEGACY_VAULT_ABI, deployer);
  const pending = await vault.pendingCheckInContract();
  const effectiveAt = await vault.pendingUpdateTimestamp();
  const effectiveAtValue = BigInt(effectiveAt);
  const now = effectiveAtValue > 1000000000000n
    ? BigInt(Date.now())
    : BigInt(Math.floor(Date.now() / 1000));

  console.log(`Legacy vault: ${legacyVault}`);
  console.log(`Pending CheckIn: ${pending}`);
  console.log(`Effective at: ${effectiveAt.toString()}`);

  if (pending === ethers.ZeroAddress) throw new Error("No pending legacy vault update");
  if (effectiveAtValue > now) {
    throw new Error(`Timelock still active. Try after unix ${effectiveAt.toString()}`);
  }

  const tx = await vault.confirmCheckInContractUpdate();
  await tx.wait();

  deployed.legacyVaultCheckInContract = await vault.checkInContract();
  delete deployed.legacyVaultUpdateEffectiveAt;
  fs.writeFileSync(outPath, JSON.stringify(deployed, null, 2));
  console.log(`Legacy vault now uses ${deployed.legacyVaultCheckInContract}`);
  console.log(`Wrote ${outPath}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Legacy vault confirmation failed:", error);
    process.exit(1);
  });
