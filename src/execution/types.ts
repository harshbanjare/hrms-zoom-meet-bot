export type BotProvider = 'google' | 'microsoft' | 'zoom';

export interface HrmsRecordingTarget {
  bucket: string;
  region: string;
  keyPrefix: string;
  endpoint?: string;
  forcePathStyle?: boolean;
}

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
  provider: 's3' | 'azure' | 'screenapp';
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
}

export interface HrmsJobResult {
  jobId: string;
  moduleId: string;
  provider: BotProvider;
  status: 'completed' | 'failed';
  meetingUrl: string;
  startedAt?: string;
  completedAt: string;
  recording?: {
    bucket: string;
    key: string;
    region: string;
    endpoint?: string;
    fileName: string;
    contentType: string;
    sizeBytes: number;
    storagePath: string;
    url?: string;
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
