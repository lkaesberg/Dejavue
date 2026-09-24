import { describe, expect, it } from 'vitest';
import { jsonForScript } from './jsonScript';

describe('jsonForScript', () => {
  it('cannot close the script element, and still parses back to the same value', () => {
    const value = { t: '</script><script>alert(1)</script>', amp: 'a & b', ls: 'x\u2028y\u2029z' };
    const json = jsonForScript(value);
    expect(json).not.toMatch(/[<>&\u2028\u2029]/);
    expect(JSON.parse(json)).toEqual(value);
  });
});
