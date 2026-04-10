import { Frame, Page } from 'playwright';
import { JoinParams, AbstractMeetBot } from './AbstractMeetBot';
import { BotStatus, WaitPromise } from '../types';
import config from '../config';
import { WaitingAtLobbyRetryError } from '../error';
import { v4 } from 'uuid';
import { patchBotStatus } from '../services/botService';
import { RecordingTask } from '../tasks/RecordingTask';
import { ContextBridgeTask } from '../tasks/ContextBridgeTask';
import { getWaitingPromise } from '../lib/promise';
import createBrowserContext from '../lib/chromium';
import { uploadDebugImage } from '../services/bugService';
import { Logger } from 'winston';
import { handleWaitingAtLobbyError } from './MeetBotBase';
import { ZOOM_REQUEST_DENIED } from '../constants';
import { isHrmsExecutionContext } from '../execution/types';

class BotBase extends AbstractMeetBot {
  protected page: Page;
  protected slightlySecretId: symbol; // Use any hard-to-guess identifier
  protected _logger: Logger;
  protected _correlationId: string;
  constructor(logger: Logger, correlationId: string) {
    super();
    this.slightlySecretId = Symbol(v4());
    this._logger = logger;
    this._correlationId = correlationId;
  }
  join(params: JoinParams): Promise<void> {
    throw new Error('Function not implemented.');
  }
}

export class ZoomBot extends BotBase {
  private static readonly ZOOM_AI_COMPANION_NOT_NOW_SELECTOR =
    'body > div:nth-child(41) > div > div > div > div.zm-modal-footer > div > div > button.zm-btn.zm-btn-legacy.zm-btn--default.zm-btn__outline--blue';

  constructor(logger: Logger, correlationId: string) {
    super(logger, correlationId);
  }

  private async dismissAiCompanionPrompt(
    container: Frame | Page,
    params: JoinParams,
    source: string,
  ): Promise<boolean> {
    try {
      const directDismissButton = container.locator(
        ZoomBot.ZOOM_AI_COMPANION_NOT_NOW_SELECTOR,
      );
      const directDismissVisible = await directDismissButton
        .first()
        .isVisible()
        .catch(() => false);

      if (directDismissVisible) {
        await directDismissButton.first().click({ force: true, timeout: 5000 });
        await this.page.waitForTimeout(1000);
        this._logger.info(
          'Dismissed Zoom AI Companion prompt using direct selector',
          {
            phase: 'zoom.ai-companion.dismissed',
            source,
            selector: ZoomBot.ZOOM_AI_COMPANION_NOT_NOW_SELECTOR,
          },
        );
        return true;
      }

      const companionDialog = container
        .locator('div, [role="dialog"]')
        .filter({ hasText: /Request access for AI Companion/i })
        .first();

      const dialogVisible = await companionDialog.isVisible().catch(() => false);
      if (!dialogVisible) {
        this._logger.info('Zoom AI Companion prompt not present', {
          phase: 'zoom.ai-companion.check',
          source,
        });
        return false;
      }

      this._logger.warn('Zoom AI Companion prompt detected', {
        phase: 'zoom.ai-companion.detected',
        source,
        selectorAttempted: ZoomBot.ZOOM_AI_COMPANION_NOT_NOW_SELECTOR,
      });

      const notNowButton = companionDialog
        .locator('button, [role="button"]')
        .filter({ hasText: /^Not now$/i })
        .first();

      const notNowVisible = await notNowButton.isVisible().catch(() => false);
      if (!notNowVisible) {
        this._logger.warn('Zoom AI Companion prompt is visible but Not now button was not found', {
          phase: 'zoom.ai-companion.dismiss.failed',
          source,
        });
        await uploadDebugImage(
          await this.page.screenshot({ type: 'png', fullPage: true }),
          `zoom-ai-companion-${source}`,
          params.userId,
          this._logger,
          params.botId,
          undefined,
          params.executionContext,
        );
        return false;
      }

      await notNowButton.click({ force: true, timeout: 5000 });
      await this.page.waitForTimeout(1000);

      this._logger.info('Dismissed Zoom AI Companion prompt using Not now', {
        phase: 'zoom.ai-companion.dismissed',
        source,
      });
      return true;
    } catch (error) {
      this._logger.warn('Failed to dismiss Zoom AI Companion prompt', {
        phase: 'zoom.ai-companion.dismiss.failed',
        source,
        error,
      });
      return false;
    }
  }

