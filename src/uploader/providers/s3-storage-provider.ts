import { StorageProvider, UploadOptions, S3UploadTarget } from './storage-provider';
import config from '../../config';
import { S3Client, S3ClientConfig } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { createReadStream } from 'fs';

export class S3StorageProvider implements StorageProvider {
  readonly name = 's3' as const;

  private resolveTarget(target?: S3UploadTarget) {
    const s3 = config.s3CompatibleStorage;
    return {
      bucket: target?.bucket || s3.bucket,
      region: target?.region || s3.region,
      endpoint: target?.endpoint ?? s3.endpoint,
      forcePathStyle:
        typeof target?.forcePathStyle === 'boolean'
          ? target.forcePathStyle
          : !!s3.forcePathStyle,
    };
  }

  validateConfig(options?: { s3Target?: S3UploadTarget }): void {
    const s3 = config.s3CompatibleStorage;
    const target = this.resolveTarget(options?.s3Target);
    const missing: string[] = [];
    if (!s3.accessKeyId) missing.push('S3_ACCESS_KEY_ID');
    if (!s3.secretAccessKey) missing.push('S3_SECRET_ACCESS_KEY');
    if (!target.region) missing.push('S3_REGION');
    if (!target.bucket) missing.push('S3_BUCKET_NAME');
    if (missing.length) {
      throw new Error(`S3 compatible storage configuration is not set or incomplete. Missing: ${missing.join(', ')}`);
    }
  }

  async uploadFile(options: UploadOptions): Promise<boolean> {
    const s3Config = config.s3CompatibleStorage;
    const target = this.resolveTarget(options.s3Target);

    // TypeScript knows these are defined because validateConfig() was called first
    if (!target.region || !s3Config.accessKeyId || !s3Config.secretAccessKey || !target.bucket) {
      throw new Error('S3 configuration validation failed - this should never happen after validateConfig()');
    }

    const clientConfig: S3ClientConfig = {
      region: target.region,
      credentials: {
        accessKeyId: s3Config.accessKeyId,
        secretAccessKey: s3Config.secretAccessKey,
      },
      forcePathStyle: !!target.forcePathStyle,
    };

    if (target.endpoint) {
      clientConfig.endpoint = target.endpoint;
    }

    const s3Client = new S3Client(clientConfig);

    try {
      options.logger.info(`Starting upload of ${options.key}`);
      const upload = new Upload({
        client: s3Client,
        params: {
          Bucket: target.bucket,
          Key: options.key,
          Body: createReadStream(options.filePath),
          ContentType: options.contentType,
        },
        queueSize: options.concurrency || 4,
        partSize: options.partSize || 50 * 1024 * 1024,
      });

      upload.on('httpUploadProgress', (progress) => {
        options.logger.info(`Uploaded ${options.key} ${progress.loaded} of ${progress.total || 0} bytes`);
      });

      await upload.done();
      options.logger.info(`Upload of ${options.key} complete.`);
      return true;
    } catch (err) {
      options.logger.error(`Upload for ${options.key} failed.`, err);
      return false;
    }
  }
}
