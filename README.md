# sailor-cambrian-yield

A Sailor skill and reference implementation for a USDC yield-rotation agent: hold a position in
whichever lending venue pays the best supply rate, decide from an off-chain rate feed, and move
only when the improvement is worth the gas.

Built and run live on Base against Aave v3, Morpho and Euler, with rate data from
[Cambrian](https://docs.cambrian.org). The live agent is private; this is the skill file and a
stripped reference implementation.

## What's here

```
.agents/skills/sailor-cambrian-yield/SKILL.md   the skill — read this first
reference/src/agent.ts                          the agent loop
reference/scripts/gen-fixtures.ts               calldata fixture generator
reference/contracts/test/YieldRotateFork.t.sol  fork test that replays the agent's own calldata
reference/.env.example                          required environment variables
```

The `reference/` tree mirrors the layout of a scaffolded Sailor project, so the files sit where
they would in a real one. Drop the skill into any such project at
`.agents/skills/sailor-cambrian-yield/SKILL.md` and the agent will find it.

## The strategy

```
tick:
  reconcile prior dispatches against the chain
  read rates from the feed          → fail closed on any bad read
  read the position from the chain  → never from the ledger
  if idle     → redeploy into the best venue
  if deployed → rotate only if (spread ≥ threshold) AND (cadence elapsed)
```

Bounded by two configured permissions: `ApproveAndCallBatchPermission` for atomic
approve → deposit → reset on entry, and `WithdrawPermission` for exits, with a per-transaction
cap and the recipient pinned to the SMA on-chain. The agent never names a permission — the
runner routes each dispatch by call shape.

## Why the skill is worth reading

Everything in it broke during the build. Most of it breaks silently — the agent keeps ticking,
the logs keep reading as healthy, and the strategy quietly stops working.

**The feed lies.** Rate rows come back corrupt, and a corrupt rate always sorts to the top of a
"best rate" comparison. Column metadata arrives as objects rather than strings, so naive parsing
matches nothing and skips every tick without an error. The free tier rate-limits parallel
requests. Identifiers are compound values where picking the wrong half yields a valid, deployed,
completely wrong address.

**Units diverge.** ERC-4626 vaults hold shares; the withdraw call spends assets; the two are
frequently different scales. A 101 USDC position reads as a nineteen-digit share balance. Feed
that number to a withdraw and every rotation reverts, forever, while the ticks in between look
fine. Aave doesn't behave this way, which is exactly why the bug survives a partial test.

**Memory is control flow.** The cadence guard reads the agent's own ledger to decide whether it
may act. A deposit mislabelled as a rotation froze the agent for a full day, with nothing in the
log looking wrong.

**And a passing test suite proved nothing.** The original fork test was Solidity; the agent is
TypeScript. Forge can't import the agent's functions, so the test reimplemented the calls it
claimed to validate, using correctly-denominated amounts the agent never actually produced. It
passed. What it proved — that deposit and withdraw work on these venues when called with sensible
numbers — was true, and had nothing to do with the agent. That one generalises well past Sail:

> A test written in a different language from the code under test does not test that code. It
> tests a second implementation that happens to agree with your assumptions.

The fix is in `reference/scripts/gen-fixtures.ts`: a script imports the agent's real functions,
runs them against a live read, and writes the resulting calldata to JSON. The fork test replays
those exact bytes. The fixture *is* the agent's output, so the test can't pass while the agent is
broken.

Full detail, with the code, in [the skill file](.agents/skills/sailor-cambrian-yield/SKILL.md).

## Using the reference implementation

It is a reference, not a drop-in. Venue addresses, thresholds and the SMA come from environment
variables — see `reference/.env.example`. Nothing runs without a mandate you have planned,
registered and configured yourself.

The fixture generator reads live chain state, so regenerate before running the fork test. These
commands assume you have copied the contents of `reference/` into a scaffolded Sailor project and
are running from that project's root, not from this repo:

```
npx tsx scripts/gen-fixtures.ts
cd contracts && forge test --match-contract YieldRotateForkTest -vvv
```

## Sailor issues encountered (v2.2.1)

Reported to Sail separately; noted here so nobody loses an hour.

- `sailor service install --chain <id>` writes a systemd unit that runs `sailor run --chain <id>`,
  but `run` only accepts `--chains`. The installer generates a permanently broken service.
  Installing with no chain flag works on a single-chain project.
- `sailor keys show` doesn't read `SAIL_PASSPHRASE` from `.sail/.env.local` and prompts even when
  the value is correct — while its own error message points you at that file. The daemon reads it
  correctly, so the two commands disagree.

## Licence

MIT.
