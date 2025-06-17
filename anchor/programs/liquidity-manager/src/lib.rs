use anchor_lang::{prelude::*, solana_program::{instruction::Instruction, program::invoke}};
use anchor_spl::{
    associated_token::AssociatedToken, token::{Mint, Token, TokenAccount}, token_interface::spl_pod::bytemuck 
};
use anchor_lang::solana_program::account_info::AccountInfo;
use ::bytemuck::{Pod, Zeroable};
use bytemuck::{pod_from_bytes};

pub const RAYDIUM_CLMM_PROGRAM_ID: Pubkey = pubkey!("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");  // Should be in an .env

declare_id!("BqNn2BhDXSvHPgNB9XQWrysvMRkDyChUBnVuhRHTz3Eq");

#[program]
pub mod liquidity_manager {
    use super::*;

    // Initializes the manager with a Raydium pool and token vaults
    pub fn initialize(
        ctx: Context<Initialize>,
        lower_tick: i32,
        upper_tick: i32,
        executor: Pubkey,
    ) -> Result<()> {
        let manager = &mut ctx.accounts.manager;
        manager.authority = *ctx.accounts.authority.key;
        manager.pool = ctx.accounts.pool.key();
        manager.token_mint_a = ctx.accounts.token_mint_a.key(); 
        manager.token_mint_b = ctx.accounts.token_mint_b.key(); 
        manager.token_vault_a = ctx.accounts.token_vault_a.key(); 
        manager.token_vault_b = ctx.accounts.token_vault_b.key(); 
        manager.lower_tick = lower_tick;
        manager.upper_tick = upper_tick;
        manager.executor = executor;
        manager.current_liquidity = 0; 
        
        // Token vaults are automatically created by Anchor via #[account(init)]
        msg!(
            "Manager initialized for pool: {}. Vault A: {}, Vault B: {}",
            manager.pool,
            ctx.accounts.token_vault_a.key(),
            ctx.accounts.token_vault_b.key()
        );
        Ok(())
    }

    // Updates the target tick range (admin-only)
    pub fn update_range(ctx: Context<UpdateRange>, lower: i32, upper: i32) -> Result<()> {
        let manager = &mut ctx.accounts.manager;
        manager.lower_tick = lower;
        manager.upper_tick = upper;
        Ok(())
    }



