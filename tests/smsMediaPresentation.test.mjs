import test from "node:test";
import assert from "node:assert/strict";

import {
  smsMediaKind,
  smsMediaLabel,
  smsMediaMimeType,
  smsMediaSizeLabel,
  smsMediaSource,
  smsVisibleBodyText,
} from "../smsMediaPresentation.js";

test("private image descriptors use mimeType even when their signed URL is opaque", () => {
  const item = {
    mimeType: "image/jpeg",
    path: "messages/example/photo.jpg",
    url: "https://supabase.test/storage/v1/object/sign/sms-media/private-token",
    size: 300_170,
  };

  assert.equal(smsMediaMimeType(item), "image/jpeg");
  assert.equal(smsMediaKind(item), "image");
  assert.equal(smsMediaSource(item), item.url);
  assert.equal(smsMediaLabel(item), "Photo");
  assert.equal(smsMediaSizeLabel(item), "293 KB");
});

test("PDF, audio, and video attachments remain identifiable and openable by source", () => {
  for (const [mimeType, kind, label] of [
    ["application/pdf", "pdf", "PDF document"],
    ["audio/mpeg", "audio", "Audio"],
    ["video/mp4", "video", "Video"],
  ]) {
    const item = { mimeType, url: "https://supabase.test/storage/v1/object/sign/sms-media/token" };
    assert.equal(smsMediaKind(item), kind);
    assert.equal(smsMediaLabel(item), label);
    assert.ok(smsMediaSource(item));
  }
});

test("the generated media note disappears only after secure media has loaded", () => {
  assert.equal(smsVisibleBodyText("[1 media attachment]", 1), "");
  assert.equal(smsVisibleBodyText("Here is the gate [1 media attachment]", 1), "Here is the gate");
  assert.equal(smsVisibleBodyText("[1 media attachment; secure copy pending]", 1), "[1 media attachment; secure copy pending]");
  assert.equal(smsVisibleBodyText("[1 media attachment]", 0), "[1 media attachment]");
});
