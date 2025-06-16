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

import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
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

  const executor = Keypair.generate();

  let mockPool: {
    status: number;
    nonce: number;
    current_tick: number;
  };
  before(async () => {
    const realConnection = new anchor.web3.Connection(
      "http://127.0.0.1:8899",
      "confirmed"
    );

    await realConnection.requestAirdrop(executor.publicKey, 1_000_000_000);

    tokenMintA = await createMint(
      realConnection,
      provider.wallet.payer,
      provider.wallet.publicKey,
      null,
      9
    );

    tokenMintB = await createMint(
      realConnection,
      provider.wallet.payer,
      provider.wallet.publicKey,
      null,
      6
    );

    const mockPoolAccount = Keypair.generate();
    poolKey = mockPoolAccount.publicKey;

    mockPool = { status: 1, nonce: 1, current_tick: 0 };

    const getMockPoolData = () => {
      const data = Buffer.alloc(8);
      data.writeUInt8(mockPool.status, 0);
      data.writeUInt8(mockPool.nonce, 1);
      data.writeInt32LE(mockPool.current_tick, 2);
      return data;
    };

    const lamports = await realConnection.getMinimumBalanceForRentExemption(8);
    const createPoolTx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: provider.wallet.publicKey,
        newAccountPubkey: poolKey,
        lamports,
        space: 8,
        programId: SystemProgram.programId,
      })
    );

    await provider.sendAndConfirm(createPoolTx, [
      provider.wallet.payer,
      mockPoolAccount,
    ]);

    // ✅ NO extra write / instruction here

    // Proxy to inject pool data for your mock
    const proxiedConnection = new Proxy(realConnection, {
      get(target, prop, receiver) {
        if (prop === "getAccountInfo") {
          return async (pubkey: PublicKey) => {
            if (pubkey.equals(poolKey)) {
              return {
                executable: false,
                owner: SystemProgram.programId,
                lamports: 1_000_000_000,
                data: getMockPoolData(),
                rentEpoch: 0,
              };
            }
            return await target.getAccountInfo(pubkey);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const newProvider = new anchor.AnchorProvider(
      proxiedConnection,
      provider.wallet,
      {}
    );
    anchor.setProvider(newProvider);

    [managerPDA] = await PublicKey.findProgramAddressSync(
      [Buffer.from("manager"), poolKey.toBuffer()],
      program.programId
    );

    console.log("✅ Mock pool setup complete");
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
    mockPool.current_tick = managerState.upperTick + 10; // Trigger rebalance
    console.log("Starting rebalance!");

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

/*import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  createAccount,
  createInitializeAccountInstruction,
  createInitializeMintInstruction,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
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

  const executor = Keypair.generate(); // Revisar

  let mockPool: {
    status: number;
    nonce: number;
    current_tick: number;
  };

  before(async () => {
    // Airdrop to executor
    await provider.connection.requestAirdrop(executor.publicKey, 1_000_000_000);

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

    // Enhanced mock setup
    const mockPoolAccount = Keypair.generate();
    poolKey = mockPoolAccount.publicKey;

    mockPool = {
      status: 1,
      nonce: 1,
      current_tick: 0,
    };

    const getMockPoolData = () => {
      const data = Buffer.alloc(8);
      data.writeUInt8(mockPool.status, 0);
      data.writeUInt8(mockPool.nonce, 1);
      data.writeInt32LE(mockPool.current_tick, 2);
      return data;
    };

    // Unified mock account info
    const mockAccountInfo = {
      executable: false,
      owner: SystemProgram.programId,
      lamports: 1_000_000_000,
      data: getMockPoolData(),
      rentEpoch: 0,
    };

    // Program account mock
    (program.account as any).pool = {
      fetch: async (address: PublicKey) =>
        address.equals(poolKey) ? getMockPoolData() : null,
      fetchNullable: async () => null,
      fetchMultiple: async () => [],
    };

    // Connection-level mock
    provider.connection.getAccountInfo = async (pubkey) =>
      pubkey.equals(poolKey) ? mockAccountInfo : null;

    // Transaction-level mock
    const originalSendTransaction = provider.connection.sendTransaction;
    provider.connection.sendTransaction = async (tx, signers, options) => {
      // Get recent blockhash if not provided
      if (!options?.skipPreflight) {
        const recentBlockhash = (await provider.connection.getRecentBlockhash())
          .blockhash;
        (tx as anchor.web3.Transaction).recentBlockhash = recentBlockhash;
      }

      const parsed = anchor.web3.Transaction.from(tx.serialize());

      // Add our mock account to all instructions
      parsed.instructions.forEach((ix) => {
        if (ix.programId.equals(program.programId)) {
          ix.keys.push({
            pubkey: poolKey,
            isSigner: false,
            isWritable: false,
          });
        }
      });

      return originalSendTransaction(parsed, signers, options);
    };

    // Find PDA
    [managerPDA] = await PublicKey.findProgramAddress(
      [Buffer.from("manager"), poolKey.toBuffer()],
      program.programId
    );
  });

  it("should verify mock setup", async () => {
    // Test direct fetch
    const fetched = await (program.account as any).pool.fetch(poolKey);
    assert.ok(fetched instanceof Buffer, "Should return Buffer");

    // Test connection-level fetch
    const accInfo = await provider.connection.getAccountInfo(poolKey);
    assert.ok(accInfo, "Should return mock account info");
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
    // 1. Get manager state with vault addresses
    const managerState = await program.account.liquidityManager.fetch(
      managerPDA
    );

    mockPool.current_tick = managerState.upperTick + 10; // Value above upper tick

    // 2. Verify mock data
    const poolData = await (program.account as any).pool.fetch(poolKey);
    assert.ok(poolData instanceof Buffer, "Pool mock should return Buffer");
    console.log("Mock pool bytes:", [...poolData]);

    const tokenVaultA = managerState.tokenVaultA;
    const tokenVaultB = managerState.tokenVaultB;

    console.log("Using Vault A:", tokenVaultA.toString());
    console.log("Using Vault B:", tokenVaultB.toString());

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

    console.log("Breaks here?");

    // 3. Create pool token vaults (regular token accounts owned by pool)
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

    console.log("or here?");

    // 4. Create position NFT (regular mint)
    const positionNftMint = Keypair.generate();

    // Create and initialize mint
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
        0, // Decimals for NFT
        managerPDA, // Mint authority
        null // Freeze authority
      )
    );
    await provider.sendAndConfirm(createMintTx, [
      provider.wallet.payer,
      positionNftMint,
    ]);

    console.log("Maybe here?");
    // 5. Create position token account (regular token account, not ATA)
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
        positionTokenAccount.publicKey, // New token account
        positionNftMint.publicKey, // Token mint
        managerPDA // Owner (manager PDA)
      )
    );

    // Sign and send with both payer and new account as signers
    await provider.sendAndConfirm(createTokenAccountTx, [
      provider.wallet.payer,
      positionTokenAccount,
    ]);

    console.log(
      "Position token account created:",
      positionTokenAccount.publicKey.toString()
    );

    console.log("perhaps here?");
    // 6. Fund the vaults
    const payerTokenAccountA = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      provider.wallet.payer,
      managerState.tokenMintA,
      provider.wallet.publicKey
    );
    const payerTokenAccountB = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      provider.wallet.payer,
      managerState.tokenMintB,
      provider.wallet.publicKey
    );

    console.log("yeah here?");

    // Mint tokens to fund
    await mintTo(
      provider.connection,
      provider.wallet.payer,
      managerState.tokenMintA,
      payerTokenAccountA.address,
      provider.wallet.payer,
      10_000_000_000
    );
    await mintTo(
      provider.connection,
      provider.wallet.payer,
      managerState.tokenMintB,
      payerTokenAccountB.address,
      provider.wallet.payer,
      10_000_000_000
    );

    console.log("dang here?");
    // Transfer to manager vaults
    await program.methods
      .fundVaults(new anchor.BN(1_000_000), new anchor.BN(1_000_000))
      .accounts({
        vaultA: tokenVaultA,
        vaultB: tokenVaultB,
        payerTokenA: payerTokenAccountA.address,
        payerTokenB: payerTokenAccountB.address,
        mintA: managerState.tokenMintA,
        mintB: managerState.tokenMintB,
        payer: provider.wallet.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    console.log("Oh my here?");
    // After funding vaults
    const vaultABalance = await provider.connection.getTokenAccountBalance(
      tokenVaultA
    );
    const vaultBBalance = await provider.connection.getTokenAccountBalance(
      tokenVaultB
    );
    console.log("Vault A Balance:", vaultABalance.value.amount);
    console.log("Vault B Balance:", vaultBBalance.value.amount);

    // 7. Prepare remaining accounts
    const remainingAccounts = [
      { pubkey: tickArrayLower.publicKey, isWritable: true, isSigner: false },
      { pubkey: tickArrayUpper.publicKey, isWritable: true, isSigner: false },
      { pubkey: positionNftMint.publicKey, isWritable: true, isSigner: false },
      {
        pubkey: positionTokenAccount.publicKey,
        isWritable: true,
        isSigner: false,
      },
      { pubkey: poolTokenVaultA, isWritable: true, isSigner: false },
      { pubkey: poolTokenVaultB, isWritable: true, isSigner: false },
    ];

    console.log("Nice!");

    const { blockhash } = await provider.connection.getRecentBlockhash();

    // 8. Execute rebalance
    try {
      const tx = await program.methods
        .rebalance()
        .accounts({
          manager: managerPDA,
          pool: poolKey,
          tokenVaultA,
          tokenVaultB,
          tokenMintA: managerState.tokenMintA,
          tokenMintB: managerState.tokenMintB,
          executor: executor.publicKey,
          positionAuthority: provider.wallet.publicKey,
          positionNftMint: positionNftMint.publicKey,
          positionTokenAccount: positionTokenAccount.publicKey,
          tickArrayLower: tickArrayLower.publicKey,
          tickArrayUpper: tickArrayUpper.publicKey,
          tokenOwnerAccountA: tokenVaultA,
          tokenOwnerAccountB: tokenVaultB,
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

      console.log("Got it!");

      console.log("Rebalance tx:", tx);

      // Verify state changes
      const updatedManager = await program.account.liquidityManager.fetch(
        managerPDA
      );
      assert.notEqual(updatedManager.currentLiquidity.toString(), "0");
      assert.notEqual(updatedManager.lowerTick, managerState.lowerTick);
    } catch (error) {
      console.error("Rebalance failed:", error);
      if (error.logs) console.error("Logs:", error.logs);
      throw error;
    }
  });
});
*/
