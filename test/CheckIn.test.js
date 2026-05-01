const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("CheckIn — Heartbeat Contract", function () {
  let checkIn;
  let owner, user1, user2;

  beforeEach(async () => {
    [owner, user1, user2] = await ethers.getSigners();
    const CheckIn = await ethers.getContractFactory("CheckIn");
    checkIn = await CheckIn.deploy();
  });

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
      await checkIn.connect(user1).checkIn();
      await time.increase(13 * 60 * 60); // 13 hours later
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

    it("should prevent check-in within 12 hour window", async () => {
      await checkIn.connect(user1).checkIn();
      await expect(checkIn.connect(user1).checkIn())
        .to.be.revertedWith("Already checked in recently. Come back later.");
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
  });

  describe("Silence duration", () => {
    it("should track silence duration correctly", async () => {
      await checkIn.connect(user1).checkIn();
      await time.increase(5 * 24 * 60 * 60); // 5 days
      const silence = await checkIn.silenceDuration(user1.address);
      expect(silence).to.be.closeTo(5 * 24 * 60 * 60, 5);
    });
  });
});
