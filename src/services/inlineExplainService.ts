import * as vscode from "vscode";
import { getModelForTask, getModelMaxTokens, getModelTemperature, getModelTopP } from "../config";
import { ProviderRegistry } from "../providers/registry";

interface InlineExplainTarget {
  editor: vscode.TextEditor;
  range: vscode.Range;
  path: string;
  content: string;
}

export class InlineExplainService implements vscode.Disposable {
  private readonly decorationType = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor("editor.hoverHighlightBackground"),
    border: "1px solid",
    borderColor: new vscode.ThemeColor("editorWidget.border"),
    overviewRulerColor: new vscode.ThemeColor("editorInfo.foreground"),
    overviewRulerLane: vscode.OverviewRulerLane.Right,
    after: {
      margin: "0 0 0 12px",
      color: new vscode.ThemeColor("descriptionForeground"),
      contentText: "Patchlane 正在解释..."
    }
  });

  private active?: {
    editor: vscode.TextEditor;
    range: vscode.Range;
    content: string;
    controller: AbortController;
  };

  public constructor(private readonly providers: ProviderRegistry) {}

  public async explainSelection(): Promise<void> {
    const target = getInlineExplainTarget();
    this.active?.controller.abort();

    const controller = new AbortController();
    this.active = {
      editor: target.editor,
      range: target.range,
      content: "",
      controller
    };

    this.render(target.editor, target.range, "正在解释选中代码...", "");

    try {
      const activeModel = getModelForTask("chat");
      const response = await this.providers.get(activeModel.providerId).chat({
        model: activeModel.modelId,
        messages: [
          {
            role: "system",
            content: [
              "Explain selected code clearly and practically.",
              "Keep the answer structured and concise.",
              "Mention purpose, important control flow, edge cases, and risks.",
              "Reply in Chinese unless the selected code strongly indicates another language."
            ].join(" ")
          },
          {
            role: "user",
            content: [
              `文件：${target.path}`,
              "",
              "请解释这段代码：",
              "```",
              target.content,
              "```"
            ].join("\n")
          }
        ],
        temperature: getModelTemperature(),
        maxTokens: getModelMaxTokens(),
        topP: getModelTopP()
      }, {
        signal: controller.signal,
        onDelta: (delta) => {
          if (this.active?.controller !== controller) {
            return;
          }
          this.active.content += delta;
          this.render(target.editor, target.range, "正在解释选中代码...", this.active.content);
        }
      });

      if (this.active?.controller !== controller) {
        return;
      }

      this.active.content = response.content;
      this.render(target.editor, target.range, "解释完成，悬停查看结果", response.content);
      vscode.window.setStatusBarMessage("Patchlane: 解释完成，悬停选中代码查看。", 3500);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.render(target.editor, target.range, "解释失败，悬停查看原因", `**解释失败**\n\n${message}`);
      vscode.window.showErrorMessage(message);
    }
  }

  public clear(): void {
    this.active?.controller.abort();
    this.active?.editor.setDecorations(this.decorationType, []);
    this.active = undefined;
  }

  public dispose(): void {
    this.clear();
    this.decorationType.dispose();
  }

  private render(editor: vscode.TextEditor, range: vscode.Range, label: string, markdown: string): void {
    const hover = new vscode.MarkdownString(markdown || "正在请求模型解释选中代码...");
    hover.supportThemeIcons = true;
    hover.isTrusted = false;

    editor.setDecorations(this.decorationType, [
      {
        range,
        hoverMessage: hover,
        renderOptions: {
          after: {
            contentText: `Patchlane · ${label}`
          }
        }
      }
    ]);
  }
}

function getInlineExplainTarget(): InlineExplainTarget {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    throw new Error("请先打开一个文件。");
  }

  const selection = editor.selection;
  const range = selection.isEmpty
    ? new vscode.Range(editor.selection.active.line, 0, editor.selection.active.line, editor.document.lineAt(editor.selection.active.line).range.end.character)
    : new vscode.Range(selection.start, selection.end);
  const content = selection.isEmpty ? editor.document.lineAt(editor.selection.active.line).text : editor.document.getText(selection);

  return {
    editor,
    range,
    path: vscode.workspace.asRelativePath(editor.document.uri, false),
    content
  };
}
