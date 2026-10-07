-- Trip Rooms platform bridge: which platform room a journey mirrors into,
-- and messages private to one seat (support-agent replies).
ALTER TABLE "bus_journey" ADD COLUMN "platform_room_id" TEXT;
ALTER TABLE "message" ADD COLUMN "visible_to_seat" TEXT;
