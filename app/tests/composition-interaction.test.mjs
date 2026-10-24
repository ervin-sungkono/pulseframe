import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { loadSources } from "./load-source.mjs";

const modules = await loadSources();

test("dragging and canceling preserve edits committed by another control", () => {
  const ref = { current: null };
  const source = readFileSync(
    new URL("../lib/hooks/use-composition-interaction.ts", import.meta.url),
    "utf8",
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} };
  const requireModule = (id) => {
    if (id === "react") return { useRef: () => ref };
    if (id === "../composition/model") return modules["composition/model"];
    if (id === "../composition/geometry") return modules["composition/geometry"];
    throw new Error(`Unexpected dependency: ${id}`);
  };
  new Function("require", "module", "exports", compiled)(requireModule, module, module.exports);
  const { defaultComposition, newElement } = modules["composition/model"];
  let composition = defaultComposition();
  const render = () =>
    module.exports.useCompositionInteraction({
      composition,
      mode: "ring",
      selectedId: "visualizer",
      onSelect() {},
      onChange(next) {
        composition = next;
      },
    });
  const event = {
    button: 0,
    pointerType: "mouse",
    pointerId: 1,
    clientX: 50,
    clientY: 50,
    target: { dataset: {} },
    preventDefault() {},
    currentTarget: {
      getBoundingClientRect: () => ({ x: 0, y: 0, width: 100, height: 100 }),
      focus() {},
      setPointerCapture() {},
    },
  };
  render().onPointerDown(event);
  const inserted = newElement("rectangle");
  composition = {
    ...composition,
    elements: [inserted],
    lyrics: { ...composition.lyrics, color: "#ff0000" },
  };
  render().onPointerMove({ ...event, clientX: 60 });
  assert.equal(composition.visualizers[0].transform.x, 0.6);
  assert.deepEqual(composition.elements, [inserted]);
  assert.equal(composition.lyrics.color, "#ff0000");
  render().onKeyDown({ key: "Escape" });
  assert.equal(composition.visualizers[0].transform.x, 0.5);
  assert.deepEqual(composition.elements, [inserted]);
  assert.equal(composition.lyrics.color, "#ff0000");
});
