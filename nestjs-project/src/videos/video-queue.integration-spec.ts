import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { createTestDataSource } from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './video.entity';
import {
  VIDEO_FAILURE_QUEUE,
  VIDEO_PROCESSING_QUEUE,
  VideoProcessingJob,
  VideoQueue,
} from './video-queue';

describe('VideoQueue with a real TypeORM transaction (integration)', () => {
  let source: DataSource;
  let observer: DataSource;
  let module: TestingModule;
  let queue: VideoQueue;
  let user: User;
  let channel: Channel;
  let videoId: string | undefined;

  beforeAll(async () => {
    const entities = [User, Channel, Video];
    source = await createTestDataSource(entities, {
      synchronize: false,
    }).initialize();
    observer = await createTestDataSource(entities, {
      synchronize: false,
    }).initialize();
    module = await Test.createTestingModule({
      providers: [VideoQueue, { provide: DataSource, useValue: source }],
    }).compile();
    queue = module.get(VideoQueue);
    await queue.ready();

    const nickname = `queue-${randomUUID()}`;
    user = await source.getRepository(User).save({
      email: `${nickname}@example.com`,
      password: 'unused-test-fixture',
    });
    channel = await source
      .getRepository(Channel)
      .save({ name: 'Queue integration', nickname, user_id: user.id });
  }, 30_000);

  beforeEach(async () => {
    videoId = randomUUID();
    await source.getRepository(Video).save({
      id: videoId,
      url: `/videos/${videoId}`,
      channelId: channel.id,
      title: 'Queue transaction',
      filename: 'transaction.mp4',
      contentType: 'video/mp4',
      sizeBytes: 1,
      uploadId: null,
      originalKey: `videos/${videoId}/original`,
      status: VideoStatus.Draft,
    });
  });

  afterEach(async () => {
    if (source?.isInitialized && videoId) {
      await source.query(
        "DELETE FROM pgboss.job WHERE name IN ($1, $2) AND data ->> 'videoId' = $3",
        [VIDEO_PROCESSING_QUEUE, VIDEO_FAILURE_QUEUE, videoId],
      );
      await source.getRepository(Video).delete(videoId);
    }
  });

  afterAll(async () => {
    try {
      if (source?.isInitialized && channel) {
        await source.getRepository(Channel).delete(channel.id);
      }
      if (source?.isInitialized && user) {
        await source.getRepository(User).delete(user.id);
      }
    } finally {
      await module?.close();
      if (observer?.isInitialized) {
        await observer.destroy();
      }
      if (source?.isInitialized) {
        await source.destroy();
      }
    }
  });

  async function jobCount(connection: Pick<DataSource, 'query'>, id: string) {
    const [result] = await connection.query<{ count: number }[]>(
      "SELECT count(*)::int AS count FROM pgboss.job WHERE name = $1 AND data ->> 'videoId' = $2",
      [VIDEO_PROCESSING_QUEUE, id],
    );
    return result.count;
  }

  async function visibleState(id: string) {
    const video = await observer.getRepository(Video).findOneByOrFail({ id });
    return { status: video.status, jobs: await jobCount(observer, id) };
  }

  it('rolls back the video state and the inserted job together', async () => {
    const id = videoId!;
    const forcedRollback = new Error('Forced rollback after enqueue');

    await expect(
      source.transaction(async (manager) => {
        await manager.update(Video, id, { status: VideoStatus.Processing });
        await queue.enqueue(manager, id);
        expect(await jobCount(manager, id)).toBe(1);
        expect(await visibleState(id)).toEqual({
          status: VideoStatus.Draft,
          jobs: 0,
        });
        throw forcedRollback;
      }),
    ).rejects.toBe(forcedRollback);

    expect(await visibleState(id)).toEqual({
      status: VideoStatus.Draft,
      jobs: 0,
    });
  });

  it('commits the video state and exactly one job together', async () => {
    const id = videoId!;

    await source.transaction(async (manager) => {
      await manager.update(Video, id, { status: VideoStatus.Processing });
      await queue.enqueue(manager, id);
      expect(await visibleState(id)).toEqual({
        status: VideoStatus.Draft,
        jobs: 0,
      });
    });

    expect(await visibleState(id)).toEqual({
      status: VideoStatus.Processing,
      jobs: 1,
    });
  });

  it('updates a processing video when its last active job expires', async () => {
    const id = videoId!;
    const boss = await queue.ready();
    await source.transaction(async (manager) => {
      await manager.update(Video, id, { status: VideoStatus.Processing });
      await queue.enqueue(manager, id);
    });
    const [job] = await boss.fetch<VideoProcessingJob>(VIDEO_PROCESSING_QUEUE);
    expect(job.data.videoId).toBe(id);

    // Simulate the last worker dying during its final attempt. The queue still
    // performs its real expiration and dead-letter operations.
    await source.query(
      `UPDATE pgboss.job
       SET started_on = now() - expire_in - interval '1 second',
           retry_count = retry_limit
       WHERE id = $1 AND name = $2 AND state = 'active'`,
      [job.id, VIDEO_PROCESSING_QUEUE],
    );

    await queue.startFailureConsumer();
    try {
      await boss.expire();
      const videos = observer.getRepository(Video);
      const deadline = Date.now() + 10_000;
      let video = await videos.findOneByOrFail({ id });
      while (video.status === VideoStatus.Processing && Date.now() < deadline) {
        await delay(100);
        video = await videos.findOneByOrFail({ id });
      }
      expect(video.status).toBe(VideoStatus.Error);
      expect(video.failureCode).toBe('PROCESSING_FAILED');
    } finally {
      await boss.offWork(VIDEO_FAILURE_QUEUE);
    }
  }, 15_000);
});
