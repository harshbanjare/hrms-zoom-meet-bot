import axios from 'axios';
import { createReadStream, promises as fs } from 'fs';

export interface YouTubeUploadOptions {
  filePath: string;
  fileName: string;
  contentType: string;
  title: string;
  description?: string;
  privacyStatus: 'public';
  accessToken: string;
  refreshAccessToken?: () => Promise<string>;
}

export interface YouTubeUploadResult {
  videoId: string;
  watchUrl: string;
  embedUrl: string;
  thumbnailUrl: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  privacyStatus: 'public';
  storagePath: string;
  url: string;
}

const YOUTUBE_RESUMABLE_UPLOAD_URL =
  'https://www.googleapis.com/upload/youtube/v3/videos';

function isUnauthorized(error: unknown) {
  if (!axios.isAxiosError(error)) {
    return false;
  }

  return error.response?.status === 401;
}

async function withAccessTokenRetry<T>(
  initialAccessToken: string,
  refreshAccessToken: (() => Promise<string>) | undefined,
  action: (accessToken: string) => Promise<T>,
): Promise<T> {
  try {
    return await action(initialAccessToken);
  } catch (error) {
    if (!isUnauthorized(error) || !refreshAccessToken) {
      throw error;
    }

    const refreshedAccessToken = await refreshAccessToken();
    return action(refreshedAccessToken);
  }
}

export async function uploadVideoToYouTube(
  options: YouTubeUploadOptions,
): Promise<YouTubeUploadResult> {
  const stats = await fs.stat(options.filePath);
  const metadata = {
    snippet: {
      title: options.title,
      description: options.description || '',
      categoryId: '27',
    },
    status: {
      privacyStatus: options.privacyStatus,
    },
  };

  const initiateUpload = async (accessToken: string) =>
    axios.post(
      `${YOUTUBE_RESUMABLE_UPLOAD_URL}?uploadType=resumable&part=snippet,status`,
      metadata,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Length': String(stats.size),
          'X-Upload-Content-Type': options.contentType,
        },
        timeout: 15000,
        validateStatus: (status) => status >= 200 && status < 400,
      },
    );

  const initiateResponse = await withAccessTokenRetry(
    options.accessToken,
    options.refreshAccessToken,
    initiateUpload,
  );

  const uploadUrl = initiateResponse.headers.location as string | undefined;
  if (!uploadUrl) {
    throw new Error('YouTube resumable upload URL was not returned');
  }

  const uploadVideo = async (accessToken: string) =>
    axios.put(uploadUrl, createReadStream(options.filePath), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Length': String(stats.size),
        'Content-Type': options.contentType,
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 0,
    });

  const uploadResponse = await withAccessTokenRetry(
    options.accessToken,
    options.refreshAccessToken,
    uploadVideo,
  );

  const videoId = uploadResponse.data?.id as string | undefined;
  if (!videoId) {
    throw new Error('YouTube upload completed without a video id');
  }

  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const embedUrl = `https://www.youtube.com/embed/${videoId}`;
  const thumbnailUrl = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

  return {
    videoId,
    watchUrl,
    embedUrl,
    thumbnailUrl,
    fileName: options.fileName,
    contentType: options.contentType,
    sizeBytes: stats.size,
    privacyStatus: options.privacyStatus,
    storagePath: watchUrl,
    url: watchUrl,
  };
}
