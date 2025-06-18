import { Raydium } from "@raydium-io/raydium-sdk";
import { NATIVE_MINT } from "@solana/spl-token";

describe("liquidity-manager (DevNet)", () => {
  let raydium: Raydium;
  let tokenMintA: PublicKey;
  let tokenMintB: PublicKey = NATIVE_MINT; // Using WSOL as token B

  before(async () => {
    // Initialize Raydium SDK for DevNet
    raydium = await Raydium.load({
      owner: provider.wallet, // Your Anchor provider wallet
      connection: new Connection(clusterApiUrl("devnet")),
      cluster: "devnet",
    });

    // Create test tokens on DevNet
    tokenMintA = await createTestToken(provider, 9); // Helper function to create a token
  });

  it("Initializes the manager with real Raydium pool", async () => {
    // 1. Create a Raydium pool
    const mintAInfo = await raydium.token.getTokenInfo(tokenMintA.toString());
    const mintBInfo = await raydium.token.getTokenInfo(tokenMintB.toString());

    const { execute, extInfo } = await raydium.cpmm.createPool({
      programId: new PublicKey("Eew5QFWV7QyA3hd2YZkQK3a2ojzaerfWtCJ4JTu1K1mX"), // DevNet CPMM
      poolFeeAccount: new PublicKey(
        "9zSzfkYy6awexsHvmggeH36pfVUdDGyCcwmjT3AQPBj6"
      ), // DevNet fee account
      mintA: mintAInfo,
      mintB: mintBInfo,
      mintAAmount: new BN(1_000_000 * 10 ** mintAInfo.decimals),
      mintBAmount: new BN(1_000_000 * 10 ** mintBInfo.decimals),
    });

    const poolCreationTx = await execute();
    await provider.connection.confirmTransaction(poolCreationTx);

    const poolKey = extInfo.poolId;

    // 2. Initialize your manager with this pool
    const tx = await program.methods
      .initialize(
        -100, // lower_tick
        100, // upper_tick
        provider.wallet.publicKey
      )
      .accounts({
        manager: managerPDA,
        pool: poolKey,
        tokenMintA,
        tokenMintB,
        // ... rest of your accounts
      })
      .rpc();
  });

  // Helper function to create test tokens
  async function createTestToken(
    provider: AnchorProvider,
    decimals: number
  ): Promise<PublicKey> {
    const mintKeypair = Keypair.generate();
    const lamports =
      await provider.connection.getMinimumBalanceForRentExemption(
        MintLayout.span
      );

    const createTx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: provider.wallet.publicKey,
        newAccountPubkey: mintKeypair.publicKey,
        lamports,
        space: MintLayout.span,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMintInstruction(
        mintKeypair.publicKey,
        decimals,
        provider.wallet.publicKey,
        provider.wallet.publicKey
      )
    );

    await provider.sendAndConfirm(createTx, [mintKeypair]);
    return mintKeypair.publicKey;
  }
});
