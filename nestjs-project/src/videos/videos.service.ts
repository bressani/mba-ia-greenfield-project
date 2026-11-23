import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { DomainException } from '../common/exceptions/domain.exception';
import { VIDEO_PART_BYTES } from './video.constants';
import type {
  SignedVideoPartsDto,
  StartVideoDto,
  VideoDto,
  VideoUploadDto,
} from './video.dto';
import { Video, VideoStatus } from './video.entity';
import { VideoQueue } from './video-queue';
import { VideoStorage } from './video-storage';

class VideoException extends DomainException {}

@Injectable()
export class VideosService {
  private readonly logger = new Logger(VideosService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly storage: VideoStorage,
    private readonly queue: VideoQueue,
  ) {}

  async start(userId: string, input: StartVideoDto): Promise<VideoDto> {
    const manager = this.dataSource.manager;
    const channel = await manager.findOneBy(Channel, { user_id: userId });
    if (!channel) {
      throw new VideoException('CHANNEL_NOT_FOUND', 404, 'Channel not found');
    }

    const id = randomUUID();
    const originalKey = `videos/${id}/original`;
    const uploadId = await this.storageCall(() =>
      this.storage.createUpload(originalKey, input.contentType),
    );

    const video = manager.create(Video, {
      ...input,
      id,
      url: `/videos/${id}`,
      channelId: channel.id,
      originalKey,
      uploadId,
      status: VideoStatus.Draft,
    });

    try {
      return this.view(await manager.save(video));
    } catch (error) {
      await this.storage.abortUpload(originalKey, uploadId).catch(() => {
        this.logger.warn(`Could not abort multipart upload for video ${id}`);
      });
      throw error;
    }
  }

  async get(userId: string, id: string): Promise<VideoDto> {
    const video = await this.ownedVideo(this.dataSource.manager, userId, id);
    const response = this.view(video);
    if (video.status === VideoStatus.Ready && video.thumbnailKey) {
      const thumbnailKey = video.thumbnailKey;
      response.links = await this.storageCall(() =>
        this.storage.signLinks(video.originalKey, video.filename, thumbnailKey),
      );
    }
    return response;
  }

  async getUpload(userId: string, id: string): Promise<VideoUploadDto> {
    const video = await this.ownedVideo(this.dataSource.manager, userId, id);
    const uploadId = this.draftUploadId(video);
    const parts = await this.storageCall(() =>
      this.storage.listParts(video.originalKey, uploadId),
    );
    return {
      id,
      sizeBytes: video.sizeBytes,
      partSizeBytes: VIDEO_PART_BYTES,
      partCount: this.partCount(video),
      parts: parts.map(({ partNumber, sizeBytes }) => ({
        partNumber,
        sizeBytes,
      })),
    };
  }

  async signParts(
    userId: string,
    id: string,
    partNumbers: number[],
  ): Promise<SignedVideoPartsDto> {
    const video = await this.ownedVideo(this.dataSource.manager, userId, id);
    const uploadId = this.draftUploadId(video);
    const partCount = this.partCount(video);
    if (
      new Set(partNumbers).size !== partNumbers.length ||
      partNumbers.some((partNumber) => partNumber > partCount)
    ) {
      throw new VideoException(
        'INVALID_UPLOAD_PART',
        400,
        'Part numbers must be unique and within this upload plan',
      );
    }

    const parts = await Promise.all(
      partNumbers.map(async (partNumber) => {
        const sizeBytes = this.partSize(video, partNumber);
        const url = await this.storageCall(() =>
          this.storage.signPart(
            video.originalKey,
            uploadId,
            partNumber,
            sizeBytes,
          ),
        );
        return { partNumber, sizeBytes, url };
      }),
    );
    return { parts };
  }

