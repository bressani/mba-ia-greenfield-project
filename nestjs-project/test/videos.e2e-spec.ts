import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { IncomingMessage, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import {
  AbortMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { Channel } from '../src/channels/entities/channel.entity';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { getMailpitMessage, getMailpitMessages } from '../src/test/mailpit';
import { VIDEO_PROCESSING_QUEUE, VideoQueue } from '../src/videos/video-queue';
import type { VideoUploadDto } from '../src/videos/video.dto';
import { Video, VideoStatus } from '../src/videos/video.entity';

const execFileAsync = promisify(execFile);
const PART_SIZE_BYTES = 64 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 10_000_000_000;
const S3_ENDPOINT = process.env.S3_ENDPOINT ?? 'http://minio:9000';
const S3_BUCKET = process.env.S3_BUCKET ?? 'streamtube-videos';
const accessKeyId = process.env.S3_ACCESS_KEY_ID;
const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;

interface VideoResponse {
  id: string;
  url: string;
  status: VideoStatus;
  sizeBytes: number;
  title: string;
  partSizeBytes: number;
  durationSeconds: number | null;
  metadata: {
    format: string;
    videoCodec: string;
    width: number;
    height: number;
  } | null;
  failureCode: string | null;
  links?: { thumbnail: string; playback: string; download: string } | null;
}

interface SignedPart {
  partNumber: number;
  url: string;
}

function storageRequest(
  method: 'GET' | 'PUT',
  url: string,
  headers: Record<string, string> = {},
  body?: Buffer,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    // Connect inside Compose without changing the host covered by the signature.
    const signed = new URL(url);
    const endpoint = new URL(S3_ENDPOINT);
    const send = endpoint.protocol === 'https:' ? httpsRequest : httpRequest;
    const outgoing = send(
      endpoint,
      {
        method,
        path: signed.pathname + signed.search,
        headers: { ...headers, host: signed.host },
      },
      resolve,
    );
    outgoing.on('error', () =>
      reject(new Error('Request to object storage failed')),
    );
    outgoing.setTimeout(30_000, () => outgoing.destroy());
    outgoing.end(body);
  });
}

async function* responseBytes(
  response: IncomingMessage,
): AsyncGenerator<Buffer> {
  try {
    for await (const chunk of response) {
      yield Buffer.from(chunk as Uint8Array);
    }
  } catch {
    throw new Error('Failed to read the object storage response');
  }
}

function assertStorageStatus(response: IncomingMessage, status: number) {
  if (response.statusCode !== status) {
    response.destroy();
  }
  expect(response.statusCode).toBe(status);
}

async function upload(part: SignedPart, bytes: Buffer): Promise<void> {
  const response = await storageRequest(
    'PUT',
    part.url,
    { 'content-length': String(bytes.length) },
    bytes,
  );
  assertStorageStatus(response, 200);
  expect(Boolean(response.headers.etag)).toBe(true);
  for await (const chunk of responseBytes(response)) {
    expect(chunk.length).toBe(0);
  }
}

async function readSmallObject(response: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of responseBytes(response)) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function multipartFixture() {
  const { stdout: movie } = await execFileAsync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=duration=1:size=160x120:rate=15',
      '-an',
      '-c:v',
      'libx264',
      '-threads',
      '1',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      'frag_keyframe+empty_moov+default_base_moof',
      '-f',
      'mp4',
      'pipe:1',
    ],
    { encoding: 'buffer' },
  );
  const first = Buffer.alloc(PART_SIZE_BYTES);
  const second = Buffer.alloc(16_384);
  movie.copy(first);
  // Add a valid top-level ISO BMFF padding box so the fixture crosses a part boundary.
  first.writeUInt32BE(1, movie.length);
  first.write('free', movie.length + 4);
  first.writeBigUInt64BE(
    BigInt(first.length + second.length - movie.length),
    movie.length + 8,
  );
  return { first, last: second, movieBytes: movie.length };
}

