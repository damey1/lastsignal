# LastSignal — your EchoLife onchain

> An AI-powered proof of life & message capsule protocol built on Ritual Chain.

---

## What is LastSignal?

LastSignal is your daily onchain heartbeat. You check in. You write locked messages for the people you love. If you go silent, LastSignal notices — and your messages find their way home.

Built on **Ritual Chain** (Chain ID: 1979) — the first L1 with AI execution native to the chain.

**Founder:** Maxiq ([@cryptomaxiq](https://twitter.com/cryptomaxiq))  
**Parent Project:** AmanahProtocol — full onchain inheritance protocol (coming soon)

---

## Product Layers

| Layer | Feature | Status |
|-------|---------|--------|
| Layer 1 | Daily Check-In (Heartbeat) | 🔨 Building |
| Layer 1 | Streak Tracking | 🔨 Building |
| Layer 1 | Locked Message Vault | 🔨 Building |
| Layer 1 | Inactivity Alerts | 🔨 Building |
| Layer 2 | Future Self AI Engine | 📋 Planned |
| Layer 3 | AmanahProtocol Bridge | 📋 Planned |

---

## Tech Stack

- **Blockchain:** Ritual Chain (EVM-compatible)
- **Smart Contracts:** Solidity + Hardhat
- **Frontend:** HTML / CSS / JavaScript + Ethers.js
- **AI Layer:** Ritual Chain native AI sidecar (Layer 2)

---

## Network Details

| Field | Value |
|-------|-------|
| Network Name | Ritual Chain |
| Chain ID | 1979 |
| RPC URL | https://rpc.ritualfoundation.org |
| Currency Symbol | $RITUAL |
| Block Explorer | https://explorer.ritualfoundation.org |

---

## Getting Started

### Prerequisites
- Node.js v18+
- npm or yarn
- MetaMask with Ritual testnet added

### Install

```bash
git clone https://github.com/YOUR_USERNAME/lastsignal.git
cd lastsignal
npm install
```

### Set up environment

```bash
cp .env.example .env
```

Add your private key to `.env`:

```
PRIVATE_KEY=your_wallet_private_key_here
RITUAL_RPC_URL=https://rpc.ritualfoundation.org
```

> ⚠️ Never commit your `.env` file. It is already in `.gitignore`.

### Compile contracts

```bash
npx hardhat compile
```

### Run tests

```bash
npx hardhat test
```

### Deploy to Ritual testnet

```bash
npx hardhat run scripts/deploy.js --network ritual
```

---

## Contract Overview

### CheckIn.sol
The heartbeat contract. Records your wallet address and timestamp on every check-in. Tracks streaks and last-seen time.

### MessageVault.sol
The message capsule contract. Stores encrypted messages locked to a recipient. Unlocks automatically if the owner's heartbeat flatlines past a set threshold.

---

## Roadmap

- [x] Concept document v1.0
- [x] Landing page live
- [ ] CheckIn.sol deployed to Ritual testnet
- [ ] MessageVault.sol deployed to Ritual testnet
- [ ] Frontend connected via ethers.js
- [ ] Future Self AI engine (Ritual sidecar)
- [ ] AmanahProtocol bridge
- [ ] Mainnet launch

---

*LastSignal — your EchoLife onchain.*
