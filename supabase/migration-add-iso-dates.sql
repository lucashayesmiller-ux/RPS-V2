-- Migration: add start_iso and end_iso columns for reliable date comparisons
-- Run this in Supabase SQL Editor BEFORE redeploying the app.
--
-- These columns store YYYY-MM-DD calendar dates (UTC) used by the dashboard
-- to classify rentals as active, upcoming, or historical. The display strings
-- (start_date / end_date like "Apr 7") are kept for the UI.

alter table rentals
  add column if not exists start_iso text,
  add column if not exists end_iso   text;

-- Backfill: mark all existing rows that have no end_iso as returned.
-- These are historical orders from before the fix that were never given
-- an end date. They will no longer appear in the operational dashboard.
-- Staff can still find them via search.
update rentals
set    status = 'returned'
where  end_iso is null
and    start_iso is null
and    status in ('setup', 'out', 'overdue');

-- After running this migration, trigger a manual Shopify sync from the app.
-- New orders will get correct start_iso and end_iso values on sync.
