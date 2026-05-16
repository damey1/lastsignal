const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("CheckInAdapter — Legacy vault compatibility", function () {
  let badges, oldCheckIn, newCheckIn, adapter;
  let owner, user1, user2, legacyVault;
  const DAY = 24 * 60 * 60;

  beforeEach(async () => {
    [owner, user1, user2, legacyVault] = await ethers.getSigners();

    const LastSignalBadges = await ethers.getContractFactory("LastSignalBadges");
    badges = await LastSignalBadges.deploy();

    const CheckIn = await ethers.getContractFactory("CheckIn");
    oldCheckIn = await CheckIn.deploy(await badges.getAddress(), ethers.ZeroAddress);
    newCheckIn = await CheckIn.deploy(await badges.getAddress(), await oldCheckIn.getAddress());

    await badges.setMinter(await oldCheckIn.getAddress(), true);
    await badges.setMinter(await newCheckIn.getAddress(), true);

    const CheckInAdapter = await ethers.getContractFactory("CheckInAdapter");
    adapter = await CheckInAdapter.deploy(
      await newCheckIn.getAddress(),
      await oldCheckIn.getAddress(),
      legacyVault.address
    );
  });

  it("returns a timestamp for the legacy vault validation probe", async () => {
    expect(await adapter.lastSeen(legacyVault.address)).to.equal(await adapter.validationTimestamp());
  });

  it("falls back to old CheckIn for unmigrated users", async () => {
    await oldCheckIn.connect(user1).checkIn();
    const oldSignal = await oldCheckIn.getSignal(user1.address);

    expect(await adapter.lastSeen(user1.address)).to.equal(oldSignal.lastCheckIn);
  });

  it("prefers new CheckIn after a user migrates and checks in again", async () => {
    await oldCheckIn.connect(user1).checkIn();
    await newCheckIn.connect(user1).migrateMySignal();

    await time.increase(DAY + 1);
    await newCheckIn.connect(user1).checkIn();
    const newSignal = await newCheckIn.getSignal(user1.address);

    expect(await adapter.lastSeen(user1.address)).to.equal(newSignal.lastCheckIn);
  });

  it("reverts when neither CheckIn knows the user", async () => {
    await expect(adapter.lastSeen(user2.address))
      .to.be.revertedWithCustomError(adapter, "UserNotFound");
  });
});