    pub fn rebalance(ctx: Context<Rebalance>) -> Result<()> {

        msg!("Accounts received:");
        for account in ctx.remaining_accounts.iter() {
            msg!("- {} (writable: {}, signer: {})", 
                account.key(), 
                account.is_writable,
                account.is_signer
            );
        }
    
        msg!("Attempting to manually deserialize pool data...");
        let pool_data = ctx.accounts.pool.try_borrow_data()?;
        msg!("Raw data length: {}", pool_data.len());
    
        let display_len = pool_data.len().min(32);
        msg!("First {} bytes: {:?}", display_len, &pool_data[..display_len]);
    
        if pool_data.len() < 6 {
            msg!("Error: Pool data too short");
            return err!(LiquidityManagerError::InvalidPoolData);
        }
    
        // Manual byte extraction
        let status = pool_data[0];
        let nonce = pool_data[1];
        let current_tick = i32::from_le_bytes([pool_data[2], pool_data[3], pool_data[4], pool_data[5]]);
    
        msg!("Manually parsed Pool State => status: {}, nonce: {}, current_tick: {}", status, nonce, current_tick);
    
        // Now use current_tick as before
        require!(
            current_tick < ctx.accounts.manager.lower_tick || 
            current_tick > ctx.accounts.manager.upper_tick,
            LiquidityManagerError::NoRebalanceNeeded
        );
        /*    
        // Debug: Print pool account info
        msg!("Attempting to deserialize pool data...");
        let pool_data = ctx.accounts.pool.try_borrow_data()?.to_vec();
        msg!("Raw data length: {}", pool_data.len());
        
        // Print first 32 bytes for debugging
        let display_len = pool_data.len().min(32);
        msg!("First {} bytes: {:?}", display_len, &pool_data[..display_len]);
        
        
        let pool_state = pod_from_bytes::<RaydiumPoolState>(&pool_data)
            .map_err(|e| {
                msg!("Deserialization error: {:?}", e);
                LiquidityManagerError::InvalidPoolData
            })?;

        let pool_state = deserialize_pool_state(&pool_data)
            .map_err(|e| {
                msg!("Deserialization error: {:?}", e);
                LiquidityManagerError::InvalidPoolData
            })?;
            
        msg!("Pool State current Tick: {}",  pool_state.current_tick);

        let current_tick = pool_state.current_tick;

        // 2. Check if rebalance is needed
        require!(
            current_tick < ctx.accounts.manager.lower_tick || 
            current_tick > ctx.accounts.manager.upper_tick,
            LiquidityManagerError::NoRebalanceNeeded
        );
    */
        remove_liquidity(
            &ctx,
            ctx.accounts.manager.current_liquidity
        )?;

        /*
        swap_to_target_ratio(
            ctx, 
            current_tick
        );
         */

         let swap_ix = jupiter_swap_instruction(
            &ctx.accounts.token_vault_a.key(),
            &ctx.accounts.token_vault_b.key(),
            ctx.accounts.token_vault_a.amount, // Swap 100% of Token A
            1,                                // Minimum out (adjust for slippage)
            ctx.accounts.jupiter_program.key(),
        )?;

         // 2. Execute swap
        invoke(
            &swap_ix,
            &[
                ctx.accounts.token_vault_a.to_account_info(),
                ctx.accounts.token_vault_b.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
            ],
        )?;

        // 3. Calculate new ticks (centered around current price)
        let new_lower_tick = current_tick - 100;
        let new_upper_tick = current_tick + 100;
    
        // 4. Get token amounts from vaults
        let token_a_amount = ctx.accounts.token_vault_a.amount;
        let token_b_amount = ctx.accounts.token_vault_b.amount;
    
        // 5. Calculate liquidity parameters
        let liquidity = calculate_liquidity(
            new_lower_tick,
            new_upper_tick,
            token_a_amount,
            token_b_amount,
            current_tick,
            ctx.accounts.token_mint_a.decimals, // Add token A decimals
            ctx.accounts.token_mint_b.decimals, // Add token B decimals
        )?;


        // 6. Add 10% slippage buffer
        let token_a_max = token_a_amount.checked_mul(110).unwrap() / 100;
        let token_b_max = token_b_amount.checked_mul(110).unwrap() / 100;

        // 7. Execute CPI
        add_liquidity_cpi(
            &ctx,
            new_lower_tick,
            new_upper_tick,
            liquidity,
            token_a_max,
            token_b_max
        )?;
    
        // 8. Update manager state
        let manager = &mut ctx.accounts.manager;
        manager.lower_tick = new_lower_tick;
        manager.upper_tick = new_upper_tick;
    
        Ok(())
    }
    
    pub fn fund_vaults(ctx: Context<FundVaults>, amount_a: u64, amount_b: u64) -> Result<()> {
        // Transfer token A
        anchor_spl::token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                anchor_spl::token::Transfer {
                    from: ctx.accounts.payer_token_a.to_account_info(),
                    to: ctx.accounts.vault_a.to_account_info(),
                    authority: ctx.accounts.payer.to_account_info(),
                },
            ),
            amount_a,
        )?;
    
        // Transfer token B
        anchor_spl::token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                anchor_spl::token::Transfer {
                    from: ctx.accounts.payer_token_b.to_account_info(),
                    to: ctx.accounts.vault_b.to_account_info(),
                    authority: ctx.accounts.payer.to_account_info(),
                },
            ),
            amount_b,
        )?;
    
        Ok(())
    }
}

#[test]
fn test_struct_size() {
    println!("Struct size: {}", std::mem::size_of::<RaydiumPoolState>());
}

#[test]
fn test_struct_layout() {
    use std::mem;
    println!("RaydiumPoolState size: {}", mem::size_of::<RaydiumPoolState>());
    
    // Manually verify offsets (less precise but works)
    let dummy = RaydiumPoolState {
        status: 0,
        nonce: 0,
        current_tick: 0,
    };
    
    unsafe {
        println!("Status offset: {}", 
            (&dummy.status as *const _ as usize) - (&dummy as *const _ as usize));
        println!("Nonce offset: {}", 
            (&dummy.nonce as *const _ as usize) - (&dummy as *const _ as usize));
        println!("Current tick offset: {}", 
            (&dummy.current_tick as *const _ as usize) - (&dummy as *const _ as usize));
    }
}

