const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const SEVEN_DAYS = 7 * 24 * 60 * 60;

describe("MessageVault — Heartbeat-gated vault", function () {
  let checkIn, vault;
  let owner, recipient, other;

  beforeEach(async () => {
    [owner, recipient, other] = await ethers.getSigners();

    const CheckIn = await ethers.getContractFactory("CheckIn");
    checkIn = await CheckIn.deploy();

    const MessageVault = await ethers.getContractFactory("MessageVault");
    vault = await MessageVault.deploy(await checkIn.getAddress());
  });

  async function sealMessage(
    signer = owner,
    to = recipient,
    content = "encrypted://message",
    unlockAfter = SEVEN_DAYS
  ) {
    const tx = await vault
      .connect(signer)
      .sealMessage(to.address, content, unlockAfter);
    const receipt = await tx.wait();

    for (const log of receipt.logs) {
      const parsed = vault.interface.parseLog(log);
      if (parsed && parsed.name === "MessageSealed") {
        return parsed.args.messageId;
      }
    }

    throw new Error("MessageSealed event not found");
  }

  async function blockTimestamp(tx) {
    const receipt = await tx.wait();
    const block = await ethers.provider.getBlock(receipt.blockNumber);
    return block.timestamp;
  }

  it("requires the owner to establish a heartbeat before sealing", async () => {
    await expect(
      vault
        .connect(owner)
        .sealMessage(recipient.address, "encrypted://message", SEVEN_DAYS)
    ).to.be.revertedWithCustomError(vault, "HeartbeatNotFound");
  });

  it("keeps a message locked while the owner heartbeat is still fresh", async () => {
    await checkIn.connect(owner).checkIn();
    const messageId = await sealMessage();

    await time.increase(SEVEN_DAYS - 60);

    expect(await vault.isUnlockable(messageId)).to.equal(false);
    await expect(vault.connect(recipient).claimMessage(messageId))
      .to.be.revertedWithCustomError(vault, "StillLocked");
  });

  it("resets unlock timing from the owner's latest CheckIn heartbeat", async () => {
    await checkIn.connect(owner).checkIn();
    const messageId = await sealMessage();

    await time.increase(13 * 60 * 60);
    await checkIn.connect(owner).checkIn();

    await time.increase(SEVEN_DAYS - 60);

    expect(await vault.isUnlockable(messageId)).to.equal(false);
    await expect(vault.connect(recipient).claimMessage(messageId))
      .to.be.revertedWithCustomError(vault, "StillLocked");
  });

  it("allows the recipient to claim and read after heartbeat inactivity passes", async () => {
    await checkIn.connect(owner).checkIn();
    const messageId = await sealMessage();

    await time.increase(SEVEN_DAYS + 1);

    const tx = await vault.connect(recipient).claimMessage(messageId);

    await expect(tx)
      .to.emit(vault, "MessageUnlocked")
      .withArgs(messageId, recipient.address, await blockTimestamp(tx));

    expect(await vault.connect(recipient).readMessage(messageId))
      .to.equal("encrypted://message");
  });

  it("allows only the owner to cancel a locked message", async () => {
    await checkIn.connect(owner).checkIn();
    const messageId = await sealMessage();

    await expect(vault.connect(other).cancelMessage(messageId))
      .to.be.revertedWithCustomError(vault, "NotOwner");

    const tx = await vault.connect(owner).cancelMessage(messageId);

    await expect(tx)
      .to.emit(vault, "MessageCanceled")
      .withArgs(messageId, owner.address, await blockTimestamp(tx));

    expect(await vault.isUnlockable(messageId)).to.equal(false);
    await time.increase(SEVEN_DAYS + 1);
    await expect(vault.connect(recipient).claimMessage(messageId))
      .to.be.revertedWithCustomError(vault, "MessageIsCanceled");
  });

  it("allows the owner to read and rotate locked encrypted content", async () => {
    await checkIn.connect(owner).checkIn();
    const messageId = await sealMessage();

    expect(await vault.connect(owner).readOwnMessage(messageId))
      .to.equal("encrypted://message");
    await expect(vault.connect(other).readOwnMessage(messageId))
      .to.be.revertedWithCustomError(vault, "NotOwner");

    const tx = await vault
      .connect(owner)
      .updateMessageContent(messageId, "encrypted://rotated");

    await expect(tx)
      .to.emit(vault, "MessageContentUpdated")
      .withArgs(messageId, owner.address, await blockTimestamp(tx));

    expect(await vault.connect(owner).readOwnMessage(messageId))
      .to.equal("encrypted://rotated");

    await time.increase(SEVEN_DAYS + 1);
    await vault.connect(recipient).claimMessage(messageId);
    expect(await vault.connect(recipient).readMessage(messageId))
      .to.equal("encrypted://rotated");
  });

  it("allows only the owner to update the inactivity unlock while locked", async () => {
    await checkIn.connect(owner).checkIn();
    const messageId = await sealMessage();
    const newDelay = 14 * 24 * 60 * 60;

    await expect(vault.connect(other).updateInactivityUnlock(messageId, newDelay))
      .to.be.revertedWithCustomError(vault, "NotOwner");

    const tx = await vault
      .connect(owner)
      .updateInactivityUnlock(messageId, newDelay);

    await expect(tx)
      .to.emit(vault, "MessageUnlockDelayUpdated")
      .withArgs(messageId, owner.address, newDelay, await blockTimestamp(tx));

    await time.increase(SEVEN_DAYS + 1);
    expect(await vault.isUnlockable(messageId)).to.equal(false);

    await time.increase(SEVEN_DAYS);
    expect(await vault.isUnlockable(messageId)).to.equal(true);
  });

  it("blocks owner updates after a message is unlocked or canceled", async () => {
    await checkIn.connect(owner).checkIn();
    const canceledId = await sealMessage(owner, recipient, "encrypted://cancel");
    const unlockedId = await sealMessage(owner, recipient, "encrypted://unlock");

    await vault.connect(owner).cancelMessage(canceledId);
    await expect(vault.connect(owner).updateMessageContent(canceledId, "x"))
      .to.be.revertedWithCustomError(vault, "MessageIsCanceled");
    await expect(vault.connect(owner).updateInactivityUnlock(canceledId, SEVEN_DAYS))
      .to.be.revertedWithCustomError(vault, "MessageIsCanceled");

    await time.increase(SEVEN_DAYS + 1);
    await vault.connect(recipient).claimMessage(unlockedId);
    await expect(vault.connect(owner).updateMessageContent(unlockedId, "x"))
      .to.be.revertedWithCustomError(vault, "AlreadyUnlocked");
    await expect(vault.connect(owner).updateInactivityUnlock(unlockedId, SEVEN_DAYS))
      .to.be.revertedWithCustomError(vault, "AlreadyUnlocked");
  });
});
