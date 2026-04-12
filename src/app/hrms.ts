import express, { Request, Response } from 'express';
import DiskUploader, { IUploader } from '../middleware/disk-uploader';
import { globalJobStore } from '../lib/globalJobStore';
import { encodeFileNameSafebase64 } from '../util/strings';
import { getRecordingNamePrefix } from '../util/recordingName';
import { createHrmsCorrelationId, getErrorType, loggerFactory } from '../util/logger';
import {
  HrmsJobRequest,
  HrmsExecutionContext,
  HrmsJobResult,
  HrmsRecordingTarget,
  isHrmsS3RecordingTarget,
  isHrmsYouTubeRecordingTarget,
} from '../execution/types';
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
  if (job.recording.destination === 's3') {
    if (!isNonEmptyString(job.recording.bucket)) {
      return { valid: false, error: 'recording.bucket is required' };
    }
    if (!isNonEmptyString(job.recording.region)) {
      return { valid: false, error: 'recording.region is required' };
    }
    if (!isNonEmptyString(job.recording.keyPrefix)) {
      return { valid: false, error: 'recording.keyPrefix is required' };
    }
    if (
      job.recording.endpoint !== undefined &&
      !isValidUrl(job.recording.endpoint)
    ) {
      return {
        valid: false,
        error: 'recording.endpoint must be a valid URL when provided',
      };
    }
  } else if (job.recording.destination === 'youtube') {
    if (job.recording.privacyStatus !== 'public') {
      return {
        valid: false,
        error: 'recording.privacyStatus must be public for YouTube uploads',
      };
    }
    if (!isNonEmptyString(job.recording.accessToken)) {
      return {
        valid: false,
        error: 'recording.accessToken is required for YouTube uploads',
      };
    }
    if (!isNonEmptyString(job.recording.accessTokenExpiresAt)) {
      return {
        valid: false,
        error: 'recording.accessTokenExpiresAt is required for YouTube uploads',
      };
    }
    if (!isNonEmptyString(job.recording.tokenRefreshUrl) || !isValidUrl(job.recording.tokenRefreshUrl)) {
      return {
        valid: false,
        error: 'recording.tokenRefreshUrl must be a valid URL for YouTube uploads',
      };
    }
    if (!isNonEmptyString(job.recording.channelId)) {
      return {
        valid: false,
        error: 'recording.channelId is required for YouTube uploads',
      };
    }
  } else {
    return {
      valid: false,
      error: 'recording.destination must be one of s3 or youtube',
    };
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

function normalizeRecordingTarget(recording: HrmsJobRequest['recording']): HrmsRecordingTarget {
  if (recording.destination === 's3') {
    return {
      destination: 's3',
      bucket: recording.bucket.trim(),
      region: recording.region.trim(),
      keyPrefix: recording.keyPrefix.trim(),
      endpoint: recording.endpoint?.trim(),
      forcePathStyle: recording.forcePathStyle === true,
    };
  }

  return {
    destination: 'youtube',
    privacyStatus: 'public',
    title: recording.title?.trim(),
    description: recording.description?.trim(),
    accessToken: recording.accessToken.trim(),
    accessTokenExpiresAt: recording.accessTokenExpiresAt.trim(),
    tokenRefreshUrl: recording.tokenRefreshUrl.trim(),
    channelId: recording.channelId.trim(),
  };
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
    logger.info('Starting HRMS meeting job execution', {
      phase: 'job.started',
      storageProvider: executionContext.recording.destination,
      recordingBucket: isHrmsS3RecordingTarget(executionContext.recording)
        ? executionContext.recording.bucket
        : undefined,
      recordingRegion: isHrmsS3RecordingTarget(executionContext.recording)
        ? executionContext.recording.region
        : undefined,
      recordingKeyPrefix: isHrmsS3RecordingTarget(executionContext.recording)
        ? executionContext.recording.keyPrefix
        : undefined,
      youtubeTitle: isHrmsYouTubeRecordingTarget(executionContext.recording)
        ? executionContext.recording.title
        : undefined,
      youtubeChannelId: isHrmsYouTubeRecordingTarget(executionContext.recording)
        ? executionContext.recording.channelId
        : undefined,
    });
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

    logger.info('Launching HRMS meeting bot join flow', {
      phase: 'browser.launch',
    });
    await bot.join(joinParams);
    const recording = uploader.getUploadedRecordingDetails();

    if (!recording || !recording.fileName || !recording.contentType || !recording.sizeBytes) {
      throw new Error('Recording upload completed without usable metadata');
    }

    let callbackRecording: HrmsJobResult['recording'];
    if (recording.provider === 'youtube') {
      if (!recording.videoId || !recording.watchUrl || !recording.embedUrl) {
        throw new Error('YouTube upload completed without usable metadata');
      }
      callbackRecording = {
        destination: 'youtube',
        videoId: recording.videoId,
        watchUrl: recording.watchUrl,
        embedUrl: recording.embedUrl,
        thumbnailUrl: recording.thumbnailUrl,
        privacyStatus: recording.privacyStatus || 'public',
        fileName: recording.fileName,
        contentType: recording.contentType,
        sizeBytes: recording.sizeBytes,
        storagePath: recording.storagePath || recording.watchUrl,
        url: recording.url || recording.watchUrl,
      };
    } else {
      if (
        !recording.bucket ||
        !recording.key ||
        !recording.region ||
        !recording.storagePath
      ) {
        throw new Error('S3 upload completed without usable metadata');
      }
      callbackRecording = {
        destination: 's3',
        bucket: recording.bucket,
        key: recording.key,
        region: recording.region,
        endpoint: recording.endpoint,
        fileName: recording.fileName,
        contentType: recording.contentType,
        sizeBytes: recording.sizeBytes,
        storagePath: recording.storagePath,
        url: recording.url,
      };
    }

    const successPayload: HrmsJobResult = {
      jobId: executionContext.jobId,
      moduleId: executionContext.moduleId,
      provider: executionContext.provider,
      status: 'completed',
      meetingUrl: executionContext.meetingUrl,
      startedAt: executionContext.startedAt,
      completedAt: new Date().toISOString(),
      recording: callbackRecording,
      metadata: executionContext.metadata,
    };

    logger.info('Sending HRMS completion callback', {
      phase: 'callback.started',
      callbackUrl: executionContext.callbackUrl,
      callbackStatus: successPayload.status,
    });
    const callbackDelivered = await notifyHrmsJobResult(executionContext, successPayload, logger);
    logger.info('HRMS meeting job finished', {
      phase: 'job.finished',
      callbackDelivered,
      status: successPayload.status,
      recordingKey: recording.key,
      recordingBucket: recording.bucket,
      recordingVideoId: recording.videoId,
    });
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

    logger.error('HRMS meeting job failed', {
      phase: 'job.failed',
      errorType: getErrorType(error),
      error: error instanceof Error ? error.message : String(error),
    });
    logger.info('Sending HRMS failure callback', {
      phase: 'callback.started',
      callbackUrl: executionContext.callbackUrl,
      callbackStatus: failurePayload.status,
    });
    const callbackDelivered = await notifyHrmsJobResult(executionContext, failurePayload, logger);
    logger.info('HRMS meeting job finished', {
      phase: 'job.finished',
      callbackDelivered,
      status: failurePayload.status,
    });
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
    recording: normalizeRecordingTarget(job.recording),
    metadata: normalizeMetadata(job.metadata),
    startedAt: new Date().toISOString(),
  };

  const correlationId = createHrmsCorrelationId({
    jobId: executionContext.jobId,
    moduleId: executionContext.moduleId,
    provider: executionContext.provider,
    meetingUrl: executionContext.meetingUrl,
  });
  const logger = loggerFactory(correlationId, executionContext.provider, {
    jobId: executionContext.jobId,
    moduleId: executionContext.moduleId,
    provider: executionContext.provider,
    meetingUrl: executionContext.meetingUrl,
  });

  try {
    const jobResult = await globalJobStore.addJob(async () => {
      await runHrmsJob(executionContext, logger);
    }, logger, { maxRetries: 0 });

    if (!jobResult.accepted) {
      logger.warn('Rejected HRMS job because another meeting is active', {
        phase: 'job.rejected',
      });
      return res.status(409).json({
        success: false,
        error: 'Another meeting is currently being processed. Please try again later.',
        data: {
          jobId: executionContext.jobId,
          moduleId: executionContext.moduleId,
        },
      });
    }

    logger.info('Accepted HRMS meeting job', {
      phase: 'job.accepted',
    });
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
      phase: 'job.setup.failed',
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
