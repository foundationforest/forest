// The Forest escrow client: build every instruction, compute the clock start and each deadline
// from a market file's defaults and the parties' choices, produce the deposit address and its pay
// link, and decode the escrow account and its events. It talks to no network of its own: the
// caller reads accounts and sends transactions.
//
// Nothing here is shipped.

export * from './program.ts'
export * from './terms.ts'
export * from './pay.ts'
