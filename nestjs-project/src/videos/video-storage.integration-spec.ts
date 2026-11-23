import {
  DeleteObjectCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { VideoStorage } from './video-storage';

async function requestStorage(
  url: string | URL,
  options?: RequestInit,
): Promise<Response> {
  try {
    return await fetch(url, {
      signal: AbortSignal.timeout(10_000),
      ...options,
    });
  } catch {
    throw new Error('Could not reach the MinIO HTTP endpoint');
  }
}

describe('VideoStorage with MinIO', () => {
  const bucket = process.env.S3_BUCKET ?? 'streamtube-videos';
  const endpoint = process.env.S3_ENDPOINT ?? 'http://minio:9000';
  const previousPublicEndpoint = process.env.S3_PUBLIC_ENDPOINT;
  let testModule: TestingModule;
  let storage: VideoStorage;
  let cleanupClient: S3Client;
  let videoId: string;
  let originalKey: string;
  let uploadId: string | undefined;

  beforeAll(async () => {
    const accessKeyId = process.env.S3_ACCESS_KEY_ID;
    const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
    if (!accessKeyId || !secretAccessKey) {
      throw new Error(
        'MinIO credentials are required by this integration suite',
      );
    }

    // The test client runs in the Compose network and signs the hostname it uses.
    process.env.S3_PUBLIC_ENDPOINT = endpoint;
    testModule = await Test.createTestingModule({
      providers: [VideoStorage],
    }).compile();
    storage = testModule.get(VideoStorage);
    cleanupClient = new S3Client({
      endpoint,
      region: process.env.S3_REGION ?? 'us-east-1',
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle: true,
    });
  });

  beforeEach(() => {
    videoId = randomUUID();
    originalKey = `storage-fixtures/${videoId}/source.mp4`;
    uploadId = undefined;
  });

  afterEach(async () => {
    if (!cleanupClient || !videoId) {
      return;
    }
    try {
      if (uploadId) {
        await storage.abortUpload(originalKey, uploadId);
      }
    } finally {
      await Promise.all(
        [originalKey, `videos/${videoId}/thumbnail.jpg`].map((key) =>
          cleanupClient.send(
            new DeleteObjectCommand({
              Bucket: bucket,
              Key: key,
            }),
          ),
        ),
      );
    }
  });

  afterAll(async () => {
    try {
      await testModule?.close();
    } finally {
      cleanupClient?.destroy();
      if (previousPublicEndpoint === undefined) {
        delete process.env.S3_PUBLIC_ENDPOINT;
      } else {
        process.env.S3_PUBLIC_ENDPOINT = previousPublicEndpoint;
      }
    }
  });

  it('resumes a multipart upload and retrieves the verified original and thumbnail through MinIO', async () => {
    const firstPart = Buffer.alloc(5 * 1024 * 1024, 0x31);
    const lastPart = Buffer.from('abc');
    const size = firstPart.length + lastPart.length;
    uploadId = await storage.createUpload(originalKey, 'video/mp4');
    expect(await storage.originalSize(originalKey)).toBeNull();
    expect(await storage.listParts(originalKey, uploadId)).toEqual([]);

    const firstUrl = await storage.signPart(
      originalKey,
      uploadId,
      1,
      firstPart.length,
    );
    const wrongLength = await requestStorage(firstUrl, {
      method: 'PUT',
      headers: { connection: 'close' },
      body: Buffer.from('x'),
    });
    expect(wrongLength.status).toBe(403);
    await wrongLength.arrayBuffer();

    const firstUpload = await requestStorage(firstUrl, {
      method: 'PUT',
      body: firstPart,
    });
    expect(firstUpload.status).toBe(200);
    await firstUpload.arrayBuffer();
    const resumed = await storage.listParts(originalKey, uploadId);
    expect(resumed).toMatchObject([
      { partNumber: 1, sizeBytes: firstPart.length },
    ]);

    const lastUrl = await storage.signPart(
      originalKey,
      uploadId,
      2,
      lastPart.length,
    );
    const lastUpload = await requestStorage(lastUrl, {
      method: 'PUT',
      body: lastPart,
    });
    expect(lastUpload.status).toBe(200);
    await lastUpload.arrayBuffer();
    const parts = await storage.listParts(originalKey, uploadId);
    expect(parts.map((part) => part.sizeBytes)).toEqual([
      firstPart.length,
      lastPart.length,
    ]);
    await storage.completeUpload(originalKey, uploadId, parts);
    uploadId = undefined;
    expect(await storage.originalSize(originalKey)).toBe(size);
    const { ContentLength } = await cleanupClient.send(
      new HeadObjectCommand({ Bucket: bucket, Key: originalKey }),
    );
    expect(ContentLength).toBe(size);

    const thumbnailBytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const thumbnailKey = await storage.putThumbnail(videoId, thumbnailBytes);
    const links = await storage.signLinks(
      originalKey,
      'vídeo "x".mp4',
      thumbnailKey,
    );

    const unsignedUrl = new URL(links.playback);
    unsignedUrl.search = '';
    const unsigned = await requestStorage(unsignedUrl);
    expect(unsigned.status).toBe(403);
    await unsigned.body?.cancel();

    const start = firstPart.length - 1;
    const end = firstPart.length + 1;
    const range = await requestStorage(links.playback, {
      headers: { Range: `bytes=${start}-${end}` },
    });
    expect(range.status).toBe(206);
    expect(range.headers.get('content-range')).toBe(
      `bytes ${start}-${end}/${size}`,
    );
    expect(await range.text()).toBe('1ab');

    const download = await requestStorage(links.download);
    expect(download.status).toBe(200);
    expect(download.headers.get('content-disposition')).toMatch(
      /^attachment; filename=.*; filename\*=UTF-8''v%C3%ADdeo%20%22x%22\.mp4$/,
    );
    const downloaded = Buffer.from(await download.arrayBuffer());
    expect(downloaded.equals(Buffer.concat([firstPart, lastPart]))).toBe(true);

    const thumbnail = await requestStorage(links.thumbnail);
    expect(thumbnail.status).toBe(200);
    expect(thumbnail.headers.get('content-type')).toBe('image/jpeg');
    expect(
      Buffer.from(await thumbnail.arrayBuffer()).equals(thumbnailBytes),
    ).toBe(true);
  }, 30_000);

  it('invalidates a cancelled multipart session', async () => {
    const cancelled = await storage.createUpload(originalKey, 'video/mp4');
    uploadId = cancelled;

    await storage.abortUpload(originalKey, cancelled);
    uploadId = undefined;

    await expect(
      storage.listParts(originalKey, cancelled),
    ).rejects.toMatchObject({ name: 'NoSuchUpload' });
    expect(await storage.originalSize(originalKey)).toBeNull();
  });
});
