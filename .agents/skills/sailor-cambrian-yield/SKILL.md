---
name: sailor-cambrian-yield
description: "Build a USDC yield-rotation agent that holds a position in whichever lending venue pays the best supply rate, using an off-chain rate feed (Cambrian) rather than on-chain reads. Covers the read → decide → act loop for position management: detecting where the position currently sits, comparing rates across venues, and rotating with a spread threshold and a cadence guard. Load this when the strategy is yield / earn / APY rotation across Aave v3, Morpho, Euler or similar ERC-4626 venues, and when rate data comes from a third-party HTTP API. Assumes the mandate is already planned — the permissions themselves are sailor-template-approve-batch (entry) and sailor-template-withdraw (exit)."
compatibility: A Sailor project (`@sail.money/sailor/sdk`, `sailor` CLI) with ApproveAndCallBatchPermission and WithdrawPermission both registered AND configured. Written against sailor v2.2.1 with WithdrawPermission v2 on Base (8453) with Aave v3, Morpho and Euler as venues, and Cambrian as the rate feed. The venue and feed specifics are replaceable; the failure modes are not.
---

# sailor-cambrian-yield — rate-driven position rotation on an external feed

You arrive here from the mandate plan ([`sailor-mandate-planner`](../sailor-mandate-planner/SKILL.md))
with a strategy spec whose shape is: *hold one position, in one venue, chosen by a number that
comes from outside the chain.*

This skill is the agent loop for that shape. It does not cover the permissions — entry is
[`sailor-template-approve-batch`](../sailor-template-approve-batch/SKILL.md), exit is
[`sailor-template-withdraw`](../sailor-template-withdraw/SKILL.md), and a rotating strategy
needs both, registered and configured.

Everything below was hit and verified during a live build, not reasoned about in advance.
Several of these look like nitpicks and are not: three of them will silently disable the agent
while every log line still reads as healthy.

## The shape

```
tick:
  reconcile prior dispatches against the chain
  read rates from the feed          → fail closed on any bad read
  read the position from the chain  → never from the ledger
  if idle    → redeploy into the best venue
  if deployed → rotate only if (spread ≥ threshold) AND (cadence elapsed)
```

Two branches, not one. Idle is not a degenerate case of deployed — it is what a half-finished
rotation leaves behind, and it must not be gated by the rotation cadence. If a withdraw lands
and the following deposit reverts, the capital sits in the SMA earning nothing. Making it wait
out a 24-hour cooldown before redeploying is a real cost caused by a lazy branch.

## Part 1 — the feed will lie to you, and you must fail closed

An agent built on a data source you do not control has more failure modes than an agent that
reads the chain. Every one of them must resolve to "do nothing", never to "assume zero".

### The response shape is not what naive parsing expects

Cambrian returns a columnar format:

```json
[{"columns": [{"name": "chainId", "type": "UInt16"}], "data": [[8453]], "rows": 1}]
```

Each entry in `columns` is an **object**, not a string, and each row is a **positional array**
aligned to that column order. Comparing a column object against a string name yields no match,
every index resolves to `-1`, every row is filtered out, and the agent skips the tick.

It does not error. It does not warn. It reports zero usable markets and holds, forever, looking
exactly like a correctly cautious agent.

```ts
const colNames = block.columns.map((c) =>
  typeof c === "string" ? c : (c as { name?: string })?.name ?? "",
);
const iApy = colNames.indexOf("supplyApy");
```

Also note the column naming is inconsistent across the venue endpoints: Aave and Morpho call
the asset column `underlyingSymbol`, Euler calls it `loanSymbol`. Pass the expected name in
per endpoint rather than assuming one.

One more identifier trap in the same family: Euler's `marketId` is a **compound** value holding
two addresses. The lending vault — the one you deposit into — is the **first** half. The second
is the collateral vault. Picking the wrong half writes a valid, deployed, completely wrong
address into the mandate, and nothing downstream complains. Verify by calling `asset()` on the
address you extracted and confirming it returns the token you expect, before it reaches a
permission config.

Verifying an address this way proves **identity**, not **usability**. `asset()`
returning the token you expect tells you the vault is what it claims to be. It
tells you nothing about whether the vault will accept the deposit your permission
template actually sends. Those are different questions and the second one is the
one that spends gas.


### Some rows are corrupt, and they are always the most attractive ones

`supplyApy` is a decimal — `0.0442` means 4.42%. Small Morpho USDC vaults on Base returned
values like `2979`. An agent that sorts by rate and takes the top row will route the entire
position into a broken record, because a corrupt number sorts above every real one.

Bound it:

```ts
const MAX_SUPPLY_APY = 0.3; // nothing above 30% is a real stablecoin supply rate
```

Also drop any row whose rate or liquidity is `NaN`. A missing field must disqualify a venue,
not score it as zero.

Pair the ceiling with a liquidity floor. A high rate on a vault with no exit liquidity is a
position you cannot leave.

### The free tier rate-limits parallel requests