// revisar si esta funcion esta interna o externa.
pub fn add_liquidity_cpi(
    ctx: &Context<Rebalance>,
    lower_tick: i32,
    upper_tick: i32,
    liquidity_amount: u128,
    token_max_a: u64,
    token_max_b: u64,
) -> Result<()> {

    let mut data = vec![0x02]; // IncreaseLiquidity discriminator
    data.extend_from_slice(&lower_tick.to_le_bytes());
    data.extend_from_slice(&upper_tick.to_le_bytes());
    data.extend_from_slice(&liquidity_amount.to_le_bytes());
    data.extend_from_slice(&token_max_a.to_le_bytes());
    data.extend_from_slice(&token_max_b.to_le_bytes());

    let ix = Instruction {
        program_id: RAYDIUM_CLMM_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(ctx.accounts.pool.key(), false),
            AccountMeta::new(ctx.accounts.position_authority.key(), true),
            AccountMeta::new(ctx.accounts.position_nft_mint.key(), false),
            AccountMeta::new(ctx.accounts.position_token_account.key(), false),
            AccountMeta::new(ctx.accounts.tick_array_lower.key(), false),
            AccountMeta::new(ctx.accounts.tick_array_upper.key(), false),
            AccountMeta::new(ctx.accounts.token_owner_account_a.key(), false),
            AccountMeta::new(ctx.accounts.token_owner_account_b.key(), false),
            AccountMeta::new(ctx.accounts.token_vault_a.key(), false),
            AccountMeta::new(ctx.accounts.token_vault_b.key(), false),
            AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
        ],
        data,
    };

    invoke(
        &ix,
        &[
            ctx.accounts.pool.to_account_info(),
            ctx.accounts.position_authority.to_account_info(),
            ctx.accounts.position_nft_mint.to_account_info(),
            ctx.accounts.position_token_account.to_account_info(),
            ctx.accounts.tick_array_lower.to_account_info(),
            ctx.accounts.tick_array_upper.to_account_info(),
            ctx.accounts.token_owner_account_a.to_account_info(),
            ctx.accounts.token_owner_account_b.to_account_info(),
            ctx.accounts.token_vault_a.to_account_info(),
            ctx.accounts.token_vault_b.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
        ],
    )?;

    Ok(())
}

// Helper function (simplified)
fn calculate_liquidity(
    lower_tick: i32,
    upper_tick: i32,
    amount_a: u64,
    amount_b: u64,
    current_tick: i32,
    token_a_decimals: u8,
    token_b_decimals: u8,
) -> Result<u128> {
    // 1. Convert ticks to sqrt prices
    let sqrt_price_lower = tick_to_sqrt_price(lower_tick)?;
    let sqrt_price_upper = tick_to_sqrt_price(upper_tick)?;
    let sqrt_price_current = tick_to_sqrt_price(current_tick)?;

    // 2. Adjust amounts for decimals
    let amount_a = adjust_for_decimals(amount_a, token_a_decimals)?;
    let amount_b = adjust_for_decimals(amount_b, token_b_decimals)?;

    // 3. Calculate liquidity based on position relative to current tick
    if current_tick < lower_tick {
        // Position is entirely in token B (right of range)
        Ok(calculate_liquidity_b(
            amount_b,
            sqrt_price_lower,
            sqrt_price_upper
        )?)
    } else if current_tick >= upper_tick {
        // Position is entirely in token A (left of range)
        Ok(calculate_liquidity_a(
            amount_a,
            sqrt_price_lower,
            sqrt_price_upper
        )?)
    } else {
        // Position is active (within range)
        Ok(std::cmp::min(
            calculate_liquidity_a(amount_a, sqrt_price_current, sqrt_price_upper)?,
            calculate_liquidity_b(amount_b, sqrt_price_lower, sqrt_price_current)?,
        ))
    }

}


/// Converts tick to sqrt price (Q64.64 fixed point)
fn tick_to_sqrt_price(tick: i32) -> Result<u128> {
    // Raydium uses Q64.64 fixed point sqrt price
    let sqrt_price = (1.0001f64.powi(tick)).sqrt();
    Ok((sqrt_price * (1u128 << 64) as f64) as u128)
}

/// Calculates liquidity when position is all token A
fn calculate_liquidity_a(amount_a: u128, sqrt_price_low: u128, sqrt_price_high: u128) -> Result<u128> {
    let sqrt_diff = sqrt_price_high.checked_sub(sqrt_price_low)
        .ok_or(LiquidityManagerError::InvalidTickRange)?;
    
    amount_a
        .checked_mul(sqrt_price_high)
        .and_then(|v| v.checked_mul(sqrt_price_low))
        .and_then(|v| v.checked_div(sqrt_diff))
        .ok_or(LiquidityManagerError::CalculationOverflow.into())
}

