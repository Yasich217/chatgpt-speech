import * as os from "node:os";
import * as vscode from "vscode";

export function localWorkspaceFolderPath(): string {
  return (
    vscode.workspace.workspaceFolders?.find(
      (folder) => folder.uri.scheme === "file",
    )?.uri.fsPath ?? ""
  );
}

export function localProcessCwd(): string {
  return localWorkspaceFolderPath() || os.homedir();
}

export function expandWorkspaceFolderVar(value: string): string {
  return value.replaceAll("${workspaceFolder}", localWorkspaceFolderPath());
}

export function describeExtensionHost(
  context: vscode.ExtensionContext,
): string {
  const extensionKind =
    context.extension.extensionKind === vscode.ExtensionKind.UI
      ? "ui"
      : context.extension.extensionKind === vscode.ExtensionKind.Workspace
        ? "workspace"
        : "unknown";
  return `extensionHost=${extensionKind}; remoteName=${vscode.env.remoteName ?? "none"}; localWorkspaceFolder=${localWorkspaceFolderPath() || "<none>"}`;
}