Three endpoints fetched concurrently returned `429` on two of the three. Sequential with
roughly 1.2 seconds between calls, and one retry on a 429, works reliably.

This costs about three seconds per tick on a daily schedule. There is no reason to optimise it.

### If you cannot read the rate on the venue you are *in*, skip the tick

This is the rule that matters most, and it is not obvious until it happens.

On the first overnight tick, the Morpho fetch failed outright while Aave and Euler returned
normally. The position was in Morpho. The agent could see two rates and not the third — the
third being the one it was actually holding.

An agent that drops a failed venue and compares the survivors will rotate out of its own
position on a network blip, paying gas and slippage to move because of a transient HTTP error.
The comparison it thinks it is making is not a comparison at all.

```ts
const currentRate = rates.find((r) => r.id === current.id);
if (!currentRate) {
  // Fail closed. A missing number is not a low number.
  return [];
}
```

Generalised: **every read failure resolves to hold.** Not just bad values — missing values,
empty results, timeouts, and rate limits too. An agent whose data source is outside its control
should be biased toward inaction, because the cost of an unnecessary hold is one day of a
slightly worse rate, and the cost of an unnecessary move is real money spent on a decision
made from noise.

## Part 2 — the on-chain rules

### Read the position in assets, never in shares

This is the one that will cost you a working agent while everything looks fine.

For an ERC-4626 vault, `balanceOf(sma)` returns **shares**, and the share token frequently uses
18 decimals while the underlying asset uses 6. A 101 USDC position in a Morpho vault reads as
`91868893613457354668`.

Hand that number to `withdraw(assets, receiver, owner)` and you are asking the vault for
ninety-one trillion USDC. If a per-transaction cap is configured, the dispatch clamps to the
cap and asks for 250 USDC out of a position holding 101 — and reverts. Every rotation fails,
forever, and the daily "no rotate" ticks in between keep looking perfectly healthy.

Convert before you compare or spend:

```ts
const assets = await vault.read.convertToAssets([shares]);
```

Aave is the exception — its aToken balance is already denominated in the underlying asset at
the same decimals, so it needs no conversion. That asymmetry is precisely what makes the bug
survivable in testing: whichever venue you happen to check first may be the one that works.

Name the field `assets`, not `shares`, so the unit is visible at every call site. The original
code carried a comment acknowledging that the value was shares being passed into an assets
argument. Writing it down did not prevent it. Naming it would have.

### `withdraw`, never `redeem`

Sail's per-transaction cap is enforced against **calldata slot 0**. For `withdraw(assets, ...)`
slot 0 is an asset amount. For `redeem(shares, ...)` slot 0 is a share count.

Same cap, same permission, completely different meaning. A 250 USDC cap against a share count
is not a 250 USDC limit — it is whatever 250 shares happen to be worth, which drifts as the
vault accrues.

Use `withdraw`. Configure the cap in asset terms. Never mix.

### Withdraw one base unit less than you hold

`deposit(assets)` mints `floor(shares)`. Withdrawing that exact asset amount back out requires
`ceil(shares)`, which is one more share than exists, and the call reverts —
`NotEnoughAvailableUserBalance` on Aave, an EVC authorisation error on Euler.

```ts
const assets = amt > 0n ? amt - 1n : 0n;
```

One base unit of dust stays in the venue. At 6 decimals that is a millionth of a dollar. Accept
it.

## Part 3 — the agent's memory decides what the agent does next

See [`sailor-memory`](../sailor-memory/SKILL.md) for the ledger itself. Two things specific to a
rotating strategy.

### A wrong label in the ledger is a behaviour change, not a cosmetic one

The cadence guard reads the ledger to find the last confirmed rotation. If a plain deposit gets
written as a rotation, the 24-hour clock starts on a deposit, and the agent freezes for a full
day without a single thing in the log looking wrong.

That happened. The reconciler classified any non-approve call as a rotation by default, so the
very first deposit — an idle redeploy, not a rotation — armed the cooldown.

Classify from the transaction's actual selectors:

| selector     | call                    | meaning            |
|--------------|-------------------------|--------------------|
| `0x6e553f65` | ERC-4626 `deposit`      | entry              |
| `0x617ba037` | Aave `supply`           | entry              |
| `0xb460af94` | ERC-4626 `withdraw`     | exit               |
| `0x69328dec` | Aave `withdraw`         | exit               |
| `0x095ea7b3` | `approve`               | bookkeeping only   |

A rotation contains an exit. A deposit alone is not a rotation. Anything you cannot classify is
`unverified`, never a guess.

The broader rule: **in an agent that reads its own history to decide what to do, a labelling bug
is a control-flow bug.** Treat the ledger's schema with the same care as the dispatch logic.

### Read the position from the chain, never from what you meant to do

The ledger records intent and outcome. It is not a source of truth about where the money is. A
dispatch can revert, land partially, or land and be reconciled late. Read balances every tick.

## Part 4 — testing, and why a passing suite proved nothing

