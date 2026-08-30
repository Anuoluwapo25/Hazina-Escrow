#![no_std]

use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, panic_with_error, token,
    Address, Env, String, Symbol,
};

// ─── Constants ───────────────────────────────────────────────────────────────

// These are `pub` on purpose: the property-based lifecycle suite in
// `tests/fuzz/` derives its input strategies and expected-value models from
// them, so the tests and the contract can never disagree about a boundary.
// Same rule as hazina-escrow's constants (see docs/INVARIANTS.md there).

/// TTL extension applied to persistent pass/plan records (~60 days in ledgers).
pub const PASS_BUMP_LEDGERS: u32 = 518_400;

/// Minimum remaining TTL before a bump is triggered (~24 h in ledgers).
pub const PASS_MIN_TTL: u32 = 17_280;

/// Denominator for every basis-point fee calculation.
pub const MAX_BASIS_POINTS: u32 = 10_000;

/// Minimum subscription price per period in stroops (0.001 USDC). Mirrors
/// `MIN_LOCK_AMOUNT` in hazina-escrow.
pub const MIN_SUB_AMOUNT: i128 = 10_000;

/// Maximum subscription period: 30 days in seconds. Mirrors
/// `MAX_EXPIRY_SECONDS` in hazina-escrow.
pub const MAX_PERIOD_SECONDS: u64 = 30 * 24 * 60 * 60;

/// Sanity ceiling on seats per plan; real caps are whatever the seller sets
/// below this.
pub const MAX_SEATS_CAP: u32 = 10_000;

// ─── Cross-contract fee reader (#551 reuse) ──────────────────────────────────

/// Mirror of hazina-escrow's `DatasetFeeConfig`. Field names MUST match the
/// escrow struct exactly — Soroban structs decode by field name across
/// contracts, so this local type is the wire contract for the cross-call.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowFeeConfig {
    pub default_fee_bps: u32,
    pub has_custom_fee: bool,
    pub dataset_fee_bps: u32,
    pub effective_fee_bps: u32,
}

/// Read-only client for the escrow contract's fee config. The access-pass
/// contract NEVER stores fee state of its own; every charge point resolves
/// fees through this client so #551 stays the single source of truth.
#[contractclient(name = "EscrowFeeClient")]
pub trait EscrowFeeReader {
    fn get_dataset_fee_config(env: Env, dataset_id: String) -> EscrowFeeConfig;
}

// ─── Storage keys ────────────────────────────────────────────────────────────

#[contracttype]
pub enum DataKey {
    /// Set to `true` the first time initialize() runs. Checked before any
    /// other state is written to guard against re-initialization.
    Initialized,
    Admin,
    /// Optional payout address for platform fees; falls back to Admin.
    Treasury,
    /// Payment token (SAC address) fixed at initialization.
    Token,
    /// hazina-escrow contract address used for fee lookups.
    EscrowContract,
    /// Plan id counter; plans are assigned sequentially from 0.
    PlanCount,
    /// Active seats per plan (see the seat semantics note on `subscribe`).
    SeatsUsed(u64),
}

#[contracttype]
pub enum PlanKey {
    Record(u64),
}

/// One pass per (buyer, dataset_id). A resubscribe after expiry or revoke
/// overwrites the same entry in place.
#[contracttype]
pub enum PassKey {
    Holder(Address, String),
}

// ─── Errors ──────────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum HazinaAccessPassError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    NotAdmin = 3,
    NotSeller = 4,
    EmptyDatasetId = 5,
    InvalidAmount = 6,
    InvalidPeriod = 7,
    InvalidSeats = 8,
    PlanNotFound = 9,
    PlanInactive = 10,
    MaxSeatsReached = 11,
    AlreadySubscribed = 12,
    PassNotFound = 13,
    FeeLookupFailed = 14,
    InvalidRecipient = 15,
    NotExpired = 16,
    NothingToSettle = 17,
}

// ─── Types ───────────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanRecord {
    pub plan_id: u64,
    pub seller: Address,
    pub dataset_id: String,
    pub price_per_period: i128,
    pub period_seconds: u64,
    pub max_seats: u32,
    pub active: bool,
}

/// The buyer's current pass. `start`/`expiry`/`term_period_seconds`
/// describe the CURRENT term; `term_period_seconds` is snapshotted per term
/// so pro-rata math on revoke stays correct even if the seller later defines
/// a new plan with a different period.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PassRecord {
    pub plan_id: u64,
    pub buyer: Address,
    pub dataset_id: String,
    pub start: u64,
    pub expiry: u64,
    pub term_period_seconds: u64,
    pub amount_paid: i128,
    /// Fee snapshotted at payment time from the escrow contract — same rule
    /// as escrow snapshots `platform_fee_bps` at lock time.
    pub fee_bps: u32,
    pub revoked: bool,
}

// ─── Contract ────────────────────────────────────────────────────────────────

#[contract]
pub struct HazinaAccessPass;

#[contractimpl]
impl HazinaAccessPass {
    // ─── Initialization ──────────────────────────────────────────────────────

    /// One-time setup. Panics with `AlreadyInitialized` on any subsequent call.
    /// The `Initialized` flag is written *before* any other state so there is
    /// no window for partial re-init even if a future upgrade bug exists.
    ///
    /// Fee configuration is NOT stored here by design: it is read live from
    /// `escrow_contract` at every charge point (#551 single source of truth).
    /// A misconfigured escrow address surfaces as a failed subscribe (the
    /// cross-contract call traps), never as a silently wrong fee.
    pub fn initialize(env: Env, admin: Address, escrow_contract: Address, token: Address) {
        if env.storage().instance().has(&DataKey::Initialized) {
            panic_with_error!(&env, HazinaAccessPassError::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Initialized, &true);

        // Fail fast on an unusable token; the escrow address is validated
        // lazily (escrow's own getters never trap on uninitialized state, so
        // an eager ping proves nothing).
        Self::assert_valid_token(&env, &token);

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::EscrowContract, &escrow_contract);
        env.storage().instance().set(&DataKey::Token, &token);
        env.storage().instance().set(&DataKey::PlanCount, &0u64);
        env.storage()
            .instance()
            .extend_ttl(PASS_MIN_TTL, PASS_BUMP_LEDGERS);

        env.events().publish(
            (Symbol::new(&env, "initialized"),),
            (admin, escrow_contract, token),
        );
    }

