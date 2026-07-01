# Orbit Ads Manager

Orbit is a full-stack Meta campaign-management dashboard designed for marketing teams that want a guided alternative to Ads Manager. It includes a campaign dashboard, four-step campaign creator, creative library, campaign analytics, Meta connection settings, JWT authentication, upload handling, and a Prisma/PostgreSQL API.

## What is functional

- Cookie-based login, logout, protected routes, profile/default settings, and password changes
- Database-backed campaign search, filtering, creation, editing, deletion, and status changes
- Multiple ad sets and ads, targeting, bidding, formats, UTMs, validation, and browser draft recovery
- Local creative upload, preview, filtering, attachment to ads, and deletion
- Live Meta campaign and account-insights views with no synthetic metrics
- Multiple ad-account discovery and selection, matching the accounts available to the connected Facebook user
- Meta OAuth, encrypted token storage, account/Page selection, live insights, and reconnect errors
- Local campaign drafting and creative management; optional safe publish creates Meta objects as paused
- Optional AI field suggestions, creative briefs, and pre-save campaign reviews

Publishing is gated by `PUBLISHING_ENABLED`. When enabled, Orbit uses safe publish mode: campaigns, ad sets, ads, and creatives are created in Meta with status `PAUSED`, so nothing spends until the user reviews and activates the objects inside Ads Manager.

## For the end user

Orbit now presents the ad setup as a simple Goal → Audience → Ad flow:

- A Goal is the overall thing the user wants, such as getting sales, website visits, leads, reach, engagement, or app downloads.
- An Audience is the group of people inside that goal, such as people in a country, age range, gender, or interest group.
- An Ad is the actual message, image, or video people will see inside an audience.
- The beginner flow starts at `/`, asks one question at a time, and uses plain labels instead of Meta Ads Manager jargon.
- The advanced technical builder is still available at `/advanced/campaigns/new` for power users.

## Quick start

1. Copy the environment file:

   ```bash
   cp .env.example .env
   ```

2. Start PostgreSQL and the application:

   ```bash
   docker compose up
   ```

3. In another terminal, create the schema and seed demo data:

   ```bash
   docker compose exec app npm --prefix server run prisma:migrate -- --name init
   docker compose exec app npm --prefix server run prisma:seed
   ```

   When pulling future schema changes, run the migration command again with a new migration name.

4. Open `http://localhost:5173`. Demo sign-in:

   - Email: `maya@acmestudio.com`
   - Password: `password123`

For a local Node workflow, run `npm run install:all`, start PostgreSQL, then run `npm --prefix server run prisma:generate`, `npm --prefix server run prisma:migrate`, `npm --prefix server run prisma:seed`, and `npm run dev`.

## Production deployment

Oracle VM + Nginx deployment notes for `orbit.ixclabs.com` are in [deploy/oracle-vm-orbit.md](/Users/pransharora/Documents/Codex/2026-06-22/files-mentioned-by-the-user-you/deploy/oracle-vm-orbit.md).

## Meta app setup