  private async dismissBlockingZoomPrompts(
    container: Frame | Page,
    params: JoinParams,
    source: string,
  ) {
    await this.dismissAiCompanionPrompt(container, params, source);
  }

  // TODO use base class for shared functions such as bot status and bot logging
  // TODO Lift the JoinParams to the constructor argument
  async join({ url, name, bearerToken, teamId, timezone, userId, eventId, botId, uploader, executionContext }: JoinParams): Promise<void> {
    const _state: BotStatus[] = ['processing'];
    const isHrms = isHrmsExecutionContext(executionContext);

    const handleUpload = async () => {
      this._logger.info('Begin recording upload to server', {
        phase: 'upload.started',
        userId,
        teamId,
      });
      const uploadResult = await uploader.uploadRecordingToRemoteStorage();
      this._logger.info('Recording upload result', {
        phase: uploadResult ? 'upload.finished' : 'upload.failed',
        uploadResult,
        userId,
        teamId,
      });
      if (!uploadResult) {
        throw new Error('Recording upload failed');
      }
    };
    
    try {
      const pushState = (st: BotStatus) => _state.push(st);
      await this.joinMeeting({ url, name, bearerToken, teamId, timezone, userId, eventId, botId, pushState, uploader });

      // Finish the upload from the temp video
      await handleUpload();
      if (!isHrms) {
        await patchBotStatus({ botId, eventId, provider: 'zoom', status: _state, token: bearerToken }, this._logger);
      }
    } catch(error) {
      if (!_state.includes('failed')) {
        if (_state.includes('finished')) {
          _state.splice(_state.indexOf('finished'), 1, 'failed');
        } else {
          _state.push('failed');
        }
      }

      if (!isHrms) {
        await patchBotStatus({ botId, eventId, provider: 'zoom', status: _state, token: bearerToken }, this._logger);
      }
      
      if (!isHrms && error instanceof WaitingAtLobbyRetryError) {
        await handleWaitingAtLobbyError({ token: bearerToken, botId, eventId, provider: 'zoom', error }, this._logger);
      }

      throw error;
    }
  }

