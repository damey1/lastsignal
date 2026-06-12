const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  const fs = require("fs");
  const path = require("path");
  const outPath = path.join(__dirname, "..", "deployed.json");
  const deployed = JSON.parse(fs.readFileSync(outPath, "utf8"));

  console.log("Deployer:", deployer.address);
  console.log("Old vault:", deployed.messageVault);

  const MessageVault = await ethers.getContractFactory("MessageVault");
  const vault = await MessageVault.deploy(deployed.checkIn, deployed.badges, deployed.schedulerNotifications);
  await vault.waitForDeployment();
  const vaultAddress = await vault.getAddress();
  console.log("New vault:", vaultAddress);

  // Update scheduler to allow new vault
  const SchedulerNotif = await ethers.getContractFactory("SchedulerNotifications");
  const scheduler = SchedulerNotif.attach(deployed.schedulerNotifications);
  await (await scheduler.setVault(vaultAddress)).wait();
  console.log("Scheduler vault updated");

  // Save legacy vault reference — accumulate all past vaults
  const oldVault = deployed.messageVault;
  if (!deployed.legacyVaults) deployed.legacyVaults = [];
  if (!deployed.legacyVaults.includes(oldVault)) {
    deployed.legacyVaults.push(oldVault);
  }
  // Also keep single-field backward compat
  deployed.legacyMessageVault = deployed.legacyVaults[deployed.legacyVaults.length - 1];
  deployed.messageVault = vaultAddress;
  fs.writeFileSync(outPath, JSON.stringify(deployed, null, 2));
  console.log(`deployed.json updated — ${deployed.legacyVaults.length} legacy vault(s)`);
}

main().catch(console.error);
