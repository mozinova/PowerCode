import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/languages/features/json/json.worker?worker";
import CssWorker from "monaco-editor/languages/features/css/css.worker?worker";
import HtmlWorker from "monaco-editor/languages/features/html/html.worker?worker";
import TsWorker from "monaco-editor/languages/features/typescript/ts.worker?worker";
import { applyRememberedLanguages } from "./builtinLanguages";
import { POWERCODE_DARK, defineEditorTheme } from "./themes";

self.MonacoEnvironment = {
  getWorker(_workerId, label) {
    switch (label) {
      case "json":
        return new JsonWorker();
      case "css":
      case "scss":
      case "less":
        return new CssWorker();
      case "html":
      case "handlebars":
      case "razor":
        return new HtmlWorker();
      case "typescript":
      case "javascript":
        return new TsWorker();
      default:
        return new EditorWorker();
    }
  },
};

defineEditorTheme(POWERCODE_DARK);
monaco.editor.setTheme(POWERCODE_DARK.id);
// Before any model: languages an extension serves start without Monaco's own service.
applyRememberedLanguages();

export { monaco };
