import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import PgBoss from 'pg-boss';
import { DataSource, EntityManager } from 'typeorm';
import { Video, VideoStatus } from './video.entity';

export const VIDEO_PROCESSING_QUEUE = 'video-processing';
export const VIDEO_FAILURE_QUEUE = 'video-processing-failed';

export interface VideoProcessingJob {
  videoId: string;
}

@Injectable()
export class VideoQueue implements OnModuleDestroy {
  private readonly logger = new Logger(VideoQueue.name);
  private starting?: Promise<PgBoss>;

  constructor(private readonly dataSource: DataSource) {}

  ready(): Promise<PgBoss> {
    this.starting ??= this.start().catch((error: unknown) => {
      this.starting = undefined;
      throw error;
    });
    return this.starting;
  }

  private async start(): Promise<PgBoss> {
    const boss = new PgBoss({
      schedule: false,
      db: {
        executeSql: async (sql: string, params: unknown[]) => {
          const runner = this.dataSource.createQueryRunner();
          try {
            const result = await runner.query(sql, params, true);
            return { rows: result.records as unknown[] };
          } finally {
            await runner.release();
          }
        },
      },
    });
    boss.on('error', () => this.logger.error('Video queue connection error'));
    await boss.start();
    try {
      await boss.createQueue(VIDEO_FAILURE_QUEUE);
      await boss.createQueue(VIDEO_PROCESSING_QUEUE);
      return boss;
    } catch (error) {
      await boss.stop();
      throw error;
    }
  }

  async enqueue(manager: EntityManager, videoId: string): Promise<void> {
    const boss = await this.ready();
    const id = await boss.send(
      VIDEO_PROCESSING_QUEUE,
      { videoId } satisfies VideoProcessingJob,
      {
        retryLimit: 2,
        retryDelay: 2,
        expireInHours: 1,
        deadLetter: VIDEO_FAILURE_QUEUE,
        db: {
          executeSql: async (sql: string, params: unknown[]) => ({
            rows: await manager.query<unknown[]>(sql, params),
          }),
        },
      },
    );
    if (!id) {
      throw new Error('Video processing job was not queued');
    }
  }

  async startFailureConsumer(): Promise<void> {
    const boss = await this.ready();
    await boss.work<VideoProcessingJob>(
      VIDEO_FAILURE_QUEUE,
      { pollingIntervalSeconds: 1 },
      async ([job]) => {
        await this.dataSource
          .getRepository(Video)
          .update(
            { id: job.data.videoId, status: VideoStatus.Processing },
            { status: VideoStatus.Error, failureCode: 'PROCESSING_FAILED' },
          );
      },
    );
  }

  async onModuleDestroy(): Promise<void> {
    if (this.starting) {
      const boss = await this.starting;
      await boss.stop({ graceful: true, timeout: 30_000 });
    }
  }
}
