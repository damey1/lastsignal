const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const LEGACY_VAULT_ABI = [
  "function owner() view returns (address)",
  "function checkInContract() view returns (address)",
  "function pendingCheckInContract() view returns (address)",
  "function pendingUpdateTimestamp() view returns (uint256)",
  "function proposeCheckInContract(address newCheckInContract) external",
];

async function main() {
  const [deployer] = await ethers.getSigners();
  const outPath = path.join(__dirname, "..", "deployed.json");
  const deployed = JSON.parse(fs.readFileSync(outPath, "utf8"));

  const primaryCheckIn = process.env.PRIMARY_CHECKIN_ADDRESS || deployed.checkIn;
  const fallbackCheckIn = process.env.FALLBACK_CHECKIN_ADDRESS || deployed.previousCheckIn;
  const legacyVault = process.env.LEGACY_VAULT_ADDRESS || deployed.legacyMessageVault;

  if (!primaryCheckIn || !fallbackCheckIn || !legacyVault) {
    throw new Error("primary CheckIn, fallback CheckIn, and legacy vault are required");
  }

  console.log(`Deployer: ${deployer.address}`);
  console.log(`Primary CheckIn:  ${primaryCheckIn}`);
  console.log(`Fallback CheckIn: ${fallbackCheckIn}`);
  console.log(`Legacy vault:     ${legacyVault}`);

  const CheckInAdapter = await ethers.getContractFactory("CheckInAdapter");
  const adapter = await CheckInAdapter.deploy(primaryCheckIn, fallbackCheckIn, legacyVault);
  await adapter.waitForDeployment();
  const adapterAddress = await adapter.getAddress();
  console.log(`Adapter deployed: ${adapterAddress}`);

  const vault = new ethers.Contract(legacyVault, LEGACY_VAULT_ABI, deployer);
  const owner = await vault.owner();
  if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(`Deployer is not legacy vault owner. Owner is ${owner}`);
  }

  console.log("Proposing adapter on legacy vault...");
  const tx = await vault.proposeCheckInContract(adapterAddress);
  await tx.wait();

  const pending = await vault.pendingCheckInContract();
  const effectiveAt = await vault.pendingUpdateTimestamp();
  console.log(`Pending CheckIn: ${pending}`);
  console.log(`Confirm after:   ${effectiveAt.toString()}`);

  deployed.legacyMessageVault = legacyVault;
  deployed.checkInAdapter = adapterAddress;
  deployed.legacyVaultUpdateEffectiveAt = effectiveAt.toString();
  fs.writeFileSync(outPath, JSON.stringify(deployed, null, 2));
  console.log(`Wrote ${outPath}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Adapter proposal failed:", error);
    process.exit(1);
  });