    /// Set where platform fees land. Falls back to admin when unset.
    pub fn set_treasury(env: Env, admin: Address, treasury: Address) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);
        if treasury == env.current_contract_address() {
            panic_with_error!(&env, HazinaAccessPassError::InvalidRecipient);
        }
        env.storage().instance().set(&DataKey::Treasury, &treasury);
        env.events()
            .publish((Symbol::new(&env, "trs_set"),), (treasury,));
    }

    // ─── Plans ───────────────────────────────────────────────────────────────

    /// Define a subscription plan for a dataset. Sellers self-serve; the
    /// seller recorded here is the only non-admin account allowed to flip the
    /// plan's `active` flag or revoke its passes.
    ///
    /// Repricing creates a NEW plan rather than mutating this one, so every
    /// existing pass keeps the economics it was sold under.
    pub fn define_plan(
        env: Env,
        seller: Address,
        dataset_id: String,
        price_per_period: i128,
        period_seconds: u64,
        max_seats: u32,
    ) -> u64 {
        seller.require_auth();
        Self::assert_valid_dataset_id(&env, &dataset_id);
        if price_per_period < MIN_SUB_AMOUNT {
            panic_with_error!(&env, HazinaAccessPassError::InvalidAmount);
        }
        if period_seconds == 0 || period_seconds > MAX_PERIOD_SECONDS {
            panic_with_error!(&env, HazinaAccessPassError::InvalidPeriod);
        }
        if max_seats == 0 || max_seats > MAX_SEATS_CAP {
            panic_with_error!(&env, HazinaAccessPassError::InvalidSeats);
        }

        let plan_id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::PlanCount)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::PlanCount, &(plan_id + 1));

        let record = PlanRecord {
            plan_id,
            seller: seller.clone(),
            dataset_id: dataset_id.clone(),
            price_per_period,
            period_seconds,
            max_seats,
            active: true,
        };
        env.storage()
            .persistent()
            .set(&PlanKey::Record(plan_id), &record);
        env.storage().persistent().extend_ttl(
            &PlanKey::Record(plan_id),
            PASS_MIN_TTL,
            PASS_BUMP_LEDGERS,
        );

        env.events().publish(
            (Symbol::new(&env, "plan_new"),),
            (
                plan_id,
                seller,
                dataset_id,
                price_per_period,
                period_seconds,
                max_seats,
            ),
        );
        plan_id
    }

    /// Activate/deactivate a plan. Deactivation blocks NEW subscriptions and
    /// renewals but never shortens access already paid for (see `has_access`).
    pub fn set_plan_active(env: Env, caller: Address, plan_id: u64, active: bool) {
        caller.require_auth();
        let mut plan = Self::read_plan(&env, plan_id);
        let admin = Self::get_admin(&env);
        if caller != plan.seller && caller != admin {
            panic_with_error!(&env, HazinaAccessPassError::NotSeller);
        }
        plan.active = active;
        env.storage()
            .persistent()
            .set(&PlanKey::Record(plan_id), &plan);
        env.storage().persistent().extend_ttl(
            &PlanKey::Record(plan_id),
            PASS_MIN_TTL,
            PASS_BUMP_LEDGERS,
        );
        env.events()
            .publish((Symbol::new(&env, "plan_set"),), (plan_id, active));
    }

    pub fn get_plan(env: Env, plan_id: u64) -> PlanRecord {
        let plan = Self::read_plan(&env, plan_id);
        env.storage().persistent().extend_ttl(
            &PlanKey::Record(plan_id),
            PASS_MIN_TTL,
            PASS_BUMP_LEDGERS,
        );
        plan
    }

    pub fn get_seats_used(env: Env, plan_id: u64) -> u32 {
        Self::read_seats_used(&env, plan_id)
    }

    // ─── Subscription lifecycle ──────────────────────────────────────────────

    /// Subscribe a buyer to a plan, charging one full period up front.
    ///
    /// Seat semantics (approved in docs/ACCESS_PASS_PLAN.md §11 Q1):
    /// - A seat is held from first subscribe until revoke.
    /// - An EXPIRED pass still holds its seat; the holder resubscribing
    ///   reuses that slot without incrementing the counter.
    /// - Renewal never changes the counter.
    /// - Revoke frees the seat.
    ///
    /// Payment ordering is load-bearing: the token transfer into custody
    /// happens BEFORE any state write, inside the same invocation. If the
    /// transfer fails the whole call reverts and nothing persists — the
    /// "no pass without settled payment" invariant is structural, not a
    /// post-hoc check.
    pub fn subscribe(env: Env, buyer: Address, dataset_id: String, plan_id: u64) {
        buyer.require_auth();
        Self::assert_valid_dataset_id(&env, &dataset_id);
        let plan = Self::read_plan(&env, plan_id);
        if !plan.active {
            panic_with_error!(&env, HazinaAccessPassError::PlanInactive);
        }

        let now = env.ledger().timestamp();
        let key = PassKey::Holder(buyer.clone(), dataset_id.clone());
        let existing: Option<PassRecord> = env.storage().persistent().get(&key);
        if let Some(pass) = &existing {
            if !pass.revoked && now < pass.expiry {
                // True even at `expiry - 1`: an active pass always blocks.
                panic_with_error!(&env, HazinaAccessPassError::AlreadySubscribed);
            }
        }
        // Reaching here with an unrevoked pass means it was already expired:
        // slot reuse, counter untouched.
        let seat_held = matches!(&existing, Some(p) if !p.revoked);

        if !seat_held {
            let used = Self::read_seats_used(&env, plan_id);
            if used >= plan.max_seats {
                panic_with_error!(&env, HazinaAccessPassError::MaxSeatsReached);
            }
        }

        // Fee lookup FIRST (fail closed): a broken escrow link aborts before
        // any money moves.
        let fee_bps = Self::resolve_fee_bps(&env, &dataset_id);

        // Settled payment before any write.
        let token_client = token::Client::new(&env, &Self::get_token(&env));
        token_client.transfer(
            &buyer,
            &env.current_contract_address(),
            &plan.price_per_period,
        );

        if !seat_held {
            let used = Self::read_seats_used(&env, plan_id);
            env.storage()
                .persistent()
                .set(&DataKey::SeatsUsed(plan_id), &(used + 1));
            env.storage().persistent().extend_ttl(
                &DataKey::SeatsUsed(plan_id),
                PASS_MIN_TTL,
                PASS_BUMP_LEDGERS,
            );
        }

        let pass = PassRecord {
            plan_id,
            buyer: buyer.clone(),
            dataset_id: dataset_id.clone(),
            start: now,
            expiry: now.saturating_add(plan.period_seconds),
            term_period_seconds: plan.period_seconds,
            amount_paid: plan.price_per_period,
            fee_bps,
            revoked: false,
        };
        env.storage().persistent().set(&key, &pass);
        env.storage()
            .persistent()
            .extend_ttl(&key, PASS_MIN_TTL, PASS_BUMP_LEDGERS);
        Self::bump_plan(&env, plan_id);

        env.events().publish(
            (Symbol::new(&env, "subscribed"),),
            (
                buyer,
                dataset_id,
                plan_id,
                pass.expiry,
                pass.amount_paid,
                pass.fee_bps,
            ),
        );
    }

    /// Renew for another period.
    ///
    /// Settlement sequence:
    /// 1. If the prior term carries unsettled value, pay it out of custody:
    ///    net to the seller, fee to the treasury. Renewing early does not
    ///    refund unused days — instead the new term extends from `expiry`.
    /// 2. Charge the CURRENT plan price with a FRESH fee snapshot.
    /// 3. Term math (approved boundary behavior):
    ///    - renewing before expiry extends: `new_expiry = old_expiry + period`
    ///      (no paid time lost);
    ///    - renewing after expiry starts a FRESH term anchored at `now`,
    ///      NOT `old_expiry + period`.
    pub fn renew(env: Env, buyer: Address, dataset_id: String) {
        buyer.require_auth();
        Self::assert_valid_dataset_id(&env, &dataset_id);
        let mut pass = Self::read_pass_or_panic(&env, &buyer, &dataset_id);
        if pass.revoked {
            // A revoked pass was fully settled at revoke time; renewing it
            // would re-pay its stale `amount_paid` out of custody that no
            // longer holds those funds. Same convention as double-revoke:
            // revoked means gone.
            panic_with_error!(&env, HazinaAccessPassError::PassNotFound);
        }
        let plan = Self::read_plan(&env, pass.plan_id);
        if !plan.active {
            panic_with_error!(&env, HazinaAccessPassError::PlanInactive);
        }

        let now = env.ledger().timestamp();

        // 1) Settle the prior term out of custody.
        if pass.amount_paid > 0 {
            let fee = Self::fee_with_floor(pass.amount_paid, pass.fee_bps);
            let seller_net = pass.amount_paid - fee;
            let treasury = Self::treasury_or_admin(&env);
            let token_client = token::Client::new(&env, &Self::get_token(&env));
            token_client.transfer(&env.current_contract_address(), &plan.seller, &seller_net);
            if fee > 0 {
                token_client.transfer(&env.current_contract_address(), &treasury, &fee);
            }
        }

        // 2) Charge the new term before any state write.
        let fee_bps = Self::resolve_fee_bps(&env, &dataset_id);
        let token_client = token::Client::new(&env, &Self::get_token(&env));
        token_client.transfer(
            &buyer,
            &env.current_contract_address(),
            &plan.price_per_period,
        );

        // 3) Fresh-term vs extend arithmetic.
        let old_expiry = pass.expiry;
        let (start, expiry) = if now >= old_expiry {
            (now, now.saturating_add(plan.period_seconds))
        } else {
            (old_expiry, old_expiry.saturating_add(plan.period_seconds))
        };
        pass.start = start;
        pass.expiry = expiry;
        pass.term_period_seconds = plan.period_seconds;
        pass.amount_paid = plan.price_per_period;
        pass.fee_bps = fee_bps;

        let key = PassKey::Holder(buyer.clone(), dataset_id.clone());
        env.storage().persistent().set(&key, &pass);
        // Bump-on-renew.
        env.storage()
            .persistent()
            .extend_ttl(&key, PASS_MIN_TTL, PASS_BUMP_LEDGERS);
        Self::bump_plan(&env, plan.plan_id);

        env.events().publish(
            (Symbol::new(&env, "renewed"),),
            (buyer, dataset_id, old_expiry, pass.expiry, pass.amount_paid),
        );
    }

    /// Permissionless settlement of a naturally expired term. Anyone may
    /// trigger it — the outcome is fully determined by prior state, mirroring
    /// escrow's anyone-can-execute actions (`execute_upgrade`). Without this,
    /// a term ending without renew/revoke would strand value in custody.
    pub fn settle_expired(env: Env, buyer: Address, dataset_id: String) {
        Self::assert_valid_dataset_id(&env, &dataset_id);
        let mut pass = Self::read_pass_or_panic(&env, &buyer, &dataset_id);
        if pass.revoked {
            // Revoked passes were fully settled at revoke time.
            panic_with_error!(&env, HazinaAccessPassError::NothingToSettle);
        }
        let now = env.ledger().timestamp();
        if now < pass.expiry {
            panic_with_error!(&env, HazinaAccessPassError::NotExpired);
        }
        if pass.amount_paid == 0 {
            panic_with_error!(&env, HazinaAccessPassError::NothingToSettle);
        }

        let plan = Self::read_plan(&env, pass.plan_id);
        let fee = Self::fee_with_floor(pass.amount_paid, pass.fee_bps);
        let seller_net = pass.amount_paid - fee;
        let treasury = Self::treasury_or_admin(&env);
        let token_client = token::Client::new(&env, &Self::get_token(&env));
        token_client.transfer(&env.current_contract_address(), &plan.seller, &seller_net);
        if fee > 0 {
            token_client.transfer(&env.current_contract_address(), &treasury, &fee);
        }

        pass.amount_paid = 0;
        let key = PassKey::Holder(buyer.clone(), dataset_id.clone());
        env.storage().persistent().set(&key, &pass);
        env.storage()
            .persistent()
            .extend_ttl(&key, PASS_MIN_TTL, PASS_BUMP_LEDGERS);

        env.events().publish(
            (Symbol::new(&env, "settled"),),
            (buyer, dataset_id, seller_net, fee),
        );
    }

    /// Revoke a pass. Allowed mid-term (pro-rata refund to the buyer) or
    /// after expiry (pure settlement: refund is zero, seller still gets the
    /// earned term). Callable by the plan's seller or the admin.
    ///
    /// Pro-rata arithmetic (floor division everywhere):
    ///   elapsed   = min(now, expiry) - start
    ///   remaining = term_period_seconds - elapsed
    ///   refund    = amount_paid * remaining / term_period_seconds
    ///   earned    = amount_paid - refund
    ///   fee       = floor(earned * fee_bps / 10_000), floored up to 1 stroop
    ///               when fee_bps > 0 and earned > 0 (escrow rule)
    /// Conservation: refund + (earned - fee) + fee == amount_paid exactly.
    pub fn revoke(env: Env, caller: Address, buyer: Address, dataset_id: String) {
        caller.require_auth();
        Self::assert_valid_dataset_id(&env, &dataset_id);
        let mut pass = Self::read_pass_or_panic(&env, &buyer, &dataset_id);
        if pass.revoked {
            panic_with_error!(&env, HazinaAccessPassError::PassNotFound);
        }
        let plan = Self::read_plan(&env, pass.plan_id);
        let admin = Self::get_admin(&env);
        if caller != plan.seller && caller != admin {
            panic_with_error!(&env, HazinaAccessPassError::NotSeller);
        }

        let now = env.ledger().timestamp();
        let elapsed = now.min(pass.expiry).saturating_sub(pass.start);
        let remaining = pass.term_period_seconds - elapsed;
        let refund = pass.amount_paid * remaining as i128 / pass.term_period_seconds as i128;
        let earned = pass.amount_paid - refund;
        let fee = Self::fee_with_floor(earned, pass.fee_bps);
        let seller_net = earned - fee;

        let treasury = Self::treasury_or_admin(&env);
        let token_client = token::Client::new(&env, &Self::get_token(&env));
        if refund > 0 {
            token_client.transfer(&env.current_contract_address(), &pass.buyer, &refund);
        }
        if seller_net > 0 {
            token_client.transfer(&env.current_contract_address(), &plan.seller, &seller_net);
        }
        if fee > 0 {
            token_client.transfer(&env.current_contract_address(), &treasury, &fee);
        }

        pass.revoked = true;
        let key = PassKey::Holder(buyer.clone(), dataset_id.clone());
        env.storage().persistent().set(&key, &pass);
        env.storage()
            .persistent()
            .extend_ttl(&key, PASS_MIN_TTL, PASS_BUMP_LEDGERS);

        // Free the seat (saturating; the counter can never legitimately be 0 here).
        let used = Self::read_seats_used(&env, pass.plan_id);
        env.storage()
            .persistent()
            .set(&DataKey::SeatsUsed(pass.plan_id), &(used.saturating_sub(1)));
        env.storage().persistent().extend_ttl(
            &DataKey::SeatsUsed(pass.plan_id),
            PASS_MIN_TTL,
            PASS_BUMP_LEDGERS,
        );

        env.events().publish(
            (Symbol::new(&env, "revoked"),),
            (buyer, dataset_id, refund, earned),
        );
    }

    // ─── Read-only views ────────────────────────────────────────────────────

    /// True iff a pass exists, is not revoked, and has not expired. Never
    /// panics on a missing pass. Bumps the pass entry TTL while present so an
    /// actively-checked pass never archives (same idiom as escrow's
    /// `get_escrow`).
    pub fn has_access(env: Env, buyer: Address, dataset_id: String) -> bool {
        let key = PassKey::Holder(buyer, dataset_id);
        match env.storage().persistent().get::<_, PassRecord>(&key) {
            Some(pass) => {
                let active = !pass.revoked && env.ledger().timestamp() < pass.expiry;
                env.storage()
                    .persistent()
                    .extend_ttl(&key, PASS_MIN_TTL, PASS_BUMP_LEDGERS);
                active
            }
            None => false,
        }
    }

    /// Returns `None` when absent rather than trapping: the UI polls this
    /// constantly and a trap-per-miss read would be hostile to read-only
    /// simulations. Deliberate deviation from escrow's panicking getter.
    pub fn get_pass(env: Env, buyer: Address, dataset_id: String) -> Option<PassRecord> {
        let key = PassKey::Holder(buyer, dataset_id);
        match env.storage().persistent().get::<_, PassRecord>(&key) {
            Some(pass) => {
                env.storage()
                    .persistent()
                    .extend_ttl(&key, PASS_MIN_TTL, PASS_BUMP_LEDGERS);
                Some(pass)
            }
            None => None,
        }
    }

    // ─── Private helpers ─────────────────────────────────────────────────────

    fn assert_admin(env: &Env, caller: &Address) {
        if Self::get_admin(env) != *caller {
            panic_with_error!(env, HazinaAccessPassError::NotAdmin);
        }
    }

    fn get_admin(env: &Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(env, HazinaAccessPassError::NotInitialized))
    }

    fn get_token(env: &Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Token)
            .unwrap_or_else(|| panic_with_error!(env, HazinaAccessPassError::NotInitialized))
    }

    fn get_escrow_contract(env: &Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::EscrowContract)
            .unwrap_or_else(|| panic_with_error!(env, HazinaAccessPassError::NotInitialized))
    }

    fn treasury_or_admin(env: &Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Treasury)
            .unwrap_or_else(|| Self::get_admin(env))
    }

    /// Single source of truth for fees: a live cross-contract read of the
    /// escrow contract's per-dataset effective fee (#551). Any failure is
    /// fail-closed: guest errors map to `FeeLookupFailed`, host-level
    /// failures trap, and both abort the invocation before money moves.
    fn resolve_fee_bps(env: &Env, dataset_id: &String) -> u32 {
        let escrow = Self::get_escrow_contract(env);
        match EscrowFeeClient::new(env, &escrow).try_get_dataset_fee_config(dataset_id) {
            // Outer Err: host-level invocation failure. Inner Err: escrow
            // rejected the lookup. Both fail closed before any money moves.
            Ok(Ok(cfg)) => cfg.effective_fee_bps,
            _ => panic_with_error!(env, HazinaAccessPassError::FeeLookupFailed),
        }
    }

    /// Platform cut with the escrow 1-stroop floor: when bps > 0 and the
    /// amount is too small to produce a nonzero cut, charge 1 stroop so a
    /// tiny sale can never route 100% to the counterparty.
    fn fee_with_floor(amount: i128, fee_bps: u32) -> i128 {
        let cut = amount * fee_bps as i128 / MAX_BASIS_POINTS as i128;
        if cut == 0 && amount > 0 && fee_bps > 0 {
            1
        } else {
            cut
        }
    }

    fn read_plan(env: &Env, plan_id: u64) -> PlanRecord {
        env.storage()
            .persistent()
            .get(&PlanKey::Record(plan_id))
            .unwrap_or_else(|| panic_with_error!(env, HazinaAccessPassError::PlanNotFound))
    }

    fn read_pass_or_panic(env: &Env, buyer: &Address, dataset_id: &String) -> PassRecord {
        env.storage()
            .persistent()
            .get(&PassKey::Holder(buyer.clone(), dataset_id.clone()))
            .unwrap_or_else(|| panic_with_error!(env, HazinaAccessPassError::PassNotFound))
    }

    fn read_seats_used(env: &Env, plan_id: u64) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::SeatsUsed(plan_id))
            .unwrap_or(0)
    }

    fn bump_plan(env: &Env, plan_id: u64) {
        env.storage().persistent().extend_ttl(
            &PlanKey::Record(plan_id),
            PASS_MIN_TTL,
            PASS_BUMP_LEDGERS,
        );
    }

    fn assert_valid_dataset_id(env: &Env, dataset_id: &String) {
        if dataset_id.is_empty() {
            panic_with_error!(env, HazinaAccessPassError::EmptyDatasetId);
        }
    }

    fn assert_valid_token(env: &Env, token: &Address) {
        let _ = token::Client::new(env, token).decimals();
    }
}

