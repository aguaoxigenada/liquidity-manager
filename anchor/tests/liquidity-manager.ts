import * as anchor from "@coral-xyz/anchor";
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

    // Create mock pool account keypair
    const mockPoolAccount = Keypair.generate();
    poolKey = mockPoolAccount.publicKey;

    // Define mock pool data structure
    mockPool = {
      status: 1,
      nonce: 1,
      current_tick: 0,
    };

    const getMockPoolData = () => {
      const data = Buffer.alloc(8); // Must match Rust struct size
      data.writeUInt8(mockPool.status, 0);
      data.writeUInt8(mockPool.nonce, 1);
      data.writeInt32LE(mockPool.current_tick, 2);
      return data;
    };

    // Mock getAccountInfo without jest
    provider.connection.getAccountInfo = async (pubkey: PublicKey) => {
      if (pubkey.equals(poolKey)) {
        const data = Buffer.alloc(8); // Match your struct size
        data.writeUInt8(mockPool.status, 0);
        data.writeUInt8(mockPool.nonce, 1);
        data.writeInt32LE(mockPool.current_tick, 2);

        return {
          executable: false,
          owner: SystemProgram.programId,
          lamports: 1000000000,
          data: data, // <-- Critical change! Use the actual mock data
        };
      }
      return null;
    };

    (program.account as any).pool = {
      fetch: async (address: PublicKey) => {
        if (address.equals(poolKey)) {
          const data = Buffer.alloc(8); // Must match Rust struct size
          data.writeUInt8(mockPool.status, 0); // u8 at offset 0
          data.writeUInt8(mockPool.nonce, 1); // u8 at offset 1
          data.writeInt32LE(mockPool.current_tick, 2); // i32 at offset 2
          return data;
        }
        return null;
      },
      // Optional but good practice:
      fetchNullable: async (address: PublicKey) => null,
      fetchMultiple: async (addresses: PublicKey[]) =>
        addresses.map(() => null),
    };

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

    const poolData = await (program.account as any).pool.fetch(poolKey);
    assert.ok(poolData instanceof Buffer, "Pool mock should return Buffer");

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

  /*
  it("Rebalances the position", async () => {
    // 1. Get manager state with stored vault addresses
    const managerState = await program.account.liquidityManager.fetch(
      managerPDA
    );

    // Use the vault addresses stored in manager account
    const tokenVaultA = managerState.tokenVaultA;
    const tokenVaultB = managerState.tokenVaultB;

    console.log("[1] Using Manager Vault A:", tokenVaultA.toString());
    console.log("[1] Using Manager Vault B:", tokenVaultB.toString());

    // 2. Verify vaults exist and are valid
    const vaultA = await getAccount(provider.connection, tokenVaultA);
    const vaultB = await getAccount(provider.connection, tokenVaultB);

    assert.equal(
      vaultA.mint.toString(),
      managerState.tokenMintA.toString(),
      "Vault A has wrong mint"
    );
    assert.equal(
      vaultB.mint.toString(),
      managerState.tokenMintB.toString(),
      "Vault B has wrong mint"
    );
    assert.equal(
      vaultA.owner.toString(),
      managerPDA.toString(),
      "Vault A has wrong owner"
    );
    assert.equal(
      vaultB.owner.toString(),
      managerPDA.toString(),
      "Vault B has wrong owner"
    );

    // 3. Create tick arrays
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

    // 4. Create pool token vaults (regular token accounts owned by pool)
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

    // 5. Create position NFT
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
        0,
        managerPDA,
        null
      )
    );
    await provider.sendAndConfirm(createMintTx, [positionNftMint]);

    // Create position token account
    const positionTokenAccount = await createAssociatedTokenAccount(
      provider.connection,
      provider.wallet.payer,
      positionNftMint.publicKey,
      managerPDA
    );

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

    // 7. Prepare remaining accounts
    const remainingAccounts = [
      { pubkey: tickArrayLower.publicKey, isWritable: true, isSigner: false },
      { pubkey: tickArrayUpper.publicKey, isWritable: true, isSigner: false },
      { pubkey: positionNftMint.publicKey, isWritable: true, isSigner: false },
      { pubkey: positionTokenAccount, isWritable: true, isSigner: false },
      { pubkey: poolTokenVaultA, isWritable: true, isSigner: false },
      { pubkey: poolTokenVaultB, isWritable: true, isSigner: false },
    ];

    // 8. Execute rebalance
    try {
      console.log(
        "[2] Executing rebalance with vault A:",
        tokenVaultA.toString()
      );
      console.log(
        "[2] Executing rebalance with vault B:",
        tokenVaultB.toString()
      );

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
          positionTokenAccount,
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

      console.log("Rebalance tx:", tx);

      // Verify state changes
      const updatedManager = await program.account.liquidityManager.fetch(
        managerPDA
      );
      assert.notEqual(
        updatedManager.currentLiquidity.toString(),
        "0",
        "Liquidity not updated"
      );
      assert.notEqual(
        updatedManager.lowerTick,
        managerState.lowerTick,
        "Ticks not updated"
      );
    } catch (error) {
      console.error("Rebalance failed:", error);
      if (error.logs) console.error("Transaction logs:", error.logs);
      if (error instanceof anchor.web3.SendTransactionError) {
        console.error("Full logs:", await error.getLogs());
      }
      throw error;
    }
  });
*/
  /*
  it("Rebalances the position", async () => {
    // Get current manager state and existing vaults
    const managerState = await program.account.liquidityManager.fetch(
      managerPDA
    );

    // Get the existing token vaults that were created during initialization
    const tokenVaultA = await anchor.utils.token.associatedAddress({
      mint: managerState.tokenMintA,
      owner: managerPDA,
    });
    const tokenVaultB = await anchor.utils.token.associatedAddress({
      mint: managerState.tokenMintB,
      owner: managerPDA,
    });

    // Verify vaults exist
    const vaultAInfo = await provider.connection.getAccountInfo(tokenVaultA);
    const vaultBInfo = await provider.connection.getAccountInfo(tokenVaultB);
    assert.ok(vaultAInfo !== null, "Token Vault A does not exist");
    assert.ok(vaultBInfo !== null, "Token Vault B does not exist");

    // Create tick arrays
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

    // Create pool token vaults (regular token accounts owned by pool)
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

    // Create position NFT (regular mint)
    const positionNftMint = Keypair.generate();

    // Create mint account
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
        0,
        managerPDA,
        null
      )
    );
    await provider.sendAndConfirm(createMintTx, [positionNftMint]);

    // Create position token account (regular token account, not ATA)
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
      // Initialize as token account
      {
        keys: [
          {
            pubkey: positionTokenAccount.publicKey,
            isSigner: false,
            isWritable: true,
          },
          {
            pubkey: managerState.tokenMintA,
            isSigner: false,
            isWritable: false,
          },
          { pubkey: managerPDA, isSigner: false, isWritable: false },
          {
            pubkey: SystemProgram.programId,
            isSigner: false,
            isWritable: false,
          },
        ],
        programId: TOKEN_PROGRAM_ID,
        data: Buffer.from([...new Uint8Array([1, 0, 0, 0])]), // Initialize account instruction
      }
    );
    await provider.sendAndConfirm(createTokenAccountTx, [positionTokenAccount]);

    // Fund payer's token accounts
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

    // Mint tokens to fund vaults
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

    // Fund manager's vaults (using existing vaults)
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

    // Prepare remaining accounts
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

    // Execute rebalance using the existing vaults
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

      console.log("Rebalance tx:", tx);

      const updatedManager = await program.account.liquidityManager.fetch(
        managerPDA
      );
      assert.notEqual(updatedManager.currentLiquidity.toString(), "0");
      assert.notEqual(updatedManager.lowerTick, managerState.lowerTick);
    } catch (error) {
      console.error("Rebalance error:", error);
      if (error.logs) console.error("Logs:", error.logs);
      if (error instanceof anchor.web3.SendTransactionError) {
        console.error("Full logs:", await error.getLogs());
      }
      throw error;
    }
  });
  */
});