This is the finding worth the most to anyone building here, and it generalises past Sail
entirely.

The build had a Base-fork integration test whose header claimed it proved the agent's exact
deposit and withdraw calldata against all three live venues — selectors, encoding, and
recipient pinning. The whole suite passed. It did not catch the shares-as-assets bug described
above, and it could not have.

The test was Solidity. The agent is TypeScript. Forge cannot import the agent's functions, so
the test necessarily **reimplemented** the calls it claimed to be validating — with hardcoded,
correctly-denominated asset amounts. It proved that ERC-4626 deposit and withdraw work on Base
when called with sensible numbers. That was true, and entirely irrelevant.

**A test written in a different language from the code under test does not test that code. It
tests a second implementation that happens to agree with your assumptions.**

The fix is a calldata fixture. A small script imports the agent's real functions, runs them
against a live read, and writes the resulting bytes to JSON. The fork test loads that JSON and
replays the exact bytes.

```
scripts/gen-fixtures.ts     imports readPosition, depositBatch, withdrawCall
                            → contracts/test/fixtures/*.json
YieldRotateFork.t.sol       vm.readFile → vm.parseJsonBytes → replay verbatim
```

Now the fixture *is* the agent's output, so the test cannot pass while the agent is broken.

Two assertions that would have caught the original bug, and that a revert-only test never will:

- The withdrawn amount must land within a few percent of the position value. A test that only
  checks "did not revert" is nearly worthless for a strategy whose entire job is moving the
  right amount.
- The position value read by the agent must agree with the venue's own `maxWithdraw(sma)`. That
  single assertion is a direct unit check — a share balance will never match it.

Cover every venue on both legs, including venues you hold no position in. Deal the fork a
balance, replay the deposit fixture to create a position, then replay the withdraw against it.
The venue you are not currently in is exactly the one the next rotation moves to.

The fixture is block-specific, since accrual shifts the position between blocks. Regenerate
before running.

### And a fork test still is not a dispatch

Everything above hardens the calldata. None of it proves the venue will accept that
calldata *through the permission*.

A fork test deals itself a balance and pranks the SMA, so it calls the vault directly.
The live path goes through the Sail kernel, which is a different caller in a different
context. Sail's own `mandate simulate` is closer but still off-chain, and on a proxied
vault it reports a false negative: it scans the proxy's bytecode, finds no selectors
there, and warns that the function does not exist.

This is not hypothetical. On this build, one of three venues passed the fixture replay,
passed a live `asset()` check, and then reverted on the first real rotation with an
inner ERC-20 allowance error, from a batch byte-for-byte identical in shape to the venue
that works. The withdraw leg had already succeeded, so the capital landed idle in the
SMA. Cause still unresolved at time of writing; that venue is disabled.

**Treat a venue as unproven until real funds have moved through it in both directions.**
A venue that has only ever been tested is a venue you will discover on the day it
matters. If that means going live with fewer venues than you planned, go live with
fewer venues.


## Part 5 — operating notes

**Anything the agent prints goes into the Sail dashboard.** `sailor` pipes the agent's stdout
into the activity feed, where it sits alongside real dispatch events and stays there. Debug
logging pollutes a permanent, public-facing record. Log the decision and the reason, not the
intermediate state. Strip debug output before going live.

**Restarting the service is not optional after a code change.** The daemon holds the version of
the agent loaded when the process started. Editing the file changes nothing about what is
currently ticking. This is obvious and it is still easy to spend a day watching a fixed agent
run broken code.

**Watch the gas balance on the manager wallet.** It funds every dispatch. If it drains, the
agent keeps ticking and keeps failing.

## Known Sailor issues encountered (v2.2.1)

Reported separately; noted here so nobody loses an hour to them.

- `sailor service install --chain <id>` writes a unit that runs `sailor run --chain <id>`, but
  `run` only accepts `--chains`. The installer generates a permanently broken service.
  Installing with no chain flag works when the project has a single chain configured.
- `sailor keys show` does not read `SAIL_PASSPHRASE` from `.sail/.env.local` and prompts even
  when the value is correct — while its own error message points you at that file. The daemon
  reads it correctly, so the two commands disagree.

## Checklist before going live

- [ ] Column names extracted from column *objects*, not compared as strings
- [ ] Rate ceiling and liquidity floor applied; `NaN` disqualifies
- [ ] Feed endpoints fetched sequentially with a retry on 429
- [ ] Unreadable rate on the **current** venue skips the tick
- [ ] Position read in assets via `convertToAssets`, not shares
- [ ] `withdraw` used, never `redeem`; cap configured in asset terms
- [ ] Withdraw amount is position minus one base unit
- [ ] Reconciler classifies by selector; a deposit is never labelled a rotation
- [ ] Fork test replays the agent's own calldata and asserts on the amount received
- [ ] Every venue covered on both legs, including ones you do not currently hold
- [ ] Every venue proven by a real dispatch in both directions, not only on a fork
- [ ] Debug logging stripped
- [ ] Service restarted after the last code change