  async complete(userId: string, id: string): Promise<VideoDto> {
    const current = await this.ownedVideo(this.dataSource.manager, userId, id);
    if (current.status !== VideoStatus.Draft) {
      return this.view(current);
    }
    await this.queue.ready().catch(() => {
      throw this.queueUnavailable();
    });
    return this.dataSource.transaction(async (manager) => {
      const video = await this.ownedVideo(manager, userId, id, true);
      if (video.status !== VideoStatus.Draft) {
        return this.view(video);
      }

      const uploadId = this.draftUploadId(video);
      const { originalKey } = video;
      let size = await this.storageCall(() =>
        this.storage.originalSize(originalKey),
      );
      if (size === null) {
        const parts = await this.storageCall(() =>
          this.storage.listParts(originalKey, uploadId),
        );
        if (
          parts.length !== this.partCount(video) ||
          parts.some(({ partNumber }, index) => partNumber !== index + 1)
        ) {
          throw new VideoException(
            'UPLOAD_INCOMPLETE',
            409,
            'Upload all planned parts before completing the video',
          );
        }
        if (
          parts.some(
            ({ partNumber, sizeBytes }) =>
              sizeBytes !== this.partSize(video, partNumber),
          )
        ) {
          throw this.sizeMismatch();
        }

        await this.storageCall(() =>
          this.storage.completeUpload(originalKey, uploadId, parts),
        );
        size = await this.storageCall(() =>
          this.storage.originalSize(originalKey),
        );
      }

      if (size !== video.sizeBytes) {
        throw this.sizeMismatch();
      }

      video.status = VideoStatus.Processing;
      video.uploadId = null;
      const saved = await manager.save(video);
      try {
        await this.queue.enqueue(manager, id);
      } catch {
        throw this.queueUnavailable();
      }
      return this.view(saved);
    });
  }

  private queueUnavailable(): VideoException {
    return new VideoException(
      'VIDEO_QUEUE_UNAVAILABLE',
      503,
      'Video processing queue is temporarily unavailable',
    );
  }

  private async ownedVideo(
    manager: EntityManager,
    userId: string,
    id: string,
    lock = false,
  ): Promise<Video> {
    const channel = await manager.findOneBy(Channel, { user_id: userId });
    const video = channel
      ? await manager.findOne(Video, {
          where: { id, channelId: channel.id },
          ...(lock && { lock: { mode: 'pessimistic_write' } }),
        })
      : null;
    if (!video) {
      throw new VideoException('VIDEO_NOT_FOUND', 404, 'Video not found');
    }
    return video;
  }

  private draftUploadId(video: Video): string {
    if (video.status !== VideoStatus.Draft || !video.uploadId) {
      throw new VideoException(
        'VIDEO_NOT_DRAFT',
        409,
        'Video has no draft upload',
      );
    }
    return video.uploadId;
  }

  private partCount(video: Video): number {
    return Math.ceil(video.sizeBytes / VIDEO_PART_BYTES);
  }

  private partSize(video: Video, partNumber: number): number {
    return Math.min(
      VIDEO_PART_BYTES,
      video.sizeBytes - (partNumber - 1) * VIDEO_PART_BYTES,
    );
  }

  private async storageCall<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof Error) {
        if (error.name === 'NoSuchUpload') {
          throw new VideoException(
            'UPLOAD_UNAVAILABLE',
            409,
            'Multipart session is unavailable',
          );
        }
        if (error.name === 'InvalidPart' || error.name === 'InvalidPartOrder') {
          throw new VideoException(
            'UPLOAD_INCOMPLETE',
            409,
            'Multipart parts changed before completion',
          );
        }
        if (error.name === 'EntityTooSmall') {
          throw this.sizeMismatch();
        }
      }
      throw new VideoException(
        'VIDEO_STORAGE_UNAVAILABLE',
        503,
        'Video storage is temporarily unavailable',
      );
    }
  }

  private sizeMismatch(): VideoException {
    return new VideoException(
      'UPLOAD_SIZE_MISMATCH',
      409,
      'Stored video size does not match the upload plan',
    );
  }

  private view(video: Video): VideoDto {
    return {
      id: video.id,
      url: video.url,
      title: video.title,
      filename: video.filename,
      contentType: video.contentType,
      sizeBytes: video.sizeBytes,
      status: video.status,
      partSizeBytes: VIDEO_PART_BYTES,
      metadata: video.metadata,
      durationSeconds: video.durationSeconds,
      failureCode: video.failureCode,
      createdAt: video.createdAt,
      updatedAt: video.updatedAt,
    };
  }
}
