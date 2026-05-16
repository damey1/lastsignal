const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const badgesAddress = process.env.BADGES_ADDRESS;
  const checkInAddress = process.env.CHECKIN_ADDRESS;
  const vaultAddress = process.env.VAULT_ADDRESS;
  const previousCheckIn = process.env.PREVIOUS_CHECKIN_ADDRESS;

  if (!badgesAddress || !checkInAddress || !vaultAddress) {
    throw new Error("BADGES_ADDRESS, CHECKIN_ADDRESS, and VAULT_ADDRESS are required");
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

  const deployedJson = {
    badges: badgesAddress,
    checkIn: checkInAddress,
    messageVault: vaultAddress,
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
