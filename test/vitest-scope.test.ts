import { describe, it, expect, afterEach } from 'vitest';
import { makeTempRepo, writeRepoFile } from './helpers.js';
import { mirrorSpecOf, pickVitestScope } from '../src/verify/vitest-scope.js';

let cleanups: Array<() => void> = [];
afterEach(() => { cleanups.forEach((c) => c()); cleanups = []; });

function setup() {
  const { dir, cleanup } = makeTempRepo(); cleanups.push(cleanup);
  return dir;
}

describe('mirrorSpecOf', () => {
  const specs = [
    'app/javascript/dashboard/helper/specs/URLHelper.spec.js',
    'app/javascript/dashboard/store/modules/contacts/specs/actions.spec.js',
    'app/javascript/dashboard/store/modules/labels/specs/actions.spec.js',
    'app/javascript/widget/store/spec/actions.spec.js',
  ];

  it('basename match regardless of specs/ nesting level', () => {
    expect(mirrorSpecOf('app/javascript/dashboard/helper/URLHelper.js', specs))
      .toBe('app/javascript/dashboard/helper/specs/URLHelper.spec.js');
  });

  it('collision resolved by longest common dir prefix', () => {
    expect(mirrorSpecOf('app/javascript/dashboard/store/modules/labels/actions.js', specs))
      .toBe('app/javascript/dashboard/store/modules/labels/specs/actions.spec.js');
    expect(mirrorSpecOf('app/javascript/widget/store/actions.js', specs))
      .toBe('app/javascript/widget/store/spec/actions.spec.js');
  });

  it('tie broken alphabetically (determinism)', () => {
    expect(mirrorSpecOf('app/javascript/other/actions.js', specs))
      .toBe('app/javascript/dashboard/store/modules/contacts/specs/actions.spec.js');
  });

  it('vue source maps to its spec.js mirror', () => {
    const s = ['app/javascript/widget/components/specs/App.spec.js'];
    expect(mirrorSpecOf('app/javascript/widget/components/App.vue', s)).toBe(s[0]);
  });

  it('no candidate → null', () => {
    expect(mirrorSpecOf('app/javascript/nowhere/Thing.js', specs)).toBeNull();
  });
});

describe('pickVitestScope', () => {
  it('mirror + reference-scan hits merged', () => {
    const dir = setup();
    writeRepoFile(dir, 'app/javascript/helper/url.js', 'export const make = () => 1;');
    writeRepoFile(dir, 'app/javascript/helper/specs/url.spec.js', "import { make } from '../url';");
    writeRepoFile(dir, 'app/javascript/other/specs/nav.spec.js', "import url from 'helper/url';");
    writeRepoFile(dir, 'app/javascript/other/specs/pure.spec.js', 'no reference here');
    const scope = pickVitestScope(dir, 'app/javascript/helper/url.js', 20)!;
    expect(scope.specFiles).toEqual([
      'app/javascript/helper/specs/url.spec.js',
      'app/javascript/other/specs/nav.spec.js',
    ]);
    expect(scope.scanNote).toMatch(/命中 1 个/);
  });

  it('scan over limit → mirror-only with explicit note', () => {
    const dir = setup();
    writeRepoFile(dir, 'app/javascript/helper/hot.js', 'export const hot = 1;');
    writeRepoFile(dir, 'app/javascript/helper/specs/hot.spec.js', 'hot');
    for (let i = 0; i < 4; i++) writeRepoFile(dir, `app/javascript/x/specs/s${i}.spec.js`, 'uses hot here');
    const scope = pickVitestScope(dir, 'app/javascript/helper/hot.js', 3)!;
    expect(scope.specFiles).toEqual(['app/javascript/helper/specs/hot.spec.js']);
    expect(scope.scanNote).toMatch(/超上限/);
  });

  it('over limit AND no mirror → null; both empty → null', () => {
    const dir = setup();
    writeRepoFile(dir, 'app/javascript/helper/wide.js', 'export const wide = 1;');
    for (let i = 0; i < 4; i++) writeRepoFile(dir, `app/javascript/x/specs/w${i}.spec.js`, 'wide everywhere');
    expect(pickVitestScope(dir, 'app/javascript/helper/wide.js', 3)).toBeNull();
    writeRepoFile(dir, 'app/javascript/helper/lonely.js', 'export const lonely = 1;');
    expect(pickVitestScope(dir, 'app/javascript/helper/lonely.js', 20)).toBeNull();
  });

  it('word boundary: basename "url" does not match "curl" in spec content', () => {
    const dir = setup();
    writeRepoFile(dir, 'app/javascript/helper/url.js', 'export const make = () => 1;');
    writeRepoFile(dir, 'app/javascript/helper/specs/url.spec.js', 'mirror');
    writeRepoFile(dir, 'app/javascript/x/specs/net.spec.js', 'const c = curl();');
    const scope = pickVitestScope(dir, 'app/javascript/helper/url.js', 20)!;
    expect(scope.specFiles).toEqual(['app/javascript/helper/specs/url.spec.js']);
    expect(scope.scanNote).toMatch(/零命中/);
  });

  it('walkSpecs ignores decoy specs inside node_modules/.git', () => {
    const dir = setup();
    writeRepoFile(dir, 'app/javascript/a/specs/real.spec.js', 'x');
    writeRepoFile(dir, 'node_modules/pkg/real.spec.js', 'uses real here');
    writeRepoFile(dir, '.git/hooks/real.spec.js', 'uses real here');
    writeRepoFile(dir, 'app/javascript/b/decoy.test.js', 'x');
    const scope = pickVitestScope(dir, 'app/javascript/a/real.js', 20)!;
    expect(scope.specFiles).toEqual(['app/javascript/a/specs/real.spec.js']);
  });

  it('.test.js mirror works end to end', () => {
    const dir = setup();
    writeRepoFile(dir, 'app/javascript/a/thing.js', 'export const t = 1;');
    writeRepoFile(dir, 'app/javascript/a/__tests__/thing.test.js', 'mirror');
    const scope = pickVitestScope(dir, 'app/javascript/a/thing.js', 20)!;
    expect(scope.specFiles).toEqual(['app/javascript/a/__tests__/thing.test.js']);
  });

  it('hits exactly at scanLimit: merged, no fallback', () => {
    const dir = setup();
    writeRepoFile(dir, 'app/javascript/a/edge.js', 'export const e = 1;');
    writeRepoFile(dir, 'app/javascript/a/specs/edge.spec.js', 'mirror');
    for (let i = 0; i < 3; i++) writeRepoFile(dir, `app/javascript/x/specs/e${i}.spec.js`, 'edge used');
    const scope = pickVitestScope(dir, 'app/javascript/a/edge.js', 3)!;
    expect(scope.specFiles).toHaveLength(4);
    expect(scope.scanNote).toMatch(/命中 3 个/);
  });
});
