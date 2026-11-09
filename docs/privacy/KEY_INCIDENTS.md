# Key incidents

What to do when a device is lost or a service key may be compromised. The design behind this is D-24 in `DECISION_LOG.md`.

One fact shapes everything here. A key can be replaced so it reads nothing new. Nothing can make anyone forget what a key has already read. So a rotation stops future exposure. It doesn't undo past exposure.

## Device loss (user)

Nothing has to be rotated and no one has to act on-chain. The private account comes from the wallet signature (D-21), so the same wallet restores the same account on any new device, including notes, positions and claims, from chain data.

- If only the device was lost and the wallet is still safe: sign in from another device and carry on. "Remember this device" only ever stored an encrypted copy, so a lost device on its own doesn't expose the account.
- If the wallet itself may be stolen: whoever has the wallet can sign and derive the same private account. Move funds to a new wallet as soon as possible by closing positions and unshielding to an address you control. Rooq can't freeze or reverse this for anyone.
- If the device was also running Rooq with the app open, treat the private account's viewing key as exposed. Past and future positions on that account are readable to whoever got it. Moving to a new account stops the future exposure only.

## Compromised or lost service key

Three service keys are in scope: the coordinator key and the two risk worker keys. They read data. None of them can move funds or change a record, so the danger is someone reading private orders and positions. The transaction keys that pay gas (`RISK_TX_KEY`, `COORDINATOR_TX_KEY`) are separate and are handled by replacing the key and refilling the new address.

**What a compromised key exposes.** Everything ever encrypted to it: every position and order already recorded, and every new one until the change takes effect. Assume that all past data under that key is known to the attacker. Tell users plainly.

**Do not destroy the old key.** The old key is the only way to read records still encrypted to it. Destroying it early would strand live positions and could stop their liquidation. Keep it, restricted and logged, until the health check says it is no longer needed. Keep it even if it is compromised.

### Rotation steps

1. Make the new keys. On the operator machine, generate each new scalar and store it in the Keychain or an environment secret. Never write it to a file or a chat. Work out the public point of each.
2. Load both keys into the service before anything changes on chain. Set `RISK_SK` (or `COORDINATOR_SK`) to the new key and `RISK_SK_PREVIOUS` (or `COORDINATOR_SK_PREVIOUS`) to the old one, comma-separated if there is more than one retired key. Restart. The service starts as long as one of its keys is one this deployment has used.
3. Check the health endpoint of each service. Look for `keys.keysHeld` of at least 2 and `keys.currentKeyHeld` true, and `blocked` not showing `KEY_MISSING`.
4. Schedule the change from the guardian wallet: call `scheduleKeyRotation` on PrivateMarkets with all three public keys (reuse the current point for a slot that stays the same). The new set is public and can't take effect for 24 hours. Cancel with `cancelKeyRotation` if a mistake shows up.
5. After 24 hours, anyone can call `activateKeyRotation`. New locks, positions and market state then use the new keys. Wallets and the app should read keys from the contract each time they build a proof; a wallet still holding the old keys gets its lock rejected and must refresh.
6. Let old records move on. Workers update live positions onto the new keys without any owner present. Check `keys.retiredKeyRecords` on both workers and the coordinator. Live locks, unpaid claims, market records and pool state keep that number above zero until each is matched, paid, folded or touched again.
7. Only when `retiredKeyRecords` is zero on all three services for the retired key, destroy the old key and remove it from `*_SK_PREVIOUS`.

If a worker lost its key entirely rather than having it stolen, the other worker can keep doing everything, because every position, lock and claim is also encrypted to the other risk key. Rotate the lost slot to a new key the same way. Market records are encrypted to the coordinator and both risk keys. If both risk keys are lost at once, the owners can still close their own positions, but nobody can liquidate them, which is why the two workers must keep separate keys on separate hosts (REC-08).

If the guardian key itself is stolen, an attacker can schedule a change, but it can't take effect for 24 hours and it can only make new data readable by keys they control. It can't move funds. There is no way to change the guardian on a live deployment, so the guardian must be a multisig before real use.
