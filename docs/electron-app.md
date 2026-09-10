# Spark recovery bundle backup and unilateral exit

The Electron app keeps a Spark recovery bundle in an encrypted local vault and can import an exported recovery bundle to exit a selected Bitcoin output without Spark operators. Each seed profile selects Bitcoin mainnet or local regtest. Mainnet defaults to the public mempool.space explorer; using your own Bitcoin node is optional. USDB unilateral exit is not supported. The app is unaudited; the chain-backed tests use disposable regtest funds.

## Run the application

Use Node 22.22.2 or newer in the Node 22 series (or Node 24.15+), then:

```sh
npm ci
npm run desktop:start
```

The app runs from source, without signed installers or automatic updates. The UI and main process build into `dist-desktop/`. Electron supports macOS, Windows and Linux; platform CI runs the same desktop suite and actual-window smoke test.

Create a vault using the wallet's recovery words (BIP-39 mnemonic) or its 64-byte hex seed. New profiles without an imported bundle use account 1, without an account selector or extra seed-passphrase field. Creating from a bundle matches its identity against account 1 and Blink account 0 on the selected network before saving. Existing vaults retain their stored account. Choose a separate vault password of at least 12 characters, or click **Generate password** for a cryptographically random 32-character password. **Show password** lets you save it in your password manager before creating the vault. This password encrypts the local vault and does not change the wallet derived from the seed.

The **Bundle backup** and **Unilateral exit** tabs keep each step within the desktop window. A saved unilateral exit opens directly in the progress view; setup controls remain available in the Bundle backup tab. For regtest, under **Connection settings**, paste the PEM certificate from the local operator and save the Spark connection. Mainnet uses the default public Spark coordinator with normal HTTPS certificate verification. **Refresh now** captures leaves and their ancestors. A timestamp is only the age of the recovery bundle: changes between polls, while disconnected, or while locked can be missing.

### Multiple seeds and mainnet connection

Use **Seed profiles** to add a seed or import its saved recovery bundle. Give each profile a name and choose its network. The toolbar selects a profile; its bundle, Spark connection, fee address, signed exit and completed history stay separate. A seed can have one profile per network, up to 50 profiles total within the 32 MiB encrypted vault limit. An oversized update is rejected before replacing the saved vault. Network and account cannot be changed after profile creation. One vault password encrypts and unlocks every profile. Existing single-seed vaults migrate atomically when unlocked; the prior ciphertext remains in `.previous`.

Under **Connection settings**, **Bitcoin connection · all mainnet seeds** defaults to **Public explorer · mempool.space**. **Own Bitcoin node** switches all mainnet profiles to a loopback Bitcoin Core RPC endpoint, including one forwarded through a local tunnel. Save its URL, RPC username and password once. The RPC password is encrypted in the vault and never returned to the renderer. Leaving it blank retains the saved password; switching to the public explorer removes the saved RPC configuration. Regtest always uses the isolated test node.

The shared Bitcoin connection can be changed while an exit is waiting, allowing a failed explorer to be replaced by your node; saved signed transactions are retained. Own-node errors do not silently fall back to the public explorer. The node needs `scantxoutset`, historical transaction lookup (typically `txindex=1`) and `submitpackage` support. The regtest stack uses Bitcoin Core 29.

The public explorer sees requested addresses and transactions and is trusted for chain status, UTXO availability and confirmations. The app checks the reported mainnet genesis hash and verifies each fee output against its raw parent transaction before using it. These checks do not turn an explorer into a locally validating node. The pinned Spark SDK also queries mempool.space during mainnet package construction, even when your own node is selected; the own-node option does not currently eliminate every public chain query. Bundle refresh connects to the Spark coordinator and does not need the Bitcoin explorer or node.

