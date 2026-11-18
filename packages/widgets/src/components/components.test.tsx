import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ItemRowModel } from "../model.js";
import { ItemTable } from "./ItemTable.js";
import { Notice } from "./Notice.js";
import { StatsSummary } from "./StatsSummary.js";

afterEach(cleanup);

const row = (over: Partial<ItemRowModel>): ItemRowModel => ({
  targetId: "SKU-1",
  status: "pending",
  before: "a",
  after: "b",
  ...over,
});

describe("components", () => {
  it("SEC-5 hostile values render as text in the item table", () => {
    const hostile = "<img src=x onerror=alert(1)>";
    const { container } = render(
      <ItemTable rows={[row({ before: hostile })]} />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText(hostile)).toBeTruthy();
  });

  it("UI-3 the item table shows one row per changed field with before and after", () => {
    const { container } = render(
      <ItemTable
        rows={[
          row({
            before: { price: 1, name: "x" },
            after: { price: 2, name: "y" },
          }),
        ]}
      />,
    );
    expect(container.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(screen.getByText("price")).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    expect(
      container.querySelectorAll('tbody tr:first-child td[rowspan="2"]'),
    ).toHaveLength(2);
  });

  it("UI-3 an excluded item shows its reason", () => {
    const { container } = render(
      <ItemTable rows={[row({ status: "excluded", reason: "no_change" })]} />,
    );
    expect(screen.getByText("excluded: no_change")).toBeTruthy();
    expect(container.querySelectorAll("tbody tr")).toHaveLength(1);
  });

  it("UI-3 a failed item shows its error code", () => {
    render(
      <ItemTable
        rows={[row({ status: "failed", error: "UPSTREAM_REJECTED" })]}
      />,
    );
    expect(screen.getByText("UPSTREAM_REJECTED")).toBeTruthy();
  });

  it("UI-3 checkboxes appear only where canSelect allows and call toggle", () => {
    const toggle = vi.fn();
    render(
      <ItemTable
        rows={[row({ targetId: "A" }), row({ targetId: "B" })]}
        selection={{
          selected: new Set(["A"]),
          canSelect: (r) => r.targetId === "A",
          toggle,
        }}
      />,
    );
    expect(screen.queryByLabelText("Select B")).toBeNull();
    const box = screen.getByLabelText<HTMLInputElement>("Select A");
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    expect(toggle).toHaveBeenCalledWith("A");
  });

  it("UI-3 StatsSummary states included, excluded per reason, hash and expiry", () => {
    const hash = `sha256:6114edb2${"0".repeat(48)}`;
    const { container } = render(
      <StatsSummary
        stats={{
          total: 4,
          included: 3,
          excluded: { no_change: 1 },
          written: 0,
          failed: 0,
          skipped: 0,
        }}
        hash={hash}
        expiresAt="2026-01-02T10:00:00Z"
      />,
    );
    expect(container.textContent).toContain(
      "3 changes · 1 excluded (no_change 1)",
    );
    expect(container.textContent).toContain("sha256:6114edb2…");
    expect(container.querySelector("[title]")?.getAttribute("title")).toBe(
      hash,
    );
    expect(container.textContent).toContain("Expires ");
  });

  it("UI-6 Notice uses role alert for errors and status for info", () => {
    render(
      <>
        <Notice kind="error">bad</Notice>
        <Notice kind="info">fine</Notice>
      </>,
    );
    expect(screen.getByRole("alert").textContent).toBe("bad");
    expect(screen.getByRole("status").textContent).toBe("fine");
  });
});
