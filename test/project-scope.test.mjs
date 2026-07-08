import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectKeyForCwd, isSubtreeOf, projectMatches } from '../src/util.mjs';

// ADR-33: project-scoped session isolation — the core helpers. "Same folder means same
// project" (Tye, verbatim): projectKeyForCwd derives a PROJECT KEY from a cwd (the git repo
// root, else the cwd itself), never spawning a subprocess (a pure fs walk — hook/statusline-
// latency-safe, works with no `git` on PATH, matches statusline.mjs's own "no spawn"
// contract). isSubtreeOf/projectMatches answer "is this session's project the same as (or
// nested inside) that loop's project" — ADR-5-style, one-way.

test('projectKeyForCwd: a cwd nested inside a git repo resolves to the repo ROOT, regardless of depth', () => {
  const root = mkdtempSync(join(tmpdir(), 'pk-git-'));
  mkdirSync(join(root, '.git'));
  mkdirSync(join(root, 'sub', 'deeper', 'still'), { recursive: true });
  assert.equal(projectKeyForCwd(root), root, 'the repo root itself');
  assert.equal(projectKeyForCwd(join(root, 'sub')), root);
  assert.equal(projectKeyForCwd(join(root, 'sub', 'deeper', 'still')), root, 'arbitrarily deep nesting still resolves to the root');
});

test('projectKeyForCwd: a worktree/submodule `.git` FILE (not a directory) is treated the same as a `.git` dir', () => {
  const root = mkdtempSync(join(tmpdir(), 'pk-worktree-'));
  mkdirSync(root, { recursive: true });
  // a real worktree/submodule .git is a FILE containing "gitdir: <path>" — existsSync doesn't
  // care whether it's a file or a directory, so this must resolve identically to a plain repo.
  writeFileSync(join(root, '.git'), 'gitdir: /elsewhere/.git/worktrees/x\n');
  mkdirSync(join(root, 'sub'), { recursive: true });
  assert.equal(projectKeyForCwd(join(root, 'sub')), root);
});

test('projectKeyForCwd: no `.git` anywhere up the tree → the cwd itself (resolved) is the project key', () => {
  const base = mkdtempSync(join(tmpdir(), 'pk-plain-'));
  const plain = join(base, 'not-a-repo');
  mkdirSync(plain, { recursive: true });
  assert.equal(projectKeyForCwd(plain), plain);
  // a cwd that doesn't even exist on disk still degrades to itself (resolved), never throws
  assert.equal(projectKeyForCwd(join(base, 'does-not-exist')), join(base, 'does-not-exist'));
});

test('projectKeyForCwd: missing/malformed input → null; never throws', () => {
  assert.equal(projectKeyForCwd(''), null);
  assert.equal(projectKeyForCwd(undefined), null);
  assert.equal(projectKeyForCwd(null), null);
  assert.equal(projectKeyForCwd(123), null);
  assert.equal(projectKeyForCwd({}), null);
});

test('isSubtreeOf: same path, nested path, and the ONE-WAY property (ancestor does not inherit a descendant\'s scope)', () => {
  assert.equal(isSubtreeOf('/a/b', '/a/b'), true);
  assert.equal(isSubtreeOf('/a/b/c', '/a/b'), true, 'a is nested inside b');
  assert.equal(isSubtreeOf('/a/b', '/a/b/c'), false, 'the REVERSE direction is not a match (one-way)');
  assert.equal(isSubtreeOf('/a/bx', '/a/b'), false, 'a sibling with a shared PREFIX string is not a subtree');
  assert.equal(isSubtreeOf('/a/b/', '/a/b'), true, 'trailing slashes are stripped before comparing');
});

test('isSubtreeOf: never crashes and never matches on empty/root-stripped input', () => {
  assert.equal(isSubtreeOf('', '/a/b'), false);
  assert.equal(isSubtreeOf('/a/b', ''), false);
  assert.equal(isSubtreeOf('/', '/'), false, "both strip to '' — the empty guard fires before the equality check (never match on '/')");
  assert.equal(isSubtreeOf(null, '/a/b'), false);
  assert.equal(isSubtreeOf('/a/b', undefined), false);
  assert.equal(isSubtreeOf(42, '/a/b'), false);
});

test('projectMatches: same key or subtree → true; mismatched, or either side absent → false', () => {
  assert.equal(projectMatches('/a/b', '/a/b'), true);
  assert.equal(projectMatches('/a/b/c', '/a/b'), true);
  assert.equal(projectMatches('/a/b', '/a/b/c'), false, 'one-way — the loop nested deeper than the session is NOT a match');
  assert.equal(projectMatches('/a/x', '/a/b'), false);
  assert.equal(projectMatches(null, '/a/b'), false);
  assert.equal(projectMatches('/a/b', null), false);
  assert.equal(projectMatches('', ''), false);
});
