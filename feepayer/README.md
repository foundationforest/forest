# feepayer

The fee payer is a service that co-signs a person's transaction and charges their network fee in their dollar token, so people never need SOL. It is configuration of Kora, nothing more: no custom code. It holds none of the person's keys and decides nothing.

Nothing here is configured yet.

- **What it does.** The person's device builds the transaction and signs it with the person's own keys. The fee payer adds its signature as the transaction's payer, pays the network fee in SOL, takes the same value in the person's dollar token in the same transaction, and sends it.
- **Its one key** is its own, which pays network fees and holds a little SOL. It never holds a person's key.
- **What it checks** is mechanical: that the transaction calls programs its configuration lists (the registry, the escrow, the token programs) and that it is paid. Nothing about the person, the market or the deal.
- **Storage deposits.** Some transactions also take a storage deposit from their payer: a registration's code account, an escrow's two accounts, a token account made for someone. When the fee payer is the payer, its price has to count those deposits too, or it pays them on the person's behalf. Whether Kora's price counts a deposit taken inside a program call is not checked yet.
- **A registration** has three signing roles, in three account slots of `register`: the payer (the network fee and the code account's storage deposit), the fee authority (owner of the token account the 25 cents come from) and the profile's wallet (consent; the proof names it). The fee payer is the payer; the profile's wallet pays the 25 cents and signs. The program refuses a registration the profile's wallet did not sign.
- **Nothing it sees lets it take a badge.** It receives the profile-signed transaction before it lands. It can refuse to co-sign, but it cannot land the proof under its own key: the proof would not verify, and the person's code stays unused.

Anything paid on someone's behalf is an outside layer, never in the foundation: whoever pays for someone else is just another payer, and the programs cannot tell and never need to.
