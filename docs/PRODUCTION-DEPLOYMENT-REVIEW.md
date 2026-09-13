# PCare Pharma — Production Deployment & Domain Configuration Review

**Reviewed:** 2026-09-12
**Target:** `https://pcare-pharma.com` — AWS EC2 (ap-south-1) + Supabase (ap-south-1)
**Scope:** architecture, security, database migration, backups, cost, and a corrected execution plan.

**How this review was produced:** every finding below was checked against the actual
repository at `01-production-app/` and against the live Supabase project
`sttizzqvsgjpmrwwgpvw` (ap-north-east-1, Postgres 17.6.1) using read-only SQL.
Where a fact could not be checked from here it is marked
**VERIFY FROM ACTUAL ENVIRONMENT — DO NOT ASSUME.**

---

## 1. Executive Verdict

> ### NO-GO today. → GO WITH CONDITIONS once the eleven P0 items in §2 are closed.

This is not a "needs polish" verdict. Four of the blockers are things that would make
the deployment *fail or be wrong on day one*, and they are not visible from the
deployment plan you supplied — they only surface when you read the code and query the
live database:

1. **A database function that the application calls exists in no migration file.**
   `receive_purchase_atomic(uuid, uuid, jsonb, text)` is live and correct (verified),
   but the repository only creates the **three**-argument version
   (`schema-22-atomic-workflows.sql:196`). `schema-34` *grants* on the four-argument
   version and `schema-35` *drops* the three-argument one. Replaying the repo's SQL
   files onto a fresh Mumbai project therefore aborts at schema-34 with `42883` and,
   if you push past it, leaves goods-receiving with **no function at all**. The live
   Tokyo database is currently the only place that definition exists. If the Tokyo
   project is deleted before it is extracted, it is gone.

2. **The nginx template will not start.** `limit_req_zone` is inside a `server { }`
   block (`nginx.conf.template:24`); nginx only accepts it in `http { }`. `nginx -t`
   fails with *"limit_req_zone" directive is not allowed here*. The same file also
   names the wrong domain, has no `client_max_body_size` (so the 1 MB default breaks
   every 12 MB invoice upload with a 413), and sets `proxy_read_timeout 60s` against a
   120 s Gemini budget (so every long extraction dies as a 504).

3. **Staff can read purchase cost and vendor identity through the API today.**
   `GET /api/v1/inventory/:medicineId/batches` and `GET /api/v1/inventory/batch/:batchId`
   carry no owner guard (`inventory.routes.js:77,79`) and select `*` from
   `batches_with_stock`, which expands `inventory_batches.*` — including `unit_cost`,
   `supplier_id` and `po_id`. `GET /api/v1/suppliers` additionally merges
   `supplier_balances.total_purchased / total_paid`. This is the P0 you already
   identified, now with exact coordinates.

4. **Expired stock is sellable, and for 5½ hours a day it is sellable by design.**
   `medicines_with_stock.total_stock` sums the whole ledger with no expiry predicate,
   and `create_bill_atomic()` contains **no expiry guard whatsoever** — the only filter
   is a JavaScript `gte('exp_date', <UTC today>)` in `inventory.service.js:60`. Between
   00:00 and 05:30 IST, "UTC today" is yesterday in Bengaluru, so a batch that expired
   yesterday remains sellable. For a pharmacy that is a regulatory problem, not a
   reporting one.

Everything else in your plan is sound. The single-origin architecture is right, the
region choice is right, Let's Encrypt on nginx is right, Spaceship DNS is sufficient,
and Route 53 is genuinely unnecessary. The RLS lockdown in `schema-29` is **verified
working** — `anon` and `authenticated` hold *zero* table or view grants in `public` on
the live database, which is a better posture than most production Supabase projects.

The conditions are listed in §13. There are eleven; most are a few hours each.

---

## 2. Critical Problems Found

| # | Pri | Problem | Risk | Required Fix |
|---|-----|---------|------|--------------|
| 1 | **P0** | `receive_purchase_atomic(uuid,uuid,jsonb,text)` exists live but in no `.sql` file. `schema-34:19` grants it; `schema-35:34` drops the 3-arg one that *is* in a file. | Rebuilding Mumbai from the repo aborts (`42883`) or silently ships a database where goods receiving is gone. Definition is lost forever if Tokyo is deleted. | Extract with `pg_get_functiondef`, commit as `schema-38-reconcile-live.sql`. Body is reproduced verbatim in §7.3. |
| 2 | **P0** | `purchases.invoice_no` column exists live, created by no migration file. Same class of drift. | Same. Also `purchases_status_check` still has **no** `partially_received`, which `PurchasesPage` offers as a filter. | Include in `schema-38`. Take `pg_dump --schema-only` as the source of truth, not the files. |
| 3 | **P0** | Migration docs are three generations stale. `MIGRATION-ORDER.md` header says 19 files, body lists 20, repo contains **24**. `schema-32/33/34/35` are undocumented. `schema-31` does not exist. | Anyone rebuilding by following the doc produces a different database from the live one. | Rewrite `MIGRATION-ORDER.md` from the dump, not from filenames. Order given in §7.4. |
| 4 | **P0** | `schema-37-invoice-tax-detail.sql` is **not applied** to the live database (verified: `supplier_invoices.invoice_type` does not exist). | Mumbai must include it. Applying it after go-live means an API restart (the `config/capabilities.js` probe caches per process). | Apply as the last schema step, before the API is ever started. |
| 5 | **P0** | Staff can read `unit_cost`, `supplier_id`, `po_id` via `GET /inventory/:medicineId/batches` and `/inventory/batch/:batchId`; and supplier balances via `GET /suppliers`. | Margin and vendor pricing disclosure to counter staff. Frontend hiding is not a control. | Serializer layer between service and response. Design in §8.2. |
| 6 | **P0** | `create_bill_atomic()` has no expiry guard; `medicines_with_stock.total_stock` counts expired units; `is_low_stock` derives from it. | Expired medicine can be dispensed. Reorder decisions are made against stock that cannot legally be sold. | Add `sellable_stock` / `expired_stock` to the views and a hard guard in the RPC. SQL in §8.3. |
| 7 | **P0** | Seven JS call sites use `new Date().toISOString().slice(0,10)` as "today" (`inventory.service.js:30,60,159,186,320`; `expiry.service.js:83,120`). Postgres side is already IST. | Between 00:00–05:30 IST every day, expired batches pass the "not expired" filter and new batches expiring today can be created. | Replace all seven with `getISTDateString()` from `utils/date.js`. Tests in §12.4. |
| 8 | **P0** | `nginx.conf.template` is syntactically invalid (`limit_req_zone` in `server{}`), names `pcarepharma.in`, has no `client_max_body_size`, 60 s proxy timeout, `expires 1d` on `index.html`, and an unconditional 80→443 redirect that blocks ACME. | nginx will not start. If it did: every invoice upload 413s, every long extraction 504s, and the SPA serves a stale `index.html` for a day after each deploy. | Replace wholesale. Full config in §5.6. |
| 9 | **P0** | PM2 `env_production` only applies when started with `--env production`. Without it `NODE_ENV` is undefined → `config.isProduction === false`. | `errorHandler.js:42` returns **stack traces** to clients, and `auth.controller.js:21` drops `secure` from the refresh cookie. | Start with `--env production`; assert `NODE_ENV=production` in the post-deploy health check. |
| 10 | **P0** | No backups exist, and Supabase **Free has no automated backups and no PITR**. Storage objects are not covered by any database backup either. | Total, unrecoverable loss of a pharmacy's sales, stock and GST records. | Nightly `pg_dump` + Storage sync to S3, with a **rehearsed restore**. §9. |
| 11 | **P0** | No endpoint rate limit or concurrency cap on `POST /api/v1/supplier-invoices` (only the global 900/15 min). Multer buffers 12 MB in memory; PM2 `max_memory_restart` is 400 M on a 2 GB box. | Uncapped Gemini spend; OOM restart mid-upload after the storage write has already been paid for. | Per-user limiter + in-flight semaphore + nginx `limit_req`/`limit_conn`. §5.6, §8.8. |
| 12 | P1 | `discount_amount` is validated only as `isFloat({min:0})` (`billing.routes.js:32`) and `bills_with_totals.total = subtotal − discount_amount` with no floor (verified). | Any staff account can post a discount larger than the bill and create a **negative-total** sale, which flows straight into `daily_sales_summary`. Cash-handling fraud vector. | Clamp inside `create_bill_atomic` (`discount ≤ subtotal`) and add a validator ceiling. |
| 13 | P1 | `public.match_medicines_trgm(text,int)` is `SECURITY DEFINER` and **executable by `anon`** via `/rest/v1/rpc/`. `schema-34` revoked `match_suppliers_trgm` and missed this one. Same for `public.is_owner()`. (Confirmed by Supabase security advisor.) | Anyone holding the anon key can enumerate the medicine catalogue, bypassing every API guard. | Add the two missing revokes to `schema-38`. |
| 14 | P1 | 12 functions have a mutable `search_path`, including `check_no_negative_stock` — `schema-35` rewrote it and dropped the `SET search_path` the original had. | Search-path manipulation vector on trigger functions. | `ALTER FUNCTION … SET search_path = public, pg_temp` for all 12. |
| 15 | P1 | No Content-Security-Policy anywhere. Helmet's CSP never reaches the SPA document once nginx serves the static files. | No defence-in-depth against XSS on a page that holds an access token in memory. | CSP in nginx, with a SHA-256 hash for the one inline theme script in `index.html`. §5.6. |
| 16 | P1 | `requestContext.js:12` trusts a client-supplied `X-Request-Id`; `req.originalUrl` (with query strings) is logged. | Log injection; and `GET /customers/search?q=<patient phone>` writes PII into logs with no retention policy. | nginx must overwrite `X-Request-Id`; cap log retention at 14 days. |
| 17 | P1 | `frontend/dist` is git-ignored, so the EC2 box must run `vite build` — 1.07 MB bundle on 2 GB RAM with no swap. | OOM during deploy, leaving no serving directory. | 2 GB swap file, or build in CI and ship the artifact. |
| 18 | P1 | Supabase Auth: leaked-password protection is disabled; `pg_trgm` is installed in `public`. | Weak passwords accepted for accounts that can read every patient record. | Enable in the new project; install `pg_trgm` into `extensions`. |
| 19 | P2 | `/ready` is not proxied by the nginx template, so the readiness probe is unreachable from outside. | Deploy checks and monitoring silently test nothing. | Add the location. |
| 20 | P2 | No log rotation configured for `/var/log/pcare`; directory does not exist before PM2 starts. | Disk fills; PM2 fails to write and the app dies with no diagnostic. | `pm2-logrotate` + pre-created directory. §5.8. |

---

## 3. Corrected Architecture

```text
                        Spaceship (registrar + DNS)
                        A  @    -> <EIP>      TTL 300 -> 3600
                        A  www  -> <EIP>
                        CAA @   -> letsencrypt.org
                                 |
                                 | public DNS
                                 v
  Browser  --------- HTTPS/TLS 1.2+1.3 ---------> AWS ap-south-1 (Mumbai)
  (SPA, access token in memory,                   +---------------------------+
   refresh token in httpOnly                      |  EC2 t4g.small, Ubuntu 24 |
   SameSite=Strict cookie)                        |  20 GB gp3, ENCRYPTED     |
                                                  |  IMDSv2 required          |
                                                  |                           |
                                                  |  nginx :80 -> 301 :443    |
                                                  |  nginx :443               |
                                                  |    /assets/  static, 1y   |
                                                  |    /         SPA fallback |
                                                  |              no-cache     |
                                                  |    /api/     ---+         |
                                                  |    /health /ready |       |
                                                  |                 |         |
                                                  |      127.0.0.1:4000       |
                                                  |      Node 22 + PM2        |
                                                  |      (fork, 1 instance)   |
                                                  +-----------|---------------+
                                                              |
                          +-----------------------------------+------------------+
                          |                                   |                  |
                   HTTPS (service_role)              HTTPS (nightly)      HTTPS (nightly)
                          |                                   |                  |
                          v                                   v                  v
              Supabase ap-south-1 (Mumbai)            S3 pcare-backups     Google Gemini
              +---------------------------+          (private, versioned,  (invoice OCR,
              | PostgreSQL 17   RLS on     |           SSE, 30-day LC,      capped)
              | Auth (GoTrue)              |           Object Lock weekly)
              | Storage: supplier-invoices |
              |   PRIVATE, 0 public policies|
              +---------------------------+

  Access to the box:  AWS SSM Session Manager (primary, no open port 22)
                      SSH from your IP (break-glass only)
  Secrets:            AWS SSM Parameter Store SecureString  ->  /srv/pcare/current/backend/.env (0600)
```

Three deliberate departures from your proposal:

* **nginx serves the static SPA; Express does not.** `app.js:165` keeps its static block
  as a harmless fallback (it costs nothing and keeps `run-demo.sh` working), but nginx
  wins because it never reaches Node. This matters for reasons beyond speed: it lets you
  express `immutable` on `/assets/*` and `no-cache` on `/index.html` separately — which
  `express.static` cannot do cleanly — and it keeps the login page available while the
  Node process is restarting mid-deploy.
* **Port 22 closed by default; SSM Session Manager is the access path.** "SSH restricted
  to my IP" breaks the moment your ISP re-issues your address, which for most Indian
  residential connections is weekly. SSM costs nothing, needs no inbound port, and logs
  every session to CloudTrail.
* **SSM Parameter Store, not Secrets Manager.** Standard parameters are free; Secrets
  Manager is $0.40/secret/month, which on six secrets is 12 % of your entire infra bill.

---

## 4. Domain / Spaceship Configuration

Answering your thirteen questions directly.

### 4.1 The records to create

```text
Type   Host     Value                 TTL
A      @        <EC2_ELASTIC_IP>      300  (raise to 3600 after go-live)
A      www      <EC2_ELASTIC_IP>      300  (raise to 3600 after go-live)
CAA    @        0 issue "letsencrypt.org"      3600
TXT    @        v=spf1 -all           3600
TXT    _dmarc   v=DMARC1; p=reject; rua=mailto:<your-address>   3600
```

**VERIFY FROM ACTUAL ENVIRONMENT — DO NOT ASSUME:** the Elastic IP does not exist yet.
Do not write these records with a placeholder.

### 4.2 Nameservers — no change needed (Q1)

Keep Spaceship's default nameservers. You only change nameservers when you move DNS
*hosting* elsewhere. Confirm in the Spaceship panel that the domain is on
"Spaceship DNS" (their managed DNS) and not on "parked"/"forwarding" mode — a parked
domain silently ignores the records you add.

