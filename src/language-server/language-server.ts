/**
 * @license
 * Copyright (c) 2017 The Polymer Project Authors. All rights reserved.
 * This code may only be used under the BSD style license found at
 * http://polymer.github.io/LICENSE.txt
 * The complete set of authors may be found at
 * http://polymer.github.io/AUTHORS.txt
 * The complete set of contributors may be found at
 * http://polymer.github.io/CONTRIBUTORS.txt
 * Code distributed by Google as part of the polymer project is also
 * subject to an additional IP rights grant found at
 * http://polymer.github.io/PATENTS.txt
 */

import {applyEdits, Edit, makeParseLoader, PackageUrlResolver} from 'polymer-analyzer';
import {AnalysisCache} from 'polymer-analyzer/lib/core/analysis-cache';
import {AnalysisContext} from 'polymer-analyzer/lib/core/analysis-context';
import {ResolvedUrl} from 'polymer-analyzer/lib/model/url';
import * as util from 'util';
import {ClientCapabilities, CompletionItem, CompletionItemKind, CompletionList, Definition, FileChangeType, FileEvent, Hover, IConnection, InitializeResult, Location, ServerCapabilities, TextDocumentPositionParams, TextDocuments, TextEdit, WillSaveTextDocumentParams} from 'vscode-languageserver';
import Uri from 'vscode-uri';

import {AttributeCompletion, LocalEditorService} from '../local-editor-service';

import CommandExecutor, {allSupportedCommands} from './commands';
import AnalyzerLSPConverter from './converter';
import DiagnosticGenerator from './diagnostics';
import FileSynchronizer from './file-synchronizer';
import Settings from './settings';
import {Handler} from './util';

export default class LanguageServer extends Handler {
  readonly converter: AnalyzerLSPConverter;
  protected readonly connection: IConnection;
  private readonly _editorService: LocalEditorService;
  readonly fileSynchronizer: FileSynchronizer;
  private readonly _documents: TextDocuments;

  private _settings: Settings;

  /** Get an initialized and ready language server. */
  static async initializeWithConnection(
      connection: IConnection, interceptLogs = true): Promise<LanguageServer> {
    function getWorkspaceUri(
        rootUri: string|null, rootPath: string|null|undefined): Uri|null {
      if (rootUri) {
        return Uri.parse(rootUri);
      }
      if (rootPath) {
        return Uri.file(rootPath);
      }
      return null;
    }

    function makeServer(workspaceUri: Uri) {
      return new LanguageServer(connection, workspaceUri);
    }

    // When we get an initialization request we want to construct a server and
    // tell the client about its capabilities.
    const server = await new Promise<LanguageServer>((resolve, reject) => {
      connection.onInitialize((params): InitializeResult => {
        // Normalize across the two ways that the workspace may be
        // communicated to us.
        const workspaceUri = getWorkspaceUri(params.rootUri, params.rootPath);
        if (!workspaceUri || workspaceUri.scheme !== 'file') {
          reject(
              `Got invalid workspaceUri from client: ` +
              `${util.inspect(workspaceUri)}`);
          return {capabilities: {}};
        }
        const newServer = makeServer(workspaceUri);
        resolve(newServer);
        return {capabilities: newServer.capabilities(params.capabilities)};
      });
    });

    // The console will be valid immediately after the connection has
    // initialized. So hook it up then.
    if (interceptLogs) {
      const {hookUpRemoteConsole} = await import('../intercept-logs');
      hookUpRemoteConsole(connection.console);
    }
    return server;
  }