Explorer integration follows the [mempool REST API](https://mempool.space/docs/api/rest) for UTXOs, status and raw transactions, and its [package submission implementation](https://github.com/mempool/mempool/blob/master/backend/src/api/bitcoin/bitcoin.routes.ts) at `/api/v1/txs/package`. Mainnet tests use mocked responses; no live mainnet exit or funds were used for validation.

### Background refresh over days

Automatic refresh runs every minute while unlocked by default. For hourly refresh across screen locks:

1. Unlock the vault, configure each profile's Spark coordinator and click **Refresh now** to verify connectivity and save a current recovery bundle.
2. Expand **Automatic refresh**. Select **Keep unlocked until I lock or quit**, then **Refresh all profiles hourly while unlocked**. The toolbar shows **Kept unlocked**. This keeps all seeds and the vault encryption key available to the main process, including when the screen locks.
3. Minimize the window and leave the app running. Successful refreshes atomically update the encrypted local vault, not previously exported files. The coordinator must be reachable. Failed refreshes retain the previous recovery bundle and retry on the next hourly interval; **Refresh now** retries immediately.
4. Standby pauses work. On resume, the app checks immediately and refreshes if due, without a password while this mode remains active. Missed hours result in one refresh, not a burst of requests. If the OS closes the app, reboots, or logs you out, unlock again and re-enable both options.

Hourly polling can miss up to an hour of wallet changes, and longer during sleep or connectivity failures. To avoid sleep gaps, configure the computer to stay awake; the app does not prevent standby. **Lock vault** always stops background work, after any in-flight operation finishes. Turning off keep-unlocked mode restores screen locking and starts a fresh 15-minute unlock window. Both preferences reset on locking or restart. Refresh pauses only for profiles with a unilateral exit session. Other profiles continue to refresh. Each profile has its own hourly timer; a failure does not stop the remaining profiles. Approved exits also progress in the background for every profile, regardless of which is selected.

Use **Export encrypted recovery bundle** to save a portable recovery bundle with a separate recovery bundle password. The seed is never included in a bundle export: keep the seed separately.

### Import an existing Blink or CLI bundle

On a fresh installation, enter the matching seed and network and choose a new vault password, then click **Create vault and import bundle**. This action stays disabled until a seed and a valid new vault password are entered. Select the JSON file using the native file picker. The app validates the bundle and its account identity before creating the encrypted vault, then opens **Unilateral exit**. This works without Spark operators.

In an existing vault, open **Bundle backup** and click **Import recovery bundle**. Imports must match the selected profile's seed, network and stored account. Importing never changes an existing profile's account, and is blocked during an active unilateral exit session.

Supported formats:

| File | Required secret |
| --- | --- |
| Blink **Export file / Copy JSON** or CLI `spark.unilateral-exit-bundle.v1` | Matching seed; no file password |
| Blink device/cloud `blink.recovery-bundle-backup.v1` | Matching seed decrypts the AES-128-GCM envelope |
| This app's encrypted export | Matching seed and the recovery bundle password |

For a password-encrypted desktop file during setup, expand **Does your file need a password?** and enter its recovery bundle password. In an existing vault, use **Recovery bundle password**. This is separate from the new vault password. The app opens saved files locally; it does not connect to Blink cloud storage.

MAINNET bundles require a mainnet profile; LOCAL/REGTEST bundles require a regtest profile. Imported timestamps do not establish freshness. Blink format compatibility is based on `blink-mobile` recovery-backup sources at `476b4ea939bce3437e5a8df06fe462dcfe2ea498`; this does not assert those features are in every released Blink version.

## Unilateral exit

1. Import a saved bundle or use the existing recovery bundle. Open the **Unilateral exit** tab, select one output and enter a `bc1` mainnet destination or `bcrt1` regtest destination.
2. Estimate fee funding, send Bitcoin on the profile's network to the displayed funding address, and wait for confirmation. On regtest, mine a confirmation.
3. Prepare the unilateral exit, inspect its destination and exact fees, and confirm the native dialog. Fees are capped at 100,000 sats and must be below the selected output's value.
4. Keep the vault unlocked while it submits packages and waits for confirmations and relative timelocks. On regtest, mine blocks to advance the chain. **Check chain / resume** checks progress immediately.
5. After restart, unlock the same vault to resume the saved signed transactions. Completion requires a confirmed destination sweep. **Exit another output** archives the completed session and allows another leaf to be selected.

The app freezes the selected profile's recovery bundle during a unilateral exit session. Do not spend, swap or otherwise change that Spark wallet while exiting. The app does not coordinate competing wallets or automatically choose an alternative exit path after conflicting on-chain spends. A running approved session cannot be discarded through the UI. Cancel a review before approval if its inputs are wrong.

## Storage and security boundary

- The main process owns key derivation, decryption, operator access, signing and Bitcoin node/explorer access. The renderer is sandboxed with Node disabled, context isolation, denied permissions/navigation, a fixed IPC interface, local bundled assets and a restrictive content security policy. Seed entry passes through the renderer once and its fields are cleared after submission.
- The vault uses scrypt and AES-256-GCM with fresh randomness. Files are written with restrictive permissions, synced and atomically renamed; the prior ciphertext is retained as `.previous`. POSIX also syncs the parent directory. Windows power-loss durability needs platform validation beyond process-restart tests.
- The seed remains accessible to the main process while unlocked. Locking drops references and clears the encryption key buffer; JavaScript does not guarantee erasure of seed strings or all copies in memory. The app uses a password vault, not OS keychain storage or hardware signing. It does not protect against a compromised OS, malicious application code or a compromised renderer capturing seed entry or invoking permitted actions.
- By default, lock occurs after a 15-minute unlock window, on an OS lock-screen event, or on request. Explicit keep-unlocked mode bypasses the time and screen-lock triggers until you lock or quit. If an operation is in progress, manual locking completes when it finishes; no new background operation starts in between. Closing the app stops polling and broadcasting.
- Retaining an identity authentication key for locked background refresh is not implemented. That key also authorizes Spark token transfers; it must not be described as watch-only.
- Regtest coordinator HTTPS is restricted to loopback with explicit certificate trust. Regtest Bitcoin RPC is fixed to `127.0.0.1:8332`, using the upstream fixture credentials `testutil` / `testutilpassword`. Mainnet coordinators require HTTPS. The Bitcoin connection verifies its network before preparation and broadcasting. No telemetry or remote web UI is included.

The vault is `vault.json` under Electron's application-data directory in the folder `blink-spark-backup` (`~/Library/Application Support` on macOS, `%APPDATA%` on Windows, the platform config directory on Linux). The test harness uses a temporary directory instead. Preserve the encrypted vault as well as exported bundles: only the vault retains approved signed recovery transactions and completed-session history. An exported bundle alone is not a checkpoint of an in-flight recovery. Never overwrite the only vault copy when investigating a failed write; `.previous` is a fallback, not a guaranteed record of the latest approval.

## Tests

```sh
npm run desktop:typecheck
npm run desktop:test
npm run desktop:test:ui
```

The desktop test command requires 100% statements, branches, functions and lines **per file** across the executable desktop TypeScript and the shared transaction-ID helper, including renderer, preload, main process, vault, validation, service, chain adapter and engine. There are no desktop application-code coverage exclusions. Declarative test configuration and the test harness itself are outside that denominator. Coverage reports are in `coverage/desktop/`. Existing reused CLI/SDK code has separate tests and is not represented as having 100% coverage by this desktop threshold.

Actual Electron import tests create and reopen vaults from plaintext Blink/CLI JSON, Blink seed-encrypted backups and desktop password-encrypted exports, including Blink regtest account 0. Crypto tests use an independently constructed WebCrypto envelope and reject wrong seeds, corrupt ciphertext and mismatched metadata.

The actual Electron smoke test exercises seed entry with a public test mnemonic, generated-password creation and restart unlock, encrypted persistence, import/export, failed unlock, keep-unlocked controls and renderer isolation. File pickers and approval clicks are stubbed at Electron's native-dialog boundary; application IPC and storage execute normally. Screen-lock and resume events are emitted in the actual Electron main process. A real Electron regtest test deposits into two independent seeds, refreshes both in the background and reopens both bundles with one password. UI tests also cover three profiles across both networks, a shared node setting and wrong-seed imports, without making public mainnet calls. Unit tests advance a simulated clock across three days, sleep gaps and offline retries. Physical multi-day uptime and OS sleep/wake cycles, native dialog appearance, assistive technology, code signing, OS key stores and physical power loss are not certified by these tests.

Layout tests check page overflow and primary-action visibility at 1100x850 and 760x650, including long recovery addresses. The UI follows the sibling `blink-brand` design system; asset provenance and licensing are in [desktop/assets/README.md](../desktop/assets/README.md).

For the complete chain-backed UX test, have Docker available and an upstream Spark checkout next to this repo (or set `SPARK_LOCAL_DIR`):

```sh
bash scripts/desktop-regtest.sh up
bash scripts/desktop-regtest.sh test
bash scripts/desktop-regtest.sh stop
```

These commands retain the Compose project identifier `spark-desktop-pilot` for compatibility with existing test volumes. They never remove volumes. The stack needs the upstream loopback service ports, including 8332 and 8535-8537; PostgreSQL's host port is disabled to avoid conflicts. The test creates a disposable Spark deposit, refreshes and exports through the app, stops only this project's operators, imports the backup, approves an exit, restarts Electron and checks the confirmed destination transaction on the actual Bitcoin node. It restores the test operators on completion. The harness enables the SDK's local self-signed-certificate escape hatch solely for creating the fixture wallet; the app removes that setting and uses explicit CA verification for its refresh.

To copy the coordinator certificate for a manual run:

```sh
docker exec spark-desktop-pilot-spark-operator-0-1 cat /opt/spark/tls/server_0.crt
```

The disposable wallet and funding/mining operations are provided by the automated harness. The app UI does not create Spark deposits or mine blocks. On Linux, actual-window tests require a display (CI uses Xvfb) and working Chromium sandbox support. Windows users can use Git Bash or WSL for Docker fixture orchestration while running Electron natively.
