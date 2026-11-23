import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { AppModule } from '../app.module';
import { VideoProcessor } from './video-processor';
import {
  VIDEO_PROCESSING_QUEUE,
  VideoQueue,
  VideoProcessingJob,
} from './video-queue';
import { VideoStorage } from './video-storage';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    abortOnError: false,
  });
  app.enableShutdownHooks();

  try {
    const videoQueue = app.get(VideoQueue);
    const queue = await videoQueue.ready();
    await videoQueue.startFailureConsumer();
    const processor = new VideoProcessor(
      app.get(DataSource),
      app.get(VideoStorage),
    );
    await queue.work<VideoProcessingJob>(
      VIDEO_PROCESSING_QUEUE,
      { includeMetadata: true, pollingIntervalSeconds: 1 },
      async ([job]) => processor.process(job),
    );
    Logger.log('Video worker ready', 'VideoWorker');
  } catch (error) {
    await app.close();
    throw error;
  }
}

void bootstrap().catch(() => {
  Logger.error('Video worker startup failed', undefined, 'VideoWorker');
  process.exitCode = 1;
});
