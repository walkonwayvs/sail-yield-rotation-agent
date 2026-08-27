// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";

/// Base-fork integration test for yieldRotate — deposit AND withdraw paths, all 3 venues.
///
/// This test does NOT construct its own calldata. It reads JSON fixtures produced by
/// scripts/gen-fixtures.ts, which imports the agent's REAL readPosition(), withdrawCall(),
/// and depositBatch() from src/agent.ts, runs them against a live Base RPC read, and writes
/// the resulting calldata + position amounts to:
///   contracts/test/fixtures/deposit-fixtures.json   (per-venue deposit calldata)
///   contracts/test/fixtures/withdraw-fixtures.json  (per-venue withdraw calldata)
///
/// Why this structure: the agent is TypeScript and the test is Solidity, so any forge test
/// will always reimplement the *call*. The previous version hardcoded amounts and built its
/// own withdraw(assets,...) calls — which passed even while the agent fed share balances
/// (18 decimals) into the assets slot (6 decimals), because the test's hardcoded amounts
/// were correct asset values the agent never produced. By sourcing the calldata from the
/// agent itself via a fixture, a broken agent produces a broken fixture, and the assertions
/// below catch it.
///
/// The SMA is a Safe: when the kernel dispatches an approved call, msg.sender to the venue
/// IS the SMA. vm.startPrank(SMA) replicates that exactly, including Euler/EVC's
/// "caller == onBehalfOf account" authentication.
///
/// Configuration: SMA_ADDRESS, USDC_ADDRESS, and AAVE_A_TOKEN_ADDRESS are read from
/// environment variables via vm.envAddress. See .env.example.

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
}

interface IERC4626 {
    function asset() external view returns (address);
    function maxWithdraw(address owner) external view returns (uint256);
    function convertToAssets(uint256 shares) external view returns (uint256);
}

