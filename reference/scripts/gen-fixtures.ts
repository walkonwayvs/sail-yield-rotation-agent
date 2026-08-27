/**
 * Fixture generator for YieldRotateFork.t.sol.
 *
 * Imports the agent's REAL code paths — readPosition(), withdrawCall(), and depositBatch()
 * from src/agent.ts — runs them against a live Base RPC read (no transactions, no gas), and
 * writes the resulting calldata + position amounts to JSON fixtures under
 * contracts/test/fixtures/.
 *
 * The forge test replays those exact bytes against a live fork, instead of constructing its
 * own calls with hardcoded amounts. This is the structural fix: the test can no longer pass
 * while the agent's code is broken, because the fixture IS the agent's output.
 *
 * Deposit fixtures: for each venue (aave, morpho, euler), generate depositBatch() calldata
 * with a fixed deposit amount. The test deals the fork that amount, replays the deposit,
 * and asserts shares/tokens were minted.
 *
 * Withdraw fixtures:
 *  - If the SMA has a live deployed position → readPosition() + withdrawCall() against it.
 *  - If no live position → generate a withdraw fixture against a SYNTHETIC deposit. We can't
 *    call depositBatch() on-chain (that would be a transaction / gas), so instead we produce
 *    the withdraw calldata for a known deposit amount. The test deals USDC, runs the deposit
 *    first (from the agent's deposit fixture), then replays the withdraw against the position
 *    that creates.
 *
 * Configuration: SMA_ADDRESS, BASE_RPC_URL, and all venue/USDC/aToken addresses are read
 * from environment variables (see .env.example). No hardcoded addresses in this script.
 *
 * Usage: npx tsx scripts/gen-fixtures.ts
 * Reads BASE_RPC_URL and SMA_ADDRESS from the environment (or .env).
 */
import fs from "node:fs";
import path from "node:path";
import { createPublicClient, http, type Address, type PublicClient } from "viem";
import { base } from "viem/chains";
import type { AgentContext, AgentReads } from "@sail.money/sailor/sdk";
import { readPosition, withdrawCall, depositBatch } from "../src/agent.ts";

// ── Environment-resolved addresses ──────────────────────────────────────────
function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") throw new Error(`missing required env var: ${name} (see .env.example)`);
  return v.trim();
}

const SMA: Address = requireEnv("SMA_ADDRESS") as Address;
const USDC: Address = requireEnv("USDC_ADDRESS") as Address;
const AAVE_POOL: Address = requireEnv("AAVE_POOL_ADDRESS") as Address;
const AAVE_A_TOKEN: Address = requireEnv("AAVE_A_TOKEN_ADDRESS") as Address;
const MORPHO_VAULT: Address = requireEnv("MORPHO_VAULT_ADDRESS") as Address;
const EULER_VAULT: Address = requireEnv("EULER_VAULT_ADDRESS") as Address;
const RPC_URL: string = requireEnv("BASE_RPC_URL");

const VENUE_IDS = ["aave", "morpho", "euler"] as const;
type VenueId = (typeof VENUE_IDS)[number];

// The deposit amount used for synthetic positions (withdraw tests + all deposit tests).
// Well under the 250 USDC per-tx cap.
const DEPOSIT_AMOUNT = 100_000_000n;

// buildCtx: a minimal AgentContext stub satisfying only the fields readPosition() and the
// dispatch builders touch — ctx.safe, ctx.publicClient, ctx.read.balance.
function buildCtx(rpcUrl: string): AgentContext {
  const publicClient: PublicClient = createPublicClient({
    chain: base,
    transport: http(rpcUrl),
  });
  const read: AgentReads = {
    balance: async (token) => {
      if (token === "native") return 0n;
      const r = await publicClient.readContract({
        address: token,
        abi: [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] }],
        functionName: "balanceOf",
        args: [SMA],
      });
      return r as bigint;
    },
    allowance: async () => 0n,
    decimals: async () => 6,
  };
  return {
    safe: SMA,
    account: SMA,
    chainId: 8453,
    blockNumber: 0n,
    timestamp: 0,
    now: new Date(0),
    publicClient,
    read,
    env: {},
    data: {},
    log: () => {},
    manager: { address: SMA, sign: async () => "0x", signTyped: async () => "0x" },
    client: {} as never,
    chain: () => { throw new Error("not used in fixture generation"); },
  } as AgentContext;
}

