const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  LastSignal — your EchoLife onchain");
  console.log("  Deploying contracts to Ritual Chain...");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`  Deployer: ${deployer.address}`);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`  Balance:  ${ethers.formatEther(balance)} RITUAL`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  // ── Deploy CheckIn ──
  console.log("📡 Deploying CheckIn.sol (Heartbeat)...");
  const CheckIn = await ethers.getContractFactory("CheckIn");
  const checkIn = await CheckIn.deploy();
  await checkIn.waitForDeployment();
  const checkInAddress = await checkIn.getAddress();
  console.log(`✅ CheckIn deployed: ${checkInAddress}\n`);

  // ── Deploy MessageVault ──
  console.log("🔒 Deploying MessageVault.sol...");
  const MessageVault = await ethers.getContractFactory("MessageVault");
  const messageVault = await MessageVault.deploy(checkInAddress);
  await messageVault.waitForDeployment();
  const vaultAddress = await messageVault.getAddress();
  console.log(`✅ MessageVault deployed: ${vaultAddress}\n`);

  // ── Write deployed.json ──
  const { network } = hre;
  const fs = require("fs");
  const path = require("path");
  const deployedJson = {
    checkIn: checkInAddress,
    messageVault: vaultAddress,
    network: network.name,
  };
  const outPath = path.join(__dirname, "..", "deployed.json");
  fs.writeFileSync(outPath, JSON.stringify(deployedJson, null, 2));
  console.log(`📝 Wrote ${outPath}\n`);

  // ── Summary ──
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  ✅ DEPLOYMENT COMPLETE");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`  CheckIn:      ${checkInAddress}`);
  console.log(`  MessageVault: ${vaultAddress}`);
  console.log(`  Network:      ${network.name}`);
  console.log(`  Explorer:     https://explorer.ritualfoundation.org`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("\n📋 deployed.json written — frontend will pick up these addresses automatically.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("❌ Deployment failed:", error);
    process.exit(1);
  });
