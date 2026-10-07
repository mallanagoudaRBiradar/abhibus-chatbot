-- ============================================================================
--  abrs_new: chat_abhibus_inbox.keep_until  (run once, after abrs_new_chat_tables.sql)
-- ============================================================================
--  Inbox rows (bus-online's raw booking / cancellation data) now live as long as
--  the trip's chat: until 3 hours after the last passenger's drop time
--  (CHAT_CLOSE_AFTER_LAST_DROP_MIN). The chat server deletes a trip's rows when it
--  ends the chat; keep_until (that same time) covers fully cancelled PNRs.
--  Until this runs, rows of fully cancelled PNRs are simply kept.
--  Only touches chat_abhibus_inbox; safe to run while bus-online is inserting.
-- ============================================================================
ALTER TABLE `chat_abhibus_inbox`
    ADD COLUMN `keep_until` DATETIME(3) NULL AFTER `processed_at`,
    ADD INDEX `chat_abhibus_inbox_keep_until_idx` (`keep_until`);