### 4.3 Route 53 is not necessary (Q2, Q3)

Route 53 would be justified by exactly three things, none of which apply:

* an **ALIAS record at the apex** pointing at an AWS-managed endpoint (ALB, CloudFront,
  S3 website). You have a static Elastic IP, so a plain `A` record works and an ALIAS
  buys nothing.
* **Route 53 health-check failover** between two instances. You have one instance.
* **ACM DNS-01 validation automation**. You are not using ACM (see §6.8).

Route 53 would cost $0.50/hosted zone/month plus query charges — about 3 % of your
budget for zero functional gain. Spaceship DNS is sufficient. Keep the domain there.

### 4.4 A record, not CNAME (Q4)

The apex (`@`) **must** be an `A` record. A CNAME at a zone apex is prohibited
(RFC 1034 §3.6.2) because the apex must also carry SOA and NS records. Some providers
offer "ALIAS"/"CNAME flattening" to work around this; you do not need it, because your
target is a literal IP address.

### 4.5 www (Q5)

Create `www` as a second **A record to the same IP**, and let nginx issue the
`301 https://pcare-pharma.com$request_uri`. Rationale: a CNAME `www → pcare-pharma.com`
also works, but adds a DNS resolution hop for no benefit, and certbot's HTTP-01
challenge has to resolve `www` independently anyway. Two A records is the simplest
thing that certbot, the browser and the redirect all agree about.

The redirect is in nginx, not DNS — DNS cannot redirect.

### 4.6 Before or after EC2? (Q7)

**After the Elastic IP is allocated, and before you run certbot.** Concretely, this
is step 9 in §11 — the moment the EIP exists. Create the records immediately, then do
OS hardening while DNS propagates. That overlaps the wait with useful work.

### 4.7 Propagation and certificate issuance (Q8)

Let's Encrypt resolves your hostname from its own validation servers at the moment you
request the certificate. It does not care about your local resolver's cache — but it
does care that the authoritative answer has actually changed. With TTL 300 and a fresh
record, that is usually minutes.

The danger is the rate limit: **5 failed validations per account per hostname per hour**,
and 50 certificates per registered domain per week. Burn those and you are locked out
for an hour at the exact moment you are trying to go live. So:

```bash
dig +short @1.1.1.1 pcare-pharma.com        # must return your EIP
dig +short @8.8.8.8 www.pcare-pharma.com    # must return your EIP
curl -I http://pcare-pharma.com/.well-known/acme-challenge/test   # must reach nginx
certbot certonly --dry-run ...              # ALWAYS dry-run first
```

Only after all four succeed do you issue for real.

### 4.8 Other Spaceship configuration after purchase (Q9)

**VERIFY FROM ACTUAL ENVIRONMENT — DO NOT ASSUME.** In the Spaceship panel confirm:

1. **ICANN registrant email verification is complete.** An unverified registrant email
   gets the domain **suspended** 15 days after registration. This takes down the whole
   pharmacy and catches people out constantly.
2. **Registrar transfer lock is ON** (prevents domain hijacking).
3. **WHOIS privacy is ON.**
4. The domain is not in "parking" or "forwarding" mode.

### 4.9 Auto-renewal — yes, enable it (Q10)

Enable it, and keep a valid card on file. A lapsed domain means the POS is unreachable
*and* the name enters a redemption period where a squatter can take it. Also put the
expiry date in a calendar with a 30-day reminder; auto-renew fails silently when a card
expires.

### 4.10 Records you must NOT create (Q11)

* **No wildcard `A * `.** It points every future subdomain at this one box and makes
  subdomain-takeover and certificate confusion easy.
* **No `AAAA` record** unless the instance genuinely has a routable IPv6 address *and*
  nginx is listening on `[::]:443`. An AAAA pointing at an address that does not answer
  makes IPv6-capable clients hang for the connect timeout before falling back — a
  classic self-inflicted "the site is slow for some people" outage.
* **No A record pointing at the EC2 public DNS name or a non-Elastic public IP.** A
  non-Elastic IP changes on every stop/start.
* **No second CNAME at the apex** alongside the A record.
* **Do not point any record at the Supabase host.** The browser never talks to Supabase.

### 4.11 DNSSEC — not now (Q12)

Skip it. The honest risk trade: DNSSEC protects against cache-poisoning, which for a
site already behind TLS with HSTS is a narrow residual threat. Against that, a DS
record that falls out of sync with the zone's keys makes the domain **fail to resolve
entirely** for every validating resolver — a total outage, self-inflicted, and one you
cannot fix by restarting anything. For a single-shop POS with one operator and no
key-rotation runbook, that is the larger risk. Revisit in a year if you want. P2,
optional, never a blocker.

### 4.12 Email DNS (Q13)

You send no mail from this domain today. Supabase Auth's password-reset mails go out
from Supabase's own sending domain on the free tier, so **no DNS is needed for the
reset flow to work** — but you must still set the Supabase Site URL (§6.3).

Do add the two records above:

* `TXT @ "v=spf1 -all"` — states that nothing is authorised to send as this domain.
* `TXT _dmarc "v=DMARC1; p=reject; rua=mailto:…"` — tells receivers to reject spoofed
  mail claiming to be your pharmacy.

Both are pure protection for a domain that sends nothing, and cost nothing.

A **null MX** (`MX @ 0 .`, RFC 7505) is tempting for the same reason, but only add it
if you are certain you will never want `owner@pcare-pharma.com`. **VERIFY FROM ACTUAL
ENVIRONMENT — DO NOT ASSUME:** check whether Spaceship's email-forwarding feature is
enabled for this domain first; a null MX silently breaks it.

Leave everything else in the zone untouched.

---

## 5. AWS Architecture

### 5.1 EC2 — t4g.small is the right call

2 GB is the binding constraint, and it is binding for two specific reasons the plan
does not mention:

* `vite build` on the 1.07 MB bundle needs roughly 1–1.5 GB peak. On a 1 GB
  `t4g.micro` it OOMs.
* `multer.memoryStorage()` buffers the whole 12 MB invoice, then the extraction layer
  base64-encodes it (+33 %) for the Gemini request body. Two concurrent uploads is
  ~64 MB of live buffers plus V8 overhead.

So: **t4g.small, plus a 2 GB swap file.** Swap is what turns an OOM-kill during a build
into a slow build.

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-swap.conf
```

Node version: **Node 22 LTS** (`nodesource` or `nvm`). The repo pins no `engines` field —
add `"engines": { "node": ">=20 <23" }` to both `package.json` files so a future
`npm install` on a mismatched runtime fails loudly.

### 5.2 EBS

20 GB gp3 is right (~6 GB OS + ~1.5 GB node_modules ×2 + logs + headroom).

**Enable EBS encryption by default in ap-south-1 BEFORE you launch the instance.** You
cannot encrypt a root volume in place afterwards — you would have to snapshot, copy the
snapshot with encryption, and relaunch.

```bash
aws ec2 enable-ebs-encryption-by-default --region ap-south-1
aws ec2 get-ebs-encryption-by-default --region ap-south-1   # verify: true
```

### 5.3 Elastic IP — and the cost nobody expects

Allocate one and associate it. Note: since February 2024 AWS charges **$0.005/hour for
every public IPv4 address**, attached or not — about **$3.65/month**. This is not
avoidable while the service is publicly reachable on IPv4, and it is roughly 18 % of
your monthly bill. Budget for it; do not be surprised by it.

Do not leave an *unassociated* EIP lying around — it costs the same and does nothing.

### 5.4 Security Group — your proposal, corrected

| Port | Source | Verdict |
|---|---|---|
| 443 | `0.0.0.0/0` | Required. |
| 80 | `0.0.0.0/0` | Required — HTTP-01 renewal needs it **permanently**, not just at issuance. |
| 22 | your IP /32 | **Remove it after SSM is working.** Keep as break-glass only, and expect to edit it whenever your ISP changes your address. |
| 4000 | — | Correct: never expose. Also bind Node to loopback: set `PORT=4000` and confirm `ss -lntp` shows `127.0.0.1:4000`, not `0.0.0.0:4000`. **VERIFY:** `app.listen(config.port)` with no host argument binds `::`/`0.0.0.0`. The SG is the only thing keeping it private. Add `HOST=127.0.0.1` handling, or accept SG+UFW as the control and document it. |
| 5432 | — | Correct: nothing listens locally; Postgres is Supabase's. |

Outbound: leave the default allow-all. The box must reach Supabase, Gemini, S3, apt
and Let's Encrypt.

### 5.5 UFW

Defence in depth behind the SG, and the thing that protects you if a SG rule is ever
widened by accident.

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow from <YOUR_IP>/32 to any port 22 proto tcp comment 'break-glass ssh'
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable
```

Note UFW does not need a rule for SSM — Session Manager is an **outbound** connection.

### 5.6 nginx — complete replacement for `nginx.conf.template`

