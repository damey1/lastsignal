const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const RITUAL_SCHEDULER = "0x56e776BAE2DD60664b69Bd5F865F1180ffB7D58B";

async function main() {
  const [deployer] = await ethers.getSigners();
  const outPath = path.join(__dirname, "..", "deployed.json");
  const deployed = JSON.parse(fs.readFileSync(outPath, "utf8"));

  const checkInAddress = process.env.CHECKIN_ADDRESS || deployed.checkIn;
  const vaultAddress = process.env.VAULT_ADDRESS || deployed.messageVault;
  const oldSchedulerAddress = deployed.schedulerNotifications;
  const fundAmount = process.env.SCHEDULER_ESCROW_FUND
    ? ethers.parseEther(process.env.SCHEDULER_ESCROW_FUND)
    : ethers.parseEther("0.01");

  if (!checkInAddress || !vaultAddress) {
    throw new Error("CHECKIN_ADDRESS/deployed.checkIn and VAULT_ADDRESS/deployed.messageVault are required");
  }

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  LastSignal — replace SchedulerNotifications");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`  Deployer:      ${deployer.address}`);
  console.log(`  CheckIn:       ${checkInAddress}`);
  console.log(`  MessageVault:  ${vaultAddress}`);
  console.log(`  Old Scheduler: ${oldSchedulerAddress || "(none)"}`);
  console.log(`  Fund amount:   ${ethers.formatEther(fundAmount)} RITUAL`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  const SchedulerNotifications = await ethers.getContractFactory("SchedulerNotifications");
  console.log("⏰ Deploying SchedulerNotifications...");
  const schedulerNotifications = await SchedulerNotifications.deploy(checkInAddress, RITUAL_SCHEDULER);
  await schedulerNotifications.waitForDeployment();
  const schedulerAddress = await schedulerNotifications.getAddress();
  console.log(`✅ SchedulerNotifications deployed: ${schedulerAddress}`);

  console.log("🔗 Authorizing MessageVault on SchedulerNotifications...");
  await (await schedulerNotifications.setVault(vaultAddress)).wait();
  console.log(`✅ Scheduler vault set: ${await schedulerNotifications.vault()}`);

  const MessageVault = await ethers.getContractFactory("MessageVault");
  const vault = MessageVault.attach(vaultAddress);

  const vaultOwner = await vault.owner();
  if (vaultOwner.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(`Deployer is not MessageVault owner. Owner is ${vaultOwner}`);
  }

  console.log("🔁 Pointing existing MessageVault to new SchedulerNotifications...");
  await (await vault.setSchedulerNotifications(schedulerAddress)).wait();
  console.log(`✅ Vault scheduler updated: ${await vault.schedulerNotifications()}`);

  if (fundAmount > 0n) {
    console.log("💰 Funding SchedulerNotifications escrow balance...");
    await (await deployer.sendTransaction({ to: schedulerAddress, value: fundAmount })).wait();
    const balance = await ethers.provider.getBalance(schedulerAddress);
    console.log(`✅ SchedulerNotifications balance: ${ethers.formatEther(balance)} RITUAL`);
  }

  deployed.previousSchedulerNotifications = oldSchedulerAddress;
  deployed.schedulerNotifications = schedulerAddress;
  deployed.messageVault = vaultAddress;
  deployed.checkIn = checkInAddress;
  deployed.network = hre.network.name;
  fs.writeFileSync(outPath, JSON.stringify(deployed, null, 2));
  console.log(`📝 Updated ${outPath}`);

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  ✅ SCHEDULER REPLACEMENT COMPLETE");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`  Scheduler:    ${schedulerAddress}`);
  console.log(`  MessageVault: ${vaultAddress}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("❌ Scheduler replacement failed:", error);
    process.exit(1);
  });
