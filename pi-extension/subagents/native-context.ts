import { ExtensionRunner, InteractiveMode, getPackageDir, getMarkdownTheme, type ExtensionContext, type ExtensionAPI, type ToolRenderers, type MessageRenderer, type MarkdownTransformer, type EntryRenderer } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Pi 1.1 exposes native components but not the active frontend/renderer registry
// on ExtensionContext. Keep the small compatibility boundary here: observe context
// creation/init without replacing registrations, running factories again, or executing tools.
const KEY = Symbol.for("pi-subagents/native-presentation");
type Bridge = { runners: WeakMap<object, ExtensionRunner>; frontends: WeakMap<object, any>; hooked: WeakSet<object> };
const bridge: Bridge = (globalThis as any)[KEY] ??= { runners: new WeakMap(), frontends: new WeakMap(), hooked: new WeakSet() };
if (!bridge.hooked.has(ExtensionRunner.prototype)) {
  bridge.hooked.add(ExtensionRunner.prototype);
  const original = ExtensionRunner.prototype.createContext;
  ExtensionRunner.prototype.createContext = function () {
    const context = original.call(this);
    bridge.runners.set(context.sessionManager, this);
    return context;
  };
}
const frontendPrototype = InteractiveMode.prototype as any;
if (!bridge.hooked.has(frontendPrototype)) {
  bridge.hooked.add(frontendPrototype);
  for (const method of ["init", "setupExtensionShortcuts"]) {
    const original = frontendPrototype[method];
    frontendPrototype[method] = function (...args: any[]) {
      bridge.frontends.set(this.sessionManager, this);
      return original.apply(this, args);
    };
  }
}

/** Pi 1.1 has no widget priority option. Keep our stable widget before other
 * above-editor widgets without disposing or recreating their components. */
export function pinWidgetFirst(context: ExtensionContext, key: string) {
  const frontend = bridge.frontends.get(context.sessionManager);
  const widgets: Map<string, any> | undefined = frontend?.extensionWidgetsAbove;
  if (!widgets?.has(key) || widgets.keys().next().value === key) return;
  const first = widgets.get(key);
  const others = [...widgets].filter(([name]) => name !== key);
  widgets.clear();
  widgets.set(key, first);
  for (const [name, component] of others) widgets.set(name, component);
  frontend.renderWidgets();
}

let builtinRenderers: Record<string, ToolRenderers> = {};
let Keybindings: any;
let CustomEntry: any;
export function nativeKeybindings(): import("@earendil-works/pi-coding-agent").KeybindingsManager {
  if (!Keybindings) throw new Error("Native presentation was not initialized");
  return Keybindings.create();
}
let ready: Promise<void> | undefined;
export function prepareNativeRenderers(): Promise<void> {
  return ready ??= (async () => {
    const root = getPackageDir();
    const helpers = await import(pathToFileURL(join(root, "dist/core/tools/renderers/index.js")).href);
    Keybindings = (await import(pathToFileURL(join(root, "dist/core/keybindings.js")).href)).KeybindingsManager;
    CustomEntry = (await import(pathToFileURL(join(root, "dist/modes/interactive/components/custom-entry.js")).href)).CustomEntryComponent;
    builtinRenderers = helpers.createAllToolRenderers();
  })();
}

export interface NativePresentation {
  settings(): { outputPad: number; hideThinking: boolean; hiddenThinkingLabel: string; showImages: boolean; imageWidthCells: number; markdownTheme: ReturnType<typeof getMarkdownTheme>; transformers: readonly MarkdownTransformer[] };
  tool(name: string): ToolRenderers | undefined;
  message(type: string): MessageRenderer | undefined;
  entry(entry: any, padding: number, onError?: (error: unknown) => void): import("@earendil-works/pi-tui").Component | undefined;
  editorFactory?: ExtensionContext["ui"]["getEditorComponent"];
  toolsExpanded(): boolean;
  setToolsExpanded(expanded: boolean): void;
  workingIndicator(): any;
}

export function nativePresentation(pi?: ExtensionAPI, context?: ExtensionContext): NativePresentation {
  const frontend = context ? bridge.frontends.get(context.sessionManager) : undefined;
  const runner = context ? bridge.runners.get(context.sessionManager) : undefined;
  return {
    settings() {
      const settings = pi?.getSettings?.() ?? {};
      return {
        outputPad: frontend?.outputPad ?? settings.outputPad ?? 1,
        hideThinking: frontend?.hideThinkingBlock ?? settings.hideThinkingBlock ?? false,
        hiddenThinkingLabel: frontend?.hiddenThinkingLabel ?? "Thinking...",
        showImages: frontend?.settingsManager.getShowImages() ?? settings.terminal?.showImages ?? true,
        imageWidthCells: frontend?.settingsManager.getImageWidthCells() ?? settings.terminal?.imageWidthCells ?? 60,
        markdownTheme: frontend?.getMarkdownThemeWithSettings() ?? { ...getMarkdownTheme(), codeBlockIndent: settings.markdown?.codeBlockIndent ?? "  " },
        transformers: frontend?.getMarkdownTransformers() ?? runner?.getMarkdownTransformers() ?? [],
      };
    },
    tool(name) {
      if (frontend) return frontend.getRegisteredToolDefinition(name);
      const definition = runner?.getToolDefinition(name);
      const builtin = builtinRenderers[name];
      const base = definition ? { ...builtin, ...definition, renderCall: definition.renderCall ?? builtin?.renderCall, renderResult: definition.renderResult ?? builtin?.renderResult } : builtin;
      return runner ? runner.resolveToolRenderers(name, () => base) : base;
    },
    message: (type) => runner?.getMessageRenderer(type),
    entry(entry, padding, onError) {
      const renderer: EntryRenderer | undefined = runner?.getEntryRenderer(entry.customType);
      if (!renderer || !CustomEntry) return undefined;
      const component = new CustomEntry(entry, (...args: Parameters<EntryRenderer>) => {
        try { return renderer(...args); }
        catch (error) { onError?.(error); throw error; }
      }, padding);
      return component.hasContent() ? component : undefined;
    },
    editorFactory: context?.ui.getEditorComponent?.bind(context.ui),
    toolsExpanded: () => context?.ui.getToolsExpanded?.() ?? false,
    setToolsExpanded: (expanded) => context?.ui.setToolsExpanded?.(expanded),
    workingIndicator: () => frontend?.workingIndicatorOptions,
  };
}