The existing template is unusable (finding #8). Two files.

**`/etc/nginx/conf.d/pcare-limits.conf`** — must be at `http` scope, which is why the
current template fails:

```nginx
# Rate-limit zones live in http{} context. conf.d/*.conf is included from http{}.
limit_req_zone  $binary_remote_addr zone=pcare_login:10m   rate=10r/m;
limit_req_zone  $binary_remote_addr zone=pcare_upload:10m  rate=6r/m;
limit_req_zone  $binary_remote_addr zone=pcare_api:10m     rate=20r/s;
limit_conn_zone $binary_remote_addr zone=pcare_conn:10m;

# Correct WebSocket upgrade mapping. The old template set
# `Connection: upgrade` unconditionally, which breaks keepalive on every
# ordinary request. This app has no WebSockets, but the map is the right
# shape if one is ever added.
map $http_upgrade $connection_upgrade { default upgrade; '' close; }
```

**`/etc/nginx/sites-available/pcare`** — phase 1, before the certificate exists:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name pcare-pharma.com www.pcare-pharma.com;

    # Served over plain HTTP forever — renewals need it, not just issuance.
    location ^~ /.well-known/acme-challenge/ {
        root /var/www/certbot;
        default_type "text/plain";
    }

    location / { return 301 https://pcare-pharma.com$request_uri; }
}
```

Phase 2, added after `certbot certonly` succeeds:

```nginx
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name pcare-pharma.com;

    ssl_certificate     /etc/letsencrypt/live/pcare-pharma.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/pcare-pharma.com/privkey.pem;
    include             /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam         /etc/letsencrypt/ssl-dhparams.pem;

    # ── Security headers.
    # IMPORTANT: `add_header` does NOT inherit into a location that declares its
    # own add_header. Every header the site needs is therefore declared ONCE here,
    # and no location below uses add_header — locations use `expires` instead,
    # which does not break inheritance. Breaking this rule silently strips CSP
    # and HSTS from whichever path you edit.
    add_header Strict-Transport-Security "max-age=300" always;   # raise to 31536000 after a stable week
    add_header X-Content-Type-Options    "nosniff" always;
    add_header X-Frame-Options           "DENY" always;
    add_header Referrer-Policy           "strict-origin-when-cross-origin" always;
    add_header Permissions-Policy        "camera=(), microphone=(), geolocation=(), payment=()" always;
    add_header Cross-Origin-Opener-Policy "same-origin" always;
    # CSP. 'sha256-...' covers the ONE inline theme script in frontend/dist/index.html.
    # RECOMPUTE IT whenever that script changes:
    #   openssl dgst -sha256 -binary inline.js | openssl base64 -A
    # VERIFY FROM ACTUAL ENVIRONMENT — DO NOT ASSUME the placeholder below.
    add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'sha256-<COMPUTE_ME>'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" always;

    # ── Uploads and long extractions.
    # 12 MB file + multipart overhead. 15m is the right headroom; the app's own
    # limit (INVOICE_MAX_UPLOAD_MB=12) stays the authoritative one so the user
    # gets a clean 413 FILE_TOO_LARGE from Express, not an nginx HTML page.
    client_max_body_size 15m;
    client_body_timeout  120s;

    gzip on;
    gzip_vary on;
    gzip_min_length 1024;
    gzip_types text/plain text/css application/javascript application/json
               application/xml image/svg+xml font/woff2;
    # Brotli is NOT in stock Ubuntu nginx. Skip it — gzip on a 1 MB bundle over a
    # shop broadband line is not the bottleneck, and building a module is churn.

    access_log /var/log/nginx/pcare.access.log;
    error_log  /var/log/nginx/pcare.error.log warn;

    limit_conn pcare_conn 24;

    # ── API
    location /api/ {
        limit_req zone=pcare_api burst=40 nodelay;
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # OVERWRITE, never forward: requestContext.js trusts this header and
        # writes it into every log line.
        proxy_set_header X-Request-Id      $request_id;
        proxy_set_header Upgrade           $http_upgrade;
        proxy_set_header Connection        $connection_upgrade;
        proxy_read_timeout    180s;   # > GEMINI_TIMEOUT_MS (120s) + retry headroom
        proxy_send_timeout    180s;
        proxy_connect_timeout 10s;
        proxy_request_buffering on;   # keep: shields Node from slow uploads
    }

    location = /api/v1/auth/login {
        limit_req zone=pcare_login burst=5 nodelay;
        proxy_pass http://127.0.0.1:4000;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Request-Id      $request_id;
    }

    location = /api/v1/supplier-invoices {
        limit_req  zone=pcare_upload burst=3 nodelay;
        limit_conn pcare_conn 2;
        proxy_pass http://127.0.0.1:4000;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Request-Id      $request_id;
        proxy_read_timeout 180s;
        proxy_send_timeout 180s;
    }

    # ── Health / readiness (monitored externally)
    location = /health { proxy_pass http://127.0.0.1:4000; access_log off; }
    location = /ready  { proxy_pass http://127.0.0.1:4000; access_log off; }

    # ── Static SPA
    root /srv/pcare/current/frontend/dist;
    index index.html;

    # Hashed filenames -> safe to cache forever.
    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";   # see note below
        try_files $uri =404;
    }

    # index.html must NEVER be cached, or a deploy leaves clients on old JS
    # whose hashed chunks no longer exist.
    location = /index.html {
        expires -1;
        add_header Cache-Control "no-store, must-revalidate";
    }

    location / { try_files $uri $uri/ /index.html; }

    location ~ /\.  { deny all; }   # .env, .git, dotfiles
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name www.pcare-pharma.com;
    ssl_certificate     /etc/letsencrypt/live/pcare-pharma.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/pcare-pharma.com/privkey.pem;
    include             /etc/letsencrypt/options-ssl-nginx.conf;
    return 301 https://pcare-pharma.com$request_uri;
}
```

> **Note on the two `add_header` uses in the static locations.** They *do* suppress the
> server-level headers for those paths. That is acceptable and deliberate: `/assets/*`
> and `index.html` are static files where CSP and HSTS matter less than correct caching
> — but if you would rather not make that trade, repeat the five security headers
> inside both locations. Do not leave it half-done.

**WebSockets: none.** Nothing in the codebase opens one (verified — no `ws`, no
`socket.io`, no Supabase Realtime subscription). The `map` above exists so that adding
one later does not require rediscovering this.

### 5.7 Directory layout — releases, not `git reset --hard`

```text
/srv/pcare/
  releases/
    2026-09-20T1130-<sha>/     <- full checkout + built dist + node_modules
    2026-09-21T0915-<sha>/
  current -> releases/2026-09-21T0915-<sha>     (symlink; nginx root follows it)
  shared/
    .env -> (rendered from SSM, 0600, owner pcare)
```

Rollback is `ln -sfn releases/<previous> current && systemctl reload nginx && pm2 reload pcare-api`
— seconds, and it works even when the new code will not start. `git reset --hard`
gives you no equivalent.

### 5.8 PM2 — corrected `ecosystem.config.js`

```js
module.exports = {
  apps: [{
    name: 'pcare-api',
    script: './backend/src/server.js',
    cwd: '/srv/pcare/current',        // dotenv reads <cwd>/backend/.env via env.js
    instances: 1,
    exec_mode: 'fork',                // NOT cluster: the rate limiter and the
                                      // capabilities probe are per-process state
    autorestart: true,
    watch: false,
    max_memory_restart: '700M',       // was 400M — too tight for 12MB multipart
                                      // buffers + base64 on a 2GB box
    kill_timeout: 12000,              // server.js drains for 10s; PM2's default
                                      // 1600ms SIGKILL would cut it off mid-drain
    listen_timeout: 10000,
    env_production: {
      NODE_ENV: 'production',
      PORT: 4000,
    },
    error_file: '/var/log/pcare/error.log',
    out_file:   '/var/log/pcare/out.log',
    merge_logs: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
  }]
};
```

Setup, in this order:

```bash
sudo mkdir -p /var/log/pcare && sudo chown pcare:pcare /var/log/pcare
sudo -u pcare pm2 start ecosystem.config.js --env production   # --env is MANDATORY
sudo -u pcare pm2 save
sudo env PATH=$PATH pm2 startup systemd -u pcare --hp /home/pcare   # prints a command; run it
sudo -u pcare pm2 install pm2-logrotate
sudo -u pcare pm2 set pm2-logrotate:max_size 10M
sudo -u pcare pm2 set pm2-logrotate:retain 14
sudo -u pcare pm2 set pm2-logrotate:compress true
```

Verify `NODE_ENV` actually took: `pm2 env 0 | grep NODE_ENV`. If it is missing, the
app is leaking stack traces (finding #9).

### 5.9 IAM

* **Root account:** hardware or TOTP MFA, no access keys, used only for billing and
  account-level settings. Never for daily work.
* **Human access:** an IAM user (or IAM Identity Center user — free) with MFA enforced.
  `AdministratorAccess` is acceptable *during build-out*; after go-live, detach it and
  attach a narrower policy, keeping an MFA-protected break-glass admin.
* **Instance role** (`PCareProdInstanceRole`) — no long-lived keys on the box:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "BackupWrite", "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:AbortMultipartUpload"],
      "Resource": "arn:aws:s3:::pcare-backups-<SUFFIX>/*" },
    { "Sid": "BackupListOwnPrefix", "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::pcare-backups-<SUFFIX>" },
    { "Sid": "ReadSecrets", "Effect": "Allow",
      "Action": ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"],
      "Resource": "arn:aws:ssm:ap-south-1:<ACCOUNT_ID>:parameter/pcare/prod/*" },
    { "Sid": "DecryptSecrets", "Effect": "Allow",
      "Action": ["kms:Decrypt"],
      "Resource": "*",
      "Condition": { "StringEquals": { "kms:ViaService": "ssm.ap-south-1.amazonaws.com" } } }
  ]
}
```

Plus the AWS-managed `AmazonSSMManagedInstanceCore` for Session Manager.

Note what is **absent**: no `s3:GetObject` and no `s3:DeleteObject`. The box can write
backups and cannot read or delete them. If the box is compromised, the backups are not.
That is the single most valuable line in this policy.

* **CloudTrail:** the 90-day Event History is on by default and free. That is enough at
  this size. One management-events trail to S3 is also free (you pay only cents of S3);
  add it if you want retention beyond 90 days.

### 5.10 IMDSv2

```bash
aws ec2 modify-instance-metadata-options --instance-id <ID> \
  --http-tokens required --http-endpoint enabled --http-put-response-hop-limit 1 \
  --region ap-south-1
```

`hop-limit 1` is the part that matters: it stops a container or SSRF proxy on the box
from reaching the metadata service and stealing the instance role credentials.

### 5.11 CloudWatch — see §10 for the cost decision

Short version: **use the free basic metrics and free alarms, skip the agent initially**,
and put external uptime monitoring in front of `/health`.

---

## 6. Supabase Architecture

### 6.1 Project

New project in **ap-south-1 (Mumbai)**. Two projects, actually — see §7.1.

**VERIFY FROM ACTUAL ENVIRONMENT — DO NOT ASSUME:** Supabase's free-project limit per
organisation (historically two active free projects). If your org cannot hold two, run
staging first, verify, then *delete* it and create production.

Latency: Mumbai EC2 → Mumbai Supabase is a few milliseconds. This matters more than it
looks, because `authenticate.js:13` calls `supabase.auth.getUser(token)` **on every
single request** and then does a second query for the profile. Tokyo → Mumbai would add
~120 ms to every API call. Moving the database to Mumbai is the single biggest
performance change in this whole plan.

### 6.2 PostgreSQL

Postgres 17. Do not restore the `auth` or `storage` schemas — see §7.2.

Set `pg_trgm` into the `extensions` schema on the new project, not `public`:

```sql
create schema if not exists extensions;
create extension if not exists pg_trgm with schema extensions;
```

Then either qualify the trigram operators or add `extensions` to the search path used
by the functions that need them. **VERIFY:** `match_medicines_trgm` /
`match_suppliers_trgm` both declare `set search_path = public`; they will need
`set search_path = public, extensions`. Test the medicine search before go-live — a
broken trigram match makes the invoice-matching screen silently return nothing.

### 6.3 Auth

Three users. Recreate them through the **Admin API**, never by inserting into
`auth.users` (§7.2 explains why).

Configuration to set in the new project **before** any password-reset test:

| Setting | Value |
|---|---|
| Site URL | `https://pcare-pharma.com` |
| Redirect allow-list | `https://pcare-pharma.com/**` |
| Leaked-password protection | **Enabled** (currently disabled — advisor finding) |
| Minimum password length | 12 or more |
| Email confirmations | Your call; the app creates users via admin API |
| JWT expiry | 3600 s (matches `frontend/src/lib/api.js` assumptions) |

The reset link that lands in an owner's mailbox is built from Site URL. Leaving it at
the default `localhost:3000` is a silent break you will only find when someone forgets
their password.

### 6.4 Storage

One bucket: `supplier-invoices`, **private**.

Verified on the live project: the bucket is private and `storage.objects` has **zero
policies** — so nothing but `service_role` can touch it. That is the correct design
(the API mints short-lived signed URLs, `INVOICE_SIGNED_URL_TTL=900`). Replicate
exactly: create the bucket private, add no policies.

Do **not** migrate the 7 existing test objects.

### 6.5 RLS

Verified on the live project and worth stating plainly because it is better than the
docs suggest: **`anon` and `authenticated` hold zero table or view grants in `public`.**
`schema-29-rls-lockdown.sql` did its job. Everything goes through Express on the
service_role client.

**This does not survive a fresh project automatically.** A new Supabase project grants
`anon`/`authenticated` broad default privileges on `public`. `schema-29` must be
re-applied, and then re-verified with the query in §7.6.

Two gaps `schema-29`/`schema-34` left, both confirmed by the security advisor, both to
fix in `schema-38`:

```sql
revoke all on function public.match_medicines_trgm(text, integer) from public, anon, authenticated;
grant execute on function public.match_medicines_trgm(text, integer) to service_role;
revoke all on function public.is_owner() from public, anon, authenticated;
grant execute on function public.is_owner() to service_role;
```

### 6.6 SSL to Postgres

`supabase-js` speaks HTTPS to PostgREST/GoTrue — TLS is not optional and not
configurable; it is always on. Nothing to do for the application path.

For `pg_dump` (backups) you must pass it explicitly — see §9.2. Supabase requires TLS,
but `sslmode=require` alone does not verify the certificate. Use `verify-full` with the
Supabase CA bundle.

---

## 7. Database Migration Plan

### 7.1 One project or two? — Two, and both free

```text
 Tokyo (sttizzqvsgjpmrwwgpvw)      "the only place some DDL exists"
        |
        | pg_dump --schema-only      (authoritative)
        | + selective data export
        v
 pcare-staging  (Mumbai, Free)     rehearse, verify, run the full test suite here
        |
        | replay the SAME scripted steps
        v
 pcare-prod     (Mumbai, Free)     real pharmacy
```

Cost: **$0.** Both are free-tier. Staging will auto-pause after 7 days idle; that is
fine — restore it on demand when you need to re-run tests.

Keep staging permanently afterwards. The repository explicitly requires a non-production
project for `TEST_OWNER_EMAIL`/`TEST_STAFF_*`, and **your integration suites have never
run** — `backend/.env` currently has no `TEST_*` variables at all (verified). Staging is
where `tests/loose-units.test.js`, `tests/supplier-invoices.test.js` and the concurrency
tests in §12 finally execute for the first time.

### 7.2 Why the previous plan's auth/storage restore was unsafe — and it was

You were right to challenge it. Three independent reasons:

1. **`ON_ERROR_STOP=1` and "duplicate errors are harmless" are mutually exclusive.**
   That is the literal contradiction: the flag exists to abort on the first error. If
   duplicates are expected, the restore stops at the first one, leaving the database
   half-built with no transaction to roll back. If you drop the flag to tolerate them,
   you lose the only signal that something real failed.

2. **`auth` and `storage` are Supabase-managed and versioned.** GoTrue and storage-api
   each run their own migration chains against those schemas at project creation and on
   every platform upgrade. A new Mumbai project may be on a *newer* chain than Tokyo.
   Restoring Tokyo's copy over it produces a schema that neither the running GoTrue
   version nor its next migration expects. The failure mode is not an error at restore
   time — it is authentication breaking weeks later during a platform upgrade.

3. **`auth.users` is not just a table.** It is joined by `auth.identities`,
   `auth.sessions`, `auth.refresh_tokens`, `auth.mfa_factors`, and carries
   `instance_id` and provider metadata. Raw insertion is not a supported operation and
   Supabase documents it as unsupported. For three users, the cost of doing it properly
   is about ten minutes.

**The supported path, for three users:**

```js
// scripts/create-users.js — run once against the NEW project with its service key
const { createClient } = require('@supabase/supabase-js');
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } });

const PEOPLE = [
  { email: 'REAL_OWNER@example.com', role: 'owner', full_name: 'VERIFY' },
  // ...staff
];

for (const p of PEOPLE) {
  const { data, error } = await admin.auth.admin.createUser({
    email: p.email,
    password: process.env[`PW_${p.role.toUpperCase()}`],  // from SSM, never inline
    email_confirm: true,
  });
  if (error) throw error;
  // public.users.id is FK -> auth.users(id) ON DELETE CASCADE (verified).
  // The SAME id must be used, or every created_by reference breaks.
  const { error: e2 } = await admin.from('users').insert({
    id: data.user.id, email: p.email, full_name: p.full_name, role: p.role, is_active: true,
  });
  if (e2) throw e2;
}
```

There is **no trigger on `auth.users`** on the live project (verified), so the
`public.users` row will not appear by itself. You must insert it.

Passwords: set fresh ones for the real pharmacy. Do not try to carry hashes across.

**Storage:** create the bucket via the dashboard or the schema file. Do not restore
`storage.objects` rows — they reference physical objects that do not exist in the new
project's bucket, so every one of them would be a dangling record.

### 7.3 The function that exists nowhere else — capture it first

This is step zero. Before anything else, before you touch the Mumbai project, run this
against Tokyo and commit the output:

```sql
select pg_get_functiondef(p.oid)
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'receive_purchase_atomic';
```

The current live definition (verified today, reproduce exactly) is:

```sql
CREATE OR REPLACE FUNCTION public.receive_purchase_atomic(
  p_purchase_id uuid, p_user_id uuid, p_items jsonb, p_invoice_no text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_po public.purchases%rowtype;
  v_item jsonb;
  v_po_item public.purchase_items%rowtype;
  v_batch_id uuid;
  v_mrp numeric;
  v_sp numeric;
BEGIN
  SELECT * INTO v_po FROM public.purchases WHERE id = p_purchase_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PURCHASE_NOT_FOUND'; END IF;
  IF v_po.status <> 'sent' THEN
    RAISE EXCEPTION 'INVALID_STATUS: only sent orders can be received';
  END IF;
  IF jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'NO_ITEMS: receipt items are required';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    SELECT * INTO v_po_item FROM public.purchase_items
     WHERE id = (v_item->>'purchase_item_id')::uuid AND purchase_id = p_purchase_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'ITEM_NOT_FOUND: purchase item % not on this order', v_item->>'purchase_item_id';
    END IF;

    v_sp  := coalesce(nullif(v_item->>'selling_price', '')::numeric, v_po_item.unit_cost);
    v_mrp := coalesce(nullif(v_item->>'mrp', '')::numeric, v_sp);
    IF v_sp > v_mrp THEN
      RAISE EXCEPTION 'PRICE_EXCEEDS_MRP: selling price cannot exceed MRP';
    END IF;

    INSERT INTO public.inventory_batches
      (medicine_id, batch_no, exp_date, mfg_date, unit_cost, mrp, selling_price,
       supplier_id, po_id, created_by)
    VALUES
      (v_po_item.medicine_id, upper(trim(v_item->>'batch_no')),
       (v_item->>'exp_date')::date, nullif(v_item->>'mfg_date', '')::date,
       v_po_item.unit_cost, v_mrp, v_sp, v_po.supplier_id, p_purchase_id, p_user_id)
    RETURNING id INTO v_batch_id;

    INSERT INTO public.inventory_ledger (batch_id, change_qty, reason, ref_id, note, created_by)
    VALUES (v_batch_id, (v_item->>'qty_received')::int, 'purchase_receipt',
            p_purchase_id, 'PO: ' || v_po.purchase_number ||
            CASE WHEN p_invoice_no IS NOT NULL AND trim(p_invoice_no) <> ''
                 THEN ' (Inv: ' || trim(p_invoice_no) || ')' ELSE '' END, p_user_id);

    UPDATE public.purchase_items
       SET qty_received = (v_item->>'qty_received')::int,
           batch_no = upper(trim(v_item->>'batch_no')),
           batch_id = v_batch_id, mrp = v_mrp, selling_price = v_sp,
           exp_date = (v_item->>'exp_date')::date,
           mfg_date = nullif(v_item->>'mfg_date', '')::date
     WHERE id = v_po_item.id;
  END LOOP;

  UPDATE public.purchases
     SET status = 'received', received_at = now(), received_by = p_user_id,
         invoice_no = nullif(trim(p_invoice_no), '')
   WHERE id = p_purchase_id;
END; $function$;
```

It also needs the column that nothing in the repo creates:

```sql
alter table public.purchases add column if not exists invoice_no text;
```

**Correction to `CLAUDE.md`:** the "Known incomplete work" entry claiming
`receive_purchase_atomic` is broken by an arity mismatch is **stale**. The live database
has the 4-arg function and `purchases.invoice_no`, and there are **3 purchases with
`status = 'received'`** (verified). Goods receiving works. The downstream claim that
`medicine_vendor_prices` source A is empty is therefore also stale.

### 7.4 The actual migration order

Derived from the filesystem and the live database, **not** from `MIGRATION-ORDER.md`.
24 files, in this order:

```text
 1  modules/auth/auth.sql
 2  modules/users/users.sql
 3  modules/categories/categories.sql
 4  modules/medicines/medicines.sql
 5  modules/inventory/inventory.sql
 6  modules/suppliers/schema-06-10.sql
 7  modules/customers/schema-11-14.sql
 8  modules/settings/schema-15-20.sql
 9  modules/chronic-care/schema-21-chronic-care.sql
10  db/schema-22-atomic-workflows.sql
11  modules/supplier-invoices/schema-23-supplier-invoices.sql
12  modules/supplier-invoices/schema-24-invoice-line-detail.sql
13  modules/supplier-invoices/schema-25-pack-contents.sql
14  modules/attendance/schema-26-staff-attendance.sql
15  db/schema-27-loose-units.sql
16  db/schema-28-security-hardening.sql
17  db/schema-29-rls-lockdown.sql
18  modules/stock-requisitions/schema-30-stock-requisitions.sql
        (there is no schema-31)
19  db/schema-32-in-db-aggregations.sql            <- undocumented until now
20  db/schema-33-rls-clean-is-owner.sql            <- undocumented until now
21  db/schema-34-rpc-privilege-hardening.sql       <- undocumented; WILL FAIL without #23
22  db/schema-35-inventory-concurrency-hardening.sql <- undocumented until now
23  modules/notifications/schema-36-notification-dismissals.sql
24  modules/supplier-invoices/schema-37-invoice-tax-detail.sql   <- NOT applied in Tokyo
25  db/schema-38-reconcile-live.sql                <- NEW, you must write it
```

**The ordering problem you must fix before running any of this.** `schema-34` (step 21)
revokes on `receive_purchase_atomic(uuid,uuid,jsonb,text)`, which nothing has created
at that point. Under `ON_ERROR_STOP=1` the run aborts there. Two ways out; take the
first:

* **Preferred:** split `schema-38` in two. Put the `create or replace function` for the
  4-arg `receive_purchase_atomic` and the `alter table purchases add column invoice_no`
  into `schema-31-purchase-receipt-invoice.sql` and run it at position 19 (right after
  schema-30). Then 32→37 run clean, and `schema-38` holds only the new hardening. This
  makes the file sequence tell the truth about what depends on what.
* Alternative: leave `schema-34`'s stray revoke and run that one file without
  `ON_ERROR_STOP`. Do not do this — it defeats the point of the flag for the whole file.

`schema-38-reconcile-live.sql` should then contain, at minimum:

```sql
-- 1. Close the two RPC privilege gaps schema-34 missed (security-advisor confirmed).
revoke all on function public.match_medicines_trgm(text, integer) from public, anon, authenticated;
grant execute on function public.match_medicines_trgm(text, integer) to service_role;
revoke all on function public.is_owner() from public, anon, authenticated;
grant execute on function public.is_owner() to service_role;

-- 2. Pin search_path on the 12 functions the advisor flags. schema-35 rewrote
--    check_no_negative_stock and dropped the setting the original had.
alter function public.handle_updated_at()               set search_path = public, pg_temp;
alter function public.check_staff_limit()               set search_path = public, pg_temp;
alter function public.check_category_limit()            set search_path = public, pg_temp;
alter function public.block_ledger_mutation()           set search_path = public, pg_temp;
alter function public.next_purchase_number()            set search_path = public, pg_temp;
alter function public.next_bill_number()                set search_path = public, pg_temp;
alter function public.next_customer_return_number()     set search_path = public, pg_temp;
alter function public.next_supplier_return_number()     set search_path = public, pg_temp;
alter function public.next_requisition_number()         set search_path = public, pg_temp;
alter function public.check_no_negative_stock()         set search_path = public, pg_temp;
alter function public.check_no_negative_loose_stock()   set search_path = public, pg_temp;
alter function public.is_countable_content(text)        set search_path = public, pg_temp;

-- 3. Expired stock (see §8.3) and the discount floor (see §8.5) land here too.
```

### 7.5 What data moves, and what must not

Verified live counts (Tokyo, today):

| Table | Rows | Migrate? |
|---|---:|---|
| `medicine_categories` | 10 | **Yes** — seeded reference data |
| `chronic_conditions` | 15 | **Yes** — fixed clinical list |
| `pharmacy_settings` | 14 | **Yes, but review every value** — shop name, GST number, thresholds |
| `medicines` | 27 | **Owner's decision** — see below |
| `suppliers` | 6 | **Owner's decision** — see below |
| `customers` | 2 | No — test data, and real patient data must not be invented |
| `users` / `auth.users` | 3 / 3 | Recreate via Admin API (§7.2), not copied |
| `inventory_batches` | 5 | **No** |
| `inventory_ledger` | 28 | **No** |
| `loose_unit_ledger` | 12 | **No** |
| `bills` / `bill_items` | 14 / 16 | **No** |
| `purchases` / `purchase_items` | 3 / 3 | **No** |
| `supplier_invoices` / items | 7 / 74 | **No** |
| Storage objects | 7 | **No** |
| `customer_returns` | 5 | **No** |
| `supplier_returns` | 1 | **No** |
| `staff_attendance` | 5 | **No** |
| `stock_requisitions` | 2 | **No** |
| `notifications` | 12 | **No** |
| `audit_logs` | 327 | **No** — a new pharmacy's trail starts at its first real action |
| `login_attempts` | — | **No** |

On the 27 medicines and 6 suppliers: these are test-catalogue rows. Carrying them means
the pharmacy opens with a catalogue that does not match its shelves, and every one of
them has `created_by` pointing at a user id that will not exist in Mumbai. My
recommendation is to carry **categories, conditions and settings only**, and let the real
catalogue arrive through the first few supplier invoices (Module 23) — which is what that
module is for. If the owner wants a head start, export the 27 as a CSV for review and
re-import the ones that are real, with `created_by` set to the new owner id.

Whatever you choose, the FK rewrite is mandatory:

```sql
-- created_by / updated_by on every carried row must point at a user that exists in Mumbai.
update public.medicines           set created_by = '<NEW_OWNER_UUID>' where created_by is not null;
update public.medicine_categories set created_by = '<NEW_OWNER_UUID>' where created_by is not null;
update public.suppliers           set created_by = '<NEW_OWNER_UUID>' where created_by is not null;
update public.pharmacy_settings   set updated_by = '<NEW_OWNER_UUID>' where updated_by is not null;
```

**Sequences.** Because every transactional table stays empty, the sequences
(`bill_number_seq`, `purchase_number_seq`, `customer_return_seq`, `supplier_return_seq`,
`stock_requisition_seq`, `audit_logs_id_seq`) should start at their defaults — bill
numbering restarts at 1, which is correct for a new pharmacy. Verify anyway (§7.6),
because a partial data copy would break this silently.

### 7.6 Verification — beyond row counts

Run every one of these against **staging** and **production**, and diff the two outputs
against Tokyo where the question is "did the schema come across".

**A. Schema shape**

```sql
-- Columns, types, nullability, defaults — one hash per table.
select table_name,
       md5(string_agg(column_name||':'||data_type||':'||is_nullable||':'||
                      coalesce(column_default,'-'), ',' order by ordinal_position)) as shape
from information_schema.columns
where table_schema='public'
group by table_name order by table_name;
```

**B. Constraints, indexes, triggers**

```sql
select conrelid::regclass::text as tbl, conname, pg_get_constraintdef(oid)
from pg_constraint where connamespace='public'::regnamespace order by 1,2;

select tablename, indexname, indexdef from pg_indexes
where schemaname='public' order by 1,2;

select tgrelid::regclass::text, tgname, pg_get_triggerdef(oid)
from pg_trigger where not tgisinternal
  and tgrelid in (select oid from pg_class where relnamespace='public'::regnamespace)
order by 1,2;
```

**C. Function signatures — the check that would have caught finding #1**

```sql
select p.proname, pg_get_function_identity_arguments(p.oid) as args,
       p.prosecdef, p.proconfig
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname not like 'gtrgm%' and p.proname not like '%_trgm_%'
order by 1,2;
```

Expected, explicitly: `receive_purchase_atomic` present **exactly once**, with
`p_purchase_id uuid, p_user_id uuid, p_items jsonb, p_invoice_no text`. Zero rows or two
rows are both failures.

**D. Views**

```sql
select viewname, md5(pg_get_viewdef(('public.'||viewname)::regclass, true)) from pg_views
where schemaname='public' order by 1;
```

**E. Security posture — must be non-negotiable before go-live**

```sql
-- Must return ZERO rows. Anything here is a PostgREST bypass of the whole API.
select grantee, table_name, privilege_type
from information_schema.role_table_grants
where table_schema='public' and grantee in ('anon','authenticated','public');

-- Must return ZERO rows.
select p.proname, pg_get_function_identity_arguments(p.oid)
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public'
  and (has_function_privilege('anon', p.oid, 'EXECUTE')
    or has_function_privilege('authenticated', p.oid, 'EXECUTE'))
  and p.proname not like '%trgm%' and p.proname not in ('set_limit','show_limit','similarity');

-- RLS on for every table.
select relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relkind='r' and not c.relrowsecurity;   -- expect zero rows
```

**F. Referential integrity and data sanity**

```sql
-- Orphans: run one per FK. Example shape:
select count(*) from public.medicines m
  left join public.medicine_categories c on c.id=m.category_id where c.id is null;   -- 0
select count(*) from public.medicines m
  left join public.users u on u.id=m.created_by where m.created_by is not null and u.id is null;  -- 0

-- Deterministic content checksum for each carried table (order-independent).
select md5(string_agg(t::text, '|' order by t::text)) from public.medicine_categories t;
select md5(string_agg(t::text, '|' order by t::text)) from public.chronic_conditions t;
select md5(string_agg(t::text, '|' order by t::text)) from public.pharmacy_settings  t;

-- Intentional emptiness — every one MUST be 0.
select 'bills' t, count(*) from public.bills union all
select 'bill_items', count(*) from public.bill_items union all
select 'inventory_ledger', count(*) from public.inventory_ledger union all
select 'inventory_batches', count(*) from public.inventory_batches union all
select 'loose_unit_ledger', count(*) from public.loose_unit_ledger union all
select 'purchases', count(*) from public.purchases union all
select 'supplier_invoices', count(*) from public.supplier_invoices union all
select 'customer_returns', count(*) from public.customer_returns union all
select 'audit_logs', count(*) from public.audit_logs;

-- Invariant that must hold forever, checked here for the first time.
select batch_id, sum(change_qty) from public.inventory_ledger
group by batch_id having sum(change_qty) < 0;      -- expect zero rows
select batch_id, sum(change_qty) from public.loose_unit_ledger
group by batch_id having sum(change_qty) < 0;      -- expect zero rows
```

**G. Sequences ahead of max**

```sql
select s.relname,
       pg_sequence_last_value(s.oid) as last_value
from pg_class s join pg_namespace n on n.oid=s.relnamespace
where n.nspname='public' and s.relkind='S' order by 1;
-- For any table you DID copy, assert: sequence last_value >= max(id/number) in that table.
```

**H. Storage and auth**

```sql
select id, public from storage.buckets;                    -- exactly one row, public=false
select count(*) from storage.objects;                      -- 0
select count(*) from pg_policy where polrelid='storage.objects'::regclass;  -- 0
select count(*) from auth.users;                           -- 3 (or however many you created)
select u.id, u.email, p.role, p.is_active
from auth.users u join public.users p on p.id=u.id;        -- every auth user has a profile
```

**I. Application-level verification — the one that actually proves it works**

Point `backend/.env` at staging, add `TEST_*` credentials, and run:

```bash
cd backend && npx jest --runInBand          # ALL suites, not just tests/unit
```

This is the first time these suites will ever have executed against a real database.
Expect failures; they are findings, not noise.

### 7.7 schema-37, specifically

Apply it as step 24, **before the API is started for the first time**. Two reasons that
ordering is not arbitrary:

* `config/capabilities.js:132` probes `supplier_invoices.invoice_type` **once per
  process** and caches the promise. Apply the migration after the API is running and
  every upload silently stores no tax detail until you restart.
* `ingestInvoice` writes the whole header in one insert. On an unmigrated database the
  probe correctly strips the new columns — but you would then have invoices in the
  database with no tax block, and `schema-37` does not backfill them.

Since production starts empty, applying it before first boot means every invoice the
pharmacy ever uploads has the full tax document. That is the whole win.

After applying, verify:

```sql
select count(*) from information_schema.columns
where table_schema='public' and table_name='supplier_invoices' and column_name='invoice_type';  -- 1
select to_regclass('public.supplier_invoice_tax_summary');  -- not null
```

---

## 8. Security Review

### 8.1 What is already right

Worth stating, because it changes where effort should go:

* **RLS lockdown verified effective.** Zero `anon`/`authenticated` grants in `public`.
* **service_role never leaves the server.** `config/supabase.js` is the only reader, and
  the frontend has no Supabase dependency at all — `VITE_API_URL` defaults to `/api/v1`
  (`frontend/src/lib/api.js:64`), relative, same-origin.
* **Bill prices are server-resolved.** `billing.service.js:106` allocates batches and
  prices from `getAvailableBatchesFEFO`; the client sends only `medicine_id`, `qty` and
  `loose_qty`. There is no price-tampering vector.
* **`created_by` always from the JWT** (`authenticate.js:21` → services).
* **SQL injection:** everything goes through PostgREST's parameterised client or
  `$1`-style RPC arguments. No string-concatenated SQL anywhere in the services.
* **Refresh-token rotation is handled correctly**, including writing the rotated token
  back to the cookie (`auth.controller.js:66`).
* **Password-reset enumeration is closed** (`auth.controller.js:85`).
* **Storage bucket is private with no policies** — service_role only, signed URLs with a
  900 s TTL.

### 8.2 P0 — the staff data-exposure fix

**Exact exposure, verified:**

| Endpoint | Guard | Leaks |
|---|---|---|
| `GET /api/v1/inventory/:medicineId/batches` | `authenticate` only | `unit_cost`, `supplier_id`, `po_id` (via `select('*')` on `batches_with_stock`, which expands `inventory_batches.*`) |
| `GET /api/v1/inventory/batch/:batchId` | `authenticate` only | same |
| `GET /api/v1/suppliers` | `authenticate` only | `supplier_balances.total_purchased`, `total_paid` merged in `suppliers.service.js:50` |
| `GET /api/v1/suppliers/:id` | `authenticate` only | full supplier record |

Not exposed (checked, so you do not chase them): `/inventory/:id/available-batches`
selects an explicit column list with no `unit_cost`; `/inventory/` overview reads
`medicines_with_stock`, and `medicines` has no cost column; `/reports/*`,
`/purchases/*`, `/expiry/*`, `/supplier-returns/*` and `/audit-logs` all carry
`router.use(authorize('owner'))`. Modules 23 and 30 are the two documented exceptions.

**The fix — a serializer layer, following Module 30's `presentItem`/`itemSelect` shape**
(the repo already names this the reference pattern):

```js
// backend/src/utils/present.js — new file
//
// The response boundary. A field that is not in the role's allow-list cannot
// leave the process, regardless of what the service selected. Allow-list, never
// deny-list: a column added to a view later is invisible to Staff by default,
// which is the direction an accident should fail in.

const OWNER_ONLY_BATCH_FIELDS = ['unit_cost', 'supplier_id', 'po_id', 'supplier_name'];
const OWNER_ONLY_SUPPLIER_FIELDS = ['total_purchased', 'total_paid', 'balance', 'credit_limit'];

function omitFields(row, fields) {
  if (!row) return row;
  const out = { ...row };
  for (const f of fields) delete out[f];
  return out;
}

const isOwner = (actor) => actor?.role === 'owner';

function presentBatch(row, actor) {
  if (!actor?.role) throw new Error('presentBatch requires an actor'); // fail closed
  return isOwner(actor) ? row : omitFields(row, OWNER_ONLY_BATCH_FIELDS);
}
function presentBatches(rows, actor) { return (rows || []).map((r) => presentBatch(r, actor)); }

function presentSupplier(row, actor) {
  if (!actor?.role) throw new Error('presentSupplier requires an actor');
  return isOwner(actor) ? row : omitFields(row, OWNER_ONLY_SUPPLIER_FIELDS);
}
function presentSuppliers(rows, actor) { return (rows || []).map((r) => presentSupplier(r, actor)); }

module.exports = { presentBatch, presentBatches, presentSupplier, presentSuppliers,
                   OWNER_ONLY_BATCH_FIELDS, OWNER_ONLY_SUPPLIER_FIELDS };
```

Then thread `req.user` through the controllers that call those services, exactly as
`billing.service.getBillById(id, actor)` already does. **`actor` must be required, not
optional** — an optional actor is how a future caller silently reopens this, which is
the argument `utils/authz.js` already makes for `assertCanAccess`.

Two refinements worth making while you are in there:

1. **Prefer narrowing the `select` as well.** `presentBatch` is the guarantee; a
   role-aware column list in `inventory.service.js` means the cost never leaves Postgres
   in the first place. Belt and braces, and cheaper.
2. **Module 23 and 30 keep their exception**, but make it explicit in code — call
   `presentBatch(row, { role: 'owner' })` nowhere; instead let those modules use their
   own presenters, so the exception is visible at the call site rather than inferred
   from its absence.

**Tests that must exist** (`backend/tests/staff-field-exposure.test.js`), one per attack
in your list:

```js
// Runs with a real staff session against staging.
const OWNER_ONLY = ['unit_cost', 'supplier_id', 'po_id', 'total_purchased', 'total_paid'];

function assertNoOwnerFields(payload) {
  const seen = JSON.stringify(payload);
  for (const f of OWNER_ONLY) {
    expect(seen).not.toContain(`"${f}"`);   // deep, not shallow: nested rows count
  }
}

test('TC-A9-01 normal call: staff batch list carries no cost', async () => {
  const res = await request(app).get(`/api/v1/inventory/${medId}/batches`)
    .set('Authorization', `Bearer ${staffToken}`).expect(200);
  assertNoOwnerFields(res.body);
});

test('TC-A9-02 by-id read', async () => { /* /inventory/batch/:id */ });
test('TC-A9-03 supplier list carries no balances', async () => { /* /suppliers */ });
test('TC-A9-04 query-parameter probing cannot re-add fields', async () => {
  // PostgREST-style select smuggling must not be honoured by the Express layer.
  const res = await request(app)
    .get(`/api/v1/inventory/${medId}/batches?select=*,unit_cost&columns=unit_cost`)
    .set('Authorization', `Bearer ${staffToken}`).expect(200);
  assertNoOwnerFields(res.body);
});
test('TC-A9-05 owner DOES receive the fields (proves the test can fail)', async () => {
  const res = await request(app).get(`/api/v1/inventory/${medId}/batches`)
    .set('Authorization', `Bearer ${ownerToken}`).expect(200);
  expect(JSON.stringify(res.body)).toContain('"unit_cost"');
});
test('TC-A9-06 direct PostgREST with the anon key is refused', async () => {
  // The lockdown check, from outside Express entirely.
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/inventory_batches?select=unit_cost`, {
    headers: { apikey: process.env.SUPABASE_ANON_KEY,
               Authorization: `Bearer ${staffToken}` } });
  expect([401, 403, 404]).toContain(r.status);
});
test('TC-A9-07 direct PostgREST RPC is refused', async () => {
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/match_medicines_trgm`, {
    method: 'POST', headers: { apikey: process.env.SUPABASE_ANON_KEY,
      'Content-Type': 'application/json' }, body: JSON.stringify({ p_query: 'a', p_limit: 5 }) });
  expect(r.status).toBeGreaterThanOrEqual(400);   // currently FAILS — see finding #13
});
```

TC-A9-05 matters more than it looks: a field-absence test that can never fail is the
most common way this class of test rots.

TC-A9-06/07 are the "browser devtools / direct REST call" cases from your brief, and
07 currently fails — that is finding #13.

### 8.3 P0 — expired stock and sellable stock

The database must stop treating "in the ledger" as "sellable". Three changes, all in
`schema-38`:

```sql
-- 1. Views gain an explicit vocabulary. total_stock KEEPS its meaning (physical units
--    on the premises) — renaming it would break every caller. sellable_stock is new.
--    Expiry is evaluated with pharmacy_today(), NOT current_date: the database runs in
--    UTC (verified: current_setting('TimeZone') = 'UTC'), so current_date is yesterday
--    in Bengaluru between 00:00 and 05:30 IST.
create or replace view public.medicines_with_stock as
with med_stock as (
  select ib.medicine_id,
         coalesce(sum(il.change_qty), 0)::bigint as total_stock,
         coalesce(sum(il.change_qty) filter (where ib.exp_date >= public.pharmacy_today()), 0)::bigint
           as sellable_stock,
         coalesce(sum(il.change_qty) filter (where ib.exp_date <  public.pharmacy_today()), 0)::bigint
           as expired_stock
  from public.inventory_batches ib
  join public.inventory_ledger il on il.batch_id = ib.id
  group by ib.medicine_id
)
-- ... rest of the view unchanged, but:
--   is_low_stock must derive from SELLABLE, not total:
--   coalesce(ms.sellable_stock,0) < m.low_stock_threshold as is_low_stock
;