  /**
   * Called once we've got an initialized connection, a working polymer
   * editor service, and a workspace.
   */
  constructor(connection: IConnection, workspaceUri: Uri) {
    super();
    this._disposables.push(connection);
    this.connection = connection;

    const workspacePath = workspaceUri.fsPath;

    // TODO(rictic): try out implementing an incrementally synced version of
    //     TextDocuments. Should be a performance win for editing large docs.
    this._documents = new TextDocuments();
    this._documents.listen(connection);
    this.converter = new AnalyzerLSPConverter(workspaceUri);

    const synchronizer = new FileSynchronizer(
        connection, this._documents, workspacePath, this.converter);

    this._settings = new Settings(connection, synchronizer, this.converter);
    this._disposables.push(this._settings);

    this._editorService = new LocalEditorService({
      urlLoader: synchronizer.urlLoader,
      urlResolver: new PackageUrlResolver(),
      settings: this._settings
    });

    this._disposables.push(
        synchronizer.fileChanges.listen((filesChangeEvents) => {
          this.handleFilesChanged(filesChangeEvents);
        }));
    this.fileSynchronizer = synchronizer;

    const diagnosticGenerator = new DiagnosticGenerator(
        this._editorService.analyzer, this.converter, connection,
        this._settings, synchronizer, this._documents);
    this._disposables.push(diagnosticGenerator);

    const commandExecutor =
        new CommandExecutor(this.connection, diagnosticGenerator);
    this._disposables.push(commandExecutor);

    this._initEventHandlers();
  }

  private capabilities(clientCapabilities: ClientCapabilities):
      ServerCapabilities {
    const ourCapabilities: ServerCapabilities = {
      textDocumentSync: {
        change: this._documents.syncKind,
        openClose: true,
        willSaveWaitUntil: true
      },
      completionProvider: {resolveProvider: false},
      hoverProvider: true,
      definitionProvider: true,
      codeActionProvider: true,
    };
    // If the client can apply edits, then we can handle the
    // polymer-ide/applyEdit command, which just delegates to the client's
    // applyEdit functionality. Otherwise the client plugin can handle the
    // polymer-ide/applyEdit if it wants that feature.
    if (clientCapabilities.workspace &&
        clientCapabilities.workspace.applyEdit) {
      ourCapabilities.executeCommandProvider = {commands: allSupportedCommands};
    }
    return ourCapabilities;
  }

  private _initEventHandlers() {
    this.connection.onHover(async(textPosition) => {
      return this.handleErrors(
          this.getDocsForHover(textPosition), undefined) as Promise<Hover>;
    });

    this.connection.onDefinition(async(textPosition) => {
      return this.handleErrors(
          this.getDefinition(textPosition), undefined) as Promise<Definition>;
    });

    this.connection.onCompletion(async(textPosition) => {
      return this.handleErrors(
          this.autoComplete(textPosition), {isIncomplete: true, items: []});
    });

    this.connection.onWillSaveTextDocumentWaitUntil((req) => {
      if (this._settings.fixOnSave) {
        return this.handleErrors(this.fixOnSave(req), []);
      }
      return [];
    });
  }

  private async autoComplete(textPosition: TextDocumentPositionParams):
      Promise<CompletionList> {
    const localPath =
        this.converter.getWorkspacePathToFile(textPosition.textDocument);
    const completions =
        await this._editorService.getTypeaheadCompletionsAtPosition(
            localPath, this.converter.convertPosition(textPosition.position));
    if (!completions) {
      return {isIncomplete: false, items: []};
    }
    if (completions.kind === 'element-tags') {
      return {
        isIncomplete: false,
        items: completions.elements.map(c => {
          return {
            label: `<${c.tagname}>`,
            kind: CompletionItemKind.Class,
            documentation: c.description,
            insertText: c.expandTo
          };
        }),
      };
    } else if (completions.kind === 'attributes') {
      return {
        isIncomplete: false,
        items: completions.attributes.map(attributeCompletionToCompletionItem),
      };
    } else if (completions.kind === 'properties-in-polymer-databinding') {
      return {
        isIncomplete: false,
        items: completions.properties.map(attributeCompletionToCompletionItem)
      };
    }
    return {isIncomplete: false, items: []};
  }