fn calculate_liquidity_b(amount_b: u128, sqrt_price_low: u128, sqrt_price_high: u128) -> Result<u128> {
    let sqrt_diff = sqrt_price_high.checked_sub(sqrt_price_low)
        .ok_or(LiquidityManagerError::InvalidTickRange)?;
    
    amount_b
        .checked_mul(1u128 << 64)
        .and_then(|v| v.checked_div(sqrt_diff))
        .ok_or(LiquidityManagerError::CalculationOverflow.into())
}

/// Adjusts token amount for decimals (convert to native units)
fn adjust_for_decimals(amount: u64, decimals: u8) -> Result<u128> {
    Ok(amount as u128 * 10u128.pow(decimals as u32))
}

fn remove_liquidity(
    ctx: &Context<Rebalance>,
    liquidity_to_remove: u128
) -> Result<()> {

    msg!("¨Starting the removal of liquidity");

    // 1. Prepare instruction data
    let mut data = Vec::new();
    data.push(0x03); // DecreaseLiquidity discriminator
    data.extend_from_slice(&liquidity_to_remove.to_le_bytes());
    data.extend_from_slice(&0u64.to_le_bytes()); // token_min_a
    data.extend_from_slice(&0u64.to_le_bytes()); // token_min_b

    msg!("Finished preparation of instruction");

    // 2. Build instruction
    let ix = Instruction {
        program_id: RAYDIUM_CLMM_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(ctx.accounts.pool.key(), false),
            AccountMeta::new_readonly(ctx.accounts.executor.key(), true),
            AccountMeta::new(ctx.accounts.position_nft_mint.key(), false),
            AccountMeta::new(ctx.accounts.position_token_account.key(), false),
            AccountMeta::new(ctx.accounts.token_vault_a.key(), false),
            AccountMeta::new(ctx.accounts.token_vault_b.key(), false),
            AccountMeta::new(ctx.accounts.pool_token_vault_a.key(), false),
            AccountMeta::new(ctx.accounts.pool_token_vault_b.key(), false),
            AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
        ],
        data,
    };

    msg!("¨Build instruction complete");

    // 3. Execute CPI
    invoke(
        &ix,
        &[
            ctx.accounts.pool.to_account_info(),
            ctx.accounts.executor.to_account_info(),
            ctx.accounts.position_nft_mint.to_account_info(),
            ctx.accounts.position_token_account.to_account_info(),
            ctx.accounts.token_vault_a.to_account_info(),
            ctx.accounts.token_vault_b.to_account_info(),
            ctx.accounts.pool_token_vault_a.to_account_info(),
            ctx.accounts.pool_token_vault_b.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
        ],
    )?;

    msg!("Completed CPI");

    Ok(())
}

pub fn swap_to_target_ratio(
    ctx: Context<Rebalance>,
    swap_ix_data: Vec<u8>,
) -> Result<()> {
    invoke(
        &Instruction {
            program_id: ctx.accounts.jupiter_program.key(),
            accounts: ctx.remaining_accounts.iter()
                .map(|a| AccountMeta {
                    pubkey: a.key(),
                    is_signer: a.is_signer,
                    is_writable: a.is_writable,
                })
                .collect(),
            data: swap_ix_data,
        },
        ctx.remaining_accounts,
    )?;
    Ok(())
}

fn jupiter_swap_instruction(
    input_mint: &Pubkey,
    output_mint: &Pubkey,
    amount_in: u64,
    min_amount_out: u64,
    jupiter_program: Pubkey,
) -> Result<Instruction> {
    let mut data = vec![0x01]; // Jupiter swap instruction discriminator
    data.extend_from_slice(&amount_in.to_le_bytes());
    data.extend_from_slice(&min_amount_out.to_le_bytes());

    Ok(Instruction {
        program_id: jupiter_program,
        accounts: vec![
            AccountMeta::new(*input_mint, false),
            AccountMeta::new(*output_mint, false),
        ],
        data,
    })
}

fn deserialize_pool_state(data: &[u8]) -> Result<RaydiumPoolState> {
    require!(
        data.len() < 6,
        LiquidityManagerError::InvalidAccountData
    );

    let status = data[0];
    let nonce = data[1];
    let current_tick = i32::from_le_bytes([data[2], data[3], data[4], data[5]]);

    Ok(RaydiumPoolState {
        status,
        nonce,
        current_tick,
    })
}

