import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Storage } from '@google-cloud/storage';
import { Logger } from 'winston';
import config, { NODE_ENV } from '../config';
import {
  BotExecutionContext,
  isHrmsExecutionContext,
  isHrmsS3RecordingTarget,
} from '../execution/types';

interface UploadOption {
  skipTimestamp?: boolean;
}

interface DebugImageUploadResult {
  success: boolean;
  provider: 'gcp' | 's3';
  storagePath?: string;
  url?: string;
  key?: string;
  bucket?: string;
}

const storage = new Storage();

const sanitizeSegment = (value: string) =>
  value
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

const buildS3CompatibleUrl = (
  endpoint: string | undefined,
  region: string,
  bucket: string,
  forcePathStyle: boolean,
  key: string,
): string => {
  const safeKey = encodeURI(key);
  if (endpoint) {
    const ep = endpoint.replace(/\/$/, '');
    if (forcePathStyle) {
      return `${ep}/${bucket}/${safeKey}`;
    }
    const url = new URL(ep);
    return `${url.protocol}//${bucket}.${url.host}/${safeKey}`;
  }

  return `https://${bucket}.s3.${region}.amazonaws.com/${safeKey}`;
};

async function uploadImageToGCP(
  fileName: string,
  buffer: Buffer,
  logger: Logger,
): Promise<DebugImageUploadResult> {
  try {
    const bucket = storage.bucket(config.miscStorageBucket ?? '');
    const file = bucket.file(fileName);
    await file.save(buffer);
    return {
      success: true,
      provider: 'gcp',
      storagePath: fileName,
    };
  } catch (error) {
    logger.error('Error uploading buffer to GCP debug storage', {
      phase: 'debug-artifact.upload.failed',
      error,
    });
    return {
      success: false,
      provider: 'gcp',
    };
  }
}

async function uploadImageToHrmsS3(
  executionContext: Extract<BotExecutionContext, { mode: 'hrms' }>,
  fileName: string,
  buffer: Buffer,
  logger: Logger,
  opts?: UploadOption,
): Promise<DebugImageUploadResult> {
  if (!isHrmsS3RecordingTarget(executionContext.recording)) {
    logger.warn('Skipping HRMS debug screenshot upload because recording destination is not S3', {
      phase: 'debug-artifact.upload.skipped',
      destination: executionContext.recording.destination,
    });
    return {
      success: false,
      provider: 's3',
    };
  }

  const s3 = config.s3CompatibleStorage;
  const bucket = executionContext.recording.bucket;
  const region = executionContext.recording.region;
  const endpoint = executionContext.recording.endpoint;
  const forcePathStyle = !!executionContext.recording.forcePathStyle;

  if (!s3.accessKeyId || !s3.secretAccessKey) {
    logger.error('Missing S3 credentials for HRMS debug screenshot upload', {
      phase: 'debug-artifact.upload.failed',
      bucket,
      region,
    });
    return {
      success: false,
      provider: 's3',
    };
  }

  const timestamp = opts?.skipTimestamp
    ? ''
    : `${new Date().toISOString().replace(/[:.]/g, '-')}-`;
  const safeLabel = sanitizeSegment(fileName) || 'debug-image';
  const key = `${executionContext.recording.keyPrefix}/debug/${executionContext.moduleId}/${executionContext.jobId}/${timestamp}${safeLabel}.png`;

  const client = new S3Client({
    region,
    endpoint,
    forcePathStyle,
    credentials: {
      accessKeyId: s3.accessKeyId,
      secretAccessKey: s3.secretAccessKey,
    },
  });

  try {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: buffer,
        ContentType: 'image/png',
      }),
    );
    const url = buildS3CompatibleUrl(
      endpoint,
      region,
      bucket,
      forcePathStyle,
      key,
    );
    return {
      success: true,
      provider: 's3',
      bucket,
      key,
      storagePath: `s3://${bucket}/${key}`,
      url,
    };
  } catch (error) {
    logger.error('Error uploading HRMS debug screenshot to S3', {
      phase: 'debug-artifact.upload.failed',
      bucket,
      key,
      region,
      error,
    });
    return {
      success: false,
      provider: 's3',
      bucket,
      key,
      storagePath: `s3://${bucket}/${key}`,
    };
  }
}

// TODO Save to local volume for development
export const uploadDebugImage = async (
  buffer: Buffer,
  fileName: string,
  userId: string,
  logger: Logger,
  botId?: string,
  opts?: UploadOption,
  executionContext?: BotExecutionContext,
) => {
  try {
    if (NODE_ENV === 'development') {
      return;
    }

    logger.info('Begin upload Debug Image', {
      phase: 'debug-artifact.upload.started',
      debugLabel: fileName,
      userId,
      botId,
    });

    let result: DebugImageUploadResult;

    if (executionContext && isHrmsExecutionContext(executionContext)) {
      result = await uploadImageToHrmsS3(
        executionContext,
        fileName,
        buffer,
        logger,
        opts,
      );
    } else {
      if (!config.miscStorageBucket) {
        logger.error('Developer TODO: Add .env value for GCP_MISC_BUCKET', {
          phase: 'debug-artifact.upload.failed',
          userId,
          botId,
        });
        return;
      }
      const bot = botId ?? 'bot';
      const now = opts?.skipTimestamp ? '' : `-${new Date().toISOString()}`;
      const qualifiedFile = `${config.miscStorageFolder}/${userId}/${bot}/${fileName}${now}.png`;
      result = await uploadImageToGCP(qualifiedFile, buffer, logger);
    }

    if (result.success) {
      logger.info(`Debug Image File uploaded successfully: ${fileName}`, {
        phase: 'debug-artifact.upload.finished',
        provider: result.provider,
        storagePath: result.storagePath,
        bucket: result.bucket,
        key: result.key,
        url: result.url,
      });
      return;
    }

    logger.warn(`Debug Image File upload failed: ${fileName}`, {
      phase: 'debug-artifact.upload.failed',
      provider: result.provider,
      storagePath: result.storagePath,
      bucket: result.bucket,
      key: result.key,
    });
  } catch (err) {
    logger.error('Error uploading debug image:', {
      phase: 'debug-artifact.upload.failed',
      userId,
      botId,
      error: err,
    });
  }
};
