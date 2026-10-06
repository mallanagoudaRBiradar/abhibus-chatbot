-- CreateEnum
CREATE TYPE "JourneyStatus" AS ENUM ('SCHEDULED', 'IN_TRANSIT', 'ARRIVED', 'PURGED');

-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('M', 'F', 'O');

-- CreateEnum
CREATE TYPE "RoomType" AS ENUM ('MAIN_COMMON', 'WOMEN_ONLY');

-- CreateEnum
CREATE TYPE "ContentType" AS ENUM ('TEXT', 'STICKER', 'BUS_LOCATION', 'BROADCAST', 'LANDMARK', 'SYSTEM');

-- CreateEnum
CREATE TYPE "BookingChannel" AS ENUM ('OWN', 'API');

-- CreateEnum
CREATE TYPE "EtaGameStatus" AS ENUM ('OPEN', 'LOCKED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "SosStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED');

-- CreateTable
CREATE TABLE "bus_journey" (
    "journey_id" TEXT NOT NULL,
    "service_id" TEXT NOT NULL,
    "journey_date" TEXT NOT NULL,
    "bus_number" TEXT NOT NULL,
    "operator_name" TEXT NOT NULL,
    "route_name" TEXT NOT NULL,
    "source_city" TEXT NOT NULL,
    "destination_city" TEXT NOT NULL,
    "start_time" TIMESTAMP(3) NOT NULL,
    "estimated_end_time" TIMESTAMP(3) NOT NULL,
    "actual_end_time" TIMESTAMP(3),
    "purge_at" TIMESTAMP(3),
    "status" "JourneyStatus" NOT NULL DEFAULT 'SCHEDULED',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bus_journey_pkey" PRIMARY KEY ("journey_id")
);