describe('Upload and process videos (e2e)', () => {
  let app: INestApplication<App>;
  let source: DataSource;
  let throttler: ThrottlerStorageService;
  let owner: string;
  let other: string;
  const userIds: string[] = [];
  const videoIds: string[] = [];
  const storage = new S3Client({
    endpoint: S3_ENDPOINT,
    region: process.env.S3_REGION ?? 'us-east-1',
    credentials:
      accessKeyId && secretAccessKey
        ? { accessKeyId, secretAccessKey }
        : undefined,
    forcePathStyle: true,
    requestChecksumCalculation: 'WHEN_REQUIRED',
  });

  beforeAll(async () => {
    const fixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = fixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();
    source = fixture.get(DataSource);
    throttler = fixture.get<ThrottlerStorageService>(ThrottlerStorage);
    owner = await registerAndLogin();
    other = await registerAndLogin();
  }, 30_000);

  beforeEach(() => throttler.storage.clear());

  afterAll(async () => {
    try {
      for (const id of videoIds) {
        const video = await source.getRepository(Video).findOneBy({ id });
        if (!video) {
          continue;
        }
        if (video.uploadId) {
          try {
            await storage.send(
              new AbortMultipartUploadCommand({
                Bucket: S3_BUCKET,
                Key: video.originalKey,
                UploadId: video.uploadId,
              }),
            );
          } catch (error) {
            if (!(error instanceof Error) || error.name !== 'NoSuchUpload') {
              throw new Error('Failed to clean up the test multipart upload');
            }
          }
        }
        await storage.send(
          new DeleteObjectsCommand({
            Bucket: S3_BUCKET,
            Delete: {
              Objects: [
                { Key: video.originalKey },
                { Key: `videos/${id}/thumbnail.jpg` },
              ],
            },
          }),
        );
        if (video.status !== VideoStatus.Draft) {
          await source.query(
            "DELETE FROM pgboss.job WHERE name = $1 AND data ->> 'videoId' = $2",
            [VIDEO_PROCESSING_QUEUE, id],
          );
        }
        await source.getRepository(Video).delete(id);
      }
      for (const id of userIds) {
        await source.query('DELETE FROM refresh_tokens WHERE user_id = $1', [
          id,
        ]);
        await source.query(
          'DELETE FROM verification_tokens WHERE user_id = $1',
          [id],
        );
        await source.getRepository(Channel).delete({ user_id: id });
        await source.query('DELETE FROM users WHERE id = $1', [id]);
      }
    } finally {
      storage.destroy();
      await app?.close();
    }
  }, 30_000);

  async function registerAndLogin(): Promise<string> {
    const email = `video-${randomUUID()}@example.com`;
    const password = 'phase03-test-password';
    const registration = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password })
      .expect(201);
    userIds.push((registration.body as { id: string }).id);

    let confirmationToken: string | null = null;
    for (let attempt = 0; attempt < 30 && !confirmationToken; attempt++) {
      const messages = (await getMailpitMessages()) as {
        ID: string;
        To?: { Address: string }[];
      }[];
      const message = messages.find((item) =>
        item.To?.some((recipient) => recipient.Address === email),
      );
      if (!message) {
        await delay(200);
        continue;
      }
      const { HTML: html } = (await getMailpitMessage(message.ID)) as {
        HTML: string;
      };
      const url = /href="([^"]+\/auth\/confirm-email\?[^"]+)"/.exec(html)?.[1];
      confirmationToken = url
        ? new URL(url.replace(/&#x3D;/g, '=')).searchParams.get('token')
        : null;
    }
    expect(Boolean(confirmationToken)).toBe(true);
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token: confirmationToken })
      .expect(204);
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(200);
    return (login.body as { access_token: string }).access_token;
  }

  async function startUpload(filename: string, sizeBytes: number) {
    const response = await request(app.getHttpServer())
      .post('/videos')
      .auth(owner, { type: 'bearer' })
      .send({
        title: 'A video title',
        filename,
        contentType: 'video/mp4',
        sizeBytes,
      })
      .expect(201);
    const video = response.body as VideoResponse;
    videoIds.push(video.id);
    return video;
  }

  async function signedPart(
    id: string,
    partNumber: number,
  ): Promise<SignedPart> {
    const response = await request(app.getHttpServer())
      .post(`/videos/${id}/upload/parts`)
      .auth(owner, { type: 'bearer' })
      .send({ partNumbers: [partNumber] })
      .expect(200);
    const { parts } = response.body as { parts: SignedPart[] };
    expect(parts.map((part) => part.partNumber)).toEqual([partNumber]);
    expect(Boolean(parts[0].url)).toBe(true);
    return parts[0];
  }

  function complete(id: string) {
    return request(app.getHttpServer())
      .post(`/videos/${id}/upload/complete`)
      .auth(owner, { type: 'bearer' });
  }

  async function jobCount(id: string): Promise<number> {
    const [jobs] = await source.query<{ count: number }[]>(
      "SELECT count(*)::int AS count FROM pgboss.job WHERE name = $1 AND data ->> 'videoId' = $2",
      [VIDEO_PROCESSING_QUEUE, id],
    );
    return jobs.count;
  }

  async function waitUntilProcessed(id: string): Promise<VideoResponse> {
    let lastStatus: VideoStatus | undefined;
    for (let attempt = 0; attempt < 90; attempt++) {
      throttler.storage.clear();
      const response = await request(app.getHttpServer())
        .get(`/videos/${id}`)
        .auth(owner, { type: 'bearer' })
        .expect(200);
      const video = response.body as VideoResponse;
      lastStatus = video.status;
      if (
        lastStatus === VideoStatus.Ready ||
        lastStatus === VideoStatus.Error
      ) {
        return video;
      }
      await delay(500);
    }
    throw new Error(`Video worker did not finish (last state: ${lastStatus})`);
  }

  it('validates the upload limit and requires authentication', async () => {
    const input = {
      title: 'Size limit',
      filename: 'limit.mp4',
      contentType: 'video/mp4',
      sizeBytes: MAX_UPLOAD_BYTES + 1,
    };

    await request(app.getHttpServer()).post('/videos').send(input).expect(401);
    await request(app.getHttpServer())
      .post('/videos')
      .auth(owner, { type: 'bearer' })
      .send(input)
      .expect(400);
  });

  it('resumes multipart upload, protects it from another channel and serves the processed video', async () => {
    const { first, last, movieBytes } = await multipartFixture();
    const sizeBytes = first.length + last.length;
    const draft = await startUpload('resume.mp4', sizeBytes);
    expect(draft.status).toBe(VideoStatus.Draft);
    expect(draft.title).toBe('A video title');
    expect(draft.url).toBe(`/videos/${draft.id}`);
    expect(draft.partSizeBytes).toBe(PART_SIZE_BYTES);
    expect(draft.sizeBytes).toBe(sizeBytes);
    expect('originalKey' in draft || 'original_key' in draft).toBe(false);

    const videos = source.getRepository(Video);
    const persisted = await videos.findOneByOrFail({ id: draft.id });
    expect(persisted.originalKey).toBe(`videos/${draft.id}/original`);
    if (!persisted.uploadId) {
      throw new Error('Draft omitted the multipart session ID');
    }

    // Replace the empty fixture session so the API and worker must read the key from the row.
    await storage.send(
      new AbortMultipartUploadCommand({
        Bucket: S3_BUCKET,
        Key: persisted.originalKey,
        UploadId: persisted.uploadId,
      }),
    );
    const originalKey = `e2e-fixtures/${draft.id}/source.mp4`;
    const { UploadId: uploadId } = await storage.send(
      new CreateMultipartUploadCommand({
        Bucket: S3_BUCKET,
        Key: originalKey,
        ContentType: persisted.contentType,
      }),
    );
    if (!uploadId) {
      throw new Error('MinIO omitted the fixture multipart session ID');
    }
    await videos.update(draft.id, { originalKey, uploadId });

    for (const path of [draft.url, `${draft.url}/upload`]) {
      await request(app.getHttpServer())
        .get(path)
        .auth(other, { type: 'bearer' })
        .expect(404);
    }
    await request(app.getHttpServer())
      .post(`${draft.url}/upload/parts`)
      .auth(other, { type: 'bearer' })
      .send({ partNumbers: [1] })
      .expect(404);
    await request(app.getHttpServer())
      .post(`${draft.url}/upload/complete`)
      .auth(other, { type: 'bearer' })
      .expect(404);

    await upload(await signedPart(draft.id, 1), first);
    const resumed = await request(app.getHttpServer())
      .get(`${draft.url}/upload`)
      .auth(owner, { type: 'bearer' })
      .expect(200);
    const progress = resumed.body as VideoUploadDto;
    expect(progress.parts).toEqual([
      { partNumber: 1, sizeBytes: first.length },
    ]);
    expect(progress.partCount).toBe(2);
    const incomplete = await complete(draft.id).expect(409);
    expect((incomplete.body as { error: string }).error).toBe(
      'UPLOAD_INCOMPLETE',
    );

    const lastPart = await signedPart(draft.id, 2);
    const wrongSize = await storageRequest(
      'PUT',
      lastPart.url,
      { 'content-length': '1' },
      Buffer.alloc(1),
    );
    assertStorageStatus(wrongSize, 403);
    wrongSize.resume();

    // Write directly with the test S3 client to exercise the independent size check.
    await storage.send(
      new UploadPartCommand({
        Bucket: S3_BUCKET,
        Key: originalKey,
        UploadId: uploadId,
        PartNumber: 2,
        Body: Buffer.alloc(1),
      }),
    );
    const mismatched = await complete(draft.id).expect(409);
    expect((mismatched.body as { error: string }).error).toBe(
      'UPLOAD_SIZE_MISMATCH',
    );
    expect(await jobCount(draft.id)).toBe(0);
    await upload(lastPart, last);

    const queue = app.get<VideoQueue>(VideoQueue);
    const enqueue = queue.enqueue.bind(queue) as VideoQueue['enqueue'];
    const failedEnqueue = jest
      .spyOn(queue, 'enqueue')
      .mockImplementationOnce(async (manager, id) => {
        await enqueue(manager, id);
        throw new Error('Forced failure after the real enqueue');
      });
    try {
      const failed = await complete(draft.id).expect(503);
      expect((failed.body as { error: string }).error).toBe(
        'VIDEO_QUEUE_UNAVAILABLE',
      );
    } finally {
      failedEnqueue.mockRestore();
    }
    const { ContentLength } = await storage.send(
      new HeadObjectCommand({
        Bucket: S3_BUCKET,
        Key: originalKey,
      }),
    );
    expect(ContentLength).toBe(sizeBytes);
    expect((await videos.findOneByOrFail({ id: draft.id })).status).toBe(
      VideoStatus.Draft,
    );
    expect(await jobCount(draft.id)).toBe(0);

    await Promise.all([
      complete(draft.id).expect(202),
      complete(draft.id).expect(202),
    ]);
    const ready = await waitUntilProcessed(draft.id);

    expect(ready.status).toBe(VideoStatus.Ready);
    expect(ready.title).toBe('A video title');
    expect(ready.sizeBytes).toBe(sizeBytes);
    expect(ready.durationSeconds).toBeCloseTo(1);
    expect(ready.metadata?.videoCodec).toBe('h264');
    expect(ready.metadata?.format).toContain('mp4');
    expect(ready.metadata?.width).toBe(160);
    expect(ready.metadata?.height).toBe(120);
    expect('originalKey' in ready || 'original_key' in ready).toBe(false);
    const processed = await videos.findOneByOrFail({ id: draft.id });
    expect(processed.originalKey).toBe(originalKey);
    expect(processed.thumbnailKey).toBe(`videos/${draft.id}/thumbnail.jpg`);

    await complete(draft.id).expect(202);
    expect(await jobCount(draft.id)).toBe(1);
    await request(app.getHttpServer())
      .get(draft.url)
      .auth(other, { type: 'bearer' })
      .expect(404);

    if (!ready.links) {
      throw new Error('Ready video omitted media links');
    }
    const thumbnail = await storageRequest('GET', ready.links.thumbnail);
    assertStorageStatus(thumbnail, 200);
    expect(thumbnail.headers['content-type']).toBe('image/jpeg');
    expect((await readSmallObject(thumbnail)).subarray(0, 3)).toEqual(
      Buffer.from([0xff, 0xd8, 0xff]),
    );

    const range = `0-${movieBytes - 1}`;
    const playback = await storageRequest('GET', ready.links.playback, {
      range: `bytes=${range}`,
    });
    assertStorageStatus(playback, 206);
    expect(playback.headers['content-range']).toBe(
      `bytes ${range}/${sizeBytes}`,
    );
    expect(playback.headers['content-type']).toBe('video/mp4');
    const playableBytes = await readSmallObject(playback);
    expect(playableBytes.equals(first.subarray(0, movieBytes))).toBe(true);
    const decode = execFileAsync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-i',
        'pipe:0',
        '-frames:v',
        '1',
        '-threads',
        '1',
        '-pix_fmt',
        'rgb24',
        '-f',
        'rawvideo',
        'pipe:1',
      ],
      { encoding: 'buffer' },
    );
    decode.child.stdin?.end(playableBytes);
    const { stdout: decodedFrame } = await decode;
    expect(decodedFrame.length).toBe(160 * 120 * 3);

    const download = await storageRequest('GET', ready.links.download);
    assertStorageStatus(download, 200);
    expect(download.headers['content-disposition']).toMatch(
      /^attachment;.*resume\.mp4/,
    );
    const digest = createHash('sha256');
    let receivedBytes = 0;
    for await (const chunk of responseBytes(download)) {
      receivedBytes += chunk.length;
      digest.update(chunk);
    }
    expect(receivedBytes).toBe(sizeBytes);
    expect(digest.digest('hex')).toBe(
      createHash('sha256').update(first).update(last).digest('hex'),
    );
  }, 75_000);

  it('records an error for invalid media without allowing playback', async () => {
    const media = Buffer.from('The bytes do not belong to a video.');
    const draft = await startUpload('invalid.mp4', media.length);

    await upload(await signedPart(draft.id, 1), media);
    await complete(draft.id).expect(202);
    const invalid = await waitUntilProcessed(draft.id);

    expect(invalid.status).toBe(VideoStatus.Error);
    expect(invalid.failureCode).toBe('INVALID_MEDIA');
    expect(Boolean(invalid.links)).toBe(false);
  }, 60_000);
});
