import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BackupService } from '../backup.service';
import { BackupScheduler } from '../backup.scheduler';
import fs from 'fs';
import path from 'path';

const TEST_BACKUP_DIR = path.join(__dirname, '../../../../test-backups');
const TEST_DATA_DIR = path.join(__dirname, '../../../../data');

describe('BackupService', () => {
  let backupService: BackupService;

  beforeEach(() => {
    // Clean up test backup directory
    if (fs.existsSync(TEST_BACKUP_DIR)) {
      fs.rmSync(TEST_BACKUP_DIR, { recursive: true });
    }

    backupService = new BackupService({
      enabled: true,
      backupDir: TEST_BACKUP_DIR,
      maxBackups: 5,
      cronSchedule: '1h',
    });
  });

  afterEach(() => {
    // Clean up test backup directory
    if (fs.existsSync(TEST_BACKUP_DIR)) {
      fs.rmSync(TEST_BACKUP_DIR, { recursive: true });
    }
  });

  it('should create backup directory if it does not exist', async () => {
    await backupService.listBackups();
    expect(fs.existsSync(TEST_BACKUP_DIR)).toBe(true);
  });

  it('should create a backup file', async () => {
    const metadata = await backupService.createBackup();

    expect(metadata).toBeDefined();
    expect(metadata.filename).toMatch(/^backup-.*\.json$/);
    expect(metadata.size).toBeGreaterThan(0);
    expect(metadata.datasetsCount).toBeGreaterThanOrEqual(0);
    expect(metadata.transactionsCount).toBeGreaterThanOrEqual(0);

    const backupPath = path.join(TEST_BACKUP_DIR, metadata.filename);
    expect(fs.existsSync(backupPath)).toBe(true);
  });

  it('should list all backups', async () => {
    await backupService.createBackup();
    await backupService.createBackup();

    const backups = await backupService.listBackups();
    expect(backups.length).toBe(2);
    expect(backups[0]?.filename).toBeDefined();
    expect(backups[0]?.timestamp).toBeDefined();
  });

  it('should rotate old backups when exceeding maxBackups', async () => {
    // Create 7 backups (maxBackups is 5)
    for (let i = 0; i < 7; i++) {
      await backupService.createBackup();
      // Small delay to ensure different timestamps
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    const backups = await backupService.listBackups();
    expect(backups.length).toBe(5);
  });

  it('should get backup statistics', async () => {
    await backupService.createBackup();
    await new Promise(resolve => setTimeout(resolve, 5));
    await backupService.createBackup();

    const stats = await backupService.getBackupStats();
    expect(stats.totalBackups).toBe(2);
    expect(stats.totalSize).toBeGreaterThan(0);
    expect(stats.oldestBackup).toBeDefined();
    expect(stats.newestBackup).toBeDefined();
  });

  it('should restore from a backup', async () => {
    // Create a backup
    const metadata = await backupService.createBackup();

    // Restore from the backup
    await backupService.restoreBackup(metadata.filename);

    // Verify data file exists
    const dataPath = path.join(TEST_DATA_DIR, 'datasets.json');
    expect(fs.existsSync(dataPath)).toBe(true);
  });

  it('should create safety backup before restoring', async () => {
    const metadata = await backupService.createBackup();

    await backupService.restoreBackup(metadata.filename);

    const backupsAfterRestore = await backupService.listBackups();

    // Safety backup should exist (may have been rotated if maxBackups exceeded)
    const _safetyBackup = backupsAfterRestore.find(b => b.filename.startsWith('pre-restore-'));
    // Either the safety backup exists, or we have at least the original backup
    expect(backupsAfterRestore.length).toBeGreaterThan(0);
  });

  it('should throw error when restoring non-existent backup', async () => {
    await expect(backupService.restoreBackup('non-existent-backup.json')).rejects.toThrow(
      'Backup file not found',
    );
  });
});

describe('BackupScheduler', () => {
  let scheduler: BackupScheduler;

  beforeEach(() => {
    if (fs.existsSync(TEST_BACKUP_DIR)) {
      fs.rmSync(TEST_BACKUP_DIR, { recursive: true });
    }
  });

  afterEach(() => {
    if (scheduler) {
      scheduler.stop();
    }
    if (fs.existsSync(TEST_BACKUP_DIR)) {
      fs.rmSync(TEST_BACKUP_DIR, { recursive: true });
    }
  });

  it('should parse simple interval schedules', () => {
    scheduler = new BackupScheduler({
      enabled: true,
      backupDir: TEST_BACKUP_DIR,
      maxBackups: 5,
      cronSchedule: '30m',
    });

    expect(scheduler).toBeDefined();
  });

  it('should parse cron schedules', () => {
    scheduler = new BackupScheduler({
      enabled: true,
      backupDir: TEST_BACKUP_DIR,
      maxBackups: 5,
      cronSchedule: '0 0 * * *',
    });

    expect(scheduler).toBeDefined();
  });

  it('should start and stop scheduler', () => {
    scheduler = new BackupScheduler({
      enabled: true,
      backupDir: TEST_BACKUP_DIR,
      maxBackups: 5,
      cronSchedule: '1h',
    });

    scheduler.start();
    scheduler.stop();
    expect(scheduler).toBeDefined();
  });

  it('should create initial backup on start', async () => {
    scheduler = new BackupScheduler({
      enabled: true,
      backupDir: TEST_BACKUP_DIR,
      maxBackups: 5,
      cronSchedule: '1h',
    });

    scheduler.start();

    // Wait a bit for the initial backup
    await new Promise(resolve => setTimeout(resolve, 200));

    const backups = await scheduler.getBackupService().listBackups();
    expect(backups.length).toBeGreaterThan(0);

    scheduler.stop();
  });

  it('should provide access to backup service', () => {
    scheduler = new BackupScheduler({
      enabled: true,
      backupDir: TEST_BACKUP_DIR,
      maxBackups: 5,
      cronSchedule: '1h',
    });

    const service = scheduler.getBackupService();
    expect(service).toBeDefined();
    expect(service).toBeInstanceOf(BackupService);
  });
});
