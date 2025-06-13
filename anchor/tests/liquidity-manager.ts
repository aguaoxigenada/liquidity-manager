import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import assert from "assert";
import { LiquidityManager } from "../target/types/liquidity_manager";

describe("liquidity-manager", () => {
  // Configure the client
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace
    .LiquidityManager as Program<LiquidityManager>;

  // Test accounts
  let poolKey: PublicKey;
  let tokenMintA: PublicKey;
  let tokenMintB: PublicKey;
  let managerPDA: PublicKey;
  let vaultA: PublicKey;
  let vaultB: PublicKey;

  before(async () => {
    // Initialize test tokens
    tokenMintA = await createMint(
      provider.connection,
      provider.wallet.payer,
      provider.wallet.publicKey,
      null,
      9 // SOL decimals
    );

    tokenMintB = await createMint(
      provider.connection,
      provider.wallet.payer,
      provider.wallet.publicKey,
      null,
      6 // USDC decimals
    );

    // Generate a mock pool address
    poolKey = anchor.web3.Keypair.generate().publicKey;
  });

  it("Initializes the manager", async () => {
    // Find PDA for manager account
    [managerPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("manager"), poolKey.toBuffer()],
      program.programId
    );

    // Calculate vault addresses
    vaultA = await getAssociatedTokenAddress(tokenMintA, managerPDA);
    vaultB = await getAssociatedTokenAddress(tokenMintB, managerPDA);

    const tx = await program.methods
      .initialize(
        -100, // lower_tick
        100 // upper_tick
      )
      .accounts({
        manager: managerPDA,
        pool: poolKey,
        tokenMintA,
        tokenMintB,
        tokenVaultA: vaultA,
        tokenVaultB: vaultB,
        authority: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
      })
      .rpc();

    console.log("Initialization tx:", tx);

    // Verify initialization
    const managerState = await program.account.liquidityManager.fetch(
      managerPDA
    );
    console.log("Manager state:", managerState);
  });

  it("Updates the range", async () => {
    const newLowerTick = -200;
    const newUpperTick = 200;

    const tx = await program.methods
      .updateRange(newLowerTick, newUpperTick)
      .accounts({
        manager: managerPDA,
        authority: provider.wallet.publicKey,
      })
      .rpc();

    console.log("Update range tx:", tx);

    // Verify update
    const managerState = await program.account.liquidityManager.fetch(
      managerPDA
    );
    assert.equal(managerState.lowerTick, newLowerTick);
    assert.equal(managerState.upperTick, newUpperTick);
  });

  it("Rebalances the position", async () => {
    // Mock pool data - in a real test you'd need to setup a test pool
    const mockPoolData = new Uint8Array(/* ... */); // Your RaydiumPoolState structure

    // Mock remaining accounts for rebalance
    const remainingAccounts = [
      // Add required accounts for position, tick arrays, etc.
    ];

    const tx = await program.methods
      .rebalance()
      .accounts({
        manager: managerPDA,
        pool: poolKey,
        tokenVaultA: vaultA,
        tokenVaultB: vaultB,
        tokenMintA,
        tokenMintB,
        executor: provider.wallet.publicKey,
        positionAuthority: provider.wallet.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        raydiumProgram: new PublicKey(
          "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK"
        ),
        jupiterProgram: new PublicKey(
          "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"
        ),
      })
      .remainingAccounts(remainingAccounts)
      .rpc();

    console.log("Rebalance tx:", tx);
  });
});
