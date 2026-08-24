#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short, token,
    Address, BytesN, Env, String, Vec,
};

// ─── Constants ───────────────────────────────────────────────────────────────

// These are `pub` on purpose: the property-based invariant suite in
// `tests/fuzz/` derives its input strategies and expected-value models from
// them, so the tests and the contract can never disagree about a boundary.
// See docs/INVARIANTS.md.

/// TTL extension applied to persistent escrow records (~60 days in ledgers).
const ESCROW_BUMP_LEDGERS: u32 = 518_400;

/// Minimum remaining TTL before a bump is triggered (~24 h in ledgers).
const ESCROW_MIN_TTL: u32 = 17_280;

/// Denominator for every basis-point fee calculation.
pub const MAX_BASIS_POINTS: u32 = 10_000;

/// How many ledgers after `lock` the buyer may still raise a dispute.
pub const DISPUTE_WINDOW_LEDGERS: u32 = 1_000;

/// Hard cap on the platform fee: 2 000 bps = 20 %.
pub const MAX_FEE_BPS: u32 = 2_000;

/// Minimum lock amount in stroops (0.001 USDC).
pub const MIN_LOCK_AMOUNT: i128 = 10_000;

/// Maximum escrow expiry: 30 days in seconds.
pub const MAX_EXPIRY_SECONDS: u64 = 30 * 24 * 60 * 60;

/// Per-escrow amount ceiling applied when the admin has not set one.
pub const DEFAULT_MAX_ESCROW_AMOUNT: i128 = 1_000_000_000_000;

/// Per-ledger escrow-creation ceiling applied when the admin has not set one.
pub const DEFAULT_MAX_ESCROWS_PER_LEDGER: u32 = 100;

/// Floor for the timelock delay (~0.6 h of 5 s ledgers). Prevents an
/// accidental `delay = 0` configuration from ever taking effect; delay
/// changes are themselves timelocked, so the floor is an outer bound on how
/// fast any single configuration can change.
pub const MIN_TIMELOCK_DELAY_LEDGERS: u32 = 500;

/// Ceiling for the timelock delay (~60 days of 5 s ledgers, matching
/// `ESCROW_BUMP_LEDGERS`).
pub const MAX_TIMELOCK_DELAY_LEDGERS: u32 = 518_400;

/// Default timelock delay (~3 days of 5 s ledgers). Sensitive admin actions
/// (`upgrade`, `emergency_withdraw`, admin/treasury/delay changes) cannot take
/// effect before this many ledgers have passed since they were proposed.
pub const DEFAULT_TIMELOCK_DELAY_LEDGERS: u32 = 25_920;

// ─── Storage keys ────────────────────────────────────────────────────────────

#[contracttype]
pub enum DataKey {
    /// Set to `true` the first time initialize() runs. Checked before any
    /// other state is written to guard against re-initialization.
    Initialized,
    Admin,
    Treasury,
    DefaultPlatformFee,
    EscrowCount,
    Paused,
    WhitelistEnforced,
    MaxEscrowAmount,
    MaxEscrowsPerLedger,
    EscrowsThisLedger,
    LastEscrowLedger,
    DatasetFee(String),
    Whitelisted(Address),
    Blacklisted(Address),
    Arbitrator,
    /// Timelock delay in ledgers; defaults to `DEFAULT_TIMELOCK_DELAY_LEDGERS`.
    TimelockDelay,
    /// Pending timelocked `upgrade` (one slot per action type).
    PendingUpgrade,
    /// Pending timelocked emergency sweep.
    PendingWithdrawal,
    /// Pending timelocked, two-step admin handover.
    PendingAdminChange,
    /// Pending timelocked treasury change.
    PendingTreasuryChange,
    /// Pending timelocked delay change.
    PendingDelayChange,
    /// Number of open disputes for a given seller. Incremented in
    /// `raise_dispute`, decremented when a disputed escrow settles.
    /// Read cross-contract by the bond crate in `request_unstake`.
    OpenDisputesBySeller(Address),
}

#[contracttype]
pub enum EscrowKey {
    Record(u64),
}

// ─── Errors ──────────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum HazinaEscrowError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    NotAdmin = 3,
    InvalidFeeBps = 4,
    InvalidAmount = 5,
    AlreadyReleased = 6,
    AlreadyRefunded = 7,
    EscrowNotFound = 8,
    AddressBlacklisted = 9,
    AddressNotWhitelisted = 10,
    EmptyDatasetId = 11,
    Paused = 12,

    AmountExceedsCircuitBreaker = 13,
    RateLimitExceeded = 14,
    NotPaused = 15,
    NotBuyer = 16,
    BuyerNotConfirmed = 17,
    AlreadyConfirmed = 18,
    NotSeller = 19,
    NotExpired = 20,

    AlreadyDisputed = 21,
    DisputeDeadlinePassed = 22,
    NotArbitrator = 23,
    DisputedEscrow = 24,
    NotDisputed = 25,

    PendingActionExists = 26,
    NoPendingAction = 27,
    TimelockNotElapsed = 28,
    InvalidTimelockDelay = 29,
    CandidateMismatch = 30,
    InvalidRecipient = 31,
}

// ─── Types ───────────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowRecord {
    pub escrow_id: u64,
    pub dataset_id: String,
    pub buyer: Address,
    pub seller: Address,
    pub amount: i128,
    pub token: Address,
    pub deadline: u64,
    pub buyer_confirmed: bool,
    pub platform_fee_bps: u32,
    pub released: bool,
    pub refunded: bool,
    pub disputed: bool,
    pub dispute_deadline: Option<u64>,
}

#[contracttype]
#[derive(Clone, Eq, PartialEq)]
pub struct DatasetFeeConfig {
    pub default_fee_bps: u32,
    pub has_custom_fee: bool,
    pub dataset_fee_bps: u32,
    pub effective_fee_bps: u32,
}

#[contracttype]
#[derive(Clone, Eq, PartialEq)]
pub struct AddressPolicy {
    pub whitelisted: bool,
    pub blacklisted: bool,
    pub whitelist_enforced: bool,
    pub can_transact: bool,
}

#[contracttype]
#[derive(Clone, Eq, PartialEq)]
pub struct SellerShare {
    pub seller: Address,
    pub amount: i128,
}

