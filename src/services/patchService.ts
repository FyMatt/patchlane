import * as vscode from "vscode";
import { ParsedFilePatch, applyPatchToText, extractUnifiedDiff, parseUnifiedDiff } from "./unifiedDiff";

export { applyPatchToText, extractUnifiedDiff, parseUnifiedDiff } from "./unifiedDiff";

export interface BackupEntry {
  path: string;
  kind: "modify" | "delete" | "create";
  backupPath?: string;
}

export interface BackupManifest {
  id: string;
  createdAt: string;
  workspaceRoot: string;
  entries: BackupEntry[];
  patchText: string;
}

export interface PatchApplyResult {
  backupId: string;
  files: string[];
}

export interface PatchApplyOptions {
  signal?: AbortSignal;
}

interface FileChangePlan {
  kind: "create" | "modify" | "delete";
  relativePath: string;
  fileUri: vscode.Uri;
  currentText: string;
  nextText?: string;
}

export class PatchService {
  private readonly backupRootUri: vscode.Uri;
  private readonly manifestUri: vscode.Uri;
  private lastManifest?: BackupManifest;

  public constructor(private readonly storageUri: vscode.Uri) {
    this.backupRootUri = vscode.Uri.joinPath(this.storageUri, "patch-backups");
    this.manifestUri = vscode.Uri.joinPath(this.storageUri, "last-patch-manifest.json");
  }

  public async applyUnifiedDiff(rawText: string, options: PatchApplyOptions = {}): Promise<PatchApplyResult> {
    assertNotAborted(options.signal);
    const patchText = extractUnifiedDiff(rawText);
    const parsed = parseUnifiedDiff(patchText);
    if (parsed.files.length === 0) {
      throw new Error("No file changes were found in the patch.");
    }

    const workspaceRootUri = this.getWorkspaceRootUri();
    const workspaceRootPath = workspaceRootUri.fsPath;
    const plans = await Promise.all(parsed.files.map(async (filePatch) => this.buildChangePlan(workspaceRootUri, filePatch)));
    assertNotAborted(options.signal);
    await this.ensureNoDirtyDocuments(plans.map((plan) => plan.fileUri));
    assertNotAborted(options.signal);

    const backupId = createId();
    const backupDirUri = vscode.Uri.joinPath(this.backupRootUri, backupId);
    await vscode.workspace.fs.createDirectory(backupDirUri);

    const manifest: BackupManifest = {
      id: backupId,
      createdAt: new Date().toISOString(),
      workspaceRoot: workspaceRootPath,
      entries: [],
      patchText
    };

    try {
      for (const plan of plans) {
        assertNotAborted(options.signal);
        await this.backupPlan(plan, backupDirUri, manifest.entries);
      }

      for (const plan of plans) {
        assertNotAborted(options.signal);
        await this.applyPlan(plan);
      }

      assertNotAborted(options.signal);
      await this.saveManifest(manifest);
      this.lastManifest = manifest;

      return {
        backupId,
        files: plans.map((plan) => plan.relativePath)
      };
    } catch (error) {
      await this.restoreManifestEntries(manifest.entries);
      throw error;
    }
  }

  public async rollbackLastPatch(): Promise<void> {
    const manifest = await this.loadManifest();
    if (!manifest) {
      throw new Error("暂无可撤回的修改记录。");
    }

    await this.restoreManifestEntries(manifest.entries);
    await this.clearManifest();
    this.lastManifest = undefined;
  }

  public getLastBackupId(): string | undefined {
    return this.lastManifest?.id;
  }

  public async loadLastManifest(): Promise<BackupManifest | undefined> {
    if (this.lastManifest) {
      return this.lastManifest;
    }

    this.lastManifest = await this.loadManifest();
    return this.lastManifest;
  }

  private async buildChangePlan(workspaceRootUri: vscode.Uri, filePatch: ParsedFilePatch): Promise<FileChangePlan> {
    const targetPath = resolvePatchPath(filePatch);
    const fileUri = toWorkspaceUri(workspaceRootUri, targetPath);
    const exists = await uriExists(fileUri);

    if (filePatch.oldPath === "/dev/null") {
      if (exists) {
        throw new Error(`Cannot create ${targetPath}: the file already exists.`);
      }

      const nextText = applyPatchToText("", filePatch, targetPath, true);
      return {
        kind: "create",
        relativePath: targetPath,
        fileUri,
        currentText: "",
        nextText
      };
    }

    if (filePatch.newPath === "/dev/null") {
      if (!exists) {
        throw new Error(`Cannot delete ${targetPath}: the file does not exist.`);
      }

      const currentText = await readTextFile(fileUri);
      return {
        kind: "delete",
        relativePath: targetPath,
        fileUri,
        currentText
      };
    }

    if (!exists) {
      throw new Error(`Cannot modify ${targetPath}: the file does not exist.`);
    }

    const currentText = await readTextFile(fileUri);
    const nextText = applyPatchToText(currentText, filePatch, targetPath, false);

    return {
      kind: "modify",
      relativePath: targetPath,
      fileUri,
      currentText,
      nextText
    };
  }

