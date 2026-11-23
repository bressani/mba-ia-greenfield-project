import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import type PgBoss from 'pg-boss';
import { DataSource } from 'typeorm';
import { Video, VideoStatus } from './video.entity';
import type { VideoProcessingJob } from './video-queue';
import { VideoStorage } from './video-storage';

const run = promisify(execFile);

interface ProbeStream {
  index: number;
  codec_type: string;
  codec_name?: string;
  duration?: string;
  width?: number;
  height?: number;
  disposition?: { attached_pic?: number };
}

interface ProbeResult {
  format?: { duration?: string; format_name?: string };
  streams?: ProbeStream[];
}

class InvalidMedia extends Error {}

async function ffmpegCommand(command: 'ffprobe' | 'ffmpeg', args: string[]) {
  try {
    return await run(command, args);
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      typeof error.code === 'number'
    ) {
      throw new InvalidMedia();
    }
    throw error;
  }
}

export class VideoProcessor {
  constructor(
    private readonly db: DataSource,
    private readonly storage: VideoStorage,
  ) {}

  async process(
    job: PgBoss.JobWithMetadata<VideoProcessingJob>,
  ): Promise<void> {
    const { videoId } = job.data;
    const videos = this.db.getRepository(Video);
    const video = await videos.findOne({
      select: { originalKey: true },
      where: { id: videoId, status: VideoStatus.Processing },
    });
    if (!video) {
      return;
    }

    let directory: string | undefined;
    try {
      directory = await mkdtemp(join(tmpdir(), 'streamtube-video-'));
      const original = join(directory, 'original');
      const thumbnail = join(directory, 'thumbnail.jpg');
      await pipeline(
        await this.storage.openOriginal(video.originalKey),
        createWriteStream(original),
      );
      const { stdout } = await ffmpegCommand('ffprobe', [
        '-v',
        'error',
        '-protocol_whitelist',
        'file',
        '-show_entries',
        'format=duration,format_name:stream=index,codec_type,codec_name,width,height,duration:stream_disposition=attached_pic',
        '-of',
        'json',
        original,
      ]);
      const probe = JSON.parse(stdout) as ProbeResult;
      const videoStream = probe.streams?.find(
        (stream) =>
          stream.codec_type === 'video' && !stream.disposition?.attached_pic,
      );
      if (!videoStream) {
        throw new InvalidMedia();
      }
      const audioStream = probe.streams?.find(
        (stream) => stream.codec_type === 'audio',
      );
      const durationSeconds =
        [probe.format?.duration, videoStream.duration]
          .map(Number)
          .find((seconds) => Number.isFinite(seconds) && seconds >= 0) ?? null;

      await ffmpegCommand('ffmpeg', [
        '-v',
        'error',
        '-nostdin',
        '-protocol_whitelist',
        'file',
        '-i',
        original,
        '-map',
        `0:${videoStream.index}`,
        '-frames:v',
        '1',
        '-vf',
        "scale='min(640,iw)':'min(360,ih)':force_original_aspect_ratio=decrease",
        '-threads',
        '1',
        thumbnail,
      ]);
      const image = await readFile(thumbnail).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') {
            throw new InvalidMedia();
          }
          throw error;
        },
      );
      const thumbnailKey = await this.storage.putThumbnail(videoId, image);

      await videos.update(
        { id: videoId, status: VideoStatus.Processing },
        {
          status: VideoStatus.Ready,
          durationSeconds,
          metadata: {
            format: probe.format?.format_name ?? null,
            videoCodec: videoStream.codec_name ?? null,
            audioCodec: audioStream?.codec_name ?? null,
            width: videoStream.width ?? null,
            height: videoStream.height ?? null,
          },
          thumbnailKey,
        },
      );
    } catch (error) {
      if (error instanceof InvalidMedia) {
        await videos.update(
          { id: videoId, status: VideoStatus.Processing },
          {
            status: VideoStatus.Error,
            failureCode: 'INVALID_MEDIA',
          },
        );
        return;
      }
      throw new Error('Video processing failed');
    } finally {
      if (directory) {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
}
