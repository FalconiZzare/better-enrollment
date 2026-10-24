import { describe, expect, it } from "vitest";
import { createTestAuth, seedAdmin, type TestAuth } from "./helpers";

async function errCode(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    const err = e as { body?: { code?: string } };
    return err.body?.code;
  }
}

/** Public invites with createdAt forced into tied groups. */
async function seedInvites(auth: TestAuth, headers: Headers, instants: number[]) {
  const ctx = await auth.$context;
  const base = Date.UTC(2026, 0, 1);
  const rows: { id: string; createdAt: Date; type: string }[] = [];
  for (const [i, offset] of instants.entries()) {
    const type = i % 3 === 0 ? "private" : "public";
    const res = await auth.api.createInvite({
      body: type === "private" ? { email: `p${i}@list.com` } : { type: "public", maxUses: 1 },
      headers
    });
    const createdAt = new Date(base + offset * 1000);
    await ctx.adapter.update({
      model: "invite",
      where: [{ field: "id", value: res.inviteId }],
      update: { createdAt }
    });
    rows.push({ id: res.inviteId, createdAt, type });
  }
  return rows.sort(
    (a, b) =>
      b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
  );
}

async function walk(
  auth: TestAuth,
  headers: Headers,
  limit: number,
  query: Record<string, string> = {}
) {
  const ids: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const res = await auth.api.listInvites({
      query: { ...query, limit, ...(cursor ? { cursor } : {}) },
      headers
    });
    ids.push(...res.invites.map((i) => i.id));
    cursor = res.nextCursor ?? undefined;
    pages++;
    if (pages > 50) throw new Error("cursor did not terminate");
  } while (cursor);
  return { ids, pages };
}

describe("GET /invite/list keyset cursor", () => {
  it("pages across createdAt ties without gaps or duplicates", async () => {
    const auth = await createTestAuth();
    const headers = await seedAdmin(auth);
    // Three ties at 30s, four at 20s, one at 10s, two at 5s.
    const expected = await seedInvites(auth, headers, [30, 20, 30, 10, 20, 5, 20, 30, 20, 5]);
    const order = expected.map((r) => r.id);

    for (const limit of [1, 2, 3, 4, 7, 10, 11]) {
      const { ids, pages } = await walk(auth, headers, limit);
      expect(ids).toEqual(order);
      expect(pages).toBe(Math.max(1, Math.ceil(order.length / limit)));
    }
  });

  it("applies filters together with the cursor", async () => {
    const auth = await createTestAuth();
    const headers = await seedAdmin(auth);
    const expected = await seedInvites(auth, headers, [3, 3, 3, 2, 2, 1, 1, 1, 1]);
    const publics = expected.filter((r) => r.type === "public").map((r) => r.id);
    const { ids } = await walk(auth, headers, 2, { type: "public" });
    expect(ids).toEqual(publics);
  });

  it("first page carries nextCursor; page keeps offset paging; bad cursors are rejected", async () => {
    const auth = await createTestAuth();
    const headers = await seedAdmin(auth);
    const expected = await seedInvites(auth, headers, [4, 3, 2, 1, 0]);

    const first = await auth.api.listInvites({ query: { limit: 2 }, headers });
    expect(first.invites.map((i) => i.id)).toEqual(expected.slice(0, 2).map((r) => r.id));
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(first.total).toBe(5);

    const third = await auth.api.listInvites({ query: { limit: 2, page: 3 }, headers });
    expect(third.invites.map((i) => i.id)).toEqual([expected[4]!.id]);
    expect(third.page).toBe(3);
    expect(third.nextCursor).toBeNull();

    const second = await auth.api.listInvites({ query: { limit: 2, page: 2 }, headers });
    expect(second.invites.map((i) => i.id)).toEqual(expected.slice(2, 4).map((r) => r.id));
    expect(second.nextCursor).toEqual(expect.any(String));

    expect(
      await errCode(auth.api.listInvites({ query: { cursor: "not-a-cursor" }, headers }))
    ).toBe("INVALID_CURSOR");
  });
});
