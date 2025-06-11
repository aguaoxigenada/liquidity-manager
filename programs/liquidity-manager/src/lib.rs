use anchor_lang::prelude::*;

declare_id!("BqNn2BhDXSvHPgNB9XQWrysvMRkDyChUBnVuhRHTz3Eq");

#[program]
pub mod liquidity_manager {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        msg!("Greetings from: {:?}", ctx.program_id);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}
