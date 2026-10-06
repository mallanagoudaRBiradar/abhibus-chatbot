import { config } from '../config';
import { MockBookingSource } from './mockBookingSource';
import { MysqlBookingSource } from './mysqlBookingSource';
import type { BookingSource } from './types';

export const bookingSource: BookingSource =
  config.BOOKING_SOURCE === 'mysql' ? new MysqlBookingSource() : new MockBookingSource();
export * from './types';
