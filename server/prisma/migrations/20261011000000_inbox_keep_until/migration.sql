-- chat_abhibus_inbox: keep rows until 3 h after the trip ends (same as prisma/sql/abrs_new_chat_tables2.sql)
ALTER TABLE `chat_abhibus_inbox`
    ADD COLUMN `keep_until` DATETIME(3) NULL AFTER `processed_at`,
    ADD INDEX `chat_abhibus_inbox_keep_until_idx` (`keep_until`);
