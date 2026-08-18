# Dataset snapshots (time machine)

Every dataset has a history. A refresh no longer overwrites the payload and
forgets the previous one — it appends to an immutable, content-addressed
timeline that buyers can read at any past instant and that a dispute can be
settled against.

Issue: [#600](https://github.com/Hazina-Escrow/Hazina-Escrow/issues/600)

## Model

`dataset_snapshots` stores one row per distinct payload:

| column                        | meaning                                                     |
| ----------------------------- | ----------------------------------------------------------- |
| `content_hash`                | `sha256(canonical(payload))` — the content address          |
| `payload` / `encoding`        | gzip'd canonical JSON (base64), or plain JSON when tiny     |
| `valid_from` / `valid_to`     | half-open range `[from, to)`; `valid_to IS NULL` = live now |
| `byte_size` / `raw_byte_size` | stored vs uncompressed size — drives the storage estimator  |
| `observations`                | how many refreshes saw this exact content                   |
| `provider_run_id`             | the refresh sweep that wrote it                             |

**Invariant.** For one dataset, sorted by `valid_from`, each row's `valid_to`
equals the next row's `valid_from`, and only the last row is open. No overlaps,
no gaps — asserted by a property test, and preserved by compaction.

### Content addressing

`canonicalize()` sorts object keys, drops `undefined`, rejects non-finite
numbers, and emits no insignificant whitespace, so two payloads carrying the
same information hash identically. `_fetchedAt` — the wall-clock stamp the
refresh path adds — is stripped before hashing; without that, every poll would
look like a change. Delivery receipts hash the same way, so a receipt hash and a
snapshot hash for the same payload agree byte for byte.

### De-duplication

An unchanged refresh writes **zero** new rows: the live snapshot's
`observations` counter and `last_observed_at` advance instead. A five-minute
feed that changes twice a day stores two rows a day, not 288.

## API

All routes hang off a dataset. History _shape_ is public — that is what makes a
back catalogue worth buying. _Payloads_ need the owning seller's JWT or the
`txHash` of a completed purchase of that dataset.

| method | route                                            | returns                                      |
| ------ | ------------------------------------------------ | -------------------------------------------- |
| GET    | `/api/v1/datasets/:id/history`                   | snapshot metadata + per-day change sparkline |
| GET    | `/api/v1/datasets/:id/snapshots/at?asOf=`        | the snapshot live at that instant            |
| GET    | `/api/v1/datasets/:id/snapshots/range?from=&to=` | snapshots overlapping a window               |
| GET    | `/api/v1/datasets/:id/snapshots/diff?from=&to=`  | structural diff between two snapshots        |
| GET    | `/api/v1/datasets/:id/snapshots/storage`         | storage footprint + projection (seller only) |
| PUT    | `/api/v1/datasets/:id/snapshots/policy`          | set the retention policy (seller only)       |

`asOf` resolves as `valid_from <= asOf < valid_to`, so an `asOf` exactly equal to
a `valid_from` returns _that_ snapshot, never its predecessor. Listings are
paginated with `limit`/`offset` and hard-capped at 200 rows per request.

`diff` accepts ISO instants or 64-character content hashes on either end. Its
output shape is documented in `snapshots.diff.ts` and is stable: entries are
sorted by path, and arrays of objects are matched by identity (`id`, `address`,
`wallet`, …) rather than position, so one insertion does not read as "everything
changed".

## Retention

Per-dataset policy, defaulting to: keep every snapshot for 7 days, one per hour
to 90 days, one per day to 365 days.

```jsonc
{ "retentionDays": 365, "fullResolutionDays": 7, "hourlyDays": 90 }
```

The scheduled compaction job (`SNAPSHOT_COMPACTION_INTERVAL_MS`, default 6h)
enforces it. Two rules are absolute: the live snapshot is never deleted, and a
snapshot referenced by a completed purchase is never deleted — it is the
evidence a dispute is settled against. Deleted rows hand their time to the
preceding survivor, so `asOf` still resolves everywhere inside the window.

`GET /snapshots/storage` reports the current footprint, the measured compression
ratio, and what the observed cadence implies at steady state.

## Backfill

`npm run snapshots:backfill --prefix backend` gives every existing dataset an
opening snapshot dated at its last refresh (or its creation). It also runs at
startup unless `SNAPSHOT_BACKFILL_ON_START=false`. It is idempotent: a dataset
that already has an open snapshot is skipped, so running it twice changes
nothing.
