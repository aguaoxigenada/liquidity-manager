import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccount,
  createMint,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import assert from "assert";
import { LiquidityManager } from "../target/types/liquidity_manager";

describe("liquidity-manager", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace
    .LiquidityManager as Program<LiquidityManager>;

  let poolKey: PublicKey;
  let tokenMintA: PublicKey;
  let tokenMintB: PublicKey;
  let managerPDA: PublicKey;
  let managerBump: number;

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
    poolKey = Keypair.generate().publicKey;

    // Find PDA for manager account
    [managerPDA, managerBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("manager"), poolKey.toBuffer()],
      program.programId
    );
  });

  it("Initializes the manager", async () => {
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
        authority: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        // Anchor creates this:
        tokenVaultA: await anchor.utils.token.associatedAddress({
          mint: tokenMintA,
          owner: managerPDA,
        }),
        tokenVaultB: await anchor.utils.token.associatedAddress({
          mint: tokenMintB,
          owner: managerPDA,
        }),
      })
      .rpc();

    console.log("Initialization tx:", tx);

    // Verify initialization
    const managerState = await program.account.liquidityManager.fetch(
      managerPDA
    );
    console.log("Manager state:", managerState);

    // Verify vaults were created
    const vaultA = await anchor.utils.token.associatedAddress({
      mint: tokenMintA,
      owner: managerPDA,
    });
    const vaultB = await anchor.utils.token.associatedAddress({
      mint: tokenMintB,
      owner: managerPDA,
    });

    const vaultAInfo = await provider.connection.getAccountInfo(vaultA);
    const vaultBInfo = await provider.connection.getAccountInfo(vaultB);
    assert.ok(vaultAInfo !== null);
    assert.ok(vaultBInfo !== null);
  });

  it("Rebalances the position", async () => {
    // 1. Setup required accounts
    const tickArrayLower = Keypair.generate();
    const tickArrayUpper = Keypair.generate();
    const positionNft = Keypair.generate();

    const positionTokenAccount = await createAssociatedTokenAccount(
      provider.connection,
      provider.wallet.payer,
      positionNft.publicKey,
      provider.wallet.publicKey
    );

    const poolTokenVaultA = await createAssociatedTokenAccount(
      provider.connection,
      provider.wallet.payer,
      tokenMintA,
      poolKey
    );

    const poolTokenVaultB = await createAssociatedTokenAccount(
      provider.connection,
      provider.wallet.payer,
      tokenMintB,
      poolKey
    );

    // 2. Prepare remaining accounts
    const remainingAccounts = [
      { pubkey: tickArrayLower.publicKey, isWritable: true, isSigner: false },
      { pubkey: tickArrayUpper.publicKey, isWritable: true, isSigner: false },
      { pubkey: positionNft.publicKey, isWritable: true, isSigner: false },
      { pubkey: positionTokenAccount, isWritable: true, isSigner: false },
      { pubkey: poolTokenVaultA, isWritable: true, isSigner: false },
      { pubkey: poolTokenVaultB, isWritable: true, isSigner: false },
    ];

    // 3. Execute rebalance
    const tx = await program.methods
      .rebalance()
      .accounts({
        manager: managerPDA,
        pool: poolKey,
        tokenVaultA: await anchor.utils.token.associatedAddress({
          mint: tokenMintA,
          owner: managerPDA,
        }),
        tokenVaultB: await anchor.utils.token.associatedAddress({
          mint: tokenMintB,
          owner: managerPDA,
        }),
        tokenMintA,
        tokenMintB,
        executor: provider.wallet.publicKey,
        positionAuthority: provider.wallet.publicKey,
        positionNft: positionNft.publicKey,
        positionTokenAccount,
        tickArrayLower: tickArrayLower.publicKey,
        tickArrayUpper: tickArrayUpper.publicKey,
        poolTokenVaultA,
        poolTokenVaultB,
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
      .signers([positionNft, tickArrayLower, tickArrayUpper])
      .rpc();

    console.log("Rebalance tx:", tx);
  });

  /*
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

  
  */
});
