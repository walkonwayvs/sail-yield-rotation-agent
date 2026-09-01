// yieldRotate agent — hold USDC in the best-rate Aave/Morpho/Euler venue on Base.
// Adapted from the canonical read → decide → act skeleton into a position-management
// shape: detect current position, compare rates, conditionally rotate (withdraw then
// deposit), and redeploy idle capital left by a half-finished rotation.
//
// Configuration: venue addresses, USDC, and the aToken are read from environment
// variables (see .env.example). Thresholds below are strategy constants, not secrets.

import fs from "node:fs";
import path from "node:path";
import type { Agent, AgentContext, Address, Call, Dispatch } from "@sail.money/sailor/sdk";
import { encodeFunctionData, formatUnits, parseEventLogs } from "viem";

// ── Environment-resolved addresses ──────────────────────────────────────────
// These MUST be set via environment variables. Defaults are intentionally absent
// from code so a misconfiguration fails loudly at startup.
function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var: ${name}`);
  return v;
}

const CHAIN_ID = 8453;

const USDC: Address = requireEnv("USDC_ADDRESS") as Address;
const AAVE_POOL: Address = requireEnv("AAVE_POOL_ADDRESS") as Address;
// Aave's position is the aToken (e.g. aBasUSDC), NOT the Pool. The Pool is the
// lending contract (supply/withdraw are called on it); the SMA's Aave position is
// balanceOf on the aToken, which is already asset-denominated in 6 decimals.
const AAVE_A_TOKEN: Address = requireEnv("AAVE_A_TOKEN_ADDRESS") as Address;
const MORPHO_VAULT: Address = requireEnv("MORPHO_VAULT_ADDRESS") as Address; // ERC-4626
const EULER_VAULT: Address = requireEnv("EULER_VAULT_ADDRESS") as Address; // ERC-4626 / EVC

const VENUES: { id: "aave" | "morpho" | "euler"; name: string; addr: Address; kind: "aave" | "erc4626" }[] = [
  { id: "aave", name: "Aave V3 Pool", addr: AAVE_POOL, kind: "aave" },
  { id: "morpho", name: "Morpho vault", addr: MORPHO_VAULT, kind: "erc4626" },
  { id: "euler", name: "Euler vault", addr: EULER_VAULT, kind: "erc4626" },
];

// Per-tx cap. The on-chain configured maxAmountPerTx on BOTH permissions is asset-
// denominated. We call ERC-4626 withdraw(assets,...), NEVER redeem(shares,...), so
// the cap applies to assets (slot 0).
const PER_TX_CAP = 250_000_000n; // 250 USDC, 6 decimals
const USDC_DECIMALS = 6;

// Decision thresholds (strategy constants, not secrets).
const MIN_LIQUIDITY_USD = 40_000;
const MAX_SUPPLY_APY = 0.3; // skip corrupt rows (>0.30)
const MIN_SPREAD_TO_ROTATE = 0.005; // 0.5 percentage points
const ROTATION_COOLDOWN_SEC = 24 * 60 * 60; // 24 h between rotations

// ── ABI fragments (only what the loop reads or builds) ──────────────────────
const ERC20_BALANCE_OF_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const ERC20_APPROVE_ABI = [
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const ERC20_TRANSFER_EVENT_ABI = [
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
] as const;

// Aave V3 Pool.supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)
const AAVE_SUPPLY_ABI = [
  {
    name: "supply",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "onBehalfOf", type: "address" },
      { name: "referralCode", type: "uint16" },
    ],
    outputs: [],
  },
] as const;

// Aave V3 Pool.withdraw(address asset, uint256 amount, address to)
const AAVE_WITHDRAW_ABI = [
  {
    name: "withdraw",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "to", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// ERC-4626 deposit(uint256 assets, address receiver)
const ERC4626_DEPOSIT_ABI = [
  {
    name: "deposit",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "assets", type: "uint256" },
      { name: "receiver", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// ERC-4626 withdraw(uint256 assets, address receiver, address owner)
const ERC4626_WITHDRAW_ABI = [
  {
    name: "withdraw",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "assets", type: "uint256" },
      { name: "receiver", type: "address" },
      { name: "owner", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// ERC-4626 convertToAssets(uint256 shares) → asset amount (6-dec USDC here).
// Used to translate the SMA's vault share balance into the asset amount the
// withdraw(assets,...) call needs. maxWithdraw would also work; convertToAssets
// keeps the read simple and stateless (no per-owner accounting quirks).
const ERC4626_CONVERT_TO_ASSETS_ABI = [
  {
    name: "convertToAssets",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "shares", type: "uint256" }],
    outputs: [{ name: "assets", type: "uint256" }],
  },
] as const;

// ── Discord notifications (sailor-extend pattern) ────────────────────────────
// Fire-and-forget alerts for events an operator must see: persistent rate-fetch failures,
// zero-spread self-compare, and prolonged stillness. Silently disabled when
// DISCORD_WEBHOOK_URL is not set. Every send is wrapped in try/catch so a notification
// failure can never throw into tick() or stop a dispatch.
//
// Read from process.env, NOT ctx.env: ctx.env is the per-chain strategy map
// (.sail/env/<slug>.json), while DISCORD_WEBHOOK_URL is an infrastructure secret that lives
// in .sail/.env.local alongside the RPC URL and passphrase (both process-env, not ctx.env).
async function notify(ctx: AgentContext, message: string): Promise<void> {
  const webhook = process.env.DISCORD_WEBHOOK_URL;
  if (!webhook) return;
  try {
    await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: `⛵ sail-agent — ${message}` }),
    });
  } catch {
    // a lost alert must not stop a dispatch
  }
}

// Alert thresholds (operational, not strategy-spec).
const RATE_FAIL_ALERT_TICKS = 3; // consecutive unreadable-rate ticks before alerting
const ZERO_SPREAD_ALERT_TICKS = 3; // consecutive 0.000pp spreads before alerting
const STALE_VENUE_SEC = 14 * 24 * 60 * 60; // 14 d holding one venue → stillness alert

// Tracks consecutive-tick failure counts per venue, so we can alert when a venue's rate
// feed is persistently down. A single transient failure is silent; three in a row means
// the venue's rate is persistently unreadable — notify. Reset on a total fetch failure or
// position-read failure (different paths that break the per-venue streak).
let failedStreak: Map<string, number> = new Map();

// Tracks consecutive ticks where the best-vs-current spread was exactly 0.000pp — the
// signature of comparing a rate against itself (a phantom rate from a vault the agent
// cannot reach, or two venues reporting an identical number). Three in a row → notify.
// Preserved across ticks that skip before computing a spread (no comparison is not a
// non-zero spread); reset the moment a real non-zero spread is seen.
let zeroSpreadStreak = 0;

// ── Once-and-suppress arming for the three operational alerts ───────────────
// Each alert fires once, then stays quiet until its condition clears, then re-arms so a
// recurrence alerts again. Re-arming is driven by the SAME condition that clears the
// streak, so the two never drift apart.
//   zeroSpreadArmed  — cleared by a non-zero spread (which also resets the streak).
//   failedArmed      — per venue; cleared when that venue's rate is successfully read.
//   stillnessArmed   — cleared when the held venue is no longer past STALE_VENUE_SEC
//                      (i.e. a confirmed rotation moved heldSince forward).
let zeroSpreadArmed = true;
let failedArmed: Map<string, boolean> = new Map();
let stillnessArmed = true;

// ── Memory ledger (.sail/memory/ledger.jsonl) — see sailor-memory skill ─────
// Append-only, chain-reconciled record of every tick. A fresh process recovers its own
// history by reading this file — the cadence guard below reads last CONFIRMED rotation
// from it, not ctx.data (which resets every fresh process).
const LEDGER_PATH = path.join(process.cwd(), ".sail", "memory", "ledger.jsonl");
const ACTIVITY_PATH = path.join(process.cwd(), ".sail", "activity.jsonl");

type LedgerEntry = {
  ts: number;
  block: number;
  chainId: number;
  kind: "acted" | "skipped";
  action?: string; // "deposit" | "withdraw" | "rotate"
  outcome?: "confirmed" | "reverted" | "unverified";
  txHash?: string;
  venue?: string;
  reason?: string;
  note?: string;
  [k: string]: unknown;
};

const readLines = (file: string): string[] => {
  try {
    return fs.readFileSync(file, "utf-8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
};

const appendLedger = (entry: LedgerEntry): void => {
  fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
  fs.appendFileSync(LEDGER_PATH, `${JSON.stringify(entry)}\n`);
};

// Last CONFIRMED rotation's timestamp — the cadence guard's only input. A rotation is an
// acted entry whose action is "rotate" (a withdraw+deposit pair) — NOT a redeploy of idle
// capital (action "deposit"), which must never be gated by the cooldown. Sourced from the
// ledger, not ctx.data: ctx.data resets on every fresh process.
const readLastRotationSec = (): number => {
  const lines = readLines(LEDGER_PATH);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const e = JSON.parse(lines[i]) as LedgerEntry;
      if (e.kind === "acted" && e.outcome === "confirmed" && e.action === "rotate") return e.ts;
    } catch {
      // a malformed line is skipped, never fatal
    }
  }
  return 0;
};

// The timestamp the SMA started holding its CURRENT venue — the last CONFIRMED rotation's
// ts (same source as the cadence guard), or, if it has never rotated, the first ledger
// entry's ts (when the agent began tracking). Used by the 14-day stillness alert: nothing
// in the loop distinguishes "correctly holding" from "stuck comparing a phantom rate", so
// prolonged stillness is surfaced for a human to disambiguate. Returns 0 when the ledger
// is empty (fresh install, nothing to alert on).
const readHeldSinceSec = (): number => {
  const lines = readLines(LEDGER_PATH);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const e = JSON.parse(lines[i]) as LedgerEntry;
      if (e.kind === "acted" && e.outcome === "confirmed" && e.action === "rotate") return e.ts;
    } catch {
      // a malformed line is skipped, never fatal
    }
  }
  for (let i = 0; i < lines.length; i++) {
    try {
      return (JSON.parse(lines[i]) as LedgerEntry).ts;
    } catch {
      // a malformed line is skipped, never fatal
    }
  }
  return 0;
};

// Extract 4-byte selectors from a hex calldata blob. For a plain ERC-20 / vault call the
// data is just selector+args (one selector at offset 0). For an SMA-Safe exec envelope the
// inner calls are packed; this scans every 4-byte-aligned window and returns the ones that
// look like known selectors, so reconcilePending can classify a dispatch without fully
// decoding the Safe envelope.
const KNOWN_SELECTORS = new Set([
  "095ea7b3", // approve
  "6e553f65", // erc4626 deposit
  "617ba037", // aave supply
  "b460af94", // erc4626 withdraw
  "69328dec", // aave withdraw
]);

function extractSelectors(input: `0x${string}`): string[] {
  const hex = input.slice(2).toLowerCase();
  const found: string[] = [];
  for (let i = 0; i + 8 <= hex.length; i += 2) {
    const s = hex.slice(i, i + 8);
    if (KNOWN_SELECTORS.has(s)) found.push(s);
  }
  return found;
}

// txHashes already recorded, so reconciliation never double-ledgers a dispatch.
const ledgeredTxHashes = (): Set<string> => {
  const set = new Set<string>();
  for (const line of readLines(LEDGER_PATH).slice(-100)) {
    try {
      const e = JSON.parse(line) as LedgerEntry;
      if (e.kind === "acted" && typeof e.txHash === "string") set.add(e.txHash);
    } catch {
      // ignore
    }
  }
  return set;
};

/**
 * Chain-reconcile every dispatch this agent submitted that the runner has since confirmed
 * or reverted. `sailor run` appends dispatch_executed / dispatch_reverted to activity.jsonl
 * only AFTER awaiting the receipt — so by the time any tick starts, the previous tick's
 * outcome is already on disk. Every field comes from the receipt / fresh balance reads,
 * never from what the agent meant to do. Unreadable receipt ⇒ "unverified", never a
 * fabricated success (sailor-transactions confirmed/reverted/unverified doctrine).
 */
async function reconcilePending(ctx: AgentContext): Promise<void> {
  const already = ledgeredTxHashes();
  // The runner's dispatch events carry {type:"dispatch_executed"|"dispatch_reverted",
  // permission, target, txHash, ...}. We match on type+txHash only: for a 3-call deposit
  // batch `target` is the first call (the approve, on USDC), not the venue, so it can't
  // disambiguate which venue this was — we recover that from the receipt's calls instead.
  const pending = readLines(ACTIVITY_PATH)
    .slice(-40)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(
      (e): e is Record<string, unknown> =>
        !!e &&
        (e.type === "dispatch_executed" || e.type === "dispatch_reverted") &&
        typeof e.txHash === "string" &&
        !already.has(e.txHash as string),
    );

  for (const event of pending) {
    const txHash = event.txHash as `0x${string}`;
    const permission = (event.permission as Address | undefined) ?? null;
    const outcome: "confirmed" | "reverted" =
      event.type === "dispatch_executed" ? "confirmed" : "reverted";

    try {
      const [tx, receipt] = await Promise.all([
        ctx.publicClient.getTransaction({ hash: txHash }),
        ctx.publicClient.getTransactionReceipt({ hash: txHash }),
      ]);

      // Classify the dispatch by inspecting the inner call selectors. The SMA is a Safe:
      // the kernel dispatches an SMA-exec transaction whose inner batch holds the real calls.
      // We read the executing tx's data to recover the selectors of the inner calls, then
      // classify:
      //   - A DEPOSIT batch is [approve, deposit-or-supply, approve(0)]. The consuming call
      //     has selector 0x6e553f65 (erc4626 deposit) or 0x617ba037 (aave supply). The
      //     approve calls (0x095ea7b3) are bookkeeping. A standalone deposit batch is NOT a
      //     rotation — it is an idle redeploy or a rotation's deposit leg. Only a
      //     withdraw+deposit PAIR is a rotation. A deposit-only dispatch is action "deposit".
      //   - A WITHDRAW call has selector 0xb460af94 (erc4626 withdraw) or 0x69328dec (aave
      //     withdraw). A withdraw dispatched alone is the exit leg of a rotation; when paired
      //     with a deposit in the same tick (two dispatches) the pair is the rotation.
      //     Because reconcilePending processes one tx at a time, we label a withdraw as
      //     "rotate" (it is the rotation trigger) and a deposit-alone as "deposit".
      //
      // The previous logic defaulted any non-approve selector to "rotate", which mislabelled
      // the standalone idle-redeploy deposit as a rotation and started the 24h cooldown clock
      // on a deposit — a deposit is never a rotation. Only a real withdraw+deposit pair is.
      const selectors = extractSelectors(tx.input);
      const hasWithdraw = selectors.some(
        (s) => s === "b460af94" || s === "69328dec", // erc4626 withdraw / aave withdraw
      );
      const hasDeposit =
        selectors.some((s) => s === "6e553f65" || s === "617ba037") || // erc4626 deposit / aave supply
        selectors.some((s) => s === "095ea7b3"); // approve ⇒ a deposit batch's bookkeeping
      // A rotation always contains a withdraw. A deposit-only dispatch (idle redeploy, or a
      // rotation's deposit leg arriving as a separate tx) has no withdraw.
      const action = hasWithdraw ? "rotate" : hasDeposit ? "deposit" : "unverified";

      // Venue recovery: match inner call targets against our known venue addresses. A
      // multi-call batch may touch several; we pick the first venue target (the consuming
      // call's venue, since approve calls target USDC, not the venue). This is reliable
      // because the venue addresses are fixed and on-allowlist.
      let venue: string | undefined;
      if (tx.to) {
        const to = tx.to.toLowerCase();
        for (const v of VENUES) {
          if (to === v.addr.toLowerCase()) {
            venue = v.id;
            break;
          }
        }
      }
      const usdcBal = await ctx.read.balance(USDC);

      appendLedger({
        ts: ctx.timestamp,
        block: Number(receipt.blockNumber),
        chainId: ctx.chainId,
        kind: "acted",
        action,
        venue,
        permission,
        outcome,
        txHash,
        gasUsed: receipt.gasUsed.toString(),
        usdcBalanceAfter: usdcBal.toString(),
      });
    } catch (e) {
      appendLedger({
        ts: ctx.timestamp,
        block: Number(ctx.blockNumber),
        chainId: ctx.chainId,
        kind: "acted",
        action: "unverified",
        permission,
        outcome: "unverified",
        txHash,
        gasUsed: null,
        note: (e as Error).message.slice(0, 160),
      });
    }
  }
}

// ── Cambrian API: best supply APY per venue ──────────────────────────────────
type VenueRates = { id: "aave" | "morpho" | "euler"; apy: number; liquidityUsd: number }[];

/**
 * Query the three Cambrian endpoints, filter to chainId 8453 + the strategy's risk bounds,
 * and return the supply APY + availableLiquidityUsd for each of our three venues. FAIL
 * CLOSED: if any endpoint errors or returns no usable row for a venue, that venue is dropped
 * (not given apy 0) so a network blip can't make the agent rotate away from a real position
 * into a venue whose rate it couldn't actually read.
 */
async function fetchRates(ctx: AgentContext): Promise<{ rates: VenueRates; best: VenueRates[number] | null }> {
  const apiKey = ctx.env.CAMBRIAN_API_KEY;
  const aaveUrl = ctx.env.CAMBRIAN_AAVE_URL;
  const morphoUrl = ctx.env.CAMBRIAN_MORPHO_URL;
  const eulerUrl = ctx.env.CAMBRIAN_EULER_URL;
  if (!apiKey || !aaveUrl || !morphoUrl || !eulerUrl) {
    throw new Error("missing Cambrian env (CAMBRIAN_API_KEY / CAMBRIAN_*_URL)");
  }

  // Response shape: [{"columns":[...],"data":[[...]],"rows":N}] — rows are positional arrays
  // aligned to columns. Aave/Morpho name the asset column `underlyingSymbol`; Euler names it
  // `loanSymbol`. Filter chainId 8453 ourselves (no query params).
  //
  // FIX 1: each entry in `columns` is an OBJECT like {"name":"chainId","type":"UInt16"}, NOT a
  // string — map to .name before matching, or every indexOf resolves to -1 and no rows survive.
  //
  // FIX 2: Cambrian's free tier 429s on rapid parallel calls — fetch the three endpoints
  // SEQUENTIALLY with a delay between them, retrying once on a 429.
  const headers: Record<string, string> = { "x-api-key": apiKey };
  type Row = { apy: number; liquidityUsd: number; addr: string };
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  // Returns USDC rows for a venue. columns entries are objects {name,type} — map to .name.
  const fetchRows = async (label: string, url: string, symbolCol: "underlyingSymbol" | "loanSymbol", addrCol: string): Promise<Row[]> => {
    try {
      // Retry on a 429 (free-tier rate limit) or a thrown fetch error.
      let json: unknown;
      for (let attempt = 1; attempt <= 3; attempt++) {
        let res: Response;
        try {
          res = await fetch(url, { headers });
        } catch (e) {
          if (attempt < 3) {
            await sleep(2000);
            continue;
          }
          throw e;
        }
        if (res.status === 429) {
          if (attempt < 3) {
            await sleep(2000);
            continue;
          }
          throw new Error(`Cambrian ${label} HTTP 429 after retry — rate limited`);
        }
        if (!res.ok) throw new Error(`Cambrian ${label} HTTP ${res.status}`);
        json = await res.json();
        break;
      }
      const blocks = json as { columns: unknown[]; data: unknown[][]; rows?: number }[];
      const block = blocks[0];
      if (!block || !Array.isArray(block.columns) || !Array.isArray(block.data)) return [];
      const colNames: string[] = block.columns.map((c) =>
        typeof c === "string" ? c : (c as { name?: string })?.name ?? "",
      );
      const colIdx = (name: string) => colNames.indexOf(name);
      const iChain = colIdx("chainId");
      const iSym = colIdx(symbolCol);
      const iApy = colIdx("supplyApy");
      const iLiq = colIdx("availableLiquidityUsd");
      const iAddr = colIdx(addrCol);
      const afterChain = block.data.filter((r) => iChain < 0 || Number(r[iChain]) === CHAIN_ID);
      const afterUsdc = iSym < 0 ? [] : afterChain.filter((r) => String(r[iSym]).toUpperCase() === "USDC");
      return afterUsdc.map((r) => ({
        apy: iApy >= 0 ? Number(r[iApy]) : NaN,
        liquidityUsd: iLiq >= 0 ? Number(r[iLiq]) : NaN,
        addr: iAddr >= 0 ? String(r[iAddr]) : "",
      }));
    } catch (e) {
      ctx.log(`fetchRates: ${label} error: ${(e as Error).message.slice(0, 120)}`);
      return [];
    }
  };

  // Sequential with a delay between endpoints — Cambrian's free tier 429s on parallel calls.
  const aaveRows = await fetchRows("aave", aaveUrl, "underlyingSymbol", "poolAddress");
  await sleep(1200);
  const morphoRows = await fetchRows("morpho", morphoUrl, "underlyingSymbol", "vaultAddress");
  await sleep(1200);
  const eulerRows = await fetchRows("euler", eulerUrl, "loanSymbol", "loanAddress");

  // Pick each venue's valid USDC row for the contract it can actually deposit into / holds:
  // filter to the row whose address matches the target BEFORE the validity filters, so we
  // never compare against a rate from a pool/vault we can't reach. Cambrian's poolAddress
  // for Aave is the aToken (AAVE_A_TOKEN); vaultAddress for Morpho is the vault (MORPHO_VAULT).
  // Euler's loanAddress is the loan token (USDC), not a vault address, so Euler skips the
  // address filter and keeps its existing address-less selection. Also note that Cambrian's
  // Euler endpoint has no vault-address column, so the euler rate cannot be filtered to the
  // vault this agent deposits into. It is therefore a best-of-all-Euler-USDC-markets number,
  // not the rate of the held position — the exact phantom-rate problem the skill file warns
  // about. A second reason euler is disabled in the live agent. A missing address match
  // returns null — fail-closed, same as an unreadable rate. Then: skip if
  // availableLiquidityUsd < 40000, skip if supplyApy > 0.30 (corrupt rows); a NaN apy or
  // liquidity also disqualifies.
  const pickBest = (rows: Row[], target?: Address): Row | null => {
    const afterAddr = target ? rows.filter((r) => r.addr && r.addr.toLowerCase() === target.toLowerCase()) : rows;
    const finite = afterAddr.filter((r) => Number.isFinite(r.apy) && Number.isFinite(r.liquidityUsd));
    const afterLiq = finite.filter((r) => r.liquidityUsd >= MIN_LIQUIDITY_USD);
    const afterApy = afterLiq.filter((r) => r.apy <= MAX_SUPPLY_APY); // corrupt (>30%)
    let best: Row | null = null;
    for (const r of afterApy) if (!best || r.apy > best.apy) best = r;
    return best;
  };

  const rates: VenueRates = [];
  const push = (id: "aave" | "morpho" | "euler", r: Row | null) => {
    if (r) rates.push({ id, apy: r.apy, liquidityUsd: r.liquidityUsd });
  };
  push("aave", pickBest(aaveRows, AAVE_A_TOKEN));
  push("morpho", pickBest(morphoRows, MORPHO_VAULT));
  push("euler", pickBest(eulerRows));

  const best = rates.length ? rates.reduce((m, r) => (r.apy > m.apy ? r : m)) : null;
  return { rates, best };
}

// ── Position detection (terrain, not map) ────────────────────────────────────
// Which venue currently holds the SMA's USDC. Read from on-chain balances, never from the
// ledger's intent. aUSDC (Aave) is the aToken and is ALREADY asset-denominated in 6 decimals.
// Morpho/Euler balances are vault SHARES (18 decimals) — convertToAssets translates them to
// the asset amount (USDC, 6 decimals) that withdraw(assets,...) consumes.
export type Position = { state: "deployed" | "idle" | "skip"; venue?: (typeof VENUES)[number]; assets: bigint };

// Exported so the fixture generator (scripts/gen-fixtures.ts) can exercise the real
// code path — readPosition + withdrawCall — rather than reimplement it in Solidity.
export async function readPosition(ctx: AgentContext): Promise<Position> {
  const bal = async (token: Address) => {
    const r = await ctx.publicClient.readContract({
      address: token,
      abi: ERC20_BALANCE_OF_ABI,
      functionName: "balanceOf",
      args: [ctx.safe],
    });
    return r as bigint;
  };
  // For ERC-4626 venues: convert a share balance into its USDC asset value.
  const assetsOf = async (vault: Address, shares: bigint): Promise<bigint> => {
    const r = await ctx.publicClient.readContract({
      address: vault,
      abi: ERC4626_CONVERT_TO_ASSETS_ABI,
      functionName: "convertToAssets",
      args: [shares],
    });
    return r as bigint;
  };
  const [aave, morphoShares, eulerShares, usdc] = await Promise.all([
    bal(AAVE_A_TOKEN).catch(() => 0n), // aToken — Aave position token, already 6-dec assets
    bal(MORPHO_VAULT).catch(() => 0n), // ERC-4626 share balance (18 dec) — convert below
    bal(EULER_VAULT).catch(() => 0n), // ERC-4626 share balance (18 dec) — convert below
    ctx.read.balance(USDC),
  ]);

  // Convert share balances to asset amounts (USDC, 6 dec). A zero share balance yields zero
  // assets, so we skip the read to save an RPC call.
  const [morphoAssets, eulerAssets] = await Promise.all([
    morphoShares > 0n ? assetsOf(MORPHO_VAULT, morphoShares).catch(() => 0n) : Promise.resolve(0n),
    eulerShares > 0n ? assetsOf(EULER_VAULT, eulerShares).catch(() => 0n) : Promise.resolve(0n),
  ]);

  const held: { v: (typeof VENUES)[number]; assets: bigint }[] = [];
  if (aave > 0n) held.push({ v: VENUES[0], assets: aave });
  if (morphoAssets > 0n) held.push({ v: VENUES[1], assets: morphoAssets });
  if (eulerAssets > 0n) held.push({ v: VENUES[2], assets: eulerAssets });

  if (held.length === 0) {
    // No venue balance. The tick's idle branch re-reads the USDC balance and handles it.
    return { state: "idle", assets: usdc };
  }
  if (held.length > 1) {
    // Should never happen (we hold one venue at a time). Refuse to guess which venue owns
    // the position. We return a "skip" sentinel so the tick does NOT deposit into a second
    // venue while the SMA is already deployed across multiple — that would fragment the
    // position. The tick checks for this explicitly and logs + skips.
    return { state: "skip", assets: 0n };
  }
  return { state: "deployed", venue: held[0].v, assets: held[0].assets };
}

// ── Dispatch builders ────────────────────────────────────────────────────────
// The runner resolves the authorizing permission from the call shape; we never name one.
const intent = (calls: Call[]): Dispatch => ({ txHash: "0x", calls, success: false, gasUsed: 0n });

// Deposit: atomic [approve(spender, amt), consuming deposit, approve(spender, 0)].
// requireAmountMatch=true on-chain ⇒ the consuming call's leading uint256 must equal the
// approve amount (both = amt). allowUnconstrainedRecipient=false ⇒ decoded recipient must
// equal the SMA. spender = venue target (the consuming call pulls USDC from there).
// USDC is passed explicitly so the builder does not depend on a global constant.
// Exported so the fixture generator (scripts/gen-fixtures.ts) can exercise the real deposit
// code path, the same way it exercises withdrawCall() for the withdraw path.
export function depositBatch(
  venue: (typeof VENUES)[number],
  amt: bigint,
  sma: Address,
  usdc: Address,
): Call[] {
  const approveAmt = (addr: Address, n: bigint) =>
    ({ target: usdc, value: 0n, data: encodeFunctionData({ abi: ERC20_APPROVE_ABI, functionName: "approve", args: [addr, n] }) });
  const consuming =
    venue.kind === "aave"
      ? ({ target: venue.addr, value: 0n, data: encodeFunctionData({ abi: AAVE_SUPPLY_ABI, functionName: "supply", args: [usdc, amt, sma, 0] }) } as Call)
      : ({ target: venue.addr, value: 0n, data: encodeFunctionData({ abi: ERC4626_DEPOSIT_ABI, functionName: "deposit", args: [amt, sma] }) } as Call);
  return [approveAmt(venue.addr, amt), consuming, approveAmt(venue.addr, 0n)];
}

// Withdraw: single call, recipient pinned to SMA on-chain. ERC-4626 withdraw(assets, SMA, SMA);
// Aave withdraw(USDC, amount, SMA). Cap is asset-denominated on-chain, so we use withdraw
// (slot 0 = assets), NEVER redeem (slot 0 = shares). Rounding fix: withdraw amt-1 base units —
// deposit mints floor(shares); withdrawing the exact amount needs ceil(shares) and reverts
// (NotEnoughAvailableUserBalance / EVC auth). One base unit (1e-6 USDC) of dust stays behind.
// USDC is passed explicitly so the builder does not depend on a global constant.
export function withdrawCall(
  venue: (typeof VENUES)[number],
  amt: bigint,
  sma: Address,
  usdc: Address,
): Call {
  const assets = amt > 0n ? amt - 1n : 0n;
  if (venue.kind === "aave") {
    return {
      target: venue.addr,
      value: 0n,
      data: encodeFunctionData({ abi: AAVE_WITHDRAW_ABI, functionName: "withdraw", args: [usdc, assets, sma] }),
    };
  }
  return {
    target: venue.addr,
    value: 0n,
    data: encodeFunctionData({ abi: ERC4626_WITHDRAW_ABI, functionName: "withdraw", args: [assets, sma, sma] }),
  };
}

export const agent: Agent = {
  name: "yieldRotate",
  description: "Hold USDC in the highest-supply-rate Aave/Morpho/Euler venue on Base; rotate on >=0.5pp improvement, at most once per 24h; redeploy idle capital left by a half-finished rotation.",

  async tick(ctx: AgentContext): Promise<Dispatch[]> {
    ctx.log(`tick — block ${ctx.blockNumber}, sma ${ctx.safe}`);

    // Reconcile first — catch the ledger up on any dispatch a PRIOR tick submitted that has
    // since confirmed or reverted. Doubles as this tick's memory read: the cooldown guard
    // below reads the ledger this just brought current.
    try {
      await reconcilePending(ctx);
    } catch (e) {
      ctx.log(`reconcile failed (non-fatal): ${(e as Error).message.slice(0, 120)}`);
    }

    // ── Read rates (FAIL CLOSED). A fetch error or empty result is a no, not a maybe.
    let rates: VenueRates;
    let best: VenueRates[number] | null;
    try {
      ({ rates, best } = await fetchRates(ctx));
    } catch (e) {
      failedStreak = new Map(); // total fetch failure — different path, breaks the per-venue streak
      const reason = `rates unavailable: ${(e as Error).message.slice(0, 140)}`;
      ctx.log(`${reason} — skipping`);
      void notify(ctx, `tick skipped — ${reason}`);
      appendLedger({ ts: ctx.timestamp, block: Number(ctx.blockNumber), chainId: ctx.chainId, kind: "skipped", reason });
      return [];
    }

    // ── Consecutive-failure detection. A venue missing from `rates` failed this tick
    // (network error or no valid rows after filtering both count). If it has failed
    // RATE_FAIL_ALERT_TICKS ticks running (this tick included), the feed is persistently
    // down — notify once, then suppress until the venue reads successfully. A single
    // transient failure is silent; the total-throw path above resets the streak. The
    // previous tick's counts are in failedStreak. Venues that read OK this tick re-arm.
    const rateIds = new Set(rates.map((r) => r.id));
    const thisTickFailed = new Set(VENUES.map((v) => v.id).filter((id) => !rateIds.has(id)));
    const nextStreak = new Map<string, number>();
    for (const id of thisTickFailed) {
      const count = (failedStreak.get(id) ?? 0) + 1;
      nextStreak.set(id, count);
      if (count >= RATE_FAIL_ALERT_TICKS && failedArmed.get(id) !== false) {
        failedArmed.set(id, false); // suppress until the venue reads successfully
        void notify(ctx, `rate fetch failed ${count} ticks in a row — ${id}`);
      }
    }
    for (const id of rateIds) failedArmed.set(id, true); // successful read re-arms
    failedStreak = nextStreak;

    if (!best || rates.length === 0) {
      const reason = "no valid USDC market after filters (liquidity<40k / apy>0.30 / fetch empty)";
      ctx.log(`${reason} — skipping`);
      appendLedger({ ts: ctx.timestamp, block: Number(ctx.blockNumber), chainId: ctx.chainId, kind: "skipped", reason });
      return [];
    }
    const bestVenue = VENUES.find((v) => v.id === best!.id)!;
    ctx.log(`rates: ${rates.map((r) => `${r.id}=${(r.apy * 100).toFixed(2)}%`).join(", ")} — best ${best.id} ${(best.apy * 100).toFixed(2)}%`);

    // ── Read position (terrain). Idle = raw USDC, no venue balance.
    // RPC reads (balanceOf / convertToAssets / ctx.read.balance) can time out. A thrown
    // read here used to propagate out of tick() and error the strategy with NO ledger entry
    // — the exact failure mode the Cambrian catch above was written to prevent. Handle it
    // the same way: log, write a "skipped" ledger entry, notify, and return no dispatches.
    // Never throw out of tick() for a read failure.
    let pos: Position;
    let usdcBal: bigint;
    try {
      pos = await readPosition(ctx);
      usdcBal = await ctx.read.balance(USDC);
    } catch (e) {
      failedStreak = new Map(); // a read failure is not a per-venue rate streak
      const reason = `position read failed: ${(e as Error).message.slice(0, 140)}`;
      ctx.log(`${reason} — skipping`);
      void notify(ctx, `tick skipped — ${reason}`);
      appendLedger({ ts: ctx.timestamp, block: Number(ctx.blockNumber), chainId: ctx.chainId, kind: "skipped", reason });
      return [];
    }

    // ── Skip sentinel: the SMA holds balances in multiple venues at once. We never want
    // to fragment or withdraw from the wrong one, so we log + skip and wait for manual
    // intervention (or for one balance to drain to zero on the next tick).
    if (pos.state === "skip") {
      const reason = "multiple venues hold a balance — refusing to guess, skipping";
      ctx.log(`${reason}`);
      appendLedger({ ts: ctx.timestamp, block: Number(ctx.blockNumber), chainId: ctx.chainId, kind: "skipped", reason });
      return [];
    }

    // ── Branch 1: IDLE — redeploy, no rate-gap gate, no cooldown gate.
    // A half-finished rotation (withdraw landed, deposit reverted) leaves USDC idle. The
    // position is supposed to be deployed, so we redeploy into the current best venue
    // immediately. This is never gated by the 24h cooldown (that gates rotations, not
    // redeploying stranded capital) nor by the 0.5pp spread (idle->deployed isn't a
    // rotation between venues). Cap still applies.
    if (pos.state === "idle") {
      if (usdcBal === 0n) {
        const reason = "no USDC anywhere (idle, zero balance) — nothing to deploy";
        ctx.log(`${reason} — skipping`);
        appendLedger({ ts: ctx.timestamp, block: Number(ctx.blockNumber), chainId: ctx.chainId, kind: "skipped", reason });
        return [];
      }
      const amt = usdcBal < PER_TX_CAP ? usdcBal : PER_TX_CAP;
      ctx.log(`idle: ${formatUnits(usdcBal, USDC_DECIMALS)} USDC sitting in SMA — redeploying ${formatUnits(amt, USDC_DECIMALS)} into ${bestVenue.name}`);
      appendLedger({
        ts: ctx.timestamp, block: Number(ctx.blockNumber), chainId: ctx.chainId, kind: "acted",
        action: "deposit", venue: bestVenue.id, note: "idle redeploy (no cooldown/spread gate)",
        // outcome set when reconciled on a later tick; do not write optimistically
      });
      return [intent(depositBatch(bestVenue, amt, ctx.safe, USDC))];
    }

    // ── Branch 2: DEPLOYED — rotate only on >=0.5pp gap AND >=24h since last rotation.
    const current = pos.venue!;
    const currentRate = rates.find((r) => r.id === current.id);
    if (!currentRate) {
      // We hold a venue whose rate we couldn't read this tick. Fail closed: do NOT rotate
      // away from it on a missing number (a network blip shouldn't trigger a move), but also
      // don't pretend it's fine. Log + skip; next tick re-reads.
      const reason = `current venue ${current.id} rate unreadable this tick — not rotating on a missing number`;
      ctx.log(`${reason} — skipping`);
      appendLedger({ ts: ctx.timestamp, block: Number(ctx.blockNumber), chainId: ctx.chainId, kind: "skipped", reason });
      return [];
    }

    // ── Stillness alert. Prolonged stillness — holding one venue with no rotation — is
    // either a correct decision or a broken comparison, and nothing in the loop
    // distinguishes them. Surface it once after STALE_VENUE_SEC, then suppress until the
    // held venue is no longer stale (a confirmed rotation moves heldSince forward, which
    // re-arms). heldSince is the last confirmed rotation's ts (or the first ledger entry if
    // the agent has never rotated). A fresh ledger (heldSince 0) never alerts.
    const heldSince = readHeldSinceSec();
    const stale = heldSince > 0 && ctx.timestamp - heldSince >= STALE_VENUE_SEC;
    if (stale) {
      if (stillnessArmed) {
        stillnessArmed = false; // suppress until no longer stale
        void notify(ctx, `held ${current.id} ${Math.floor((ctx.timestamp - heldSince) / 86400)}d — no rotation (check rates)`);
      }
    } else {
      stillnessArmed = true; // re-arm: a rotation moved heldSince forward (or never stale)
    }

    const lastRotation = readLastRotationSec();
    const sinceLast = ctx.timestamp - lastRotation;
    if (lastRotation > 0 && sinceLast < ROTATION_COOLDOWN_SEC) {
      const reason = `cooldown: last rotation ${sinceLast}s ago, interval ${ROTATION_COOLDOWN_SEC}s`;
      ctx.log(`${reason} — skipping`);
      appendLedger({ ts: ctx.timestamp, block: Number(ctx.blockNumber), chainId: ctx.chainId, kind: "skipped", reason });
      return [];
    }

    const spread = best.apy - currentRate.apy;
    // ── Zero-spread alert. A spread of exactly 0.000pp between two DIFFERENT venues is the
    // signature of comparing a rate against itself — a phantom rate from a vault the agent
    // cannot reach, or two venues reporting an identical number. Three consecutive such
    // spreads → notify once, then suppress until a real non-zero spread is seen (which
    // re-arms). A zero spread with best.id === current.id is the agent correctly holding the
    // best venue — not a phantom, never counted. Repeatedly escaped detection for days.
    if (spread === 0 && best.id !== current.id) {
      zeroSpreadStreak += 1;
      if (zeroSpreadStreak >= ZERO_SPREAD_ALERT_TICKS && zeroSpreadArmed) {
        zeroSpreadArmed = false; // suppress until a non-zero spread re-arms
        void notify(ctx, `spread 0.000pp ${zeroSpreadStreak} ticks in a row — possible phantom-rate self-compare`);
      }
    } else {
      zeroSpreadStreak = 0;
      zeroSpreadArmed = true; // re-arm: a real non-zero spread (or self-hold) was seen
    }
    if (best.id === current.id || spread < MIN_SPREAD_TO_ROTATE) {
      const reason = `no rotate: best ${best.id} ${(best.apy * 100).toFixed(2)}% vs current ${current.id} ${(currentRate.apy * 100).toFixed(2)}% (spread ${(spread * 100).toFixed(3)}pp < ${MIN_SPREAD_TO_ROTATE * 100}pp)`;
      ctx.log(`${reason} — skipping`);
      appendLedger({ ts: ctx.timestamp, block: Number(ctx.blockNumber), chainId: ctx.chainId, kind: "skipped", reason });
      return [];
    }

    // ── Act: rotate. Withdraw from current (amount-1, recipient=SMA), then deposit into
    // best. Two dispatches in order: the withdraw returns USDC to the SMA, the deposit batch
    // consumes it. Both within the per-tx cap. pos.assets is the position value in USDC
    // (6 dec) — for ERC-4626 venues readPosition() already converted shares → assets via
    // convertToAssets, so this is an asset-to-asset comparison against the 6-dec PER_TX_CAP.
    const amt = pos.assets < PER_TX_CAP ? pos.assets : PER_TX_CAP;
    ctx.log(`rotate: withdraw ${formatUnits(amt, USDC_DECIMALS)} from ${current.name}, deposit into ${bestVenue.name} (spread ${(spread * 100).toFixed(3)}pp)`);
    appendLedger({
      ts: ctx.timestamp, block: Number(ctx.blockNumber), chainId: ctx.chainId, kind: "acted",
      action: "rotate", venue: bestVenue.id, from: current.id,
      note: `spread ${(spread * 100).toFixed(4)}pp`,
    });
    return [
      intent([withdrawCall(current, amt, ctx.safe, USDC)]),
      intent(depositBatch(bestVenue, amt, ctx.safe, USDC)),
    ];
  },
};