-- CreateTable
CREATE TABLE "passenger_booking" (
    "id" TEXT NOT NULL,
    "pnr_number" TEXT NOT NULL,
    "journey_id" TEXT NOT NULL,
    "seat_number" TEXT NOT NULL,
    "passenger_name" TEXT,
    "gender" "Gender" NOT NULL,
    "phone_hash" TEXT,
    "channel" "BookingChannel" NOT NULL,
    "device_id" TEXT,
    "claimed_at" TIMESTAMP(3),
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "passenger_booking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_room" (
    "room_id" TEXT NOT NULL,
    "journey_id" TEXT NOT NULL,
    "room_type" "RoomType" NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "pinned_message_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_room_pkey" PRIMARY KEY ("room_id")
);

-- CreateTable
CREATE TABLE "message" (
    "message_id" TEXT NOT NULL,
    "room_id" TEXT NOT NULL,
    "sender_seat" TEXT,
    "sender_handle" TEXT NOT NULL,
    "content_type" "ContentType" NOT NULL,
    "payload" JSONB NOT NULL,
    "client_msg_id" TEXT,
    "is_hidden" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_pkey" PRIMARY KEY ("message_id")
);

-- CreateTable
CREATE TABLE "read_receipt" (
    "message_id" TEXT NOT NULL,
    "pnr_number" TEXT NOT NULL,
    "seat_number" TEXT NOT NULL,
    "seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "read_receipt_pkey" PRIMARY KEY ("message_id","seat_number")
);

-- CreateTable
CREATE TABLE "message_reaction" (
    "message_id" TEXT NOT NULL,
    "seat_number" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_reaction_pkey" PRIMARY KEY ("message_id","seat_number","emoji")
);

-- CreateTable
CREATE TABLE "message_report" (
    "id" TEXT NOT NULL,
    "journey_id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "reporter_pnr" TEXT NOT NULL,
    "reporter_seat" TEXT NOT NULL,
    "reported_seat" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "content_snapshot" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retain_until" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "message_report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seat_mute" (
    "journey_id" TEXT NOT NULL,
    "seat_number" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "muted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "seat_mute_pkey" PRIMARY KEY ("journey_id","seat_number")
);

-- CreateTable
CREATE TABLE "seat_block" (
    "journey_id" TEXT NOT NULL,
    "blocker_seat" TEXT NOT NULL,
    "blocked_seat" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "seat_block_pkey" PRIMARY KEY ("journey_id","blocker_seat","blocked_seat")
);

-- CreateTable
CREATE TABLE "eta_game" (
    "id" TEXT NOT NULL,
    "journey_id" TEXT NOT NULL,
    "checkpoint_name" TEXT NOT NULL,
    "checkpoint_lat" DOUBLE PRECISION NOT NULL,
    "checkpoint_lng" DOUBLE PRECISION NOT NULL,
    "status" "EtaGameStatus" NOT NULL DEFAULT 'OPEN',
    "closes_at" TIMESTAMP(3) NOT NULL,
    "actual_at" TIMESTAMP(3),
    "winner_seat" TEXT,
    "winner_pnr" TEXT,
    "reward_points" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "eta_game_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eta_guess" (
    "id" TEXT NOT NULL,
    "game_id" TEXT NOT NULL,
    "pnr_number" TEXT NOT NULL,
    "seat_number" TEXT NOT NULL,
    "guess_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "eta_guess_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sos_event" (
    "id" TEXT NOT NULL,
    "journey_id" TEXT NOT NULL,
    "pnr_number" TEXT NOT NULL,
    "seat_number" TEXT NOT NULL,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "place_label" TEXT,
    "status" "SosStatus" NOT NULL DEFAULT 'OPEN',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledged_at" TIMESTAMP(3),

    CONSTRAINT "sos_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bus_journey_status_purge_at_idx" ON "bus_journey"("status", "purge_at");

-- CreateIndex
CREATE INDEX "passenger_booking_pnr_number_idx" ON "passenger_booking"("pnr_number");

-- CreateIndex
CREATE UNIQUE INDEX "passenger_booking_journey_id_seat_number_key" ON "passenger_booking"("journey_id", "seat_number");

-- CreateIndex
CREATE UNIQUE INDEX "chat_room_journey_id_room_type_key" ON "chat_room"("journey_id", "room_type");

-- CreateIndex
CREATE INDEX "message_room_id_created_at_idx" ON "message"("room_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "message_room_id_sender_seat_client_msg_id_key" ON "message"("room_id", "sender_seat", "client_msg_id");

-- CreateIndex
CREATE INDEX "message_report_journey_id_reported_seat_idx" ON "message_report"("journey_id", "reported_seat");

-- CreateIndex
CREATE UNIQUE INDEX "message_report_message_id_reporter_pnr_key" ON "message_report"("message_id", "reporter_pnr");

-- CreateIndex
CREATE INDEX "eta_game_journey_id_status_idx" ON "eta_game"("journey_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "eta_guess_game_id_seat_number_key" ON "eta_guess"("game_id", "seat_number");

-- CreateIndex
CREATE INDEX "sos_event_status_created_at_idx" ON "sos_event"("status", "created_at");

-- AddForeignKey
ALTER TABLE "passenger_booking" ADD CONSTRAINT "passenger_booking_journey_id_fkey" FOREIGN KEY ("journey_id") REFERENCES "bus_journey"("journey_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_room" ADD CONSTRAINT "chat_room_journey_id_fkey" FOREIGN KEY ("journey_id") REFERENCES "bus_journey"("journey_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message" ADD CONSTRAINT "message_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "chat_room"("room_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "read_receipt" ADD CONSTRAINT "read_receipt_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "message"("message_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_reaction" ADD CONSTRAINT "message_reaction_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "message"("message_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seat_mute" ADD CONSTRAINT "seat_mute_journey_id_fkey" FOREIGN KEY ("journey_id") REFERENCES "bus_journey"("journey_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seat_block" ADD CONSTRAINT "seat_block_journey_id_fkey" FOREIGN KEY ("journey_id") REFERENCES "bus_journey"("journey_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eta_game" ADD CONSTRAINT "eta_game_journey_id_fkey" FOREIGN KEY ("journey_id") REFERENCES "bus_journey"("journey_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eta_guess" ADD CONSTRAINT "eta_guess_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "eta_game"("id") ON DELETE CASCADE ON UPDATE CASCADE;
