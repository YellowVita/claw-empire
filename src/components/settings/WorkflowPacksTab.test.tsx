import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import WorkflowPacksTab from "./WorkflowPacksTab";

function t(messages: Record<string, string>): string {
  return messages.en ?? messages.ko ?? messages.ja ?? messages.zh ?? Object.values(messages)[0] ?? "";
}

describe("WorkflowPacksTab", () => {
  it("shows workflow packs and handles export/import actions", async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn(async () => {});
    const onExportAll = vi.fn(async () => {});
    const onExportOne = vi.fn(async () => {});
    const onImportFile = vi.fn(async () => {});

    render(
      <WorkflowPacksTab
        t={t}
        packs={[
          {
            key: "development",
            name: "Development",
            enabled: true,
            input_schema: {},
            prompt_preset: {},
            qa_rules: {},
            output_template: {},
            routing_keywords: [],
            cost_profile: {},
          },
        ]}
        loading={false}
        importError={null}
        importSuccess="Imported 1 workflow packs."
        exportingKey={null}
        importing={false}
        onRefresh={onRefresh}
        onExportAll={onExportAll}
        onExportOne={onExportOne}
        onImportFile={onImportFile}
      />,
    );

    expect(screen.getByText("Workflow Pack Backup/Restore")).toBeInTheDocument();
    expect(screen.getByText("Imported 1 workflow packs.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Export All" }));
    expect(onExportAll).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Export" }));
    expect(onExportOne).toHaveBeenCalledWith("development");

    const input = screen.getByLabelText("Import JSON", { selector: "input" });
    const file = new File(['{"version":1,"exported_at":1,"packs":[]}'], "workflow-packs.v1.json", {
      type: "application/json",
    });
    await user.upload(input, file);
    expect(onImportFile).toHaveBeenCalledTimes(1);
    expect(onImportFile).toHaveBeenCalledWith(expect.any(File));
  });
});
