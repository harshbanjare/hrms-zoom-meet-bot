import { Logger } from 'winston';
import { KnownError } from '../error';
import { getErrorType } from '../util/logger';

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

interface JobOptions {
  maxRetries?: number;
}

export class JobStore {
  private isRunning: boolean = false;
  private shutdownRequested: boolean = false;

  async addJob<T>(
    task: () => Promise<T>,
    logger: Logger,
    options: JobOptions = {},
  ): Promise<{ accepted: boolean }> {
    if (this.isRunning || this.shutdownRequested) {
      return { accepted: false };
    }

    this.isRunning = true;
    const maxRetries = options.maxRetries ?? 2;

    // Execute the task asynchronously without waiting for completion
    this.executeTaskWithRetry(task, logger, 0, maxRetries).then(() => {
      logger.info('LogBasedMetric Bot has finished recording meeting successfully.');
    }).catch((error) => {
      const errorType = getErrorType(error);
      if (error instanceof KnownError) {
        logger.error('KnownError JobStore is permanently exiting:', { error });
      } else {
        logger.error('Error executing task after multiple retries:', { error });
      }
      logger.error(`LogBasedMetric Bot has permanently failed. [errorType: ${errorType}]`);
    }).finally(() => {
      this.isRunning = false;
    });

    logger.info('LogBasedMetric Bot job has been queued and started recording meeting.');
    return { accepted: true };
  }

  private async executeTaskWithRetry<T>(
    task: () => Promise<T>,
    logger: Logger,
    retryCount: number,
    maxRetries: number,
  ): Promise<void> {
    try {
      await task();
    } catch (error) {
      if (error instanceof KnownError && !error.retryable) {
        logger.error('KnownError is not retryable:', error.name, error.message);
        throw error;
      }

      if (error instanceof KnownError && error.retryable && (retryCount + 1) >= error.maxRetries) {
        logger.error(`KnownError: ${error.maxRetries} tries consumed:`, error.name, error.message);
        throw error;
      }

      retryCount += 1;
      if (retryCount > maxRetries) {
        throw error;
      }

      await sleep(retryCount * 30000);
      if (retryCount <= maxRetries) {
        if (retryCount) {
          logger.warn(`Retry count: ${retryCount}`, {
            phase: 'job.retry',
            retryCount,
            maxRetries,
          });
        }
        await this.executeTaskWithRetry(task, logger, retryCount, maxRetries);
      } else {
        throw error;
      }
    }
  }

  isBusy(): boolean {
    return this.isRunning;
  }

  /**
   * Check if shutdown has been requested
   */
  isShutdownRequested(): boolean {
    return this.shutdownRequested;
  }

  /**
   * Request graceful shutdown - prevents new jobs from being accepted
   */
  requestShutdown(): void {
    this.shutdownRequested = true;
  }

  /**
   * Wait for ongoing tasks to complete
   * @returns Promise that resolves when all tasks are complete
   */
  async waitForCompletion(): Promise<void> {
    if (!this.isRunning) {
      return; // No tasks running, can shutdown immediately
    }

    console.log('Waiting for ongoing tasks to complete...');
    
    return new Promise<void>((resolve) => {
      const checkCompletion = () => {
        if (!this.isRunning) {
          console.log('All tasks completed successfully');
          resolve();
        } else {
          setTimeout(checkCompletion, 1000); // Check every 1 second
        }
      };
      checkCompletion();
    });
  }
} 
