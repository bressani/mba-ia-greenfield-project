import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { CreateUsersAndChannels1775687773260 } from './migrations/1775687773260-CreateUsersAndChannels';
import { CreateAuthTokens1777579850478 } from './migrations/1777579850478-CreateAuthTokens';
import { Video } from '../videos/video.entity';
import { CreateVideos1795435209266 } from './migrations/1795435209266-CreateVideos';
import { AddVideoTitle1795435209267 } from './migrations/1795435209267-AddVideoTitle';
import { AddVideoOriginalKey1795435209268 } from './migrations/1795435209268-AddVideoOriginalKey';
import { createTestDataSource } from '../test/create-test-data-source';

const MANAGED_TABLES = [
  'users',
  'channels',
  'refresh_tokens',
  'verification_tokens',
  'videos',
];

describe('Database migrations (integration)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = createTestDataSource(
      [User, Channel, RefreshToken, VerificationToken, Video],
      {
        synchronize: false,
        migrations: [
          CreateUsersAndChannels1775687773260,
          CreateAuthTokens1777579850478,
          CreateVideos1795435209266,
          AddVideoTitle1795435209267,
          AddVideoOriginalKey1795435209268,
        ],
      },
    );

    await dataSource.initialize();

    const tables = [...MANAGED_TABLES, 'migrations'].map(
      (table) => `"${table}"`,
    );
    await dataSource.query(`DROP TABLE IF EXISTS ${tables.join(', ')} CASCADE`);
    await dataSource.query(
      'DROP TYPE IF EXISTS "public"."videos_status_enum", "public"."verification_tokens_type_enum"',
    );
  });

  afterAll(async () => {
    // Re-apply so the shared DB is fully migrated when subsequent suites run.
    await dataSource.runMigrations();
    await dataSource.destroy();
  });

  it('should apply all migrations and create all five tables', async () => {
    const ranMigrations = await dataSource.runMigrations();

    expect(ranMigrations).toHaveLength(5);
    expect(ranMigrations.at(-1)?.name).toBe('AddVideoOriginalKey1795435209268');

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [MANAGED_TABLES],
    );
    const tableNames = result.map((r) => r.table_name);
    expect(tableNames).toEqual([
      'channels',
      'refresh_tokens',
      'users',
      'verification_tokens',
      'videos',
    ]);
  });

  it('should persist a video with a unique URL and a valid channel', async () => {
    const users = dataSource.getRepository(User);
    const channels = dataSource.getRepository(Channel);
    const videos = dataSource.getRepository(Video);
    const user = await users.save(
      users.create({
        email: `${randomUUID()}@example.test`,
        password: 'unused',
      }),
    );

    try {
      const channel = await channels.save(
        channels.create({
          name: 'Migration test channel',
          nickname: `migration-${randomUUID()}`,
          user_id: user.id,
        }),
      );
      const id = randomUUID();
      const draft = {
        id,
        url: `/videos/${id}`,
        channelId: channel.id,
        title: 'A sample video',
        filename: 'sample.mp4',
        contentType: 'video/mp4',
        sizeBytes: 10_000_000_000,
        uploadId: 'session-id',
        originalKey: `videos/${id}/original`,
      };
      await videos.insert(draft);

      expect(await videos.findOneByOrFail({ id })).toMatchObject({
        status: 'draft',
        channelId: channel.id,
        sizeBytes: draft.sizeBytes,
        title: draft.title,
        filename: draft.filename,
        originalKey: draft.originalKey,
      });
      await expect(
        videos.insert({ ...draft, id: randomUUID() }),
      ).rejects.toMatchObject({ code: '23505' });

      const otherId = randomUUID();
      await expect(
        videos.insert({
          ...draft,
          id: otherId,
          url: `/videos/${otherId}`,
          originalKey: undefined,
        }),
      ).rejects.toMatchObject({ code: '23502', column: 'original_key' });
      await expect(
        videos.insert({
          ...draft,
          id: otherId,
          url: `/videos/${otherId}`,
          channelId: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: '23503' });

      await channels.delete(channel.id);
      expect(await videos.findOneBy({ id })).toBeNull();
    } finally {
      await channels.delete({ user_id: user.id });
      await users.delete(user.id);
    }
  });

  it('backfills the title of videos created before the title migration', async () => {
    await dataSource.undoLastMigration();
    await dataSource.undoLastMigration();
    const id = randomUUID();
    const users = dataSource.getRepository(User);
    const channels = dataSource.getRepository(Channel);
    const user = await users.save({
      email: `${id}@example.test`,
      password: 'unused',
    });

    try {
      const channel = await channels.save({
        name: 'Legacy channel',
        nickname: `legacy-${id}`,
        user_id: user.id,
      });
      await dataSource.query(
        `INSERT INTO videos (id, url, channel_id, filename, content_type, size_bytes)
         VALUES ($1, $2, $3, 'legacy.mp4', 'video/mp4', 1)`,
        [id, `/videos/${id}`, channel.id],
      );

      await dataSource.runMigrations();

      const video = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ id });
      expect(video.title).toBe('legacy.mp4');
    } finally {
      await channels.delete({ user_id: user.id });
      await users.delete(user.id);
      await dataSource.runMigrations();
    }
  });

  it('backfills the original key and rolls back without changing existing video data', async () => {
    await dataSource.undoLastMigration();
    const id = randomUUID();
    const originalKey = `videos/${id}/original`;
    const thumbnailKey = `videos/${id}/thumbnail.jpg`;
    const users = dataSource.getRepository(User);
    const channels = dataSource.getRepository(Channel);
    const user = await users.save({
      email: `${id}@example.test`,
      password: 'unused',
    });

    try {
      const channel = await channels.save({
        name: 'Legacy channel',
        nickname: `legacy-${id}`,
        user_id: user.id,
      });
      await dataSource.query(
        `INSERT INTO videos (id, url, channel_id, title, filename, content_type, size_bytes, thumbnail_key)
         VALUES ($1, $2, $3, 'Legacy title', 'legacy.mp4', 'video/mp4', 1, $4)`,
        [id, `/videos/${id}`, channel.id, thumbnailKey],
      );

      await dataSource.runMigrations();
      const videos = dataSource.getRepository(Video);
      expect(await videos.findOneByOrFail({ id })).toMatchObject({
        originalKey,
        thumbnailKey,
        title: 'Legacy title',
        filename: 'legacy.mp4',
      });

      await dataSource.undoLastMigration();
      await expect(
        dataSource.query('SELECT original_key FROM videos WHERE id = $1', [id]),
      ).rejects.toMatchObject({ code: '42703' });
      const rows = await dataSource.query<
        Pick<Video, 'title' | 'filename' | 'thumbnailKey'>[]
      >(
        'SELECT title, filename, thumbnail_key AS "thumbnailKey" FROM videos WHERE id = $1',
        [id],
      );
      expect(rows).toEqual([
        { title: 'Legacy title', filename: 'legacy.mp4', thumbnailKey },
      ]);

      await dataSource.runMigrations();
      expect(await videos.findOneByOrFail({ id })).toMatchObject({
        originalKey,
        thumbnailKey,
      });
    } finally {
      await channels.delete({ user_id: user.id });
      await users.delete(user.id);
      await dataSource.runMigrations();
    }
  });

  it('should revert the video migrations and remove the videos table', async () => {
    await dataSource.undoLastMigration();
    await dataSource.undoLastMigration();
    await dataSource.undoLastMigration();

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])`,
      [['videos']],
    );
    expect(result).toHaveLength(0);
  });
});
