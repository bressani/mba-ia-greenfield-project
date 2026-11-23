import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelsModule } from '../channels/channels.module';
import { Video } from './video.entity';
import { VideoQueue } from './video-queue';
import { VideoStorage } from './video-storage';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';

@Module({
  imports: [ChannelsModule, TypeOrmModule.forFeature([Video])],
  controllers: [VideosController],
  providers: [VideosService, VideoStorage, VideoQueue],
  exports: [VideoStorage, VideoQueue],
})
export class VideosModule {}
