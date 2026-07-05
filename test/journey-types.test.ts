import { describe, it, expect } from 'vitest';
import type { LearningStep, JourneyPath, Progress } from '../src/types.js';

describe('journey types', () => {
  it('shapes are usable', () => {
    const step: LearningStep = {
      chunkId: 'a.rs', order: 0, chapterId: 'foo:src', difficulty: 0.1, neighbors: ['b.rs'],
    };
    const path: JourneyPath = { repo: '/x', steps: [step] };
    const p: Progress = { version: 1, understood: ['a.rs'] };
    expect(path.steps[0].chunkId).toBe('a.rs');
    expect(p.understood).toContain('a.rs');
  });
});
