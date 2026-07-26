import { BackupService, BackupConfig } from './backup.service';
import { logger } from '../lib/logger';

/**
 * Cron-like scheduler for automated backups
 */
export class BackupScheduler {
  private backupService: BackupService;
  private intervalId: NodeJS.Timeout | null = null;
  private cronSchedule: string;

  constructor(config: BackupConfig) {
    this.backupService = new BackupService(config);
    this.cronSchedule = config.cronSchedule;
  }

  /**
   * Start the backup scheduler
   */
  start(): void {
    if (this.intervalId) {
      logger.info('[Backup Scheduler] Already running');
      return;
    }

    const intervalMs = this.parseCronSchedule(this.cronSchedule);

    logger.info(
      `[Backup Scheduler] Starting automated backups (${this.cronSchedule}, every ${this.formatInterval(intervalMs)})`,
    );

    // Run initial backup
    this.runBackup();

    // Schedule recurring backups
    this.intervalId = setInterval(() => {
      this.runBackup();
    }, intervalMs);
  }

  /**
   * Stop the backup scheduler
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info('[Backup Scheduler] Stopped');
    }
  }

  /**
   * Run a backup immediately
   */
  private async runBackup(): Promise<void> {
    try {
      await this.backupService.createBackup();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`[Backup Scheduler] Backup failed: ${message}`);
    }
  }

  /**
   * Parse cron schedule string to milliseconds
   * Supports simplified cron format or simple intervals
   */
  private parseCronSchedule(schedule: string): number {
    // Simple interval format (e.g., "1h", "30m", "1d")
    const simpleMatch = schedule.match(/^(\d+)(m|h|d)$/);
    if (simpleMatch && simpleMatch[1]) {
      const value = parseInt(simpleMatch[1], 10);
      const unit = simpleMatch[2];

      switch (unit) {
        case 'm':
          return value * 60 * 1000; // minutes
        case 'h':
          return value * 60 * 60 * 1000; // hours
        case 'd':
          return value * 24 * 60 * 60 * 1000; // days
      }
    }

    // Cron format parsing
    const parts = schedule.split(' ');
    if (parts.length === 5) {
      const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
      if (minute && hour && dayOfMonth && month && dayOfWeek) {
        // Every N minutes
        if (minute.startsWith('*/')) {
          const minutes = parseInt(minute.slice(2), 10);
          return minutes * 60 * 1000;
        }

        // Hourly
        if (minute === '0' && hour === '*') {
          return 60 * 60 * 1000;
        }

        // Daily
        if (minute === '0' && hour === '0' && dayOfMonth === '*' && month === '*') {
          return 24 * 60 * 60 * 1000;
        }

        // Weekly
        if (
          minute === '0' &&
          hour === '0' &&
          dayOfMonth === '*' &&
          month === '*' &&
          dayOfWeek !== '*'
        ) {
          return 7 * 24 * 60 * 60 * 1000;
        }
      }
    }

    // Default to 1 hour if parsing fails
    logger.warn(`[Backup Scheduler] Could not parse schedule "${schedule}", defaulting to 1 hour`);
    return 60 * 60 * 1000;
  }

  /**
   * Format interval in milliseconds to human-readable string
   */
  private formatInterval(ms: number): string {
    const seconds = ms / 1000;
    const minutes = seconds / 60;
    const hours = minutes / 60;
    const days = hours / 24;

    if (days >= 1) return `${days} day${days !== 1 ? 's' : ''}`;
    if (hours >= 1) return `${hours} hour${hours !== 1 ? 's' : ''}`;
    if (minutes >= 1) return `${minutes} minute${minutes !== 1 ? 's' : ''}`;
    return `${seconds} second${seconds !== 1 ? 's' : ''}`;
  }

  /**
   * Get backup service instance for manual operations
   */
  getBackupService(): BackupService {
    return this.backupService;
  }
}
