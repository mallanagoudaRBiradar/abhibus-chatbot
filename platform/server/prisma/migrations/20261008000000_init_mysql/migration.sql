-- =============================================================================
-- abrs_new_chat_tables1.sql  -  Ops console (Trip Rooms platform) tables
-- =============================================================================
-- Run ONCE on abrs_new, after abrs_new_chat_tables.sql (the 14 chat_* tables).
-- Creates 23 tables, all prefixed chat_console_ (the console's own room / member /
-- message tables, kept apart from the journey-chat chat_* tables).
-- Tables are in dependency order; foreign keys are declared inline. MySQL 8+, utf8mb4.
-- Then load the console logins + API keys:  cd platform/server && npm run setup:real
-- =============================================================================

CREATE TABLE `chat_console_tenant` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `verticals` JSON NOT NULL,
    `theme` JSON NOT NULL,
    `config` JSON NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `chat_console_api_client` (
    `id` VARCHAR(191) NOT NULL,
    `tenant_id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `client_id` VARCHAR(191) NOT NULL,
    `secret_hash` VARCHAR(191) NOT NULL,
    `secret_hint` VARCHAR(191) NOT NULL,
    `scopes` JSON NOT NULL,
    `created_by` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `last_used_at` DATETIME(3) NULL,
    `revoked_at` DATETIME(3) NULL,

    UNIQUE INDEX `chat_console_api_client_client_id_key`(`client_id`),
    PRIMARY KEY (`id`),
    CONSTRAINT `chat_console_api_client_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `chat_console_tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `chat_console_dashboard_user` (
    `id` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `password_hash` VARCHAR(191) NOT NULL,
    `role` ENUM('admin', 'ops', 'marketing', 'developer', 'support', 'viewer') NOT NULL,
    `tenant_ids` JSON NOT NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `last_login_at` DATETIME(3) NULL,
    `notif_state` JSON NULL,

    UNIQUE INDEX `chat_console_dashboard_user_email_key`(`email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `chat_console_room` (
    `id` VARCHAR(191) NOT NULL,
    `tenant_id` VARCHAR(191) NOT NULL,
    `trip_key` VARCHAR(191) NOT NULL,
    `vertical` ENUM('bus', 'train', 'flight', 'custom') NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `subtitle` VARCHAR(191) NOT NULL DEFAULT '',
    `scope` JSON NOT NULL,
    `departs_at` DATETIME(3) NOT NULL,
    `arrives_at` DATETIME(3) NOT NULL,
    `stops` JSON NOT NULL,
    `activation` JSON NULL,
    `features` JSON NULL,
    `location_feed` VARCHAR(191) NOT NULL DEFAULT 'none',
    `locale` VARCHAR(191) NOT NULL DEFAULT 'en-IN',
    `metadata` JSON NULL,
    `meta` JSON NOT NULL,
    `state` ENUM('scheduled', 'dormant', 'open', 'onboard', 'read_only', 'closed') NOT NULL DEFAULT 'scheduled',
    `delay_min` INTEGER NOT NULL DEFAULT 0,
    `breakdown` BOOLEAN NOT NULL DEFAULT false,
    `ops_only` BOOLEAN NOT NULL DEFAULT false,
    `slow_mode` BOOLEAN NOT NULL DEFAULT false,
    `parent_room_id` VARCHAR(191) NULL,
    `opens_at` DATETIME(3) NOT NULL,
    `read_only_at` DATETIME(3) NOT NULL,
    `purge_at` DATETIME(3) NOT NULL,
    `last_alert_at` DATETIME(3) NULL,
    `last_ad_at` DATETIME(3) NULL,
    `ad_count` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `chat_console_room_state_purge_at_idx`(`state`, `purge_at`),
    UNIQUE INDEX `chat_console_room_tenant_id_trip_key_key`(`tenant_id`, `trip_key`),
    PRIMARY KEY (`id`),
    CONSTRAINT `chat_console_room_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `chat_console_tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `chat_console_channel` (
    `id` VARCHAR(191) NOT NULL,
    `room_id` VARCHAR(191) NOT NULL,
    `kind` ENUM('MAIN', 'WOMEN') NOT NULL,
    `pinned_id` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `chat_console_channel_room_id_kind_key`(`room_id`, `kind`),
    PRIMARY KEY (`id`),
    CONSTRAINT `chat_console_channel_room_id_fkey` FOREIGN KEY (`room_id`) REFERENCES `chat_console_room`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `chat_console_member` (
    `id` VARCHAR(191) NOT NULL,
    `room_id` VARCHAR(191) NOT NULL,
    `external_user_id` VARCHAR(191) NOT NULL,
    `booking_ref` VARCHAR(191) NOT NULL,
    `segment_from` VARCHAR(191) NULL,
    `segment_to` VARCHAR(191) NULL,
    `party_size` INTEGER NOT NULL DEFAULT 1,
    `seat_refs` JSON NOT NULL,
    `chart_status` VARCHAR(191) NULL,
    `locale` VARCHAR(191) NOT NULL DEFAULT 'en-IN',
    `notify` JSON NOT NULL,
    `gender` ENUM('M', 'F', 'O', 'U') NOT NULL DEFAULT 'U',
    `role` ENUM('traveller', 'ops', 'crew', 'bot') NOT NULL DEFAULT 'traveller',
    `handle` VARCHAR(191) NOT NULL,
    `display_name` VARCHAR(191) NULL,
    `avatar_id` VARCHAR(191) NULL,
    `profile_set` BOOLEAN NOT NULL DEFAULT false,
    `muted` BOOLEAN NOT NULL DEFAULT false,
    `removed_at` DATETIME(3) NULL,
    `removed_reason` VARCHAR(191) NULL,
    `sharing_location` BOOLEAN NOT NULL DEFAULT false,
    `last_seen_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `chat_console_member_room_id_role_idx`(`room_id`, `role`),
    UNIQUE INDEX `chat_console_member_room_id_external_user_id_key`(`room_id`, `external_user_id`),
    PRIMARY KEY (`id`),
    CONSTRAINT `chat_console_member_room_id_fkey` FOREIGN KEY (`room_id`) REFERENCES `chat_console_room`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `chat_console_message` (
    `id` VARCHAR(191) NOT NULL,
    `channel_id` VARCHAR(191) NOT NULL,
    `sender_id` VARCHAR(191) NULL,
    `sender_name` VARCHAR(191) NOT NULL,
    `content_type` ENUM('TEXT', 'STICKER', 'LOCATION', 'ALERT', 'SYSTEM', 'TARA', 'PRIVATE', 'POLL', 'SURVEY', 'GAME', 'AD', 'ISSUE', 'VOUCHER', 'TIMER', 'LOST', 'CREW', 'RATE', 'LANDMARK') NOT NULL,
    `payload` JSON NOT NULL,
    `visible_to` VARCHAR(191) NULL,
    `client_msg_id` VARCHAR(191) NULL,
    `hidden` BOOLEAN NOT NULL DEFAULT false,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `chat_console_message_channel_id_created_at_idx`(`channel_id`, `created_at`),
    UNIQUE INDEX `chat_console_message_channel_id_sender_id_client_msg_id_key`(`channel_id`, `sender_id`, `client_msg_id`),
    PRIMARY KEY (`id`),
    CONSTRAINT `chat_console_message_channel_id_fkey` FOREIGN KEY (`channel_id`) REFERENCES `chat_console_channel`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `chat_console_reaction` (
    `message_id` VARCHAR(191) NOT NULL,
    `member_id` VARCHAR(191) NOT NULL,
    `key` VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL, -- binary: utf8mb4_unicode_ci treats all emoji as equal
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`message_id`, `member_id`, `key`),
    CONSTRAINT `chat_console_reaction_message_id_fkey` FOREIGN KEY (`message_id`) REFERENCES `chat_console_message`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `chat_console_receipt` (
    `message_id` VARCHAR(191) NOT NULL,
    `member_id` VARCHAR(191) NOT NULL,
    `seen_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`message_id`, `member_id`),
    CONSTRAINT `chat_console_receipt_message_id_fkey` FOREIGN KEY (`message_id`) REFERENCES `chat_console_message`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `chat_console_member_block` (
    `room_id` VARCHAR(191) NOT NULL,
    `blocker_id` VARCHAR(191) NOT NULL,
    `blocked_id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`room_id`, `blocker_id`, `blocked_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `chat_console_report` (
    `id` VARCHAR(191) NOT NULL,
    `room_id` VARCHAR(191) NOT NULL,
    `target_key` VARCHAR(191) NOT NULL,
    `reporter_ref` VARCHAR(191) NOT NULL,
    `reporter_id` VARCHAR(191) NOT NULL,
    `reported_id` VARCHAR(191) NOT NULL,
    `reason` VARCHAR(191) NOT NULL,
    `snapshot` JSON NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `retain_until` DATETIME(3) NOT NULL,

    INDEX `chat_console_report_room_id_reported_id_idx`(`room_id`, `reported_id`),
    UNIQUE INDEX `chat_console_report_target_key_reporter_ref_key`(`target_key`, `reporter_ref`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `chat_console_ops_action` (
    `id` VARCHAR(191) NOT NULL,
    `tenant_id` VARCHAR(191) NOT NULL,
    `room_id` VARCHAR(191) NOT NULL,
    `member_id` VARCHAR(191) NULL,
    `type` ENUM('sos', 'issue', 'wait_request', 'lost_found', 'report', 'care') NOT NULL,
    `severity` ENUM('info', 'warning', 'critical') NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `detail` VARCHAR(191) NOT NULL,
    `data` JSON NOT NULL,
    `status` ENUM('open', 'acknowledged', 'resolved') NOT NULL DEFAULT 'open',
    `assignee` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `chat_console_ops_action_tenant_id_status_idx`(`tenant_id`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `chat_console_issue_report` (
    `room_id` VARCHAR(191) NOT NULL,
    `label` VARCHAR(191) NOT NULL,
    `member_id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`room_id`, `label`, `member_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `chat_console_audit_log` (
    `id` VARCHAR(191) NOT NULL,
    `tenant_id` VARCHAR(191) NULL,
    `actor` VARCHAR(191) NOT NULL,
    `action` VARCHAR(191) NOT NULL,
    `room_id` VARCHAR(191) NULL,
    `target_id` VARCHAR(191) NULL,
    `reason` VARCHAR(191) NULL,
    `data` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `chat_console_audit_log_tenant_id_created_at_idx`(`tenant_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `chat_console_location_fix` (
    `id` VARCHAR(191) NOT NULL,
    `room_id` VARCHAR(191) NOT NULL,
    `source` VARCHAR(191) NOT NULL,
    `member_id` VARCHAR(191) NULL,
    `lat` DOUBLE NULL,
    `lng` DOUBLE NULL,
    `data` JSON NOT NULL,
    `recorded_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `chat_console_location_fix_room_id_recorded_at_idx`(`room_id`, `recorded_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `chat_console_trip_event` (
    `id` VARCHAR(191) NOT NULL,
    `room_id` VARCHAR(191) NOT NULL,
    `type` VARCHAR(191) NOT NULL,
    `data` JSON NOT NULL,
    `actor` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `chat_console_trip_event_room_id_created_at_idx`(`room_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `chat_console_campaign` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `advertiser` VARCHAR(191) NOT NULL,
    `format` ENUM('card', 'sponsored_poll', 'sponsored_game', 'stop_offer', 'survey') NOT NULL,
    `status` ENUM('draft', 'live', 'paused', 'ended') NOT NULL DEFAULT 'draft',
    `tenant_ids` JSON NOT NULL,
    `verticals` JSON NOT NULL,
    `routes` JSON NOT NULL,
    `stops` JSON NOT NULL,
    `stages` JSON NOT NULL,
    `creative` JSON NOT NULL,
    `poll` JSON NULL,
    `survey` JSON NULL,
    `starts_at` DATETIME(3) NULL,
    `ends_at` DATETIME(3) NULL,
    `cap_impressions` INTEGER NULL,
    `impressions` INTEGER NOT NULL DEFAULT 0,
    `clicks` INTEGER NOT NULL DEFAULT 0,
    `responses` INTEGER NOT NULL DEFAULT 0,
    `created_by` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `chat_console_campaign_delivery` (
    `id` VARCHAR(191) NOT NULL,
    `campaign_id` VARCHAR(191) NOT NULL,
    `room_id` VARCHAR(191) NOT NULL,
    `ok` BOOLEAN NOT NULL,
    `reason` VARCHAR(191) NOT NULL,
    `message_id` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `chat_console_campaign_delivery_campaign_id_created_at_idx`(`campaign_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `chat_console_survey_template` (
    `id` VARCHAR(191) NOT NULL,
    `tenant_id` VARCHAR(191) NULL,
    `name` VARCHAR(191) NOT NULL,
    `questions` JSON NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `chat_console_survey_response` (
    `message_id` VARCHAR(191) NOT NULL,
    `member_id` VARCHAR(191) NOT NULL,
    `answers` JSON NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`message_id`, `member_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `chat_console_webhook` (
    `id` VARCHAR(191) NOT NULL,
    `tenant_id` VARCHAR(191) NOT NULL,
    `url` VARCHAR(191) NOT NULL,
    `events` JSON NOT NULL,
    `secret` VARCHAR(191) NOT NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`),
    CONSTRAINT `chat_console_webhook_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `chat_console_tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `chat_console_event_log` (
    `id` VARCHAR(191) NOT NULL,
    `tenant_id` VARCHAR(191) NULL,
    `room_id` VARCHAR(191) NULL,
    `type` VARCHAR(191) NOT NULL,
    `data` JSON NOT NULL,
    `deliveries` JSON NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `chat_console_event_log_tenant_id_created_at_idx`(`tenant_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `chat_console_bot` (
    `id` VARCHAR(191) NOT NULL,
    `tenant_id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `label` VARCHAR(191) NOT NULL,
    `webhook_url` VARCHAR(191) NULL,
    `triggers` JSON NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`),
    CONSTRAINT `chat_console_bot_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `chat_console_tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