// ─── Timelocked action payloads ───────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingUpgrade {
    pub wasm_hash: BytesN<32>,
    /// Ledger sequence before which the action cannot be executed.
    pub execute_after: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingWithdrawal {
    pub token: Address,
    /// Recipient; constrained to the configured treasury at schedule time.
    pub to: Address,
    pub amount: i128,
    pub execute_after: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingAdminChange {
    pub candidate: Address,
    pub execute_after: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingTreasuryChange {
    pub treasury: Address,
    pub execute_after: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingDelayChange {
    pub delay: u32,
    pub execute_after: u64,
}

// ─── Contract ────────────────────────────────────────────────────────────────

#[contract]
pub struct HazinaEscrow;

#[contractimpl]
impl HazinaEscrow {
    // ─── Initialization ──────────────────────────────────────────────────────

    /// One-time setup. Panics with `AlreadyInitialized` on any subsequent call.
    /// The `Initialized` flag is written *before* any other state so there is
    /// no window for partial re-init even if a future upgrade bug exists.
    pub fn initialize(env: Env, admin: Address, platform_fee_bps: u32) {
        if env.storage().instance().has(&DataKey::Initialized) {
            panic_with_error!(&env, HazinaEscrowError::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Initialized, &true);

        Self::assert_valid_fee(&env, platform_fee_bps);

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::DefaultPlatformFee, &platform_fee_bps);
        env.storage().instance().set(&DataKey::EscrowCount, &0u64);
        env.storage()
            .instance()
            .set(&DataKey::WhitelistEnforced, &false);
        env.storage().instance().set(&DataKey::Paused, &false);
    }

    // ─── Pause / unpause ─────────────────────────────────────────────────────

    pub fn pause(env: Env, admin: Address) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);
        env.storage().instance().set(&DataKey::Paused, &true);
        env.events().publish((symbol_short!("paused"),), admin);
    }

    pub fn unpause(env: Env, admin: Address) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);
        env.storage().instance().set(&DataKey::Paused, &false);
        env.events().publish((symbol_short!("unpaused"),), admin);
    }

    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    // ─── Fee management ──────────────────────────────────────────────────────

    pub fn set_default_fee(env: Env, admin: Address, fee_bps: u32) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);
        Self::assert_valid_fee(&env, fee_bps);
        env.storage()
            .instance()
            .set(&DataKey::DefaultPlatformFee, &fee_bps);
        env.events()
            .publish((symbol_short!("fee_upd"),), (admin, fee_bps));
    }

    /// Alias for `set_default_fee` kept for backward compatibility.
    pub fn set_fee(env: Env, admin: Address, fee_bps: u32) {
        Self::set_default_fee(env, admin, fee_bps);
    }

    /// Alias for `set_default_fee` kept for backward compatibility.
    pub fn update_fee(env: Env, admin: Address, fee_bps: u32) {
        Self::set_default_fee(env, admin, fee_bps);
    }

    pub fn get_default_fee(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::DefaultPlatformFee)
            .unwrap_or(500)
    }

    /// Alias for `get_default_fee` kept for backward compatibility.
    pub fn get_fee(env: Env) -> u32 {
        Self::get_default_fee(env)
    }

    pub fn set_dataset_fee(env: Env, admin: Address, dataset_id: String, fee_bps: u32) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);
        Self::assert_valid_dataset_id(&env, &dataset_id);
        Self::assert_valid_fee(&env, fee_bps);
        env.storage()
            .persistent()
            .set(&DataKey::DatasetFee(dataset_id.clone()), &fee_bps);
        env.events()
            .publish((symbol_short!("dsf_upd"),), (dataset_id, fee_bps));
    }

    pub fn clear_dataset_fee(env: Env, admin: Address, dataset_id: String) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);
        Self::assert_valid_dataset_id(&env, &dataset_id);
        env.storage()
            .persistent()
            .remove(&DataKey::DatasetFee(dataset_id.clone()));
        env.events()
            .publish((symbol_short!("dsf_clr"),), dataset_id);
    }

    pub fn get_dataset_fee_config(env: Env, dataset_id: String) -> DatasetFeeConfig {
        Self::assert_valid_dataset_id(&env, &dataset_id);
        let default_fee_bps = Self::get_default_fee(env.clone());
        let dataset_fee_bps: Option<u32> = env
            .storage()
            .persistent()
            .get(&DataKey::DatasetFee(dataset_id));
        let effective_fee_bps = dataset_fee_bps.unwrap_or(default_fee_bps);
        DatasetFeeConfig {
            default_fee_bps,
            has_custom_fee: dataset_fee_bps.is_some(),
            dataset_fee_bps: dataset_fee_bps.unwrap_or(default_fee_bps),
            effective_fee_bps,
        }
    }

    // ─── Treasury ────────────────────────────────────────────────────────────

    pub fn get_treasury(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::Treasury)
    }

    // ─── Timelock config ─────────────────────────────────────────────────────

    /// The delay, in ledgers, between proposing a sensitive admin action and
    /// being allowed to execute it.
    pub fn get_timelock_delay(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::TimelockDelay)
            .unwrap_or(DEFAULT_TIMELOCK_DELAY_LEDGERS)
    }

    /// Propose changing the timelock delay. Takes effect (if at all) after the
    /// *current* configured delay has elapsed, so an admin cannot shrink the
    /// window around themselves faster than the current window allows.
    pub fn schedule_set_timelock_delay(env: Env, admin: Address, delay: u32) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);
        if !(MIN_TIMELOCK_DELAY_LEDGERS..=MAX_TIMELOCK_DELAY_LEDGERS).contains(&delay) {
            panic_with_error!(&env, HazinaEscrowError::InvalidTimelockDelay);
        }
        let execute_after = Self::propose_with_current_delay(&env);
        Self::store_pending(
            &env,
            DataKey::PendingDelayChange,
            &PendingDelayChange {
                delay,
                execute_after,
            },
        );
        env.events()
            .publish((symbol_short!("tl_sched"),), (delay, execute_after));
    }

    /// Anyone may execute a delay change once its timelock has elapsed.
    pub fn execute_set_timelock_delay(env: Env) {
        let pending: PendingDelayChange = Self::read_pending(&env, DataKey::PendingDelayChange);
        Self::assert_executable(&env, pending.execute_after);
        Self::remove_pending(&env, &DataKey::PendingDelayChange);
        env.storage()
            .instance()
            .set(&DataKey::TimelockDelay, &pending.delay);
        env.events()
            .publish((symbol_short!("tl_exec"),), (pending.delay,));
    }

    pub fn cancel_set_timelock_delay(env: Env, admin: Address) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);
        Self::remove_pending(&env, &DataKey::PendingDelayChange);
        env.events().publish((symbol_short!("tl_canc"),), ());
    }

    // ─── Timelocked upgrade ──────────────────────────────────────────────────

    /// Propose swapping the contract's WASM. The hash is public and immutable
    /// until `execute_upgrade` fires (or the admin cancels), so users get a
    /// real window to observe the pending change before it can take effect.
    pub fn schedule_upgrade(env: Env, admin: Address, new_wasm_hash: BytesN<32>) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);
        let execute_after = Self::propose_with_current_delay(&env);
        Self::store_pending(
            &env,
            DataKey::PendingUpgrade,
            &PendingUpgrade {
                wasm_hash: new_wasm_hash.clone(),
                execute_after,
            },
        );
        env.events()
            .publish((symbol_short!("up_sched"),), (new_wasm_hash, execute_after));
    }

    /// Anyone may deploy the proposed WASM once the timelock has elapsed.
    pub fn execute_upgrade(env: Env) {
        let pending: PendingUpgrade = Self::read_pending(&env, DataKey::PendingUpgrade);
        Self::assert_executable(&env, pending.execute_after);
        Self::remove_pending(&env, &DataKey::PendingUpgrade);
        env.events()
            .publish((symbol_short!("up_exec"),), (pending.wasm_hash.clone(),));
        env.deployer()
            .update_current_contract_wasm(pending.wasm_hash);
    }

    pub fn cancel_upgrade(env: Env, admin: Address) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);
        Self::remove_pending(&env, &DataKey::PendingUpgrade);
        env.events().publish((symbol_short!("up_canc"),), ());
    }

    // ─── Address policy ──────────────────────────────────────────────────────

    pub fn set_whitelist_enforced(env: Env, admin: Address, enforced: bool) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);
        env.storage()
            .instance()
            .set(&DataKey::WhitelistEnforced, &enforced);
        env.events()
            .publish((symbol_short!("wl_mode"),), (admin, enforced));
    }

    pub fn set_address_whitelisted(env: Env, admin: Address, address: Address, whitelisted: bool) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);
        env.storage()
            .persistent()
            .set(&DataKey::Whitelisted(address.clone()), &whitelisted);
        env.events()
            .publish((symbol_short!("addr_wl"),), (address, whitelisted));
    }

    pub fn set_address_blacklisted(env: Env, admin: Address, address: Address, blacklisted: bool) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);
        env.storage()
            .persistent()
            .set(&DataKey::Blacklisted(address.clone()), &blacklisted);
        env.events()
            .publish((symbol_short!("addr_bl"),), (address, blacklisted));
    }

    pub fn get_address_policy(env: Env, address: Address) -> AddressPolicy {
        let whitelist_enforced = env
            .storage()
            .instance()
            .get(&DataKey::WhitelistEnforced)
            .unwrap_or(false);
        let whitelisted = env
            .storage()
            .persistent()
            .get(&DataKey::Whitelisted(address.clone()))
            .unwrap_or(false);
        let blacklisted = env
            .storage()
            .persistent()
            .get(&DataKey::Blacklisted(address))
            .unwrap_or(false);
        AddressPolicy {
            whitelisted,
            blacklisted,
            whitelist_enforced,
            can_transact: !blacklisted && (!whitelist_enforced || whitelisted),
        }
    }

    // ─── Circuit-breaker config ───────────────────────────────────────────────

    pub fn set_max_escrow_amount(env: Env, admin: Address, max_amount: i128) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);
        if max_amount <= 0 {
            panic_with_error!(&env, HazinaEscrowError::InvalidAmount);
        }
        env.storage()
            .instance()
            .set(&DataKey::MaxEscrowAmount, &max_amount);
        env.events()
            .publish((symbol_short!("cb_amt"),), (admin, max_amount));
    }

    pub fn set_max_escrows_per_ledger(env: Env, admin: Address, max_per_ledger: u32) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);
        if max_per_ledger == 0 {
            panic_with_error!(&env, HazinaEscrowError::InvalidAmount);
        }
        env.storage()
            .instance()
            .set(&DataKey::MaxEscrowsPerLedger, &max_per_ledger);
        env.events()
            .publish((symbol_short!("cb_rate"),), (admin, max_per_ledger));
    }

    pub fn get_max_escrow_amount(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::MaxEscrowAmount)
            .unwrap_or(DEFAULT_MAX_ESCROW_AMOUNT)
    }

    pub fn get_max_escrows_per_ledger(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::MaxEscrowsPerLedger)
            .unwrap_or(DEFAULT_MAX_ESCROWS_PER_LEDGER)
    }

    // ─── Escrow lifecycle ─────────────────────────────────────────────────────

    pub fn lock(
        env: Env,
        buyer: Address,
        seller: Address,
        token: Address,
        amount: i128,
        dataset_id: String,
        expiry_seconds: u64,
    ) -> u64 {
        buyer.require_auth();
        Self::assert_not_paused(&env);
        Self::assert_valid_amount(&env, amount);
        if expiry_seconds == 0 || expiry_seconds > MAX_EXPIRY_SECONDS {
            panic_with_error!(&env, HazinaEscrowError::InvalidAmount);
        }
        Self::assert_valid_dataset_id(&env, &dataset_id);
        Self::assert_valid_token(&env, &token);
        Self::assert_valid_parties(&env, &buyer, &seller);
        Self::require_operational_address(&env, &buyer);
        Self::require_operational_address(&env, &seller);
        Self::check_amount_circuit_breaker(&env, amount);
        Self::check_rate_circuit_breaker_n(&env, 1);

        let token_client = token::Client::new(&env, &token);
        token_client.transfer(&buyer, &env.current_contract_address(), &amount);

        let fee_bps = Self::resolve_fee_bps(&env, &dataset_id);
        let escrow_id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::EscrowCount)
            .unwrap_or(0);

        let now = env.ledger().timestamp();
        let deadline = now.saturating_add(expiry_seconds);

        let record = EscrowRecord {
            escrow_id,
            dataset_id,
            buyer: buyer.clone(),
            seller: seller.clone(),
            amount,
            token,
            deadline,
            buyer_confirmed: false,
            platform_fee_bps: fee_bps,
            released: false,
            refunded: false,
            disputed: false,
            dispute_deadline: Some(env.ledger().sequence() as u64 + DISPUTE_WINDOW_LEDGERS as u64),
        };

        env.storage()
            .persistent()
            .set(&EscrowKey::Record(escrow_id), &record);
        env.storage().persistent().extend_ttl(
            &EscrowKey::Record(escrow_id),
            ESCROW_MIN_TTL,
            ESCROW_BUMP_LEDGERS,
        );
        env.storage()
            .instance()
            .set(&DataKey::EscrowCount, &(escrow_id + 1));

        env.events().publish(
            (symbol_short!("locked"),),
            (escrow_id, buyer, seller, amount, fee_bps),
        );
        escrow_id
    }

    /// Lock a single payment split across multiple sellers.
    /// Escrows get a default 1-hour deadline. Returns the first escrow ID.
    pub fn lock_multi(
        env: Env,
        buyer: Address,
        token: Address,
        shares: Vec<SellerShare>,
        dataset_ids: Vec<String>,
    ) -> u64 {
        buyer.require_auth();
        Self::assert_not_paused(&env);
        if shares.is_empty() || shares.len() != dataset_ids.len() {
            panic_with_error!(&env, HazinaEscrowError::EscrowNotFound);
        }

        Self::assert_valid_token(&env, &token);

        Self::require_operational_address(&env, &buyer);

        let mut total_amount: i128 = 0;
        let mut i: u32 = 0;
        while i < shares.len() {
            let share = shares
                .get(i)
                .unwrap_or_else(|| panic_with_error!(&env, HazinaEscrowError::EscrowNotFound));
            Self::assert_valid_amount(&env, share.amount);
            Self::check_amount_circuit_breaker(&env, share.amount);
            Self::require_operational_address(&env, &share.seller);
            total_amount += share.amount;
            i += 1;
        }

        Self::check_rate_circuit_breaker_n(&env, shares.len());

        let token_client = token::Client::new(&env, &token);
        token_client.transfer(&buyer, &env.current_contract_address(), &total_amount);

        let first_id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::EscrowCount)
            .unwrap_or(0);
        let mut next_id = first_id;
        let now = env.ledger().timestamp();
        let deadline = now.saturating_add(3_600u64);

        let mut j: u32 = 0;
        while j < shares.len() {
            let share = shares
                .get(j)
                .unwrap_or_else(|| panic_with_error!(&env, HazinaEscrowError::EscrowNotFound));
            let dataset_id = dataset_ids
                .get(j)
                .unwrap_or_else(|| panic_with_error!(&env, HazinaEscrowError::EscrowNotFound));
            Self::assert_valid_dataset_id(&env, &dataset_id);
            let fee_bps = Self::resolve_fee_bps(&env, &dataset_id);
            let record = EscrowRecord {
                escrow_id: next_id,
                dataset_id,
                buyer: buyer.clone(),
                seller: share.seller,
                amount: share.amount,
                token: token.clone(),
                deadline,
                buyer_confirmed: false,
                platform_fee_bps: fee_bps,
                released: false,
                refunded: false,
                disputed: false,
                dispute_deadline: Some(
                    env.ledger().sequence() as u64 + DISPUTE_WINDOW_LEDGERS as u64,
                ),
            };
            env.storage()
                .persistent()
                .set(&EscrowKey::Record(next_id), &record);
            env.storage().persistent().extend_ttl(
                &EscrowKey::Record(next_id),
                ESCROW_MIN_TTL,
                ESCROW_BUMP_LEDGERS,
            );
            next_id += 1;
            j += 1;
        }
        env.storage()
            .instance()
            .set(&DataKey::EscrowCount, &next_id);
        first_id
    }

    pub fn set_arbitrator(env: Env, admin: Address, arbitrator: Address) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);
        env.storage()
            .instance()
            .set(&DataKey::Arbitrator, &arbitrator);
        env.events()
            .publish((soroban_sdk::symbol_short!("arbit"),), (admin, arbitrator));
    }

    pub fn raise_dispute(env: Env, buyer: Address, escrow_id: u64, evidence_hash: BytesN<32>) {
        buyer.require_auth();
        let mut record = Self::read_escrow(&env, escrow_id);
        if record.buyer != buyer {
            panic_with_error!(&env, HazinaEscrowError::NotBuyer);
        }
        if record.released {
            panic_with_error!(&env, HazinaEscrowError::AlreadyReleased);
        }
        if record.refunded {
            panic_with_error!(&env, HazinaEscrowError::AlreadyRefunded);
        }
        if record.disputed {
            panic_with_error!(&env, HazinaEscrowError::AlreadyDisputed);
        }
        let deadline = record.dispute_deadline.unwrap_or(0);
        if env.ledger().sequence() as u64 > deadline {
            panic_with_error!(&env, HazinaEscrowError::DisputeDeadlinePassed);
        }
        record.disputed = true;
        env.storage()
            .persistent()
            .set(&EscrowKey::Record(escrow_id), &record);

        // Bump the per-seller open-dispute counter so the bond crate can
        // cross-contract read it in `request_unstake`.
        let seller = record.seller.clone();
        let prev: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::OpenDisputesBySeller(seller.clone()))
            .unwrap_or(0);
        env.storage()
            .persistent()
            .set(&DataKey::OpenDisputesBySeller(seller), &(prev + 1));

        env.events().publish(
            (soroban_sdk::symbol_short!("disp_up"),),
            (escrow_id, buyer, evidence_hash, deadline),
        );
    }

    /// Buyer confirms delivery, unblocking the admin `release` call.
    pub fn confirm_delivery(env: Env, escrow_id: u64, buyer: Address) {
        buyer.require_auth();
        let mut record = Self::read_escrow(&env, escrow_id);
        if record.buyer != buyer {
            panic_with_error!(&env, HazinaEscrowError::NotBuyer);
        }

        if record.buyer_confirmed {
            panic_with_error!(&env, HazinaEscrowError::AlreadyConfirmed);
        }

        if record.released {
            panic_with_error!(&env, HazinaEscrowError::AlreadyReleased);
        }
        if record.refunded {
            panic_with_error!(&env, HazinaEscrowError::AlreadyRefunded);
        }

        if record.disputed {
            panic_with_error!(&env, HazinaEscrowError::AlreadyDisputed);
        }
        record.buyer_confirmed = true;
        env.storage()
            .persistent()
            .set(&EscrowKey::Record(escrow_id), &record);
        env.events()
            .publish((symbol_short!("confirm"),), (escrow_id, buyer));
    }

    pub fn resolve_dispute(env: Env, arbitrator: Address, escrow_id: u64, favour_buyer: bool) {
        arbitrator.require_auth();
        Self::assert_arbitrator(&env, &arbitrator);
        let record = Self::read_escrow(&env, escrow_id);
        if !record.disputed {
            panic_with_error!(&env, HazinaEscrowError::NotDisputed);
        }
        if favour_buyer {
            Self::refund_one(&env, escrow_id);
        } else {
            let admin = Self::get_admin(&env);
            Self::release_disputed_one(&env, &admin, escrow_id);
        }
        env.events().publish(
            (soroban_sdk::symbol_short!("disp_res"),),
            (escrow_id, favour_buyer, arbitrator),
        );
    }

    pub fn release(env: Env, admin: Address, escrow_id: u64) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);
        Self::assert_not_paused(&env);
        Self::release_one(&env, &admin, escrow_id);
    }

    pub fn release_multi(env: Env, admin: Address, escrow_ids: Vec<u64>) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);
        Self::assert_not_paused(&env);
        let mut i: u32 = 0;
        while i < escrow_ids.len() {
            let escrow_id = escrow_ids
                .get(i)
                .unwrap_or_else(|| panic_with_error!(&env, HazinaEscrowError::EscrowNotFound));
            Self::release_one(&env, &admin, escrow_id);
            i += 1;
        }
    }

    pub fn refund(env: Env, admin: Address, escrow_id: u64) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);

        Self::refund_one(&env, escrow_id);
    }

    fn assert_arbitrator(env: &Env, caller: &Address) {
        let arbitrator: Address = env
            .storage()
            .instance()
            .get(&DataKey::Arbitrator)
            .unwrap_or_else(|| {
                env.storage()
                    .instance()
                    .get(&DataKey::Admin)
                    .unwrap_or_else(|| panic_with_error!(env, HazinaEscrowError::NotInitialized))
            });
        if arbitrator != *caller {
            panic_with_error!(env, HazinaEscrowError::NotArbitrator);
        }
    }

    fn refund_one(env: &Env, escrow_id: u64) {
        Self::assert_not_paused(env);

        env.storage().persistent().extend_ttl(
            &EscrowKey::Record(escrow_id),
            ESCROW_MIN_TTL,
            ESCROW_BUMP_LEDGERS,
        );

        let mut record = Self::read_escrow(env, escrow_id);

        if record.released {
            panic_with_error!(env, HazinaEscrowError::AlreadyReleased);
        }
        if record.refunded {
            panic_with_error!(env, HazinaEscrowError::AlreadyRefunded);
        }
        let token_client = token::Client::new(env, &record.token);
        token_client.transfer(
            &env.current_contract_address(),
            &record.buyer,
            &record.amount,
        );
        let was_disputed = record.disputed;
        record.refunded = true;
        record.disputed = false;
        env.storage()
            .persistent()
            .set(&EscrowKey::Record(escrow_id), &record);

        // Decrement the per-seller open-dispute counter when settling
        // a disputed escrow (only incremented for disputed escrows).
        if was_disputed {
            let seller = record.seller.clone();
            let prev: u32 = env
                .storage()
                .persistent()
                .get(&DataKey::OpenDisputesBySeller(seller.clone()))
                .unwrap_or(0);
            if prev > 0 {
                env.storage()
                    .persistent()
                    .set(&DataKey::OpenDisputesBySeller(seller), &(prev - 1));
            }
        }

        env.events().publish(
            (symbol_short!("refunded"),),
            (escrow_id, record.buyer, record.amount),
        );
    }

    fn release_disputed_one(env: &Env, admin: &Address, escrow_id: u64) {
        let mut record = Self::read_escrow(env, escrow_id);
        record.disputed = false;
        // Arbitrator's decision overrides the buyer-confirmation requirement —
        // that gate exists to protect an unresponsive buyer, not a buyer who
        // has already had their dispute heard and resolved against them.
        record.buyer_confirmed = true;
        let seller = record.seller.clone();
        env.storage()
            .persistent()
            .set(&EscrowKey::Record(escrow_id), &record);

        // Decrement the per-seller open-dispute counter.
        let prev: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::OpenDisputesBySeller(seller.clone()))
            .unwrap_or(0);
        if prev > 0 {
            env.storage()
                .persistent()
                .set(&DataKey::OpenDisputesBySeller(seller), &(prev - 1));
        }

        Self::release_one(env, admin, escrow_id);
    }

    /// Seller claims funds after the escrow deadline has passed without release.
    /// The platform fee is withheld in the contract (admin recovers via emergency_withdraw).
    pub fn claim_expired(env: Env, escrow_id: u64, seller: Address) {
        seller.require_auth();
        let mut record = Self::read_escrow(&env, escrow_id);
        if record.seller != seller {
            panic_with_error!(&env, HazinaEscrowError::NotSeller);
        }
        if record.released {
            panic_with_error!(&env, HazinaEscrowError::AlreadyReleased);
        }
        if record.refunded {
            panic_with_error!(&env, HazinaEscrowError::AlreadyRefunded);
        }
        // --- ADD THE DISPUTE CHECK HERE ---
        if record.disputed {
            panic_with_error!(&env, HazinaEscrowError::DisputedEscrow);
        }
        // ---------------------------------
        if env.ledger().timestamp() <= record.deadline {
            panic_with_error!(&env, HazinaEscrowError::NotExpired);
        }

        let calculated_cut =
            record.amount * record.platform_fee_bps as i128 / MAX_BASIS_POINTS as i128;
        let platform_cut =
            if calculated_cut == 0 && record.amount > 0 && record.platform_fee_bps > 0 {
                1
            } else {
                calculated_cut
            };
        let seller_cut = record.amount - platform_cut;

        let token_client = token::Client::new(&env, &record.token);
        token_client.transfer(&env.current_contract_address(), &record.seller, &seller_cut);

        record.released = true;
        env.storage()
            .persistent()
            .set(&EscrowKey::Record(escrow_id), &record);

        env.events()
            .publish((symbol_short!("claimed"),), (escrow_id, seller, seller_cut));
    }

    // ─── Timelocked emergency withdrawal ─────────────────────────────────────

    /// Propose sweeping stuck tokens out of the contract.
    ///
    /// The contract must already be paused (the admin's instant signal that
    /// something is wrong), and the sweep is constrained to the configured
    /// treasury — never an arbitrary address — so even a fully compromised
    /// admin key can only ever steer funds to the treasury, and only after the
    /// timelock, and only while paused. Pausing is instant; moving money is
    /// deliberately not.
    pub fn schedule_emergency_withdraw(
        env: Env,
        admin: Address,
        token: Address,
        to: Address,
        amount: i128,
    ) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);
        if amount <= 0 {
            panic_with_error!(&env, HazinaEscrowError::InvalidAmount);
        }
        Self::assert_paused(&env);
        let allowed: Address = env
            .storage()
            .instance()
            .get(&DataKey::Treasury)
            .unwrap_or_else(|| admin.clone());
        if to != allowed {
            panic_with_error!(&env, HazinaEscrowError::InvalidRecipient);
        }
        let execute_after = Self::propose_with_current_delay(&env);
        Self::store_pending(
            &env,
            DataKey::PendingWithdrawal,
            &PendingWithdrawal {
                token: token.clone(),
                to: to.clone(),
                amount,
                execute_after,
            },
        );
        env.events().publish(
            (symbol_short!("em_sched"),),
            (token, to, amount, execute_after),
        );
    }

    /// Anyone may execute the proposed sweep once the timelock has elapsed and
    /// the contract is still paused (the emergency has not been stood down).
    pub fn execute_emergency_withdraw(env: Env) {
        let pending: PendingWithdrawal = Self::read_pending(&env, DataKey::PendingWithdrawal);
        Self::assert_executable(&env, pending.execute_after);
        Self::assert_paused(&env);
        Self::remove_pending(&env, &DataKey::PendingWithdrawal);
        let token_client = token::Client::new(&env, &pending.token);
        token_client.transfer(
            &env.current_contract_address(),
            &pending.to,
            &pending.amount,
        );
        env.events().publish(
            (symbol_short!("em_exec"),),
            (pending.token, pending.to, pending.amount),
        );
    }

    pub fn cancel_emergency_withdraw(env: Env, admin: Address) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);
        Self::remove_pending(&env, &DataKey::PendingWithdrawal);
        env.events().publish((symbol_short!("em_canc"),), ());
    }

    // ─── Timelocked, two-step admin handover ─────────────────────────────────

    /// Propose a new admin. Nothing changes until the timelock has elapsed and
    /// the candidate confirms by calling `accept_admin` — so a typo'd or hostile
    /// address can never take over unilaterally, and the proposal is visible to
    /// everyone for the duration of the delay.
    pub fn schedule_admin_change(env: Env, admin: Address, candidate: Address) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);
        let execute_after = Self::propose_with_current_delay(&env);
        Self::store_pending(
            &env,
            DataKey::PendingAdminChange,
            &PendingAdminChange {
                candidate: candidate.clone(),
                execute_after,
            },
        );
        env.events()
            .publish((symbol_short!("adm_sched"),), (candidate, execute_after));
    }

    /// The designated candidate completes the handover by authenticating
    /// themselves once the timelock has elapsed.
    pub fn accept_admin(env: Env, candidate: Address) {
        candidate.require_auth();
        let pending: PendingAdminChange = Self::read_pending(&env, DataKey::PendingAdminChange);
        if pending.candidate != candidate {
            panic_with_error!(&env, HazinaEscrowError::CandidateMismatch);
        }
        Self::assert_executable(&env, pending.execute_after);
        Self::remove_pending(&env, &DataKey::PendingAdminChange);
        env.storage().instance().set(&DataKey::Admin, &candidate);
        env.events()
            .publish((symbol_short!("adm_exec"),), (candidate,));
    }

    pub fn cancel_admin_change(env: Env, admin: Address) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);
        Self::remove_pending(&env, &DataKey::PendingAdminChange);
        env.events().publish((symbol_short!("adm_canc"),), ());
    }

    // ─── Timelocked treasury change ──────────────────────────────────────────

    /// Propose changing where platform fees land (and where an emergency sweep
    /// may be routed). The old treasury keeps receiving fees until the change
    /// actually executes.
    pub fn schedule_set_treasury(env: Env, admin: Address, treasury: Address) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);
        let execute_after = Self::propose_with_current_delay(&env);
        Self::store_pending(
            &env,
            DataKey::PendingTreasuryChange,
            &PendingTreasuryChange {
                treasury: treasury.clone(),
                execute_after,
            },
        );
        env.events()
            .publish((symbol_short!("trs_sched"),), (treasury, execute_after));
    }

    pub fn execute_set_treasury(env: Env) {
        let pending: PendingTreasuryChange =
            Self::read_pending(&env, DataKey::PendingTreasuryChange);
        Self::assert_executable(&env, pending.execute_after);
        Self::remove_pending(&env, &DataKey::PendingTreasuryChange);
        env.storage()
            .instance()
            .set(&DataKey::Treasury, &pending.treasury);
        env.events()
            .publish((symbol_short!("trs_exec"),), (pending.treasury,));
    }

    pub fn cancel_set_treasury(env: Env, admin: Address) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);
        Self::remove_pending(&env, &DataKey::PendingTreasuryChange);
        env.events().publish((symbol_short!("trs_canc"),), ());
    }

    // ─── Pending-action getters ──────────────────────────────────────────────

    pub fn get_pending_upgrade(env: Env) -> Option<PendingUpgrade> {
        env.storage().instance().get(&DataKey::PendingUpgrade)
    }

    pub fn get_pending_emergency_withdrawal(env: Env) -> Option<PendingWithdrawal> {
        env.storage().instance().get(&DataKey::PendingWithdrawal)
    }

    pub fn get_pending_admin_change(env: Env) -> Option<PendingAdminChange> {
        env.storage().instance().get(&DataKey::PendingAdminChange)
    }

    pub fn get_pending_treasury_change(env: Env) -> Option<PendingTreasuryChange> {
        env.storage()
            .instance()
            .get(&DataKey::PendingTreasuryChange)
    }

    pub fn get_pending_timelock_delay(env: Env) -> Option<PendingDelayChange> {
        env.storage().instance().get(&DataKey::PendingDelayChange)
    }

    pub fn get_escrow(env: Env, escrow_id: u64) -> EscrowRecord {
        let record = Self::read_escrow(&env, escrow_id);
        env.storage().persistent().extend_ttl(
            &EscrowKey::Record(escrow_id),
            ESCROW_MIN_TTL,
            ESCROW_BUMP_LEDGERS,
        );
        record
    }

    pub fn get_escrow_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::EscrowCount)
            .unwrap_or(0)
    }

    /// Returns the number of currently open (unresolved) disputes for a seller.
    /// Used cross-contract by the bond crate in `request_unstake`.
    /// Named `dspt_cnt` (<= 9 chars) to fit `symbol_short!` for cross-contract calls.
    pub fn dspt_cnt(env: Env, seller: Address) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::OpenDisputesBySeller(seller))
            .unwrap_or(0)
    }

    // ─── Private helpers ─────────────────────────────────────────────────────

    fn assert_admin(env: &Env, caller: &Address) {
        let admin = Self::get_admin(env);
        if admin != *caller {
            panic_with_error!(env, HazinaEscrowError::NotAdmin);
        }
    }

    fn get_admin(env: &Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(env, HazinaEscrowError::NotInitialized))
    }

    // All timelocked actions are gated through these helpers so the
    // invariant is enforced in one place: an action is stored in a single
    // pending slot, becomes executable only after `execute_after`, and is
    // cleared the moment it runs or is cancelled.

    fn timelock_delay(env: &Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::TimelockDelay)
            .unwrap_or(DEFAULT_TIMELOCK_DELAY_LEDGERS)
    }

    /// The ledger sequence at which a freshly proposed action becomes
    /// executable, based on the *currently configured* delay.
    fn propose_with_current_delay(env: &Env) -> u64 {
        env.ledger().sequence() as u64 + Self::timelock_delay(env) as u64
    }

    fn store_pending<T: soroban_sdk::IntoVal<Env, soroban_sdk::Val>>(
        env: &Env,
        key: DataKey,
        payload: &T,
    ) {
        if env.storage().instance().has(&key) {
            panic_with_error!(env, HazinaEscrowError::PendingActionExists);
        }
        env.storage().instance().set(&key, payload);
    }

    fn read_pending<T: soroban_sdk::TryFromVal<Env, soroban_sdk::Val>>(
        env: &Env,
        key: DataKey,
    ) -> T {
        env.storage()
            .instance()
            .get(&key)
            .unwrap_or_else(|| panic_with_error!(env, HazinaEscrowError::NoPendingAction))
    }

    fn remove_pending(env: &Env, key: &DataKey) {
        if !env.storage().instance().has(key) {
            panic_with_error!(env, HazinaEscrowError::NoPendingAction);
        }
        env.storage().instance().remove(key);
    }

    fn assert_executable(env: &Env, execute_after: u64) {
        if (env.ledger().sequence() as u64) < execute_after {
            panic_with_error!(env, HazinaEscrowError::TimelockNotElapsed);
        }
    }

    fn assert_valid_fee(env: &Env, fee_bps: u32) {
        if fee_bps > MAX_FEE_BPS {
            panic_with_error!(env, HazinaEscrowError::InvalidFeeBps);
        }
    }

    fn assert_valid_amount(env: &Env, amount: i128) {
        if amount < MIN_LOCK_AMOUNT {
            panic_with_error!(env, HazinaEscrowError::InvalidAmount);
        }
    }

    fn assert_valid_dataset_id(env: &Env, dataset_id: &String) {
        if dataset_id.is_empty() {
            panic_with_error!(env, HazinaEscrowError::EmptyDatasetId);
        }
    }

    fn assert_valid_token(env: &Env, token: &Address) {
        let _ = token::Client::new(env, token).decimals();
    }

    fn assert_valid_parties(env: &Env, buyer: &Address, seller: &Address) {
        if buyer == seller || seller == &env.current_contract_address() {
            panic_with_error!(env, HazinaEscrowError::InvalidAmount);
        }
    }

    fn assert_not_paused(env: &Env) {
        if env
            .storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
        {
            panic_with_error!(env, HazinaEscrowError::Paused);
        }
    }

    fn assert_paused(env: &Env) {
        if !env
            .storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
        {
            panic_with_error!(env, HazinaEscrowError::NotPaused);
        }
    }

    fn resolve_fee_bps(env: &Env, dataset_id: &String) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::DatasetFee(dataset_id.clone()))
            .unwrap_or_else(|| Self::get_default_fee(env.clone()))
    }

    fn require_operational_address(env: &Env, address: &Address) {
        let policy = Self::get_address_policy(env.clone(), address.clone());
        if policy.blacklisted {
            panic_with_error!(env, HazinaEscrowError::AddressBlacklisted);
        }
        if policy.whitelist_enforced && !policy.whitelisted {
            panic_with_error!(env, HazinaEscrowError::AddressNotWhitelisted);
        }
    }

    fn release_one(env: &Env, admin: &Address, escrow_id: u64) {
        let mut record = Self::read_escrow(env, escrow_id);
        if record.released {
            panic_with_error!(env, HazinaEscrowError::AlreadyReleased);
        }
        if record.refunded {
            panic_with_error!(env, HazinaEscrowError::AlreadyRefunded);
        }

        if record.disputed {
            panic_with_error!(env, HazinaEscrowError::DisputedEscrow);
        }

        if !record.buyer_confirmed {
            panic_with_error!(env, HazinaEscrowError::BuyerNotConfirmed);
        }

        let calculated_cut =
            record.amount * record.platform_fee_bps as i128 / MAX_BASIS_POINTS as i128;
        let platform_cut =
            if calculated_cut == 0 && record.amount > 0 && record.platform_fee_bps > 0 {
                1
            } else {
                calculated_cut
            };
        let seller_cut = record.amount - platform_cut;

        let token_client = token::Client::new(env, &record.token);
        token_client.transfer(&env.current_contract_address(), &record.seller, &seller_cut);

        let treasury: Address = env
            .storage()
            .instance()
            .get(&DataKey::Treasury)
            .unwrap_or(admin.clone());
        token_client.transfer(&env.current_contract_address(), &treasury, &platform_cut);

        record.released = true;
        env.storage()
            .persistent()
            .set(&EscrowKey::Record(escrow_id), &record);

        env.events().publish(
            (symbol_short!("released"),),
            (escrow_id, record.seller, seller_cut, platform_cut),
        );
    }

    fn read_escrow(env: &Env, escrow_id: u64) -> EscrowRecord {
        env.storage()
            .persistent()
            .get(&EscrowKey::Record(escrow_id))
            .unwrap_or_else(|| panic_with_error!(env, HazinaEscrowError::EscrowNotFound))
    }

    fn check_amount_circuit_breaker(env: &Env, amount: i128) {
        let max: i128 = env
            .storage()
            .instance()
            .get(&DataKey::MaxEscrowAmount)
            .unwrap_or(DEFAULT_MAX_ESCROW_AMOUNT);
        if amount > max {
            env.events()
                .publish((symbol_short!("cb_amt"),), (amount, max));
            panic_with_error!(env, HazinaEscrowError::AmountExceedsCircuitBreaker);
        }
    }

    fn check_rate_circuit_breaker_n(env: &Env, n: u32) {
        let max: u32 = env
            .storage()
            .instance()
            .get(&DataKey::MaxEscrowsPerLedger)
            .unwrap_or(DEFAULT_MAX_ESCROWS_PER_LEDGER);

        let current_ledger = env.ledger().sequence();
        let last_ledger: u32 = env
            .storage()
            .instance()
            .get(&DataKey::LastEscrowLedger)
            .unwrap_or(0);

        let current_count: u32 = if current_ledger != last_ledger {
            0
        } else {
            env.storage()
                .instance()
                .get(&DataKey::EscrowsThisLedger)
                .unwrap_or(0)
        };

        let new_count = current_count + n;
        if new_count > max {
            env.events().publish(
                (symbol_short!("cb_rate"),),
                (new_count, max, current_ledger),
            );
            panic_with_error!(env, HazinaEscrowError::RateLimitExceeded);
        }

        env.storage()
            .instance()
            .set(&DataKey::EscrowsThisLedger, &new_count);
        env.storage()
            .instance()
            .set(&DataKey::LastEscrowLedger, &current_ledger);
    }
}

