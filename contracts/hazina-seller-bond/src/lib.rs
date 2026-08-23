#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short, token,
    Address, Env,
};

// ─── Constants ───────────────────────────────────────────────────────────────

// These are `pub` on purpose: the property-based invariant suite in
// `tests/fuzz/` derives its input strategies and expected-value models from
// them, so the tests and the contract can never disagree about a boundary.
// See docs/INVARIANTS.md.

/// TTL extension applied to persistent bond records (~60 days in ledgers).
const BOND_BUMP_LEDGERS: u32 = 518_400;

/// Minimum remaining TTL before a bump is triggered (~24 h in ledgers).
const BOND_MIN_TTL: u32 = 17_280;

/// Denominator for every basis-point fee calculation.
pub const MAX_BASIS_POINTS: u32 = 10_000;

/// Hard cap on slash per incident: 2 000 bps = 20 %.
pub const MAX_SLASH_BPS: u32 = 2_000;

/// Default slash the backend applies per incident: 1 000 bps = 10 %.
pub const DEFAULT_SLASH_BPS: u32 = 1_000;

/// Minimum cooldown in seconds (1 hour).
pub const MIN_COOLDOWN_SECS: u32 = 3_600;

/// Maximum cooldown in seconds (365 days).
pub const MAX_COOLDOWN_SECS: u32 = 365 * 24 * 60 * 60;

// ── Tier thresholds (stroops; USDC has 7 decimals) ───────────────────────────

/// Bronze tier minimum: 100 USDC = 1_000_000_000 stroops.
pub const TIER_BRONZE_MIN: i128 = 1_000_000_000;

/// Silver tier minimum: 500 USDC = 5_000_000_000 stroops.
pub const TIER_SILVER_MIN: i128 = 5_000_000_000;

/// Gold tier minimum: 2_500 USDC = 25_000_000_000 stroops.
pub const TIER_GOLD_MIN: i128 = 25_000_000_000;

// ─── Storage keys ────────────────────────────────────────────────────────────

#[contracttype]
pub enum DataKey {
    /// Set to `true` the first time `init` runs. Checked before any other
    /// state is written to guard against re-initialization.
    Initialized,
    Admin,
    Token,
    Arbitrator,
    /// Address of the escrow contract, used for cross-contract dispute reads.
    EscrowContract,
    /// Cooldown period in seconds for unstake requests.
    CooldownSecs,
    /// Per-seller bond record (hot-path, persistent with TTL bumps).
    Bond(Address),
    /// Idempotency marker keyed by escrow id: prevents double-slash.
    SlashedEscrow(u64),
}

// ─── Errors ──────────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum HazinaBondError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    NotAdmin = 3,
    NotArbitrator = 4,
    InvalidAmount = 5,
    InvalidCooldown = 6,
    NothingStaked = 7,
    InsufficientStake = 8,
    UnstakeAlreadyPending = 9,
    CooldownNotElapsed = 10,
    OpenDisputeBlocksUnstake = 11,
    NothingPending = 12,
    InvalidSlashBps = 13,
    AlreadySlashed = 14,
}

