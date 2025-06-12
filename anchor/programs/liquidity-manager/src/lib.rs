use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    //account_info::AccountInfo,
    entrypoint::ProgramResult,
    program_error::ProgramError,
};

declare_id!("BqNn2BhDXSvHPgNB9XQWrysvMRkDyChUBnVuhRHTz3Eq");

#[program]   
pub mod liquidity_manager {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        msg!("Greetings from: {:?}", ctx.program_id);
        Ok(())
    }

  
    pub fn update_range(ctx: Context<UpdateRange>, lower: i32, upper: i32) -> Result<()> {
        let manager = &mut ctx.accounts.manager;
        manager.lower_tick = lower;
        manager.upper_tick = upper;
        Ok(())
    }


}


#[account]
pub struct LiquidityManager {
    pub authority: Pubkey, // owner of the bot
    pub pool: Pubkey,      // CLMM pool
    pub lower_tick: i32,
    pub upper_tick: i32,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = user, space = 8 + 64)]
    pub manager: Account<'info, LiquidityManager>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateRange<'info> {
    #[account(mut, has_one = authority)]
    pub manager: Account<'info, LiquidityManager>,
    pub authority: Signer<'info>,
}

