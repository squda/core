import { describe, expect, it } from 'vitest';
import { Logger } from '../src/log.js';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const logger = new Logger(
    {},
    {
      level: 'debug',
      write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
      now: () => new Date('2026-08-14T12:00:00Z'),
    },
  );
  return { logger, lines };
}

describe('Logger', () => {
  it('writes one json object per line', () => {
    const { logger, lines } = capture();

    logger.info('scraped', { url: 'https://a.test/' });

    expect(lines[0]).toEqual({
      at: '2026-08-14T12:00:00.000Z',
      level: 'info',
      message: 'scraped',
      url: 'https://a.test/',
    });
  });

  // The point of the whole file: a request id set once appears on every line
  // written downstream, without a single function passing it along.
  it('stamps a child’s fields on everything it writes', () => {
    const { logger, lines } = capture();
    const request = logger.child({ requestId: 'abc' });

    request.info('started');
    request.child({ jobId: 'job-1' }).warn('slow');

    expect(lines[0]).toMatchObject({ requestId: 'abc', message: 'started' });
    expect(lines[1]).toMatchObject({ requestId: 'abc', jobId: 'job-1', level: 'warn' });
  });

  it('lets a call add fields without polluting the logger', () => {
    const { logger, lines } = capture();
    const request = logger.child({ requestId: 'abc' });

    request.info('one', { extra: 1 });
    request.info('two');

    expect(lines[0]).toMatchObject({ extra: 1 });
    expect(lines[1]).not.toHaveProperty('extra');
  });

  it('drops anything below its level', () => {
    const lines: string[] = [];
    const logger = new Logger({}, { level: 'warn', write: (line) => lines.push(line) });

    logger.debug('nope');
    logger.info('also nope');
    logger.warn('yes');
    logger.error('yes');

    expect(lines).toHaveLength(2);
  });

  it('can be passed around as a bare function', () => {
    const { logger, lines } = capture();
    const emit = logger.child({ requestId: 'abc' }).info;

    emit('detached');

    expect(lines[0]).toMatchObject({ requestId: 'abc', message: 'detached' });
  });
});
