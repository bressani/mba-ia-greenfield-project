import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExtraModels,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { Response } from 'express';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import {
  SignedVideoPartsDto,
  SignVideoPartsDto,
  StartVideoDto,
  VideoDto,
  VideoUploadDto,
} from './video.dto';
import { VideosService } from './videos.service';

const videoError = (status: number, description: string) =>
  ApiResponse({
    status,
    description,
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  });

@ApiTags('videos')
@ApiBearerAuth('access-token')
@ApiExtraModels(ApiErrorEnvelope)
@videoError(401, 'Missing or invalid access token')
@Controller('videos')
export class VideosController {
  constructor(private readonly videos: VideosService) {}

  @Post()
  @ApiOperation({
    summary: 'Start a video upload',
    description: 'Creates a private draft and its multipart upload session.',
  })
  @ApiResponse({
    status: 201,
    type: VideoDto,
    description: 'Video draft created',
    headers: {
      Location: {
        description: 'Path to the owned video',
        schema: { type: 'string' },
      },
    },
  })
  @videoError(400, 'Invalid upload details')
  @videoError(404, 'The authenticated user has no channel')
  @videoError(503, 'Video storage unavailable')
  async start(
    @CurrentUser() user: JwtPayload,
    @Body() input: StartVideoDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const video = await this.videos.start(user.sub, input);
    response.location(video.url);
    return video;
  }

  @Get(':id')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Get an owned video',
    description: 'Returns processing status and temporary links when ready.',
  })
  @ApiResponse({ status: 200, type: VideoDto, description: 'Owned video' })
  @videoError(400, 'Invalid video ID')
  @videoError(404, 'Video not found')
  @videoError(503, 'Video storage unavailable')
  get(
    @CurrentUser() user: JwtPayload,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.videos.get(user.sub, id);
  }

  @Get(':id/upload')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Get multipart upload progress',
    description:
      'Lists parts already stored so an interrupted upload can resume.',
  })
  @ApiResponse({
    status: 200,
    type: VideoUploadDto,
    description: 'Multipart progress',
  })
  @videoError(400, 'Invalid video ID')
  @videoError(404, 'Video not found')
  @videoError(409, 'Video has no resumable draft upload')
  @videoError(503, 'Video storage unavailable')
  getUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.videos.getUpload(user.sub, id);
  }

  @Post(':id/upload/parts')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Sign multipart upload parts',
    description:
      'Issues temporary PUT URLs with an exact byte length for each requested part.',
  })
  @ApiResponse({
    status: 200,
    type: SignedVideoPartsDto,
    description: 'Temporary part URLs',
  })
  @videoError(400, 'Invalid video ID or part numbers')
  @videoError(404, 'Video not found')
  @videoError(409, 'Video has no draft upload')
  @videoError(503, 'Video storage unavailable')
  signParts(
    @CurrentUser() user: JwtPayload,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() input: SignVideoPartsDto,
  ) {
    return this.videos.signParts(user.sub, id, input.partNumbers);
  }

  @Post(':id/upload/complete')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Complete a video upload',
    description:
      'Validates stored parts and requests processing once. Repeat calls return the current status.',
  })
  @ApiResponse({
    status: 202,
    type: VideoDto,
    description: 'Upload confirmed and current video state returned',
  })
  @videoError(400, 'Invalid video ID')
  @videoError(404, 'Video not found')
  @videoError(409, 'Multipart upload incomplete, mismatched or unavailable')
  @videoError(503, 'Video storage or processing queue unavailable')
  complete(
    @CurrentUser() user: JwtPayload,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.videos.complete(user.sub, id);
  }
}
