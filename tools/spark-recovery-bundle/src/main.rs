use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{self, Write},
    path::PathBuf,
    process::Command,
    sync::Arc,
};

use anyhow::{Context, Result, anyhow};
use bip39::Mnemonic;
use chrono::{SecondsFormat, Utc};
use clap::Parser;
use prost::Message;
use serde::Serialize;
use spark::{
    Identifier, Network,
    operator::{
        OperatorConfig, OperatorPool, OperatorPoolConfig,
        rpc::{
            DefaultConnectionManager,
            spark::{QueryNodesRequest, TreeNode, query_nodes_request::Source},
        },
    },
    session_store::InMemorySessionStore,
};
use spark_wallet::{
    DefaultSigner, SparkSigner, SparkSignerAdapter, SparkWalletConfig, TreeNodeId,
    account_master_key,
};

const BUNDLE_SCHEMA: &str = "spark.unilateral-exit-bundle.v1";
const DEFAULT_OPERATOR_SET: &str = "breez-sdk";
const AVAILABLE_STATUS: i32 = 1;

#[derive(Debug, Parser)]
#[command(name = "spark-recovery-bundle")]
#[command(about = "Export a Spark unilateral-exit recovery bundle")]
struct Args {
    /// File containing a BIP-39 mnemonic or 64-byte hex seed.
    #[arg(long)]
    seed_file: Option<PathBuf>,

    /// BIP-39 mnemonic or 64-byte hex seed. Prefer --seed-file or the hidden prompt.
    #[arg(long)]
    seed: Option<String>,

    /// Optional BIP-39 passphrase.
    #[arg(long, default_value = "")]
    passphrase: String,

    /// Optional Spark account number. Defaults to the vendored SDK default for the network.
    #[arg(long)]
    account_number: Option<u32>,

    /// Spark network: mainnet, regtest, testnet, or signet.
    #[arg(long, default_value = "mainnet")]
    network: String,

    /// Output JSON path. Prints to stdout when omitted.
    #[arg(long)]
    out: Option<PathBuf>,

    /// Optional operator-set label stored in the bundle.
    #[arg(long, default_value = DEFAULT_OPERATOR_SET)]
    operator_set: String,

    /// Optional app version label stored in the bundle.
    #[arg(long, default_value = "unknown")]
    app_version: String,

    /// Query page size for operator pagination.
    #[arg(long, default_value_t = 100)]
    page_size: i64,

