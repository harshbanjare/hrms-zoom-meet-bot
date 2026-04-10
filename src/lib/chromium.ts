import { Browser, BrowserContext, Page } from 'playwright';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { Logger } from 'winston';
import config from '../config';
import { getCorrelationIdLog } from '../util/logger';

const stealthPlugin = StealthPlugin();
stealthPlugin.enabledEvasions.delete('iframe.contentWindow');
stealthPlugin.enabledEvasions.delete('media.codecs');
chromium.use(stealthPlugin);

export type BotType = 'microsoft' | 'google' | 'zoom';

function emitBrowserLog(
  logger: Logger | undefined,
  correlationId: string,
  level: 'info' | 'warn' | 'error',
  message: string,
  meta?: Record<string, unknown>,
) {
  if (logger) {
    logger[level](message, {
      phase: 'browser.runtime',
      ...meta,
    });
    return;
  }

  const line = `${getCorrelationIdLog(correlationId)} ${message}`;
  if (level === 'error') {
    console.error(line, meta ?? '');
    return;
  }
  if (level === 'warn') {
    console.warn(line, meta ?? '');
    return;
  }
  console.log(line, meta ?? '');
}

function attachBrowserErrorHandlers(
  browser: Browser,
  context: BrowserContext,
  page: Page,
  correlationId: string,
  logger?: Logger,
) {
  browser.on('disconnected', () => {
    emitBrowserLog(logger, correlationId, 'warn', 'Browser has disconnected', {
      phase: 'browser.lifecycle',
    });
  });

  context.on('close', () => {
    emitBrowserLog(logger, correlationId, 'info', 'Browser context has closed', {
      phase: 'browser.lifecycle',
    });
  });

  page.on('crash', (page) => {
    emitBrowserLog(logger, correlationId, 'error', 'Browser page has crashed', {
      phase: 'browser.lifecycle',
      pageUrl: page?.url(),
    });
  });

  page.on('close', (page) => {
    emitBrowserLog(logger, correlationId, 'info', 'Browser page has closed', {
      phase: 'browser.lifecycle',
      pageUrl: page?.url(),
    });
  });
}

async function launchBrowserWithTimeout(
  launchFn: () => Promise<Browser>,
  timeoutMs: number,
  correlationId: string,
  logger?: Logger,
): Promise<Browser> {
  let timeoutId: NodeJS.Timeout;
  let finished = false;

  return new Promise((resolve, reject) => {
    // Set up timeout
    timeoutId = setTimeout(() => {
      if (!finished) {
        finished = true;
        reject(new Error(`Browser launch timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    // Start launch
    launchFn()
      .then(result => {
        if (!finished) {
          finished = true;
          clearTimeout(timeoutId);
          emitBrowserLog(logger, correlationId, 'info', 'Browser launch function succeeded', {
            phase: 'browser.launch',
          });
          resolve(result);
        }
      })
      .catch(err => {
        emitBrowserLog(logger, correlationId, 'error', 'Error launching browser', {
          phase: 'browser.launch',
          error: err instanceof Error ? err.message : String(err),
        });
        if (!finished) {
          finished = true;
          clearTimeout(timeoutId);
          reject(err);
        }
      });
  });
}

async function createBrowserContext(
  url: string,
  correlationId: string,
  botType: BotType = 'google',
  logger?: Logger,
): Promise<Page> {
  const size = {
    width: config.recordingCapture.width,
    height: config.recordingCapture.height,
  };

  // Base browser args used by all bots
  const baseBrowserArgs: string[] = [
    '--enable-usermedia-screen-capturing',
    '--allow-http-screen-capture',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-web-security',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    `--window-size=${size.width},${size.height}`,
    '--auto-accept-this-tab-capture',
    '--enable-features=MediaRecorder',
    '--enable-audio-service-out-of-process',
    '--autoplay-policy=no-user-gesture-required',
  ];

  // Fake device args - only for Microsoft Teams
  // Teams needs fake devices to interact with pre-join screen toggles,
  // but actual recording is done via ffmpeg (X11 + PulseAudio)
  const fakeDeviceArgs: string[] = [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
  ];

  // Google Meet and Zoom use browser-based recording (getDisplayMedia + MediaRecorder)
  // and don't need fake devices:
  // - Google Meet: clicks "Continue without microphone and camera"
  // - Zoom: expects "Cannot detect your camera/microphone" notifications
  const browserArgs = botType === 'microsoft'
    ? [...baseBrowserArgs, ...fakeDeviceArgs]
    : baseBrowserArgs;

  // Teams-specific display args: kiosk mode prevents address bar from showing in ffmpeg recording
  // Google Meet and Zoom don't need this since they use tab capture (getDisplayMedia)
  const displayArgs = botType === 'microsoft'
    ? ['--kiosk', '--start-maximized']
    : [];

  emitBrowserLog(logger, correlationId, 'info', `Launching browser for ${botType} bot`, {
    phase: 'browser.launch',
    botType,
    fakeDevicesEnabled: botType === 'microsoft',
    display: process.env.DISPLAY || null,
    pulseServer: process.env.PULSE_SERVER || null,
    chromeExecutablePath: config.chromeExecutablePath,
    viewport: `${size.width}x${size.height}`,
  });

  const browser = await launchBrowserWithTimeout(
    async () => await chromium.launch({
      headless: false,
      args: [
        ...browserArgs,
        ...displayArgs,
      ],
      ignoreDefaultArgs: ['--mute-audio'],
      executablePath: config.chromeExecutablePath,
    }),
    60000,
    correlationId,
    logger,
  );

  const linuxX11UserAgent = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36';
  
  const context = await browser.newContext({
    permissions: ['camera', 'microphone'],
    viewport: size,
    ignoreHTTPSErrors: true,
    userAgent: linuxX11UserAgent,
    // Record video only in development for debugging
    ...(process.env.NODE_ENV === 'development' && {
      recordVideo: {
        dir: './debug-videos/',
        size: size,
      },
    }),
  });

  // Grant permissions so Teams will play audio (Teams requires this unlike Google Meet)
  await context.grantPermissions(['microphone', 'camera'], { origin: url });

  const page = await context.newPage();

  // Attach common error handlers
  attachBrowserErrorHandlers(browser, context, page, correlationId, logger);

  emitBrowserLog(logger, correlationId, 'info', 'Browser launched successfully', {
    phase: 'browser.launch',
    grantedPermissions: ['microphone', 'camera'],
    ignoreHTTPSErrors: true,
  });

  return page;
}

export default createBrowserContext;
