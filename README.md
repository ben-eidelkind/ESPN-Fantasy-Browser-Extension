# ESPN Fantasy Exporter (Supabase)

A Chrome Manifest V3 extension that exports ESPN Fantasy Football league data to Supabase or as a JSON download. It reads your logged-in ESPN cookies (SWID and `espn_s2`) and calls the private league API so you can archive or sync your fantasy league.

## Features
- Detects `leagueId` from the active `fantasy.espn.com` tab with a manual fallback.
- Season defaults to the latest football season (switching in July) and is editable.
- Uses your ESPN cookies (permission is requested on first use) to call the private API with the required views.
- Normalizes the response and computes summary counts before saving.
- Optional Supabase sync using anon key, with REST insert to a table (defaults to `espn_syncs`).
- Popup actions: detect league ID, test ESPN connectivity, fetch, download JSON, sync to Supabase, show preview.
- Options page to manage Supabase URL/key/table and reset saved storage.

## Installing (Unpacked)
1. Download or clone this repository.
2. In Chrome, visit `chrome://extensions/` and enable **Developer mode**.
3. Click **Load unpacked** and select the `extension` folder from this project.
4. Pin the extension for quick access (optional). Chrome will display its default puzzle-piece icon because this repository intentionally ships without custom image assets.

## Usage
1. Open `fantasy.espn.com` and ensure you are logged in to ESPN.
2. Click the extension popup and press **Detect on this Tab**. If detection fails, enter the league ID manually.
3. Adjust the season if needed (defaults to current or previous year based on the calendar).
4. Use **Test Connection** to validate cookies and league access.
5. Choose whether to include raw ESPN payloads, then **Fetch Data**.
6. Review the JSON preview, optionally download the file, or **Sync to Supabase** once credentials are configured.

### Supabase Setup
1. Create a Supabase project and obtain the **Project URL** and **anon key** from the dashboard.
2. In Supabase SQL editor, create a table similar to:
   ```sql
   create table public.espn_syncs (
     id uuid default gen_random_uuid() primary key,
     league_id bigint,
     season integer,
     fetched_at timestamptz,
     payload jsonb
   );
   ```
3. Enable Row Level Security (RLS) and add policies that allow inserts with the anon key as appropriate for your project.
4. Open the extension **Options** page and paste the project URL, anon key, and desired table name.
5. Back in the popup, fetched payloads can now be synced with **Sync to Supabase**.

## Troubleshooting
- **Missing cookies**: Open `fantasy.espn.com`, log in, and refresh. The extension requires SWID and `espn_s2`.
- **401/403 errors**: ESPN session expired. Refresh the league site before retrying.
- **404 errors**: League ID or season is incorrect, or you lack access to the league.
- **429 errors**: ESPN rate-limited the request; the extension retries automatically with backoff.
- **Supabase errors**: Verify URL, anon key, table name, and RLS policies.

## Storage Keys
The extension stores the following keys in `chrome.storage.local`:
- `leagueId`
- `season`
- `supabaseUrl`
- `supabaseAnonKey`
- `supabaseTable`
- `lastSummary`
- `lastSyncedAt`

Clear storage from the Options page if you need to reset the extension.

## Asset Policy
This project contains only text-based source files. No binary or image assets are included so that the extension remains PR-safe and uses Chrome's default iconography.
