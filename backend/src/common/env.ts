import { logger } from '../lib/logger';

export function parsePositiveInt(envVar: string | undefined, fallback: number): number {
  if (!envVar) return fallback;
  const parsed = Number.parseInt(envVar, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    logger.warn(`Env var value "${envVar}" is not a positive integer, using fallback ${fallback}`);
    return fallback;
  }
  return parsed;
}
