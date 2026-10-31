import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeReportedLocalPath } from '../../src/main/security/localPath';

describe('normalizeReportedLocalPath', () => {
  it.runIf(process.platform === 'win32')('normalizes Windows-native, Git Bash, WSL, file URL, and UNC spellings', () => {
    expect(normalizeReportedLocalPath('C:/Users/fixture-user/result.txt')).toBe('C:\\Users\\fixture-user\\result.txt');
    expect(normalizeReportedLocalPath('/c/Users/fixture-user/result.txt')).toBe('C:\\Users\\fixture-user\\result.txt');
    expect(normalizeReportedLocalPath('/mnt/c/Users/fixture-user/result.txt')).toBe('C:\\Users\\fixture-user\\result.txt');
    expect(normalizeReportedLocalPath('file:///C:/Users/fixture-user/result.txt')).toBe('C:\\Users\\fixture-user\\result.txt');
    expect(normalizeReportedLocalPath('//server/share/result.txt')).toBe('\\\\server\\share\\result.txt');
  });

  it('resolves relative paths against the supplied base directory', () => {
    expect(normalizeReportedLocalPath('nested/result.txt', path.resolve('workspace'))).toBe(path.resolve('workspace', 'nested/result.txt'));
  });
});