contract YieldRotateForkTest is Test {
    address SMA;         // set in setUp from vm.envAddress("SMA_ADDRESS")
    address USDC;        // set in setUp from vm.envAddress("USDC_ADDRESS")
    address AAVE_A_TOKEN; // set in setUp from vm.envAddress("AAVE_A_TOKEN_ADDRESS")

    // Fixture JSON, loaded once in setUp.
    string depositJson;
    string withdrawJson;

    function setUp() public {
        SMA = vm.envAddress("SMA_ADDRESS");
        USDC = vm.envAddress("USDC_ADDRESS");
        AAVE_A_TOKEN = vm.envAddress("AAVE_A_TOKEN_ADDRESS");

        vm.createSelectFork(vm.envString("BASE_RPC_URL"));

        depositJson = vm.readFile("test/fixtures/deposit-fixtures.json");
        withdrawJson = vm.readFile("test/fixtures/withdraw-fixtures.json");
    }

    // ── Helpers ─────────────────────────────────────────────────────────────────

    /// Load a venue's deposit calls from the fixture JSON and replay them under
    /// vm.startPrank(SMA). Returns the USDC balance of the SMA after the deposit.
    function _replayDeposit(string memory venueKey) internal returns (uint256) {
        // Deposit batch is always 3 calls: [approve, deposit, approve(0)]. Stored as flat
        // fields (call0..call2) because this forge version lacks vm.parseJsonArrayLength.
        // Deal the SMA enough USDC to cover the deposit amount.
        uint256 depositAmount = vm.parseJsonUint(depositJson, string.concat(".", venueKey, ".depositAmount"));
        deal(USDC, SMA, depositAmount);

        uint256 usdcBefore = IERC20(USDC).balanceOf(SMA);
        assertEq(usdcBefore, depositAmount, "deal did not set USDC balance");

        // Replay each call as the SMA (the kernel dispatches from the SMA).
        vm.startPrank(SMA);
        for (uint256 i = 0; i < 3; i++) {
            string memory prefix = string.concat(".", venueKey, ".call", vm.toString(i));
            address target = vm.parseJsonAddress(depositJson, string.concat(prefix, "Target"));
            bytes memory data = vm.parseJsonBytes(depositJson, string.concat(prefix, "Data"));
            (bool ok, bytes memory ret) = target.call(data);
            if (!ok) {
                console2.log("[deposit] call", i, "REVERTED for", venueKey);
                console2.logBytes(ret);
            }
            require(ok, "deposit call reverted");
        }
        vm.stopPrank();

        uint256 usdcAfter = IERC20(USDC).balanceOf(SMA);
        return usdcAfter;
    }

    /// Load a venue's withdraw calldata from the fixture JSON and replay it under
    /// vm.prank(SMA). Returns the USDC received (balance delta).
    function _replayWithdraw(string memory venueKey) internal returns (uint256 received, bool ok, bytes memory ret) {
        address withdrawTarget = vm.parseJsonAddress(withdrawJson, string.concat(".", venueKey, ".withdrawTarget"));
        bytes memory withdrawData = vm.parseJsonBytes(withdrawJson, string.concat(".", venueKey, ".withdrawData"));

        uint256 usdcBefore = IERC20(USDC).balanceOf(SMA);

        vm.prank(SMA);
        (ok, ret) = withdrawTarget.call(withdrawData);

        uint256 usdcAfter = IERC20(USDC).balanceOf(SMA);
        received = usdcAfter > usdcBefore ? usdcAfter - usdcBefore : 0;
    }

    /// Assert that `received` is within `tolerancePct` percent of `expected`.
    function _assertWithinPct(uint256 received, uint256 expected, uint256 tolerancePct, string memory label) internal pure {
        uint256 lower = expected * (100 - tolerancePct) / 100;
        uint256 upper = expected * (100 + tolerancePct) / 100;
        require(received >= lower, string.concat(label, ": received < ", vm.toString(tolerancePct), "% of position"));
        require(received <= upper, string.concat(label, ": received > ", vm.toString(tolerancePct), "% of position"));
    }

    // ════════════════════════════════════════════════════════════════════════════
    // DEPOSIT TESTS — all 3 venues. Sources calldata from depositBatch() via fixture.
    // ════════════════════════════════════════════════════════════════════════════

    function test_deposit_aave() public {
        uint256 depositAmount = vm.parseJsonUint(depositJson, ".aave.depositAmount");

        // aToken balance before
        uint256 aTokenBefore = IERC20(AAVE_A_TOKEN).balanceOf(SMA);

        uint256 usdcAfter = _replayDeposit("aave");

        // USDC should be consumed.
        assertLt(usdcAfter, depositAmount, "aave deposit: USDC not consumed");

        // aToken balance should have increased by ~depositAmount (aTokens are 1:1 with USDC).
        uint256 aTokenAfter = IERC20(AAVE_A_TOKEN).balanceOf(SMA);
        uint256 minted = aTokenAfter - aTokenBefore;
        assertGt(minted, 0, "aave deposit: no aToken minted");
        _assertWithinPct(minted, depositAmount, 2, "aave deposit: aToken minted");
        console2.log("[deposit aave] minted aToken:", minted);
    }

    function test_deposit_morpho() public {
        address venueAddr = vm.parseJsonAddress(depositJson, ".morpho.venueAddress");
        uint256 depositAmount = vm.parseJsonUint(depositJson, ".morpho.depositAmount");

        // Vault share balance before
        uint256 sharesBefore = IERC20(venueAddr).balanceOf(SMA);

        uint256 usdcAfter = _replayDeposit("morpho");

        assertLt(usdcAfter, depositAmount, "morpho deposit: USDC not consumed");

        // Share balance should have increased. Shares are 18-dec; convertToAssets should
        // return ~depositAmount (6-dec USDC).
        uint256 sharesAfter = IERC20(venueAddr).balanceOf(SMA);
        uint256 sharesMinted = sharesAfter - sharesBefore;
        assertGt(sharesMinted, 0, "morpho deposit: no shares minted");

        uint256 assetsValue = IERC4626(venueAddr).convertToAssets(sharesMinted);
        _assertWithinPct(assetsValue, depositAmount, 2, "morpho deposit: share value");
        console2.log("[deposit morpho] share value:", assetsValue);
    }

    function test_deposit_euler() public {
        address venueAddr = vm.parseJsonAddress(depositJson, ".euler.venueAddress");
        uint256 depositAmount = vm.parseJsonUint(depositJson, ".euler.depositAmount");

        uint256 sharesBefore = IERC20(venueAddr).balanceOf(SMA);

        uint256 usdcAfter = _replayDeposit("euler");

        assertLt(usdcAfter, depositAmount, "euler deposit: USDC not consumed");

        uint256 sharesAfter = IERC20(venueAddr).balanceOf(SMA);
        uint256 sharesMinted = sharesAfter - sharesBefore;
        assertGt(sharesMinted, 0, "euler deposit: no shares minted");

        uint256 assetsValue = IERC4626(venueAddr).convertToAssets(sharesMinted);
        _assertWithinPct(assetsValue, depositAmount, 2, "euler deposit: share value");
        console2.log("[deposit euler] share value:", assetsValue);
    }

    // ════════════════════════════════════════════════════════════════════════════
    // WITHDRAW TESTS — all 3 venues. Sources calldata from withdrawCall() via fixture.
    //
    // If the SMA has a live position → replay the withdraw directly.
    // If no live position → deposit first (from deposit fixture), then replay the withdraw
    //   against the position that creates.
    // ════════════════════════════════════════════════════════════════════════════

    function test_withdraw_morpho() public {
        uint256 positionAssets = vm.parseJsonUint(withdrawJson, ".morpho.positionAssets");
        require(positionAssets > 0, "morpho fixture: positionAssets must be > 0");

        (uint256 received, bool ok, bytes memory ret) = _replayWithdraw("morpho");
        if (!ok) {
            console2.log("[withdraw morpho] REVERTED");
            console2.logBytes(ret);
        }
        assertTrue(ok, "morpho withdraw reverted on live fork");

        console2.log("[withdraw morpho] received:", received, "position:", positionAssets);
        assertGt(received, 0, "morpho withdraw returned zero USDC");

        // The amount received must be within 5% of the position value. This is the assertion
        // that catches the shares-vs-assets bug: a share balance fed into the assets slot
        // would either revert or withdraw a nonsensical amount.
        _assertWithinPct(received, positionAssets, 5, "morpho withdraw");
    }

    function test_withdraw_aave() public {
        // No live position — deposit first, then withdraw.
        _replayDeposit("aave");

        uint256 positionAssets = vm.parseJsonUint(withdrawJson, ".aave.positionAssets");
        require(positionAssets > 0, "aave fixture: positionAssets must be > 0");

        (uint256 received, bool ok, bytes memory ret) = _replayWithdraw("aave");
        if (!ok) {
            console2.log("[withdraw aave] REVERTED");
            console2.logBytes(ret);
        }
        assertTrue(ok, "aave withdraw reverted on live fork");

        console2.log("[withdraw aave] received:", received, "position:", positionAssets);
        assertGt(received, 0, "aave withdraw returned zero USDC");
        _assertWithinPct(received, positionAssets, 5, "aave withdraw");
    }

    function test_withdraw_euler() public {
        // No live position — deposit first, then withdraw.
        _replayDeposit("euler");

        uint256 positionAssets = vm.parseJsonUint(withdrawJson, ".euler.positionAssets");
        require(positionAssets > 0, "euler fixture: positionAssets must be > 0");

        (uint256 received, bool ok, bytes memory ret) = _replayWithdraw("euler");
        if (!ok) {
            console2.log("[withdraw euler] REVERTED");
            console2.logBytes(ret);
        }
        assertTrue(ok, "euler withdraw reverted on live fork");

        console2.log("[withdraw euler] received:", received, "position:", positionAssets);
        assertGt(received, 0, "euler withdraw returned zero USDC");
        _assertWithinPct(received, positionAssets, 5, "euler withdraw");
    }

    // ════════════════════════════════════════════════════════════════════════════
    // AMOUNT-CORRECTNESS GUARD — the assertion that would have caught the original bug.
    //
    // The fixture's positionAssets must be a sane USDC value, not a share balance. A share
    // balance (18 decimals) would fail both bounds. This runs against whichever venue has a
    // live position in the fixture.
    // ════════════════════════════════════════════════════════════════════════════

    function test_fixture_position_is_asset_denominated() public view {
        uint256 positionAssets = vm.parseJsonUint(withdrawJson, ".morpho.positionAssets");

        // positionAssets should be in the 6-dec USDC range for a reasonable position.
        // A share balance (18 dec) cannot fall into this band.
        assertGe(positionAssets, 1_000_000, "positionAssets too small - looks like a share balance, not assets");
        assertLe(positionAssets, 500_000_000, "positionAssets too large - looks like a share balance, not assets");
    }

    /// For ERC-4626 venues: cross-check the agent's positionAssets against the vault's own
    /// maxWithdraw(SMA). They should agree (both are asset-denominated USDC values for the
    /// same position). A share balance would not match.
    function test_position_matches_vault_maxWithdraw() public view {
        address venueAddr = vm.parseJsonAddress(withdrawJson, ".morpho.venueAddress");
        uint256 positionAssets = vm.parseJsonUint(withdrawJson, ".morpho.positionAssets");

        uint256 vaultMax = IERC4626(venueAddr).maxWithdraw(SMA);
        console2.log("[maxWithdraw] vault:", vaultMax, "agent:", positionAssets);

        // convertToAssets and maxWithdraw can differ by a few base units (rate accrual between
        // the fixture block and this fork block). 2% tolerance.
        uint256 lower = positionAssets * 98 / 100;
        uint256 upper = positionAssets * 102 / 100;
        assertGe(vaultMax, lower, "vault maxWithdraw < 98% of agent positionAssets");
        assertLe(vaultMax, upper, "vault maxWithdraw > 102% of agent positionAssets");
    }
}
