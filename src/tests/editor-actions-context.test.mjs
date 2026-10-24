import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

test("editor actions require a provider and remain scoped to each editor", async () => {
  const vite = await createServer({
    root: fileURLToPath(new URL("../..", import.meta.url)),
    configFile: fileURLToPath(new URL("../../vite.config.ts", import.meta.url)),
    logLevel: "silent",
    server: { middlewareMode: true },
  });

  try {
    const { EditorActionsContext, useEditorActions } = await vite.ssrLoadModule(
      "/src/lib/hooks/use-editor-actions.ts",
    );
    function ActionProbe() {
      return React.createElement("span", null, useEditorActions().label);
    }

    assert.throws(
      () => renderToStaticMarkup(React.createElement(ActionProbe)),
      /Editor actions must be used within the editor workspace/,
    );

    const first = React.createElement(
      EditorActionsContext.Provider,
      { value: { label: "first editor" } },
      React.createElement(ActionProbe),
    );
    const second = React.createElement(
      EditorActionsContext.Provider,
      { value: { label: "second editor" } },
      React.createElement(ActionProbe),
    );

    const markup = renderToStaticMarkup(React.createElement(React.Fragment, null, first, second));
    assert.match(markup, /first editor/);
    assert.match(markup, /second editor/);
  } finally {
    await vite.close();
  }
});