// ─── Unit tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    extern crate std;

    use super::*;
    use hazina_escrow::HazinaEscrowClient;
    use soroban_sdk::{
        testutils::{storage::Persistent as _, Address as _, Events as _, Ledger as _},
        token::{Client as TokenClient, StellarAssetClient},
        TryFromVal,
    };
    use std::panic::{catch_unwind, AssertUnwindSafe};

    const INITIAL_BUYER_BALANCE: i128 = 10_000_000_000;
    const DAY: u64 = 24 * 60 * 60;

    pub struct Setup {
        pub env: Env,
        pub client: HazinaAccessPassClient<'static>,
        pub escrow: HazinaEscrowClient<'static>,
        pub admin: Address,
        pub seller: Address,
        pub buyer: Address,
        pub usdc: Address,
        pub token: TokenClient<'static>,
    }

    /// Unlike hazina-escrow's setup, the ledger's MIN persistent TTL is pinned
    /// to the SDK default floor (4_096) instead of being raised: fresh entries
    /// start short-lived, so the TTL-bump tests observe exact
    /// `(PASS_MIN_TTL, PASS_BUMP_LEDGERS)` effects instead of trivially
    /// passing against a raised floor. Escrow raises both bounds because its
    /// timelock flows jump 25_920 ledgers; the pass contract has no timelock.
    pub fn setup() -> Setup {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(1_000);
        // Deterministic fresh-entry TTL: keep the SDK default floor (4_096)
        // explicitly so extend_ttl(PASS_MIN_TTL, PASS_BUMP_LEDGERS) always
        // fires on writes and the TTL tests can assert exact values. Only MAX
        // is raised so extending to 518_400 ledgers is legal.
        env.ledger().set_min_persistent_entry_ttl(4_096);
        env.ledger().set_max_entry_ttl(1_000_000);

        let admin = Address::generate(&env);
        let seller = Address::generate(&env);
        let buyer = Address::generate(&env);

        let token_id = env.register_stellar_asset_contract_v2(admin.clone());
        let usdc = token_id.address();
        StellarAssetClient::new(&env, &usdc).mint(&buyer, &INITIAL_BUYER_BALANCE);

        let escrow_id = env.register(hazina_escrow::HazinaEscrow, ());
        let escrow = HazinaEscrowClient::new(&env, &escrow_id);
        escrow.initialize(&admin, &500);

        let contract_id = env.register(HazinaAccessPass, ());
        let client = HazinaAccessPassClient::new(&env, &contract_id);
        client.initialize(&admin, &escrow_id, &usdc);

        let token = TokenClient::new(&env, &usdc);
        Setup {
            env,
            client,
            escrow,
            admin,
            seller,
            buyer,
            usdc,
            token,
        }
    }

    pub fn ds(env: &Env, value: &str) -> String {
        String::from_str(env, value)
    }

    pub fn make_plan(s: &Setup, price: i128, period: u64, seats: u32) -> u64 {
        s.client
            .define_plan(&s.seller, &ds(&s.env, "ds-plan"), &price, &period, &seats)
    }

    fn last_event_topic(s: &Setup) -> Symbol {
        let all = s.env.events().all();
        let (_, topics, _) = all.get(all.len() - 1).unwrap();
        Symbol::try_from_val(&s.env, &topics.get(0).unwrap()).unwrap()
    }

    /// TTL of a pass entry, read from inside the contract's own context
    /// (SDK 22 forbids direct storage access from test code).
    fn pass_ttl(s: &Setup, buyer: &Address, dataset_id: &String) -> u32 {
        let key = PassKey::Holder(buyer.clone(), dataset_id.clone());
        s.env.as_contract(&s.client.address, || {
            s.env.storage().persistent().get_ttl(&key)
        })
    }

    /// Advance the ledger sequence far enough that an entry written with the
    /// `(PASS_MIN_TTL, PASS_BUMP_LEDGERS)` pair ages just below the bump
    /// threshold. Before jumping, every foreign entry later ops must touch is
    /// re-based onto a raised floor so nothing archives mid-test (touching an
    /// archived entry traps in testutils).
    fn age_pass_entry_below_threshold(s: &Setup) {
        s.env.ledger().set_min_persistent_entry_ttl(600_001);
        // Rewrites the token instance and buyer balance at the new floor.
        StellarAssetClient::new(&s.env, &s.usdc).mint(&s.buyer, &1);
        // Contract instances touched by renew / has_access afterwards.
        // Threshold == extend_to == the test ledger's max entry TTL forces
        // the extension to fire regardless of current TTL and parks the
        // entries far beyond the jump horizon.
        let ceiling = 1_000_000; // matches setup()'s set_max_entry_ttl
        for addr in [&s.client.address, &s.escrow.address, &s.usdc] {
            s.env.as_contract(addr, || {
                s.env.storage().instance().extend_ttl(ceiling, ceiling);
            });
        }
        let jump = PASS_BUMP_LEDGERS - PASS_MIN_TTL + 1;
        s.env
            .ledger()
            .set_sequence_number(s.env.ledger().sequence() + jump);
    }

    // ── B1: an active pass blocks subscribe right up to expiry − 1 ─────────

    #[test]
    #[should_panic(expected = "Error(Contract, #12)")]
    fn test_subscribe_blocked_at_expiry_minus_one() {
        let s = setup();
        let plan = make_plan(&s, 100_000, DAY, 10);
        s.client.subscribe(&s.buyer, &ds(&s.env, "ds-plan"), &plan);

        let pass = s.client.get_pass(&s.buyer, &ds(&s.env, "ds-plan")).unwrap();
        s.env.ledger().set_timestamp(pass.expiry - 1);
        s.client.subscribe(&s.buyer, &ds(&s.env, "ds-plan"), &plan);
    }

    #[test]
    fn test_has_access_true_at_expiry_minus_one() {
        let s = setup();
        let plan = make_plan(&s, 100_000, DAY, 10);
        s.client.subscribe(&s.buyer, &ds(&s.env, "ds-plan"), &plan);

        let pass = s.client.get_pass(&s.buyer, &ds(&s.env, "ds-plan")).unwrap();
        s.env.ledger().set_timestamp(pass.expiry - 1);
        assert!(s.client.has_access(&s.buyer, &ds(&s.env, "ds-plan")));
    }

    // ── B2: at exact expiry the pass is dead and a fresh subscribe works ────

    #[test]
    fn test_subscribe_allowed_at_exact_expiry() {
        let s = setup();
        let plan = make_plan(&s, 100_000, DAY, 10);
        s.client.subscribe(&s.buyer, &ds(&s.env, "ds-plan"), &plan);

        let pass = s.client.get_pass(&s.buyer, &ds(&s.env, "ds-plan")).unwrap();
        s.env.ledger().set_timestamp(pass.expiry);
        assert!(!s.client.has_access(&s.buyer, &ds(&s.env, "ds-plan")));

        // Fresh term anchored at now, not a resurrection of the old one.
        let balance_before = s.token.balance(&s.buyer);
        s.client.subscribe(&s.buyer, &ds(&s.env, "ds-plan"), &plan);
        let renewed = s.client.get_pass(&s.buyer, &ds(&s.env, "ds-plan")).unwrap();
        assert_eq!(renewed.start, pass.expiry);
        assert_eq!(renewed.expiry, pass.expiry + DAY);
        assert_eq!(
            balance_before - s.token.balance(&s.buyer),
            100_000,
            "fresh subscribe charges again"
        );
    }

    // ── B3: renew after expiry is a FRESH term anchored at now ──────────────

    #[test]
    fn test_renew_after_expiry_is_fresh_term() {
        let s = setup();
        let plan = make_plan(&s, 100_000, DAY, 10);
        s.client.subscribe(&s.buyer, &ds(&s.env, "ds-plan"), &plan);

        let first = s.client.get_pass(&s.buyer, &ds(&s.env, "ds-plan")).unwrap();
        // Well past expiry: a stale extension would put expiry in the past+1d.
        let late = first.expiry + 3_600;
        s.env.ledger().set_timestamp(late);

        s.client.renew(&s.buyer, &ds(&s.env, "ds-plan"));
        let second = s.client.get_pass(&s.buyer, &ds(&s.env, "ds-plan")).unwrap();
        assert_eq!(second.start, late, "fresh term starts at renew time");
        assert_eq!(second.expiry, late + DAY, "NOT old_expiry + period");
    }

    // ── B4: renew before expiry extends from expiry, no lost paid time ──────

    #[test]
    fn test_renew_before_expiry_extends() {
        let s = setup();
        let plan = make_plan(&s, 100_000, DAY, 10);
        s.client.subscribe(&s.buyer, &ds(&s.env, "ds-plan"), &plan);

        let first = s.client.get_pass(&s.buyer, &ds(&s.env, "ds-plan")).unwrap();
        s.env.ledger().set_timestamp(first.expiry - 100);
        s.client.renew(&s.buyer, &ds(&s.env, "ds-plan"));

        let second = s.client.get_pass(&s.buyer, &ds(&s.env, "ds-plan")).unwrap();
        assert_eq!(second.expiry, first.expiry + DAY);
        assert_eq!(second.start, first.expiry);
    }

    // ── B4b: renewing a revoked pass must not re-settle stale value ────────

    #[test]
    #[should_panic(expected = "Error(Contract, #13)")]
    fn test_renew_revoked_pass_panics() {
        let s = setup();
        let plan = make_plan(&s, 100_000, DAY, 10);
        s.client.subscribe(&s.buyer, &ds(&s.env, "ds-plan"), &plan);
        s.client.revoke(&s.seller, &s.buyer, &ds(&s.env, "ds-plan"));
        // Without the revoked guard this would transfer amount_paid out of
        // custody a second time, draining other buyers' funds.
        s.client.renew(&s.buyer, &ds(&s.env, "ds-plan"));
    }

    // ── B5/B6: seat accounting ──────────────────────────────────────────────

    #[test]
    #[should_panic(expected = "Error(Contract, #11)")]
    fn test_subscribe_fails_when_max_seats_reached() {
        let s = setup();
        let plan = make_plan(&s, 100_000, DAY, 2);
        let ds_key = ds(&s.env, "ds-plan");

        let alice = Address::generate(&s.env);
        let bob = Address::generate(&s.env);
        let carol = Address::generate(&s.env);
        StellarAssetClient::new(&s.env, &s.usdc).mint(&alice, &INITIAL_BUYER_BALANCE);
        StellarAssetClient::new(&s.env, &s.usdc).mint(&bob, &INITIAL_BUYER_BALANCE);
        StellarAssetClient::new(&s.env, &s.usdc).mint(&carol, &INITIAL_BUYER_BALANCE);

        s.client.subscribe(&alice, &ds_key, &plan);
        s.client.subscribe(&bob, &ds_key, &plan);
        assert_eq!(s.client.get_seats_used(&plan), 2);
        s.client.subscribe(&carol, &ds_key, &plan);
    }

    #[test]
    fn test_resubscribe_after_expiry_reuses_seat() {
        let s = setup();
        let plan = make_plan(&s, 100_000, DAY, 1); // single-seat plan
        let ds_key = ds(&s.env, "ds-plan");

        let alice = Address::generate(&s.env);
        let bob = Address::generate(&s.env);
        StellarAssetClient::new(&s.env, &s.usdc).mint(&alice, &INITIAL_BUYER_BALANCE);
        StellarAssetClient::new(&s.env, &s.usdc).mint(&bob, &INITIAL_BUYER_BALANCE);

        s.client.subscribe(&alice, &ds_key, &plan);
        assert_eq!(s.client.get_seats_used(&plan), 1);

        // Alice's pass expires; the seat is still hers until she moves on.
        let pass = s.client.get_pass(&alice, &ds_key).unwrap();
        s.env.ledger().set_timestamp(pass.expiry + 1);

        // Bob cannot take the seat (expired-but-held).
        let result = catch_unwind(AssertUnwindSafe(|| {
            s.client.subscribe(&bob, &ds_key, &plan);
        }));
        assert!(result.is_err(), "expired pass must keep holding the seat");
        assert_eq!(s.client.get_seats_used(&plan), 1);

        // Alice resubscribes into her own slot: no increment.
        s.client.subscribe(&alice, &ds_key, &plan);
        assert_eq!(s.client.get_seats_used(&plan), 1);
        assert!(s.client.has_access(&alice, &ds_key));
    }

    // ── B7: pro-rata refund arithmetic on revoke ────────────────────────────

    #[test]
    fn test_revoke_refunds_pro_rata_half_term() {
        let s = setup();
        let price: i128 = 1_000_000;
        let plan = make_plan(&s, price, DAY, 10);
        let ds_key = ds(&s.env, "ds-plan");

        let seller_before = s.token.balance(&s.seller);
        let admin_before = s.token.balance(&s.admin);
        s.client.subscribe(&s.buyer, &ds_key, &plan);

        // Revoke exactly halfway through the term.
        let pass = s.client.get_pass(&s.buyer, &ds_key).unwrap();
        s.env
            .ledger()
            .set_timestamp(pass.start + pass.term_period_seconds / 2);

        s.client.revoke(&s.seller, &s.buyer, &ds_key);

        let expected_refund = price / 2; // 500_000
        let expected_earned = price - expected_refund; // 500_000
        let expected_fee = expected_earned * 500 / 10_000; // 25_000 (default 500 bps)

        assert_eq!(
            s.token.balance(&s.buyer),
            INITIAL_BUYER_BALANCE - price + expected_refund
        );
        assert_eq!(
            s.token.balance(&s.seller) - seller_before,
            expected_earned - expected_fee
        );
        assert_eq!(s.token.balance(&s.admin) - admin_before, expected_fee);
        assert_eq!(
            s.token.balance(&s.client.address),
            0,
            "custody must be empty after revoke"
        );

        let revoked = s.client.get_pass(&s.buyer, &ds_key).unwrap();
        assert!(revoked.revoked);
        assert!(!s.client.has_access(&s.buyer, &ds_key));
        assert_eq!(s.client.get_seats_used(&plan), 0);
    }

    #[test]
    fn test_revoke_pro_rata_rounding_floor() {
        let s = setup();
        // Odd price + small custom fee forces floor rounding and the 1-stroop
        // fee floor in the same case.
        let price: i128 = 99_999;
        let plan = make_plan(&s, price, 1_000, 10);
        let ds_key = ds(&s.env, "ds-rounding");
        s.escrow.set_dataset_fee(&s.admin, &ds_key, &333);

        s.client.subscribe(&s.buyer, &ds_key, &plan);
        let pass = s.client.get_pass(&s.buyer, &ds_key).unwrap();

        // Elapse 999 of 1000 seconds: remaining = 1 → refund floors to 9.
        s.env
            .ledger()
            .set_timestamp(pass.start + pass.term_period_seconds - 1);
        s.client.revoke(&s.admin, &s.buyer, &ds_key);

        let remaining: i128 = 1;
        let expected_refund = price * remaining / 1_000; // 99
        let earned = price - expected_refund; // 99_900
        let expected_fee = earned * 333 / 10_000; // 3_326 (floor)
        let expected_seller = earned - expected_fee;

        // Seller and admin start at zero in setup, so their final balances
        // equal exactly what revoke paid out.
        assert_eq!(
            s.token.balance(&s.buyer),
            INITIAL_BUYER_BALANCE - price + expected_refund
        );
        assert_eq!(s.token.balance(&s.seller), expected_seller);
        assert_eq!(s.token.balance(&s.admin), expected_fee);
        assert_eq!(
            s.token.balance(&s.buyer)
                + s.token.balance(&s.seller)
                + s.token.balance(&s.admin)
                + s.token.balance(&s.client.address),
            INITIAL_BUYER_BALANCE,
            "total held by test actors plus custody must be conserved"
        );
    }

    // ── B8: revoking after natural expiry settles, refunds zero ─────────────

    #[test]
    fn test_revoke_after_expiry_settles_not_refunds() {
        let s = setup();
        let price: i128 = 400_000;
        let plan = make_plan(&s, price, DAY, 10);
        let ds_key = ds(&s.env, "ds-expired-revoke");

        let seller_before = s.token.balance(&s.seller);
        let admin_before = s.token.balance(&s.admin);
        let buyer_before = s.token.balance(&s.buyer);

        s.client.subscribe(&s.buyer, &ds_key, &plan);
        let pass = s.client.get_pass(&s.buyer, &ds_key).unwrap();
        s.env.ledger().set_timestamp(pass.expiry + 60);

        s.client.revoke(&s.seller, &s.buyer, &ds_key);

        let expected_fee = price * 500 / 10_000;
        assert_eq!(
            s.token.balance(&s.buyer),
            buyer_before - price,
            "zero refund"
        );
        assert_eq!(
            s.token.balance(&s.seller) - seller_before,
            price - expected_fee
        );
        assert_eq!(s.token.balance(&s.admin) - admin_before, expected_fee);
        assert_eq!(s.token.balance(&s.client.address), 0);
        assert_eq!(s.client.get_seats_used(&plan), 0);
    }

    // ── B9: TTL bump pair on writes and reads ───────────────────────────────

    #[test]
    fn test_ttl_bumped_on_write_and_read() {
        let s = setup();
        let plan = make_plan(&s, 100_000, DAY, 10);
        let ds_key = ds(&s.env, "ds-ttl");
        s.client.subscribe(&s.buyer, &ds_key, &plan);

        assert_eq!(
            pass_ttl(&s, &s.buyer, &ds_key),
            PASS_BUMP_LEDGERS,
            "subscribe must extend the pass entry to the bump constant"
        );

        // Age the entry below the bump threshold, then prove a READ bumps it
        // back (bump-on-read, matching escrow's get_escrow idiom).
        age_pass_entry_below_threshold(&s);
        assert_eq!(
            pass_ttl(&s, &s.buyer, &ds_key),
            PASS_MIN_TTL - 1,
            "precondition: entry aged just below the threshold"
        );

        assert!(s.client.has_access(&s.buyer, &ds_key));
        assert_eq!(
            pass_ttl(&s, &s.buyer, &ds_key),
            PASS_BUMP_LEDGERS,
            "has_access must re-bump an aged entry"
        );
    }

    #[test]
    fn test_ttl_bumped_on_renew() {
        let s = setup();
        let plan = make_plan(&s, 100_000, DAY, 10);
        let ds_key = ds(&s.env, "ds-ttl-renew");
        s.client.subscribe(&s.buyer, &ds_key, &plan);

        age_pass_entry_below_threshold(&s);

        s.client.renew(&s.buyer, &ds_key);
        assert_eq!(
            pass_ttl(&s, &s.buyer, &ds_key),
            PASS_BUMP_LEDGERS,
            "renew must bump the pass entry (bump-on-renew)"
        );
    }

    // ── B10: no pass without settled payment ────────────────────────────────

    #[test]
    fn formal_no_pass_without_settled_payment() {
        let s = setup();
        let price: i128 = 500_000;
        let plan = make_plan(&s, price, DAY, 10);
        let ds_key = ds(&s.env, "ds-unpaid");

        // Drain the buyer below the price so the transfer fails.
        let drain_to = Address::generate(&s.env);
        s.token
            .transfer(&s.buyer, &drain_to, &(INITIAL_BUYER_BALANCE - price + 1));

        let result = catch_unwind(AssertUnwindSafe(|| {
            s.client.subscribe(&s.buyer, &ds_key, &plan);
        }));
        assert!(result.is_err(), "insufficient funds must revert subscribe");

        // Nothing persisted: no pass, no seat, no custody.
        assert!(s.client.get_pass(&s.buyer, &ds_key).is_none());
        assert!(!s.client.has_access(&s.buyer, &ds_key));
        assert_eq!(s.client.get_seats_used(&plan), 0);
        assert_eq!(s.token.balance(&s.client.address), 0);
    }

    #[test]
    #[should_panic]
    fn test_subscribe_panics_when_transfer_fails() {
        let s = setup();
        let price: i128 = 500_000;
        let plan = make_plan(&s, price, DAY, 10);
        let drain_to = Address::generate(&s.env);
        s.token
            .transfer(&s.buyer, &drain_to, &(INITIAL_BUYER_BALANCE - price + 1));
        s.client
            .subscribe(&s.buyer, &ds(&s.env, "ds-unpaid"), &plan);
    }

    // ── B11: double subscribe mid-term ──────────────────────────────────────

    #[test]
    #[should_panic(expected = "Error(Contract, #12)")]
    fn test_double_subscribe_panics() {
        let s = setup();
        let plan = make_plan(&s, 100_000, DAY, 10);
        let ds_key = ds(&s.env, "ds-double");
        s.client.subscribe(&s.buyer, &ds_key, &plan);
        s.client.subscribe(&s.buyer, &ds_key, &plan);
    }

    // ── Settlement via settle_expired ────────────────────────────────────────

    #[test]
    fn test_settle_expired_pays_seller_permissionlessly() {
        let s = setup();
        let price: i128 = 400_000;
        let plan = make_plan(&s, price, DAY, 10);
        let ds_key = ds(&s.env, "ds-settle");

        let seller_before = s.token.balance(&s.seller);
        let admin_before = s.token.balance(&s.admin);

        s.client.subscribe(&s.buyer, &ds_key, &plan);
        let pass = s.client.get_pass(&s.buyer, &ds_key).unwrap();
        s.env.ledger().set_timestamp(pass.expiry + 1);

        // settle_expired has NO caller gate at all: anyone may trigger it.
        s.client.settle_expired(&s.buyer, &ds_key);

        let expected_fee = price * 500 / 10_000;
        assert_eq!(
            s.token.balance(&s.seller) - seller_before,
            price - expected_fee
        );
        assert_eq!(s.token.balance(&s.admin) - admin_before, expected_fee);
        assert_eq!(s.token.balance(&s.client.address), 0);

        // Record kept for history but settled; access gone either way.
        let settled = s.client.get_pass(&s.buyer, &ds_key).unwrap();
        assert_eq!(settled.amount_paid, 0);
        assert!(!s.client.has_access(&s.buyer, &ds_key));

        // Second settle attempt is rejected, not double-paid.
        let result = catch_unwind(AssertUnwindSafe(|| {
            s.client.settle_expired(&s.buyer, &ds_key);
        }));
        assert!(result.is_err(), "settling twice must fail");
        assert_eq!(
            s.token.balance(&s.seller) - seller_before,
            price - expected_fee
        );
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #16)")]
    fn test_settle_expired_fails_before_expiry() {
        let s = setup();
        let plan = make_plan(&s, 100_000, DAY, 10);
        let ds_key = ds(&s.env, "ds-settle-early");
        s.client.subscribe(&s.buyer, &ds_key, &plan);
        s.client.settle_expired(&s.buyer, &ds_key);
    }

    // ── Renewal settlement economics ─────────────────────────────────────────

    #[test]
    fn test_renew_settles_prior_term_then_charges_new() {
        let s = setup();
        let price: i128 = 300_000;
        let plan = make_plan(&s, price, DAY, 10);
        let ds_key = ds(&s.env, "ds-renew-econ");

        let seller_before = s.token.balance(&s.seller);
        let admin_before = s.token.balance(&s.admin);
        let buyer_before = s.token.balance(&s.buyer);

        s.client.subscribe(&s.buyer, &ds_key, &plan);
        s.client.renew(&s.buyer, &ds_key);

        let expected_fee = price * 500 / 10_000;
        // Prior term settled to seller/treasury, new term charged to buyer.
        assert_eq!(
            s.token.balance(&s.seller) - seller_before,
            price - expected_fee
        );
        assert_eq!(s.token.balance(&s.admin) - admin_before, expected_fee);
        assert_eq!(buyer_before - s.token.balance(&s.buyer), 2 * price);
        assert_eq!(
            s.token.balance(&s.client.address),
            price,
            "exactly the new term sits in custody"
        );
    }

    #[test]
    fn test_renew_uses_current_price_and_fee_snapshot() {
        let s = setup();
        let ds_key = ds(&s.env, "ds-reprice");
        let plan_v1 = make_plan(&s, 200_000, DAY, 10);
        s.client.subscribe(&s.buyer, &ds_key, &plan_v1);

        // Seller reprices via a NEW plan; the old pass keeps its snapshot…
        let pass_v1 = s.client.get_pass(&s.buyer, &ds_key).unwrap();
        assert_eq!(pass_v1.amount_paid, 200_000);
        assert_eq!(pass_v1.fee_bps, 500);

        // …and renewal re-charges at the SAME plan (v1), fresh fee lookup.
        s.escrow.set_dataset_fee(&s.admin, &ds_key, &900);
        s.env.ledger().set_timestamp(pass_v1.expiry - 10);
        s.client.renew(&s.buyer, &ds_key);

        let after = s.client.get_pass(&s.buyer, &ds_key).unwrap();
        assert_eq!(after.amount_paid, 200_000, "same plan, same price");
        assert_eq!(after.fee_bps, 900, "fee re-snapshotted at renew time");
    }

    #[test]
    fn test_renew_requires_active_plan_and_existing_pass() {
        let s = setup();
        let plan = make_plan(&s, 100_000, DAY, 10);
        let ds_key = ds(&s.env, "ds-renew-gates");

        // No pass yet.
        let result = catch_unwind(AssertUnwindSafe(|| {
            s.client.renew(&s.buyer, &ds_key);
        }));
        assert!(result.is_err());

        s.client.subscribe(&s.buyer, &ds_key, &plan);
        s.client.set_plan_active(&s.seller, &plan, &false);
        let result = catch_unwind(AssertUnwindSafe(|| {
            s.client.renew(&s.buyer, &ds_key);
        }));
        assert!(result.is_err());

        // Paid access survives deactivation within the term.
        assert!(s.client.has_access(&s.buyer, &ds_key));
    }

    // ── Authorization matrix ─────────────────────────────────────────────────

    #[test]
    #[should_panic(expected = "Error(Contract, #4)")]
    fn test_revoke_rejects_outsider() {
        let s = setup();
        let plan = make_plan(&s, 100_000, DAY, 10);
        let ds_key = ds(&s.env, "ds-auth");
        s.client.subscribe(&s.buyer, &ds_key, &plan);
        let impostor = Address::generate(&s.env);
        s.client.revoke(&impostor, &s.buyer, &ds_key);
    }

    #[test]
    fn test_revoke_by_admin_allowed() {
        let s = setup();
        let plan = make_plan(&s, 100_000, DAY, 10);
        let ds_key = ds(&s.env, "ds-admin-revoke");
        s.client.subscribe(&s.buyer, &ds_key, &plan);
        s.client.revoke(&s.admin, &s.buyer, &ds_key);
        assert!(s.client.get_pass(&s.buyer, &ds_key).unwrap().revoked);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #4)")]
    fn test_set_plan_active_rejects_outsider() {
        let s = setup();
        let plan = make_plan(&s, 100_000, DAY, 10);
        let impostor = Address::generate(&s.env);
        s.client.set_plan_active(&impostor, &plan, &false);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #3)")]
    fn test_set_treasury_requires_admin() {
        let s = setup();
        let impostor = Address::generate(&s.env);
        s.client.set_treasury(&impostor, &Address::generate(&s.env));
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #15)")]
    fn test_set_treasury_rejects_self_as_recipient() {
        let s = setup();
        s.client.set_treasury(&s.admin, &s.client.address);
    }

    #[test]
    fn test_treasury_unset_falls_back_to_admin() {
        let s = setup();
        let plan = make_plan(&s, 100_000, 1_000, 10);
        let ds_key = ds(&s.env, "ds-treasury-fallback");
        s.client.subscribe(&s.buyer, &ds_key, &plan);
        let pass = s.client.get_pass(&s.buyer, &ds_key).unwrap();
        s.env
            .ledger()
            .set_timestamp(pass.start + pass.term_period_seconds + 1);
        let admin_before = s.token.balance(&s.admin);
        s.client.revoke(&s.seller, &s.buyer, &ds_key);
        assert!(s.token.balance(&s.admin) > admin_before);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #1)")]
    fn test_initialize_twice_panics() {
        let s = setup();
        let escrow_id = s.escrow.address;
        s.client.initialize(&s.admin, &escrow_id, &s.usdc);
    }

    // ── Validation matrix ────────────────────────────────────────────────────

    #[test]
    #[should_panic(expected = "Error(Contract, #5)")]
    fn test_define_plan_rejects_empty_dataset_id() {
        let s = setup();
        s.client
            .define_plan(&s.seller, &ds(&s.env, ""), &100_000, &DAY, &10);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #6)")]
    fn test_define_plan_rejects_price_below_minimum() {
        let s = setup();
        s.client.define_plan(
            &s.seller,
            &ds(&s.env, "ds-low"),
            &(MIN_SUB_AMOUNT - 1),
            &DAY,
            &10,
        );
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #7)")]
    fn test_define_plan_rejects_zero_period() {
        let s = setup();
        s.client
            .define_plan(&s.seller, &ds(&s.env, "ds-period"), &100_000, &0, &10);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #7)")]
    fn test_define_plan_rejects_period_over_cap() {
        let s = setup();
        s.client.define_plan(
            &s.seller,
            &ds(&s.env, "ds-period-max"),
            &100_000,
            &(MAX_PERIOD_SECONDS + 1),
            &10,
        );
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #8)")]
    fn test_define_plan_rejects_zero_seats() {
        let s = setup();
        s.client
            .define_plan(&s.seller, &ds(&s.env, "ds-seats"), &100_000, &DAY, &0);
    }

    #[test]
    fn test_define_plan_accepts_boundary_values() {
        let s = setup();
        let plan = s.client.define_plan(
            &s.seller,
            &ds(&s.env, "ds-boundary"),
            &MIN_SUB_AMOUNT,
            &MAX_PERIOD_SECONDS,
            &MAX_SEATS_CAP,
        );
        let record = s.client.get_plan(&plan);
        assert_eq!(record.price_per_period, MIN_SUB_AMOUNT);
        assert_eq!(record.period_seconds, MAX_PERIOD_SECONDS);
        assert_eq!(record.max_seats, MAX_SEATS_CAP);
        assert!(record.active);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #9)")]
    fn test_subscribe_unknown_plan_panics() {
        let s = setup();
        s.client.subscribe(&s.buyer, &ds(&s.env, "ds-unknown"), &99);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #10)")]
    fn test_subscribe_inactive_plan_panics() {
        let s = setup();
        let plan = make_plan(&s, 100_000, DAY, 10);
        s.client.set_plan_active(&s.seller, &plan, &false);
        s.client
            .subscribe(&s.buyer, &ds(&s.env, "ds-inactive"), &plan);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #13)")]
    fn test_revoke_missing_pass_panics() {
        let s = setup();
        let _plan = make_plan(&s, 100_000, DAY, 10);
        s.client
            .revoke(&s.seller, &s.buyer, &ds(&s.env, "ds-missing"));
    }

    #[test]
    fn test_empty_dataset_id_reads_are_total() {
        // Read-only views never trap, not even on a malformed id: they return
        // their natural empty answer (mirrors get_pass returning Option).
        let s = setup();
        let empty = ds(&s.env, "");
        assert!(!s.client.has_access(&s.buyer, &empty));
        assert!(s.client.get_pass(&s.buyer, &empty).is_none());
    }

    // ── Fee model reuse (#551) ───────────────────────────────────────────────

    #[test]
    fn test_subscription_follows_escrow_default_fee_change() {
        let s = setup();
        let plan = make_plan(&s, 1_000_000, DAY, 10);
        let ds_key = ds(&s.env, "ds-fee-live");

        s.escrow.set_default_fee(&s.admin, &750);
        s.client.subscribe(&s.buyer, &ds_key, &plan);
        let pass = s.client.get_pass(&s.buyer, &ds_key).unwrap();
        assert_eq!(pass.fee_bps, 750, "snapshot must reflect live escrow state");
    }

    #[test]
    fn test_subscription_uses_escrow_per_dataset_override() {
        let s = setup();
        let plan = make_plan(&s, 100_000, DAY, 10);
        let ds_key = ds(&s.env, "ds-fee-override");
        s.escrow.set_dataset_fee(&s.admin, &ds_key, &1_234);
        s.client.subscribe(&s.buyer, &ds_key, &plan);
        assert_eq!(s.client.get_pass(&s.buyer, &ds_key).unwrap().fee_bps, 1_234);
    }

    // ── Events ───────────────────────────────────────────────────────────────

    #[test]
    fn test_lifecycle_emits_expected_topics() {
        let s = setup();
        let plan = make_plan(&s, 100_000, DAY, 10);
        let ds_key = ds(&s.env, "ds-events");

        s.client.subscribe(&s.buyer, &ds_key, &plan);
        assert_eq!(last_event_topic(&s), Symbol::new(&s.env, "subscribed"));

        s.client.renew(&s.buyer, &ds_key);
        assert_eq!(last_event_topic(&s), Symbol::new(&s.env, "renewed"));

        s.client.revoke(&s.seller, &s.buyer, &ds_key);
        assert_eq!(last_event_topic(&s), Symbol::new(&s.env, "revoked"));
    }

    #[test]
    fn test_initialize_and_plan_emit_events() {
        let s = setup();
        let plan = make_plan(&s, 100_000, DAY, 10);
        assert_eq!(last_event_topic(&s), Symbol::new(&s.env, "plan_new"));

        let treasury = Address::generate(&s.env);
        s.client.set_treasury(&s.admin, &treasury);
        assert_eq!(last_event_topic(&s), Symbol::new(&s.env, "trs_set"));
        assert_eq!(s.client.get_plan(&plan).plan_id, plan);
    }

    // ── formal_ invariant tests ──────────────────────────────────────────────

    #[test]
    fn formal_revoke_conserves_value() {
        // Sweep revoke timestamps across the whole term and several price/fee
        // combos; every split must conserve value to the stroop.
        let fractions: [u64; 6] = [0, DAY / 4, DAY / 2, (3 * DAY) / 4, DAY - 1, DAY + 3_600];
        let prices: [i128; 3] = [MIN_SUB_AMOUNT, 123_457, 4_000_000];
        for price in prices {
            for fraction in fractions {
                let s = setup();
                let plan = make_plan(&s, price, DAY, 10);
                let ds_key = ds(&s.env, "ds-conservation");

                let buyer_before = s.token.balance(&s.buyer);
                let seller_before = s.token.balance(&s.seller);
                let admin_before = s.token.balance(&s.admin);

                s.client.subscribe(&s.buyer, &ds_key, &plan);
                let pass = s.client.get_pass(&s.buyer, &ds_key).unwrap();
                s.env
                    .ledger()
                    .set_timestamp(pass.start + fraction.min(DAY + 3_600));
                s.client.revoke(&s.seller, &s.buyer, &ds_key);

                // Independent recomputation of the documented split.
                let elapsed = fraction.min(pass.expiry - pass.start);
                let remaining = pass.term_period_seconds - elapsed;
                let refund = price * remaining as i128 / pass.term_period_seconds as i128;
                let earned = price - refund;
                let raw_fee = earned * 500 / 10_000;
                let fee = if raw_fee == 0 && earned > 0 {
                    1
                } else {
                    raw_fee
                };

                assert_eq!(s.token.balance(&s.buyer), buyer_before - price + refund);
                assert_eq!(s.token.balance(&s.seller) - seller_before, earned - fee);
                assert_eq!(s.token.balance(&s.admin) - admin_before, fee);
                assert_eq!(
                    refund + (earned - fee) + fee,
                    price,
                    "split must conserve the full amount paid"
                );
                assert_eq!(s.token.balance(&s.client.address), 0);
            }
        }
    }

    #[test]
    fn formal_access_monotonic_within_term() {
        let s = setup();
        let plan = make_plan(&s, 100_000, DAY, 10);
        let ds_key = ds(&s.env, "ds-monotonic");
        s.client.subscribe(&s.buyer, &ds_key, &plan);
        let pass = s.client.get_pass(&s.buyer, &ds_key).unwrap();

        // Sample the term densely plus both boundaries; access must equal
        // `now < expiry` at every point and never flicker backwards. The last
        // sample lands exactly on `expiry` (predicate false).
        let steps = 8u64;
        for i in 0..=steps {
            let t = pass.start + (DAY * i / steps);
            s.env.ledger().set_timestamp(t);
            assert_eq!(
                s.client.has_access(&s.buyer, &ds_key),
                t < pass.expiry,
                "access at t={t} diverged from the predicate"
            );
        }
    }

    #[test]
    fn formal_seats_match_state() {
        let s = setup();
        let plan = make_plan(&s, 100_000, DAY, 3);
        let ds_key = ds(&s.env, "ds-seats-formal");

        let alice = Address::generate(&s.env);
        let bob = Address::generate(&s.env);
        StellarAssetClient::new(&s.env, &s.usdc).mint(&alice, &INITIAL_BUYER_BALANCE);
        StellarAssetClient::new(&s.env, &s.usdc).mint(&bob, &INITIAL_BUYER_BALANCE);

        s.client.subscribe(&s.buyer, &ds_key, &plan);
        s.client.subscribe(&alice, &ds_key, &plan);
        s.client.subscribe(&bob, &ds_key, &plan);
        assert_eq!(s.client.get_seats_used(&plan), 3);

        // Revoke frees a seat for a new subscriber.
        s.client.revoke(&s.seller, &alice, &ds_key);
        assert_eq!(s.client.get_seats_used(&plan), 2);
        let carol = Address::generate(&s.env);
        StellarAssetClient::new(&s.env, &s.usdc).mint(&carol, &INITIAL_BUYER_BALANCE);
        s.client.subscribe(&carol, &ds_key, &plan);
        assert_eq!(s.client.get_seats_used(&plan), 3);

        // Expired passes keep seats; holder reuse doesn't double-count.
        let bob_pass = s.client.get_pass(&bob, &ds_key).unwrap();
        s.env.ledger().set_timestamp(bob_pass.expiry + 1);
        s.client.subscribe(&bob, &ds_key, &plan);
        assert_eq!(
            s.client.get_seats_used(&plan),
            3,
            "slot reuse must not inflate the counter"
        );
    }
}
