import axios from 'axios';
import crypto from 'crypto';
import { Logger } from 'winston';
import { HrmsExecutionContext, HrmsJobResult } from '../execution/types';

const CALLBACK_TIMEOUT_MS = 10000;
const MAX_CALLBACK_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [1000, 2000];

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function signPayload(body: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

export async function notifyHrmsJobResult(
  executionContext: HrmsExecutionContext,
  payload: HrmsJobResult,
  logger: Logger,
): Promise<boolean> {
  const body = JSON.stringify(payload);
  const signature = signPayload(body, executionContext.callbackSecret);

  for (let attempt = 1; attempt <= MAX_CALLBACK_ATTEMPTS; attempt++) {
    try {
      await axios.post(executionContext.callbackUrl, body, {
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': signature,
        },
        timeout: CALLBACK_TIMEOUT_MS,
      });
      logger.info('Delivered HRMS job callback', {
        jobId: executionContext.jobId,
        moduleId: executionContext.moduleId,
        attempt,
        status: payload.status,
      });
      return true;
    } catch (error) {
      logger.error('Failed HRMS job callback attempt', {
        jobId: executionContext.jobId,
        moduleId: executionContext.moduleId,
        attempt,
        status: payload.status,
        error: error instanceof Error ? error.message : String(error),
      });

      if (attempt >= MAX_CALLBACK_ATTEMPTS) {
        break;
      }

      await sleep(RETRY_DELAYS_MS[attempt - 1] || RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]);
    }
  }

  logger.error('Failed to deliver HRMS job callback after retries', {
    jobId: executionContext.jobId,
    moduleId: executionContext.moduleId,
    status: payload.status,
  });
  return false;
}
