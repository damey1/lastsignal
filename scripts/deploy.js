const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  const { network } = hre;
  const fs = require("fs");
  const path = require("path");
  const outPath = path.join(__dirname, "..", "deployed.json");

  let existingDeployed = {};
  try {
    existingDeployed = JSON.parse(fs.readFileSync(outPath, "utf8"));
  } catch (_) {
    existingDeployed = {};
  }

  const previousCheckInAddress =
    process.env.PREVIOUS_CHECKIN_ADDRESS ||
    existingDeployed.checkIn ||
    existingDeployed.previousCheckIn ||
    ethers.ZeroAddress;

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  LastSignal — your EchoLife onchain");
  console.log("  Deploying contracts to Ritual Chain...");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`  Deployer: ${deployer.address}`);
  if (previousCheckInAddress !== ethers.ZeroAddress) {
    console.log(`  Previous CheckIn for migration: ${previousCheckInAddress}`);
  }

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`  Balance:  ${ethers.formatEther(balance)} RITUAL`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  // ── Deploy LastSignalBadges ──
  console.log("🏅 Deploying LastSignalBadges.sol...");
  const LastSignalBadges = await ethers.getContractFactory("LastSignalBadges");
  const badges = await LastSignalBadges.deploy();
  await badges.waitForDeployment();
  const badgesAddress = await badges.getAddress();
  console.log(`✅ LastSignalBadges deployed: ${badgesAddress}\n`);

  // ── Deploy CheckIn ──
  console.log("📡 Deploying CheckIn.sol (Heartbeat)...");
  const CheckIn = await ethers.getContractFactory("CheckIn");
  const checkIn = await CheckIn.deploy(badgesAddress, previousCheckInAddress);
  await checkIn.waitForDeployment();
  const checkInAddress = await checkIn.getAddress();
  console.log(`✅ CheckIn deployed: ${checkInAddress}\n`);

  // ── Deploy SchedulerNotifications ──
  console.log("⏰ Deploying SchedulerNotifications.sol...");
  const RITUAL_SCHEDULER = "0x56e776BAE2DD60664b69Bd5F865F1180ffB7D58B";
  const SchedulerNotifications = await ethers.getContractFactory("SchedulerNotifications");
  const scheduler = await SchedulerNotifications.deploy(checkInAddress, RITUAL_SCHEDULER);
  await scheduler.waitForDeployment();
  const schedulerAddress = await scheduler.getAddress();
  console.log(`✅ SchedulerNotifications deployed: ${schedulerAddress}\n`);

  // ── Deploy MessageVault ──
  console.log("🔒 Deploying MessageVault.sol...");
  const MessageVault = await ethers.getContractFactory("MessageVault");
  const messageVault = await MessageVault.deploy(checkInAddress, badgesAddress, schedulerAddress);
  await messageVault.waitForDeployment();
  const vaultAddress = await messageVault.getAddress();
  console.log(`✅ MessageVault deployed: ${vaultAddress}\n`);

  // ── Authorize protocol contracts ──
  console.log("🔑 Authorizing protocol contracts...");
  await (await badges.setMinter(checkInAddress, true)).wait();
  await (await badges.setMinter(vaultAddress, true)).wait();
  await (await scheduler.setVault(vaultAddress)).wait();
  console.log("✅ Protocol contracts authorized\n");

  // ── Fund RitualWallet for scheduler fees ──
  // The scheduler contract is the payer, so we send ETH to the contract
  // and have it call deposit() on the RitualWallet.
  console.log("💰 Funding RitualWallet for scheduler fees...");
  const depositAmount = ethers.parseEther("0.01");
  const lockDuration = 1_000_000; // blocks (~4 days at 350ms/block)
  try {
    const fundTx = await deployer.sendTransaction({
      to: schedulerAddress,
      value: depositAmount,
    });
    await fundTx.wait();
    console.log(`  Sent ${ethers.formatEther(depositAmount)} RITUAL to scheduler contract`);

    const depositTx = await scheduler.fundRitualWallet(lockDuration);
    await depositTx.wait();
    console.log(`✅ RitualWallet funded: ${ethers.formatEther(depositAmount)} RITUAL (locked ${lockDuration} blocks)\n`);
  } catch (err) {
    console.warn(`⚠️ RitualWallet funding skipped: ${err.message}\n`);
  }

  // ── Authorize scheduler contract with CheckIn ──
  console.log("🔑 Transferring scheduler ownership to deployer...");
  // Already owned by deployer from constructor
  console.log("✅ SchedulerNotifications ready\n");

  // ── Write deployed.json ──
  // Merge into existing so legacy fields (legacyMessageVault, checkInAdapter, etc.)
  // survive future deployments — never build from scratch.
  const deployedJson = { ...existingDeployed };
  deployedJson.badges = badgesAddress;
  deployedJson.checkIn = checkInAddress;
  deployedJson.messageVault = vaultAddress;
  deployedJson.schedulerNotifications = schedulerAddress;
  if (previousCheckInAddress !== ethers.ZeroAddress) {
    deployedJson.previousCheckIn = previousCheckInAddress;
  }
  deployedJson.network = network.name;
  fs.writeFileSync(outPath, JSON.stringify(deployedJson, null, 2));
  console.log(`📝 Wrote ${outPath}\n`);

  // ── Summary ──
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  ✅ DEPLOYMENT COMPLETE");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`  Badges:       ${badgesAddress}`);
  console.log(`  CheckIn:      ${checkInAddress}`);
  console.log(`  MessageVault: ${vaultAddress}`);
  console.log(`  Scheduler:    ${schedulerAddress}`);
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
