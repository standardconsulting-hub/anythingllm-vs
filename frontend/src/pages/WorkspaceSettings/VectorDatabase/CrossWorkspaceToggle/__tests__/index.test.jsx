// vs-fork Plan 4 §C BLOCK-2 — frontend toggle tests.
//
// Exercises the CrossWorkspaceToggle component end-to-end via
// @testing-library/react: render, initial state derivation,
// user interaction, and the FormData payload that surfaces via
// the parent VectorDatabase form's onSubmit handler.
//
// Sub-plan v4 line 819-822 originally specified tests at
// frontend/src/components/Modals/ManageWorkspace/Settings/__tests__/
// — the toggle ended up at pages/WorkspaceSettings/VectorDatabase/
// (more correct location: it lives next to VectorSearchMode and
// related vector-database settings). The tests therefore live
// alongside the component they cover.

import { describe, test, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import CrossWorkspaceToggle from "../index"

const FIRM_REFERENCE_NAMESPACE = "firm-reference"

function noop() {}

// Wrap the toggle in a tiny form so we can read the FormData
// payload exactly the way the production VectorDatabase tab
// does (see VectorDatabase/index.jsx:18-35: it builds a
// FormData from formEl.current and casts every entry).
function renderInForm(workspace, { setHasChanges = noop } = {}) {
  let lastFormData = null
  const form = render(
    <form
      data-testid="form"
      onSubmit={(e) => {
        e.preventDefault()
        const fd = new FormData(e.currentTarget)
        const entries = {}
        for (const [k, v] of fd.entries()) entries[k] = v
        lastFormData = entries
      }}
    >
      <CrossWorkspaceToggle
        workspace={workspace}
        setHasChanges={setHasChanges}
      />
      <button type="submit" data-testid="submit">
        save
      </button>
    </form>
  )
  return {
    ...form,
    submit: async () => {
      await userEvent.click(screen.getByTestId("submit"))
      return lastFormData
    },
  }
}

describe("CrossWorkspaceToggle — Plan 4 §C BLOCK-2", () => {
  test("renders ON for a legacy/null workspace (default-on opt-out semantics)", () => {
    renderInForm({ id: 1, slug: "matter", cross_workspace_with: null })
    const checkbox = screen.getByRole("checkbox")
    expect(checkbox).toBeChecked()
  })

  test('renders ON when cross_workspace_with === "firm-reference"', () => {
    renderInForm({
      id: 1,
      slug: "matter",
      cross_workspace_with: FIRM_REFERENCE_NAMESPACE,
    })
    expect(screen.getByRole("checkbox")).toBeChecked()
  })

  test('renders OFF when cross_workspace_with is the empty string (cleared via PATCH)', () => {
    // The validation hook coerces "" → null at write time, so a
    // workspace fetched after a "toggle off" PATCH carries null.
    // But also cover the explicit "" path defensively in case a
    // future caller short-circuits validation.
    renderInForm({ id: 1, slug: "matter", cross_workspace_with: "" })
    expect(screen.getByRole("checkbox")).not.toBeChecked()
  })

  test("toggle ON → submit → FormData carries cross_workspace_with: 'firm-reference'", async () => {
    const { submit } = renderInForm({
      id: 1,
      slug: "matter",
      cross_workspace_with: FIRM_REFERENCE_NAMESPACE,
    })
    const fd = await submit()
    expect(fd.cross_workspace_with).toBe(FIRM_REFERENCE_NAMESPACE)
  })

  test("toggle OFF → submit → FormData carries cross_workspace_with: '' (server validation coerces to null)", async () => {
    const { submit } = renderInForm({
      id: 1,
      slug: "matter",
      cross_workspace_with: FIRM_REFERENCE_NAMESPACE,
    })
    await userEvent.click(screen.getByRole("checkbox"))
    const fd = await submit()
    expect(fd.cross_workspace_with).toBe("")
  })

  test("interaction calls setHasChanges (so the parent surfaces the Update button)", async () => {
    const setHasChanges = vi.fn()
    renderInForm(
      { id: 1, slug: "matter", cross_workspace_with: null },
      { setHasChanges }
    )
    await userEvent.click(screen.getByRole("checkbox"))
    expect(setHasChanges).toHaveBeenCalledWith(true)
  })
})
