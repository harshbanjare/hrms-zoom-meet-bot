export type BotProvider = 'google' | 'microsoft' | 'zoom';

export interface HrmsS3RecordingTarget {
  destination: 's3';
  bucket: string;
  region: string;
  keyPrefix: string;
  endpoint?: string;
  forcePathStyle?: boolean;
}

export interface HrmsYouTubeRecordingTarget {
  destination: 'youtube';
  privacyStatus: 'public';
  title?: string;
  description?: string;
  accessToken: string;
  accessTokenExpiresAt: string;
  tokenRefreshUrl: string;
  channelId: string;
}

export type HrmsRecordingTarget =
  | HrmsS3RecordingTarget
  | HrmsYouTubeRecordingTarget;

export interface HrmsJobRequest {
  jobId: string;
  moduleId: string;
  provider: BotProvider;
  meetingUrl: string;
  meetingTitle: string;
  botDisplayName: string;
  timezone: string;
  callbackUrl: string;
  callbackSecret: string;
  recording: HrmsRecordingTarget;
  metadata?: {
    domainId?: string;
    batchId?: string;
    batchName?: string;
    scheduledAt?: string;
    joinAt?: string;
  };
}

export interface ScreenAppExecutionContext {
  mode: 'screenapp';
  provider: BotProvider;
}

export interface HrmsExecutionContext {
  mode: 'hrms';
  jobId: string;
  moduleId: string;
  provider: BotProvider;
  meetingUrl: string;
  meetingTitle: string;
  botDisplayName: string;
  timezone: string;
  callbackUrl: string;
  callbackSecret: string;
  recording: HrmsRecordingTarget;
  metadata?: Record<string, string>;
  startedAt: string;
}

export type BotExecutionContext = ScreenAppExecutionContext | HrmsExecutionContext;

export interface UploadedRecordingDetails {
  provider: 's3' | 'azure' | 'screenapp' | 'youtube';
  bucket?: string;
  key?: string;
  region?: string;
  endpoint?: string;
  storagePath?: string;
  fileName?: string;
  contentType?: string;
  sizeBytes?: number;
  url?: string;
  fileId?: string;
  defaultProfile?: string;
  videoId?: string;
  watchUrl?: string;
  embedUrl?: string;
  thumbnailUrl?: string;
  privacyStatus?: 'public';
}

export interface HrmsJobResult {
  jobId: string;
  moduleId: string;
  provider: BotProvider;
  status: 'completed' | 'failed';
  meetingUrl: string;
  startedAt?: string;
  completedAt: string;
  recording?:
    | {
        destination: 's3';
        bucket: string;
        key: string;
        region: string;
        endpoint?: string;
        fileName: string;
        contentType: string;
        sizeBytes: number;
        storagePath: string;
        url?: string;
      }
    | {
        destination: 'youtube';
        videoId: string;
        watchUrl: string;
        embedUrl: string;
        thumbnailUrl?: string;
        privacyStatus: 'public';
        fileName: string;
        contentType: string;
        sizeBytes: number;
        storagePath: string;
        url: string;
      };
  error?: {
    code: string;
    message: string;
  };
  metadata?: Record<string, string>;
}

export const isHrmsExecutionContext = (
  context?: BotExecutionContext,
): context is HrmsExecutionContext => context?.mode === 'hrms';

export const isHrmsS3RecordingTarget = (
  recording: HrmsRecordingTarget,
): recording is HrmsS3RecordingTarget => recording.destination === 's3';

export const isHrmsYouTubeRecordingTarget = (
  recording: HrmsRecordingTarget,
): recording is HrmsYouTubeRecordingTarget =>
  recording.destination === 'youtube';
