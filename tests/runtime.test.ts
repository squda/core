import { describe, expect, it } from 'vitest';
import { checkNodeVersion, MINIMUM_NODE_MAJOR } from '../src/support/runtime.js';

describe('checkNodeVersion', () => {
  it.each(['22.0.0', '22.23.2', '24.1.0', '30.0.0'])('accepts %s', (version) => {
    expect(checkNodeVersion(version)).toBeNull();
  });

  it.each(['20.19.0', '18.20.8', '16.0.0'])('refuses %s', (version) => {
    expect(checkNodeVersion(version)).toContain(`Node ${MINIMUM_NODE_MAJOR} or newer`);
  });

  // The message has one job: say what to do. A version number alone sends
  // someone reading a stack trace from a package they never imported.
  it('says which version is running and how to change it', () => {
    const message = checkNodeVersion('20.19.0');

    expect(message).toContain('20.19.0');
    expect(message).toContain('nvm use 22');
  });

  it('refuses a version it cannot parse rather than assuming the best', () => {
    expect(checkNodeVersion('not-a-version')).not.toBeNull();
  });
});
