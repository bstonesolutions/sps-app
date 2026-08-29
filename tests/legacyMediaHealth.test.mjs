import test from "node:test";
import assert from "node:assert/strict";
import { approximateDataUrlBytes, inspectLegacyMediaHealth } from "../legacyMediaHealth.js";

test("counts inline media in every known client location", () => {
  const clients = [{
    sitePhotos: ["data:image/png;base64,YWJj", { src: "data:image/jpeg;base64,YQ==" }],
    siteVideos: [{ url: "data:video/mp4;base64,YWI=" }],
    documents: [{ src: "sps-storage://client-media/media/document.pdf" }, { src: "data:application/pdf;base64,YWJjZA==" }],
    history: [
      { photos: ["data:image/png;base64,YQ==", "data:image/png;base64,YWI="] },
      { photos: ["https://example.test/photo.jpg"] },
    ],
    equipment: [
      { photos: [{ src: "data:image/png;base64,YWJj" }] },
      { photos: [] },
    ],
  }, {
    sitePhotos: ["https://example.test/other.jpg"],
    history: [{ photos: ["data:text/plain,hello%20world"] }],
  }];

  assert.deepEqual(inspectLegacyMediaHealth(clients), {
    inlineDataUrlCount: 8,
    approximateDecodedBytes: 27,
    affectedClientCount: 2,
    affectedHistoryRowCount: 2,
    affectedEquipmentRowCount: 1,
    malformedDataUrlCount: 0,
    inspectedMediaEntryCount: 11,
    truncated: false,
  });
});

test("approximates base64 and percent-encoded payloads without decoding them", () => {
  assert.deepEqual(approximateDataUrlBytes("data:image/png;base64,YWJj"), { bytes: 3, malformed: false, truncated: false });
  assert.deepEqual(approximateDataUrlBytes("data:image/png;base64,YQ=="), { bytes: 1, malformed: false, truncated: false });
  assert.deepEqual(approximateDataUrlBytes("data:text/plain,hello%20world"), { bytes: 11, malformed: false, truncated: false });
  assert.deepEqual(approximateDataUrlBytes("not inline media"), { bytes: 0, malformed: false, truncated: false });
});

test("malformed data URLs are reported and never throw", () => {
  const result = inspectLegacyMediaHealth([{
    sitePhotos: [
      "data:image/png;base64",
      "data:image/png;base64,%%%",
      "data:text/plain,bad%2",
    ],
  }]);

  assert.equal(result.inlineDataUrlCount, 3);
  assert.equal(result.malformedDataUrlCount, 3);
  assert.equal(result.affectedClientCount, 1);
  assert.equal(result.truncated, false);
});

test("malformed and cyclic client structures stop safely", () => {
  const cyclicMedia = [];
  cyclicMedia.push(cyclicMedia, { get src() { throw new Error("bad getter"); } });
  const cyclicClient = { sitePhotos: cyclicMedia, history: [], equipment: [] };
  cyclicClient.history.push(cyclicClient.history, { photos: ["data:image/png;base64,YQ=="] });
  cyclicClient.equipment.push(cyclicClient, { photos: ["data:image/png;base64,YWI="] });

  assert.doesNotThrow(() => inspectLegacyMediaHealth([null, 42, cyclicClient]));
  const result = inspectLegacyMediaHealth([null, 42, cyclicClient]);
  assert.equal(result.inlineDataUrlCount, 2);
  assert.equal(result.affectedClientCount, 1);
  assert.equal(result.affectedHistoryRowCount, 1);
  assert.equal(result.affectedEquipmentRowCount, 1);
});

test("bounded scans report truncation instead of walking unbounded records", () => {
  const clients = [{ sitePhotos: [
    "data:image/png;base64,YQ==",
    "data:image/png;base64,YWI=",
    "data:image/png;base64,YWJj",
  ] }];
  const entryLimited = inspectLegacyMediaHealth(clients, { maxMediaEntries: 2 });
  assert.equal(entryLimited.inlineDataUrlCount, 2);
  assert.equal(entryLimited.truncated, true);

  const characterLimited = inspectLegacyMediaHealth(clients, { maxDataUrlCharacters: 2 });
  assert.equal(characterLimited.inlineDataUrlCount, 1);
  assert.equal(characterLimited.approximateDecodedBytes, 1);
  assert.equal(characterLimited.truncated, true);

  const clientLimited = inspectLegacyMediaHealth([
    { sitePhotos: [] },
    { sitePhotos: ["data:image/png;base64,YQ=="] },
  ], { maxClientRecords: 1 });
  assert.equal(clientLimited.inlineDataUrlCount, 0);
  assert.equal(clientLimited.truncated, true);
});

test("non-array roots return an empty health snapshot", () => {
  assert.deepEqual(inspectLegacyMediaHealth({ sitePhotos: ["data:image/png;base64,YQ=="] }), {
    inlineDataUrlCount: 0,
    approximateDecodedBytes: 0,
    affectedClientCount: 0,
    affectedHistoryRowCount: 0,
    affectedEquipmentRowCount: 0,
    malformedDataUrlCount: 0,
    inspectedMediaEntryCount: 0,
    truncated: false,
  });
});
