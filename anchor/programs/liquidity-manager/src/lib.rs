use anchor_lang::{prelude::*, solana_program::{instruction::Instruction, program::invoke}};
use anchor_spl::{
    associated_token::AssociatedToken, token::{Mint, Token, TokenAccount}, token_interface::spl_pod::bytemuck 
};
use ::bytemuck::{Pod, Zeroable};
use bytemuck::{pod_maybe_from_bytes, pod_from_bytes};

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
    ) -> Result<()> {
        let manager = &mut ctx.accounts.manager;
        manager.authority = *ctx.accounts.authority.key;
        manager.pool = ctx.accounts.pool.key();
        manager.lower_tick = lower_tick;
        manager.upper_tick = upper_tick;
        
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
        // 1. Get current pool state
        let pool_data = ctx.accounts.pool.try_borrow_data()?.to_vec();
        let pool_state = pod_from_bytes::<RaydiumPoolState>(&pool_data)
            .map_err(|_| error!(LiquidityManagerError::InvalidPoolData))?;
        let current_tick = pool_state.current_tick;

        // 2. Check if rebalance is needed
        require!(
            current_tick < ctx.accounts.manager.lower_tick || 
            current_tick > ctx.accounts.manager.upper_tick,
            LiquidityManagerError::NoRebalanceNeeded
        );
    
        remove_liquidity(
            &ctx,
            ctx.accounts.manager.current_liquidity
        )?;

        swap_to_target_ratio(&ctx, current_tick)?;
        
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
            current_tick
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
    current_tick: i32
) -> Result<u128> {
    // In production, use Raydium's SDK formulas
    let liquidity = (amount_a as u128).checked_add(amount_b as u128)
        .ok_or(LiquidityManagerError::CalculationOverflow)?;
    Ok(liquidity)
}

fn remove_liquidity(
    ctx: &Context<Rebalance>,
    liquidity_to_remove: u128
) -> Result<()> {
    // 1. Prepare instruction data
    let mut data = Vec::new();
    data.push(0x03); // DecreaseLiquidity discriminator
    data.extend_from_slice(&liquidity_to_remove.to_le_bytes());
    data.extend_from_slice(&0u64.to_le_bytes()); // token_min_a
    data.extend_from_slice(&0u64.to_le_bytes()); // token_min_b

    // 2. Build instruction
    let ix = Instruction {
        program_id: RAYDIUM_CLMM_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(ctx.accounts.pool.key(), false),
            AccountMeta::new_readonly(ctx.accounts.executor.key(), true),
            AccountMeta::new(ctx.accounts.position_nft.key(), false),
            AccountMeta::new(ctx.accounts.position_token_account.key(), false),
            AccountMeta::new(ctx.accounts.token_vault_a.key(), false),
            AccountMeta::new(ctx.accounts.token_vault_b.key(), false),
            AccountMeta::new(ctx.accounts.pool_token_vault_a.key(), false),
            AccountMeta::new(ctx.accounts.pool_token_vault_b.key(), false),
            AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
        ],
        data,
    };

    // 3. Execute CPI
    invoke(
        &ix,
        &[
            ctx.accounts.pool.to_account_info(),
            ctx.accounts.executor.to_account_info(),
            ctx.accounts.position_nft.to_account_info(),
            ctx.accounts.position_token_account.to_account_info(),
            ctx.accounts.token_vault_a.to_account_info(),
            ctx.accounts.token_vault_b.to_account_info(),
            ctx.accounts.pool_token_vault_a.to_account_info(),
            ctx.accounts.pool_token_vault_b.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
        ],
    )?;

    Ok(())
}

fn swap_to_target_ratio(ctx: &Context<Rebalance>, target_tick: i32) -> Result<()> {
    // Use Jupiter CPI or Raydium swap
    // Calculate swap amount based on tick
    Ok(())
}

#[account]
pub struct LiquidityManager {
    pub authority: Pubkey,     // Admin wallet
    pub executor: Pubkey,      // Executor wallet (bot)
    pub pool: Pubkey,          // Raydium CL pool address
    pub token_mint_a: Pubkey,  // SOL mint
    pub token_mint_b: Pubkey,  // USDC mint
    pub lower_tick: i32,
    pub upper_tick: i32,
    pub current_liquidity: u128,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + 32 + 32 + 32 + 32 + 32 + 4 + 4,
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
    pub position_nft: AccountInfo<'info>,
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
    
    // External Programs
    pub raydium_program: AccountInfo<'info>,
    pub jupiter_program: AccountInfo<'info>,
}
#[derive(Debug, Clone, Copy)]
#[repr(C)]
pub struct RaydiumPoolState {
    pub status: u8,
    pub nonce: u8,
    pub current_tick: i32,  
}
unsafe impl Zeroable for RaydiumPoolState {}
unsafe impl Pod for RaydiumPoolState {}


#[error_code]
pub enum LiquidityManagerError {
    #[msg("Current tick is within range - no rebalance needed")]
    NoRebalanceNeeded,
    #[msg("Invalid executor")]
    InvalidExecutor,
    #[msg("The Pool Data is invalid")]
    InvalidPoolData,
    #[msg("")]
    CalculationOverflow
}