import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");

function compileTsx(path, mockedRequire) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const code = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const compiledModule = { exports: {} };
  const jsxRuntime = {
    Fragment: Symbol.for("test.fragment"),
    jsx: (type, props) => ({ type, props: props ?? {} }),
    jsxs: (type, props) => ({ type, props: props ?? {} }),
  };
  const localRequire = (id) => (id === "react/jsx-runtime" ? jsxRuntime : mockedRequire(id));
  new Function("require", "module", "exports", code)(
    localRequire,
    compiledModule,
    compiledModule.exports,
  );
  return compiledModule.exports;
}

class HookHarness {
  hooks = [];
  stateSlots = [];
  index = 0;

  begin() {
    this.index = 0;
  }

  useState(initial) {
    const index = this.index++;
    if (!(index in this.hooks))
      this.hooks[index] = typeof initial === "function" ? initial() : initial;
    this.stateSlots.push(index);
    return [
      this.hooks[index],
      (value) => {
        this.hooks[index] = typeof value === "function" ? value(this.hooks[index]) : value;
      },
    ];
  }

  useRef(initial) {
    const index = this.index++;
    if (!(index in this.hooks)) this.hooks[index] = { current: initial };
    return this.hooks[index];
  }

  useCallback(callback) {
    this.index++;
    return callback;
  }
  useMemo(factory) {
    this.index++;
    return factory();
  }
  useEffect() {
    this.index++;
  }
  render(callback) {
    this.begin();
    return callback();
  }
}

let activeHarness;
const reactMock = {
  useState: (initial) => activeHarness.useState(initial),
  useRef: (initial) => activeHarness.useRef(initial),
  useCallback: (callback) => activeHarness.useCallback(callback),
  useMemo: (factory) => activeHarness.useMemo(factory),
  useEffect: (...args) => activeHarness.useEffect(...args),
};

const DEFAULT_SETTINGS = {
  mode: "ring",
  particleMode: "stardust",
  primary: "#111111",
  secondary: "#222222",
  background: "#333333",
  trackTitle: "Untitled",
  trackArtist: "Artist",
};
const style = (colors) => ({ mode: "ring", particleMode: "stardust", ...colors });
const settingsWith = (colors) => ({ ...DEFAULT_SETTINGS, ...colors });
const preset = (id, name, settings, pinned = false, quickLookOrder = 0, revision = 1) => ({
  id,
  name,
  settings,
  pinned,
  quickLookOrder,
  revision,
  createdAt: 1,
  updatedAt: 1,
});
const clone = (value) => structuredClone(value);

function makeLibrary(initialPresets) {
  const library = {
    presets: [...initialPresets],
    pinnedPresets: initialPresets.filter((item) => item.pinned),
    loading: false,
    search: "",
    signin: null,
    error: null,
    cursor: null,
    setSearch() {},
    async refresh() {},
    async refreshPinned() {},
    async loadMore() {},
    async remove() {},
    async update(id, patch) {
      const current =
        library.presets.find((item) => item.id === id) ??
        library.pinnedPresets.find((item) => item.id === id);
      const updated = {
        ...current,
        ...patch,
        settings: remoteC.settings,
        revision: current.revision + 1,
      };
      library.presets = library.presets.map((item) => (item.id === id ? updated : item));
      if (!library.presets.some((item) => item.id === id)) library.presets.push(updated);
      library.pinnedPresets = library.pinnedPresets.filter((item) => item.id !== id);
      if (updated.pinned) library.pinnedPresets.push(updated);
      library.pinnedPresets.sort((a, b) => a.quickLookOrder - b.quickLookOrder);
      return updated;
    },
    async reorder(moving, neighbor) {
      const moved = {
        ...moving,
        settings: remoteC.settings,
        quickLookOrder: neighbor.quickLookOrder,
        revision: moving.revision + 1,
      };
      const shifted = {
        ...neighbor,
        quickLookOrder: moving.quickLookOrder,
        revision: neighbor.revision + 1,
      };
      const update = (item) =>
        item.id === moved.id ? moved : item.id === shifted.id ? shifted : item;
      library.presets = library.presets.map(update);
      library.pinnedPresets = library.pinnedPresets
        .map(update)
        .sort((a, b) => a.quickLookOrder - b.quickLookOrder);
      return [moved, shifted];
    },
  };
  return library;
}

