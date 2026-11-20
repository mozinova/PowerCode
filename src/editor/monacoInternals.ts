//! Parts of Monaco that its public API does not expose: the registries its drop
//! and paste controllers read (`editor.dropIntoEditor`, paste with providers).
//! Monaco ships these controllers; only registering providers with them needs this.

// @ts-expect-error Monaco's internal modules have no type declarations.
import { StandaloneServices } from "monaco-editor/editor/standalone/browser/standaloneServices";
// @ts-expect-error Monaco's internal modules have no type declarations.
import { ILanguageFeaturesService } from "monaco-editor/editor/common/services/languageFeatures";
// @ts-expect-error Monaco's internal modules have no type declarations.
import { HierarchicalKind as Kind } from "monaco-editor/base/common/hierarchicalKind";
// @ts-expect-error Monaco's internal modules have no type declarations.
import { VSDataTransfer } from "monaco-editor/base/common/dataTransfer";
// @ts-expect-error Monaco's internal modules have no type declarations.
import { IBulkEditService, ResourceEdit, ResourceTextEdit } from "monaco-editor/editor/browser/services/bulkEditService";
// @ts-expect-error Monaco's internal modules have no type declarations.
import { SnippetController2 } from "monaco-editor/editor/contrib/snippet/browser/snippetController2";
// @ts-expect-error Monaco's internal modules have no type declarations.
import { SnippetParser } from "monaco-editor/editor/contrib/snippet/browser/snippetParser";
import { monaco } from "./monaco";

/** Monaco's `HierarchicalKind` (`text`, `text.updateImports`, ...). */
export interface HierarchicalKind {
  readonly value: string;
  contains(other: HierarchicalKind): boolean;
}

export const hierarchicalKind = (value: string): HierarchicalKind => new Kind(value);

/** An entry of Monaco's data transfer (clipboard or drop contents). */
export interface DataTransferItem {
  asString(): Promise<string>;
  asFile(): { name: string; uri?: monaco.Uri; data(): Promise<Uint8Array> } | undefined;
  value: unknown;
}

export interface DataTransfer extends Iterable<[string, DataTransferItem]> {
  get(mime: string): DataTransferItem | undefined;
  matches(pattern: string): boolean;
}

export interface DropOrPasteEdit {
  title: string;
  kind?: HierarchicalKind;
  insertText: string | { snippet: string };
  additionalEdit?: monaco.languages.WorkspaceEdit;
  yieldTo?: ({ kind: HierarchicalKind } | { mimeType: string })[];
  handledMimeType?: string;
}

export interface DocumentPasteEditProvider {
  id?: string;
  copyMimeTypes?: string[];
  pasteMimeTypes?: string[];
  providedPasteEditKinds?: HierarchicalKind[];
  prepareDocumentPaste?(
    model: monaco.editor.ITextModel,
    ranges: monaco.IRange[],
    dataTransfer: DataTransfer,
    token: monaco.CancellationToken,
  ): Promise<DataTransfer | undefined>;
  provideDocumentPasteEdits?(
    model: monaco.editor.ITextModel,
    ranges: monaco.IRange[],
    dataTransfer: DataTransfer,
    context: { only?: HierarchicalKind; triggerKind: number },
    token: monaco.CancellationToken,
  ): Promise<{ edits: DropOrPasteEdit[]; dispose(): void } | undefined>;
}

export interface DocumentDropEditProvider {
  id?: string;
  dropMimeTypes?: string[];
  providedDropEditKinds?: HierarchicalKind[];
  provideDocumentDropEdits(
    model: monaco.editor.ITextModel,
    position: monaco.IPosition,
    dataTransfer: DataTransfer,
    token: monaco.CancellationToken,
  ): Promise<{ edits: DropOrPasteEdit[]; dispose(): void } | undefined>;
}

interface Registry<T> {
  register(selector: string, provider: T): monaco.IDisposable;
}

interface LanguageFeatures {
  documentPasteEditProvider: Registry<DocumentPasteEditProvider>;
  documentDropEditProvider: Registry<DocumentDropEditProvider>;
}

const features = (): LanguageFeatures => StandaloneServices.get(ILanguageFeaturesService);

export const registerPasteEditProvider = (language: string, provider: DocumentPasteEditProvider) =>
  features().documentPasteEditProvider.register(language, provider);

export const registerDropEditProvider = (language: string, provider: DocumentDropEditProvider) =>
  features().documentDropEditProvider.register(language, provider);

interface TextEdit {
  resource: monaco.Uri;
  textEdit: { range: monaco.IRange; text: string; insertAsSnippet?: boolean };
  versionId?: number;
}

let snippetEditsSupported = false;

/**
 * Monaco's standalone bulk edit service applies snippet edits (`insertAsSnippet`:
 * every drop and paste edit) as plain text, `$0` and escapes included. As in VS
 * Code, the edits to the editor's own document go through its snippet controller
 * (tab stops work); edits to other documents get the snippet's plain text.
 */
export function supportSnippetEdits() {
  if (snippetEditsSupported) return;
  snippetEditsSupported = true;
  const service = StandaloneServices.get(IBulkEditService);
  const apply = service.apply.bind(service);
  service.apply = async (editsIn: unknown, options?: { editor?: monaco.editor.ICodeEditor }) => {
    const edits: unknown[] = Array.isArray(editsIn) ? editsIn : ResourceEdit.convert(editsIn);
    const isText = (e: unknown): e is TextEdit => e instanceof ResourceTextEdit;
    if (!edits.some((e) => isText(e) && e.textEdit.insertAsSnippet)) return apply(edits, options);
    const editor = options?.editor;
    const model = editor?.getModel();
    const inEditor = edits.filter((e): e is TextEdit => !!model && isText(e) && e.resource.toString() === model.uri.toString());
    const others = edits
      .filter((e) => !inEditor.includes(e as TextEdit))
      .map((e) =>
        isText(e) && e.textEdit.insertAsSnippet
          ? new ResourceTextEdit(e.resource, { range: e.textEdit.range, text: new SnippetParser().text(e.textEdit.text) }, e.versionId)
          : e,
      );
    const result = others.length ? await apply(others, options) : { ariaSummary: "", isApplied: false };
    if (editor && inEditor.length) {
      SnippetController2.get(editor)?.insert(
        inEditor.map((e) => ({
          range: monaco.Range.lift(e.textEdit.range),
          template: e.textEdit.insertAsSnippet ? e.textEdit.text : SnippetParser.escape(e.textEdit.text),
        })),
        { undoStopBefore: true, undoStopAfter: true },
      );
      return { ...result, isApplied: true };
    }
    return result;
  };
}

/** A Monaco data transfer with `entries` (what paste providers add on copy). */
export function dataTransferOf(entries: [string, DataTransferItem][]): DataTransfer {
  const transfer = new VSDataTransfer();
  for (const [mime, item] of entries) transfer.replace(mime, item);
  return transfer;
}

/** A data transfer entry holding `value` (what a paste provider put there on copy). */
export function valueItem(value: unknown): DataTransferItem {
  return {
    asString: async () => (typeof value === "string" ? value : JSON.stringify(value)),
    asFile: () => undefined,
    value,
  };
}
