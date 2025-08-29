import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

dotenv.config();

const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || "";

if (!RPC_URL) {
  console.warn("[hardhat.config] RPC_URL not set (Sepolia). Set RPC_URL in .env");
}
if (!PRIVATE_KEY) {
  console.warn("[hardhat.config] PRIVATE_KEY not set (Sepolia). Set PRIVATE_KEY in .env");
}

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 }
    }
  },
  networks: {
    hardhat: { chainId: 31337 },
    sepolia: {
      url: RPC_URL || "https://eth-sepolia.g.alchemy.com/v2/invalid-placeholder",
      chainId: 11155111,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : []
    }
  },
  etherscan: {
    apiKey: ETHERSCAN_API_KEY
  }
};

export default config;
