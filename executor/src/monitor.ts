import { CLMM } from "@raydium-io/raydium-sdk-v2";

// Fetch pool data
const poolInfo = await CLMM.fetchPool({
  connection,
  poolId: new PublicKey("POOL_ID_HERE"),
});

// Get tick arrays
const tickArrays = await CLMM.fetchTickArrays({
  poolInfo,
  lowerTick: -1000,
  upperTick: 1000,
});

// Build position
const position = await CLMM.buildPosition({
  poolInfo,
  lowerTick: -1000,
  upperTick: 1000,
  tokenAmounts: [tokenAAmount, tokenBAmount],
});
