const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("LastSignalBadges — Soulbound badges", function () {
  let badges;
  let owner, minter, user, other;

  beforeEach(async () => {
    [owner, minter, user, other] = await ethers.getSigners();

    const LastSignalBadges = await ethers.getContractFactory("LastSignalBadges");
    badges = await LastSignalBadges.deploy();
  });

  it("allows authorized minters to award a badge", async () => {
    await badges.setMinter(minter.address, true);

    await expect(badges.connect(minter).mintBadge(user.address, 1))
      .to.emit(badges, "Transfer")
      .withArgs(ethers.ZeroAddress, user.address, 1);

    expect(await badges.ownerOf(1)).to.equal(user.address);
    expect(await badges.balanceOf(user.address)).to.equal(1);
    expect(await badges.badgeTypeOf(1)).to.equal(1);
    expect(await badges.hasBadge(user.address, 1)).to.equal(true);
    expect(await badges.tokenOf(user.address, 1)).to.equal(1);
  });

  it("rejects unauthorized minting and invalid badge types", async () => {
    await expect(badges.connect(other).mintBadge(user.address, 1))
      .to.be.revertedWithCustomError(badges, "NotMinter");

    await expect(badges.mintBadge(user.address, 0))
      .to.be.revertedWithCustomError(badges, "InvalidBadgeType");

    await expect(badges.mintBadge(user.address, 11))
      .to.be.revertedWithCustomError(badges, "InvalidBadgeType");
  });

  it("does not mint duplicate badge types for one user", async () => {
    await badges.mintBadge(user.address, 1);
    await badges.mintBadge(user.address, 1);

    expect(await badges.totalSupply()).to.equal(1);
    expect(await badges.balanceOf(user.address)).to.equal(1);
    expect(await badges.tokenOf(user.address, 1)).to.equal(1);
  });

  it("blocks transfers and approvals", async () => {
    await badges.mintBadge(user.address, 1);

    await expect(badges.connect(user).approve(other.address, 1))
      .to.be.revertedWithCustomError(badges, "NonTransferable");

    await expect(badges.connect(user).setApprovalForAll(other.address, true))
      .to.be.revertedWithCustomError(badges, "NonTransferable");

    await expect(badges.connect(user).transferFrom(user.address, other.address, 1))
      .to.be.revertedWithCustomError(badges, "NonTransferable");

    await expect(badges.connect(user)["safeTransferFrom(address,address,uint256)"](user.address, other.address, 1))
      .to.be.revertedWithCustomError(badges, "NonTransferable");
  });

  it("returns deterministic token URIs for minted badges", async () => {
    await badges.mintBadge(user.address, 7);

    expect(await badges.tokenURI(1)).to.equal("lastsignal://badge/7/1");
    await expect(badges.tokenURI(2)).to.be.revertedWithCustomError(badges, "TokenNotFound");
  });
});