  private async backupPlan(plan: FileChangePlan, backupDirUri: vscode.Uri, entries: BackupEntry[]): Promise<void> {
    const backupRelativePath = plan.relativePath.replace(/\\/g, "/");
    const backupFileUri = vscode.Uri.joinPath(backupDirUri, ...backupRelativePath.split("/"));

    if (plan.kind === "create") {
      entries.push({
        path: plan.relativePath,
        kind: "create"
      });
      return;
    }

    await ensureParentDirectory(backupFileUri);
    await vscode.workspace.fs.copy(plan.fileUri, backupFileUri, { overwrite: true });

    entries.push({
      path: plan.relativePath,
      kind: plan.kind === "modify" ? "modify" : "delete",
      backupPath: vscode.Uri.joinPath(backupDirUri, ...backupRelativePath.split("/")).fsPath
    });
  }

  private async applyPlan(plan: FileChangePlan): Promise<void> {
    if (plan.kind === "delete") {
      await vscode.workspace.fs.delete(plan.fileUri, { useTrash: false });
      return;
    }

    if (typeof plan.nextText !== "string") {
      throw new Error(`Missing replacement text for ${plan.relativePath}.`);
    }

    await ensureParentDirectory(plan.fileUri);
    await vscode.workspace.fs.writeFile(plan.fileUri, new TextEncoder().encode(plan.nextText));
  }

  private async restoreManifestEntries(entries: BackupEntry[]): Promise<void> {
    for (const entry of entries) {
      const targetUri = toWorkspaceUri(this.getWorkspaceRootUri(), entry.path);

      if (entry.kind === "create") {
        if (await uriExists(targetUri)) {
          await vscode.workspace.fs.delete(targetUri, { useTrash: false });
        }
        continue;
      }

      if (!entry.backupPath) {
        continue;
      }

      const backupUri = vscode.Uri.file(entry.backupPath);
      await ensureParentDirectory(targetUri);
      await vscode.workspace.fs.copy(backupUri, targetUri, { overwrite: true });
    }
  }

  private async ensureNoDirtyDocuments(uris: vscode.Uri[]): Promise<void> {
    const normalizedTargets = new Set(uris.map((uri) => uri.toString()));
    const dirty = vscode.workspace.textDocuments.filter((document) => document.isDirty && normalizedTargets.has(document.uri.toString()));

    if (dirty.length > 0) {
      const list = dirty.map((document) => vscode.workspace.asRelativePath(document.uri, false)).join(", ");
      throw new Error(`Save these files before applying a patch: ${list}`);
    }
  }

  private async saveManifest(manifest: BackupManifest): Promise<void> {
    await vscode.workspace.fs.createDirectory(this.storageUri);
    await vscode.workspace.fs.writeFile(this.manifestUri, new TextEncoder().encode(JSON.stringify(manifest, null, 2)));
  }

  private async clearManifest(): Promise<void> {
    if (await uriExists(this.manifestUri)) {
      await vscode.workspace.fs.delete(this.manifestUri, { useTrash: false });
    }
  }

  private async loadManifest(): Promise<BackupManifest | undefined> {
    if (!(await uriExists(this.manifestUri))) {
      return undefined;
    }

    const text = await readTextFile(this.manifestUri);
    return JSON.parse(text) as BackupManifest;
  }

  private getWorkspaceRootUri(): vscode.Uri {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      throw new Error("应用修改前请先打开一个工作区文件夹。");
    }

    return folder.uri;
  }
}

function resolvePatchPath(filePatch: ParsedFilePatch): string {
  if (filePatch.oldPath === "/dev/null") {
    return filePatch.newPath;
  }

  if (filePatch.newPath === "/dev/null") {
    return filePatch.oldPath;
  }

  if (filePatch.oldPath !== filePatch.newPath) {
    throw new Error(`Rename patches are not supported yet: ${filePatch.oldPath} -> ${filePatch.newPath}`);
  }

  return filePatch.newPath;
}

function toWorkspaceUri(workspaceRootUri: vscode.Uri, relativePath: string): vscode.Uri {
  const safePath = relativePath.replace(/\\/g, "/");
  const segments = safePath.split("/").filter(Boolean);
  if (segments.length === 0) {
    throw new Error("无效的修改文件路径。");
  }

  return vscode.Uri.joinPath(workspaceRootUri, ...segments);
}

async function uriExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function readTextFile(uri: vscode.Uri): Promise<string> {
  const bytes = await vscode.workspace.fs.readFile(uri);
  return new TextDecoder().decode(bytes);
}

async function ensureParentDirectory(uri: vscode.Uri): Promise<void> {
  const directoryUri = vscode.Uri.joinPath(uri, "..");
  await vscode.workspace.fs.createDirectory(directoryUri);
}

function createId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("The operation was aborted.", "AbortError");
  }
}
