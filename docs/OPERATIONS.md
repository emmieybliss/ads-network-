# Operations

## Health

| Check | Meaning |
| --- | --- |
| API `GET /health` | The process is up. |
| API `GET /ready` | The database and Redis answer (returns 503 otherwise). Use it for load balancers and container health. |
| Admin, System | Services, queue depth, failed jobs, worker heartbeat, migrations, email outbox. |
| Admin overview | Shows "Worker healthy" while the worker's heartbeat is recent. |

If the worker stops, ads still serve and events are still admitted, but
reports stop refreshing. Settlement and alerts also wait until the worker
returns. In queue mode, events pile up in Redis and are processed when it
comes back.

## Scheduled work (worker)

| Schedule | Jobs |
| --- | --- |
| every minute | rebuild today's report aggregates, campaign start/end/budget lifecycle, settlement, spend counters |
| every 5 minutes | budget and low-balance alerts, anomaly detection (CTR spikes, invalid-domain bursts) |
| daily 00:15 UTC | flat-rate allocation, expire unconfirmed payments (14 days), retention purge, monthly statements on the 1st |

Run more than one worker for redundancy. The jobs use advisory locks and
idempotency keys, so duplicates are safe.

## Migrations

```bash
node dist/scripts/migrate.js                   # in the api image: apply pending migrations
pnpm db:migrate / pnpm db:rollback             # from a source checkout
```

The runner takes a PostgreSQL advisory lock, so two instances cannot migrate at
once. Rollback refuses to run in production unless you explicitly allow it.

## Backups and restore

Back up PostgreSQL and the creative storage volume. Redis holds only rate
limits, caps and queues: losing it loses queued but unprocessed events, not
money or history.

```bash
# backup (daily, keep off-site, encrypt at rest)
pg_dump --format=custom --no-owner "$DATABASE_URL" > blissnova-$(date +%F).dump
tar czf storage-$(date +%F).tgz -C /data storage

# restore into an empty database, then start the API (it applies any newer migrations)
pg_restore --no-owner --dbname "$DATABASE_URL" blissnova-YYYY-MM-DD.dump
tar xzf storage-YYYY-MM-DD.tgz -C /data
```

Test a restore regularly. After restoring, run reconciliation in Admin, Finance,
Summary: all eight checks should pass.

For the Docker demo, `scripts/reset-demo.sh` deletes the demo volumes. Back up
first if you changed anything you want to keep:

```bash
docker compose --env-file .env.demo exec postgres pg_dump -U blissnova -Fc blissnova > demo.dump
```

## Money corrections

Ledger rows cannot be edited or deleted; database triggers refuse it. A
correction is an adjustment (Admin, Finance, Adjustments). It needs a reason
and step-up re-authentication, and it is written to the audit log. Refunds and
disputes have their own flows.

## Incidents

1. Check `/ready`, Admin, System and the logs (`docker compose logs api worker`).
2. If invalid traffic is the problem:
   - suspend the site or campaign in Admin, giving a reason;
   - open a fraud case;
   - exclude events with a dry run first, then for real. Excluded charges are reversed through the ledger.
3. To stop serving everywhere, turn off tracking in Admin, Settings, or enable maintenance mode.
4. Record what happened in the case notes. Every admin action is in the audit log.