/*
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  createAccount,
  createAssociatedTokenAccount,
  createInitializeMintInstruction,
  createMint,
  getAccount,
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

  // Fund executor if using new keypair

  before(async () => {
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
    // Get current manager state
    const managerStateBefore = await program.account.liquidityManager.fetch(
      managerPDA
    );

    // 1. Setup mock pool data with current tick outside range
    const mockPoolData = Buffer.alloc(1024);
    const currentTick = 150; // Outside initial range (-100, 100)
    new DataView(mockPoolData.buffer).setInt32(2, currentTick, true); // Offset 2 for status+nonce

    // 2. Create tick arrays
    const tickArrayLower = Keypair.generate();
    const tickArrayUpper = Keypair.generate();

    // Fund tick arrays
    await provider.connection.requestAirdrop(
      tickArrayLower.publicKey,
      1_000_000_000
    );
    await provider.connection.requestAirdrop(
      tickArrayUpper.publicKey,
      1_000_000_000
    );

    // 3. Get vault addresses
    const tokenVaultA = await anchor.utils.token.associatedAddress({
      mint: managerStateBefore.tokenMintA,
      owner: managerPDA,
    });
    const tokenVaultB = await anchor.utils.token.associatedAddress({
      mint: managerStateBefore.tokenMintB,
      owner: managerPDA,
    });

    // 4. Create pool token vaults
    const poolTokenVaultA = await createAccount(
      provider.connection,
      provider.wallet.payer,
      managerStateBefore.tokenMintA,
      poolKey
    );
    const poolTokenVaultB = await createAccount(
      provider.connection,
      provider.wallet.payer,
      managerStateBefore.tokenMintB,
      poolKey
    );

    // 5. Create position NFT - COMPLETE SEQUENCE
    const positionNftMint = Keypair.generate();

    // Step 1: Create mint account transaction
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
        0,
        managerPDA, // Mint authority
        null // Freeze authority
      )
    );

    // Send and confirm the mint creation transaction
    await provider.sendAndConfirm(createMintTx, [positionNftMint]);

    // Step 2: Create associated token account
    const positionTokenAccount = await createAssociatedTokenAccount(
      provider.connection,
      provider.wallet.payer,
      positionNftMint.publicKey,
      managerPDA // Owner
    );

    // Verify accounts were created
    const mintInfo = await getAccount(
      provider.connection,
      positionNftMint.publicKey
    );
    console.log(
      "Mint created:",
      mintInfo.address,
      "Decimals:",
      mintInfo.decimals
    );

    const tokenAccInfo = await getAccount(
      provider.connection,
      positionTokenAccount
    );
    console.log("Token account created:", tokenAccInfo.address);

    // 6. Fund payer's token accounts
    const payerTokenAccountA = await createAssociatedTokenAccount(
      provider.connection,
      provider.wallet.payer,
      managerStateBefore.tokenMintA,
      provider.wallet.publicKey
    );
    const payerTokenAccountB = await createAssociatedTokenAccount(
      provider.connection,
      provider.wallet.payer,
      managerStateBefore.tokenMintB,
      provider.wallet.publicKey
    );

    // Mint tokens to fund vaults
    await mintTo(
      provider.connection,
      provider.wallet.payer,
      managerStateBefore.tokenMintA,
      payerTokenAccountA,
      provider.wallet.payer,
      10_000_000_000
    );
    await mintTo(
      provider.connection,
      provider.wallet.payer,
      managerStateBefore.tokenMintB,
      payerTokenAccountB,
      provider.wallet.payer,
      10_000_000_000
    );

    // 7. Fund manager's vaults
    await program.methods
      .fundVaults(new anchor.BN(1_000_000), new anchor.BN(1_000_000))
      .accounts({
        vaultA: tokenVaultA,
        vaultB: tokenVaultB,
        payerTokenA: payerTokenAccountA,
        payerTokenB: payerTokenAccountB,
        mintA: managerStateBefore.tokenMintA,
        mintB: managerStateBefore.tokenMintB,
        payer: provider.wallet.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    // 8. Prepare remaining accounts
    const remainingAccounts = [
      { pubkey: tickArrayLower.publicKey, isWritable: true, isSigner: false },
      { pubkey: tickArrayUpper.publicKey, isWritable: true, isSigner: false },
      { pubkey: positionNftMint.publicKey, isWritable: true, isSigner: false },
      { pubkey: positionTokenAccount, isWritable: true, isSigner: false },
      { pubkey: poolTokenVaultA, isWritable: true, isSigner: false },
      { pubkey: poolTokenVaultB, isWritable: true, isSigner: false },
    ];

    // 9. Execute rebalance
    try {
      const tx = await program.methods
        .rebalance()
        .accounts({
          manager: managerPDA,
          pool: poolKey,
          tokenVaultA,
          tokenVaultB,
          tokenMintA: managerStateBefore.tokenMintA,
          tokenMintB: managerStateBefore.tokenMintB,
          executor: executor.publicKey,
          positionAuthority: provider.wallet.publicKey,
          positionNftMint: positionNftMint.publicKey,
          positionTokenAccount,
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

      console.log("Rebalance tx:", tx);

      // Verify state changes
      const managerStateAfter = await program.account.liquidityManager.fetch(
        managerPDA
      );
      assert.notEqual(
        managerStateAfter.currentLiquidity.toString(),
        "0",
        "Liquidity should be updated"
      );
      assert.notEqual(
        managerStateAfter.lowerTick,
        managerStateBefore.lowerTick,
        "Ticks should be updated"
      );
    } catch (error) {
      console.error("Rebalance failed:", error);
      if (error.logs) {
        console.error("Transaction logs:", error.logs);
      } else if (error instanceof anchor.web3.SendTransactionError) {
        console.error("Transaction logs:", await error.getLogs());
      }
      throw error;
    }
  });
  /*
  it("Rebalances the position", async () => {
    const tickArrayLower = Keypair.generate();
    const tickArrayUpper = Keypair.generate();

    // Fund the tick array accounts
    await provider.connection.requestAirdrop(
      tickArrayLower.publicKey,
      1_000_000_000 // 1 SOL
    );
    await provider.connection.requestAirdrop(
      tickArrayUpper.publicKey,
      1_000_000_000 // 1 SOL
    );

    // 1. Get existing token vault addresses
    const tokenVaultA = await anchor.utils.token.associatedAddress({
      mint: tokenMintA,
      owner: managerPDA,
    });
    const tokenVaultB = await anchor.utils.token.associatedAddress({
      mint: tokenMintB,
      owner: managerPDA,
    });

    const poolTokenVaultA = await createAccount(
      provider.connection,
      provider.wallet.payer,
      tokenMintA, // Mint address
      poolKey // Owner (the pool)
    );

    const poolTokenVaultB = await createAccount(
      provider.connection,
      provider.wallet.payer,
      tokenMintB,
      poolKey
    );

    // 3. Create position NFT (must be a new mint)
    const positionNftMint = await createMint(
      provider.connection,
      provider.wallet.payer,
      provider.wallet.publicKey,
      null,
      0 // NFTs use 0 decimals
    );

    const positionTokenAccount = await createAssociatedTokenAccount(
      provider.connection,
      provider.wallet.payer,
      positionNftMint,
      provider.wallet.publicKey
    );

    const payerTokenAccountA = await createAssociatedTokenAccount(
      provider.connection,
      provider.wallet.payer,
      tokenMintA,
      provider.wallet.publicKey
    );

    const payerTokenAccountB = await createAssociatedTokenAccount(
      provider.connection,
      provider.wallet.payer,
      tokenMintB,
      provider.wallet.publicKey
    );

    // Mint tokens to payer's accounts
    await mintTo(
      provider.connection,
      provider.wallet.payer,
      tokenMintA,
      payerTokenAccountA,
      provider.wallet.payer,
      10_000_000_000 // 10 tokens (adjust decimals as needed)
    );

    await mintTo(
      provider.connection,
      provider.wallet.payer,
      tokenMintB,
      payerTokenAccountB,
      provider.wallet.payer,
      10_000_000_000
    );

    // 5. Prepare remaining accounts
    const remainingAccounts = [
      { pubkey: tickArrayLower.publicKey, isWritable: true, isSigner: false },
      { pubkey: tickArrayUpper.publicKey, isWritable: true, isSigner: false },
      { pubkey: positionNftMint, isWritable: true, isSigner: false },
      { pubkey: positionTokenAccount, isWritable: true, isSigner: false },
      { pubkey: poolTokenVaultA, isWritable: true, isSigner: false },
      { pubkey: poolTokenVaultB, isWritable: true, isSigner: false },
    ];

    // 6. Fund vaults
    await program.methods
      .fundVaults(new anchor.BN(1_000_000), new anchor.BN(1_000_000))
      .accounts({
        vaultA: tokenVaultA,
        vaultB: tokenVaultB,
        payerTokenA: payerTokenAccountA, // Add these
        payerTokenB: payerTokenAccountB, // Add these
        mintA: tokenMintA,
        mintB: tokenMintB,
        payer: provider.wallet.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    // 7. Execute rebalance
    const tx = await program.methods
      .rebalance()
      .accounts({
        manager: managerPDA,
        pool: poolKey,
        tokenVaultA,
        tokenVaultB,
        tokenMintA,
        tokenMintB,
        executor: executor.publicKey,
        positionAuthority: provider.wallet.publicKey,
        positionNftMint: positionNftMint,
        positionTokenAccount,
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
      .rpc();

    console.log("Rebalance tx:", tx);
    const managerState = await program.account.liquidityManager.fetch(
      managerPDA
    );
    assert.notEqual(
      managerState.currentLiquidity.toString(),
      "0",
      "Liquidity not updated"
    );
    assert.notEqual(managerState.lowerTick, -100, "Ticks not updated");
  });

  */
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
// });