-- 2. batches_with_stock: expiry_status must use pharmacy_today() too.
--    (schema-27 lines 363-364, 434-437, 405-406 all use current_date.)

-- 3. The guard that actually stops a sale. create_bill_atomic currently trusts the
--    batch_id it is handed and never looks at exp_date. Add, right after the FOR UPDATE:
--
--    if exists (
--      select 1 from public.inventory_batches b
--      where b.id in (select (i->>'batch_id')::uuid from jsonb_array_elements(p_items) i)
--        and b.exp_date < public.pharmacy_today()
--    ) then
--      raise exception 'EXPIRED_BATCH: cannot dispense stock past its expiry date';
--    end if;
```

Do the same for `approve_customer_return_atomic` only if you want returns of expired
goods blocked — I would **not**: a customer returning an expired strip should still be
recorded, and it goes to write-off, not back to sellable stock. Leave returns alone and
say so in the migration comment, or someone will "fix" it later.

**On "reserved stock":** you asked whether to model it. **No — not now.** There is no
concept of a held cart or a pending order in this application; a bill is created in one
atomic RPC. A reserved-stock column would be a fourth quantity with no writer and no
reader, and "nothing stored that can be computed" is the rule this schema lives by. Add
it when (and only when) a workflow exists that holds stock across requests.

Also fix the JS side (finding #7) in the same change, or the view fix is undone by the
application:

```js
// inventory.service.js — replace SEVEN call sites
const { getISTDateString } = require('../../utils/date');
// was: new Date().toISOString().slice(0, 10)
// now: getISTDateString()
```

### 8.4 Authentication, cookies, CORS, CSRF

**Cookies.** `auth.controller.js:18-24` is correct for the single-origin deployment:
`httpOnly`, `secure` (in production — see finding #9), `sameSite: 'strict'`,
`path: '/api/v1/auth'`, 7-day `maxAge`.

**Do not set `Domain=.pcare-pharma.com`** — you are right to avoid it, and the reason is
concrete: a domain-scoped cookie is sent to *every* subdomain, so anything you ever host
at `staging.pcare-pharma.com` or a future `shop2.pcare-pharma.com` receives the
pharmacy's refresh token. Host-only (the default when `domain` is omitted) is correct.
The code already omits it. Keep it that way.

**CSRF.** `sameSite: 'strict'` on the only credential the browser sends automatically is
a sufficient control here, *given* that the access token travels in an `Authorization`
header (which no browser attaches cross-site on its own). The one thing to preserve: the
refresh endpoint is the only cookie-authenticated route, and it is `POST`. If anyone ever
adds a cookie-authenticated `GET` that mutates state, this argument collapses. Worth a
comment in `auth.routes.js`.

**CORS.** With nginx serving both halves on one origin, CORS is vestigial — the browser
never makes a cross-origin request. But `FRONTEND_URL` still gates `cors()` in
`app.js:47`, so set it to **exactly** `https://pcare-pharma.com` — no trailing slash, no
`www`. A trailing slash makes the origin string never match and turns a future
cross-origin call into an opaque failure.

