import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

test("memoized cue rows keep playback enabled while generation locks cue editing", async () => {
  const vite = await createServer({
    root: fileURLToPath(new URL("../..", import.meta.url)),
    configFile: fileURLToPath(new URL("../../vite.config.ts", import.meta.url)),
    logLevel: "silent",
    server: { middlewareMode: true },
  });

  try {
    const { SubtitleCueRow } = await vite.ssrLoadModule("/src/components/SubtitleCueRow/index.tsx");
    assert.equal(SubtitleCueRow.$$typeof, Symbol.for("react.memo"));
    const markup = renderToStaticMarkup(
      React.createElement(SubtitleCueRow, {
        cue: { id: "cue-1", start: 1, end: 2, text: "A lyric" },
        index: 0,
        editorId: "editor",
        active: true,
        duration: 10,
        editingDisabled: true,
        previewDisabled: false,
        actions: {
          onTextChange() {},
          onStartChange() {},
          onEndChange() {},
          onRemove() {},
          onPreview() {},
          setElement() {},
        },
      }),
    );
    const buttons = [...markup.matchAll(/<button\b([^>]*)>/g)].map((match) => match[1]);
    assert.equal(buttons.length, 2);
    assert.doesNotMatch(buttons[0], /\bdisabled(?:=|\s|$)/);
    assert.match(buttons[1], /\bdisabled(?:=|\s|$)/);
    assert.match(markup, /<textarea[^>]*disabled=""/);
  } finally {
    await vite.close();
  }
});
