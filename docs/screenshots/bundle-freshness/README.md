# Saved-bundle freshness PoC screenshots

Captured from actual Electron using `desktop/ui/freshness.spec.ts`. These are disposable synthetic regtest fixtures served by a loopback HTTPS coordinator, not mainnet recovery evidence. The renderer, IPC, service, vault and exporter are real. No funds were moved or Bitcoin transactions signed/broadcast.

- `matching.png`: saved bundle matches two consecutive observed snapshots.
- `stale-same-balance.png`: same balance, different recovery material.
- `offline-unknown.png`: coordinator unavailable; freshness unknown.
- `invalid-saved-vault.png`: saved ciphertext unreadable; no coordinator query.

The PoC checks known recovery-material fields and structural/identity validation. It does not verify Bitcoin transaction signatures, current chain spends, or fee/time estimates. See [Electron app documentation](../../electron-app.md) for reproduction commands and limitations.
