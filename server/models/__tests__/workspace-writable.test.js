// vs-fork Plan 4 §C.4a / §C.5 — Workspace.writable allowlist
// + cross_workspace_with round-trip.
//
// Plan 4 §C.5 requires `cross_workspace_with` to be on the
// Workspace.writable allowlist. Without the entry, the
// `Workspace.update()` PATCH call silently DROPS the field
// (validateFields filters by writable membership at
// models/workspace.js:176). The helper at server/utils/chats/
// firm-reference.js (Task A2) reads `workspace.cross_workspace_with`
// — if the field is dropped on PATCH it stays null at read time
// and the helper short-circuits to zero-count, defeating the
// whole feature.
//
// These tests are deliberately small and DB-touching: they
// create a workspace, PATCH it, reload, and assert the field
// persisted. They do NOT mock the Prisma client.

process.env.STORAGE_DIR = process.env.STORAGE_DIR || __dirname;
process.env.NODE_ENV = process.env.NODE_ENV || "test";

const prisma = require("../../utils/prisma");
const { Workspace } = require("../workspace");

describe("Workspace.writable / cross_workspace_with (Plan 4 §C.4a + §C.5)", () => {
  const slugsCreated = [];

  afterEach(async () => {
    if (slugsCreated.length) {
      await prisma.workspaces.deleteMany({
        where: { slug: { in: slugsCreated } },
      });
      slugsCreated.length = 0;
    }
  });

  it("Workspace.writable includes 'cross_workspace_with' (Plan 4 §C.5)", () => {
    expect(Array.isArray(Workspace.writable)).toBe(true);
    expect(Workspace.writable).toContain("cross_workspace_with");
  });

  it("validateFields() retains cross_workspace_with on the way through", () => {
    const validated = Workspace.validateFields({
      cross_workspace_with: "firm-reference",
    });
    expect(validated).toEqual({ cross_workspace_with: "firm-reference" });
  });

  it("validateFields() drops unknown / non-writable fields (regression guard for the writable filter itself)", () => {
    const validated = Workspace.validateFields({
      cross_workspace_with: "firm-reference",
      not_a_real_field: "hostile",
      slug: "should-not-pass",
    });
    expect(validated).toEqual({ cross_workspace_with: "firm-reference" });
  });

  it("validateFields() coerces empty string to null (cleared toggle path)", () => {
    expect(Workspace.validateFields({ cross_workspace_with: "" })).toEqual({
      cross_workspace_with: null,
    });
  });

  it("validateFields() coerces unknown namespace to null (hostile PATCH guard)", () => {
    expect(
      Workspace.validateFields({ cross_workspace_with: "some-other-namespace" })
    ).toEqual({ cross_workspace_with: null });
  });

  it("validateFields() coerces non-string values to null", () => {
    expect(Workspace.validateFields({ cross_workspace_with: null })).toEqual({
      cross_workspace_with: null,
    });
    expect(
      Workspace.validateFields({ cross_workspace_with: ["firm-reference"] })
    ).toEqual({ cross_workspace_with: null });
    expect(Workspace.validateFields({ cross_workspace_with: 42 })).toEqual({
      cross_workspace_with: null,
    });
  });

  it("end-to-end: create → update → reload preserves cross_workspace_with", async () => {
    const slug = `vs-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    slugsCreated.push(slug);

    const created = await prisma.workspaces.create({
      data: { name: "vs-test-cross-ws", slug },
    });
    expect(created.cross_workspace_with).toBeNull();

    const updateResult = await Workspace.update(created.id, {
      cross_workspace_with: "firm-reference",
    });
    // Workspace.update returns either { workspace, message } where
    // workspace is the Prisma row OR (on validation no-op) just
    // { workspace: { id }, message }. Reload from prisma directly
    // for the authoritative shape.
    expect(updateResult).toBeDefined();

    const reloaded = await prisma.workspaces.findUnique({
      where: { id: created.id },
    });
    expect(reloaded.cross_workspace_with).toBe("firm-reference");
  });

  it("end-to-end: update can clear cross_workspace_with back to null", async () => {
    const slug = `vs-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    slugsCreated.push(slug);

    const created = await prisma.workspaces.create({
      data: { name: "vs-test-cross-ws-clear", slug, cross_workspace_with: "firm-reference" },
    });
    expect(created.cross_workspace_with).toBe("firm-reference");

    await Workspace.update(created.id, { cross_workspace_with: null });

    const reloaded = await prisma.workspaces.findUnique({
      where: { id: created.id },
    });
    expect(reloaded.cross_workspace_with).toBeNull();
  });
});
