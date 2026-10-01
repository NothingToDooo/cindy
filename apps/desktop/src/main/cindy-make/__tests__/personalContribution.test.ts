import { describe, expect, it, vi } from 'vitest';
import {
  PersonalContribution,
  contributionBody,
  parseContributionStore,
  type ContributionDeps,
  type ContributionRecord,
} from '../personalContribution';

const TOKEN = 'gho_fake-token-for-tests';
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const record = (runId: string, number: number): ContributionRecord => ({
  runId,
  number,
  url: `https://github.com/makecindy/cindy/pull/${number}`,
  branch: `cindy-make-pr/${runId}`,
  commit: A,
  submittedAt: 1,
});

function harness(overrides: Partial<ContributionDeps> = {}) {
  let store: Record<string, ContributionRecord> = {};
  const deps: ContributionDeps = {
    source: 'source',
    binding: () => ({ schema: 1, choice: 'github', login: 'octo', repository: 'octo/cindy' }),
    identity: async () => ({ status: 'connected', identity: { login: 'octo', token: TOKEN } }),
    git: vi.fn(async (args: string[]) => {
      if (args[0] === 'diff') return ['apps/desktop/src/renderer/x.tsx', 'docs/a.md'].join('\0');
      throw new Error('unexpected git ' + args.join(' '));
    }),
    change: (runId) =>
      runId === 'run'
        ? { title: '加一个按钮', request: '我想要按钮', baseTree: A, tree: B }
        : undefined,
    readStore: () => structuredClone(store),
    writeStore: (next) => {
      store = structuredClone(next);
    },
    fetch: vi.fn(async () => new Response('{}', { status: 404 })) as unknown as typeof fetch,
    gitIdentity: async () => ({}),
    withSourceUse: (run) => run(),
    now: () => 10_000,
    ...overrides,
  };
  return {
    contribution: new PersonalContribution(deps),
    deps,
    setStore: (next: typeof store) => (store = next),
  };
}

describe('parseContributionStore', () => {
  it('keeps only well-formed records pointing at official pull requests', () => {
    expect(
      parseContributionStore(
        JSON.stringify({
          good: record('good', 3),
          wrong: { ...record('wrong', 4), url: 'https://example.com/pull/4' },
          mismatch: record('other', 5),
        }),
      ),
    ).toEqual({ good: record('good', 3) });
    expect(parseContributionStore('nope')).toEqual({});
    expect(parseContributionStore(null)).toEqual({});
  });
});

describe('contributionBody', () => {
  it('follows the PR template and asks for the design basis only for UI changes', () => {
    const ui = contributionBody({
      title: 'feat: x',
      request: '需求',
      files: ['a.css'],
      touchesUi: true,
    });
    for (const heading of ['## 这次改了什么', '## 怎么验证的', '## 风险', '### 提交前检查'])
      expect(ui).toContain(heading);
    expect(ui).toContain('- [x] `feat` 新功能');
    expect(ui).toContain('引用的设计规范：docs/design-rules/DESIGN.md');
    expect(
      contributionBody({ title: 'fix: y', request: '', files: ['a.ts'], touchesUi: false }),
    ).toContain('引用的设计规范：不涉及：');
  });
});

describe('PersonalContribution', () => {
  it('prefills a draft with the author identity from the GitHub profile when Git has none', async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(JSON.stringify({ name: 'Octo Cat', email: 'octo@example.com' }), {
          status: 200,
        }),
    );
    const { contribution } = harness({ fetch: fetchFn as unknown as typeof fetch });
    await expect(contribution.draft('run')).resolves.toMatchObject({
      title: 'feat: 加一个按钮',
      name: 'Octo Cat',
      email: 'octo@example.com',
      touchesUi: true,
      files: ['apps/desktop/src/renderer/x.tsx', 'docs/a.md'],
      repository: 'octo/cindy',
    });
  });

  it('tells the draft whether the earlier pull request is still open', async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith('/pulls/3')
        ? new Response(JSON.stringify({ state: 'closed', merged_at: null }), { status: 200 })
        : new Response('{}', { status: 404 }),
    );
    const { contribution, setStore } = harness({ fetch: fetchFn as unknown as typeof fetch });
    setStore({ run: record('run', 3) });
    await expect(contribution.draft('run')).resolves.toMatchObject({
      existing: { number: 3, state: 'closed' },
    });
  });

  it('leaves the email for the author to fill in rather than inventing one', async () => {
    const { contribution } = harness();
    await expect(contribution.draft('run')).resolves.toMatchObject({ name: 'octo', email: '' });
  });

  it.each([
    ['notBound', { binding: () => ({ schema: 1 as const }) }],
    ['github', { identity: async () => ({ status: 'missing' as const }) }],
    [
      'account',
      {
        identity: async () => ({
          status: 'connected' as const,
          identity: { login: 'someone', token: TOKEN },
        }),
      },
    ],
    ['unavailable', { change: () => undefined }],
    ['empty', { change: () => ({ title: 't', request: 'r', baseTree: A, tree: A }) }],
  ])('refuses a draft when %s', async (code, overrides) => {
    await expect(harness(overrides).contribution.draft('run')).rejects.toMatchObject({ code });
  });

  it('validates the confirmed fields before touching Git or GitHub', async () => {
    const { contribution, deps } = harness();
    for (const input of [
      { title: '', body: '', name: 'Ada', email: 'ada@example.com' },
      { title: 'feat: x', body: '', name: '', email: 'ada@example.com' },
      { title: 'feat: x', body: '', name: 'Ada', email: 'not-an-email' },
      { title: 'feat:\nx', body: '', name: 'Ada', email: 'ada@example.com' },
    ])
      await expect(contribution.submit({ runId: 'run', ...input })).rejects.toMatchObject({
        code: 'invalid',
      });
    expect(deps.git).not.toHaveBeenCalled();
  });

  it('reports pull request states and caches them briefly', async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith('/1')
        ? new Response(JSON.stringify({ state: 'closed', merged_at: '2026-10-01' }), {
            status: 200,
          })
        : String(url).endsWith('/2')
          ? new Response(JSON.stringify({ state: 'closed', merged_at: null }), { status: 200 })
          : new Response(JSON.stringify({ state: 'open' }), { status: 200 }),
    );
    const { contribution, setStore } = harness({ fetch: fetchFn as unknown as typeof fetch });
    setStore({ a: record('a', 1), b: record('b', 2), c: record('c', 3) });
    const states = await contribution.statuses();
    expect(Object.fromEntries(states.map((view) => [view.runId, view.state]))).toEqual({
      a: 'merged',
      b: 'closed',
      c: 'open',
    });
    await contribution.statuses();
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });
});