1. Create an app at [Meta for Developers](https://developers.facebook.com/) using the Business app type.
2. Add Facebook Login for Business and the Marketing API product.
3. Add `http://localhost:4000/api/meta/callback` as a valid OAuth redirect URI.
4. Add your local URLs before trying OAuth:
   - App Domains: `localhost`
   - Website URL: `http://localhost:5173/`
   - Valid OAuth redirect URI: `http://localhost:4000/api/meta/callback`
5. Request or enable the stable local connection permission set:
   - `ads_read`
   - `ads_management`
   - `business_management`
   - `pages_show_list`
   - `pages_read_engagement`
6. Put the app ID and secret into `.env`.
7. Add a separate, long `TOKEN_ENCRYPTION_KEY` used to encrypt Meta tokens at rest.
8. Set `META_API_VERSION` to a currently supported Graph API version.
9. Set `PUBLISHING_ENABLED=true` only when you want safe publish mode. Orbit still creates everything as `PAUSED`.

The OAuth scopes are configurable with `META_OAUTH_SCOPES`. The default is:

```bash
META_OAUTH_SCOPES=ads_read,ads_management,business_management,pages_show_list,pages_read_engagement
```

New Meta apps operate in development mode and can only authorize app-role users. Business Verification and App Review are normally required before other customers can connect. Do not publish the app just to fix local OAuth errors; first make the app domains, redirect URI, and requested scopes valid.

`leads_retrieval` is required before Orbit can fetch actual Lead Ads form submissions such as names, emails, phone numbers, and form answers. `pages_manage_metadata` is useful later for Page webhook subscriptions. Add those scopes to `META_OAUTH_SCOPES` only after Meta shows them as available for this app and the required App Review/dependencies are in place. The current dashboard already reads lead counts and lead-related action metrics from Ads Insights; full lead record retrieval is the next integration layer after this permission is granted.

## Meta data behavior

The Meta integration is read-only. After OAuth, Orbit loads all accessible ad accounts, lets the user choose the active account, and retrieves campaigns and account-level insights directly from the Marketing API. No mock campaigns or synthetic performance metrics are returned.

Access tokens are encrypted with AES-256-GCM before being stored in `MetaConnection`. For a production deployment, use a managed secret/KMS for `TOKEN_ENCRYPTION_KEY`, rotate it carefully, and terminate HTTPS at your proxy.

## AI Features

Orbit can use the OpenAI API as an optional media-buyer assistant while users prepare local campaign drafts. It provides three directly usable suggestions on supported fields, a creative brief generator, and a campaign readiness review. These features never publish or modify anything in Meta.

Add the server-side API key to `.env`:

```bash
OPENAI_API_KEY=your_api_key_here
OPENAI_MODEL=gpt-4o
```

Then recreate the application container so Docker reloads the environment:

```bash
docker compose up -d --force-recreate app
```

If `OPENAI_API_KEY` is missing, AI controls are silently hidden and all Phase 1 functionality continues to work.

AI responses are requested as structured JSON and cached in memory for 10 minutes. Each non-cached OpenAI call is recorded in `AiUsageLog`. The default monthly allowance is 500,000 tokens and can be changed under Settings. A warning appears at 80%; at 100%, the server blocks further AI calls until the next calendar month or until the budget is increased.

`costUsd` is an estimate. To populate it, set the current model pricing used by your account:

```bash
OPENAI_INPUT_COST_PER_1M=0
OPENAI_OUTPUT_COST_PER_1M=0
```

Leaving these at zero still records token usage accurately without assuming a pricing rate that may change.

## Recommendation engine

The `/goals` page now has a "What needs your attention" panel above the existing Facebook goals and Orbit drafts. Click **Refresh** to run the full recommendation cycle:

1. Sync active/paused campaigns, audiences, and ads from the connected Meta ad account into Orbit.
2. Fetch last-7-days Meta insights for linked campaigns.
3. Store a performance snapshot.
4. Generate up to three pending action items per analysed campaign.

New API routes:

- `POST /api/meta/sync` imports ACTIVE and PAUSED Meta campaigns into local Campaign/AdSet/Ad records.
- `GET /api/recommendations` lists pending action items for the signed-in user's campaigns.
- `POST /api/recommendations/generate` runs sync + insight analysis + rules.
- `POST /api/recommendations/:id/act` executes the suggested action.
- `POST /api/recommendations/:id/dismiss` hides an action item.

Action types:

- `PAUSE_ALERT`: pauses the linked Meta campaign and marks the local goal paused.
- `SCALE_BUDGET`: increases the linked Meta campaign daily budget by the suggested amount.
- `FIX_PERFORMANCE`: creates a new local draft with improved copy; it does not change the running Meta ad.
- `REFRESH_CREATIVE`: returns a refresh-flow redirect for replacing creative.
- `NEW_AUDIENCE`: creates a draft audience/ad variation inside the same goal.
- `BUDGET_REVIEW`: opens the goal detail page.
- `AB_TEST`: creates a draft ad variation with a different message angle.

Meta publish safety is unchanged: new objects created from Orbit still use paused/safe mode, and draft-generating recommendation actions do not affect existing running ads.

## Useful commands

```bash
npm run dev
npm run build
npm --prefix server run prisma:generate
npm --prefix server run prisma:migrate
npm --prefix server run prisma:seed
```

The API examples are in [`api.http`](./api.http).
