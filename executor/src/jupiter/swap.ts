import { Jupiter } from "@jup-ag/core";

async function prepareSwapIx(
  inputMint: PublicKey,
  outputMint: PublicKey,
  amount: number,
  user: PublicKey
): Promise<{ ix: TransactionInstruction; accounts: AccountMeta[] }> {
  const jupiter = await Jupiter.load({ connection });

  const route = await jupiter
    .computeRoutes({
      inputMint,
      outputMint,
      amount,
      slippage: 1, // 1%
    })
    .then((r) => r[0]);

  return {
    ix: await jupiter.exchange({ route }),
    accounts: route.accounts,
  };
}