function venueMeta(venueId: VenueId) {
  // Mirrors VENUES from src/agent.ts — re-derived here to keep the fixture self-describing
  // without exporting the internal VENUES array.
  const meta: Record<VenueId, { name: string; addr: Address; kind: "aave" | "erc4626" }> = {
    aave: { name: "Aave V3 Pool", addr: AAVE_POOL, kind: "aave" },
    morpho: { name: "Morpho vault", addr: MORPHO_VAULT, kind: "erc4626" },
    euler: { name: "Euler vault", addr: EULER_VAULT, kind: "erc4626" },
  };
  return meta[venueId];
}

async function main(): Promise<void> {
  const ctx = buildCtx(RPC_URL);
  const blockNumber = Number(await ctx.publicClient.getBlockNumber());
  console.log(`connected to Base at block ${blockNumber}`);

  const fixtureDir = path.join(process.cwd(), "contracts", "test", "fixtures");
  fs.mkdirSync(fixtureDir, { recursive: true });

  // ════════════════════════════════════════════════════════════════════════════
  // DEPOSIT FIXTURES — one per venue, all from depositBatch() with the deposit amount.
  // ════════════════════════════════════════════════════════════════════════════
  const depositFixtures: Record<string, unknown> = {};
  for (const venueId of VENUE_IDS) {
    const v = venueMeta(venueId);
    const calls = depositBatch(
      { id: venueId, name: v.name, addr: v.addr, kind: v.kind },
      DEPOSIT_AMOUNT,
      SMA,
      USDC,
    );
    const fixture = {
      chainId: 8453,
      sma: SMA,
      blockNumber,
      venue: venueId,
      venueName: v.name,
      venueAddress: v.addr,
      venueKind: v.kind,
      depositAmount: DEPOSIT_AMOUNT.toString(),
      depositAmountHuman: Number(DEPOSIT_AMOUNT) / 1e6,
      // Deposit batch is always 3 calls: [approve, deposit, approve(0)]. Stored as flat
      // fields (not a JSON array) because this forge version doesn't support
      // vm.parseJsonArrayLength — flat fields work with vm.parseJsonAddress/Bytes.
      call0Target: calls[0].target,
      call0Data: calls[0].data,
      call1Target: calls[1].target,
      call1Data: calls[1].data,
      call2Target: calls[2].target,
      call2Data: calls[2].data,
      note: "Generated by scripts/gen-fixtures.ts from the agent's depositBatch(). Replayed verbatim by YieldRotateFork.t.sol.",
    };
    depositFixtures[venueId] = fixture;
    console.log(`deposit ${venueId}: ${calls.length} calls, ${Number(DEPOSIT_AMOUNT) / 1e6} USDC`);
  }
  fs.writeFileSync(
    path.join(fixtureDir, "deposit-fixtures.json"),
    JSON.stringify(depositFixtures, null, 2) + "\n",
  );
  console.log(`deposit fixtures written: ${path.join(fixtureDir, "deposit-fixtures.json")}`);

  // ════════════════════════════════════════════════════════════════════════════
  // WITHDRAW FIXTURES
  // ════════════════════════════════════════════════════════════════════════════
  const withdrawFixtures: Record<string, unknown> = {};

  // ── Live position (if any) → readPosition() + withdrawCall() ──
  const pos = await readPosition(ctx);
  console.log("position:", JSON.stringify({
    state: pos.state,
    venue: pos.venue?.id,
    assets: pos.assets.toString(),
    assetsHuman: Number(pos.assets) / 1e6,
  }));

  if (pos.state === "deployed" && pos.venue) {
    const PER_TX_CAP = 250_000_000n;
    const amt = pos.assets < PER_TX_CAP ? pos.assets : PER_TX_CAP;
    const call = withdrawCall(pos.venue, amt, SMA, USDC);
    withdrawFixtures[pos.venue.id] = {
      chainId: 8453,
      sma: SMA,
      blockNumber,
      venue: pos.venue.id,
      venueName: pos.venue.name,
      venueAddress: pos.venue.addr,
      venueKind: pos.venue.kind,
      positionAssets: pos.assets.toString(),
      positionAssetsHuman: Number(pos.assets) / 1e6,
      positionSource: "live",
      withdrawTarget: call.target,
      withdrawData: call.data,
      note: "Generated by scripts/gen-fixtures.ts from the agent's readPosition() + withdrawCall() against a live position. Replayed verbatim by YieldRotateFork.t.sol.",
    };
    console.log(`withdraw ${pos.venue.id}: live position, ${Number(pos.assets) / 1e6} USDC`);
  } else {
    console.log(`no live deployed position (state=${pos.state}); withdraw fixtures will use synthetic mode`);
  }

  // ── Synthetic venues (no live position) → deposit-first withdraw fixtures ──
  // We can't run the deposit on-chain here (no transactions allowed), so we produce the
  // withdraw calldata for the known deposit amount. The forge test deals USDC, replays the
  // deposit fixture first, then replays this withdraw against the created position.
  // For the withdraw amount, we use the deposit amount directly (the test re-reads the actual
  // position via convertToAssets/balanceOf at test time to assert on received USDC).
  for (const venueId of VENUE_IDS) {
    if (withdrawFixtures[venueId]) continue; // skip if already set (live position)

    const v = venueMeta(venueId);
    // For synthetic venues, the withdraw amount = the deposit amount. The test will deposit
    // first, then withdraw positionAssets - 1 (the agent's amt-1 rounding).
    const PER_TX_CAP = 250_000_000n;
    const amt = DEPOSIT_AMOUNT < PER_TX_CAP ? DEPOSIT_AMOUNT : PER_TX_CAP;
    const call = withdrawCall(
      { id: venueId, name: v.name, addr: v.addr, kind: v.kind },
      amt,
      SMA,
      USDC,
    );
    withdrawFixtures[venueId] = {
      chainId: 8453,
      sma: SMA,
      blockNumber,
      venue: venueId,
      venueName: v.name,
      venueAddress: v.addr,
      venueKind: v.kind,
      positionAssets: DEPOSIT_AMOUNT.toString(),
      positionAssetsHuman: Number(DEPOSIT_AMOUNT) / 1e6,
      positionSource: "synthetic",
      depositAmount: DEPOSIT_AMOUNT.toString(),
      depositAmountHuman: Number(DEPOSIT_AMOUNT) / 1e6,
      withdrawTarget: call.target,
      withdrawData: call.data,
      note: "Generated by scripts/gen-fixtures.ts from the agent's withdrawCall(). The test deposits first (from deposit-fixtures.json) to create a position, then replays this withdraw. positionAssets = the deposit amount; the test asserts received USDC is within a few % of this.",
    };
    console.log(`withdraw ${venueId}: synthetic (deposit-first), ${Number(DEPOSIT_AMOUNT) / 1e6} USDC`);
  }

  fs.writeFileSync(
    path.join(fixtureDir, "withdraw-fixtures.json"),
    JSON.stringify(withdrawFixtures, null, 2) + "\n",
  );
  console.log(`withdraw fixtures written: ${path.join(fixtureDir, "withdraw-fixtures.json")}`);
}

main().catch((e) => {
  console.error("fixture generation failed:", e);
  process.exit(1);
});