  private async getDefinition(textPosition: TextDocumentPositionParams):
      Promise<Definition|undefined> {
    const localPath =
        this.converter.getWorkspacePathToFile(textPosition.textDocument);
    const location =
        await this._editorService.getDefinitionForFeatureAtPosition(
            localPath, this.converter.convertPosition(textPosition.position));
    if (location && location.file) {
      let definition: Location = {
        uri: this.converter.getUriForLocalPath(location.file),
        range: this.converter.convertPRangeToL(location)
      };
      return definition;
    }
  }

  private async getDocsForHover(textPosition: TextDocumentPositionParams):
      Promise<Hover|undefined> {
    const localPath =
        this.converter.getWorkspacePathToFile(textPosition.textDocument);
    const documentation = await this._editorService.getDocumentationAtPosition(
        localPath, this.converter.convertPosition(textPosition.position));
    if (documentation) {
      return {contents: documentation};
    }
  }

  private async handleFilesChanged(fileChangeEvents: FileEvent[]) {
    const paths = fileChangeEvents.map(
        change => this.converter.getWorkspacePathToFile(change));
    if (paths.length === 0) {
      return;  // no new information in this notification
    }
    const deletions =
        fileChangeEvents
            .filter((change) => change.type === FileChangeType.Deleted)
            .map((change) => this.converter.getWorkspacePathToFile(change));
    if (deletions.length > 0) {
      // When a directory is deleted we may not be told about individual
      // files, we'll have to determine the tracked files ourselves.
      // This involves mucking around in private implementation details of
      // the analyzer, so we wrap this in a try/catch.
      // Analyzer issue for a supported API:
      // https://github.com/Polymer/polymer-analyzer/issues/761
      try {
        const context: AnalysisContext =
            await this._editorService.analyzer['_analysisComplete'];
        const cache: AnalysisCache = context['_cache'];
        const cachedPaths = new Set<ResolvedUrl>([
          ...cache.failedDocuments.keys(),
          ...cache.parsedDocumentPromises['_keyToResultMap'].keys()
        ]);
        for (const deletedPath of deletions) {
          const deletedDir = deletedPath + '/';
          for (const cachedPath of cachedPaths) {
            if (cachedPath.startsWith(deletedDir)) {
              paths.push(cachedPath);
            }
          }
        }
      } catch {
        // Mucking about in analyzer internals on a best effort basis here.
      }
    }
    // Clear the files from any caches and recalculate warnings as needed.
    await this._editorService.analyzer.filesChanged(paths);
  }

  private async fixOnSave(req: WillSaveTextDocumentParams):
      Promise<TextEdit[]> {
    const path = this.converter.getWorkspacePathToFile(req.textDocument);
    const {warnings, analysis} =
        await this._editorService.getWarningsForFile(path);
    const edits: Edit[] = [];
    for (const warning of warnings) {
      if (!warning.fix) {
        continue;
      }
      // A fix can touch multiple files. We can only update this document
      // though, so skip any fixes that touch others.
      if (warning.fix.some(repl => repl.range.file !== path)) {
        continue;
      }
      edits.push(warning.fix);
    }
    const {appliedEdits} = await applyEdits(
        edits, makeParseLoader(this._editorService.analyzer, analysis));
    const textEdits: TextEdit[] = [];
    for (const appliedEdit of appliedEdits) {
      for (const replacement of appliedEdit) {
        textEdits.push(TextEdit.replace(
            this.converter.convertPRangeToL(replacement.range),
            replacement.replacementText));
      }
    }
    return textEdits;
  }
}

function attributeCompletionToCompletionItem(
    attrCompletion: AttributeCompletion) {
  const item: CompletionItem = {
    label: attrCompletion.name,
    kind: CompletionItemKind.Field,
    documentation: attrCompletion.description,
    sortText: attrCompletion.sortKey
  };
  if (attrCompletion.type) {
    item.detail = `{${attrCompletion.type}}`;
  }
  if (attrCompletion.inheritedFrom) {
    if (item.detail) {
      item.detail = `${item.detail} ⊃ ${attrCompletion.inheritedFrom}`;
    } else {
      item.detail = `⊃ ${attrCompletion.inheritedFrom}`;
    }
  }
  return item;
}
