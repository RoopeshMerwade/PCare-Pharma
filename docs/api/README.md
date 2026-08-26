# API Collection

`PCare-Pharma.postman_collection.json` — 106 requests across 19 folders, importable into
**Postman**, **Requestly**, **Insomnia**, **Bruno**, or `newman` (Postman Collection v2.1).

## Import and run

1. Import the `.json` file.
2. Set the `owner_email` / `owner_password` collection variables (Postman → collection → Variables).
   Prefer the *current value* column so credentials are not written to the file.
3. Run **Auth → Login**. Its test script stores `access_token` as a collection variable automatically from the response body; every other request inherits it via collection-level bearer auth. Nothing else needs a manual token.
4. Work down the folders. Create requests save the id they just made
   (`medicine_id`, `bill_id`, `supplier_id`, …) into collection variables, so the requests after
   them resolve without copy-pasting UUIDs.

`base_url` defaults to `http://localhost:4000`. Point it at a deployed host to test that instead.

## Do not hand-edit the JSON

It is generated. Edits are overwritten on the next run.

```bash
cd backend
npm run postman         # regenerate
npm run postman:check   # exit 1 if stale or if any route is undocumented
```

**Routes are discovered by walking the live Express router** (`src/app.js`), not by a hand-kept
list. Mount a new endpoint and it appears in the collection on the next run — it cannot silently
fall behind the code.

What the router *can't* tell us is intent: a description, a realistic example body, sensible
query values. Those live in [`backend/tools/postman/routes-meta.js`](../../backend/tools/postman/routes-meta.js),
keyed by `METHOD /express/path`:

```js
'POST /api/v1/medicines': {
  name: 'Create medicine',
  role: 'owner',                      // adds the owner-only note
  description: 'Catalog entry only — it holds no stock.',
  body: { name: 'Paracetamol 500mg', /* … */ },
  capture: { var: 'medicine_id', path: 'data.medicine.id' },
},
```

| field | purpose |
|---|---|
| `name` | request label in the sidebar |
| `description` | markdown shown in Postman's docs pane |
| `auth: 'public'` | opts the request out of collection bearer auth |
| `role` | `'owner'` appends the 403-for-staff note |
| `body` | example JSON body |
| `query` | `{ key: value }`, or `{ key: [value, 'description'] }`; an empty value renders the param disabled (an optional filter) |
| `pathVars` | maps an Express param to a collection variable — `{ id: 'medicine_id' }` turns `/:id` into `/{{medicine_id}}` |
| `capture` | test script saves a response value into a collection variable for later requests |

Boilerplate endpoints (`/deactivate`, `/reactivate`, `GET …/:id`) get a sensible description
automatically, so there's no need to write the same sentence in every module.

## Adding an endpoint

1. Write the route as usual.
2. `npm run postman` — the route is already in the collection, flagged **TODO — undocumented**,
   and listed on stderr.
3. Add its entry to `routes-meta.js` and re-run.
4. Commit the route and the regenerated `.json` together.

`npm run postman:check` fails the build if the committed collection is stale, if a route has no
metadata, or if metadata refers to a route that no longer exists (a rename left behind). Worth
wiring into CI or a pre-deploy step — it's the thing that keeps this document honest.

## Before the write endpoints will work

Bill creation, purchase receiving, and both return workflows call the atomic RPCs in
`backend/src/db/schema-22-atomic-workflows.sql`. Until that migration is applied they return
`500 MIGRATION_REQUIRED`. See [`docs/MIGRATION-ORDER.md`](../MIGRATION-ORDER.md).

## Response conventions

```jsonc
// success
{ "success": true, "message": "…", "data": { … } }

// failure — note the key is `error`, not `code`
{ "error": "TOKEN_INVALID", "message": "…", "details": [ … ] }
```

- `422` validation failures carry `details: [{ field, message }]`.
- Access tokens last ~1 hour; on `401 TOKEN_INVALID` run **Auth → Refresh** (it reads the
  httpOnly `pcare_refresh` cookie and rotates it).
- Rate limits: 900 req / 15 min per IP overall, 5 / 15 min on login.