#[account]
pub struct LiquidityManager {
    pub authority: Pubkey,     // Admin wallet
    pub executor: Pubkey,      // Executor wallet (bot)
    pub pool: Pubkey,          // Raydium CL pool address
    pub token_mint_a: Pubkey,  // SOL mint
    pub token_mint_b: Pubkey,  // USDC mint
    pub token_vault_a: Pubkey, // Add this
    pub token_vault_b: Pubkey, // Add this
    pub lower_tick: i32,
    pub upper_tick: i32,
    pub current_liquidity: u128,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + 32 * 7 + 4 * 2 + 16,
        seeds = [b"manager", pool.key().as_ref()],
        bump
    )]
    pub manager: Account<'info, LiquidityManager>,
    // Token vaults (automatically created by Anchor)
    #[account(
        init,
        payer = authority,
        associated_token::mint = token_mint_a,
        associated_token::authority = manager,
    )]
    pub token_vault_a: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = authority,
        associated_token::mint = token_mint_b,
        associated_token::authority = manager,
    )]
    pub token_vault_b: Account<'info, TokenAccount>,
    
    // Raydium CL pool (validate it's a real pool)
    #[account(mut)]
    pub pool: AccountInfo<'info>,
    pub token_mint_a: Box<Account<'info, Mint>>,  // SOL
    pub token_mint_b: Box<Account<'info, Mint>>,  // USDC
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

#[derive(Accounts)]
pub struct UpdateRange<'info> {
    #[account(mut, has_one = authority)]
    pub manager: Account<'info, LiquidityManager>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct Rebalance<'info> {
    // Core Program Accounts
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
    // Authority Accounts
    #[account(mut, has_one = executor)]
    pub manager: Account<'info, LiquidityManager>,
    pub executor: Signer<'info>,
    pub position_authority: Signer<'info>,
    // Pool & Position Accounts
    #[account(mut)]
    pub pool: AccountInfo<'info>,
    #[account(mut)]
    pub position_nft_mint: AccountInfo<'info>,
    #[account(mut)]
    pub position_token_account: AccountInfo<'info>,
    // Tick Arrays
    pub tick_array_lower: AccountInfo<'info>,
    pub tick_array_upper: AccountInfo<'info>,
    // Token Vaults (Yours)
    #[account(mut)]
    pub token_vault_a: Account<'info, TokenAccount>,
    #[account(mut)]
    pub token_vault_b: Account<'info, TokenAccount>,
    #[account(mut)]
    pub token_owner_account_a: AccountInfo<'info>,
    #[account(mut)]
    pub token_owner_account_b: AccountInfo<'info>,
    // Pool Token Vaults (Raydium's)
    #[account(mut)]
    pub pool_token_vault_a: AccountInfo<'info>,
    #[account(mut)]
    pub pool_token_vault_b: AccountInfo<'info>,
    // Token Mints
    #[account(
        address = manager.token_mint_a,
        constraint = token_vault_a.mint == token_mint_a.key()
    )]
    pub token_mint_a: Box<Account<'info, Mint>>,

    #[account(
        address = manager.token_mint_b,
        constraint = token_vault_b.mint == token_mint_b.key()
    )]
    pub token_mint_b: Box<Account<'info, Mint>>,
    // External Programs
    pub raydium_program: AccountInfo<'info>,
    pub jupiter_program: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct FundVaults<'info> {
    #[account(mut)]
    pub vault_a: Account<'info, TokenAccount>,
    #[account(mut)]
    pub vault_b: Account<'info, TokenAccount>,
    #[account(mut)]
    pub payer_token_a: Account<'info, TokenAccount>,
    #[account(mut)]
    pub payer_token_b: Account<'info, TokenAccount>,
    #[account(mut)]
    pub mint_a: Account<'info, Mint>,
    #[account(mut)]
    pub mint_b: Account<'info, Mint>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub token_program: Program<'info, Token>,
}


//#[repr(C/*, packed)*/]
#[derive(Debug, Clone, Copy)]
pub struct RaydiumPoolState {
    pub status: u8,
    pub nonce: u8,
    pub current_tick: i32,  
}
/*
unsafe impl Zeroable for RaydiumPoolState {}
unsafe impl Pod for RaydiumPoolState {}*/


#[error_code]
pub enum LiquidityManagerError {
    #[msg("Current tick is within range - no rebalance needed")]
    NoRebalanceNeeded,
    #[msg("Invalid executor")]
    InvalidExecutor,
    #[msg("The Pool Data is invalid")]
    InvalidPoolData,
    #[msg("")]
    CalculationOverflow,
    #[msg("No Account Found")]
    AccountNotFound,
    #[msg("Tick is in invalid Range")]
    InvalidTickRange,
    #[msg("Account Data is wrong")]
    InvalidAccountData,
}