// ─── Unit tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger as _},
        token::{Client as TokenClient, StellarAssetClient},
        Address, Env, String, Vec,
    };

    const INITIAL_BUYER_BALANCE: i128 = 10_000_000_000;

    pub fn setup() -> (
        Env,
        HazinaEscrowClient<'static>,
        Address,
        Address,
        Address,
        Address,
    ) {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(1_000);
        // Raise the test ledger's TTL bounds so a `fuzz_tests` timelock flow,
        // which advances the ledger by `DEFAULT_TIMELOCK_DELAY_LEDGERS`
        // (25_920), does not archive the contract instance (default persistent
        // TTL is only 4_096 ledgers). Without this the very next call after the
        // jump panics with `Storage, InternalError`.
        const TEST_ENTRY_TTL: u32 = 1_000_000;
        env.ledger().set_min_persistent_entry_ttl(TEST_ENTRY_TTL);
        env.ledger().set_max_entry_ttl(TEST_ENTRY_TTL);

        let admin = Address::generate(&env);
        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);

        let token_id = env.register_stellar_asset_contract_v2(admin.clone());
        let usdc = token_id.address();
        StellarAssetClient::new(&env, &usdc).mint(&buyer, &INITIAL_BUYER_BALANCE);

        let contract_id = env.register(HazinaEscrow, ());
        let client = HazinaEscrowClient::new(&env, &contract_id);
        client.initialize(&admin, &500);

        (env, client, admin, buyer, seller, usdc)
    }

    pub fn dataset_id(env: &Env, value: &str) -> String {
        String::from_str(env, value)
    }

    // ── Initialization ────────────────────────────────────────────────────────

    #[test]
    fn test_raise_and_resolve_dispute_buyer() {
        let (env, client, admin, buyer, seller, usdc) = setup();
        let escrow_id = client.lock(
            &buyer,
            &seller,
            &usdc,
            &1_000_000,
            &dataset_id(&env, "ds-dispute-buyer"),
            &3600,
        );
        let evidence = soroban_sdk::BytesN::from_array(&env, &[7; 32]);
        client.raise_dispute(&buyer, &escrow_id, &evidence);
        let disputed = client.get_escrow(&escrow_id);
        assert!(disputed.disputed);
        client.resolve_dispute(&admin, &escrow_id, &true);
        let resolved = client.get_escrow(&escrow_id);
        assert!(resolved.refunded);
        assert!(!resolved.disputed);
    }

    #[test]
    fn test_raise_and_resolve_dispute_seller() {
        let (env, client, admin, buyer, seller, usdc) = setup();
        let escrow_id = client.lock(
            &buyer,
            &seller,
            &usdc,
            &1_000_000,
            &dataset_id(&env, "ds-dispute-seller"),
            &3600,
        );
        let evidence = soroban_sdk::BytesN::from_array(&env, &[8; 32]);
        client.raise_dispute(&buyer, &escrow_id, &evidence);
        client.resolve_dispute(&admin, &escrow_id, &false);
        let resolved = client.get_escrow(&escrow_id);
        assert!(resolved.released);
        assert!(!resolved.disputed);
    }

    #[test]
    #[should_panic]
    fn test_release_fails_for_disputed_escrow() {
        let (env, client, admin, buyer, seller, usdc) = setup();
        let escrow_id = client.lock(
            &buyer,
            &seller,
            &usdc,
            &1_000_000,
            &dataset_id(&env, "ds-dispute-release"),
            &3600,
        );
        let evidence = soroban_sdk::BytesN::from_array(&env, &[9; 32]);
        client.raise_dispute(&buyer, &escrow_id, &evidence);
        client.release(&admin, &escrow_id);
    }

    #[test]
    #[should_panic]
    fn test_buyer_cannot_raise_dispute_after_deadline() {
        let (env, client, _admin, buyer, seller, usdc) = setup();
        let escrow_id = client.lock(
            &buyer,
            &seller,
            &usdc,
            &1_000_000,
            &dataset_id(&env, "ds-dispute-expired"),
            &3600,
        );
        let record = client.get_escrow(&escrow_id);
        env.ledger()
            .set_sequence_number(record.dispute_deadline.unwrap() as u32 + 1);
        let evidence = soroban_sdk::BytesN::from_array(&env, &[10; 32]);
        client.raise_dispute(&buyer, &escrow_id, &evidence);
    }

    #[test]
    fn test_delegated_arbitrator_resolves_seller_and_admin_receives_fee() {
        let (env, client, admin, buyer, seller, usdc) = setup();
        let arbitrator = Address::generate(&env);
        let token_client = TokenClient::new(&env, &usdc);
        let amount: i128 = 1_000_000;

        client.set_arbitrator(&admin, &arbitrator);
        let escrow_id = client.lock(
            &buyer,
            &seller,
            &usdc,
            &amount,
            &dataset_id(&env, "ds-delegated-arb"),
            &3600,
        );
        let evidence = soroban_sdk::BytesN::from_array(&env, &[11; 32]);
        client.raise_dispute(&buyer, &escrow_id, &evidence);
        client.resolve_dispute(&arbitrator, &escrow_id, &false);

        let platform_fee = amount * 500i128 / 10_000i128;
        assert_eq!(token_client.balance(&admin), platform_fee);
        assert_eq!(token_client.balance(&arbitrator), 0);
        assert_eq!(token_client.balance(&seller), amount - platform_fee);
    }

    #[test]
    fn test_initialize_sets_default_config() {
        let (env, client, _admin, buyer, seller, usdc) = setup();
        assert_eq!(client.get_fee(), 500);

        let policy = client.get_address_policy(&buyer);
        assert!(!policy.whitelist_enforced);
        assert!(policy.can_transact);

        let escrow_id = client.lock(
            &buyer,
            &seller,
            &usdc,
            &1_000_000,
            &dataset_id(&env, "ds-init"),
            &3600,
        );
        let record = client.get_escrow(&escrow_id);
        assert_eq!(record.platform_fee_bps, 500);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #1)")]
    fn test_initialize_fails_when_called_twice() {
        let (_env, client, admin, _buyer, _seller, _usdc) = setup();
        client.initialize(&admin, &500);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #1)")]
    fn test_initialize_with_different_params_still_panics() {
        let (env, client, _admin, _buyer, _seller, _usdc) = setup();
        let attacker = Address::generate(&env);
        client.initialize(&attacker, &10_000);
    }

    // ── Fee management ────────────────────────────────────────────────────────

    #[test]
    fn test_set_default_fee_updates_contract_fee() {
        let (_env, client, admin, _buyer, _seller, _usdc) = setup();
        client.set_default_fee(&admin, &750);
        assert_eq!(client.get_default_fee(), 750);
        assert_eq!(client.get_fee(), 750);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #4)")]
    fn test_set_default_fee_rejects_fee_above_cap() {
        let (_env, client, admin, _buyer, _seller, _usdc) = setup();
        client.set_default_fee(&admin, &(MAX_FEE_BPS + 1));
    }

    #[test]
    fn test_set_and_clear_dataset_fee() {
        let (env, client, admin, _buyer, _seller, _usdc) = setup();
        let ds = dataset_id(&env, "ds-custom-fee");

        client.set_dataset_fee(&admin, &ds, &900);
        let cfg = client.get_dataset_fee_config(&ds);
        assert!(cfg.has_custom_fee);
        assert_eq!(cfg.dataset_fee_bps, 900);
        assert_eq!(cfg.effective_fee_bps, 900);

        client.clear_dataset_fee(&admin, &ds);
        let cleared = client.get_dataset_fee_config(&ds);
        assert!(!cleared.has_custom_fee);
        assert_eq!(cleared.effective_fee_bps, 500);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #11)")]
    fn test_set_dataset_fee_requires_non_empty_dataset_id() {
        let (env, client, admin, _buyer, _seller, _usdc) = setup();
        client.set_dataset_fee(&admin, &dataset_id(&env, ""), &900);
    }

    #[test]
    fn test_set_fee() {
        let (_env, client, admin, _buyer, _seller, _usdc) = setup();
        client.set_fee(&admin, &300);
        assert_eq!(client.get_fee(), 300);
    }

    #[test]
    fn test_set_fee_max_boundary() {
        let (_env, client, admin, _buyer, _seller, _usdc) = setup();
        client.set_fee(&admin, &MAX_FEE_BPS);
        assert_eq!(client.get_fee(), MAX_FEE_BPS);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #4)")]
    fn test_set_fee_rejects_above_cap() {
        let (_env, client, admin, _buyer, _seller, _usdc) = setup();
        client.set_fee(&admin, &(MAX_FEE_BPS + 1));
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #3)")]
    fn test_set_fee_requires_admin() {
        let (env, client, _admin, _buyer, _seller, _usdc) = setup();
        let impostor = Address::generate(&env);
        client.set_fee(&impostor, &300);
    }

    #[test]
    fn test_update_fee_accepts_max_boundary() {
        let (_env, client, admin, _buyer, _seller, _usdc) = setup();
        client.update_fee(&admin, &MAX_FEE_BPS);
        assert_eq!(client.get_fee(), MAX_FEE_BPS);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #4)")]
    fn test_update_fee_rejects_above_cap() {
        let (_env, client, admin, _buyer, _seller, _usdc) = setup();
        client.update_fee(&admin, &(MAX_FEE_BPS + 1));
    }

    // ── Address policy ────────────────────────────────────────────────────────

    #[test]
    fn test_set_address_policies_and_read_them_back() {
        let (_env, client, admin, buyer, _seller, _usdc) = setup();

        client.set_whitelist_enforced(&admin, &true);
        client.set_address_whitelisted(&admin, &buyer, &true);
        client.set_address_blacklisted(&admin, &buyer, &false);

        let policy = client.get_address_policy(&buyer);
        assert!(policy.whitelist_enforced);
        assert!(policy.whitelisted);
        assert!(!policy.blacklisted);
        assert!(policy.can_transact);
    }

    // ── Lock / release / refund ───────────────────────────────────────────────

    #[test]
    fn test_lock_and_release_use_snapshot_fee() {
        let (env, client, admin, buyer, seller, usdc) = setup();
        let token_client = TokenClient::new(&env, &usdc);
        let ds = dataset_id(&env, "ds-snapshotted-fee");
        let amount: i128 = 2_000_000;

        client.set_dataset_fee(&admin, &ds, &900);
        let escrow_id = client.lock(&buyer, &seller, &usdc, &amount, &ds, &3600);
        client.confirm_delivery(&escrow_id, &buyer);
        // Change fee after lock — the existing escrow must still use 900 bps.
        client.set_dataset_fee(&admin, &ds, &100);
        client.release(&admin, &escrow_id);

        let record = client.get_escrow(&escrow_id);
        assert_eq!(record.platform_fee_bps, 900);
        assert!(record.released);

        let admin_expected = amount * 900 / 10_000;
        let seller_expected = amount - admin_expected;
        assert_eq!(token_client.balance(&admin), admin_expected);
        assert_eq!(token_client.balance(&seller), seller_expected);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #5)")]
    fn test_lock_rejects_invalid_amount() {
        let (env, client, _admin, buyer, seller, usdc) = setup();
        client.lock(
            &buyer,
            &seller,
            &usdc,
            &0,
            &dataset_id(&env, "ds-invalid"),
            &3600,
        );
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #11)")]
    fn test_lock_rejects_empty_dataset_id() {
        let (env, client, _admin, buyer, seller, usdc) = setup();
        client.lock(
            &buyer,
            &seller,
            &usdc,
            &1_000_000,
            &dataset_id(&env, ""),
            &3600,
        );
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #5)")]
    fn test_lock_rejects_same_buyer_and_seller() {
        let (env, client, _admin, buyer, _seller, usdc) = setup();
        client.lock(
            &buyer,
            &buyer,
            &usdc,
            &1_000_000,
            &dataset_id(&env, "ds-same-party"),
            &3600,
        );
    }

    #[test]
    #[should_panic]
    fn test_lock_rejects_invalid_token_contract() {
        let (env, client, _admin, buyer, seller, _usdc) = setup();
        let invalid_token = Address::generate(&env);
        client.lock(
            &buyer,
            &seller,
            &invalid_token,
            &1_000_000,
            &dataset_id(&env, "ds-bad-token"),
            &3600,
        );
    }

    #[test]
    fn test_release_fails_without_buyer_confirmation() {
        let (env, client, admin, buyer, seller, usdc) = setup();
        let escrow_id = client.lock(
            &buyer,
            &seller,
            &usdc,
            &2_000_000,
            &dataset_id(&env, "ds-no-confirm"),
            &3600,
        );
        let result = client.try_release(&admin, &escrow_id);
        assert!(result.is_err());
    }

    #[test]
    fn release_succeeds_after_buyer_confirmation() {
        let (env, client, admin, buyer, seller, usdc) = setup();
        let token_client = TokenClient::new(&env, &usdc);
        let amount: i128 = 2_000_000;
        let escrow_id = client.lock(
            &buyer,
            &seller,
            &usdc,
            &amount,
            &dataset_id(&env, "ds-confirm"),
            &3600,
        );
        client.confirm_delivery(&escrow_id, &buyer);
        client.release(&admin, &escrow_id);

        let fee = amount * 500 / 10_000;
        assert_eq!(token_client.balance(&seller), amount - fee);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #16)")]
    fn confirm_delivery_rejects_non_buyer() {
        let (env, client, _admin, buyer, seller, usdc) = setup();
        let escrow_id = client.lock(
            &buyer,
            &seller,
            &usdc,
            &2_000_000,
            &dataset_id(&env, "ds-wrong-buyer"),
            &3600,
        );
        client.confirm_delivery(&escrow_id, &seller);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #20)")]
    fn claim_expired_fails_before_deadline() {
        let (env, client, _admin, buyer, seller, usdc) = setup();
        let escrow_id = client.lock(
            &buyer,
            &seller,
            &usdc,
            &5_000_000,
            &dataset_id(&env, "ds-not-expired"),
            &3600,
        );
        client.claim_expired(&escrow_id, &seller);
    }

    #[test]
    fn seller_can_claim_after_deadline() {
        let (env, client, _admin, buyer, seller, usdc) = setup();
        let token_client = TokenClient::new(&env, &usdc);
        let amount: i128 = 2_000_000;

        let escrow_id = client.lock(
            &buyer,
            &seller,
            &usdc,
            &amount,
            &dataset_id(&env, "ds-expired-claim"),
            &3600,
        );
        env.ledger().set_timestamp(env.ledger().timestamp() + 4_000);
        client.claim_expired(&escrow_id, &seller);

        let record = client.get_escrow(&escrow_id);
        assert!(record.released);
        let fee = amount * 500 / 10_000;
        assert_eq!(token_client.balance(&seller), amount - fee);
    }

    #[test]
    fn test_refund_marks_record_and_restores_buyer_balance() {
        let (env, client, admin, buyer, seller, usdc) = setup();
        let token_client = TokenClient::new(&env, &usdc);
        let amount: i128 = 5_000_000;

        let escrow_id = client.lock(
            &buyer,
            &seller,
            &usdc,
            &amount,
            &dataset_id(&env, "ds-refund"),
            &3600,
        );
        client.refund(&admin, &escrow_id);

        let record = client.get_escrow(&escrow_id);
        assert!(record.refunded);
        assert_eq!(token_client.balance(&buyer), INITIAL_BUYER_BALANCE);
    }

    #[test]
    #[should_panic]
    fn test_release_cannot_be_called_twice() {
        let (env, client, admin, buyer, seller, usdc) = setup();
        let escrow_id = client.lock(
            &buyer,
            &seller,
            &usdc,
            &1_000_000,
            &dataset_id(&env, "ds-release-twice"),
            &3600,
        );
        client.confirm_delivery(&escrow_id, &buyer);
        client.release(&admin, &escrow_id);
        client.release(&admin, &escrow_id);
    }

    #[test]
    #[should_panic]
    fn test_refund_cannot_be_called_after_release() {
        let (env, client, admin, buyer, seller, usdc) = setup();
        let escrow_id = client.lock(
            &buyer,
            &seller,
            &usdc,
            &1_000_000,
            &dataset_id(&env, "ds-refund-after-release"),
            &3600,
        );
        client.confirm_delivery(&escrow_id, &buyer);
        client.release(&admin, &escrow_id);
        client.refund(&admin, &escrow_id);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #3)")]
    fn test_release_requires_admin() {
        let (env, client, _admin, buyer, seller, usdc) = setup();
        let outsider = Address::generate(&env);
        let escrow_id = client.lock(
            &buyer,
            &seller,
            &usdc,
            &1_000_000,
            &dataset_id(&env, "ds-admin-check"),
            &3600,
        );
        client.confirm_delivery(&escrow_id, &buyer);
        client.release(&outsider, &escrow_id);
    }

    #[test]
    #[should_panic]
    fn test_get_escrow_fails_for_unknown_id() {
        let (_env, client, _admin, _buyer, _seller, _usdc) = setup();
        client.get_escrow(&99);
    }

    #[test]
    fn formal_release_conserves_locked_value() {
        let (env, client, admin, buyer, seller, usdc) = setup();
        let token_client = TokenClient::new(&env, &usdc);
        let amount: i128 = 3_500_000;

        let buyer_before = token_client.balance(&buyer);
        let escrow_id = client.lock(
            &buyer,
            &seller,
            &usdc,
            &amount,
            &dataset_id(&env, "ds-formal-conservation"),
            &3600,
        );
        client.confirm_delivery(&escrow_id, &buyer);
        client.release(&admin, &escrow_id);

        let seller_balance = token_client.balance(&seller);
        let admin_balance = token_client.balance(&admin);
        assert_eq!(buyer_before - token_client.balance(&buyer), amount);
        assert_eq!(seller_balance + admin_balance, amount);
    }

    #[test]
    fn formal_refund_returns_all_locked_value_to_buyer() {
        let (env, client, admin, buyer, seller, usdc) = setup();
        let token_client = TokenClient::new(&env, &usdc);
        let amount: i128 = 4_200_000;
        let buyer_before = token_client.balance(&buyer);

        let escrow_id = client.lock(
            &buyer,
            &seller,
            &usdc,
            &amount,
            &dataset_id(&env, "ds-formal-refund"),
            &3600,
        );
        client.refund(&admin, &escrow_id);

        assert_eq!(token_client.balance(&buyer), buyer_before);
        assert_eq!(token_client.balance(&seller), 0);
        assert_eq!(token_client.balance(&admin), 0);
    }

    #[test]
    fn test_set_fee_does_not_affect_existing_escrows() {
        let (env, client, admin, buyer, seller, usdc) = setup();
        let escrow_id = client.lock(
            &buyer,
            &seller,
            &usdc,
            &1_000_000,
            &dataset_id(&env, "ds-fee-snapshot"),
            &3600,
        );
        client.set_fee(&admin, &MAX_FEE_BPS);
        let record = client.get_escrow(&escrow_id);
        assert_eq!(record.platform_fee_bps, 500);
    }

    // ── Multi-lock / multi-release ────────────────────────────────────────────
    #[test]
    fn test_fee_floor() {
        let (env, client, admin, buyer, seller, usdc) = setup();
        let token_client = TokenClient::new(&env, &usdc);

        // Test 1: Fee = 0 bps
        client.set_default_fee(&admin, &0);

        let amount1: i128 = 1_000_000;
        let escrow_id1 = client.lock(
            &buyer,
            &seller,
            &usdc,
            &amount1,
            &dataset_id(&env, "ds-zero-fee"),
            &3600,
        );

        // Verify escrow state before confirmation
        let record_before = client.get_escrow(&escrow_id1);
        assert!(!record_before.buyer_confirmed);
        assert!(!record_before.released);

        // Confirm and release
        client.confirm_delivery(&escrow_id1, &buyer);

        // Verify escrow state after confirmation
        let record_after = client.get_escrow(&escrow_id1);
        assert!(record_after.buyer_confirmed);
        assert!(!record_after.released);

        client.release(&admin, &escrow_id1);

        // With 0 bps, all amount should go to seller
        assert_eq!(token_client.balance(&seller), amount1);
        assert_eq!(token_client.balance(&admin), 0);

        // Test 2: Fee = 1 bps
        client.set_default_fee(&admin, &1);

        let amount2: i128 = MIN_LOCK_AMOUNT;
        let escrow_id2 = client.lock(
            &buyer,
            &seller,
            &usdc,
            &amount2,
            &dataset_id(&env, "ds-min-fee"),
            &3600,
        );

        // Verify the fee was snapshotted correctly
        let record = client.get_escrow(&escrow_id2);
        assert_eq!(record.platform_fee_bps, 1);
        assert!(!record.buyer_confirmed);

        // Confirm and release
        client.confirm_delivery(&escrow_id2, &buyer);

        // Verify confirmation worked
        let record_confirmed = client.get_escrow(&escrow_id2);
        assert!(record_confirmed.buyer_confirmed);

        client.release(&admin, &escrow_id2);

        // With 1 bps on MIN_LOCK_AMOUNT, fee = 1 token
        let expected_fee = 1;
        let expected_seller_balance = amount1 + (amount2 - expected_fee);
        let expected_admin_balance = expected_fee;

        assert_eq!(token_client.balance(&seller), expected_seller_balance);
        assert_eq!(token_client.balance(&admin), expected_admin_balance);
    }

    #[test]
    fn test_lock_multi_and_release_multi() {
        let (env, client, admin, buyer, _seller, usdc) = setup();
        let token_client = TokenClient::new(&env, &usdc);

        let seller_1 = Address::generate(&env);
        let seller_2 = Address::generate(&env);
        let seller_3 = Address::generate(&env);
        let seller_4 = Address::generate(&env);
        let amounts: [i128; 4] = [1_000_000, 2_000_000, 3_000_000, 4_000_000];
        let total: i128 = 10_000_000;

        let mut shares = Vec::new(&env);
        shares.push_back(SellerShare {
            seller: seller_1.clone(),
            amount: amounts[0],
        });
        shares.push_back(SellerShare {
            seller: seller_2.clone(),
            amount: amounts[1],
        });
        shares.push_back(SellerShare {
            seller: seller_3.clone(),
            amount: amounts[2],
        });
        shares.push_back(SellerShare {
            seller: seller_4.clone(),
            amount: amounts[3],
        });

        let mut ds_ids = Vec::new(&env);
        ds_ids.push_back(String::from_str(&env, "ds-001"));
        ds_ids.push_back(String::from_str(&env, "ds-002"));
        ds_ids.push_back(String::from_str(&env, "ds-003"));
        ds_ids.push_back(String::from_str(&env, "ds-004"));

        let first_id = client.lock_multi(&buyer, &usdc, &shares, &ds_ids);
        assert_eq!(first_id, 0);
        assert_eq!(token_client.balance(&buyer), INITIAL_BUYER_BALANCE - total);

        // Verify all escrows were created and not confirmed
        for i in 0..4 {
            let record = client.get_escrow(&(first_id + i));
            assert_eq!(record.escrow_id, first_id + i);
            assert!(!record.buyer_confirmed);
            assert!(!record.released);
        }

        // Confirm delivery for ALL escrows
        for i in 0..4 {
            client.confirm_delivery(&(first_id + i), &buyer);
        }

        // Verify all escrows are now confirmed
        for i in 0..4 {
            let record = client.get_escrow(&(first_id + i));
            assert!(record.buyer_confirmed);
            assert!(!record.released);
        }

        // Release all escrows
        let mut escrow_ids = Vec::new(&env);
        for i in 0..4 {
            escrow_ids.push_back(first_id + i);
        }
        client.release_multi(&admin, &escrow_ids);

        // Verify all escrows are released
        for i in 0..4 {
            let record = client.get_escrow(&(first_id + i));
            assert!(record.released);
        }

        let fee_bps: i128 = 500;
        // Calculate fee per escrow (with floor of 1 token when fee > 0)
        let fee_floor = 1i128;

        let s1_fee = if amounts[0] * fee_bps / 10_000 == 0 && fee_bps > 0 {
            fee_floor.min(amounts[0])
        } else {
            amounts[0] * fee_bps / 10_000
        };
        let s2_fee = if amounts[1] * fee_bps / 10_000 == 0 && fee_bps > 0 {
            fee_floor.min(amounts[1])
        } else {
            amounts[1] * fee_bps / 10_000
        };
        let s3_fee = if amounts[2] * fee_bps / 10_000 == 0 && fee_bps > 0 {
            fee_floor.min(amounts[2])
        } else {
            amounts[2] * fee_bps / 10_000
        };
        let s4_fee = if amounts[3] * fee_bps / 10_000 == 0 && fee_bps > 0 {
            fee_floor.min(amounts[3])
        } else {
            amounts[3] * fee_bps / 10_000
        };

        let s1_expected = amounts[0] - s1_fee;
        let s2_expected = amounts[1] - s2_fee;
        let s3_expected = amounts[2] - s3_fee;
        let s4_expected = amounts[3] - s4_fee;
        let admin_expected = total - s1_expected - s2_expected - s3_expected - s4_expected;

        assert_eq!(token_client.balance(&seller_1), s1_expected);
        assert_eq!(token_client.balance(&seller_2), s2_expected);
        assert_eq!(token_client.balance(&seller_3), s3_expected);
        assert_eq!(token_client.balance(&seller_4), s4_expected);
        assert_eq!(token_client.balance(&admin), admin_expected);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #8)")]
    fn test_lock_multi_empty_shares() {
        let (env, client, _admin, buyer, _seller, usdc) = setup();
        let shares: Vec<SellerShare> = Vec::new(&env);
        let dataset_ids: Vec<String> = Vec::new(&env);
        let _ = client.lock_multi(&buyer, &usdc, &shares, &dataset_ids);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #8)")]
    fn test_lock_multi_mismatched_lengths() {
        let (env, client, _admin, buyer, _seller, usdc) = setup();
        let mut shares = Vec::new(&env);
        shares.push_back(SellerShare {
            seller: Address::generate(&env),
            amount: 1_000_000,
        });
        let dataset_ids: Vec<String> = Vec::new(&env);
        let _ = client.lock_multi(&buyer, &usdc, &shares, &dataset_ids);
    }

    // ── Pause / unpause ───────────────────────────────────────────────────────

    #[test]
    fn test_pause_and_unpause_toggles_state() {
        let (_env, client, admin, _buyer, _seller, _usdc) = setup();
        assert!(!client.is_paused());
        client.pause(&admin);
        assert!(client.is_paused());
        client.unpause(&admin);
        assert!(!client.is_paused());
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #3)")]
    fn test_pause_requires_admin() {
        let (env, client, _admin, _buyer, _seller, _usdc) = setup();
        let outsider = Address::generate(&env);
        client.pause(&outsider);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #3)")]
    fn test_unpause_requires_admin() {
        let (env, client, admin, _buyer, _seller, _usdc) = setup();
        let outsider = Address::generate(&env);
        client.pause(&admin);
        client.unpause(&outsider);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #12)")]
    fn test_lock_fails_when_paused() {
        let (env, client, admin, buyer, seller, usdc) = setup();
        client.pause(&admin);
        client.lock(
            &buyer,
            &seller,
            &usdc,
            &1_000_000,
            &dataset_id(&env, "ds-paused-lock"),
            &3600,
        );
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #12)")]
    fn test_release_fails_when_paused() {
        let (env, client, admin, buyer, seller, usdc) = setup();
        let escrow_id = client.lock(
            &buyer,
            &seller,
            &usdc,
            &1_000_000,
            &dataset_id(&env, "ds-paused-release"),
            &3600,
        );
        client.confirm_delivery(&escrow_id, &buyer);
        client.pause(&admin);
        client.release(&admin, &escrow_id);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #12)")]
    fn test_refund_fails_when_paused() {
        let (env, client, admin, buyer, seller, usdc) = setup();
        let escrow_id = client.lock(
            &buyer,
            &seller,
            &usdc,
            &1_000_000,
            &dataset_id(&env, "ds-paused-refund"),
            &3600,
        );
        client.pause(&admin);
        client.refund(&admin, &escrow_id);
    }
}

// ─── Fuzz / property-based tests ────────────────────────────────────────────

#[cfg(all(test, feature = "fuzz-tests"))]
mod fuzz_tests {
    extern crate std;

    use super::*;
    use proptest::prelude::*;
    use soroban_sdk::{
        testutils::{Address as _, Events, Ledger},
        token::{Client as TokenClient, StellarAssetClient},
        Vec as SorobanVec,
    };

    // Use the parent module's functions
    use super::tests::{dataset_id, setup};

    #[test]
    #[should_panic(expected = "Error(Contract, #12)")]
    fn test_lock_multi_fails_when_paused() {
        let (env, client, admin, buyer, _seller, usdc) = setup();
        client.pause(&admin);

        let mut shares = SorobanVec::new(&env);
        shares.push_back(SellerShare {
            seller: Address::generate(&env),
            amount: 1_000_000,
        });
        let mut ds_ids = SorobanVec::new(&env);
        ds_ids.push_back(dataset_id(&env, "ds-multi-paused"));
        client.lock_multi(&buyer, &usdc, &shares, &ds_ids);
    }

    #[test]
    fn test_get_escrow_works_while_paused() {
        let (env, client, admin, buyer, seller, usdc) = setup();
        let escrow_id = client.lock(
            &buyer,
            &seller,
            &usdc,
            &1_000_000,
            &dataset_id(&env, "ds-read-while-paused"),
            &3600,
        );
        client.pause(&admin);
        let record = client.get_escrow(&escrow_id);
        assert_eq!(record.escrow_id, escrow_id);
        assert!(!record.released);
        assert!(!record.refunded);
    }

    #[test]
    fn test_pause_emits_event() {
        let (env, client, admin, _buyer, _seller, _usdc) = setup();
        assert_eq!(env.events().all().len(), 0);
        client.pause(&admin);
        assert_eq!(env.events().all().len(), 1);
    }

    #[test]
    fn test_unpause_emits_event() {
        let (env, client, admin, _buyer, _seller, _usdc) = setup();
        client.pause(&admin);
        let _ = env.events().all();
        client.unpause(&admin);
        assert_eq!(env.events().all().len(), 1);
    }

    // ── Circuit breakers ──────────────────────────────────────────────────────

    #[test]
    fn test_rate_limit_counter_resets_on_new_ledger() {
        let (env, client, admin, buyer, seller, usdc) = setup();
        let ids = ["ds-reset-0", "ds-reset-1", "ds-reset-2"];
        client.set_max_escrows_per_ledger(&admin, &(ids.len() as u32));

        for id in ids {
            client.lock(
                &buyer,
                &seller,
                &usdc,
                &MIN_LOCK_AMOUNT,
                &dataset_id(&env, id),
                &3600,
            );
        }

        let rejected = client.try_lock(
            &buyer,
            &seller,
            &usdc,
            &MIN_LOCK_AMOUNT,
            &dataset_id(&env, "ds-reset-over"),
            &3600,
        );
        assert!(rejected.is_err());
        assert_eq!(client.get_escrow_count(), ids.len() as u64);

        env.ledger()
            .set_sequence_number(env.ledger().sequence() + 1);

        let escrow_id = client.lock(
            &buyer,
            &seller,
            &usdc,
            &MIN_LOCK_AMOUNT,
            &dataset_id(&env, "ds-reset-next"),
            &3600,
        );
        assert_eq!(escrow_id, ids.len() as u64);
    }

    // ── Emergency withdraw ────────────────────────────────────────────────────

    #[test]
    fn test_emergency_withdraw_requires_pause() {
        let (env, client, admin, _buyer, _seller, usdc) = setup();
        let token_client = TokenClient::new(&env, &usdc);
        StellarAssetClient::new(&env, &usdc).mint(&client.address, &1_000_000);

        // Scheduling fails when not paused.
        let result = client.try_schedule_emergency_withdraw(&admin, &usdc, &admin, &100_000);
        assert!(result.is_err());

        client.pause(&admin);
        // The treasury is unset in this world, so the only valid recipient of
        // an emergency sweep is the admin (the `unwrap_or(admin)` fallback).
        client.schedule_emergency_withdraw(&admin, &usdc, &admin, &100_000);
        env.ledger()
            .set_sequence_number(env.ledger().sequence() + client.get_timelock_delay());
        client.execute_emergency_withdraw();
        assert_eq!(token_client.balance(&admin), 100_000);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #3)")]
    fn test_emergency_withdraw_rejects_non_admin() {
        let (env, client, admin, _buyer, seller, usdc) = setup();
        StellarAssetClient::new(&env, &usdc).mint(&client.address, &1_000_000);
        let impostor = Address::generate(&env);
        client.pause(&admin);
        client.schedule_emergency_withdraw(&impostor, &usdc, &seller, &10);
    }

    // ── Upgrade ───────────────────────────────────────────────────────────────

    #[test]
    #[should_panic(expected = "Error(Contract, #3)")]
    fn test_upgrade_requires_admin() {
        let (env, client, _admin, _buyer, _seller, _usdc) = setup();
        let outsider = Address::generate(&env);
        let dummy_hash = soroban_sdk::BytesN::from_array(&env, &[0u8; 32]);
        client.schedule_upgrade(&outsider, &dummy_hash);
    }

    // ── Escrow count ──────────────────────────────────────────────────────────

    #[test]
    fn test_get_escrow_count_returns_correct_number() {
        let (env, client, _admin, buyer, seller, usdc) = setup();
        assert_eq!(client.get_escrow_count(), 0);

        let id1 = client.lock(
            &buyer,
            &seller,
            &usdc,
            &MIN_LOCK_AMOUNT,
            &dataset_id(&env, "ds-c1"),
            &3600,
        );
        assert_eq!(id1, 0);
        assert_eq!(client.get_escrow_count(), 1);

        let id2 = client.lock(
            &buyer,
            &seller,
            &usdc,
            &MIN_LOCK_AMOUNT,
            &dataset_id(&env, "ds-c2"),
            &3600,
        );
        assert_eq!(id2, 1);
        assert_eq!(client.get_escrow_count(), 2);
    }

    // ─── Fuzz test for settlement exclusivity ──────────────────────────────

    proptest! {
        #[test]
        fn settlement_is_exclusive(calls in prop::collection::vec(
            prop_oneof![
                Just(0u8), // Release
                Just(1u8), // Refund
                Just(2u8), // ClaimExpired
            ],
            2..10,
        )) {
            let (env, client, admin, buyer, seller, usdc) = setup();
            let token_client = TokenClient::new(&env, &usdc);
            let amount: i128 = 2_000_000;
            let deadline = 3600u64;

            let escrow_id = client.lock(
                &buyer,
                &seller,
                &usdc,
                &amount,
                &dataset_id(&env, "ds-fuzz-exclusive"),
                &deadline,
            );

            client.confirm_delivery(&escrow_id, &buyer);
            env.ledger().set_timestamp(env.ledger().timestamp() + deadline + 1);

            let contract_before = token_client.balance(&client.address);
            let mut succeeded = 0usize;
            let mut first_success: Option<u8> = None;

            for call in calls {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    match call {
                        0 => client.release(&admin, &escrow_id),
                        1 => client.refund(&admin, &escrow_id),
                        2 => client.claim_expired(&escrow_id, &seller),
                        _ => unreachable!(),
                    }
                }));

                match result {
                    Ok(_) => {
                        succeeded += 1;
                        if first_success.is_none() {
                            first_success = Some(call);
                        }
                    }
                    Err(_) => {
                        if first_success.is_some() {
                            let record = client.get_escrow(&escrow_id);
                            prop_assert!(record.released || record.refunded);
                        }
                    }
                }
            }

            let contract_after = token_client.balance(&client.address);
            let balance_delta = contract_before - contract_after;

            prop_assert_eq!(succeeded, 1, "exactly one settlement call must succeed");

            let expected_delta = if first_success == Some(2) {
                let fee = if amount * 500 / 10_000 == 0 && amount > 0 && 500 > 0 {
                    1
                } else {
                    amount * 500 / 10_000
                };
                amount - fee
            } else if first_success == Some(0) {
                amount
            } else {
                amount
            };

            prop_assert!(
                balance_delta == expected_delta,
                "contract balance should change by exactly {} (was {})",
                expected_delta,
                balance_delta
            );

            let record = client.get_escrow(&escrow_id);
            prop_assert!(record.released != record.refunded, "exactly one of released/refunded must be set");
        }
    }
}
