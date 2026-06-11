const { ethers } = require("hardhat");

async function main() {
  const addresses = process.env.ADDRESSES.split(",");
  for (const address of addresses) {
    const code = await ethers.provider.getCode(address);
    console.log(`${address}: ${code === "0x" ? "no code" : `${(code.length - 2) / 2} bytes`}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
