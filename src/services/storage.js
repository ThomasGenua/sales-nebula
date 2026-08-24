/**
 * File Storage Service
 * Uses S3 when configured, falls back to local disk.
 * Provides unified interface for upload, download, delete, and presigned URLs.
 */

const path = require('path');
const fs = require('fs');
const { v4: uuid } = require('uuid');

let S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand;
let getSignedUrl;
try {
  ({ S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3'));
  ({ getSignedUrl } = require('@aws-sdk/s3-request-presigner'));
} catch (e) { /* S3 SDK not installed */ }

class StorageService {
  constructor() {
    this.mode = 'local';
    this.s3 = null;
    this.bucket = process.env.S3_BUCKET || 'sales-nebula-uploads';
    this.localDir = process.env.UPLOAD_DIR || './uploads';
  }

  init() {
    if (process.env.AWS_ACCESS_KEY_ID && S3Client) {
      try {
        this.s3 = new S3Client({
          region: process.env.AWS_REGION || 'us-east-1',
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          },
        });
        this.mode = 's3';
        console.log(`  Storage: S3 (${this.bucket})`);
      } catch (err) {
        console.log('  Storage: S3 init failed, using local');
      }
    } else {
      console.log(`  Storage: Local (${this.localDir})`);
    }
    // Ensure local dir exists
    if (!fs.existsSync(this.localDir)) fs.mkdirSync(this.localDir, { recursive: true });
  }

  // Generate a unique key for a file
  generateKey(originalName, folder = 'documents') {
    const ext = path.extname(originalName);
    return `${folder}/${uuid()}${ext}`;
  }

  // Upload a file buffer
  async upload(buffer, key, contentType = 'application/octet-stream') {
    if (this.mode === 's3') {
      await this.s3.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buffer,
        ContentType: contentType,
      }));
      return { key, url: `https://${this.bucket}.s3.amazonaws.com/${key}`, storage: 's3' };
    }
    // Local
    const filePath = path.join(this.localDir, key.replace(/\//g, '_'));
    fs.writeFileSync(filePath, buffer);
    return { key, path: filePath, url: `/uploads/${path.basename(filePath)}`, storage: 'local' };
  }

  // Upload from multer file object
  async uploadFile(file, folder = 'documents') {
    const key = this.generateKey(file.originalname, folder);
    const buffer = file.buffer || fs.readFileSync(file.path);
    return this.upload(buffer, key, file.mimetype);
  }

  // Get a presigned download URL (S3) or file path (local)
  async getDownloadUrl(key, expiresIn = 3600) {
    if (this.mode === 's3') {
      const command = new GetObjectCommand({ Bucket: this.bucket, Key: key });
      return getSignedUrl(this.s3, command, { expiresIn });
    }
    // Local: return relative path
    return `/uploads/${key.replace(/\//g, '_')}`;
  }

  // Delete a file
  async delete(key) {
    if (this.mode === 's3') {
      await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } else {
      const filePath = path.join(this.localDir, key.replace(/\//g, '_'));
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
  }

  // Get upload config for multer
  getMulterConfig() {
    const multer = require('multer');
    if (this.mode === 's3') {
      try {
        const multerS3 = require('multer-s3');
        return multer({
          storage: multerS3({
            s3: this.s3,
            bucket: this.bucket,
            key: (req, file, cb) => cb(null, this.generateKey(file.originalname)),
          }),
          limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE) || 10485760 },
        });
      } catch (e) { /* fall through to local */ }
    }
    return multer({
      storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, this.localDir),
        filename: (req, file, cb) => cb(null, `${uuid()}${path.extname(file.originalname)}`),
      }),
      limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE) || 10485760 },
    });
  }
}

const storage = new StorageService();

module.exports = { storage };
