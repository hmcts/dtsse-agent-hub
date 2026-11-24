-- When the person pinned a Bulk Scan form, which keeps it in the sidebar's Pinned section above the date groups; null
-- for a form that is not pinned. Set and cleared only by its owner, from the form's menu in the sidebar.
ALTER TABLE "bulk_scan_spec" ADD COLUMN "pinned_at" timestamptz;
