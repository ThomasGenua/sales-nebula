#!/usr/bin/env node

/**
 * Database Backup Script
 * Creates a pg_dump backup, compresses it, and optionally uploads to S3.
 * Retains last N backups locally.
 * 
 * Usage:
 *   node scripts/backup.js                    # Local backup
 *   node scripts/backup.js --upload-s3        # Backup + S3 upload
 *   node scripts/backup.js --retention 14     # Keep 14 days of backups
 * 
 * Cron (daily at 2am):
 *   0 2 * * * cd /app && node scripts/backup.js --upload-s3 >> /var/log/sn-backup.log 2>&1
 */

require('dotenv').config();
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups');
const RETENTION_DAYS = parseInt(process.argv.find((_, i, a) => a[i - 1] === '--retention') || 7);
const UPLOAD_S3 = process.argv.includes('--upload-s3');

async function backup() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `sn-backup-${timestamp}.sql.gz`;
  const filepath = path.join(BACKUP_DIR, filename);

  // Ensure backup directory exists
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

  console.log(`[Backup] Starting: ${filename}`);

  // Parse DATABASE_URL
  const dbUrl = new URL(process.env.DATABASE_URL);
  const pgHost = dbUrl.hostname;
  const pgPort = dbUrl.port || 5432;
  const pgUser = dbUrl.username;
  const pgPass = dbUrl.password;
  const pgDb = dbUrl.pathname.slice(1).split('?')[0];

  // Run pg_dump
  const env = { ...process.env, PGPASSWORD: pgPass };
  try {
    execSync(
      `pg_dump -h ${pgHost} -p ${pgPort} -U ${pgUser} -d ${pgDb} --no-owner --no-privileges | gzip > "${filepath}"`,
      { env, stdio: ['pipe', 'pipe', 'pipe'], timeout: 300000 }
    );
  } catch (err) {
    console.error(`[Backup] pg_dump failed: ${err.message}`);
    process.exit(1);
  }

  const stats = fs.statSync(filepath);
  console.log(`[Backup] Created: ${filename} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);

  // Upload to S3
  if (UPLOAD_S3 && process.env.AWS_ACCESS_KEY_ID) {
    try {
      const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
      const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
      await s3.send(new PutObjectCommand({
        Bucket: process.env.S3_BACKUP_BUCKET || process.env.S3_BUCKET || 'sales-nebula-backups',
        Key: `backups/${filename}`,
        Body: fs.readFileSync(filepath),
        ContentType: 'application/gzip',
      }));
      console.log(`[Backup] Uploaded to S3`);
    } catch (err) {
      console.error(`[Backup] S3 upload failed: ${err.message}`);
    }
  }

  // Rotate old backups
  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('sn-backup-') && f.endsWith('.sql.gz'))
    .sort();

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);

  let removed = 0;
  for (const file of files) {
    const fpath = path.join(BACKUP_DIR, file);
    const fstat = fs.statSync(fpath);
    if (fstat.mtime < cutoff) {
      fs.unlinkSync(fpath);
      removed++;
    }
  }
  if (removed > 0) console.log(`[Backup] Rotated ${removed} old backup(s)`);

  console.log(`[Backup] Complete`);
}

backup().catch(err => {
  console.error(`[Backup] Fatal: ${err.message}`);
  process.exit(1);
});