const originalA = preset(
  "active-look",
  "Look A",
  style({ primary: "#aa0000", secondary: "#00aa00", background: "#0000aa" }),
);
const remoteC = preset(
  "active-look",
  "Look A",
  style({ primary: "#cc0000", secondary: "#00cc00", background: "#0000cc" }),
  true,
  0,
  2,
);
const editedB = style({ primary: "#bb0000", secondary: "#00bb00", background: "#0000bb" });
const savedB = preset("active-look", "Saved B", editedB, true, 0, 4);

let actualPresetDialog;
const stubComponent = () => null;
const icons = new Proxy({}, { get: () => stubComponent });
const presetSaveDialogStub = () => null;
const customizerPanelStub = () => null;
const actualHomeConstants = compileTsx("../components/Home/const.ts", (id) => {
  throw new Error(`Unexpected Home constants import: ${id}`);
});

const uiDialog = {
  Dialog: stubComponent,
  DialogContent: stubComponent,
  DialogDescription: stubComponent,
  DialogHeader: stubComponent,
  DialogTitle: stubComponent,
};
const uiAlertDialog = {
  AlertDialog: stubComponent,
  AlertDialogContent: stubComponent,
  AlertDialogHeader: stubComponent,
  AlertDialogTitle: stubComponent,
  AlertDialogDescription: stubComponent,
  AlertDialogFooter: stubComponent,
  AlertDialogCancel: stubComponent,
};
const presetComponentMocks = (id) => {
  if (id === "react") return reactMock;
  if (id === "lucide-react") return icons;
  if (id === "@/components/ui/Dialog") return uiDialog;
  if (id === "@/components/ui/AlertDialog") return uiAlertDialog;
  if (id === "@/components/PresetSaveDialog") return { PresetSaveDialog: presetSaveDialogStub };
  if (id === "@/lib/persistence/preset-store")
    return { PresetStoreError: class PresetStoreError extends Error {} };
  if (id === "@/lib/visual/presets") return { visualModeName: () => "Pulse Ring" };
  throw new Error(`Unexpected PresetDialog import: ${id}`);
};
actualPresetDialog = compileTsx(
  "../components/PresetDialog/index.tsx",
  presetComponentMocks,
).PresetDialog;

