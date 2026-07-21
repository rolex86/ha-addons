import test from "node:test";
import assert from "node:assert/strict";
import { createBatches, normalizeSubtitle, renderSrt } from "../src/subtitle-format.js";

test("normalizes SRT and preserves timing while translating only text", () => {
  const cues = normalizeSubtitle(
    "1\r\n00:00:01,000 --> 00:00:03,000\r\nExample text\r\n", "srt");
  assert.deepEqual(cues, [{
    id: "cue-000001",
    timing: "00:00:01,000 --> 00:00:03,000",
    text: "Example text",
  }]);
  assert.equal(renderSrt(cues, [{ id: "cue-000001", text: "Příklad textu" }]),
    "1\n00:00:01,000 --> 00:00:03,000\nPříklad textu\n");
});

test("normalizes WebVTT timestamps and ignores NOTE blocks", () => {
  const cues = normalizeSubtitle(
    "WEBVTT\n\nNOTE metadata\nignored\n\ncaption-id\n00:01.500 --> 00:03.000 align:start\nHello\n", "vtt");
  assert.equal(cues.length, 1);
  assert.equal(cues[0].timing, "00:00:01,500 --> 00:00:03,000");
  assert.equal(cues[0].text, "Hello");
});

test("batches cues without losing stable IDs", () => {
  const cues = Array.from({ length: 5 }, (_, index) => ({
    id: `cue-${index}`, timing: "00:00:00,000 --> 00:00:01,000", text: "text",
  }));
  assert.deepEqual(createBatches(cues, 2, 100).map(batch => batch.length), [2, 2, 1]);
});

test("rejects missing or reordered translation IDs", () => {
  const cues = normalizeSubtitle("1\n00:00:01,000 --> 00:00:02,000\nHello", "srt");
  assert.throws(() => renderSrt(cues, [{ id: "wrong", text: "Ahoj" }]), /MISSING_TRANSLATION/);
});
