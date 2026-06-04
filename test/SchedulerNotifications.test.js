const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("SchedulerNotifications", function () {
  let badges, checkIn, mockScheduler, schedulerNotifications, vault;
  let owner, recipient, other;

  const DAY = 24 * 60 * 60;
  const SEVEN_DAYS = 7 * DAY;

  beforeEach(async () => {
    [owner, recipient, other] = await ethers.getSigners();

    const LastSignalBadges = await ethers.getContractFactory("LastSignalBadges");
    badges = await LastSignalBadges.deploy();

    const CheckIn = await ethers.getContractFactory("CheckIn");
    checkIn = await CheckIn.deploy(await badges.getAddress(), ethers.ZeroAddress);
    await badges.setMinter(await checkIn.getAddress(), true);

    const MockScheduler = await ethers.getContractFactory("MockScheduler");
    mockScheduler = await MockScheduler.deploy();

    const SchedulerNotifications = await ethers.getContractFactory("SchedulerNotifications");
    schedulerNotifications = await SchedulerNotifications.deploy(
      await checkIn.getAddress(),
      await mockScheduler.getAddress()
    );

    const MessageVault = await ethers.getContractFactory("MessageVault");
    vault = await MessageVault.deploy(
      await checkIn.getAddress(),
      await badges.getAddress(),
      await schedulerNotifications.getAddress()
    );

    await schedulerNotifications.setVault(await vault.getAddress());
    await badges.setMinter(await vault.getAddress(), true);
  });

  async function sealMessage(unlockAfter = SEVEN_DAYS) {
    await checkIn.connect(owner).checkIn();
    const tx = await vault
      .connect(owner)
      .sealMessage(recipient.address, "encrypted://message", unlockAfter);
    const receipt = await tx.wait();
    const vaultAddr = (await vault.getAddress()).toLowerCase();

    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== vaultAddr) continue;
      const parsed = vault.interface.parseLog(log);
      if (parsed?.name === "MessageSealed") return parsed.args.messageId;
    }

    throw new Error("MessageSealed event not found");
  }

  async function scheduleFor(messageId) {
    const item = await schedulerNotifications.messageSchedules(messageId);
    return {
      owner: item.owner,
      recipient: item.recipient,
      baseLastSeen: item.baseLastSeen,
      inactivityUnlock: item.inactivityUnlock,
      generation: item.generation,
      warningCallId: item.warningCallId,
      unlockCallId: item.unlockCallId,
      active: item.active,
      completed: item.completed,
    };
  }

  it("arms per-message warning and unlock schedules during seal", async () => {
    const messageId = await sealMessage();
    const item = await scheduleFor(messageId);

    expect(item.owner).to.equal(owner.address);
    expect(item.recipient).to.equal(recipient.address);
    expect(item.inactivityUnlock).to.equal(SEVEN_DAYS);
    expect(item.generation).to.equal(1);
    expect(item.active).to.equal(true);
    expect(item.warningCallId).to.equal(1);
    expect(item.unlockCallId).to.equal(2);

    const warningCall = await mockScheduler.scheduled(item.warningCallId);
    const unlockCall = await mockScheduler.scheduled(item.unlockCallId);

    expect(warningCall.caller).to.equal(await schedulerNotifications.getAddress());
    expect(warningCall.payer).to.equal(await schedulerNotifications.getAddress());
    expect(unlockCall.caller).to.equal(await schedulerNotifications.getAddress());
    expect(unlockCall.payer).to.equal(await schedulerNotifications.getAddress());
    expect(warningCall.startBlock).to.be.lessThan(unlockCall.startBlock);
  });

  it("rejects direct scheduler arming from non-vault callers", async () => {
    await expect(
      schedulerNotifications
        .connect(other)
        .armMessage(ethers.id("message"), owner.address, recipient.address, SEVEN_DAYS)
    ).to.be.revertedWithCustomError(schedulerNotifications, "NotVault");
  });

  it("emits a warning when the owner has not checked in during 80 percent of the lock window", async () => {
    const messageId = await sealMessage();
    const { warningCallId } = await scheduleFor(messageId);
    const lastSeen = await checkIn.lastSeen(owner.address);

    await time.increase((SEVEN_DAYS * 8) / 10);

    await expect(mockScheduler.execute(warningCallId))
      .to.emit(schedulerNotifications, "MessageLockWarning")
      .withArgs(messageId, owner.address, recipient.address, lastSeen + BigInt(SEVEN_DAYS));
  });

  it("silently re-arms from the latest heartbeat at warning time", async () => {
    const messageId = await sealMessage();
    const original = await scheduleFor(messageId);

    await time.increase(25 * 60 * 60);
    await checkIn.connect(owner).checkIn();
    await time.increase((SEVEN_DAYS * 8) / 10);

    await expect(mockScheduler.execute(original.warningCallId))
      .to.not.emit(schedulerNotifications, "MessageLockWarning");

    const updated = await scheduleFor(messageId);
    expect(updated.generation).to.equal(original.generation + 1n);
    expect(updated.baseLastSeen).to.be.greaterThan(original.baseLastSeen);
    expect(updated.warningCallId).to.equal(3);
    expect(updated.unlockCallId).to.equal(4);
  });

  it("emits unlockable without marking vault content readable", async () => {
    const messageId = await sealMessage();
    const { unlockCallId } = await scheduleFor(messageId);

    await time.increase(SEVEN_DAYS + 1);

    await expect(mockScheduler.execute(unlockCallId))
      .to.emit(schedulerNotifications, "MessageUnlockable")
      .withArgs(messageId, owner.address, recipient.address, (silence) => silence >= SEVEN_DAYS);

    await expect(vault.connect(recipient).readMessage(messageId))
      .to.be.revertedWithCustomError(vault, "StillLocked");

    await vault.connect(recipient).claimMessage(messageId);
    expect(await vault.connect(recipient).readMessage(messageId)).to.equal("encrypted://message");
  });

  it("re-arms from the latest heartbeat at unlock time instead of emitting unlockable", async () => {
    const messageId = await sealMessage();
    const original = await scheduleFor(messageId);

    await time.increase(25 * 60 * 60);
    await checkIn.connect(owner).checkIn();
    await time.increase(SEVEN_DAYS + 1);

    await expect(mockScheduler.execute(original.unlockCallId))
      .to.not.emit(schedulerNotifications, "MessageUnlockable");

    const updated = await scheduleFor(messageId);
    expect(updated.generation).to.equal(original.generation + 1n);
    expect(updated.active).to.equal(true);
  });

  it("skips stale generation callbacks", async () => {
    const messageId = await sealMessage();
    const original = await scheduleFor(messageId);

    await time.increase(25 * 60 * 60);
    await checkIn.connect(owner).checkIn();
    await mockScheduler.execute(original.warningCallId);

    await expect(mockScheduler.execute(original.unlockCallId))
      .to.emit(schedulerNotifications, "ScheduleSkipped")
      .withArgs(messageId, "stale or inactive");
  });

  it("finalizes schedules when the message is canceled", async () => {
    const messageId = await sealMessage();
    await vault.connect(owner).cancelMessage(messageId);

    const item = await scheduleFor(messageId);
    expect(item.active).to.equal(false);
    expect(item.completed).to.equal(true);
  });

  it("refreshes schedules when the unlock delay is updated", async () => {
    const messageId = await sealMessage();
    const original = await scheduleFor(messageId);

    await vault.connect(owner).updateInactivityUnlock(messageId, 14 * DAY);

    const updated = await scheduleFor(messageId);
    expect(updated.generation).to.equal(original.generation + 1n);
    expect(updated.inactivityUnlock).to.equal(14 * DAY);
  });
});
