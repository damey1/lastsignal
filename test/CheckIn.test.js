const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("CheckIn — Heartbeat Contract", function () {
  let checkIn, badges;
  let owner, user1, user2;
  const DAY = 24 * 60 * 60;

  beforeEach(async () => {
    [owner, user1, user2] = await ethers.getSigners();
    const LastSignalBadges = await ethers.getContractFactory("LastSignalBadges");
    badges = await LastSignalBadges.deploy();

    const CheckIn = await ethers.getContractFactory("CheckIn");
    checkIn = await CheckIn.deploy(await badges.getAddress(), ethers.ZeroAddress);
    await badges.setMinter(await checkIn.getAddress(), true);
  });

  async function futureDay(offset = 1) {
    const latest = await time.latest();
    return (Math.floor(latest / DAY) + offset) * DAY;
  }

  async function buildDailyStreak(user, days) {
    const day = await futureDay();
    for (let i = 0; i < days; i++) {
      await time.setNextBlockTimestamp(day + i * DAY + 12 * 60 * 60);
      await checkIn.connect(user).checkIn();
    }
  }

  describe("First check-in", () => {
    it("should register a new user on first check-in", async () => {
      await checkIn.connect(user1).checkIn();
      const signal = await checkIn.getSignal(user1.address);
      expect(signal.exists).to.be.true;
      expect(signal.totalCheckIns).to.equal(1);
      expect(signal.currentStreak).to.equal(1);
      expect(signal.longestStreak).to.equal(1);
    });

    it("should emit HeartBeat event", async () => {
      const tx = await checkIn.connect(user1).checkIn();
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);

      await expect(tx)
        .to.emit(checkIn, "HeartBeat")
        .withArgs(user1.address, block.timestamp, 1, 1);
    });

    it("should track total users", async () => {
      await checkIn.connect(user1).checkIn();
      await checkIn.connect(user2).checkIn();
      expect(await checkIn.totalUsers()).to.equal(2);
    });
  });

  describe("Streak tracking", () => {
    it("should build streak on consecutive check-ins", async () => {
      const day = await futureDay();
      await time.setNextBlockTimestamp(day + 10 * 60 * 60);
      await checkIn.connect(user1).checkIn();
      await time.setNextBlockTimestamp(day + DAY + 11 * 60 * 60); // 25h gap
      await checkIn.connect(user1).checkIn();
      const signal = await checkIn.getSignal(user1.address);
      expect(signal.currentStreak).to.equal(2);
      expect(signal.longestStreak).to.equal(2);
    });

    it("should break streak after 48 hours", async () => {
      await checkIn.connect(user1).checkIn();
      await time.increase(49 * 60 * 60); // 49 hours later
      await checkIn.connect(user1).checkIn();
      const signal = await checkIn.getSignal(user1.address);
      expect(signal.currentStreak).to.equal(1); // reset to 1
    });

    it("should prevent more than one check-in within 24 hours", async () => {
      await checkIn.connect(user1).checkIn();
      await time.increase(12 * 60 * 60); // 12 hours later
      await expect(checkIn.connect(user1).checkIn())
        .to.be.revertedWithCustomError(checkIn, "AlreadyCheckedIn");
    });

    it("should allow the next check-in after 24 hours", async () => {
      await checkIn.connect(user1).checkIn();

      await time.increase(24 * 60 * 60 + 1); // 24h + 1 second
      expect(await checkIn.canCheckIn(user1.address)).to.equal(true);

      await checkIn.connect(user1).checkIn();
      const signal = await checkIn.getSignal(user1.address);
      expect(signal.totalCheckIns).to.equal(2);
    });

    it("should expose next eligible check-in time", async () => {
      await checkIn.connect(user1).checkIn();
      const signal = await checkIn.getSignal(user1.address);
      expect(await checkIn.nextCheckInTime(user1.address))
        .to.equal(signal.lastCheckIn + BigInt(DAY));
    });
  });

  describe("Ghost mode", () => {
    it("should detect ghost mode after threshold", async () => {
      await checkIn.connect(user1).checkIn();
      await time.increase(31 * 24 * 60 * 60); // 31 days
      expect(await checkIn.isGhost(user1.address, 0)).to.be.true;
    });

    it("should not be ghost if recently active", async () => {
      await checkIn.connect(user1).checkIn();
      expect(await checkIn.isGhost(user1.address, 0)).to.be.false;
    });

    it("should emit GhostModeEntered once after threshold", async () => {
      await checkIn.connect(user1).checkIn();
      await time.increase(31 * DAY);

      await expect(checkIn.connect(user2).declareGhost(user1.address))
        .to.emit(checkIn, "GhostModeEntered");
    });

    it("should not emit ghost event before threshold", async () => {
      await checkIn.connect(user1).checkIn();
      await time.increase(10 * DAY);
      await expect(checkIn.connect(user2).declareGhost(user1.address))
        .to.be.revertedWithCustomError(checkIn, "NotGhostYet");
    });

    it("should return false when ghost event already declared", async () => {
      await checkIn.connect(user1).checkIn();
      await time.increase(31 * DAY);
      await expect(checkIn.connect(user2).declareGhost(user1.address))
        .to.emit(checkIn, "GhostModeEntered");
      await expect(checkIn.connect(owner).declareGhost(user1.address))
        .to.not.emit(checkIn, "GhostModeEntered");
    });

    it("should reject self-declared ghost calls", async () => {
      await checkIn.connect(user1).checkIn();
      await time.increase(31 * DAY);

      await expect(checkIn.connect(user1).declareGhost(user1.address))
        .to.be.revertedWithCustomError(checkIn, "CannotDeclareSelf");
    });

    it("should award points and Ghost Caller badge to the first accurate caller", async () => {
      await checkIn.connect(user1).checkIn();
      await time.increase(31 * DAY);

      await expect(checkIn.connect(user2).declareGhost(user1.address))
        .to.emit(checkIn, "GhostCalled")
        .withArgs(user2.address, user1.address, 25, 25, 1);

      expect(await checkIn.signalPoints(user2.address)).to.equal(25);
      expect(await checkIn.ghostsCalled(user2.address)).to.equal(1);
      expect(await badges.hasBadge(user2.address, 9)).to.equal(true);

      await checkIn.connect(owner).declareGhost(user1.address);
      expect(await checkIn.signalPoints(owner.address)).to.equal(0);
      expect(await checkIn.signalPoints(user2.address)).to.equal(25);
      expect(await checkIn.ghostsCalled(user2.address)).to.equal(1);
    });

    it("should let callers earn points for multiple correct ghost declarations", async () => {
      await checkIn.connect(user1).checkIn();
      await checkIn.connect(owner).checkIn();
      await time.increase(31 * DAY);

      await checkIn.connect(user2).declareGhost(user1.address);
      await checkIn.connect(user2).declareGhost(owner.address);

      expect(await checkIn.signalPoints(user2.address)).to.equal(50);
      expect(await checkIn.ghostsCalled(user2.address)).to.equal(2);
      expect(await badges.hasBadge(user2.address, 9)).to.equal(true);
      expect(await badges.balanceOf(user2.address)).to.equal(1);
    });

    it("should award Back From The Dead once when a declared ghost checks in again", async () => {
      await checkIn.connect(user1).checkIn();
      await time.increase(31 * DAY);
      await checkIn.connect(user2).declareGhost(user1.address);

      await expect(checkIn.connect(user1).checkIn())
        .to.emit(checkIn, "BackFromTheDead");

      expect(await badges.hasBadge(user1.address, 10)).to.equal(true);
      expect(await badges.balanceOf(user1.address)).to.equal(3); // First Signal + Comeback + Back From The Dead

      await time.increase(31 * DAY);
      await checkIn.connect(user2).declareGhost(user1.address);
      await checkIn.connect(user1).checkIn();

      expect(await badges.balanceOf(user1.address)).to.equal(3);
    });
  });

  describe("Silence duration", () => {
    it("should track silence duration correctly", async () => {
      await checkIn.connect(user1).checkIn();
      await time.increase(5 * 24 * 60 * 60); // 5 days
      const silence = await checkIn.silenceDuration(user1.address);
      expect(silence).to.be.closeTo(5 * 24 * 60 * 60, 5);
    });
  });

  describe("Signal gamification", () => {
    it("should return empty defaults for users without a heartbeat", async () => {
      expect(await checkIn.signalLevel(user1.address)).to.equal(0);
      expect(await checkIn.ghostRisk(user1.address)).to.equal(0);
      expect(await checkIn.signalScore(user1.address)).to.equal(0);
    });

    it("should classify new, stable, strong, and legendary streak tiers", async () => {
      await checkIn.connect(user1).checkIn();
      expect(await checkIn.signalLevel(user1.address)).to.equal(1);

      await buildDailyStreak(user2, 7);
      expect(await checkIn.signalLevel(user2.address)).to.equal(2);

      await buildDailyStreak(owner, 14);
      expect(await checkIn.signalLevel(owner.address)).to.equal(3);

      const [, , , user3] = await ethers.getSigners();
      await buildDailyStreak(user3, 30);
      expect(await checkIn.signalLevel(user3.address)).to.equal(4);
    });

    it("should report active, watch, and ghost risk levels", async () => {
      await checkIn.connect(user1).checkIn();
      expect(await checkIn.ghostRisk(user1.address)).to.equal(1);

      await time.increase(3 * DAY);
      expect(await checkIn.ghostRisk(user1.address)).to.equal(2);

      await time.increase(28 * DAY);
      expect(await checkIn.ghostRisk(user1.address)).to.equal(3);
    });

    it("should calculate signal score and cap stale signals", async () => {
      await buildDailyStreak(user1, 7);
      const activeScore = await checkIn.signalScore(user1.address);
      expect(activeScore).to.be.greaterThan(20);

      await time.increase(3 * DAY);
      expect(await checkIn.signalScore(user1.address)).to.be.at.most(60);

      await time.increase(28 * DAY);
      expect(await checkIn.signalScore(user1.address)).to.equal(0);
    });

    it("should mint heartbeat milestone badges once", async () => {
      await buildDailyStreak(user1, 7);

      expect(await badges.hasBadge(user1.address, 1)).to.equal(true);
      expect(await badges.hasBadge(user1.address, 2)).to.equal(true);
      expect(await badges.hasBadge(user1.address, 3)).to.equal(true);
      expect(await badges.balanceOf(user1.address)).to.equal(3);

      await time.increase(DAY + 1);
      await checkIn.connect(user1).checkIn();
      expect(await badges.balanceOf(user1.address)).to.equal(3);
    });

    it("should mint comeback badge after a broken streak check-in", async () => {
      await checkIn.connect(user1).checkIn();
      await time.increase(49 * 60 * 60);
      await checkIn.connect(user1).checkIn();

      expect(await badges.hasBadge(user1.address, 6)).to.equal(true);
    });
  });

  describe("Signal migration", () => {
    it("should migrate an existing signal and award earned milestone badges", async () => {
      await buildDailyStreak(user1, 7);
      const oldSignal = await checkIn.getSignal(user1.address);

      const CheckIn = await ethers.getContractFactory("CheckIn");
      const migratedCheckIn = await CheckIn.deploy(await badges.getAddress(), await checkIn.getAddress());
      await badges.setMinter(await migratedCheckIn.getAddress(), true);

      await expect(migratedCheckIn.connect(user1).migrateMySignal())
        .to.emit(migratedCheckIn, "SignalMigrated");

      const migratedSignal = await migratedCheckIn.getSignal(user1.address);
      expect(migratedSignal.lastCheckIn).to.equal(oldSignal.lastCheckIn);
      expect(migratedSignal.totalCheckIns).to.equal(oldSignal.totalCheckIns);
      expect(migratedSignal.currentStreak).to.equal(oldSignal.currentStreak);
      expect(migratedSignal.longestStreak).to.equal(oldSignal.longestStreak);
      expect(migratedSignal.joinedAt).to.equal(oldSignal.joinedAt);
      expect(await migratedCheckIn.totalUsers()).to.equal(1);
      expect(await badges.hasBadge(user1.address, 1)).to.equal(true);
      expect(await badges.hasBadge(user1.address, 2)).to.equal(true);
      expect(await badges.hasBadge(user1.address, 3)).to.equal(true);
    });

    it("should keep the next check-in window after migration", async () => {
      await checkIn.connect(user1).checkIn();

      const CheckIn = await ethers.getContractFactory("CheckIn");
      const migratedCheckIn = await CheckIn.deploy(await badges.getAddress(), await checkIn.getAddress());
      await badges.setMinter(await migratedCheckIn.getAddress(), true);

      await migratedCheckIn.connect(user1).migrateMySignal();
      await expect(migratedCheckIn.connect(user1).checkIn())
        .to.be.revertedWithCustomError(migratedCheckIn, "AlreadyCheckedIn");

      await time.increase(DAY + 1);
      await migratedCheckIn.connect(user1).checkIn();
      const migratedSignal = await migratedCheckIn.getSignal(user1.address);
      expect(migratedSignal.totalCheckIns).to.equal(2);
      expect(migratedSignal.currentStreak).to.equal(2);
    });

    it("should reject unavailable, duplicate, and missing-user migrations", async () => {
      await expect(checkIn.connect(user1).migrateMySignal())
        .to.be.revertedWithCustomError(checkIn, "MigrationUnavailable");

      await checkIn.connect(user1).checkIn();

      const CheckIn = await ethers.getContractFactory("CheckIn");
      const migratedCheckIn = await CheckIn.deploy(await badges.getAddress(), await checkIn.getAddress());
      await badges.setMinter(await migratedCheckIn.getAddress(), true);

      await expect(migratedCheckIn.connect(user2).migrateMySignal())
        .to.be.revertedWithCustomError(migratedCheckIn, "UserNotFound");

      await migratedCheckIn.connect(user1).migrateMySignal();
      await expect(migratedCheckIn.connect(user1).migrateMySignal())
        .to.be.revertedWithCustomError(migratedCheckIn, "AlreadyMigrated");
    });
  });
});