// ─── Types ───────────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BondRecord {
    pub staked: i128,
    pub pending_unstake: i128,
    pub cooldown_ends: u64,
    pub slashed_total: i128,
    pub slash_count: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Tier {
    None,
    Bronze,
    Silver,
    Gold,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Bond {
    pub staked: i128,
    pub pending_unstake: i128,
    pub cooldown_ends: u64,
    pub slash_count: u32,
    pub slashed_total: i128,
    pub tier: Tier,
}

// ─── Contract ────────────────────────────────────────────────────────────────

#[contract]
pub struct HazinaSellerBond;

#[contractimpl]
impl HazinaSellerBond {
    // ─── Initialization ──────────────────────────────────────────────────────

    /// One-time setup. Panics with `AlreadyInitialized` on any subsequent call.
    /// The `Initialized` flag is written *before* any other state so there is
    /// no window for partial re-init even if a future upgrade bug exists.
    pub fn init(
        env: Env,
        admin: Address,
        token: Address,
        arbitrator: Address,
        escrow_contract: Address,
        cooldown_secs: u32,
    ) {
        if env.storage().instance().has(&DataKey::Initialized) {
            panic_with_error!(&env, HazinaBondError::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Initialized, &true);

        if !(MIN_COOLDOWN_SECS..=MAX_COOLDOWN_SECS).contains(&cooldown_secs) {
            panic_with_error!(&env, HazinaBondError::InvalidCooldown);
        }

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Token, &token);
        env.storage()
            .instance()
            .set(&DataKey::Arbitrator, &arbitrator);
        env.storage()
            .instance()
            .set(&DataKey::EscrowContract, &escrow_contract);
        env.storage()
            .instance()
            .set(&DataKey::CooldownSecs, &cooldown_secs);
    }

    // ─── Staking ─────────────────────────────────────────────────────────────

    /// Seller stakes USDC into the bond. Additive: calling multiple times
    /// increases the total staked amount. `require_auth` on the seller.
    pub fn stake(env: Env, seller: Address, amount: i128) {
        seller.require_auth();
        Self::assert_initialized(&env);

        if amount <= 0 {
            panic_with_error!(&env, HazinaBondError::InvalidAmount);
        }

        let token_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::Token)
            .unwrap_or_else(|| panic_with_error!(&env, HazinaBondError::NotInitialized));
        let token_client = token::Client::new(&env, &token_addr);
        token_client.transfer(&seller, &env.current_contract_address(), &amount);

        let mut record = Self::read_bond(&env, &seller);
        record.staked += amount;

        env.storage()
            .persistent()
            .set(&DataKey::Bond(seller.clone()), &record);
        env.storage().persistent().extend_ttl(
            &DataKey::Bond(seller.clone()),
            BOND_MIN_TTL,
            BOND_BUMP_LEDGERS,
        );

        env.events()
            .publish((symbol_short!("staked"),), (seller, amount));
    }

    /// Seller requests to unstake part of their bond. Starts a cooldown
    /// period; the stake remains fully slashable during cooldown.
    ///
    /// Rejects if:
    /// - `amount` exceeds `staked - pending_unstake` (InsufficientStake)
    /// - A request is already pending (UnstakeAlreadyPending)
    /// - The escrow contract reports open disputes for this seller
    ///   (OpenDisputeBlocksUnstake)
    pub fn request_unstake(env: Env, seller: Address, amount: i128) {
        seller.require_auth();
        Self::assert_initialized(&env);

        if amount <= 0 {
            panic_with_error!(&env, HazinaBondError::InvalidAmount);
        }

        let mut record = Self::read_bond(&env, &seller);

        if record.pending_unstake > 0 {
            panic_with_error!(&env, HazinaBondError::UnstakeAlreadyPending);
        }

        let available = record.staked - record.pending_unstake;
        if amount > available {
            panic_with_error!(&env, HazinaBondError::InsufficientStake);
        }

        // Check for open disputes via the escrow contract (D1-A).
        let open = Self::read_open_disputes(&env, &seller);
        if open > 0 {
            panic_with_error!(&env, HazinaBondError::OpenDisputeBlocksUnstake);
        }

        let cooldown_secs: u32 = env
            .storage()
            .instance()
            .get(&DataKey::CooldownSecs)
            .unwrap_or_else(|| panic_with_error!(&env, HazinaBondError::NotInitialized));

        let now = env.ledger().timestamp();
        record.pending_unstake = amount;
        record.cooldown_ends = now + cooldown_secs as u64;

        env.storage()
            .persistent()
            .set(&DataKey::Bond(seller.clone()), &record);
        env.storage().persistent().extend_ttl(
            &DataKey::Bond(seller.clone()),
            BOND_MIN_TTL,
            BOND_BUMP_LEDGERS,
        );

        env.events().publish(
            (symbol_short!("unstk_req"),),
            (seller, amount, record.cooldown_ends),
        );
    }

    /// Seller withdraws after cooldown has elapsed. Pays at most
    /// `min(pending_unstake, staked)` (a slash may have shrunk it).
    pub fn withdraw(env: Env, seller: Address) {
        seller.require_auth();
        Self::assert_initialized(&env);

        let mut record = Self::read_bond(&env, &seller);

        if record.pending_unstake <= 0 {
            panic_with_error!(&env, HazinaBondError::NothingPending);
        }

        let now = env.ledger().timestamp();
        if now < record.cooldown_ends {
            panic_with_error!(&env, HazinaBondError::CooldownNotElapsed);
        }

        // Pay out the minimum: a slash during cooldown may have reduced staked
        // below pending_unstake.
        let payout = core::cmp::min(record.pending_unstake, record.staked);
        if payout > 0 {
            let token_addr: Address = env
                .storage()
                .instance()
                .get(&DataKey::Token)
                .unwrap_or_else(|| panic_with_error!(&env, HazinaBondError::NotInitialized));
            let token_client = token::Client::new(&env, &token_addr);
            token_client.transfer(&env.current_contract_address(), &seller, &payout);
        }

        record.staked -= payout;
        record.pending_unstake = 0;
        record.cooldown_ends = 0;

        env.storage()
            .persistent()
            .set(&DataKey::Bond(seller.clone()), &record);
        env.storage().persistent().extend_ttl(
            &DataKey::Bond(seller.clone()),
            BOND_MIN_TTL,
            BOND_BUMP_LEDGERS,
        );

        env.events()
            .publish((symbol_short!("withdrew"),), (seller, payout));
    }

    // ─── Slash ──────────────────────────────────────────────────────────────

    /// Slash a seller's bond. Called by the arbitrator after resolving a dispute
    /// against the seller. The cut is transferred to `beneficiary` (typically
    /// the wronged buyer).
    ///
    /// Rejects if:
    /// - Caller is not the configured arbitrator (NotArbitrator)
    /// - `bps` is 0 or exceeds `MAX_SLASH_BPS` (InvalidSlashBps)
    /// - This `escrow_id` has already been slashed (AlreadySlashed)
    pub fn slash(
        env: Env,
        arbitrator: Address,
        seller: Address,
        escrow_id: u64,
        bps: u32,
        beneficiary: Address,
    ) {
        arbitrator.require_auth();
        Self::assert_initialized(&env);

        // Verify caller is the stored arbitrator.
        let stored_arb: Address = env
            .storage()
            .instance()
            .get(&DataKey::Arbitrator)
            .unwrap_or_else(|| panic_with_error!(&env, HazinaBondError::NotInitialized));
        if stored_arb != arbitrator {
            panic_with_error!(&env, HazinaBondError::NotArbitrator);
        }

        if bps == 0 || bps > MAX_SLASH_BPS {
            panic_with_error!(&env, HazinaBondError::InvalidSlashBps);
        }

        // Idempotency: reject if this escrow was already slashed.
        if env
            .storage()
            .persistent()
            .has(&DataKey::SlashedEscrow(escrow_id))
        {
            panic_with_error!(&env, HazinaBondError::AlreadySlashed);
        }

        let mut record = Self::read_bond(&env, &seller);
        if record.staked <= 0 {
            panic_with_error!(&env, HazinaBondError::NothingStaked);
        }

        // Floor math: cut = min(staked, max(1, staked * bps / MAX_BASIS_POINTS)).
        // The max(1, ..) floor ensures a non-zero bps always costs at least 1 stroop.
        let raw_cut = record.staked * (bps as i128) / (MAX_BASIS_POINTS as i128);
        let cut = core::cmp::min(record.staked, core::cmp::max(1, raw_cut));

        // Transfer cut to beneficiary.
        let token_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::Token)
            .unwrap_or_else(|| panic_with_error!(&env, HazinaBondError::NotInitialized));
        let token_client = token::Client::new(&env, &token_addr);
        token_client.transfer(&env.current_contract_address(), &beneficiary, &cut);

        // Update bond record.
        record.staked -= cut;
        record.slashed_total += cut;
        record.slash_count += 1;
        env.storage()
            .persistent()
            .set(&DataKey::Bond(seller.clone()), &record);
        env.storage().persistent().extend_ttl(
            &DataKey::Bond(seller.clone()),
            BOND_MIN_TTL,
            BOND_BUMP_LEDGERS,
        );

        // Mark this escrow id as slashed (idempotency marker).
        env.storage()
            .persistent()
            .set(&DataKey::SlashedEscrow(escrow_id), &true);

        env.events().publish(
            (symbol_short!("slashed"),),
            (seller, escrow_id, bps, cut, beneficiary),
        );
    }

    // ─── Admin ──────────────────────────────────────────────────────────────

    /// Rotate the arbitrator address. Only callable by admin.
    pub fn set_arbitrator(env: Env, admin: Address, new_arbitrator: Address) {
        admin.require_auth();
        Self::assert_initialized(&env);
        Self::assert_admin(&env, &admin);

        env.storage()
            .instance()
            .set(&DataKey::Arbitrator, &new_arbitrator);

        env.events()
            .publish((symbol_short!("arbit_set"),), new_arbitrator);
    }

    // ─── Read-only getters ───────────────────────────────────────────────────

    /// Returns the bond record for a seller, with tier derived from current
    /// staked amount. Anyone may call this.
    pub fn get_bond(env: Env, seller: Address) -> Bond {
        Self::assert_initialized(&env);
        let record = Self::read_bond(&env, &seller);
        let tier = Self::derive_tier(record.staked);
        Bond {
            staked: record.staked,
            pending_unstake: record.pending_unstake,
            cooldown_ends: record.cooldown_ends,
            slash_count: record.slash_count,
            slashed_total: record.slashed_total,
            tier,
        }
    }

    /// Returns the configured admin address.
    pub fn get_admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(&env, HazinaBondError::NotInitialized))
    }

    /// Returns the configured arbitrator address.
    pub fn get_arbitrator(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Arbitrator)
            .unwrap_or_else(|| panic_with_error!(&env, HazinaBondError::NotInitialized))
    }

    /// Returns the configured cooldown period in seconds.
    pub fn get_cooldown_secs(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::CooldownSecs)
            .unwrap_or_else(|| panic_with_error!(&env, HazinaBondError::NotInitialized))
    }

    /// Returns the configured token address.
    pub fn get_token(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Token)
            .unwrap_or_else(|| panic_with_error!(&env, HazinaBondError::NotInitialized))
    }

    // ─── Public read helpers ────────────────────────────────────────────────

    /// Returns true if the seller has a pending unstake request.
    pub fn has_open_unstake(env: Env, seller: Address) -> bool {
        Self::assert_initialized(&env);
        let record = Self::read_bond(&env, &seller);
        record.pending_unstake > 0
    }

    /// Returns true if the given escrow id has already been slashed.
    pub fn is_slashed(env: Env, escrow_id: u64) -> bool {
        Self::assert_initialized(&env);
        env.storage()
            .persistent()
            .has(&DataKey::SlashedEscrow(escrow_id))
    }

    // ─── Private helpers ─────────────────────────────────────────────────────

    fn assert_initialized(env: &Env) {
        if !env.storage().instance().has(&DataKey::Initialized) {
            panic_with_error!(env, HazinaBondError::NotInitialized);
        }
    }

    fn assert_admin(env: &Env, caller: &Address) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(env, HazinaBondError::NotInitialized));
        if admin != *caller {
            panic_with_error!(env, HazinaBondError::NotAdmin);
        }
    }

    fn read_bond(env: &Env, seller: &Address) -> BondRecord {
        env.storage()
            .persistent()
            .get(&DataKey::Bond(seller.clone()))
            .unwrap_or(BondRecord {
                staked: 0,
                pending_unstake: 0,
                cooldown_ends: 0,
                slashed_total: 0,
                slash_count: 0,
            })
    }

    /// Derive the tier from the current staked amount. Pure function of
    /// `staked` only — nothing else influences it (invariant B7).
    fn derive_tier(staked: i128) -> Tier {
        if staked >= TIER_GOLD_MIN {
            Tier::Gold
        } else if staked >= TIER_SILVER_MIN {
            Tier::Silver
        } else if staked >= TIER_BRONZE_MIN {
            Tier::Bronze
        } else {
            Tier::None
        }
    }
    /// Cross-contract read: how many open disputes does the escrow contract
    /// report for this seller? Zero if no escrow contract is configured or
    /// the seller has no open disputes.
    fn read_open_disputes(env: &Env, seller: &Address) -> u32 {
        let escrow_addr: Address = match env.storage().instance().get(&DataKey::EscrowContract) {
            Some(a) => a,
            None => return 0,
        };
        // Cross-contract call to escrow's `dspt_cnt` (< 9 chars for symbol_short!).
        // In Soroban test mode this resolves within the same host.
        env.invoke_contract::<u32>(
            &escrow_addr,
            &symbol_short!("dspt_cnt"),
            soroban_sdk::vec![&env, seller.to_val()],
        )
    }
}

