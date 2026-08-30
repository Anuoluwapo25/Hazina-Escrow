use dotenvy::from_filename;
use serde_json::Value;
use std::env;
use std::process::Command;

fn setup_env() {
    from_filename(".env.test").ok();
}

fn get_env(key: &str) -> String {
    env::var(key).unwrap_or_else(|_| panic!("{} must be set in .env.test", key))
}

fn secret_to_address(secret: &str) -> String {
    let id_name = format!("temp_{}", &secret[secret.len() - 5..]);
    // Ignore error if it already exists
    let _ = Command::new("soroban")
        .args([
            "config",
            "identity",
            "add",
            &id_name,
            "--secret-key",
            secret,
        ])
        .output();

    let output = Command::new("soroban")
        .args(["config", "identity", "address", &id_name])
        .output()
        .expect("failed to get address from soroban cli");

    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn get_usdc_contract_id() -> String {
    let output = Command::new("soroban")
        .args([
            "lab",
            "token",
            "id",
            "--asset",
            "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
            "--network",
            "testnet",
        ])
        .output()
        .expect("failed to get usdc contract id");
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn soroban_invoke(source_secret: &str, func: &str, args: &[&str]) -> String {
    let contract_id = get_env("TEST_CONTRACT_ID");

    let mut cmd = Command::new("soroban");
    cmd.args([
        "contract",
        "invoke",
        "--id",
        &contract_id,
        "--source",
        source_secret,
        "--network",
        "testnet",
        "--",
        func,
    ]);
    for arg in args {
        cmd.arg(arg);
    }

    let output = cmd.output().expect("failed to execute soroban cli");
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        panic!("Invocation of {} failed: {}", func, stderr);
    }
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn get_usdc_balance(address: &str) -> f64 {
    let url = format!("https://horizon-testnet.stellar.org/accounts/{}", address);
    let output = Command::new("curl")
        .args(["-s", &url])
        .output()
        .expect("failed to execute curl");

    let json: Value = serde_json::from_slice(&output.stdout).unwrap_or_default();
    let balances = json["balances"].as_array();

    if let Some(balances) = balances {
        for balance in balances {
            if balance["asset_code"] == "USDC"
                && balance["asset_issuer"]
                    == "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
            {
                return balance["balance"]
                    .as_str()
                    .unwrap_or("0")
                    .parse()
                    .unwrap_or(0.0);
            }
        }
    }
    0.0
}

#[test]
fn integration_lock_and_release() {
    setup_env();
    let buyer_secret = get_env("TEST_BUYER_SECRET");
    let admin_secret = get_env("TEST_ADMIN_SECRET");
    let seller_address = get_env("TEST_SELLER_ADDRESS");

    let buyer_address = secret_to_address(&buyer_secret);
    let admin_address = secret_to_address(&admin_secret);
    let usdc_contract_id = get_usdc_contract_id();

    let initial_seller_balance = get_usdc_balance(&seller_address);
    let initial_admin_balance = get_usdc_balance(&admin_address);

    println!(
        "Initial balances: Seller={}, Admin={}",
        initial_seller_balance, initial_admin_balance
    );

    // Lock 0.01 USDC (100,000 stroops for 7 decimals)
    // Amount is passed as a string to the CLI
    let escrow_id_str = soroban_invoke(
        &buyer_secret,
        "lock",
        &[
            "--buyer",
            &buyer_address,
            "--seller",
            &seller_address,
            "--token",
            &usdc_contract_id,
            "--amount",
            "100000",
            "--dataset_id",
            "ds-integration-test",
        ],
    );
    let escrow_id = escrow_id_str
        .parse::<u64>()
        .expect("failed to parse escrow_id");
    println!("Locked escrow_id: {}", escrow_id);

    // Release
    soroban_invoke(
        &admin_secret,
        "release",
        &[
            "--admin",
            &admin_address,
            "--escrow_id",
            &escrow_id.to_string(),
        ],
    );
    println!("Released escrow_id: {}", escrow_id);

    // Verify balances (Wait a bit for indexer)
    std::thread::sleep(std::time::Duration::from_secs(5));

    let final_seller_balance = get_usdc_balance(&seller_address);
    let final_admin_balance = get_usdc_balance(&admin_address);

    println!(
        "Final balances: Seller={}, Admin={}",
        final_seller_balance, final_admin_balance
    );

    // 0.01 USDC split: 95% to seller (0.0095), 5% to admin (0.0005)
    assert!(final_seller_balance > initial_seller_balance);
    assert!(final_admin_balance > initial_admin_balance);
}

#[test]
fn integration_refund() {
    setup_env();
    let buyer_secret = get_env("TEST_BUYER_SECRET");
    let admin_secret = get_env("TEST_ADMIN_SECRET");
    let seller_address = get_env("TEST_SELLER_ADDRESS");

    let buyer_address = secret_to_address(&buyer_secret);
    let admin_address = secret_to_address(&admin_secret);
    let usdc_contract_id = get_usdc_contract_id();

    let initial_buyer_balance = get_usdc_balance(&buyer_address);

    // Lock 0.01 USDC
    let escrow_id_str = soroban_invoke(
        &buyer_secret,
        "lock",
        &[
            "--buyer",
            &buyer_address,
            "--seller",
            &seller_address,
            "--token",
            &usdc_contract_id,
            "--amount",
            "100000",
            "--dataset_id",
            "ds-refund-test",
        ],
    );
    let escrow_id = escrow_id_str
        .parse::<u64>()
        .expect("failed to parse escrow_id");

    // Refund
    soroban_invoke(
        &admin_secret,
        "refund",
        &[
            "--admin",
            &admin_address,
            "--escrow_id",
            &escrow_id.to_string(),
        ],
    );

    std::thread::sleep(std::time::Duration::from_secs(5));
    let final_buyer_balance = get_usdc_balance(&buyer_address);

    // Buyer should have their 0.01 USDC back (minus transaction fees, but token balance shouldn't change for fees)
    assert!(final_buyer_balance >= initial_buyer_balance - 0.00001);
}

#[test]
fn integration_double_release_fails() {
    setup_env();
    let buyer_secret = get_env("TEST_BUYER_SECRET");
    let admin_secret = get_env("TEST_ADMIN_SECRET");
    let seller_address = get_env("TEST_SELLER_ADDRESS");

    let buyer_address = secret_to_address(&buyer_secret);
    let admin_address = secret_to_address(&admin_secret);
    let usdc_contract_id = get_usdc_contract_id();

    // Lock
    let escrow_id_str = soroban_invoke(
        &buyer_secret,
        "lock",
        &[
            "--buyer",
            &buyer_address,
            "--seller",
            &seller_address,
            "--token",
            &usdc_contract_id,
            "--amount",
            "100000",
            "--dataset_id",
            "ds-double-release-test",
        ],
    );
    let escrow_id = escrow_id_str
        .parse::<u64>()
        .expect("failed to parse escrow_id");

    // First release
    soroban_invoke(
        &admin_secret,
        "release",
        &[
            "--admin",
            &admin_address,
            "--escrow_id",
            &escrow_id.to_string(),
        ],
    );

    // Second release should fail
    let contract_id = get_env("TEST_CONTRACT_ID");
    let mut cmd = Command::new("soroban");
    cmd.args([
        "contract",
        "invoke",
        "--id",
        &contract_id,
        "--source",
        &admin_secret,
        "--network",
        "testnet",
        "--",
        "release",
        "--admin",
        &admin_address,
        "--escrow_id",
        &escrow_id.to_string(),
    ]);

    let output = cmd.output().expect("failed to execute soroban cli");
    assert!(
        !output.status.success(),
        "Second release should have failed"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("AlreadyReleased") || stderr.contains("Error(Contract, #6)"),
        "Error should indicate AlreadyReleased"
    );
}
