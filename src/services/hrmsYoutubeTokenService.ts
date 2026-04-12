import axios from 'axios';
import crypto from 'crypto';
import { Logger } from 'winston';
import { HrmsExecutionContext } from '../execution/types';

function signPayload(body: string, secret: string) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

export async function refreshHrmsYouTubeAccessToken(
  executionContext: HrmsExecutionContext,
  logger: Logger,
): Promise<string> {
  if (executionContext.recording.destination !== 'youtube') {
    throw new Error('HRMS YouTube token refresh is only valid for YouTube jobs');
  }

  const body = JSON.stringify({
    jobId: executionContext.jobId,
    moduleId: executionContext.moduleId,
    channelId: executionContext.recording.channelId,
  });
  const signature = signPayload(body, executionContext.callbackSecret);

  const response = await axios.post(
    executionContext.recording.tokenRefreshUrl,
    body,
    {
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': signature,
      },
      timeout: 10000,
    },
  );

  const accessToken = response.data?.data?.accessToken;
  if (typeof accessToken !== 'string' || !accessToken.trim()) {
    throw new Error('HRMS YouTube token refresh returned no access token');
  }

  logger.info('Refreshed HRMS YouTube access token', {
    jobId: executionContext.jobId,
    moduleId: executionContext.moduleId,
    channelId: executionContext.recording.channelId,
  });

  return accessToken.trim();
}
