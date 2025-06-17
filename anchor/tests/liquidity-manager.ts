import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  createAccount,
  createAssociatedTokenAccountInstruction,
  createInitializeAccountInstruction,
  createInitializeMintInstruction,
  createMint,
  getAssociatedTokenAddress,
  mintTo,
} from "@solana/spl-token";
import idl from "../target/idl/liquidity_manager.json";

import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import assert from "assert";
import { LiquidityManager } from "../target/types/liquidity_manager";
import { TestPool } from "../target/types/test_pool";

let provider: anchor.AnchorProvider;
let program: Program<LiquidityManager>;
let testPoolProgram: Program<TestPool>;

let connection: anchor.web3.Connection;
let mockPoolAccount: Keypair;
let poolKey: PublicKey;

describe("liquidity-manager", () => {
  let tokenMintA: PublicKey;
  let tokenMintB: PublicKey;
  let managerPDA: PublicKey;

  const executor = Keypair.generate();

  let mockPool: {
    status: number;
    nonce: number;
    current_tick: number;
  };

  before(async () => {
    connection = new anchor.web3.Connection(
      "http://127.0.0.1:8899",
      "confirmed"
    );
    const wallet = anchor.AnchorProvider.env().wallet;
    provider = new anchor.AnchorProvider(connection, wallet, {});
    anchor.setProvider(provider);

    testPoolProgram = new anchor.Program<TestPool>(
      require("../target/idl/test_pool.json"),
      provider
    );

    // Initialize program with full provider + IDL
    program = new anchor.Program(idl as anchor.Idl, provider);

    // Airdrop to executor
    await connection.requestAirdrop(executor.publicKey, 1_000_000_000);

    // Create mints as usual
    tokenMintA = await createMint(
      connection,
      wallet.payer,
      wallet.publicKey,
      null,
      9
    );

    tokenMintB = await createMint(
      connection,
      wallet.payer,
      wallet.publicKey,
      null,
      6
    );

    mockPool = { status: 1, nonce: 1, current_tick: 0 };

    mockPoolAccount = Keypair.generate();
    poolKey = mockPoolAccount.publicKey;
    console.log("got here");

    const lamports = await connection.getMinimumBalanceForRentExemption(6);
    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: wallet.publicKey,
        newAccountPubkey: mockPoolAccount.publicKey,
        lamports,
        space: 6,
        programId: testPoolProgram.programId,
      })
    );

    console.log("almost here");

    await provider.sendAndConfirm(tx, [wallet.payer, mockPoolAccount]);

    console.log("not here");

    await testPoolProgram.methods
      .initializePool(1, 1, 0) // status=1, nonce=1, tick=0
      .accounts({
        pool: poolKey,
        authority: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log("oss here");

    // Compute PDA
    [managerPDA] = await PublicKey.findProgramAddressSync(
      [Buffer.from("manager"), poolKey.toBuffer()],
      program.programId
    );

    console.log("Real pool setup complete");
  });

  it("Initializes the manager", async () => {
    const tx = await program.methods
      .initialize(
        -100, // lower_tick
        100, // upper_tick
        executor.publicKey
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

    const managerState = await program.account.liquidityManager.fetch(
      managerPDA
    );
    assert.equal(
      managerState.authority.toString(),
      provider.wallet.publicKey.toString()
    );
    assert.equal(
      managerState.executor.toString(),
      executor.publicKey.toString()
    );
    assert.equal(managerState.lowerTick, -100);
    assert.equal(managerState.upperTick, 100);
  });

  it("Rebalances the position", async () => {
    // 1. Get manager state
    const managerState = await program.account.liquidityManager.fetch(
      managerPDA
    );

    await testPoolProgram.methods
      .updatePool(managerState.upperTick + 10)
      .accounts({
        pool: poolKey,
      })
      .rpc();

    console.log("Starting rebalance!");
    console.log("Manager lowerTick:", managerState.lowerTick);
    console.log("Manager upperTick:", managerState.upperTick);
    console.log("Mock pool current_tick:", mockPool.current_tick);

    // 2. Create tick arrays
    const tickArrayLower = Keypair.generate();
    const tickArrayUpper = Keypair.generate();
    await provider.connection.requestAirdrop(
      tickArrayLower.publicKey,
      1_000_000_000
    );
    await provider.connection.requestAirdrop(
      tickArrayUpper.publicKey,
      1_000_000_000
    );

    // 3. Create pool token vaults
    const poolTokenVaultA = await createAccount(
      provider.connection,
      provider.wallet.payer,
      managerState.tokenMintA,
      poolKey
    );
    const poolTokenVaultB = await createAccount(
      provider.connection,
      provider.wallet.payer,
      managerState.tokenMintB,
      poolKey
    );
    console.log("pool token vaults created!");

    // 4. Create position NFT
    const positionNftMint = Keypair.generate();
    const createMintTx = new anchor.web3.Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: provider.wallet.publicKey,
        newAccountPubkey: positionNftMint.publicKey,
        space: 82,
        lamports: await provider.connection.getMinimumBalanceForRentExemption(
          82
        ),
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMintInstruction(
        positionNftMint.publicKey,
        0, // NFT decimals
        managerPDA, // Mint authority
        null
      )
    );
    await provider.sendAndConfirm(createMintTx, [
      provider.wallet.payer,
      positionNftMint,
    ]);

    console.log("Oh!");
    // 5. Create position token account
    const positionTokenAccount = Keypair.generate();
    const createTokenAccountTx = new anchor.web3.Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: provider.wallet.publicKey,
        newAccountPubkey: positionTokenAccount.publicKey,
        space: 165,
        lamports: await provider.connection.getMinimumBalanceForRentExemption(
          165
        ),
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeAccountInstruction(
        positionTokenAccount.publicKey,
        positionNftMint.publicKey,
        managerPDA
      )
    );
    await provider.sendAndConfirm(createTokenAccountTx, [
      provider.wallet.payer,
      positionTokenAccount,
    ]);

    console.log("Got here!");

    // 1. First get the ATA addresses
    const payerTokenAccountAAddress = await getAssociatedTokenAddress(
      managerState.tokenMintA,
      provider.wallet.publicKey
    );
    const payerTokenAccountBAddress = await getAssociatedTokenAddress(
      managerState.tokenMintB,
      provider.wallet.publicKey
    );

    // 2. Create the ATAs if they don't exist
    try {
      console.log("Creating ATAs if needed...");
      const createTokenAccountIx = [];

      // Check if ATA for token A exists
      const ataAExists = await provider.connection.getAccountInfo(
        payerTokenAccountAAddress
      );
      if (!ataAExists) {
        createTokenAccountIx.push(
          createAssociatedTokenAccountInstruction(
            provider.wallet.publicKey,
            payerTokenAccountAAddress,
            provider.wallet.publicKey,
            managerState.tokenMintA
          )
        );
      }

      // Check if ATA for token B exists
      const ataBExists = await provider.connection.getAccountInfo(
        payerTokenAccountBAddress
      );
      if (!ataBExists) {
        createTokenAccountIx.push(
          createAssociatedTokenAccountInstruction(
            provider.wallet.publicKey,
            payerTokenAccountBAddress,
            provider.wallet.publicKey,
            managerState.tokenMintB
          )
        );
      }

      // Only send transaction if we need to create accounts
      if (createTokenAccountIx.length > 0) {
        await provider.sendAndConfirm(
          new Transaction().add(...createTokenAccountIx)
        );
        console.log("Created ATAs successfully!");
      } else {
        console.log("ATAs already exist");
      }

      // 3. Now mint tokens to the ATAs
      console.log("Minting tokens...");
      await mintTo(
        provider.connection,
        provider.wallet.payer,
        managerState.tokenMintA,
        payerTokenAccountAAddress, // Use the address directly
        provider.wallet.payer, // Mint authority
        10_000_000_000
      );

      await mintTo(
        provider.connection,
        provider.wallet.payer,
        managerState.tokenMintB,
        payerTokenAccountBAddress, // Use the address directly
        provider.wallet.payer, // Mint authority
        10_000_000_000
      );

      console.log("Minting completed successfully!");
    } catch (error) {
      console.error("Error in token account setup:");
      console.error("Token A ATA:", payerTokenAccountAAddress.toString());
      console.error("Token B ATA:", payerTokenAccountBAddress.toString());

      // Verify mint accounts
      const mintAInfo = await provider.connection.getAccountInfo(
        managerState.tokenMintA
      );
      const mintBInfo = await provider.connection.getAccountInfo(
        managerState.tokenMintB
      );
      console.log("Mint A exists:", mintAInfo !== null);
      console.log("Mint B exists:", mintBInfo !== null);

      throw error;
    }

    console.log("ready to fund");
    await program.methods
      .fundVaults(new anchor.BN(1_000_000), new anchor.BN(1_000_000))
      .accounts({
        vaultA: managerState.tokenVaultA,
        vaultB: managerState.tokenVaultB,
        payerTokenA: payerTokenAccountAAddress,
        payerTokenB: payerTokenAccountBAddress,
        mintA: managerState.tokenMintA,
        mintB: managerState.tokenMintB,
        payer: provider.wallet.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
    console.log("finished funding");

    // 7. Prepare remaining accounts
    const remainingAccounts = [
      // Tick arrays
      { pubkey: tickArrayLower.publicKey, isWritable: true, isSigner: false },
      { pubkey: tickArrayUpper.publicKey, isWritable: true, isSigner: false },
      // Position accounts
      { pubkey: positionNftMint.publicKey, isWritable: true, isSigner: false },
      {
        pubkey: positionTokenAccount.publicKey,
        isWritable: true,
        isSigner: false,
      },
      // Pool token vaults
      { pubkey: poolTokenVaultA, isWritable: true, isSigner: false },
      { pubkey: poolTokenVaultB, isWritable: true, isSigner: false },
      // Token owner accounts (use vaults as owner accounts in test)
      { pubkey: managerState.tokenVaultA, isWritable: true, isSigner: false },
      { pubkey: managerState.tokenVaultB, isWritable: true, isSigner: false },
    ];

    console.log("nice!");
    // 8. Execute rebalance
    try {
      const tx = await program.methods
        .rebalance()
        .accounts({
          manager: managerPDA,
          pool: poolKey,
          tokenVaultA: managerState.tokenVaultA,
          tokenVaultB: managerState.tokenVaultB,
          tokenMintA: managerState.tokenMintA,
          tokenMintB: managerState.tokenMintB,
          executor: executor.publicKey,
          positionAuthority: provider.wallet.publicKey,
          positionNftMint: positionNftMint.publicKey,
          positionTokenAccount: positionTokenAccount.publicKey,
          tickArrayLower: tickArrayLower.publicKey,
          tickArrayUpper: tickArrayUpper.publicKey,
          tokenOwnerAccountA: managerState.tokenVaultA,
          tokenOwnerAccountB: managerState.tokenVaultB,
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
        .signers([executor])
        .rpc({ skipPreflight: true });

      // Verify state changes
      const updatedManager = await program.account.liquidityManager.fetch(
        managerPDA
      );
      assert.notEqual(updatedManager.currentLiquidity.toString(), "0");
      assert.notEqual(updatedManager.lowerTick, managerState.lowerTick);
    } catch (error) {
      console.error("Rebalance error:", error);
      if (error.logs) {
        console.error("Transaction logs:");
        error.logs.forEach((log: string) => console.log(log));
      }
      throw error;
    }
  });
});
