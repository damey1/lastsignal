const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  const fs = require("fs");
  const path = require("path");
  const outPath = path.join(__dirname, "..", "deployed.json");
  const deployed = JSON.parse(fs.readFileSync(outPath, "utf8"));
  const RITUAL_SCHEDULER = "0x56e776BAE2DD60664b69Bd5F865F1180ffB7D58B";

  console.log("Deployer:", deployer.address);
  console.log("V2:", deployed.legacyMessageVault);
  console.log("V3:", deployed.messageVault);

  // Deploy new scheduler
  const Factory = await ethers.getContractFactory("SchedulerNotifications");
  const scheduler = await Factory.deploy(deployed.checkIn, RITUAL_SCHEDULER);
  await scheduler.waitForDeployment();
  const addr = await scheduler.getAddress();
  console.log("New scheduler:", addr);

  // Authorize V2 and V3
  await (await scheduler.authorizeVault(deployed.legacyMessageVault)).wait();
  console.log("V2 authorized");
  await (await scheduler.authorizeVault(deployed.messageVault)).wait();
  console.log("V3 authorized");

  // Point V3 to new scheduler
  const MessageVault = await ethers.getContractFactory("MessageVault");
  const vault = MessageVault.attach(deployed.messageVault);
  await (await vault.setSchedulerNotifications(addr)).wait();
  console.log("V3 pointed to new scheduler");

  // Fund
  const fundAmount = ethers.parseEther("0.01");
  await (await deployer.sendTransaction({ to: addr, value: fundAmount })).wait();
  console.log("Funded with 0.01 RITUAL");

  // Save
  deployed.previousSchedulerNotifications = deployed.schedulerNotifications;
  deployed.schedulerNotifications = addr;
  fs.writeFileSync(outPath, JSON.stringify(deployed, null, 2));
  console.log("deployed.json updated");
}

main().catch(console.error);