const library = makeLibrary([originalA]);
const appHooks = new HookHarness();
const mediaSnapshot = {
  media: null,
  video: null,
  audioContext: null,
  sound: null,
  features: null,
  live: null,
  logo: null,
  background: null,
  duration: 0,
  file: null,
  playing: false,
  generation: 0,
};
const mediaSessionOwner = { snapshot: mediaSnapshot, requestGeneration: 0, pause() {} };
const appMockRequire = (id) => {
  if (id === "react") return reactMock;
  if (id === "lucide-react") return icons;
  if (id === "@/lib/export/export-settings")
    return {
      DEFAULT_EXPORT_FRAME_RATE: 30,
      DEFAULT_EXPORT_RESOLUTION: 720,
      exportDimensions: () => ({ width: 1280, height: 720 }),
    };
  if (id === "@/components/ui/Slider") return { Slider: stubComponent };
  if (id === "@/components/ui/Drawer")
    return {
      Drawer: stubComponent,
      DrawerContent: stubComponent,
      DrawerDescription: stubComponent,
      DrawerHandle: stubComponent,
      DrawerHeader: stubComponent,
      DrawerTitle: stubComponent,
    };
  if (id === "@/components/ui/Dialog") return uiDialog;
  if (id === "@/components/CustomizerPanel") return { CustomizerPanel: customizerPanelStub };
  if (id === "@/components/ExportDialog") return { ExportDialog: stubComponent };
  if (id === "@/components/PresetDialog") return { PresetDialog: actualPresetDialog };
  if (id === "@/lib/visual/presets")
    return {
      applyPreset: (current, next) => ({
        ...clone(next),
        trackTitle: current.trackTitle,
        trackArtist: current.trackArtist,
      }),
      presetStyle: (value) => {
        const { trackTitle, trackArtist, ...rest } = value;
        void trackTitle;
        void trackArtist;
        return rest;
      },
    };
  if (id === "@/lib/visual/customizer-config")
    return {
      BUILTIN_LOOKS: [],
      SECTION_KEYS: { colors: ["primary", "secondary", "background"] },
      DEFAULT_SETTINGS,
    };
  if (id === "@/components/QuickLookStrip") return { QuickLookStrip: stubComponent };
  if (id === "@/components/PresetSaveDialog") return { PresetSaveDialog: presetSaveDialogStub };
  if (id === "@/components/Home/const") return actualHomeConstants;
  if (id === "@/components/SubtitleWorkspace")
    return { SubtitleWorkspace: stubComponent };
  if (id === "@/lib/hooks/use-presets") return { usePresets: () => library };
  if (id === "@/lib/hooks/use-settings-history")
    return {
      useSettingsHistory(initial) {
        const [value, setValue] = reactMock.useState(initial);
        return {
          value,
          setValue,
          resetValue: setValue,
          undo() {},
          redo() {},
          canUndo: false,
          canRedo: false,
        };
      },
    };
  if (id === "@/lib/hooks/use-media-session")
    return {
      useMediaSession: () => ({
        session: mediaSessionOwner,
        snapshot: mediaSnapshot,
        file: null,
        duration: 0,
        position: 0,
        playing: false,
        loadingMedia: false,
        logoName: null,
        logoUrl: null,
        backgroundName: null,
        backgroundUrl: null,
        generation: 0,
        requestGeneration: 0,
        loadFile: async () => false,
        seek() {},
        togglePlay: async () => false,
        previewRange: async () => false,
        pollPosition() {},
        changeLogo: async () => false,
        changeBackground: async () => false,
        setVolume() {},
        setLoop() {},
      }),
    };
  if (id === "@/lib/hooks/use-visualizer-preview")
    return {
      useVisualizerPreview: () => ({ captureImage() {}, reducedMotionRef: { current: false } }),
    };
  if (id === "@/lib/hooks/use-export-controller")
    return {
      useExportController: () => ({
        exporting: false,
        progress: null,
        exportVideo() {},
        cancelExport() {},
      }),
    };
  if (id === "@/components/SubtitleDialog")
    return { SubtitleDialog: stubComponent, SubtitleEditor: stubComponent };
  if (id === "@/components/SubtitleGenerationPanel")
    return { SubtitleGenerationStatus: stubComponent };
  if (id === "@/lib/hooks/use-subtitle-generation")
    return { useSubtitleGeneration: () => ({ running: false }) };
  if (id === "@/lib/audio/audio-features")
    return {
      PcmFeatures: class {},
      audibleMediaTime: () => 0,
      dropEnvelope: () => 0,
      prepareSound: () => null,
    };
  if (id === "@/lib/audio/audio-analysis-config") return { ANALYSIS_FPS: 30 };
  if (id === "@/lib/media/local-image") return { readLocalImage: async () => null };
  if (id === "@/lib/audio/live-sound") return { LiveSound: class {} };
  if (id === "@/components/TrackWaveform") return { TrackWaveform: stubComponent };
  if (id === "@/lib/visual/visualizer")
    return {
      createAudioReactiveState: () => ({}),
      drawVisualization() {},
      soundResponse() {},
      warmSoundResponse() {},
      makeParticles: () => [],
    };
  if (id === "@/lib/persistence/project-file")
    return { makeProjectFile() {}, readProjectFile() {} };
  if (id === "@/lib/time") return { formatTimestamp: () => "0:00" };
  if (id === "@/lib/subtitles/model") return {};
  throw new Error(`Unexpected page import: ${id}`);
};