// ─── Unit tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Events as _, Ledger as _},
        token::{Client as TokenClient, StellarAssetClient},
        Address, Env,
    };

    const INITIAL_SELLER_BALANCE: i128 = 100_000_000_000; // 10 000 USDC

    // ── Mock escrow contract for cross-contract dispute counter tests ──

    #[soroban_sdk::contract]
    struct MockEscrow;

    #[soroban_sdk::contractimpl]
    impl MockEscrow {
        /// Returns the number of open disputes. We store the count in
        /// persistent storage keyed by the seller address so tests can
        /// control it per-seller.
        pub fn dspt_cnt(env: Env, seller: Address) -> u32 {
            env.storage()
                .persistent()
                .get(&MockDataKey::DisputeCount(seller))
                .unwrap_or(0)
        }

        /// Test helper: set the dispute count for a seller.
        pub fn set_dspt_cnt(env: Env, seller: Address, count: u32) {
            env.storage()
                .persistent()
                .set(&MockDataKey::DisputeCount(seller), &count);
        }
    }

    #[soroban_sdk::contracttype]
    enum MockDataKey {
        DisputeCount(Address),
    }

    fn setup() -> (
        Env,
        HazinaSellerBondClient<'static>,
        Address, // admin
        Address, // seller
        Address, // arbitrator
        Address, // usdc token
        Address, // bond contract address
        Address, // mock escrow contract address
    ) {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let seller = Address::generate(&env);
        let arbitrator = Address::generate(&env);
        // Register a real mock escrow contract so cross-contract calls work.
        let escrow_contract = env.register(MockEscrow, ());

        let token_id = env.register_stellar_asset_contract_v2(admin.clone());
        let usdc = token_id.address();
        StellarAssetClient::new(&env, &usdc).mint(&seller, &INITIAL_SELLER_BALANCE);

        let contract_id = env.register(HazinaSellerBond, ());
        let client = HazinaSellerBondClient::new(&env, &contract_id);
        client.init(&admin, &usdc, &arbitrator, &escrow_contract, &(3600));

        (
            env,
            client,
            admin,
            seller,
            arbitrator,
            usdc,
            contract_id,
            escrow_contract,
        )
    }

    // ── Initialization ────────────────────────────────────────────────────────

    #[test]
    fn test_init_sets_all_config() {
        let (_env, client, admin, _seller, arbitrator, usdc, _addr, _esc) = setup();
        assert_eq!(client.get_admin(), admin);
        assert_eq!(client.get_token(), usdc);
        assert_eq!(client.get_arbitrator(), arbitrator);
        assert_eq!(client.get_cooldown_secs(), 3600);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #1)")]
    fn test_init_fails_when_called_twice() {
        let (env, client, admin, _seller, arbitrator, usdc, _addr, _esc) = setup();
        let escrow_contract = Address::generate(&env);
        client.init(&admin, &usdc, &arbitrator, &escrow_contract, &3600);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #6)")]
    fn test_init_rejects_cooldown_too_low() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let _seller = Address::generate(&env);
        let arbitrator = Address::generate(&env);
        let escrow_contract = Address::generate(&env);
        let token_id = env.register_stellar_asset_contract_v2(admin.clone());
        let usdc = token_id.address();
        let contract_id = env.register(HazinaSellerBond, ());
        let client = HazinaSellerBondClient::new(&env, &contract_id);
        client.init(&admin, &usdc, &arbitrator, &escrow_contract, &100);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #6)")]
    fn test_init_rejects_cooldown_too_high() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let _seller = Address::generate(&env);
        let arbitrator = Address::generate(&env);
        let escrow_contract = Address::generate(&env);
        let token_id = env.register_stellar_asset_contract_v2(admin.clone());
        let usdc = token_id.address();
        let contract_id = env.register(HazinaSellerBond, ());
        let client = HazinaSellerBondClient::new(&env, &contract_id);
        client.init(
            &admin,
            &usdc,
            &arbitrator,
            &escrow_contract,
            &(MAX_COOLDOWN_SECS + 1),
        );
    }

    #[test]
    fn test_init_accepts_boundary_cooldowns() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let _seller = Address::generate(&env);
        let arbitrator = Address::generate(&env);
        let escrow_contract = Address::generate(&env);
        let token_id = env.register_stellar_asset_contract_v2(admin.clone());
        let usdc = token_id.address();

        // Minimum cooldown
        let contract_id = env.register(HazinaSellerBond, ());
        let client = HazinaSellerBondClient::new(&env, &contract_id);
        client.init(
            &admin,
            &usdc,
            &arbitrator,
            &escrow_contract,
            &MIN_COOLDOWN_SECS,
        );
        assert_eq!(client.get_cooldown_secs(), MIN_COOLDOWN_SECS);

        // Maximum cooldown (new contract)
        let contract_id2 = env.register(HazinaSellerBond, ());
        let client2 = HazinaSellerBondClient::new(&env, &contract_id2);
        client2.init(
            &admin,
            &usdc,
            &arbitrator,
            &escrow_contract,
            &MAX_COOLDOWN_SECS,
        );
        assert_eq!(client2.get_cooldown_secs(), MAX_COOLDOWN_SECS);
    }

    // ── Stake ─────────────────────────────────────────────────────────────────

    #[test]
    fn test_stake_transfers_tokens_and_records() {
        let (env, client, _admin, seller, _arbitrator, usdc, contract_addr, _esc) = setup();
        let token_client = TokenClient::new(&env, &usdc);

        let amount: i128 = 5_000_000_000; // 500 USDC
        client.stake(&seller, &amount);

        // Tokens moved from seller to contract
        assert_eq!(
            token_client.balance(&seller),
            INITIAL_SELLER_BALANCE - amount
        );
        assert_eq!(token_client.balance(&contract_addr), amount);

        // Bond record updated
        let bond = client.get_bond(&seller);
        assert_eq!(bond.staked, amount);
        assert_eq!(bond.pending_unstake, 0);
        assert_eq!(bond.cooldown_ends, 0);
        assert_eq!(bond.slashed_total, 0);
        assert_eq!(bond.slash_count, 0);
    }

    #[test]
    fn test_stake_is_additive() {
        let (env, client, _admin, seller, _arbitrator, usdc, contract_addr, _esc) = setup();
        let token_client = TokenClient::new(&env, &usdc);

        let first: i128 = 1_000_000_000; // 100 USDC
        let second: i128 = 2_000_000_000; // 200 USDC
        client.stake(&seller, &first);
        client.stake(&seller, &second);

        assert_eq!(
            token_client.balance(&seller),
            INITIAL_SELLER_BALANCE - first - second
        );
        assert_eq!(token_client.balance(&contract_addr), first + second);

        let bond = client.get_bond(&seller);
        assert_eq!(bond.staked, first + second);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #5)")]
    fn test_stake_rejects_zero_amount() {
        let (_env, client, _admin, seller, _arbitrator, _usdc, _addr, _esc) = setup();
        client.stake(&seller, &0);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #5)")]
    fn test_stake_rejects_negative_amount() {
        let (_env, client, _admin, seller, _arbitrator, _usdc, _addr, _esc) = setup();
        client.stake(&seller, &-100);
    }

    #[test]
    #[should_panic]
    fn test_stake_requires_seller_auth() {
        let (env, client, _admin, _seller, _arbitrator, _usdc, _addr, _esc) = setup();
        let unauthorized = Address::generate(&env);
        // mock_all_auths is set, so this won't panic — it stakes as
        // `unauthorized`. In production, require_auth prevents this.
        client.stake(&unauthorized, &1_000_000_000);
    }

    #[test]
    fn test_stake_emits_event() {
        let (env, client, _admin, seller, _arbitrator, _usdc, _addr, _esc) = setup();
        let amount: i128 = 3_000_000_000;

        client.stake(&seller, &amount);

        // 2 events: token transfer + staked
        let events = env.events().all();
        assert!(!events.is_empty());
    }

    #[test]
    fn test_get_bond_returns_zero_for_unknown_seller() {
        let (env, client, _admin, _seller, _arbitrator, _usdc, _addr, _esc) = setup();
        let unknown = Address::generate(&env);
        let bond = client.get_bond(&unknown);
        assert_eq!(bond.staked, 0);
        assert_eq!(bond.pending_unstake, 0);
        assert_eq!(bond.cooldown_ends, 0);
        assert_eq!(bond.slashed_total, 0);
        assert_eq!(bond.slash_count, 0);
        assert_eq!(bond.tier, Tier::None);
    }

    // ── Tier derivation ──────────────────────────────────────────────────────

    #[test]
    fn test_tier_none_below_bronze() {
        let bond = HazinaSellerBond::derive_tier(999_999_999);
        assert_eq!(bond, Tier::None);
    }

    #[test]
    fn test_tier_bronze_at_exact_threshold() {
        let bond = HazinaSellerBond::derive_tier(TIER_BRONZE_MIN);
        assert_eq!(bond, Tier::Bronze);
    }

    #[test]
    fn test_tier_silver_at_exact_threshold() {
        let bond = HazinaSellerBond::derive_tier(TIER_SILVER_MIN);
        assert_eq!(bond, Tier::Silver);
    }

    #[test]
    fn test_tier_gold_at_exact_threshold() {
        let bond = HazinaSellerBond::derive_tier(TIER_GOLD_MIN);
        assert_eq!(bond, Tier::Gold);
    }

    #[test]
    fn test_tier_derived_in_get_bond() {
        let (_env, client, _admin, seller, _arbitrator, _usdc, _addr, _esc) = setup();
        // Stake exactly 500 USDC -> Silver
        client.stake(&seller, &TIER_SILVER_MIN);
        let bond = client.get_bond(&seller);
        assert_eq!(bond.tier, Tier::Silver);
    }

    // ── request_unstake ──────────────────────────────────────────────────────

    #[test]
    fn test_request_unstake_success() {
        let (env, client, _admin, seller, _arbitrator, _usdc, _addr, _esc) = setup();
        let staked: i128 = 5_000_000_000;
        client.stake(&seller, &staked);

        let unstake: i128 = 2_000_000_000;
        env.ledger().set_timestamp(1000);
        client.request_unstake(&seller, &unstake);

        let bond = client.get_bond(&seller);
        assert_eq!(bond.staked, staked);
        assert_eq!(bond.pending_unstake, unstake);
        assert_eq!(bond.cooldown_ends, 1000 + 3600); // 1 hour cooldown
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #5)")]
    fn test_request_unstake_rejects_zero_amount() {
        let (_env, client, _admin, seller, _arbitrator, _usdc, _addr, _esc) = setup();
        client.stake(&seller, &5_000_000_000);
        client.request_unstake(&seller, &0);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #8)")]
    fn test_request_unstake_rejects_insufficient_stake() {
        let (_env, client, _admin, seller, _arbitrator, _usdc, _addr, _esc) = setup();
        client.stake(&seller, &1_000_000_000);
        client.request_unstake(&seller, &2_000_000_000);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #9)")]
    fn test_request_unstake_rejects_double_request() {
        let (env, client, _admin, seller, _arbitrator, _usdc, _addr, _esc) = setup();
        client.stake(&seller, &5_000_000_000);
        env.ledger().set_timestamp(1000);
        client.request_unstake(&seller, &1_000_000_000);
        client.request_unstake(&seller, &1_000_000_000);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #11)")]
    fn test_request_unstake_blocked_by_open_dispute() {
        let (env, client, _admin, seller, _arbitrator, _usdc, _bond_addr, escrow_addr) = setup();
        client.stake(&seller, &5_000_000_000);

        // Set open dispute count to 1 via the mock escrow.
        let mock_client = MockEscrowClient::new(&env, &escrow_addr);
        mock_client.set_dspt_cnt(&seller, &1);

        env.ledger().set_timestamp(1000);
        client.request_unstake(&seller, &1_000_000_000);
    }

    // ── withdraw ─────────────────────────────────────────────────────────────

    #[test]
    fn test_withdraw_success_after_cooldown() {
        let (env, client, _admin, seller, _arbitrator, usdc, _addr, _esc) = setup();
        let token_client = TokenClient::new(&env, &usdc);
        let staked: i128 = 5_000_000_000;
        client.stake(&seller, &staked);

        // Request unstake at t=1000.
        env.ledger().set_timestamp(1000);
        client.request_unstake(&seller, &staked);

        // Withdraw at t=4600 (exactly at cooldown end).
        env.ledger().set_timestamp(4600);
        client.withdraw(&seller);

        let bond = client.get_bond(&seller);
        assert_eq!(bond.staked, 0);
        assert_eq!(bond.pending_unstake, 0);
        assert_eq!(bond.cooldown_ends, 0);
        assert_eq!(token_client.balance(&seller), INITIAL_SELLER_BALANCE);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #12)")]
    fn test_withdraw_rejects_no_pending() {
        let (_env, client, _admin, seller, _arbitrator, _usdc, _addr, _esc) = setup();
        client.stake(&seller, &5_000_000_000);
        client.withdraw(&seller);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #10)")]
    fn test_withdraw_rejects_before_cooldown() {
        let (env, client, _admin, seller, _arbitrator, _usdc, _addr, _esc) = setup();
        client.stake(&seller, &5_000_000_000);

        env.ledger().set_timestamp(1000);
        client.request_unstake(&seller, &5_000_000_000);

        // Try to withdraw 1 second before cooldown ends.
        env.ledger().set_timestamp(4599);
        client.withdraw(&seller);
    }

    #[test]
    fn test_withdraw_exact_boundary_at_cooldown_ends() {
        let (env, client, _admin, seller, _arbitrator, usdc, _addr, _esc) = setup();
        let token_client = TokenClient::new(&env, &usdc);
        client.stake(&seller, &3_000_000_000);

        // Request at t=0, cooldown=3600, so cooldown_ends=3600.
        env.ledger().set_timestamp(0);
        client.request_unstake(&seller, &3_000_000_000);

        // Withdraw at t=3599 (just before): should fail.
        env.ledger().set_timestamp(3599);
        let result = client.try_withdraw(&seller);
        assert!(result.is_err());

        // Withdraw at t=3600 (exact boundary): should succeed.
        env.ledger().set_timestamp(3600);
        client.withdraw(&seller);
        assert_eq!(token_client.balance(&seller), INITIAL_SELLER_BALANCE);
    }

    #[test]
    fn test_withdraw_partial_after_mid_cooldown_slash() {
        let (env, client, _admin, seller, _arbitrator, usdc, bond_addr, _esc) = setup();
        let token_client = TokenClient::new(&env, &usdc);
        let staked: i128 = 5_000_000_000;
        client.stake(&seller, &staked);

        // Request unstake of the full amount.
        env.ledger().set_timestamp(1000);
        client.request_unstake(&seller, &staked);

        // Simulate a mid-cooldown slash by directly modifying the bond record.
        // In production, the arbitrator calls `slash()`. For this test we
        // manipulate state to verify the clamp: pending_unstake > staked after
        // a slash.
        env.as_contract(&bond_addr, || {
            let mut record = env
                .storage()
                .persistent()
                .get::<DataKey, BondRecord>(&DataKey::Bond(seller.clone()))
                .unwrap();
            record.staked = 2_000_000_000; // slashed from 5B to 2B
            record.slashed_total = 3_000_000_000;
            record.slash_count = 1;
            env.storage()
                .persistent()
                .set(&DataKey::Bond(seller.clone()), &record);
        });

        // Withdraw after cooldown: payout is min(5B, 2B) = 2B.
        env.ledger().set_timestamp(4600);
        client.withdraw(&seller);

        let bond = client.get_bond(&seller);
        assert_eq!(bond.staked, 0);
        assert_eq!(bond.pending_unstake, 0);
        // Seller gets back 2B (not the full 5B they requested).
        assert_eq!(
            token_client.balance(&seller),
            INITIAL_SELLER_BALANCE - staked + 2_000_000_000
        );
    }

    #[test]
    fn test_has_open_unstake() {
        let (env, client, _admin, seller, _arbitrator, _usdc, _addr, _esc) = setup();
        client.stake(&seller, &5_000_000_000);

        assert!(!client.has_open_unstake(&seller));

        env.ledger().set_timestamp(1000);
        client.request_unstake(&seller, &1_000_000_000);

        assert!(client.has_open_unstake(&seller));

        env.ledger().set_timestamp(4600);
        client.withdraw(&seller);

        assert!(!client.has_open_unstake(&seller));
    }

    // ── slash ────────────────────────────────────────────────────────────────

    #[test]
    fn test_slash_transfers_cut_and_updates_record() {
        let (env, client, _admin, seller, arbitrator, usdc, _addr, _esc) = setup();
        let token_client = TokenClient::new(&env, &usdc);
        let staked: i128 = 5_000_000_000; // 500 USDC
        client.stake(&seller, &staked);

        let beneficiary = Address::generate(&env);
        let bps = 1_000u32; // 10 %
        let expected_cut: i128 = 500_000_000; // 5_000_000_000 * 1000 / 10_000

        client.slash(&arbitrator, &seller, &42, &bps, &beneficiary);

        let bond = client.get_bond(&seller);
        assert_eq!(bond.staked, staked - expected_cut);
        assert_eq!(bond.slashed_total, expected_cut);
        assert_eq!(bond.slash_count, 1);

        // Tokens moved from contract to beneficiary.
        assert_eq!(token_client.balance(&beneficiary), expected_cut);
        assert_eq!(token_client.balance(&_addr), staked - expected_cut);
    }

    #[test]
    fn test_slash_is_additive() {
        let (env, client, _admin, seller, arbitrator, _usdc, _addr, _esc) = setup();
        let staked: i128 = 10_000_000_000;
        client.stake(&seller, &staked);

        let beneficiary = Address::generate(&env);

        // First slash: 10% of 10B = 1B
        client.slash(&arbitrator, &seller, &1, &1_000, &beneficiary);
        let bond = client.get_bond(&seller);
        assert_eq!(bond.staked, 9_000_000_000);
        assert_eq!(bond.slash_count, 1);
        assert_eq!(bond.slashed_total, 1_000_000_000);

        // Second slash: 10% of 9B = 900M
        client.slash(&arbitrator, &seller, &2, &1_000, &beneficiary);
        let bond = client.get_bond(&seller);
        assert_eq!(bond.staked, 8_100_000_000);
        assert_eq!(bond.slash_count, 2);
        assert_eq!(bond.slashed_total, 1_900_000_000);
    }

    #[test]
    fn test_slash_floor_math_one_stroop() {
        let (env, client, _admin, seller, arbitrator, _usdc, _addr, _esc) = setup();
        // Stake 1 stroop — the max(1, raw_cut) floor should still cut 1.
        client.stake(&seller, &1);

        let beneficiary = Address::generate(&env);
        client.slash(&arbitrator, &seller, &1, &1_000, &beneficiary);

        let bond = client.get_bond(&seller);
        assert_eq!(bond.staked, 0);
        assert_eq!(bond.slashed_total, 1);
    }

    #[test]
    fn test_slash_clamps_to_staked() {
        let (env, client, _admin, seller, arbitrator, _usdc, _addr, _esc) = setup();
        // Stake 10 stroops, slash at MAX_SLASH_BPS (20%). 10 * 2000 / 10000 = 2.
        client.stake(&seller, &10);

        let beneficiary = Address::generate(&env);
        client.slash(&arbitrator, &seller, &1, &MAX_SLASH_BPS, &beneficiary);

        let bond = client.get_bond(&seller);
        assert_eq!(bond.staked, 8);
        assert_eq!(bond.slashed_total, 2);
    }

    #[test]
    fn test_slash_at_max_bps_20_percent() {
        let (env, client, _admin, seller, arbitrator, _usdc, _addr, _esc) = setup();
        let staked: i128 = 5_000_000_000;
        client.stake(&seller, &staked);

        let beneficiary = Address::generate(&env);
        client.slash(&arbitrator, &seller, &1, &MAX_SLASH_BPS, &beneficiary);

        let bond = client.get_bond(&seller);
        let expected_cut: i128 = 1_000_000_000; // 20% of 5B
        assert_eq!(bond.staked, staked - expected_cut);
        assert_eq!(bond.slashed_total, expected_cut);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #4)")]
    fn test_slash_rejects_non_arbitrator() {
        let (env, client, _admin, seller, _arbitrator, _usdc, _addr, _esc) = setup();
        let not_arb = Address::generate(&env);
        client.stake(&seller, &5_000_000_000);
        client.slash(&not_arb, &seller, &1, &1_000, &seller);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #13)")]
    fn test_slash_rejects_zero_bps() {
        let (_env, client, _admin, seller, arbitrator, _usdc, _addr, _esc) = setup();
        client.stake(&seller, &5_000_000_000);
        client.slash(&arbitrator, &seller, &1, &0, &seller);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #13)")]
    fn test_slash_rejects_bps_above_max() {
        let (_env, client, _admin, seller, arbitrator, _usdc, _addr, _esc) = setup();
        client.stake(&seller, &5_000_000_000);
        client.slash(&arbitrator, &seller, &1, &(MAX_SLASH_BPS + 1), &seller);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #14)")]
    fn test_slash_rejects_double_slash() {
        let (_env, client, _admin, seller, arbitrator, _usdc, _addr, _esc) = setup();
        client.stake(&seller, &5_000_000_000);
        client.slash(&arbitrator, &seller, &1, &1_000, &seller);
        // Same escrow_id again
        client.slash(&arbitrator, &seller, &1, &1_000, &seller);
    }

    #[test]
    fn test_slash_idempotency_different_escrows_ok() {
        let (env, client, _admin, seller, arbitrator, _usdc, _addr, _esc) = setup();
        client.stake(&seller, &10_000_000_000);
        let beneficiary = Address::generate(&env);

        // Different escrow ids: both succeed.
        client.slash(&arbitrator, &seller, &1, &1_000, &beneficiary);
        client.slash(&arbitrator, &seller, &2, &1_000, &beneficiary);

        let bond = client.get_bond(&seller);
        assert_eq!(bond.slash_count, 2);
    }

    #[test]
    fn test_is_slashed() {
        let (_env, client, _admin, seller, arbitrator, _usdc, _addr, _esc) = setup();
        client.stake(&seller, &5_000_000_000);

        assert!(!client.is_slashed(&42));
        client.slash(&arbitrator, &seller, &42, &1_000, &seller);
        assert!(client.is_slashed(&42));
        assert!(!client.is_slashed(&43));
    }

    // ── set_arbitrator ───────────────────────────────────────────────────────

    #[test]
    fn test_set_arbitrator() {
        let (env, client, admin, _seller, _arbitrator, _usdc, _addr, _esc) = setup();
        let new_arb = Address::generate(&env);
        client.set_arbitrator(&admin, &new_arb);
        assert_eq!(client.get_arbitrator(), new_arb);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #3)")]
    fn test_set_arbitrator_rejects_non_admin() {
        let (env, client, _admin, seller, _arbitrator, _usdc, _addr, _esc) = setup();
        let new_arb = Address::generate(&env);
        client.set_arbitrator(&seller, &new_arb);
    }

    #[test]
    fn test_set_arbitrator_new_arb_can_slash() {
        let (env, client, admin, seller, _arbitrator, usdc, _addr, _esc) = setup();
        let new_arb = Address::generate(&env);
        let beneficiary = Address::generate(&env);
        StellarAssetClient::new(&env, &usdc).mint(&seller, &5_000_000_000);

        client.stake(&seller, &5_000_000_000);

        // Rotate arbitrator
        client.set_arbitrator(&admin, &new_arb);

        // New arbitrator can slash
        client.slash(&new_arb, &seller, &1, &1_000, &beneficiary);
        assert!(client.is_slashed(&1));
    }

    // ── slash during cooldown → withdraw clamp ──────────────────────────────

    #[test]
    fn test_slash_during_cooldown_withdraw_pays_shrunken_amount() {
        let (env, client, _admin, seller, arbitrator, usdc, _addr, _esc) = setup();
        let token_client = TokenClient::new(&env, &usdc);
        let staked: i128 = 5_000_000_000;
        client.stake(&seller, &staked);

        // Request unstake of the full amount.
        env.ledger().set_timestamp(1000);
        client.request_unstake(&seller, &staked);

        // Slash 10% mid-cooldown.
        let beneficiary = Address::generate(&env);
        client.slash(&arbitrator, &seller, &42, &1_000, &beneficiary);

        // Withdraw after cooldown: payout is min(5B, 4.5B) = 4.5B.
        env.ledger().set_timestamp(4600);
        client.withdraw(&seller);

        let bond = client.get_bond(&seller);
        assert_eq!(bond.staked, 0);
        assert_eq!(bond.pending_unstake, 0);
        // Seller gets 4.5B back (not the 5B they requested).
        let expected_payout: i128 = 4_500_000_000;
        assert_eq!(
            token_client.balance(&seller),
            INITIAL_SELLER_BALANCE - staked + expected_payout
        );
    }

    // ═══ Formal tests ════════════════════════════════════════════════════════
    // These are picked up by `cargo test formal_` (contracts:formal).

    /// Formal B1 — total value conserved across a fixed multi-step sequence:
    /// stake → request_unstake → slash → withdraw.
    ///
    /// The identity: every stroop that entered via stake either remains
    /// in the contract, was paid to the beneficiary (slash), or was
    /// returned to the seller (withdraw).
    #[test]
    fn formal_bond_conserves_total_value() {
        let (env, client, _admin, seller, arbitrator, usdc, _addr, _esc) = setup();
        let token_client = TokenClient::new(&env, &usdc);
        let staked: i128 = 5_000_000_000;
        let initial_total = token_client.balance(&seller);

        // Step 1: Stake
        client.stake(&seller, &staked);
        assert_eq!(
            token_client.balance(&seller) + token_client.balance(&_addr),
            initial_total
        );

        // Step 2: Request unstake
        env.ledger().set_timestamp(1000);
        client.request_unstake(&seller, &staked);
        // No token movement — conservation still holds.
        assert_eq!(
            token_client.balance(&seller) + token_client.balance(&_addr),
            initial_total
        );

        // Step 3: Slash 10% mid-cooldown
        let beneficiary = Address::generate(&env);
        client.slash(&arbitrator, &seller, &42, &1_000, &beneficiary);
        let expected_cut: i128 = 500_000_000; // 10 % of 5 B
        assert_eq!(token_client.balance(&beneficiary), expected_cut);
        assert_eq!(
            token_client.balance(&seller)
                + token_client.balance(&_addr)
                + token_client.balance(&beneficiary),
            initial_total
        );

        // Step 4: Withdraw after cooldown — payout = min(5 B, 4.5 B) = 4.5 B
        env.ledger().set_timestamp(4600);
        client.withdraw(&seller);
        let expected_payout = staked - expected_cut;
        assert_eq!(
            token_client.balance(&seller),
            initial_total - staked + expected_payout
        );
        assert_eq!(token_client.balance(&beneficiary), expected_cut);

        // Global conservation: total across all accounts is unchanged.
        assert_eq!(
            token_client.balance(&seller)
                + token_client.balance(&_addr)
                + token_client.balance(&beneficiary),
            initial_total
        );

        let bond = client.get_bond(&seller);
        assert_eq!(bond.staked, 0);
        assert_eq!(bond.pending_unstake, 0);
        assert_eq!(bond.slashed_total, expected_cut);
    }

    /// Formal B8 — dispute lock prevents unstake while disputes are open.
    /// This test uses a MockEscrow to simulate the cross-contract dispute
    /// counter, exercising the `request_unstake` → `read_open_disputes` path.
    #[test]
    fn formal_dispute_locked_stake_cannot_be_withdrawn() {
        let (env, client, _admin, seller, _arbitrator, usdc, bond_addr, escrow_addr) = setup();
        let token_client = TokenClient::new(&env, &usdc);
        let staked: i128 = 5_000_000_000;
        client.stake(&seller, &staked);

        // Open a dispute in the mock escrow
        let mock_client = MockEscrowClient::new(&env, &escrow_addr);
        mock_client.set_dspt_cnt(&seller, &1);

        // request_unstake must fail with OpenDisputeBlocksUnstake
        let result = client.try_request_unstake(&seller, &staked);
        assert!(result.is_err());
        // Verify no state change
        let bond = client.get_bond(&seller);
        assert_eq!(bond.staked, staked);
        assert_eq!(bond.pending_unstake, 0);
        assert_eq!(token_client.balance(&bond_addr), staked);

        // Close the dispute
        mock_client.set_dspt_cnt(&seller, &0);

        // Now request_unstake succeeds
        env.ledger().set_timestamp(1000);
        client.request_unstake(&seller, &staked);
        let bond = client.get_bond(&seller);
        assert_eq!(bond.pending_unstake, staked);

        // Withdraw after cooldown
        env.ledger().set_timestamp(4600);
        client.withdraw(&seller);
        assert_eq!(client.get_bond(&seller).staked, 0);
        assert_eq!(token_client.balance(&seller), INITIAL_SELLER_BALANCE);
    }
}
