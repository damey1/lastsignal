const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const badgesAddress = process.env.BADGES_ADDRESS;
  const checkInAddress = process.env.CHECKIN_ADDRESS;
  const vaultAddress = process.env.VAULT_ADDRESS;
  const schedulerNotificationsAddress = process.env.SCHEDULER_NOTIFICATIONS_ADDRESS;
  const previousCheckIn = process.env.PREVIOUS_CHECKIN_ADDRESS;

  if (!badgesAddress || !checkInAddress || !vaultAddress || !schedulerNotificationsAddress) {
    throw new Error("BADGES_ADDRESS, CHECKIN_ADDRESS, VAULT_ADDRESS, and SCHEDULER_NOTIFICATIONS_ADDRESS are required");
  }

  const LastSignalBadges = await ethers.getContractFactory("LastSignalBadges");
  const badges = LastSignalBadges.attach(badgesAddress);

  console.log("Authorizing badge minters...");
  if (!(await badges.minters(checkInAddress))) {
    await (await badges.setMinter(checkInAddress, true)).wait();
  }
  if (!(await badges.minters(vaultAddress))) {
    await (await badges.setMinter(vaultAddress, true)).wait();
  }

  console.log(`CheckIn minter: ${await badges.minters(checkInAddress)}`);
  console.log(`Vault minter:   ${await badges.minters(vaultAddress)}`);

  const SchedulerNotifications = await ethers.getContractFactory("SchedulerNotifications");
  const schedulerNotifications = SchedulerNotifications.attach(schedulerNotificationsAddress);
  await (await schedulerNotifications.setVault(vaultAddress)).wait();
  console.log(`Scheduler vault: ${vaultAddress}`);

  const deployedJson = {
    badges: badgesAddress,
    checkIn: checkInAddress,
    messageVault: vaultAddress,
    schedulerNotifications: schedulerNotificationsAddress,
    previousCheckIn: previousCheckIn || undefined,
    network: hre.network.name,
  };

  const outPath = path.join(__dirname, "..", "deployed.json");
  fs.writeFileSync(outPath, JSON.stringify(deployedJson, null, 2));
  console.log(`Wrote ${outPath}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Finalize deployment failed:", error);
    process.exit(1);
  });