    /// Operator override as id=<n>,identifier=<hex>,address=<url>,identity-public-key=<hex>[,ca-cert=<path>].
    #[arg(long = "operator")]
    operators: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RecoveryBundle {
    schema: &'static str,
    created_at: String,
    network: String,
    operator_set: String,
    wallet_identity_public_key: String,
    spark_sdk_version: String,
    app_version: String,
    leaves: Vec<BundleLeaf>,
    nodes: Vec<BundleNode>,
    balances: BundleBalances,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BundleLeaf {
    id: String,
    status: String,
    value_sats: u64,
    tree_node_hex: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BundleNode {
    id: String,
    tree_node_hex: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BundleBalances {
    btc_sats: String,
    usdb: BundleUsdbBalance,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BundleUsdbBalance {
    amount: String,
    status: String,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let network = parse_network(&args.network)?;
    let seed_input = load_seed_input(&args)?;
    let seed = parse_seed(&seed_input, &args.passphrase)?;

    let account_master = account_master_key(&seed, network, args.account_number)
        .context("failed to derive Spark account key")?;
    let signer = DefaultSigner::from_master(account_master);
    let spark_signer: Arc<dyn SparkSigner> = Arc::new(SparkSignerAdapter::new(Arc::new(signer)));
    let identity_public_key = spark_signer
        .get_identity_public_key()
        .await
        .context("failed to derive identity public key")?;
    let identity_public_key_bytes = identity_public_key.serialize().to_vec();

    let mut config = SparkWalletConfig::default_config(network);
    if !args.operators.is_empty() {
        config.operator_pool = parse_operator_pool(&args.operators)?;
    }
    let operator_pool = OperatorPool::connect(
        &config.operator_pool,
        Arc::new(DefaultConnectionManager::new()),
        Arc::new(InMemorySessionStore::default()),
        Arc::clone(&spark_signer),
        None,
    )
    .await
    .context("failed to connect to Spark operators")?;

    let nodes = query_available_nodes_with_parents(
        operator_pool.get_coordinator().client.clone(),
        network,
        identity_public_key_bytes.as_slice(),
        args.page_size,
    )
    .await?;

    let mut leaf_ids = BTreeSet::new();
    let mut leaves = Vec::new();
    for node in nodes.values() {
        if !is_available_owner_leaf(node, identity_public_key_bytes.as_slice()) {
            continue;
        }
        leaf_ids.insert(node.id.clone());
        leaves.push(BundleLeaf {
            id: node.id.clone(),
            status: node_status(node),
            value_sats: node.value,
            tree_node_hex: encode_tree_node_hex(node)?,
        });
    }

    if leaves.is_empty() {
        let mut status_counts = BTreeMap::<String, usize>::new();
        for node in nodes.values() {
            *status_counts.entry(node_status(node)).or_default() += 1;
        }
        return Err(anyhow!(
            "Spark wallet has no available leaves to export for offline recovery (identity={}, queried_nodes={}, statuses={:?})",
            identity_public_key,
            nodes.len(),
            status_counts,
        ));
    }

    let nodes = nodes
        .values()
        .map(|node| {
            Ok(BundleNode {
                id: node.id.clone(),
                tree_node_hex: encode_tree_node_hex(node)?,
            })
        })
        .collect::<Result<Vec<_>>>()?;

    let btc_sats = leaves
        .iter()
        .map(|leaf| leaf.value_sats)
        .sum::<u64>()
        .to_string();

    let bundle = RecoveryBundle {
        schema: BUNDLE_SCHEMA,
        created_at: Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true),
        network: network_label(network).to_string(),
        operator_set: args.operator_set,
        wallet_identity_public_key: identity_public_key.to_string(),
        spark_sdk_version: "breez-sdk-path".to_string(),
        app_version: args.app_version,
        leaves,
        nodes,
        balances: BundleBalances {
            btc_sats,
            usdb: BundleUsdbBalance {
                amount: "unknown".to_string(),
                status: "not-covered-by-bitcoin-unilateral-exit".to_string(),
            },
        },
    };

    let leaf_count = leaf_ids.len();
    let node_count = bundle.nodes.len();
    let output = format!("{}\n", serde_json::to_string_pretty(&bundle)?);
    if let Some(out) = args.out {
        fs::write(&out, output).with_context(|| format!("failed to write {}", out.display()))?;
    } else {
        print!("{output}");
    }

    eprintln!("Exported {leaf_count} leaf node(s) and {node_count} total node(s)");
    Ok(())
}

async fn query_available_nodes_with_parents(
    client: spark::operator::rpc::SparkRpcClient,
    network: Network,
    identity_public_key: &[u8],
    page_size: i64,
) -> Result<BTreeMap<String, TreeNode>> {
    if page_size <= 0 {
        return Err(anyhow!("--page-size must be positive"));
    }

    let mut all_nodes = BTreeMap::new();
    let mut offset = 0_i64;
    loop {
        let response = client
            .query_nodes(QueryNodesRequest {
                source: Some(Source::OwnerIdentityPubkey(identity_public_key.to_vec())),
                include_parents: true,
                limit: page_size,
                offset,
                network: proto_network(network),
                statuses: vec![],
            })
            .await
            .context("query_nodes failed")?;

        let count = response.nodes.len();
        for (id, node) in response.nodes {
            all_nodes.insert(id, node);
        }

        if count == 0 || response.offset <= 0 {
            break;
        }
        offset += page_size;
    }

    Ok(all_nodes)
}

fn load_seed_input(args: &Args) -> Result<String> {
    if let Some(seed_file) = &args.seed_file {
        return fs::read_to_string(seed_file)
            .map(|s| s.trim().to_string())
            .with_context(|| format!("failed to read {}", seed_file.display()));
    }
    if let Some(seed) = &args.seed {
        return Ok(seed.trim().to_string());
    }

    eprint!("Spark seed or mnemonic: ");
    io::stderr().flush()?;
    let _guard = TerminalEchoGuard::disable();
    let mut input = String::new();
    io::stdin().read_line(&mut input)?;
    eprintln!();
    let input = input.trim().to_string();
    if input.is_empty() {
        return Err(anyhow!("Spark seed or mnemonic is required"));
    }
    Ok(input)
}

fn parse_seed(input: &str, passphrase: &str) -> Result<Vec<u8>> {
    if let Ok(mnemonic) = input.parse::<Mnemonic>() {
        return Ok(mnemonic.to_seed(passphrase).to_vec());
    }

    let compact = input.trim().strip_prefix("0x").unwrap_or(input.trim());
    let seed = hex::decode(compact).context("seed must be a BIP-39 mnemonic or hex seed")?;
    if seed.len() != 64 {
        return Err(anyhow!(
            "hex seed must be 64 bytes after decoding, got {} bytes",
            seed.len()
        ));
    }
    Ok(seed)
}

fn parse_network(value: &str) -> Result<Network> {
    match value.to_ascii_lowercase().as_str() {
        "mainnet" => Ok(Network::Mainnet),
        "regtest" => Ok(Network::Regtest),
        "testnet" => Ok(Network::Testnet),
        "signet" => Ok(Network::Signet),
        _ => Err(anyhow!("unsupported network: {value}")),
    }
}

fn parse_operator_pool(values: &[String]) -> Result<OperatorPoolConfig> {
    let mut operators = Vec::with_capacity(values.len());
    for value in values {
        operators.push(parse_operator(value)?);
    }
    operators.sort_by_key(|operator| operator.id);
    OperatorPoolConfig::new(0, operators).context("invalid operator set")
}

fn parse_operator(value: &str) -> Result<OperatorConfig> {
    let mut id = None;
    let mut identifier = None;
    let mut address = None;
    let mut identity_public_key = None;
    let mut ca_cert = None;

    for part in value.split(',') {
        let (key, raw_value) = part
            .split_once('=')
            .ok_or_else(|| anyhow!("invalid --operator entry: {part}"))?;
        let raw_value = raw_value.trim();
        match key.trim() {
            "id" => id = Some(raw_value.parse::<usize>().context("invalid operator id")?),
            "identifier" => {
                identifier = Some(
                    Identifier::deserialize(
                        &hex::decode(raw_value).context("invalid operator identifier hex")?,
                    )
                    .map_err(|_| anyhow!("invalid operator identifier"))?,
                );
            }
            "address" => address = Some(raw_value.to_string()),
            "identity-public-key" => {
                identity_public_key = Some(
                    raw_value
                        .parse()
                        .context("invalid operator identity public key")?,
                );
            }
            "ca-cert" => {
                ca_cert = Some(
                    fs::read(raw_value)
                        .with_context(|| format!("failed to read operator CA cert {raw_value}"))?,
                );
            }
            other => return Err(anyhow!("unknown --operator field: {other}")),
        }
    }

    Ok(OperatorConfig {
        id: id.ok_or_else(|| anyhow!("operator id is required"))?,
        identifier: identifier.ok_or_else(|| anyhow!("operator identifier is required"))?,
        address: address
            .ok_or_else(|| anyhow!("operator address is required"))?
            .parse()
            .context("invalid operator address")?,
        ca_cert,
        identity_public_key: identity_public_key
            .ok_or_else(|| anyhow!("operator identity-public-key is required"))?,
        user_agent: None,
    })
}

fn network_label(network: Network) -> &'static str {
    match network {
        Network::Mainnet => "MAINNET",
        Network::Regtest => "REGTEST",
        Network::Testnet => "TESTNET",
        Network::Signet => "SIGNET",
    }
}

fn proto_network(network: Network) -> i32 {
    match network {
        Network::Mainnet => 1,
        Network::Regtest => 2,
        Network::Testnet => 3,
        Network::Signet => 4,
    }
}

fn is_available_owner_leaf(node: &TreeNode, identity_public_key: &[u8]) -> bool {
    (node.treenode_status == AVAILABLE_STATUS || node.status.eq_ignore_ascii_case("AVAILABLE"))
        && node.owner_identity_public_key == identity_public_key
        && node.id.parse::<TreeNodeId>().is_ok()
}

fn node_status(node: &TreeNode) -> String {
    if !node.status.is_empty() {
        return node.status.clone();
    }
    if node.treenode_status == AVAILABLE_STATUS {
        return "AVAILABLE".to_string();
    }
    format!("UNKNOWN_{}", node.treenode_status)
}

fn encode_tree_node_hex(node: &TreeNode) -> Result<String> {
    let mut bytes = Vec::new();
    node.encode(&mut bytes)
        .with_context(|| format!("failed to encode TreeNode {}", node.id))?;
    Ok(hex::encode(bytes))
}

struct TerminalEchoGuard {
    restore: bool,
}

impl TerminalEchoGuard {
    fn disable() -> Self {
        let restore = Command::new("stty")
            .arg("-echo")
            .status()
            .is_ok_and(|s| s.success());
        Self { restore }
    }
}

impl Drop for TerminalEchoGuard {
    fn drop(&mut self) {
        if self.restore {
            let _ = Command::new("stty").arg("echo").status();
        }
    }
}
