import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { MAX_VIDEO_BYTES, MAX_VIDEO_PARTS } from './video.constants';
import { VideoStatus } from './video.entity';
import type { VideoMetadata } from './video.entity';

export class StartVideoDto {
  @ApiProperty({ minLength: 1, maxLength: 255, example: 'My first video' })
  @IsString()
  @MaxLength(255)
  @Matches(/^(?=.*\S)[^\p{Cc}]+$/u)
  title: string;

  @ApiProperty({ minLength: 1, maxLength: 255, example: 'video.mp4' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  @Matches(/^[^\p{Cc}]+$/u)
  filename: string;

  @ApiProperty({ maxLength: 127, example: 'video/mp4' })
  @IsString()
  @MaxLength(127)
  @Matches(/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/)
  contentType: string;

  @ApiProperty({ type: 'integer', minimum: 1, maximum: MAX_VIDEO_BYTES })
  @IsInt()
  @Min(1)
  @Max(MAX_VIDEO_BYTES)
  sizeBytes: number;
}

export class SignVideoPartsDto {
  @ApiProperty({
    type: 'array',
    items: { type: 'integer', minimum: 1, maximum: MAX_VIDEO_PARTS },
    uniqueItems: true,
    minItems: 1,
    example: [1, 2],
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @ArrayMaxSize(MAX_VIDEO_PARTS)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(MAX_VIDEO_PARTS, { each: true })
  partNumbers: number[];
}

export class VideoLinksDto {
  @ApiProperty({ format: 'uri', description: 'Temporary thumbnail URL' })
  thumbnail: string;

  @ApiProperty({
    format: 'uri',
    description: 'Temporary original URL supporting Range',
  })
  playback: string;

  @ApiProperty({
    format: 'uri',
    description: 'Temporary original URL with attachment disposition',
  })
  download: string;
}

export class VideoDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ description: 'Stable owner-only API path' })
  url: string;

  @ApiProperty()
  title: string;

  @ApiProperty()
  filename: string;

  @ApiProperty()
  contentType: string;

  @ApiProperty({ type: 'integer' })
  sizeBytes: number;

  @ApiProperty({ type: 'integer' })
  partSizeBytes: number;

  @ApiProperty({ enum: VideoStatus })
  status: VideoStatus;

  @ApiProperty({ type: 'number', nullable: true })
  durationSeconds: number | null;

  @ApiProperty({
    type: 'object',
    nullable: true,
    properties: {
      format: { type: 'string', nullable: true },
      width: { type: 'integer', nullable: true },
      height: { type: 'integer', nullable: true },
      videoCodec: { type: 'string', nullable: true },
      audioCodec: { type: 'string', nullable: true },
    },
  })
  metadata: VideoMetadata | null;

  @ApiProperty({ type: 'string', nullable: true })
  failureCode: string | null;

  @ApiProperty({ type: 'string', format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: 'string', format: 'date-time' })
  updatedAt: Date;

  @ApiPropertyOptional({ type: VideoLinksDto })
  links?: VideoLinksDto;
}

export class VideoPartDto {
  @ApiProperty({ type: 'integer' })
  partNumber: number;

  @ApiProperty({ type: 'integer' })
  sizeBytes: number;
}

class SignedVideoPartDto extends VideoPartDto {
  @ApiProperty({
    format: 'uri',
    description: 'Temporary PUT URL. Send exactly sizeBytes bytes.',
  })
  url: string;
}

export class SignedVideoPartsDto {
  @ApiProperty({ type: [SignedVideoPartDto] })
  parts: SignedVideoPartDto[];
}

export class VideoUploadDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ type: 'integer' })
  sizeBytes: number;

  @ApiProperty({ type: 'integer' })
  partSizeBytes: number;

  @ApiProperty({ type: 'integer' })
  partCount: number;

  @ApiProperty({ type: [VideoPartDto] })
  parts: VideoPartDto[];
}
