-- Journey Chat tables (MySQL 8+, utf8mb4). All prefixed chat_: they live in the shared abrs_new database.
-- bus-online writes only chat_abhibus_inbox; the journey-chat service owns the rest.
-- Tables are in dependency order; foreign keys are declared inline.
-- CreateTable
CREATE TABLE `chat_bus_journey` (
    `journey_id` VARCHAR(191) NOT NULL,
    `service_id` VARCHAR(191) NOT NULL,
    `journey_date` VARCHAR(191) NOT NULL,
    `bus_number` VARCHAR(191) NOT NULL,
    `operator_name` VARCHAR(191) NOT NULL,
    `platform_room_id` VARCHAR(191) NULL,
    `route_name` VARCHAR(191) NOT NULL,
    `source_city` VARCHAR(191) NOT NULL,
    `destination_city` VARCHAR(191) NOT NULL,
    `start_time` DATETIME(3) NOT NULL,
    `estimated_end_time` DATETIME(3) NOT NULL,
    `actual_end_time` DATETIME(3) NULL,
    `purge_at` DATETIME(3) NULL,
    `status` ENUM('SCHEDULED', 'IN_TRANSIT', 'ARRIVED', 'PURGED') NOT NULL DEFAULT 'SCHEDULED',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `route` JSON NULL,
    `rooms_opened_at` DATETIME(3) NULL,
    `last_lat` DOUBLE NULL,
    `last_lng` DOUBLE NULL,
    `last_speed_kmph` DOUBLE NULL,
    `last_fix_at` DATETIME(3) NULL,
    `route_auto` BOOLEAN NOT NULL DEFAULT true,
    `tracking_ref` VARCHAR(191) NULL,
    `schedule_auto` BOOLEAN NOT NULL DEFAULT true,
    `operator_helpline` VARCHAR(191) NULL,

    INDEX `chat_bus_journey_status_purge_at_idx`(`status`, `purge_at`),
    INDEX `chat_bus_journey_status_start_time_idx`(`status`, `start_time`),
    PRIMARY KEY (`journey_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `chat_passenger_booking` (
    `id` VARCHAR(191) NOT NULL,
    `pnr_number` VARCHAR(191) NOT NULL,
    `journey_id` VARCHAR(191) NOT NULL,
    `seat_number` VARCHAR(191) NOT NULL,
    `passenger_name` VARCHAR(191) NULL,
    `gender` ENUM('M', 'F', 'O') NOT NULL,
    `phone_hash` VARCHAR(191) NULL,
    `customer_id` VARCHAR(191) NULL,
    `passenger_name_enc` TEXT NULL,
    `contact_phone_enc` TEXT NULL,
    `boarding_id` VARCHAR(191) NULL,
    `boarding_name` VARCHAR(191) NULL,
    `boarding_landmark` VARCHAR(255) NULL,
    `boarding_lat` DOUBLE NULL,
    `boarding_lng` DOUBLE NULL,
    `boarding_at` DATETIME(3) NULL,
    `dropping_id` VARCHAR(191) NULL,
    `dropping_name` VARCHAR(191) NULL,
    `dropping_lat` DOUBLE NULL,
    `dropping_lng` DOUBLE NULL,
    `dropping_at` DATETIME(3) NULL,
    `channel` ENUM('OWN', 'API', 'QR') NOT NULL,
    `device_id` VARCHAR(191) NULL,
    `display_name` VARCHAR(191) NULL,
    `avatar_id` VARCHAR(191) NULL,
    `invited_by` VARCHAR(191) NULL,
    `claimed_at` DATETIME(3) NULL,
    `synced_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `chat_passenger_booking_pnr_number_idx`(`pnr_number`),
    UNIQUE INDEX `chat_passenger_booking_journey_id_seat_number_key`(`journey_id`, `seat_number`),
    PRIMARY KEY (`id`),
    CONSTRAINT `chat_passenger_booking_journey_id_fkey` FOREIGN KEY (`journey_id`) REFERENCES `chat_bus_journey`(`journey_id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `chat_room` (
    `room_id` VARCHAR(191) NOT NULL,
    `journey_id` VARCHAR(191) NOT NULL,
    `room_type` ENUM('MAIN_COMMON', 'WOMEN_ONLY') NOT NULL,
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `pinned_message_id` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `chat_room_journey_id_room_type_key`(`journey_id`, `room_type`),
    PRIMARY KEY (`room_id`),
    CONSTRAINT `chat_room_journey_id_fkey` FOREIGN KEY (`journey_id`) REFERENCES `chat_bus_journey`(`journey_id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `chat_message` (
    `message_id` VARCHAR(191) NOT NULL,
    `room_id` VARCHAR(191) NOT NULL,
    `sender_seat` VARCHAR(191) NULL,
    `sender_handle` VARCHAR(191) NOT NULL,
    `content_type` ENUM('TEXT', 'STICKER', 'BUS_LOCATION', 'BROADCAST', 'LANDMARK', 'SYSTEM') NOT NULL,
    `payload` JSON NOT NULL,
    `client_msg_id` VARCHAR(191) NULL,
    `is_hidden` BOOLEAN NOT NULL DEFAULT false,
    `visible_to_seat` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `chat_message_room_id_created_at_idx`(`room_id`, `created_at`),
    UNIQUE INDEX `chat_message_room_id_sender_seat_client_msg_id_key`(`room_id`, `sender_seat`, `client_msg_id`),
    PRIMARY KEY (`message_id`),
    CONSTRAINT `chat_message_room_id_fkey` FOREIGN KEY (`room_id`) REFERENCES `chat_room`(`room_id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `chat_read_receipt` (
    `message_id` VARCHAR(191) NOT NULL,
    `pnr_number` VARCHAR(191) NOT NULL,
    `seat_number` VARCHAR(191) NOT NULL,
    `seen_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`message_id`, `seat_number`),
    CONSTRAINT `chat_read_receipt_message_id_fkey` FOREIGN KEY (`message_id`) REFERENCES `chat_message`(`message_id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `chat_message_reaction` (
    `message_id` VARCHAR(191) NOT NULL,
    `seat_number` VARCHAR(191) NOT NULL,
    `emoji` VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL, -- binary: utf8mb4_unicode_ci treats all emoji as equal
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`message_id`, `seat_number`, `emoji`),
    CONSTRAINT `chat_message_reaction_message_id_fkey` FOREIGN KEY (`message_id`) REFERENCES `chat_message`(`message_id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `chat_message_report` (
    `id` VARCHAR(191) NOT NULL,
    `journey_id` VARCHAR(191) NOT NULL,
    `message_id` VARCHAR(191) NOT NULL,
    `reporter_pnr` VARCHAR(191) NOT NULL,
    `reporter_seat` VARCHAR(191) NOT NULL,
    `reported_seat` VARCHAR(191) NOT NULL,
    `reason` VARCHAR(191) NOT NULL,
    `content_snapshot` JSON NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `retain_until` DATETIME(3) NOT NULL,

    INDEX `chat_message_report_journey_id_reported_seat_idx`(`journey_id`, `reported_seat`),
    UNIQUE INDEX `chat_message_report_message_id_reporter_pnr_key`(`message_id`, `reporter_pnr`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `chat_seat_mute` (
    `journey_id` VARCHAR(191) NOT NULL,
    `seat_number` VARCHAR(191) NOT NULL,
    `reason` VARCHAR(191) NOT NULL,
    `muted_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`journey_id`, `seat_number`),
    CONSTRAINT `chat_seat_mute_journey_id_fkey` FOREIGN KEY (`journey_id`) REFERENCES `chat_bus_journey`(`journey_id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `chat_seat_block` (
    `journey_id` VARCHAR(191) NOT NULL,
    `blocker_seat` VARCHAR(191) NOT NULL,
    `blocked_seat` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`journey_id`, `blocker_seat`, `blocked_seat`),
    CONSTRAINT `chat_seat_block_journey_id_fkey` FOREIGN KEY (`journey_id`) REFERENCES `chat_bus_journey`(`journey_id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `chat_eta_game` (
    `id` VARCHAR(191) NOT NULL,
    `journey_id` VARCHAR(191) NOT NULL,
    `checkpoint_name` VARCHAR(191) NOT NULL,
    `checkpoint_lat` DOUBLE NOT NULL,
    `checkpoint_lng` DOUBLE NOT NULL,
    `status` ENUM('OPEN', 'LOCKED', 'RESOLVED') NOT NULL DEFAULT 'OPEN',
    `closes_at` DATETIME(3) NOT NULL,
    `actual_at` DATETIME(3) NULL,
    `winner_seat` VARCHAR(191) NULL,
    `winner_pnr` VARCHAR(191) NULL,
    `reward_points` INTEGER NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `chat_eta_game_journey_id_status_idx`(`journey_id`, `status`),
    PRIMARY KEY (`id`),
    CONSTRAINT `chat_eta_game_journey_id_fkey` FOREIGN KEY (`journey_id`) REFERENCES `chat_bus_journey`(`journey_id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `chat_eta_guess` (
    `id` VARCHAR(191) NOT NULL,
    `game_id` VARCHAR(191) NOT NULL,
    `pnr_number` VARCHAR(191) NOT NULL,
    `seat_number` VARCHAR(191) NOT NULL,
    `guess_at` DATETIME(3) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `chat_eta_guess_game_id_seat_number_key`(`game_id`, `seat_number`),
    PRIMARY KEY (`id`),
    CONSTRAINT `chat_eta_guess_game_id_fkey` FOREIGN KEY (`game_id`) REFERENCES `chat_eta_game`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `chat_sos_event` (
    `id` VARCHAR(191) NOT NULL,
    `journey_id` VARCHAR(191) NOT NULL,
    `pnr_number` VARCHAR(191) NOT NULL,
    `seat_number` VARCHAR(191) NOT NULL,
    `lat` DOUBLE NULL,
    `lng` DOUBLE NULL,
    `place_label` VARCHAR(191) NULL,
    `status` ENUM('OPEN', 'ACKNOWLEDGED', 'RESOLVED') NOT NULL DEFAULT 'OPEN',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `acknowledged_at` DATETIME(3) NULL,

    INDEX `chat_sos_event_status_created_at_idx`(`status`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `chat_job_lease` (
    `name` VARCHAR(191) NOT NULL,
    `holder` VARCHAR(191) NOT NULL,
    `expires_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`name`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `chat_abhibus_inbox` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `event_type` VARCHAR(20) NOT NULL,
    `pnr` VARCHAR(40) NOT NULL,
    `cancel_seats` VARCHAR(255) NULL,
    `payload` LONGTEXT NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `processed_at` DATETIME(3) NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `last_error` VARCHAR(500) NULL,

    INDEX `chat_abhibus_inbox_processed_at_id_idx`(`processed_at`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