  private async joinMeeting({ pushState, ...params }: JoinParams & { pushState(state: BotStatus): void }): Promise<void> {
    const { url, name } = params;
    this._logger.info('Launching browser for Zoom...', {
      phase: 'browser.launch',
      userId: params.userId,
    });

    this.page = await createBrowserContext(url, this._correlationId, 'zoom', this._logger);

    await this.page.route('**/*.exe', (route) => {
      this._logger.info(`Detected .exe download: ${route.request().url()?.split('download')[0]}`);
    });

    await this.page.waitForTimeout(1000);

    this._logger.info('Navigating to Zoom Meeting URL...');
    await this.page.goto(url, { waitUntil: 'networkidle' });

    // Accept cookies
    try {
      this._logger.info('Waiting for the "Accept Cookies" button...');
      await this.page.waitForTimeout(3000);
      const acceptCookies = await this.page.locator('button', { hasText: 'Accept Cookies' });
      await acceptCookies.waitFor({ timeout: 5000 });

      this._logger.info('Clicking the "Accept Cookies" button...', await acceptCookies.count());
      await acceptCookies.click({ force: true });
      
    } catch (error) {
      await uploadDebugImage(await this.page.screenshot({ type: 'png', fullPage: true }), 'accept-cookie', params.userId, this._logger, params.botId, undefined, params.executionContext);
      this._logger.info('Unable to accept cookies...', error);
    }

    const hasFocus = await this.page.evaluate(() => document.hasFocus());
    this._logger.info(`Page focus status: ${hasFocus}`);

    const attempts = 3;
    let usingDirectWebClient = false;
    const findAndEnableJoinFromBrowserButton = async (retry: number): Promise<boolean> => {
      try {
        if (retry >= attempts) {
          this._logger.warn('Zoom web client link was not found after retries', {
            phase: 'zoom.join-path',
            retry,
            attempts,
          });
          return false;
        }

        this._logger.info('Waiting for 5 seconds...');
        await this.page.waitForTimeout(5000);

        const launchMeetingGetByRole = this.page.getByRole('button', { name: /Launch Meeting/i }).first();
        const launchMeetingVisible = await launchMeetingGetByRole.isVisible().catch(() => false);
        this._logger.info('Zoom landing page visibility check', {
          phase: 'zoom.join-path',
          retry,
          launchMeetingVisible,
        });

        const launchDownloadGetByRole = this.page.getByRole('button', { name: /Download Now/i }).first();
        const downloadNowVisible = await launchDownloadGetByRole.isVisible().catch(() => false);
        this._logger.info('Zoom download button visibility check', {
          phase: 'zoom.join-path',
          retry,
          downloadNowVisible,
        });

        if (downloadNowVisible) {
          this._logger.info('Click on Download Now...', {
            phase: 'zoom.join-path',
            retry,
          });
          await launchDownloadGetByRole.click({ force: true });
        } else {
          this._logger.warn('Download Now button is not visible before browser-join probe', {
            phase: 'zoom.join-path',
            retry,
          });
        }

        const joinFromBrowser = await this.page.locator('a', { hasText: 'Join from your browser' }).first();
        await joinFromBrowser.waitFor({ timeout: 5000 });
        const joinFromBrowserCount = await joinFromBrowser.count();
        const joinFromBrowserVisible = await joinFromBrowser.isVisible().catch(() => false);

        this._logger.info('Zoom browser join link visibility check', {
          phase: 'zoom.join-path',
          retry,
          joinFromBrowserCount,
          joinFromBrowserVisible,
        });

        if (joinFromBrowserCount > 0) {
          await joinFromBrowser.click({ force: true });
          this._logger.info('Clicked Join from your browser link', {
            phase: 'zoom.join-path',
            retry,
          });
          return true;
        }
        else {
          this._logger.info('Try to find the Join from your browser button again...', retry + 1);
          return await findAndEnableJoinFromBrowserButton(retry + 1);
        }
      } catch(error) {
        this._logger.info('Error on try find the web client', {
          phase: 'zoom.join-path',
          retry,
          error,
        });
        if (retry >= attempts) {
          return false;
        }
        return await findAndEnableJoinFromBrowserButton(retry + 1);
      }
    };

    const visitWebClientByUrl = async (): Promise<boolean> => {
      usingDirectWebClient = true;
      try {
        const wcUrl = new URL(url);
        wcUrl.pathname = wcUrl.pathname.replace('/j/', '/wc/join/');
        this._logger.info('Navigating to Zoom Web Client URL...', { wcUrl: wcUrl.toString(), botId: params.botId, userId: params.userId });
        await this.page.goto(wcUrl.toString(), { waitUntil: 'networkidle' });
        this._logger.info('Switched to direct Zoom web client URL', {
          phase: 'zoom.join-path',
          usingDirectWebClient,
          wcUrl: wcUrl.toString(),
        });
        return true;
      } catch(err) {
        this._logger.info('Failed to access ZOOM web client by URL', {
          phase: 'zoom.join-path',
          botId: params.botId,
          userId: params.userId,
          error: err,
        });
        return false;
      }
    };

    const waitForJoinFromBrowserNav = async (): Promise<boolean> => {
      try {
        const maxAttempts = 3;
        let attempt = 0;

        const navPromise = new Promise<boolean>((foundResolver) => {
          const interv = setInterval(async () => {
            if (attempt >= maxAttempts) {
              clearInterval(interv);
              foundResolver(false);
              return;
            }

            try {
              const joinFromBrowser = await this.page.locator('a', { hasText: 'Join from your browser' }).first();
              await joinFromBrowser.waitFor({ timeout: 4000 }).catch();
              if (await joinFromBrowser.count() > 0) {
                this._logger.info('Waiting for zoom navigation to meeting page...', params.userId);
              }
              else {
                clearInterval(interv);
                foundResolver(true);
              }
            }
            catch(e) {
              if (e?.name === 'TimeoutError') {
                this._logger.info('Join from your browser is no longer present on page...', params.userId);
                clearInterval(interv);
                foundResolver(true);
                return;
              }
              this._logger.info('An error happened while waiting for zoom navigation to finish', e);
              if (attempt >= maxAttempts) {
                clearInterval(interv);
                foundResolver(false);
                return;
              }
            }
            attempt += 1;
          }, 6000);
        });
        const success = await navPromise;
        return success;
      } catch(err) {
        this._logger.info('Zoom error: Unable to move forward from Join from your browser', params.userId);
        return false;
      }
    };

    // Join from browser
    this._logger.info('Waiting for Join from your browser to be visible...');
    const foundAndClickedJoinFromBrowser = await findAndEnableJoinFromBrowserButton(0);
    
    let navSuccess = false;
    if (foundAndClickedJoinFromBrowser) {
      this._logger.info('Verify the meeting web client is visible...');
      // Ensure the page has navigated to the web client...
      navSuccess = await waitForJoinFromBrowserNav();
    }
    
    if (!foundAndClickedJoinFromBrowser || !navSuccess) {
      await uploadDebugImage(await this.page.screenshot({ type: 'png', fullPage: true }), 'enable-join-from-browser', params.userId, this._logger, params.botId, undefined, params.executionContext);
      this._logger.info('Failed to enable Join from your browser button...', {
        phase: 'zoom.join-path',
        userId: params.userId,
        foundAndClickedJoinFromBrowser,
        navSuccess,
      });
      this._logger.info('Zoom Bot will now attempt to access the Web Client by URL...', {
        phase: 'zoom.join-path',
        userId: params.userId,
      });
      const canAccess = await visitWebClientByUrl();
      if (!canAccess) {
        await uploadDebugImage(await this.page.screenshot({ type: 'png', fullPage: true }), 'direct-access-webclient', params.userId, this._logger, params.botId, undefined, params.executionContext);
        throw new Error('Unable to join meeting after trying to access the web client by /wc/join/');
      }
    }

    this._logger.info('Heading to the web client...', { usingDirectWebClient });

    this._logger.info('Waiting for 10 seconds...');
    await this.page.waitForTimeout(10000);

    let iframe: Frame | Page = this.page;
    const apps: ('app' | 'iframe')[] = [];
    const detectAppContainer = async (startWith: 'app' | 'iframe'): Promise<boolean> => {
      try {
        if (apps.includes('app') && apps.includes('iframe')) {
          return false;
        }

        apps.push(startWith);
        this._logger.info('Attempting to detect Zoom web client container', {
          phase: 'zoom.join-path',
          startWith,
          triedContainers: apps,
          usingDirectWebClient,
        });
        if (startWith === 'app') {
          const input = await this.page.waitForSelector('input[type="text"]', { timeout: 30000 });
          const join = await this.page.locator('button', { hasText: /Join/i });
          join.waitFor({ timeout: 15000 });
          this._logger.info('Zoom app container detection result', {
            phase: 'zoom.join-path',
            inputFound: input !== null,
            joinLocatorFound: join !== null,
          });
          if (input && join) {
            iframe = this.page;
          } else {
            return await detectAppContainer('iframe');
          }
        }

        if (startWith === 'iframe') {
          const iframeElementHandle = await this.page.waitForSelector('iframe#webclient', { timeout: 30000, state: 'attached' });
          const iframeId = await iframeElementHandle?.getAttribute('id');
          this._logger.info('Zoom iframe container detection result', {
            phase: 'zoom.join-path',
            iframeFound: iframeElementHandle !== null,
            iframeId,
          });
          const contentFrame = await iframeElementHandle.contentFrame();
          if (contentFrame) {
            iframe = contentFrame;
          } else {
            return await detectAppContainer('app');
          }
        }

        return true;
      } catch(err) {
        this._logger.info('Cannot detect the App container for Zoom Web Client', {
          phase: 'zoom.join-path',
          startWith,
          error: err,
        });
        await uploadDebugImage(await this.page.screenshot({ type: 'png', fullPage: true }), 'detect-app-container', params.userId, this._logger, params.botId, undefined, params.executionContext);
        return await detectAppContainer(startWith === 'app' ? 'iframe' : 'app');
      }
    };

    const foundAppContainer = await detectAppContainer(usingDirectWebClient ? 'app' : 'iframe');

    if (!iframe || !foundAppContainer) {
      throw new Error(`Failed to get the Zoom PWA iframe on user ${params.userId}`);
    }

    this._logger.info('Waiting for the input field to be visible...');
    await iframe.waitForSelector('input[type="text"]', { timeout: 60000 });
    this._logger.info('Zoom name input is visible', {
      phase: 'zoom.join-path',
      usingDirectWebClient,
    });
    
    this._logger.info('Waiting for 5 seconds...');
    await this.page.waitForTimeout(5000);
    this._logger.info('Filling the input field with the name...');
    await iframe.fill('input[type="text"]', name ? name : 'ScreenApp Notetaker');

    await this.page.waitForTimeout(3000);

    this._logger.info('Clicking the "Join" button...');
    const joinButton = await iframe.locator('button', { hasText: 'Join' });
    this._logger.info('Zoom join button locator resolved', {
      phase: 'zoom.join-path',
      joinButtonCount: await joinButton.count(),
    });
    await joinButton.click();

    // Wait in waiting room
    try {
      const wanderingTime = config.joinWaitTime * 60 * 1000; // Give some time to be let in

      let waitTimeout: NodeJS.Timeout;
      let waitInterval: NodeJS.Timeout;
      const waitAtLobbyPromise = new Promise<boolean>((resolveMe) => {
        waitTimeout = setTimeout(() => {
          clearInterval(waitInterval);
          resolveMe(false);
        }, wanderingTime);

        waitInterval = setInterval(async () => {
          try {
            const footerInfo = await iframe.locator('#wc-footer');
            await footerInfo.waitFor({ state: 'attached' });
            const footerText = await footerInfo?.innerText();

            const tokens1 = footerText.split('\n');
            const tokens2 = footerText.split(' ');
            const tokens = tokens1.length > tokens2.length ? tokens1 : tokens2;
  
            const filtered: string[] = [];
            for (const tok of tokens) {
              if (!tok) continue;
              if (!Number.isNaN(Number(tok.trim())))
                filtered.push(tok);
              else if (tok.trim().toLowerCase() === 'participants') {
                filtered.push(tok.trim().toLowerCase());
                break;
              }
            }
            const joinedText = filtered.join('');

            if (joinedText === 'participants') 
              return;

            const isValid = joinedText.match(/\d+(.*)participants/i);
            if (!isValid) {
              return;
            }

            const num = joinedText.match(/\d+/);
            this._logger.info('Final Number of participants while waiting...', num);
            if (num && Number(num[0]) === 0)
              this._logger.info('Waiting on host...');
            else {
              clearInterval(waitInterval);
              clearTimeout(waitTimeout);
              resolveMe(true);
            }
          } catch(e) {
            // Do nothing
          }
        }, 2000);
      });

      const joined = await waitAtLobbyPromise;
      if (!joined) {
        const bodyText = await this.page.evaluate(() => document.body.innerText);

        const userDenied = (bodyText || '')?.includes(ZOOM_REQUEST_DENIED);

        this._logger.error('Cant finish wait at the lobby check', { userDenied, waitingAtLobbySuccess: joined, bodyText });

        // Don't retry lobby errors - if user doesn't admit bot, retrying won't help
        throw new WaitingAtLobbyRetryError('Zoom bot could not enter the meeting...', bodyText ?? '', false, 0);
      }

      this._logger.info('Bot is entering the meeting after wait room...');
      this._logger.info('Zoom meeting-entry heuristics satisfied', {
        phase: 'meeting.entered',
        userId: params.userId,
      });
    } catch (error) {
      this._logger.info('Closing the browser on error...', error);
      await this.page.context().browser()?.close();

      throw error;
    }

    // Wait for device notifications and close the notifications
    let notifyInternval: NodeJS.Timeout;
    let notifyTimeout: NodeJS.Timeout;
    try {
      const cameraNotifications: ('found' | 'dismissed')[] = [];
      const micNotifications: ('found' | 'dismissed')[] = [];
      const stopWaiting = 30 * 1000;
      
      const notifyPromise = new Promise<boolean>((res) => {
        notifyTimeout = setTimeout(() => {
          clearInterval(notifyInternval);
          res(false);
        }, stopWaiting);
        notifyInternval = setInterval(async () => {
          try {
            const cameraDiv = await iframe.locator('div', { hasText: /^Cannot detect your camera/i }).first();
            const micDiv = await iframe.locator('div', { hasText: /^Cannot detect your microphone/i }).first();

            if (await cameraDiv.isVisible()) {
              if (!cameraNotifications.includes('found'))
                cameraNotifications.push('found');
            }
            else {
              if (cameraNotifications.includes('found'))
                cameraNotifications.push('dismissed');
            }

            if (await micDiv.isVisible()) {
              if (!micNotifications.includes('found'))
                micNotifications.push('found');
            }
            else {
              if (micNotifications.includes('found'))
                micNotifications.push('dismissed');
            }

            if (micNotifications.length >= 2 && cameraNotifications.length >= 2) {
              clearInterval(notifyInternval);
              clearTimeout(notifyTimeout);
              res(true);
              return;
            }

            const closeButtons = await iframe.getByLabel('close').all();
            this._logger.info('Clicking the "x" button...', closeButtons.length);
            
            let counter = 0;
            try {
              for await (const close of closeButtons) {
                if (await close.isVisible()) {
                  await close.click({ timeout: 5000 });
                  counter += 1;
                }
              }
            } catch (err) {
              this._logger.info('Unable to click the x notifications', counter, err);
            }
          } catch (error) {
            // Log and ignore this error
            this._logger.info('Unable to close x notifications...', error);
            clearInterval(notifyInternval);
            clearTimeout(notifyTimeout);
            res(false);
          }
        }, 2000);
      });

      await notifyPromise.catch(() => {
        clearInterval(notifyInternval);
        clearTimeout(notifyTimeout);
      });
    }
    catch(err) {
      this._logger.info('Caught notifications close error', err.message);
    }

    // Dismiss annoucements OK button if present
    try {
      const okButton = await iframe.locator('button', { hasText: 'OK' }).first();
      if (await okButton.isVisible()) {
        await okButton.click({ timeout: 5000 });
        this._logger.info('Dismissed the OK button...');
      }
    } catch (error) {
      this._logger.info('OK button might be missing...', error);
    }

    await this.dismissBlockingZoomPrompts(iframe, params, 'post-join');

    pushState('joined');

    // Recording the meeting page
    this._logger.info('Begin recording...', {
      phase: 'recording.started',
    });
    await this.recordMeetingPage({ ...params });
    
    pushState('finished');
  }

