use anchor_lang::prelude::*;

declare_id!("6nyHyzxQqGgUWquuvqfnusJNL6FHGmGTTcoRok4MZQ4q");

#[program]
pub mod test_pool {
    use super::*;

    pub fn initialize_pool(ctx: Context<InitializePool>, status: u8, nonce: u8, current_tick: i32) -> Result<()> {
        let mut data = ctx.accounts.pool.data.borrow_mut();
        data[0] = status;
        data[1] = nonce;
        data[2..6].copy_from_slice(&current_tick.to_le_bytes());
        Ok(())
    }

    pub fn update_pool(ctx: Context<UpdatePool>, tick: i32) -> Result<()> {
        let mut data = ctx.accounts.pool.data.borrow_mut();
        data[2..6].copy_from_slice(&tick.to_le_bytes());
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializePool<'info> {
    /// Manually allocated account (without Anchor #[account] macro)
    #[account(mut)]
    pub pool: AccountInfo<'info>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdatePool<'info> {
    #[account(mut)]
    pub pool: AccountInfo<'info>,
}
