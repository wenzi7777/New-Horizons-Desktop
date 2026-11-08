import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

async function load() {
  const server = await createServer({ root: process.cwd(), logLevel: "error" });
  try {
    return await server.ssrLoadModule("/src/lib/releaseNotes.ts");
  } finally {
    await server.close();
  }
}

const notes = await load();

test("translated notes URL sits beside the original", () => {
  const url = "https://raw.githubusercontent.com/x/New-Horizons-OS/v1.18.0/releases/notes/v1.18.0.md";
  assert.equal(notes.localizedNotesUrl(url, "ja"), url.replace(/\.md$/, ".ja.md"));
  assert.equal(notes.localizedNotesUrl(url, "en"), url.replace(/\.md$/, ".en.md"));
  assert.equal(notes.localizedNotesUrl(url, "zh-CN"), null);
  assert.equal(notes.localizedNotesUrl("https://x/notes/v1.2.0-beta.1.md", "en"), "https://x/notes/v1.2.0-beta.1.en.md");
  assert.equal(notes.localizedNotesUrl("https://x/notes/v1.2.0.ja.md", "en"), null);
  assert.equal(notes.localizedNotesUrl("https://x/notes.txt", "en"), null);
});

function fakeFetch(files) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    if (!(url in files)) return new Response("", { status: 404 });
    return new Response(files[url], { status: 200 });
  };
  return { impl, calls };
}

test("fetch prefers the translation and falls back to the original", async () => {
  const base = "https://x/notes/v1.0.0.md";
  const both = fakeFetch({ [base]: "# 中文", "https://x/notes/v1.0.0.ja.md": "# 日本語" });
  assert.equal(await notes.fetchReleaseNotes(base, "ja", both.impl), "# 日本語");
  const onlyBase = fakeFetch({ [base]: "# 中文" });
  assert.equal(await notes.fetchReleaseNotes(base, "en", onlyBase.impl), "# 中文");
  assert.deepEqual(onlyBase.calls, ["https://x/notes/v1.0.0.en.md", base]);
  const zh = fakeFetch({ [base]: "# 中文" });
  assert.equal(await notes.fetchReleaseNotes(base, "zh-CN", zh.impl), "# 中文");
  assert.deepEqual(zh.calls, [base]);
  await assert.rejects(notes.fetchReleaseNotes(base, "en", fakeFetch({}).impl), /http_404/);
});

test("note files group by version with a language each", () => {
  const grouped = notes.groupNotesByVersion([
    { name: "v1.2.3.md", value: "zh" },
    { name: "v1.2.3.ja.md", value: "ja" },
    { name: "v1.2.3.en.md", value: "en" },
    { name: "v1.2.0-beta.1.md", value: "beta" },
    { name: "README.md", value: "x" },
  ]);
  assert.deepEqual([...grouped.keys()].sort(), ["v1.2.0-beta.1", "v1.2.3"]);
  assert.equal(notes.pickNotes(grouped.get("v1.2.3"), "ja"), "ja");
  assert.equal(notes.pickNotes(grouped.get("v1.2.3"), "zh-CN"), "zh");
  assert.equal(notes.pickNotes(grouped.get("v1.2.0-beta.1"), "en"), "beta");
});
