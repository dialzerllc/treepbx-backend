import { describe, expect, test } from 'bun:test';
import { applyCidStrategy, npaOf } from '../esl/caller-id-strategy';

describe('npaOf', () => {
  test('strips leading 1 for E.164 US/Canada numbers', () => {
    expect(npaOf('+15551234567')).toBe('555');
    expect(npaOf('15551234567')).toBe('555');
    expect(npaOf('+1 (555) 123-4567')).toBe('555');
  });

  test('handles bare 10-digit US numbers', () => {
    expect(npaOf('5551234567')).toBe('555');
    expect(npaOf('555-123-4567')).toBe('555');
  });

  test('strips formatting characters', () => {
    expect(npaOf('+1 (212) 555-0100')).toBe('212');
    expect(npaOf('212.555.0100')).toBe('212');
  });

  test('returns first 3 digits for non-US/Canada numbers (best-effort)', () => {
    // +44 20 7946 0958 → digits "442079460958", doesn't start with 1, slice(0,3) = "442"
    expect(npaOf('+442079460958')).toBe('442');
  });
});

describe('applyCidStrategy', () => {
  const candidates = [
    { number: '+12125551001', label: 'NY' },
    { number: '+13055552002', label: 'FL' },
    { number: '+14155553003', label: 'CA' },
  ];

  test('returns null on empty candidates', () => {
    expect(applyCidStrategy([], 'fixed', null)).toBeNull();
    expect(applyCidStrategy([], 'random', '+15551234567')).toBeNull();
  });

  test('returns single candidate regardless of strategy', () => {
    const one = [{ number: '+15551234567' }];
    expect(applyCidStrategy(one, 'fixed', null)).toBe(one[0]);
    expect(applyCidStrategy(one, 'random', null)).toBe(one[0]);
    expect(applyCidStrategy(one, 'local_match', '+19998887777')).toBe(one[0]);
  });

  describe('fixed strategy', () => {
    test('always picks first candidate', () => {
      expect(applyCidStrategy(candidates, 'fixed', null)).toBe(candidates[0]);
      expect(applyCidStrategy(candidates, 'fixed', '+14155551111')).toBe(candidates[0]);
    });
  });

  describe('random strategy', () => {
    test('returns one of the candidates', () => {
      for (let i = 0; i < 50; i++) {
        const picked = applyCidStrategy(candidates, 'random', null);
        expect(candidates).toContain(picked!);
      }
    });

    test('eventually picks every candidate across many calls', () => {
      // Statistical sanity: across 200 picks of 3 candidates, every one
      // should turn up at least once. Probability of missing any single
      // candidate is (2/3)^200 ≈ 10^-35, so this is not flaky.
      const seen = new Set<string>();
      for (let i = 0; i < 200; i++) {
        seen.add(applyCidStrategy(candidates, 'random', null)!.number);
      }
      expect(seen.size).toBe(3);
    });
  });

  describe('local_match strategy', () => {
    test('picks the DID with the matching area code', () => {
      // +13055551111 → NPA 305 → matches the FL DID.
      expect(applyCidStrategy(candidates, 'local_match', '+13055551111')).toBe(candidates[1]);
      // +14155551111 → NPA 415 → matches the CA DID.
      expect(applyCidStrategy(candidates, 'local_match', '+14155551111')).toBe(candidates[2]);
    });

    test('falls back to first candidate when no NPA match', () => {
      // +19998887777 → NPA 999 → no match, fallback to first.
      expect(applyCidStrategy(candidates, 'local_match', '+19998887777')).toBe(candidates[0]);
    });

    test('falls back to first candidate when dialedNumber is null', () => {
      expect(applyCidStrategy(candidates, 'local_match', null)).toBe(candidates[0]);
    });
  });

  describe('round_robin and sequential', () => {
    test('collapse to first candidate at this stateless layer (rotation is caller state)', () => {
      // applyCidStrategy is stateless — real rotation between consecutive
      // calls is the caller's responsibility. Here we verify the labels
      // don't crash and return a candidate.
      expect(applyCidStrategy(candidates, 'round_robin', null)).toBe(candidates[0]);
      expect(applyCidStrategy(candidates, 'sequential', null)).toBe(candidates[0]);
    });
  });

  describe('unknown strategy', () => {
    test('falls back to fixed rather than throwing', () => {
      expect(applyCidStrategy(candidates, 'nonexistent_strategy', null)).toBe(candidates[0]);
      expect(applyCidStrategy(candidates, '', null)).toBe(candidates[0]);
    });
  });
});
