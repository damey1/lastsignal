const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const badgesAddress = process.env.BADGES_ADDRESS;
  const checkInAddress = process.env.CHECKIN_ADDRESS;
  const previousCheckIn = process.env.PREVIOUS_CHECKIN_ADDRESS;

  if (!badgesAddress || !checkInAddress) {
    throw new Error("BADGES_ADDRESS and CHECKIN_ADDRESS are required");
  }

  const [deployer] = await ethers.getSigners();
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Latest nonce: ${await ethers.provider.getTransactionCount(deployer.address, "latest")}`);
  console.log(`Pending nonce: ${await ethers.provider.getTransactionCount(deployer.address, "pending")}`);

  const badgesCode = await ethers.provider.getCode(badgesAddress);
  const checkInCode = await ethers.provider.getCode(checkInAddress);
  if (badgesCode === "0x") throw new Error("BADGES_ADDRESS has no contract code");
  if (checkInCode === "0x") throw new Error("CHECKIN_ADDRESS has no contract code");

  const LastSignalBadges = await ethers.getContractFactory("LastSignalBadges");
  const badges = LastSignalBadges.attach(badgesAddress);

  const MessageVault = await ethers.getContractFactory("MessageVault");
  console.log("Deploying MessageVault...");
  const messageVault = await MessageVault.deploy(checkInAddress, badgesAddress);
  await messageVault.waitForDeployment();
  const vaultAddress = await messageVault.getAddress();
  console.log(`MessageVault deployed: ${vaultAddress}`);

  console.log("Authorizing badge minters...");
  if (!(await badges.minters(checkInAddress))) {
    await (await badges.setMinter(checkInAddress, true)).wait();
  }
  await (await badges.setMinter(vaultAddress, true)).wait();
  console.log("Badge minters authorized");

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
    console.error("Resume deployment failed:", error);
    process.exit(1);
  });
