import { promises as fs, existsSync } from 'fs';
import path from 'path';
import { logger } from '../lib/logger';
import { readStore, writeStore, type Store } from './storage';

export interface BackupConfig {
  enabled: boolean;
  backupDir: string;
  maxBackups: number;
  cronSchedule: string;
}

export interface BackupMetadata {
  timestamp: string;
  filename: string;
  size: number;
  datasetsCount: number;
  transactionsCount: number;
}

export class BackupService {
  private config: BackupConfig;

  constructor(config: BackupConfig) {
    this.config = config;
  }

  private async ensureBackupDirectory(): Promise<void> {
    if (!existsSync(this.config.backupDir)) {
      await fs.mkdir(this.config.backupDir, { recursive: true });
      logger.info(`[Backup] Created backup directory: ${this.config.backupDir}`);
    }
  }

  async createBackup(): Promise<BackupMetadata> {
    try {
      await this.ensureBackupDirectory();
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const unique = Math.random().toString(36).slice(2, 8);
      const filename = `backup-${timestamp}-${unique}.json`;
      const backupPath = path.join(this.config.backupDir, filename);

      const store = await readStore();
      const nowIso = new Date().toISOString();
      const backupData = {
        metadata: {
          timestamp: nowIso,
          version: '1.0.0',
          datasetsCount: store.datasets.length,
          transactionsCount: store.transactions.length,
        },
        data: store,
      };

      await fs.writeFile(backupPath, JSON.stringify(backupData, null, 2), 'utf-8');

      const stats = await fs.stat(backupPath);
      const metadata: BackupMetadata = {
        timestamp: nowIso,
        filename,
        size: stats.size,
        datasetsCount: store.datasets.length,
        transactionsCount: store.transactions.length,
      };

      logger.info(
        `[Backup] Created backup: ${filename} (${this.formatBytes(stats.size)}, ` +
          `${store.datasets.length} datasets, ${store.transactions.length} transactions)`,
      );

      await this.rotateBackups();
      return metadata;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`[Backup] Failed to create backup: ${message}`);
      throw error;
    }
  }

  private async rotateBackups(): Promise<void> {
    try {
      const filesList = await fs.readdir(this.config.backupDir);
      const files = await Promise.all(
        filesList
          .filter(f => f.startsWith('backup-') && f.endsWith('.json'))
          .map(async f => {
            const filePath = path.join(this.config.backupDir, f);
            const stats = await fs.stat(filePath);
            return { name: f, path: filePath, mtime: stats.mtime };
          }),
      );

      files.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

      if (files.length > this.config.maxBackups) {
        const toDelete = files.slice(this.config.maxBackups);
        for (const file of toDelete) {
          await fs.unlink(file.path);
          logger.info(`[Backup] Rotated old backup: ${file.name}`);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`[Backup] Failed to rotate backups: ${message}`);
    }
  }

  async listBackups(): Promise<BackupMetadata[]> {
    try {
      await this.ensureBackupDirectory();
      const filesList = await fs.readdir(this.config.backupDir);
      const backupFiles = filesList.filter(f => f.startsWith('backup-') && f.endsWith('.json'));

      const backups = await Promise.all(
        backupFiles.map(async f => {
          const filePath = path.join(this.config.backupDir, f);
          const stats = await fs.stat(filePath);
          const content = JSON.parse(await fs.readFile(filePath, 'utf-8'));
          return {
            timestamp: content.metadata?.timestamp || stats.mtime.toISOString(),
            filename: f,
            size: stats.size,
            datasetsCount: content.metadata?.datasetsCount || 0,
            transactionsCount: content.metadata?.transactionsCount || 0,
          };
        }),
      );

      return backups.sort(
        (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`[Backup] Failed to list backups: ${message}`);
      return [];
    }
  }

  async restoreBackup(filename: string): Promise<void> {
    try {
      const backupPath = path.join(this.config.backupDir, filename);

      if (!existsSync(backupPath)) {
        throw new Error(`Backup file not found: ${filename}`);
      }

      const backupContent = JSON.parse(await fs.readFile(backupPath, 'utf-8'));
      const restoredStore = backupContent.data as Store;

      // Safety backup before restoring
      const safetyBackup = `pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      const safetyPath = path.join(this.config.backupDir, safetyBackup);
      const currentStore = await readStore();
      await fs.writeFile(
        safetyPath,
        JSON.stringify(
          {
            metadata: {
              timestamp: new Date().toISOString(),
              version: '1.0.0',
              datasetsCount: currentStore.datasets.length,
              transactionsCount: currentStore.transactions.length,
            },
            data: currentStore,
          },
          null,
          2,
        ),
        'utf-8',
      );

      await writeStore(restoredStore);

      logger.info(`[Backup] Restored from backup: ${filename}`);
      logger.info(`[Backup] Safety backup created: ${safetyBackup}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`[Backup] Failed to restore backup: ${message}`);
      throw error;
    }
  }

  async getBackupStats(): Promise<{
    totalBackups: number;
    totalSize: number;
    oldestBackup: string | null;
    newestBackup: string | null;
  }> {
    const backups = await this.listBackups();
    return {
      totalBackups: backups.length,
      totalSize: backups.reduce((sum, b) => sum + b.size, 0),
      oldestBackup: backups.length > 0 ? backups[backups.length - 1]!.timestamp : null,
      newestBackup: backups.length > 0 ? backups[0]!.timestamp : null,
    };
  }

  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  }
}
