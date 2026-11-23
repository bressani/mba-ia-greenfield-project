import { Test } from '@nestjs/testing';
import { DataSource, FindOneOptions, QueryFailedError } from 'typeorm';
import { ChannelsService } from './channels.service';
import { Channel } from './entities/channel.entity';

function makeManager() {
  return {
    findOne: jest.fn<
      Promise<Channel | null>,
      [typeof Channel, FindOneOptions<Channel>]
    >(),
    create: jest.fn<Channel, [typeof Channel, Partial<Channel>]>(),
    save: jest.fn<Promise<Channel>, [Channel]>(),
  };
}

function makeChannel(nickname: string): Channel {
  const c = new Channel();
  c.id = 'uuid';
  c.nickname = nickname;
  c.name = nickname;
  c.user_id = 'user-id';
  c.description = null;
  c.created_at = new Date();
  c.updated_at = new Date();
  return c;
}

function makeUniqueError(): QueryFailedError {
  const driverError = Object.assign(new Error(), {
    code: '23505',
    detail: 'Key (nickname)=(abc) already exists.',
  });
  return new QueryFailedError('INSERT', [], driverError);
}

describe('ChannelsService', () => {
  let manager: ReturnType<typeof makeManager>;
  let service: ChannelsService;

  beforeEach(async () => {
    manager = makeManager();
    const module = await Test.createTestingModule({
      providers: [
        ChannelsService,
        {
          provide: DataSource,
          useValue: {
            transaction: <T>(callback: (mock: typeof manager) => Promise<T>) =>
              callback(manager),
          },
        },
      ],
    }).compile();
    service = module.get(ChannelsService);
  });

  describe('createChannel', () => {
    it('derives nickname from email prefix and saves when no collision', async () => {
      const channel = makeChannel('test');
      manager.findOne.mockResolvedValue(null);
      manager.create.mockReturnValue(channel);
      manager.save.mockResolvedValue(channel);

      const result = await service.createChannel('user-id', 'test@example.com');

      expect(manager.findOne).toHaveBeenCalledWith(Channel, {
        where: { nickname: 'test' },
      });
      expect(manager.save).toHaveBeenCalledTimes(1);
      expect(result.nickname).toBe('test');
    });

    it('retries with suffix when pre-check finds existing nickname', async () => {
      const colliding = makeChannel('john');
      const resolved = makeChannel('john_abc');
      manager.findOne
        .mockResolvedValueOnce(colliding)
        .mockResolvedValueOnce(null);
      manager.create.mockReturnValue(resolved);
      manager.save.mockResolvedValue(resolved);

      const result = await service.createChannel('user-id', 'john@example.com');

      expect(manager.findOne).toHaveBeenCalledTimes(2);
      expect(manager.save).toHaveBeenCalledTimes(1);
      expect(result.nickname).toMatch(/^john_[a-z0-9]{3}$/);
    });

    it('retries with suffix on concurrent unique constraint violation', async () => {
      const resolved = makeChannel('alice_abc');
      manager.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      manager.create.mockReturnValue(resolved);
      manager.save
        .mockRejectedValueOnce(makeUniqueError())
        .mockResolvedValueOnce(resolved);

      const result = await service.createChannel(
        'user-id',
        'alice@example.com',
      );

      expect(manager.save).toHaveBeenCalledTimes(2);
      expect(result.nickname).toMatch(/^alice/);
    });

    it('throws after exhausting max retries', async () => {
      const existing = makeChannel('bob');
      manager.findOne.mockResolvedValue(existing);

      await expect(
        service.createChannel('user-id', 'bob@example.com'),
      ).rejects.toThrow(
        'Nickname conflict could not be resolved after max retries',
      );
    });

    it('re-throws non-unique-constraint errors immediately', async () => {
      const unexpectedError = new Error('Connection lost');
      const channel = makeChannel('carol');
      manager.findOne.mockResolvedValue(null);
      manager.create.mockReturnValue(channel);
      manager.save.mockRejectedValue(unexpectedError);

      await expect(
        service.createChannel('user-id', 'carol@example.com'),
      ).rejects.toThrow('Connection lost');
      expect(manager.save).toHaveBeenCalledTimes(1);
    });
  });
});
