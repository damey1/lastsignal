const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("CheckIn — Heartbeat Contract", function () {
  let checkIn;
  let owner, user1, user2;
  const DAY = 24 * 60 * 60;

  beforeEach(async () => {
    [owner, user1, user2] = await ethers.getSigners();
    const CheckIn = await ethers.getContractFactory("CheckIn");
    checkIn = await CheckIn.deploy();
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

      await expect(checkIn.declareGhost(user1.address))
        .to.emit(checkIn, "GhostModeEntered");
    });

    it("should not emit ghost event before threshold", async () => {
      await checkIn.connect(user1).checkIn();
      await time.increase(10 * DAY);
      await expect(checkIn.declareGhost(user1.address))
        .to.be.revertedWithCustomError(checkIn, "NotGhostYet");
    });

    it("should return false when ghost event already declared", async () => {
      await checkIn.connect(user1).checkIn();
      await time.increase(31 * DAY);
      await expect(checkIn.declareGhost(user1.address))
        .to.emit(checkIn, "GhostModeEntered");
      await expect(checkIn.declareGhost(user1.address))
        .to.not.emit(checkIn, "GhostModeEntered");
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
  });
});
