import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { camelize, mirrorSpecOf, pickRspecScope } from '../src/verify/rspec-scope.js';

let cleanups: Array<() => void> = [];
afterEach(() => { cleanups.forEach((c) => c()); cleanups = []; });

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ez-rspec-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function write(repo: string, rel: string, content: string): void {
  const p = join(repo, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

describe('camelize / mirrorSpecOf', () => {
  it('camelizes snake_case basenames per Rails convention', () => {
    expect(camelize('contact_identify_action')).toBe('ContactIdentifyAction');
    expect(camelize('user')).toBe('User');
  });
  it('maps app/ files to spec/ mirrors and non-app files under spec/<dir>', () => {
    expect(mirrorSpecOf('app/actions/contact_identify_action.rb')).toBe('spec/actions/contact_identify_action_spec.rb');
    expect(mirrorSpecOf('lib/util.rb')).toBe('spec/lib/util_spec.rb');
  });
});

describe('pickRspecScope', () => {
  it('returns mirror + word-boundary scan hits (sorted), excluding the mirror itself', () => {
    const repo = makeRepo();
    write(repo, 'spec/actions/contact_identify_action_spec.rb', 'describe ContactIdentifyAction do end');
    write(repo, 'spec/services/z_svc_spec.rb', 'x = ContactIdentifyAction.new');
    write(repo, 'spec/services/a_svc_spec.rb', 'y = ContactIdentifyAction.new');
    write(repo, 'spec/models/unrelated_spec.rb', 'ContactIdentifyActionFoo # 词边界不命中');
    const scope = pickRspecScope(repo, 'app/actions/contact_identify_action.rb', 20)!;
    expect(scope.specFiles).toEqual([
      'spec/actions/contact_identify_action_spec.rb',
      'spec/services/a_svc_spec.rb',
      'spec/services/z_svc_spec.rb',
    ]);
    expect(scope.scanNote).toContain('命中 2 个');
  });

  it('falls back to mirror-only when scan hits exceed scanLimit, with explicit note', () => {
    const repo = makeRepo();
    write(repo, 'spec/actions/hot_thing_spec.rb', 'describe HotThing do end');
    for (let i = 0; i < 5; i++) write(repo, `spec/others/h${i}_spec.rb`, 'HotThing.call');
    const scope = pickRspecScope(repo, 'app/actions/hot_thing.rb', 3)!;
    expect(scope.specFiles).toEqual(['spec/actions/hot_thing_spec.rb']);
    expect(scope.scanNote).toContain('超过上限');
    expect(scope.scanNote).toContain('5');
  });

  it('mirror missing but scan hits exist → hits only', () => {
    const repo = makeRepo();
    write(repo, 'spec/services/uses_spec.rb', 'OrphanClass.call');
    const scope = pickRspecScope(repo, 'app/models/orphan_class.rb', 20)!;
    expect(scope.specFiles).toEqual(['spec/services/uses_spec.rb']);
  });

  it('mirror missing and zero hits → null', () => {
    const repo = makeRepo();
    write(repo, 'spec/services/other_spec.rb', 'SomethingElse.call');
    expect(pickRspecScope(repo, 'app/models/ghost_thing.rb', 20)).toBeNull();
  });

  it('overflow without mirror → null (hotspot without a reasonable scope)', () => {
    const repo = makeRepo();
    for (let i = 0; i < 5; i++) write(repo, `spec/others/h${i}_spec.rb`, 'NoMirror.call');
    expect(pickRspecScope(repo, 'app/models/no_mirror.rb', 3)).toBeNull();
  });

  it('repo without spec/ dir → null', () => {
    const repo = makeRepo();
    expect(pickRspecScope(repo, 'app/models/x.rb', 20)).toBeNull();
  });
});
