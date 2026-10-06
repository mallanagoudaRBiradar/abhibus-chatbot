import pino from 'pino';
import { config } from '../config';

/** PNRs, tokens and passwords are redacted from every log line. */
export const logger = pino({
  level: config.NODE_ENV === 'production' ? 'info' : 'debug',
  redact: {
    paths: ['pnr', '*.pnr', 'pnrNumber', '*.pnrNumber', 'token', '*.token', 'req.headers.authorization', 'password', '*.password'],
    censor: '[redacted]',
  },
  transport: config.NODE_ENV === 'production' ? undefined : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } },
});
