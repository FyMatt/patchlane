import * as vscode from "vscode";
import { getConfig } from "../config";

export interface IndexedFile {
  path: string;
  languageId: string;
  lineCount: number;
}

export class WorkspaceIndexService {
  public async buildIndex(): Promise<IndexedFile[]> {
    const maxFiles = getConfig().get<number>("index.maxFiles", 250);
    const exclude = getConfig().get<string>("index.exclude", "**/{node_modules,dist,out,.git,.codex}/**");
    const uris = await vscode.workspace.findFiles("**/*", exclude, maxFiles);

    const indexed: IndexedFile[] = [];
    for (const uri of uris) {
      try {
        const document = await vscode.workspace.openTextDocument(uri);
        indexed.push({
          path: vscode.workspace.asRelativePath(uri, false),
          languageId: document.languageId,
          lineCount: document.lineCount
        });
      } catch {
        indexed.push({
          path: vscode.workspace.asRelativePath(uri, false),
          languageId: "unknown",
          lineCount: 0
        });
      }
    }

    return indexed.sort((left, right) => left.path.localeCompare(right.path));
  }

  public formatIndex(indexedFiles: IndexedFile[]): string {
    return indexedFiles
      .map((file) => `${file.path} (${file.languageId}, ${file.lineCount} lines)`)
      .join("\n") || "(no files indexed)";
  }
}

