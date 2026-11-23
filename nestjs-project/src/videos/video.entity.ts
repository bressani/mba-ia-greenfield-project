import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { MAX_VIDEO_BYTES } from './video.constants';

export enum VideoStatus {
  Draft = 'draft',
  Processing = 'processing',
  Ready = 'ready',
  Error = 'error',
}

export interface VideoMetadata {
  format: string | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
}

@Entity('videos')
@Check('CHK_videos_size_bytes', `"size_bytes" BETWEEN 1 AND ${MAX_VIDEO_BYTES}`)
export class Video {
  @PrimaryColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 64, unique: true })
  url: string;

  @Index()
  @Column({ name: 'channel_id', type: 'uuid' })
  channelId: string;

  @ManyToOne(() => Channel, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'channel_id' })
  channel: Channel;

  @Column({ type: 'varchar', length: 255 })
  title: string;

  @Column({ type: 'varchar', length: 255 })
  filename: string;

  @Column({ name: 'content_type', type: 'varchar', length: 127 })
  contentType: string;

  @Column({
    name: 'size_bytes',
    type: 'bigint',
    transformer: {
      to: (size: number) => size,
      from: (size: string) => Number(size),
    },
  })
  sizeBytes: number;

  @Column({ name: 'upload_id', type: 'text', nullable: true })
  uploadId: string | null;

  @Column({ name: 'original_key', type: 'text' })
  originalKey: string;

  @Column({ type: 'enum', enum: VideoStatus, default: VideoStatus.Draft })
  status: VideoStatus;

  @Column({ type: 'jsonb', nullable: true })
  metadata: VideoMetadata | null;

  @Column({
    name: 'duration_seconds',
    type: 'double precision',
    nullable: true,
  })
  durationSeconds: number | null;

  @Column({ name: 'thumbnail_key', type: 'text', nullable: true })
  thumbnailKey: string | null;

  @Column({ name: 'failure_code', type: 'varchar', length: 64, nullable: true })
  failureCode: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
