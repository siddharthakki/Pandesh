import { describe, expect, it } from 'vitest';
import { retryTransientTaskStoreWrite } from '../../services/TaskStoreWriteBarrier';

function errorWithCode(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

describe('task-store transient write retry', () => {
  it('retries transient Windows filesystem failures and preserves the result', async () => {
    let attempts = 0;
    const delays: number[] = [];

    const result = await retryTransientTaskStoreWrite(async () => {
      attempts += 1;
      if (attempts < 3) throw errorWithCode('EPERM');
      return 'persisted';
    }, {
      maxAttempts: 5,
      baseDelayMs: 4,
      sleep: async delayMs => { delays.push(delayMs); },
    });

    expect(result).toBe('persisted');
    expect(attempts).toBe(3);
    expect(delays).toEqual([4, 8]);
  });

  it('does not retry non-transient failures', async () => {
    let attempts = 0;

    await expect(retryTransientTaskStoreWrite(async () => {
      attempts += 1;
      throw errorWithCode('ENOSPC');
    }, {
      maxAttempts: 5,
      sleep: async () => undefined,
    })).rejects.toMatchObject({ code: 'ENOSPC' });

    expect(attempts).toBe(1);
  });

  it('stops after the configured retry limit', async () => {
    let attempts = 0;

    await expect(retryTransientTaskStoreWrite(async () => {
      attempts += 1;
      throw errorWithCode('EBUSY');
    }, {
      maxAttempts: 3,
      sleep: async () => undefined,
    })).rejects.toMatchObject({ code: 'EBUSY' });

    expect(attempts).toBe(3);
  });
});
