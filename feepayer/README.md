Will hold the Kora configuration for the registration fee payer: sponsors any registration that carries a valid proof, rate-limited, no custom code.

Nothing here is configured yet. What the configuration has to allow, from the registry as it stands (session 11):

- **The sponsor co-signs for fees; the profile signs for consent.** A registration carries three signing roles, in three account slots of `register`: the payer (the network fee and the code account's rent), the fee authority (owner of the token account the fee comes from), and the profile's wallet (the key derived for that profile, which the proof's message names). On the sponsored path the sponsor is the payer and the fee authority; the profile's wallet always signs as well. A transaction the profile's wallet did not sign is refused by the program, and so is one where any other key sits in the profile's slot.
- **Sponsor only what the policy allows.** The market must be in the `markets` directory, and the proof must check out; rate-limited. The fee the sponsor pays is USDC's 0.25, or whatever the config records for another accepted mint.
- **Nothing the sponsor sees lets it take a badge.** The sponsor receives the profile-signed transaction before it lands. It can refuse to co-sign, but it cannot land the proof under its own key: the proof would not verify, and the person's code stays unused.