  private async recordMeetingPage(params: JoinParams): Promise<void> {
    const { teamId, userId, eventId, botId, uploader } = params;
    const duration = config.maxRecordingDuration * 60 * 1000;

    await this.dismissBlockingZoomPrompts(this.page, params, 'pre-recording');

    this._logger.info('Setting up the duration');
    const processingTime = 0.2 * 60 * 1000;
    const waitingPromise: WaitPromise = getWaitingPromise(processingTime + duration);

    this._logger.info('Setting up the recording connect functions');
    const chores = new ContextBridgeTask(
      this.page, 
      { ...params, botId: params.botId ?? '' },
      this.slightlySecretId.toString(),
      waitingPromise,
      uploader,
      this._logger
    );
    await chores.runAsync(null);

    this._logger.info('Setting up the recording Main Task');
    // Inject the MediaRecorder code into the browser context using page.evaluate
    const recordingTask = new RecordingTask(
      userId,
      teamId,
      this.page,
      duration,
      this.slightlySecretId.toString(),
      this._logger
    );
    await recordingTask.runAsync(null);
  
    this._logger.info('Waiting for recording duration', {
      phase: 'recording.started',
      maxRecordingDurationMinutes: config.maxRecordingDuration,
    });
    waitingPromise.promise.then(async () => {
      this._logger.info('Recording stop signal received', {
        phase: 'recording.stopped',
      });
      this._logger.info('Closing the browser...');
      await this.page.context().browser()?.close();

      this._logger.info('All done ✨', { botId, eventId, userId, teamId });
    });
    await waitingPromise.promise;
  }
}