const Home = compileTsx("../components/Home/index.tsx", appMockRequire).default;
const renderHome = () => {
  activeHarness = appHooks;
  return appHooks.render(() => Home());
};
const renderPresetDialog = (props, harness = new HookHarness()) => {
  activeHarness = harness;
  return { harness, tree: harness.render(() => actualPresetDialog(props)) };
};

function visit(node, callback) {
  if (Array.isArray(node)) {
    for (const item of node) visit(item, callback);
    return;
  }
  if (!node || typeof node !== "object") return;
  callback(node);
  visit(node.props?.children, callback);
}
function find(node, predicate, message) {
  let result;
  visit(node, (item) => {
    if (!result && predicate(item)) result = item;
  });
  assert.ok(result, message);
  return result;
}
function textContent(value) {
  if (Array.isArray(value)) return value.map(textContent).join("");
  if (value && typeof value === "object") return textContent(value.props?.children);
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}
async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

test("preset metadata refresh keeps the applied snapshot and routes explicit saves and applies correctly", async (t) => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { matchMedia: () => ({ matches: true }) },
  });
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else delete globalThis.window;
  });
  renderHome();
  const settingsSlot = appHooks.stateSlots[0];
  const activeLookSlot = appHooks.stateSlots[1];
  appHooks.hooks[settingsSlot] = settingsWith(editedB);
  appHooks.hooks[activeLookSlot] = {
    id: originalA.id,
    name: originalA.name,
    settings: clone(originalA.settings),
    preset: originalA,
  };

  const currentTree = renderHome();
  let presetElement = find(
    currentTree,
    (node) => node.type === actualPresetDialog,
    "the page did not render the real preset dialog",
  );
  assert.equal(
    typeof presetElement.props.onMetadataChanged,
    "function",
    "the page must wire its metadata-only callback",
  );
  assert.equal(
    typeof presetElement.props.onSaved,
    "function",
    "the page must keep its settings-save callback",
  );

  const metadataActions = [
    {
      label: "Pin Look A to Quick Looks",
      run: async (button) => {
        button.props.onClick();
        await settle();
      },
    },
    {
      label: "Remove Look A from Quick Looks",
      run: async (button) => {
        button.props.onClick();
        await settle();
      },
    },
  ];
  for (const action of metadataActions) {
    const rendered = renderPresetDialog(presetElement.props);
    const button = find(
      rendered.tree,
      (node) => node.type === "button" && node.props["aria-label"] === action.label,
      `missing ${action.label} action`,
    );
    await action.run(button);
    assert.deepEqual(
      appHooks.hooks[settingsSlot],
      settingsWith(editedB),
      `${action.label} changed the editor settings`,
    );
    assert.deepEqual(
      appHooks.hooks[activeLookSlot].settings,
      originalA.settings,
      `${action.label} replaced the applied snapshot with refreshed preset settings`,
    );
  }

  // Pin again so the active preset has a neighbor and can be reordered.
  const repinTree = renderHome();
  presetElement = find(
    repinTree,
    (node) => node.type === actualPresetDialog,
    "missing preset dialog after pin metadata updates",
  );
  const repin = renderPresetDialog(presetElement.props);
  const repinButton = find(
    repin.tree,
    (node) => node.type === "button" && node.props["aria-label"] === "Pin Look A to Quick Looks",
    "missing repin action",
  );
  repinButton.props.onClick();
  await settle();
  const neighbor = preset(
    "neighbor",
    "Neighbor",
    style({ primary: "#555555", secondary: "#666666", background: "#777777" }),
    true,
    1,
  );
  library.presets.push(neighbor);
  library.pinnedPresets.push(neighbor);

  let actionTree = renderHome();
  presetElement = find(
    actionTree,
    (node) => node.type === actualPresetDialog,
    "missing preset dialog before reorder",
  );
  let renderedDialog = renderPresetDialog(presetElement.props);
  let moveButton = find(
    renderedDialog.tree,
    (node) => node.type === "button" && node.props["aria-label"] === "Move Look A down",
    "missing reorder action",
  );
  moveButton.props.onClick();
  await settle();
  assert.deepEqual(
    appHooks.hooks[settingsSlot],
    settingsWith(editedB),
    "reordering changed the editor settings",
  );
  assert.deepEqual(
    appHooks.hooks[activeLookSlot].settings,
    originalA.settings,
    "reordering replaced the applied snapshot",
  );

  // Rename through the rendered form, including its state updates and async request.
  actionTree = renderHome();
  presetElement = find(
    actionTree,
    (node) => node.type === actualPresetDialog,
    "missing preset dialog before rename",
  );
  renderedDialog = renderPresetDialog(presetElement.props);
  let renameButton = find(
    renderedDialog.tree,
    (node) => node.type === "button" && node.props["aria-label"] === "Rename Look A",
    "missing rename action",
  );
  renameButton.props.onClick();
  renderedDialog = renderPresetDialog(presetElement.props, renderedDialog.harness);
  let nameInput = find(
    renderedDialog.tree,
    (node) => node.type === "input" && typeof node.props.value === "string",
    "missing rename field",
  );
  nameInput.props.onChange({ target: { value: "Renamed A" } });
  renderedDialog = renderPresetDialog(presetElement.props, renderedDialog.harness);
  const renameForm = find(
    renderedDialog.tree,
    (node) => node.type === "form",
    "missing rename form",
  );
  renameForm.props.onSubmit({ preventDefault() {} });
  await settle();
  assert.deepEqual(
    appHooks.hooks[settingsSlot],
    settingsWith(editedB),
    "renaming changed the editor settings",
  );
  assert.deepEqual(
    appHooks.hooks[activeLookSlot].settings,
    originalA.settings,
    "renaming replaced the applied snapshot",
  );

  // Section reset still uses A after the preset's remote settings have refreshed to C.
  actionTree = renderHome();
  const customizer = find(
    actionTree,
    (node) => node.type === customizerPanelStub,
    "the page did not render its customizer",
  );
  customizer.props.onResetSection("colors");
  assert.equal(appHooks.hooks[settingsSlot].primary, originalA.settings.primary);
  assert.equal(appHooks.hooks[settingsSlot].secondary, originalA.settings.secondary);
  assert.equal(appHooks.hooks[settingsSlot].background, originalA.settings.background);
  assert.equal(appHooks.hooks[settingsSlot].trackTitle, DEFAULT_SETTINGS.trackTitle);

  // Applying the remote C snapshot explicitly changes the reset baseline to C.
  actionTree = renderHome();
  presetElement = find(
    actionTree,
    (node) => node.type === actualPresetDialog,
    "missing preset dialog before explicit apply",
  );
  renderedDialog = renderPresetDialog(presetElement.props);
  const applyButton = find(
    renderedDialog.tree,
    (node) => node.type === "button" && textContent(node.props.children) === "Apply",
    "missing explicit apply action",
  );
  applyButton.props.onClick();
  assert.equal(appHooks.hooks[activeLookSlot].settings.primary, remoteC.settings.primary);
  actionTree = renderHome();
  const customizerAfterApply = find(
    actionTree,
    (node) => node.type === customizerPanelStub,
    "missing customizer after apply",
  );
  customizerAfterApply.props.onResetSection("colors");
  assert.equal(appHooks.hooks[settingsSlot].primary, remoteC.settings.primary);
  assert.equal(appHooks.hooks[settingsSlot].secondary, remoteC.settings.secondary);
  assert.equal(appHooks.hooks[settingsSlot].background, remoteC.settings.background);

  // The nested save dialog's confirmed-save callback still installs the saved B snapshot.
  actionTree = renderHome();
  presetElement = find(
    actionTree,
    (node) => node.type === actualPresetDialog,
    "missing preset dialog before confirmed save",
  );
  renderedDialog = renderPresetDialog(presetElement.props);
  const nestedSave = find(
    renderedDialog.tree,
    (node) => node.type === presetSaveDialogStub,
    "missing nested settings-save dialog",
  );
  nestedSave.props.onSaved(savedB);
  assert.deepEqual(
    appHooks.hooks[activeLookSlot].settings,
    editedB,
    "a confirmed settings save did not update the applied snapshot",
  );
});