**XSS.** React escapes by default; no `dangerouslySetInnerHTML` in the codebase. The
remaining defence is the CSP in §5.6 (finding #15). The access token lives in JS memory,
so an XSS would steal it — but the refresh token is `httpOnly` and cannot be read, which
caps the blast radius at one hour. That design is correct; the CSP closes the rest.

### 8.5 P1 — the discount hole

Verified: `billing.routes.js:32` allows any non-negative `discount_amount`, and
`bills_with_totals.total = subtotal − discount_amount` with no floor. Any staff account
can create a bill with a negative total, and it flows into `daily_sales_summary`.

```sql
-- In create_bill_atomic, after the bill_items insert and before the ledger writes:
declare v_subtotal numeric;
...
select coalesce(sum(qty * unit_price), 0) into v_subtotal
  from public.bill_items where bill_id = v_bill_id;
if coalesce((p_bill->>'discount_amount')::numeric, 0) > v_subtotal then
  raise exception 'DISCOUNT_EXCEEDS_TOTAL: discount cannot exceed the bill subtotal';
end if;
```

Plus a route-level ceiling, and — a business control worth having from day one — cap
staff discounts at a percentage held in `pharmacy_settings`, with owner override.

### 8.6 SSRF and path traversal

* **SSRF:** the only outbound URL the app constructs from data is the Gemini endpoint,
  which is built from `config.gemini.model` (an env var, not user input). Supabase
  Storage paths are server-generated. No user-supplied URL is ever fetched. **No SSRF
  surface.** The IMDS hop-limit of 1 (§5.10) is the backstop if that ever changes.
* **Path traversal:** no user input reaches the filesystem. Uploads use
  `multer.memoryStorage()` and go straight to Supabase Storage. Downloads
  (Module 30 exports) are generated in memory. `express.static` serves a fixed directory.
  nginx `location ~ /\. { deny all; }` covers dotfiles. **No traversal surface.**

### 8.7 File uploads

MIME allow-list (`ACCEPTED_MIME`) is enforced on `file.mimetype`, which is
**client-supplied**. That is fine here because the file never executes and never lands
on disk — but it means a `.exe` renamed and declared as `application/pdf` reaches Gemini,
which will simply fail to read it. Optional hardening: sniff the magic bytes
(`%PDF-`, `\xFF\xD8\xFF`, `\x89PNG`, `RIFF....WEBP`) and reject on mismatch. P2.

Two real limits already in place and correct: `files: 1` and
`fileSize: config.invoices.maxUploadBytes`.

### 8.8 Rate limiting and Gemini cost control (finding #11)

Three layers, because each catches something the others miss:

```js
// backend/src/modules/supplier-invoices/supplier-invoices.routes.js
const rateLimit = require('express-rate-limit');

// Keyed on the USER, not the IP — the whole pharmacy shares one shop IP, which is
// exactly why app.js:96 had to raise its own login limiter to 40.
const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => req.user?.id || req.ip,
  message: { error: 'RATE_LIMITED',
             message: 'Too many invoice uploads in the last hour. Try again shortly.' },
  standardHeaders: true, legacyHeaders: false,
});

// One extraction at a time. Two 12MB buffers plus base64 plus V8 on a 2GB box with
// max_memory_restart at 700M is how you get an OOM restart mid-upload — after the
// Storage write and the Gemini call have already been paid for.
let inFlight = 0;
const MAX_CONCURRENT_EXTRACTIONS = 1;
const extractionSlot = (req, res, next) => {
  if (inFlight >= MAX_CONCURRENT_EXTRACTIONS) {
    return next(new AppError(
      'Another invoice is being read right now. Please wait for it to finish.',
      429, 'EXTRACTION_BUSY'));
  }
  inFlight += 1;
  res.on('finish', () => { inFlight -= 1; });
  res.on('close',  () => { inFlight -= 1; });   // client hung up mid-extraction
  next();
};

router.post('/', authorize('owner','staff'), uploadLimiter, extractionSlot, acceptUpload, controller.upload);
```

> **Careful with the `finish`/`close` pair** — both can fire for one request. Use a
> one-shot guard (`let released = false`) so the counter cannot go negative, or the
> semaphore drifts open over time. Write the test for it.

Plus the nginx `limit_req zone=pcare_upload` and `limit_conn 2` from §5.6, and — the
layer that actually bounds the money — **a spend cap on the Google side**:

**VERIFY FROM ACTUAL ENVIRONMENT — DO NOT ASSUME:** set a budget alert and a quota cap
on the Gemini API key in Google AI Studio / Google Cloud. An application-level limiter
protects against your own users; only a provider-side cap protects against a leaked key.

Practical numbers for a single pharmacy at ~20 invoices/month: 10/hour/user, 40/day
account-wide, 1 concurrent. Generous by an order of magnitude and still a hard ceiling.

### 8.9 Environment variables and secrets

See §5.9 and the table in §11. The rules, restated as assertions you can test:

```bash
# .env must never be readable by anyone but the app user
stat -c '%a %U:%G' /srv/pcare/current/backend/.env     # expect: 600 pcare:pcare

# .env must never be reachable over HTTP
curl -sS -o /dev/null -w '%{http_code}\n' https://pcare-pharma.com/backend/.env   # 404
curl -sS -o /dev/null -w '%{http_code}\n' https://pcare-pharma.com/.env           # 403 or 404

# The service key must never appear in the built bundle
grep -rc "service_role\|SUPABASE_SERVICE_KEY" /srv/pcare/current/frontend/dist/   # 0 everywhere

# No VITE_ variable may carry a secret
grep -rn "VITE_" /srv/pcare/current/frontend/dist/assets/*.js | head
```

The frontend currently reads **only** `VITE_API_URL` (and `import.meta.env.DEV`).
**Do not set `VITE_API_URL` in production** — the default `/api/v1` is relative and
same-origin, which is exactly what you want. Setting it to an absolute URL would turn
every API call cross-origin and break `sameSite: 'strict'`.

### 8.10 GitHub

**VERIFY FROM ACTUAL ENVIRONMENT — DO NOT ASSUME:** the remote is
`https://github.com/RoopeshMerwade/PCare-Pharma.git` on branch `main`. Confirm the
repository is **private**. `.env` is correctly untracked (verified).

Required before the first deploy:
* MFA on the GitHub account.
* Branch protection on `main`: require a pull request, block force-push, block deletion,
  require status checks (`cd backend && npx jest tests/unit --runInBand` and
  `cd frontend && npm run check` — both run with no credentials).
* Enable secret scanning and push protection (free on public repos; on private repos it
  requires GitHub Advanced Security — **VERIFY** your plan).
* A read-only **deploy key** on the EC2 box, not a personal access token.
* Deploy from a **tag**, not from `main`'s tip.

---

## 9. Backup / Disaster Recovery

### 9.1 Is Supabase Free acceptable? — Yes, but only with everything below

Not a yes or a no; here is the actual risk ledger.

**What Free does not give you:** no automated backups, no point-in-time recovery, and
projects pause after 7 days of inactivity (production will never be idle; staging will,
which is fine). **VERIFY FROM ACTUAL ENVIRONMENT — DO NOT ASSUME:** re-read Supabase's
current plan page; these terms change.

**What that means concretely.** If the project is deleted — by a billing lapse, a
mis-click, a support error, or a compromised dashboard login — there is nothing to
restore from on Supabase's side. Your recovery point is whatever you last copied out
yourself. For a pharmacy that is legally required to retain sale records, that is not a
theoretical concern.

**The honest recommendation:** start on Free with the backup regime below, and budget
Supabase Pro ($25/month) within three months — roughly when the accumulated sales data
becomes something you would genuinely be unable to reconstruct. Pro buys 7-day daily
backups, no pausing, and a real support channel. At that point the $25 is cheap next to
what it insures.

Free is acceptable **today** because the database is empty. It stops being acceptable at
about the point where a month of billing exists.

### 9.2 PostgreSQL — nightly logical backup

Two gotchas that will each cost you an evening if you hit them cold:

* **`pg_dump` version.** Ubuntu 24.04 ships `postgresql-client-16`. Supabase runs
  Postgres **17.6.1** (verified). `pg_dump` refuses to dump a newer server. Add the PGDG
  repository and install `postgresql-client-17`.
* **IPv4 vs IPv6.** Supabase's direct database host (`db.<ref>.supabase.co`) is
  IPv6-only on newer projects, and a default-VPC EC2 instance has no IPv6. Use the
  **session-mode pooler** (port 5432, `…pooler.supabase.com`), which is IPv4. The
  transaction-mode pooler (6543) does not work for `pg_dump`.
  **VERIFY FROM ACTUAL ENVIRONMENT — DO NOT ASSUME** the exact pooler hostname; copy it
  from the new project's Database settings page.

```bash
# /usr/local/bin/pcare-backup-db.sh   (chmod 700, owner root)
set -euo pipefail
export PGSSLMODE=verify-full
export PGSSLROOTCERT=/etc/pcare/supabase-ca.crt      # download from the Supabase dashboard
STAMP=$(TZ=Asia/Kolkata date +%F_%H%M)
OUT=/var/backups/pcare/db-${STAMP}.dump

# Credentials from SSM — never on the command line (ps shows it) and never in the script.
PGPASSWORD=$(aws ssm get-parameter --name /pcare/prod/DB_PASSWORD --with-decryption \
             --query Parameter.Value --output text --region ap-south-1)
export PGPASSWORD

mkdir -p /var/backups/pcare
pg_dump --host="$PCARE_DB_HOST" --port=5432 --username="$PCARE_DB_USER" \
        --dbname=postgres --schema=public \
        --format=custom --compress=9 --no-owner --no-privileges \
        --file="$OUT"

# Schema-only companion: small, diffable, and the thing that catches DDL drift.
pg_dump --host="$PCARE_DB_HOST" --port=5432 --username="$PCARE_DB_USER" \
        --dbname=postgres --schema=public --schema-only --no-owner --no-privileges \
        --file="/var/backups/pcare/schema-${STAMP}.sql"

aws s3 cp "$OUT" "s3://pcare-backups-<SUFFIX>/db/${STAMP}.dump" --region ap-south-1
aws s3 cp "/var/backups/pcare/schema-${STAMP}.sql" \
          "s3://pcare-backups-<SUFFIX>/schema/${STAMP}.sql" --region ap-south-1

find /var/backups/pcare -type f -mtime +3 -delete    # local copies are a cache, not the backup
unset PGPASSWORD
```

Schedule at **02:00 IST** (`30 20 * * *` UTC — the shop is shut).

### 9.3 Supabase Storage — separate job, separate failure mode

The invoice PDFs are not in the database and no database backup covers them. They are
the *original documents* behind every batch of stock, which is exactly what a recall or
a GST audit asks for.

```js
// /usr/local/lib/pcare-backup-storage.js — run nightly after the DB dump
// Lists the private bucket and mirrors new objects into S3. ~20 files/month at <=12MB.
const { createClient } = require('@supabase/supabase-js');
// list from storage.from(BUCKET).list(prefix, {limit:1000}) recursively,
// download with .download(path), PutObject to s3://pcare-backups-<SUFFIX>/storage/<path>
// Skip objects already present (HeadObject) so the job is idempotent and cheap.
```

### 9.4 S3 bucket configuration

```bash
aws s3api create-bucket --bucket pcare-backups-<SUFFIX> --region ap-south-1 \
  --create-bucket-configuration LocationConstraint=ap-south-1
aws s3api put-public-access-block --bucket pcare-backups-<SUFFIX> \
  --public-access-block-configuration \
  "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"
aws s3api put-bucket-encryption --bucket pcare-backups-<SUFFIX> \
  --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"},"BucketKeyEnabled":true}]}'
aws s3api put-bucket-versioning --bucket pcare-backups-<SUFFIX> \
  --versioning-configuration Status=Enabled
```

Lifecycle: expire `db/` and `storage/` objects after 30 days, expire noncurrent versions
after 30 days, and abort incomplete multipart uploads after 7 days.

**Object Lock:** it can only be enabled **at bucket creation**, never afterwards. If you
want immutability — and for a ransomware scenario it is the only thing that helps — you
must decide now. Recommendation: create a **second** bucket, `pcare-backups-lock-<SUFFIX>`,
with Object Lock in **compliance** mode and a 35-day retention, and write only the
**weekly** full dump there. Governance mode can be overridden by anyone with
`s3:BypassGovernanceRetention`; compliance mode cannot be overridden by anyone,
including the root account. That is the point.

Note this interacts with the IAM policy in §5.9: the instance role has `PutObject` and
**no** `DeleteObject`. Combined with versioning, a compromised box cannot destroy
history even in the non-locked bucket.

### 9.5 EC2 backup — separate, and not a substitute

You are right that EC2 snapshots do not back up Supabase. They back up exactly three
things worth having: `/etc/letsencrypt`, `/etc/nginx`, and the rendered `.env`.

Weekly EBS snapshot via **Data Lifecycle Manager** (DLM itself is free; you pay ~$0.05/GB-month
for snapshot storage, so roughly **$0.30/month** for a 20 GB volume with incrementals).
Retain 4.

Keep the three backup domains mentally separate, as you said:

| Domain | Tool | Frequency | Retention | Proves |
|---|---|---|---|---|
| Database | `pg_dump` → S3 | nightly 02:00 IST | 30 days + weekly locked 35 days | Sales, stock, ledger |
| Storage | Node sync → S3 | nightly 02:30 IST | 30 days | Original invoice documents |
| EC2 host | EBS snapshot (DLM) | weekly | 4 | Certs, nginx config, env |

### 9.6 Restore procedure — and the rehearsal that makes it real

**A backup that has never been restored is not a backup.** Rehearse this on staging
before go-live, and again one month after:

```bash
# 1. Fetch the artefact
aws s3 cp s3://pcare-backups-<SUFFIX>/db/<STAMP>.dump ./restore.dump

# 2. Restore into the STAGING project (never production)
pg_restore --host=<STAGING_POOLER_HOST> --port=5432 --username=<USER> \
           --dbname=postgres --no-owner --no-privileges --clean --if-exists \
           --single-transaction restore.dump
#    --single-transaction is what makes a failed restore leave nothing behind.

# 3. Verify with §7.6 checks A–G against the restored copy.
# 4. Point a local backend at staging and run:  npx jest --runInBand
# 5. Record the wall-clock time. That number is your RTO. Write it down.
```

Recovery objectives to state explicitly and hold yourself to:

* **RPO: 24 hours** (nightly dump). If a day of billing is too much to lose, the answer
  is Supabase Pro with PITR, not a more frequent `pg_dump`.
* **RTO: target under 2 hours** — new Supabase project, restore, repoint `.env`, restart
  PM2. Measure it in the rehearsal; do not assume it.

### 9.7 Backup monitoring

A silent backup failure is worse than no backup, because you believe you are covered.

```bash
# At the end of pcare-backup-db.sh, on success:
aws cloudwatch put-metric-data --namespace PCare --metric-name BackupSuccess \
  --value 1 --region ap-south-1
```

Then a CloudWatch alarm on `BackupSuccess` with `TreatMissingData: breaching` over a
26-hour period → SNS → your email. That alarm fires when the backup **does not run**,
which is the case a success-notification email would never catch.

Cost: one custom metric ($0.30/month) + one alarm ($0.10/month). Worth it.

---

## 10. Cost Estimate

Using **$100 total promotional credit, ~$89 remaining**.

**VERIFY FROM ACTUAL ENVIRONMENT — DO NOT ASSUME:** every figure below must be confirmed
against the AWS Pricing Calculator for `ap-south-1`, and — critically — **check the
expiry date on the promotional credit in Billing → Credits.** Promotional credits
typically expire 12 months from issue regardless of balance.

### 10.1 Recommended production architecture

| Service | Spec | Est. $/month | Avoidable? | Cheaper option | Uses credit? |
|---|---|---:|---|---|---|
| EC2 | t4g.small, on-demand, 730 h | **~13–15** | No | t4g.micro (~7) — but 1 GB OOMs on `vite build`; reserved instance saves ~30 % but locks 1 yr | Yes |
| EBS | 20 GB gp3 | **~1.6–1.9** | No | 16 GB (~1.3) — not worth the headroom loss | Yes |
| Public IPv4 | 1 Elastic IP, 730 h @ $0.005 | **~3.65** | No, while publicly reachable | None | Yes |
| S3 | ~2 GB backups + requests | **~0.10** | No | — | Yes |
| EBS snapshots | 20 GB weekly, DLM | **~0.30** | Yes (P2) | Drop it; rebuild from the deploy script | Yes |
| CloudWatch | 3 alarms + 1 custom metric | **~0.60** | Partly | Free basic metrics only (~0.30) | Yes |
| CloudWatch agent | mem + disk metrics | **~1.20** | Yes | External monitoring only | Yes |
| Data transfer out | < 10 GB | **~0** | — | First 100 GB/mo free | — |
| CloudTrail | Event history / 1 trail | **~0** | — | Free tier | — |
| SSM Parameter Store | Standard params | **$0** | — | Free (vs Secrets Manager ~2.40) | — |
| **AWS subtotal** | | **~$20–23/mo** | | | |
| Supabase | Free tier | **$0** | | Pro $25/mo (not credit-eligible) | **No** |
| Domain | pcare-pharma.com | ~$1/mo amortised | No | | **No** |
| Gemini | ~20 invoices/mo | ~$0–1 | | Free tier may cover it | **No** |

### 10.2 Runway

```text
Remaining credit                $89
Recommended architecture        ~$21/month
Runway                          ~4.2 months
```

Minimum-cost variant (drop the CloudWatch agent, drop EBS snapshots, keep 3 free-metric
alarms): **~$19/month → ~4.7 months**. The difference is under $2.50/month — do not
compromise monitoring for it.

**After credit exhaustion, budget roughly ₹1,800–2,100/month** for AWS, plus ₹2,100/month
if you move Supabase to Pro. Set an **AWS Budget alert at $15/month and $25/month on day
one**, before you launch anything. That is the single cheapest insurance in this document.

### 10.3 Minimum-cost architecture vs recommended — the trade

| | Minimum cost (~$19/mo) | Recommended (~$21/mo) |
|---|---|---|
| Compute | t4g.small | t4g.small |
| Monitoring | 3 free-metric CloudWatch alarms + free external uptime check | + agent for memory and disk |
| Host backup | none (rebuild from deploy script) | weekly EBS snapshot |
| DB backup | nightly `pg_dump` → S3 | same + weekly copy to an Object-Locked bucket |
| Supabase | Free | Free now, Pro within 3 months |
| **What you lose** | You find out the disk is full when the app dies; a lost box means rebuilding certs and nginx by hand | — |

The minimum-cost variant is defensible. It is **not** defensible to cut the nightly
`pg_dump`, the S3 bucket, or the restore rehearsal — those are the difference between a
bad day and a closed pharmacy.

### 10.4 Things that would blow the budget, and why they are excluded

* **CloudFront** (~$1–5/mo + complexity): a CDN for users who are all in one shop in one
  city, served from a region in the same country. No.
* **Application Load Balancer** (~$16–20/mo): the only thing that would make ACM usable.
  Nearly doubles the bill to replace a free Let's Encrypt certificate. No.
* **RDS** (~$15–30/mo): you already have a managed Postgres. No.
* **Secrets Manager** (~$2.40/mo for 6 secrets): SSM Parameter Store is free and
  sufficient. No.
* **NAT Gateway** (~$35/mo): only needed for private subnets. Your instance has a public
  IP. Absolutely not — this is the most common way a small AWS account burns its credit.

---

## 11. Exact Deployment Sequence

Your ordering was close. The corrections: AWS account setup and the budget alarm move to
the front; EBS default encryption must precede instance launch; DNS goes in immediately
after the Elastic IP; and the restore test happens on staging **before** production
exists, not after go-live.

Each step: **what / where / why / expected result / verify / rollback.**

---

**Phase 0 — Preserve what only exists in one place**

**Step 0.** Capture the live Tokyo schema before anything else.
*Where:* your workstation, against project `sttizzqvsgjpmrwwgpvw`.
*Why:* `receive_purchase_atomic(…,text)` and `purchases.invoice_no` exist in no file.
*Do:* `pg_dump --schema-only --schema=public --no-owner --no-privileges` → commit as
`docs/db/tokyo-schema-snapshot-2026-09-12.sql`. Also run the §7.6-C function query and
save the output.
*Expected:* a file containing the 4-arg function body.
*Verify:* `grep -c "p_invoice_no text" tokyo-schema-snapshot-*.sql` ≥ 1.
*Rollback:* n/a — read-only.
*Do not delete or pause the Tokyo project until §11 step 6 has passed.*

---

**Phase 1 — Code (P0 fixes, before any infrastructure)**

**Step 1.** Fix the eleven P0 code/config items.
*Where:* the repository, on a branch, merged via PR.
*Items:* staff field exposure (§8.2), expiry guard + `sellable_stock` (§8.3), the seven
UTC→IST call sites (§8.3), upload rate limit + semaphore (§8.8), discount floor (§8.5),
`schema-31` + `schema-38` (§7.3, §7.4), nginx config (§5.6), PM2 config (§5.8),
`engines` pins.
*Expected:* `cd backend && npx jest tests/unit --runInBand` green;
`cd frontend && npm run check` green.
*Verify:* the new `tests/staff-field-exposure.test.js` fails against the *old* code and
passes against the new. If it passes against both, the test is wrong.
*Rollback:* revert the branch.

**Step 2.** Rewrite `docs/MIGRATION-ORDER.md` from the §7.4 list, and correct the stale
`receive_purchase_atomic` entry in `CLAUDE.md`.
*Why:* the next person to rebuild this database will follow that document.

---

**Phase 2 — Database (staging first)**

**Step 3.** Create `pcare-staging` in Supabase, region ap-south-1 (Mumbai).
*Verify:* `select current_setting('TimeZone')` → `UTC` (expected; the app handles IST).
*Rollback:* delete the project.

**Step 4.** Apply migrations 1–25 in the §7.4 order, one file at a time, with
`ON_ERROR_STOP=1`.
*Why one at a time:* you need to know which file failed.
*Expected:* 24 clean applications plus `schema-38`.
*Verify:* §7.6 checks A–E. In particular the function query must show
`receive_purchase_atomic` **exactly once** with four arguments.
*Rollback:* delete the project and start again — it is free and empty.

**Step 5.** Create the 3 auth users via the Admin API script (§7.2), then the matching
`public.users` rows.
*Verify:* `select u.id, u.email, p.role from auth.users u join public.users p on p.id=u.id;`
returns one row per person.

**Step 6.** Import master data (§7.5) and rewrite the `created_by` FKs.
*Verify:* §7.6 check F — every orphan query returns 0, every "intentional emptiness"
count is 0, and the content checksums match Tokyo for the tables you carried.

**Step 7.** Point a local backend at staging (`backend/.env` with `TEST_*` credentials)
and run the **entire** test suite — the first time it has ever run.
*Do:* `cd backend && npx jest --runInBand`
*Expected:* failures. Triage each one; they are findings.
*This is the gate.* Do not create the production project until this is green.

**Step 8.** Rehearse the restore (§9.6) into a scratch database. Record the RTO.

---

**Phase 3 — AWS account**

**Step 9.** Account hygiene, before launching anything.
*Do:* MFA on root; no root access keys; create an IAM admin user with MFA; **set AWS
Budget alerts at $15 and $25**; enable EBS encryption by default in ap-south-1.
*Verify:* `aws ec2 get-ebs-encryption-by-default --region ap-south-1` → `true`.
*Why now:* the encryption default cannot be applied to a volume retroactively.

**Step 10.** Create the S3 backup buckets (§9.4) and the instance role (§5.9).
*Verify:* `aws s3api get-public-access-block` shows all four flags true.

**Step 11.** Launch EC2: Ubuntu 24.04 LTS arm64, t4g.small, 20 GB gp3, the instance role
attached, IMDSv2 required at launch, SG with 80/443 open and 22 from your IP.
*Verify:* `aws ec2 describe-instances --query '…MetadataOptions'` → `HttpTokens: required`.

**Step 12.** Allocate and associate the Elastic IP.
*Verify:* `curl -s http://<EIP>` — connection refused is correct (nothing listening yet).
*Rollback:* release the EIP (remember it bills whether attached or not).

---

**Phase 4 — DNS (as early as possible, so propagation overlaps the rest)**

**Step 13.** Create the A, CAA, SPF and DMARC records at Spaceship (§4.1) with TTL 300.
*Verify:* `dig +short @1.1.1.1 pcare-pharma.com` returns the EIP.
*Rollback:* delete the records; with TTL 300 the world forgets in five minutes.

---

**Phase 5 — Host**

**Step 14.** Harden the OS.
*Do:* create the `pcare` user; swap file (§5.1); `unattended-upgrades` with
`Automatic-Reboot-Time "22:00"` UTC (03:30 IST, shop shut); SSH hardening in
`/etc/ssh/sshd_config.d/00-pcare-hardening.conf` — note the **first** matching directive
wins and Ubuntu's `50-cloud-init.conf` is read before a `99-` file, which is why the
filename starts with `00`; `fail2ban`; UFW (§5.5); confirm SSM Session Manager works,
then remove the port-22 SG rule.
*Verify:* `sshd -T | grep -E 'passwordauthentication|permitrootlogin'` → both `no`.
Open an SSM session successfully **before** closing port 22.
*Rollback:* re-add the SG rule from the console.

**Step 15.** Install Node 22, nginx, certbot, `postgresql-client-17` (PGDG repo), PM2,
AWS CLI.

**Step 16.** Deploy the application to `/srv/pcare/releases/<sha>` and symlink `current`.
Render `backend/.env` from SSM (mode 600, owner `pcare`). Build the frontend.
*Verify:* `stat -c '%a %U' backend/.env` → `600 pcare`; `ls frontend/dist/index.html`.
*Rollback:* repoint the `current` symlink.

**Step 17.** Start PM2 with `--env production`, configure `startup` and `logrotate` (§5.8).
*Verify:* `curl -s localhost:4000/health` → `{"status":"ok",…}`;
`curl -s localhost:4000/ready` → `{"status":"ready"}`; `pm2 env 0 | grep NODE_ENV` →
`production`.
*Rollback:* `pm2 delete pcare-api`.

---

**Phase 6 — TLS and the public edge**

**Step 18.** Install the **phase-1** nginx config (HTTP only, with the ACME location).
*Verify:* `nginx -t` passes — this is the step where the old template would have failed.
`curl -I http://pcare-pharma.com/.well-known/acme-challenge/probe` reaches nginx.

**Step 19.** Issue the certificate.
```bash
sudo mkdir -p /var/www/certbot
sudo certbot certonly --webroot -w /var/www/certbot \
  -d pcare-pharma.com -d www.pcare-pharma.com \
  --email <YOUR_EMAIL> --agree-tos --no-eff-email --dry-run   # DRY RUN FIRST
# then re-run without --dry-run
```
*Verify:* `sudo certbot certificates` lists both names with ~89 days remaining.
*Rollback:* nothing to roll back; a failed issuance changes nothing. Mind the 5-failures-per-hour limit.

**Step 20.** Install the **phase-2** nginx config (§5.6) with the 443 blocks and the
computed CSP hash. Reload.
*Verify:* `nginx -t`; `curl -I https://pcare-pharma.com` → 200 with all security headers;
`curl -I http://pcare-pharma.com` → 301; `curl -I https://www.pcare-pharma.com` → 301.
*Rollback:* `cp` the phase-1 file back and reload.

**Step 21.** Configure renewal.
```bash
sudo systemctl list-timers | grep certbot          # timer must exist
sudo certbot renew --dry-run                       # must succeed
echo 'post_hook = systemctl reload nginx' | sudo tee -a /etc/letsencrypt/cli.ini
```
*Why the hook matters:* certbot renews the file on disk; nginx keeps serving the old
certificate in memory until it is reloaded. Without the hook the site goes down 90 days
after go-live, at a moment nobody connects to a certificate renewal.

---

**Phase 7 — Production database, then cutover**

**Step 22.** Create `pcare-prod` (Mumbai) and replay steps 4–6 *exactly as scripted*.
*Why after the host:* so the Supabase Site URL can be set to a domain that already
resolves and serves.
*Verify:* the whole of §7.6 again, against production.

**Step 23.** Configure Supabase Auth for production (§6.3) — Site URL, redirect
allow-list, leaked-password protection, password length.
*Verify:* trigger a real password reset and confirm the link points at
`https://pcare-pharma.com`.

**Step 24.** Repoint `backend/.env` (via SSM) at the production project. Restart PM2.
*Why a restart and not a reload:* `config/capabilities.js` caches its probes per process.
*Verify:* `/ready` returns ready; the logs show no "columns not found" warnings — if any
appear, a migration is missing.

**Step 25.** Enable backups: install both cron jobs, run each **manually once**, confirm
the objects land in S3, and set up the `BackupSuccess` alarm (§9.7).

**Step 26.** Run the production smoke tests and security tests in §12.

**Step 27.** Raise HSTS `max-age` to `31536000` — **only after** a week of stable HTTPS.
Do not add `preload`.

**Step 28.** Go live: the owner signs in, sets `pharmacy_settings`, and enters opening
stock. Raise DNS TTL to 3600.

**Step 29.** One week later: re-run the restore rehearsal against **real** data.

---

## 12. Production Testing

### 12.1 Smoke (must pass before the owner touches it)

```bash
curl -sSI https://pcare-pharma.com | head -1                       # 200
curl -sSI http://pcare-pharma.com | head -1                        # 301
curl -sSI https://www.pcare-pharma.com | head -1                   # 301 to apex
curl -sS  https://pcare-pharma.com/health | jq .                   # status ok
curl -sS  https://pcare-pharma.com/ready  | jq .                   # status ready
curl -sSI https://pcare-pharma.com/assets/index-*.js | grep -i cache-control   # immutable
curl -sSI https://pcare-pharma.com/ | grep -i cache-control        # no-store
curl -sSI https://pcare-pharma.com/ | grep -i content-security     # present
curl -sS -o /dev/null -w '%{http_code}\n' https://pcare-pharma.com/api/v1/nope   # 404 JSON
curl -sS https://pcare-pharma.com/api/v1/medicines | jq -r .error   # TOKEN_MISSING
```

Then, in a browser: log in as owner, log in as staff, create a bill, upload an invoice,
download a requisition export, log out, and confirm the refresh flow by leaving a tab
idle for over an hour.

### 12.2 Security tests

```bash
# 1. Node must not be reachable from outside.
curl -m 5 http://<EIP>:4000/health          # must TIME OUT, not answer

# 2. No stack traces. (Catches finding #9 — the PM2 --env mistake.)
curl -sS https://pcare-pharma.com/api/v1/auth/login \
     -H 'Content-Type: application/json' -d '{"bad":' | jq .
#    expect {"error":"INVALID_JSON",...} with NO "stack" key

# 3. Secrets are not served.
for p in /.env /backend/.env /.git/config /ecosystem.config.js; do
  echo -n "$p "; curl -s -o /dev/null -w '%{http_code}\n' "https://pcare-pharma.com$p"
done                                          # all 403 or 404

# 4. Service key is not in the bundle.
curl -s https://pcare-pharma.com/assets/index-*.js | grep -c 'service_role'   # 0

# 5. Upload limits behave.
head -c 20000000 /dev/urandom > /tmp/big.pdf
curl -sS -X POST https://pcare-pharma.com/api/v1/supplier-invoices \
  -H "Authorization: Bearer $OWNER" -F file=@/tmp/big.pdf | jq -r .error
#    expect FILE_TOO_LARGE (from Express), NOT an nginx 413 HTML page

# 6. Login limiter engages and then releases.
for i in $(seq 1 12); do
  curl -s -o /dev/null -w '%{http_code} ' https://pcare-pharma.com/api/v1/auth/login \
    -H 'Content-Type: application/json' -d '{"email":"a@b.c","password":"wrong"}'
done; echo                                    # 401s then 429s

# 7. TLS grade.
#    Run https://www.ssllabs.com/ssltest/ against pcare-pharma.com — expect A or A+.
```

Plus the §8.2 `staff-field-exposure` suite, run against production with a real staff
session. That is the "verified against actual Staff-session API responses" item the QA
checklist has never been able to tick.

### 12.3 Concurrency and transaction tests

These need `TEST_*` credentials and a migrated project, which is precisely why staging
exists. **None of them has ever run.**

```js
// backend/tests/concurrency.test.js  — run against STAGING, never production

test('TC-CONC-01 two sales race for the last unit: one wins, one fails, stock never < 0', async () => {
  // Seed a batch with exactly 1 unit.
  const sale = () => request(app).post('/api/v1/billing')
    .set('Authorization', `Bearer ${staffToken}`)
    .send({ payment_mode: 'cash', items: [{ medicine_id: medId, qty: 1 }] });

  const [a, b] = await Promise.all([sale(), sale()]);
  const codes = [a.status, b.status].sort();
  expect(codes).toEqual([201, 409]);                    // exactly one of each
  expect([a.body.error, b.body.error].filter(Boolean)).toContain('INSUFFICIENT_STOCK');

  const { data } = await supabase.from('batches_with_stock')
    .select('stock_qty').eq('id', batchId).single();
  expect(data.stock_qty).toBe(0);                        // never -1
});

test('TC-CONC-02 a failed bill leaves stock untouched and writes no bill', async () => {
  const before = await stockOf(batchId);
  const beforeBills = await billCount();
  await request(app).post('/api/v1/billing')
    .set('Authorization', `Bearer ${staffToken}`)
    .send({ payment_mode: 'cash', items: [{ medicine_id: medId, qty: 999999 }] })
    .expect(409);
  expect(await stockOf(batchId)).toBe(before);
  expect(await billCount()).toBe(beforeBills);           // no orphan bill header
});

test('TC-CONC-03 a return restores stock exactly once under double submission', async () => {
  const before = await stockOf(batchId);
  const approve = () => request(app).patch(`/api/v1/customer-returns/${retId}/approve`)
    .set('Authorization', `Bearer ${ownerToken}`);
  await Promise.all([approve(), approve()]);
  expect(await stockOf(batchId)).toBe(before + qtyReturned);   // + once, not twice
});

test('TC-CONC-04 a partial purchase-receipt failure creates nothing', async () => {
  // One valid item, one with an exp_date in the past -> whole RPC must abort.
  const beforeBatches = await batchCount();
  await request(app).post(`/api/v1/purchases/${poId}/receive`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ invoice_no: 'INV-1', items: [goodItem, badItem] })
    .expect((r) => expect(r.status).toBeGreaterThanOrEqual(400));
  expect(await batchCount()).toBe(beforeBatches);        // not beforeBatches + 1
  expect(await poStatus(poId)).toBe('sent');             // not 'received'
});

test('TC-CONC-05 supplier invoice commit is atomic', async () => {
  // Approve an invoice whose last line has no selling_price -> MISSING_SELLING_PRICE.
  // Expect: zero new batches, zero new ledger rows, zero new purchases,
  //         and the invoice still NEEDS_REVIEW.
});

test('TC-INV-01 the global invariant', async () => {
  const { data } = await supabase.rpc('exec', { /* or a direct query */ });
  // select batch_id from inventory_ledger group by 1 having sum(change_qty) < 0
  expect(data).toHaveLength(0);
});

test('TC-EXP-01 an expired batch cannot be billed even when named directly', async () => {
  // Seed a batch with exp_date = pharmacy_today() - 1 and stock 10.
  // FEFO must not offer it, AND create_bill_atomic must refuse it if handed directly.
  // Currently FAILS — this is finding #6.
});
```

Run `TC-INV-01` as a **daily production cron** as well, not only in the test suite. It is
three lines of SQL and it is the one check that would catch a ledger corruption before a
customer does.

### 12.4 Timezone tests

The distinction you drew is the right one and the code already half-implements it:
**stored timestamps stay `timestamptz` in UTC; business-day boundaries are IST.** Do not
change any column type. Postgres runs in UTC (verified), `daily_sales_summary` already
buckets on `at time zone 'Asia/Kolkata'`, `pharmacy_today()` is IST, and
`top_medicines_by_qty` uses explicit `+05:30` literals. The skew is entirely in the seven
JavaScript call sites.

```js
// backend/tests/unit/timezone-boundary.test.js
const CASES = [
  ['2026-03-15T18:29:00Z', '2026-03-15'],  // 23:59 IST — still the 15th
  ['2026-03-15T18:30:00Z', '2026-03-16'],  // 00:00 IST — rolls to the 16th
  ['2026-03-15T18:31:00Z', '2026-03-16'],  // 00:01 IST
  ['2026-03-15T20:00:00Z', '2026-03-16'],  // 01:30 IST — the window where UTC lies
  ['2026-03-15T23:59:00Z', '2026-03-16'],  // 05:29 IST — last minute of the lie
  ['2026-03-16T00:01:00Z', '2026-03-16'],  // 05:31 IST — UTC finally agrees
];

test.each(CASES)('getISTDateString(%s) === %s', (iso, expected) => {
  expect(getISTDateString(new Date(iso))).toBe(expected);
});

// The regression that matters: the same six instants, through the code paths.
test.each(CASES)('expired batches are excluded at %s', async (iso) => {
  jest.setSystemTime(new Date(iso));
  const batches = await getAvailableBatchesFEFO(medId);   // batch expires on the 15th
  expect(batches.find((b) => b.id === expiredBatchId)).toBeUndefined();
});
```

Apply the same six instants to: bill creation and its appearance in today's sales; the
owner dashboard's "today" tile; `/reports/sales?dateFrom=&dateTo=`; attendance check-in
(`pharmacy_today()` — should already pass, and proving it does is the point); expiry
urgency; audit-log date filters; and `daily_sales_summary` row assignment.

The acceptance criterion is a single sentence: **a bill rung up at 23:59 IST and one at
00:01 IST must land on different business days, and both must land on the day the
cashier would name.**

---

## 13. GO / NO-GO Checklist

### P0 — MUST FIX BEFORE PRODUCTION

- [ ] **Staff API data exposure** — serializer on `/inventory/:id/batches`, `/inventory/batch/:id`, `/suppliers`; `staff-field-exposure.test.js` passing including the owner-positive case. (§8.2)
- [ ] **`receive_purchase_atomic` 4-arg + `purchases.invoice_no` captured into `schema-31`** before the Tokyo project is touched. (§7.3)
- [ ] **Migration order rewritten from the live schema**; `schema-34`'s ordering dependency resolved so a clean replay never hits `42883`. (§7.4)
- [ ] **schema-37 applied** to Mumbai before the API's first boot. (§7.7)
- [ ] **Expired stock cannot be sold** — `sellable_stock` in the views, `pharmacy_today()` not `current_date`, and a hard guard in `create_bill_atomic`. (§8.3)
- [ ] **Seven UTC date call sites replaced with `getISTDateString()`**; the six-instant boundary suite green. (§8.3, §12.4)
- [ ] **nginx config replaced** — `nginx -t` passes, `client_max_body_size 15m`, `proxy_read_timeout 180s`, `index.html` not cached, ACME location permanent. (§5.6)
- [ ] **PM2 started with `--env production`**; `pm2 env 0` shows `NODE_ENV=production`; no stack traces in any error response. (§5.8, §12.2)
- [ ] **Invoice upload rate limit + concurrency semaphore + provider-side Gemini spend cap.** (§8.8)
- [ ] **Nightly DB backup and Storage backup to S3, both run manually at least once, with a rehearsed restore and a recorded RTO.** (§9)
- [ ] **HTTPS live on `https://pcare-pharma.com`** with both names on the certificate, HTTP→HTTPS redirect, and `certbot renew --dry-run` passing. (§6, §11)

### P1 — SHOULD FIX BEFORE PRODUCTION

- [ ] Discount cannot exceed the bill subtotal (DB-enforced). (§8.5)
- [ ] `match_medicines_trgm` and `is_owner` revoked from `anon`/`authenticated`. (§6.5)
- [ ] `search_path` pinned on all 12 flagged functions. (§7.4)
- [ ] CSP header with the correct inline-script hash. (§5.6)
- [ ] nginx overwrites `X-Request-Id`; log retention capped at 14 days. (§5.6, §5.8)
- [ ] 2 GB swap; `engines` pinned in both `package.json` files. (§5.1)
- [ ] Supabase Auth: leaked-password protection on, minimum length ≥ 12, Site URL correct. (§6.3)
- [ ] `pg_trgm` in `extensions`, and the trigram functions' `search_path` updated to match — **medicine search tested afterwards**. (§6.2)
- [ ] SSM Session Manager working; port 22 closed in the SG. (§5.4)
- [ ] AWS Budget alerts at $15 and $25; EBS encryption default on; IMDSv2 required. (§5.2, §5.10, §10.2)
- [ ] GitHub: private, MFA, branch protection on `main`, read-only deploy key, deploy from a tag. (§8.10)
- [ ] The full backend test suite has run at least once against staging. (§11 step 7)
- [ ] Concurrency suite TC-CONC-01…05 passing. (§12.3)
- [ ] DNS: CAA, SPF `-all`, DMARC `p=reject`; registrant email verified; transfer lock and auto-renew on. (§4)
- [ ] External uptime monitoring on `/health` **and** `/ready`, plus certificate-expiry alerting. (§5.11)
- [ ] `BackupSuccess` CloudWatch alarm with `TreatMissingData: breaching`. (§9.7)

### P2 — CAN BE DONE AFTER GO-LIVE

- [ ] Move to Supabase Pro (target: within 3 months, once a month of real billing exists). (§9.1)
- [ ] Weekly EBS snapshot via DLM. (§9.5)
- [ ] CloudWatch agent for memory and disk metrics. (§5.11)
- [ ] Object-Locked weekly backup bucket. (§9.4)
- [ ] `partially_received` — either add it to `purchases_status_check` or remove it from the UI filter. (finding #2)
- [ ] Magic-byte sniffing on invoice uploads. (§8.7)
- [ ] HSTS raised to one year; `includeSubDomains` considered. (§11 step 27)
- [ ] DNSSEC — revisit only with a key-rotation runbook. (§4.11)
- [ ] Surface `/notifications/count`, `/inventory/movements`, `/inventory/expired`, `/reports/top-medicines`.
- [ ] Module 23 review-screen gaps (`pack_raw`, `printed_rate`, `discount_pct`, selling-price seeding on hand-mapping).
- [ ] Loose stock on the Inventory and Expiry screens (`getLooseMovements()` has no caller).

---

## 14. Instructions for the Executing Agent

Read this before touching anything.

1. **Do not make architectural decisions.** Every choice is made above. If you encounter
   something this document does not cover, stop and ask.
2. **Anything marked "VERIFY FROM ACTUAL ENVIRONMENT — DO NOT ASSUME" must be read from
   the real system**, never guessed. There are no real IP addresses, hostnames,
   credentials, ARNs, account IDs or project references invented anywhere in this
   document, and you must not invent any either.
3. **Follow §11 in order.** The order encodes dependencies: EBS encryption before launch,
   DNS before certbot, staging before production, migrations before the first API boot.
4. **Never run a migration against production that has not first run cleanly against
   staging**, file by file, with `ON_ERROR_STOP=1`.
5. **Never restore `auth.*` or `storage.*` from a dump.** Users go through the Admin API
   (§7.2). This is not negotiable and the reasoning is in that section.
6. **The Tokyo project must not be deleted or paused** until §11 step 6 has completed and
   its schema snapshot is committed. It is currently the only copy of one function
   definition.
7. **After every migration to a live database, restart the API process.**
   `config/capabilities.js` caches its probes per process; without a restart, applied
   migrations remain invisible to the running application.
8. **A backup is not done until it has been restored.** Step 8 and step 29 are not
   optional.

---

### Environment variables — the full production table

Derived from `backend/src/config/env.js` and `backend/.env.example`. No variable below is
invented; every one is read by the code today.

| Variable | Development | Production | Secret? | Source |
|---|---|---|---|---|
| `NODE_ENV` | `development` | `production` | No | PM2 `--env production` |
| `PORT` | `4000` | `4000` | No | PM2 |
| `APP_VERSION` | `1.0.0` | release tag | No | deploy script |
| `SUPABASE_URL` | Tokyo project | **Mumbai prod project** | No | SSM `/pcare/prod/SUPABASE_URL` |
| `SUPABASE_SERVICE_KEY` | Tokyo | **Mumbai prod** | **YES — critical** | SSM SecureString |
| `SUPABASE_ANON_KEY` | Tokyo | **Mumbai prod** | Low, but do not publish | SSM SecureString |
| `FRONTEND_URL` | `http://localhost:3000` | `https://pcare-pharma.com` (no trailing slash) | No | SSM |
| `LOG_LEVEL` | `debug` | `info` | No | SSM |
| `GEMINI_API_KEY` | optional | set, with a provider-side spend cap | **YES** | SSM SecureString |
| `GEMINI_MODEL` | `gemini-3.6-flash` | `gemini-3.6-flash` | No | SSM |
| `GEMINI_TIMEOUT_MS` | `120000` | `120000` — nginx `proxy_read_timeout` must exceed it | No | SSM |
| `GEMINI_MAX_ATTEMPTS` | `2` | `2` | No | SSM |
| `GEMINI_MAX_OUTPUT_TOKENS` | `32768` | `32768` | No | SSM |
| `SUPABASE_INVOICE_BUCKET` | `supplier-invoices` | `supplier-invoices` | No | SSM |
| `INVOICE_MAX_UPLOAD_MB` | `12` | `12` — keep below nginx's `15m` | No | SSM |
| `INVOICE_SIGNED_URL_TTL` | `900` | `900` | No | SSM |
| `TEST_OWNER_EMAIL` / `_PASSWORD` | staging only | **UNSET in production** | YES | staging `.env` only |
| `TEST_STAFF_EMAIL` / `_PASSWORD` | staging only | **UNSET in production** | YES | staging `.env` only |
| `VITE_API_URL` | unset (Vite proxies) | **UNSET** — the `/api/v1` default is same-origin | No | never set |

`APP_VERSION` is worth wiring to the deployed tag: `/health` returns it, so an external
monitor can tell you which release is actually running.
