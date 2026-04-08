import express, { Request, Response } from 'express';
import DiskUploader, { IUploader } from '../middleware/disk-uploader';
import { globalJobStore } from '../lib/globalJobStore';
import { encodeFileNameSafebase64 } from '../util/strings';
import { getRecordingNamePrefix } from '../util/recordingName';
import { createHrmsCorrelationId, getErrorType, loggerFactory } from '../util/logger';
import { HrmsJobRequest, HrmsExecutionContext, HrmsJobResult } from '../execution/types';
import { GoogleMeetBot } from '../bots/GoogleMeetBot';
import { MicrosoftTeamsBot } from '../bots/MicrosoftTeamsBot';
import { ZoomBot } from '../bots/ZoomBot';
import { JoinParams } from '../bots/AbstractMeetBot';
import { notifyHrmsJobResult } from '../services/hrmsCallbackService';
import { Logger } from 'winston';

const router = express.Router();
const IMMEDIATE_WINDOW_MS = 60 * 1000;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isValidUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function normalizeMetadata(metadata?: HrmsJobRequest['metadata']): Record<string, string> | undefined {
  if (!metadata) {
    return undefined;
  }

  const normalized = Object.entries(metadata).reduce<Record<string, string>>((acc, [key, value]) => {
    if (typeof value === 'string' && value.trim()) {
      acc[key] = value.trim();
    }
    return acc;
  }, {});

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function validateHrmsJob(body: unknown): { valid: true; job: HrmsJobRequest } | { valid: false; error: string } {
  const job = body as HrmsJobRequest;

  if (!job || typeof job !== 'object') {
    return { valid: false, error: 'Request body must be a JSON object' };
  }

  if (!isNonEmptyString(job.jobId)) {
    return { valid: false, error: 'jobId is required' };
  }
  if (!isNonEmptyString(job.moduleId)) {
    return { valid: false, error: 'moduleId is required' };
  }
  if (job.provider !== 'google' && job.provider !== 'microsoft' && job.provider !== 'zoom') {
    return { valid: false, error: 'provider must be one of google, microsoft, or zoom' };
  }
  if (!isNonEmptyString(job.meetingUrl) || !isValidUrl(job.meetingUrl)) {
    return { valid: false, error: 'meetingUrl must be a valid URL' };
  }
  if (!isNonEmptyString(job.meetingTitle)) {
    return { valid: false, error: 'meetingTitle is required' };
  }
  if (!isNonEmptyString(job.botDisplayName)) {
    return { valid: false, error: 'botDisplayName is required' };
  }
  if (!isNonEmptyString(job.timezone)) {
    return { valid: false, error: 'timezone is required' };
  }
  if (!isNonEmptyString(job.callbackUrl) || !isValidUrl(job.callbackUrl)) {
    return { valid: false, error: 'callbackUrl must be a valid URL' };
  }
  if (!isNonEmptyString(job.callbackSecret)) {
    return { valid: false, error: 'callbackSecret is required' };
  }
  if (!job.recording || typeof job.recording !== 'object') {
    return { valid: false, error: 'recording is required' };
  }
  if (!isNonEmptyString(job.recording.bucket)) {
    return { valid: false, error: 'recording.bucket is required' };
  }
  if (!isNonEmptyString(job.recording.region)) {
    return { valid: false, error: 'recording.region is required' };
  }
  if (!isNonEmptyString(job.recording.keyPrefix)) {
    return { valid: false, error: 'recording.keyPrefix is required' };
  }
  if (job.recording.endpoint !== undefined && !isValidUrl(job.recording.endpoint)) {
    return { valid: false, error: 'recording.endpoint must be a valid URL when provided' };
  }

  const joinAt = job.metadata?.joinAt?.trim();
  if (joinAt) {
    const joinAtTime = Date.parse(joinAt);
    if (Number.isNaN(joinAtTime)) {
      return { valid: false, error: 'metadata.joinAt must be a valid ISO date when provided' };
    }
    if (joinAtTime - Date.now() > IMMEDIATE_WINDOW_MS) {
      return { valid: false, error: 'HRMS jobs must be executed immediately; scheduling belongs in HRMS' };
    }
  }

  return { valid: true, job };
}

function createBot(provider: HrmsExecutionContext['provider'], correlationId: string, logger: Logger) {
  switch (provider) {
    case 'google':
      return new GoogleMeetBot(logger, correlationId);
    case 'microsoft':
      return new MicrosoftTeamsBot(logger, correlationId);
    case 'zoom':
      return new ZoomBot(logger, correlationId);
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}

async function runHrmsJob(executionContext: HrmsExecutionContext, logger: Logger) {
  try {
    const tempFileId = encodeFileNameSafebase64(`${executionContext.jobId}:${executionContext.moduleId}`);
    const uploader: IUploader = await DiskUploader.initialize(
      '',
      executionContext.moduleId,
      executionContext.timezone,
      executionContext.jobId,
      executionContext.moduleId,
      getRecordingNamePrefix(executionContext.provider),
      tempFileId,
      logger,
      executionContext.meetingUrl,
      executionContext,
    );

    const joinParams: JoinParams = {
      url: executionContext.meetingUrl,
      name: executionContext.botDisplayName,
      bearerToken: '',
      teamId: executionContext.moduleId,
      timezone: executionContext.timezone,
      userId: executionContext.jobId,
      botId: executionContext.moduleId,
      uploader,
      executionContext,
    };

    const correlationId = createHrmsCorrelationId({
      jobId: executionContext.jobId,
      moduleId: executionContext.moduleId,
      provider: executionContext.provider,
      meetingUrl: executionContext.meetingUrl,
    });
    const bot = createBot(executionContext.provider, correlationId, logger);

    await bot.join(joinParams);
    const recording = uploader.getUploadedRecordingDetails();

    if (
      !recording ||
      !recording.bucket ||
      !recording.key ||
      !recording.region ||
      !recording.storagePath ||
      !recording.fileName ||
      !recording.contentType ||
      !recording.sizeBytes
    ) {
      throw new Error('Recording upload completed without usable S3 metadata');
    }

    const successPayload: HrmsJobResult = {
      jobId: executionContext.jobId,
      moduleId: executionContext.moduleId,
      provider: executionContext.provider,
      status: 'completed',
      meetingUrl: executionContext.meetingUrl,
      startedAt: executionContext.startedAt,
      completedAt: new Date().toISOString(),
      recording: {
        bucket: recording.bucket,
        key: recording.key,
        region: recording.region,
        endpoint: recording.endpoint,
        fileName: recording.fileName,
        contentType: recording.contentType,
        sizeBytes: recording.sizeBytes,
        storagePath: recording.storagePath,
        url: recording.url,
      },
      metadata: executionContext.metadata,
    };

    await notifyHrmsJobResult(executionContext, successPayload, logger);
  } catch (error) {
    const failurePayload: HrmsJobResult = {
      jobId: executionContext.jobId,
      moduleId: executionContext.moduleId,
      provider: executionContext.provider,
      status: 'failed',
      meetingUrl: executionContext.meetingUrl,
      startedAt: executionContext.startedAt,
      completedAt: new Date().toISOString(),
      error: {
        code: getErrorType(error),
        message: error instanceof Error ? error.message : String(error),
      },
      metadata: executionContext.metadata,
    };

    await notifyHrmsJobResult(executionContext, failurePayload, logger);
    throw error;
  }
}

router.post('/jobs', async (req: Request, res: Response) => {
  const validation = validateHrmsJob(req.body);
  if (!validation.valid) {
    return res.status(400).json({
      success: false,
      error: validation.error,
    });
  }

  const { job } = validation;
  const executionContext: HrmsExecutionContext = {
    mode: 'hrms',
    jobId: job.jobId.trim(),
    moduleId: job.moduleId.trim(),
    provider: job.provider,
    meetingUrl: job.meetingUrl.trim(),
    meetingTitle: job.meetingTitle.trim(),
    botDisplayName: job.botDisplayName.trim(),
    timezone: job.timezone.trim(),
    callbackUrl: job.callbackUrl.trim(),
    callbackSecret: job.callbackSecret,
    recording: {
      bucket: job.recording.bucket.trim(),
      region: job.recording.region.trim(),
      keyPrefix: job.recording.keyPrefix.trim(),
      endpoint: job.recording.endpoint?.trim(),
      forcePathStyle: job.recording.forcePathStyle === true,
    },
    metadata: normalizeMetadata(job.metadata),
    startedAt: new Date().toISOString(),
  };

  const correlationId = createHrmsCorrelationId({
    jobId: executionContext.jobId,
    moduleId: executionContext.moduleId,
    provider: executionContext.provider,
    meetingUrl: executionContext.meetingUrl,
  });
  const logger = loggerFactory(correlationId, executionContext.provider);

  try {
    const jobResult = await globalJobStore.addJob(async () => {
      await runHrmsJob(executionContext, logger);
    }, logger);

    if (!jobResult.accepted) {
      return res.status(409).json({
        success: false,
        error: 'Another meeting is currently being processed. Please try again later.',
        data: {
          jobId: executionContext.jobId,
          moduleId: executionContext.moduleId,
        },
      });
    }

    return res.status(202).json({
      success: true,
      message: 'HRMS meeting job accepted and processing started',
      data: {
        jobId: executionContext.jobId,
        moduleId: executionContext.moduleId,
        status: 'processing',
      },
    });
  } catch (error) {
    logger.error('Error setting up HRMS job', {
      jobId: executionContext.jobId,
      moduleId: executionContext.moduleId,
      error: error instanceof Error ? error.message : String(error),
    });

    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
      data: {
        jobId: executionContext.jobId,
        moduleId: executionContext.moduleId,
      },
    });
  }
});

export default router;
