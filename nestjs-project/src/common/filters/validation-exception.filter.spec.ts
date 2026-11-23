import { BadRequestException } from '@nestjs/common';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { ValidationExceptionFilter } from './validation-exception.filter';

describe('ValidationExceptionFilter', () => {
  let filter: ValidationExceptionFilter;
  let mockJson: jest.Mock<void, [unknown]>;
  let mockStatus: jest.Mock<{ json: typeof mockJson }, [number]>;
  let mockHost: ExecutionContextHost;

  beforeEach(() => {
    filter = new ValidationExceptionFilter();
    mockJson = jest.fn<void, [unknown]>();
    mockStatus = jest
      .fn<{ json: typeof mockJson }, [number]>()
      .mockReturnValue({ json: mockJson });

    mockHost = new ExecutionContextHost([
      { url: '/test', method: 'POST' },
      { status: mockStatus },
    ]);
  });

  it('normalizes array of class-validator messages', () => {
    const exception = new BadRequestException({
      message: [
        'email must be an email',
        'password must be longer than or equal to 8 characters',
      ],
      error: 'Bad Request',
      statusCode: 400,
    });

    filter.catch(exception, mockHost);

    expect(mockStatus).toHaveBeenCalledWith(400);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 400,
      error: 'VALIDATION_ERROR',
      message: [
        'email must be an email',
        'password must be longer than or equal to 8 characters',
      ],
    });
  });

  it('wraps single string message into array', () => {
    const exception = new BadRequestException({
      message: 'Invalid input',
      error: 'Bad Request',
      statusCode: 400,
    });

    filter.catch(exception, mockHost);

    expect(mockStatus).toHaveBeenCalledWith(400);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 400,
      error: 'VALIDATION_ERROR',
      message: ['Invalid input'],
    });
  });
});
