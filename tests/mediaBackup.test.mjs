import test from "node:test";
import assert from "node:assert/strict";
import {
  backupManifestStatus,
  buildMediaArchive,
  buildStorageObjectPath,
  findUniqueStableMatch,
  makeStorageRef,
  parseDataUrl,
  parseStorageLocator,
  selectLegacyMediaForMigration,
  validateBackupMediaSize,
} from "../mediaBackup.js";

test("new uploads stay inside the private bucket's media policy prefix", () => {
  assert.equal(
    buildStorageObjectPath({ kind: "documents", clientId: "client 42", name: "Signed Contract.pdf", mime: "application/pdf", now: 123, nonce: "abc" }),
    "media/documents/client-42/123-abc-Signed-Contract.pdf",
  );
  assert.equal(buildStorageObjectPath({ kind: "../videos", clientId: "../", name: "clip", mime: "video/mp4", now: 1, nonce: "x" }), "media/videos/file/1-x-clip.mp4");
});

test("durable and legacy Supabase Storage locations resolve to the same object", () => {
  const ref = makeStorageRef("client-media", "photos/client 1/a.jpg");
  const expected = { bucket: "client-media", path: "photos/client 1/a.jpg", ref };
  assert.deepEqual(parseStorageLocator(ref), expected);
  assert.deepEqual(parseStorageLocator("https://demo.supabase.co/storage/v1/object/public/client-media/photos/client%201/a.jpg"), expected);
  assert.deepEqual(parseStorageLocator("https://demo.supabase.co/storage/v1/object/sign/client-media/photos/client%201/a.jpg?token=secret"), expected);
  assert.deepEqual(parseStorageLocator("https://demo.supabase.co/storage/v1/object/authenticated/client-media/photos/client%201/a.jpg"), expected);
  assert.equal(parseStorageLocator("https://example.com/photo.jpg"), null);
});

test("data URL parser accepts real base64 media and rejects unrelated strings", () => {
  assert.deepEqual(parseDataUrl("data:image/png;base64,YWJj"), { mime: "image/png", b64: "YWJj", size: 3 });
  assert.equal(parseDataUrl("data:image/png;base64,YQ==").size, 1);
  assert.equal(parseDataUrl("data:text/plain,hello"), null);
  assert.equal(parseDataUrl("hello"), null);
});

test("full media archive embeds inline and Storage media and deduplicates references", async () => {
  const storageRef = makeStorageRef("client-media", "photos/a.jpg");
  const inline = "data:image/png;base64,YWJj";
  let downloads = 0;
  const result = await buildMediaArchive({
    clients: [{ sitePhotos: [{ src: storageRef }, { src: storageRef }], documents: [{ src: inline }] }],
  }, {
    includeMedia: true,
    loadStorage: async locator => {
      downloads += 1;
      assert.equal(locator.path, "photos/a.jpg");
      return { b64: "ZGVm", mime: "image/jpeg", size: 3 };
    },
  });

  assert.equal(downloads, 1);
  assert.equal(result.candidateCount, 3);
  assert.equal(result.uniqueMediaCount, 2);
  assert.equal(result.media.length, 2);
  assert.equal(result.failures.length, 0);
  assert.equal(result.refData.clients[0].sitePhotos[0].src._media, result.refData.clients[0].sitePhotos[1].src._media);
  assert.equal(result.refData.clients[0].sitePhotos[0].src._storageRef, storageRef);
  assert.match(result.refData.clients[0].documents[0].src._media, /\.png$/);
});

test("failed Storage download is explicit and cannot be counted as captured media", async () => {
  const storageRef = makeStorageRef("client-media", "documents/missing.pdf");
  const result = await buildMediaArchive({ doc: storageRef }, {
    includeMedia: true,
    loadStorage: async () => { throw new Error("object not found"); },
  });

  assert.equal(result.uniqueMediaCount, 1);
  assert.equal(result.media.length, 0);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].source, "client-media/documents/missing.pdf");
  assert.equal(result.refData.doc._missing, true);
  assert.equal(result.refData.doc._storageRef, storageRef);
});

test("full archive captures external URLs only in known media fields", async () => {
  const external = "https://files.example.test/customer/photo.jpg?temporary=secret";
  let downloads = 0;
  const result = await buildMediaArchive({
    sps_clients: [{ id: "c1", sitePhotos: [{ src: external }] }],
    sps_branding: { companyWebsite: "https://www.example.test", googleReviewLink: "https://reviews.example.test" },
  }, {
    includeMedia: true,
    loadStorage: async () => { throw new Error("not storage"); },
    loadExternal: async (url) => {
      downloads += 1;
      assert.equal(url, external);
      return { b64: "YWJj", mime: "image/jpeg", size: 3 };
    },
  });

  assert.equal(downloads, 1);
  assert.equal(result.uniqueMediaCount, 1);
  assert.equal(result.media[0].source, "https://files.example.test/customer/photo.jpg");
  assert.equal(result.refData.sps_clients[0].sitePhotos[0].src._externalRef, external);
  assert.equal(result.refData.sps_branding.companyWebsite, "https://www.example.test");
  assert.equal(result.refData.sps_branding.googleReviewLink, "https://reviews.example.test");
});

test("external links in media captions and document notes remain ordinary data", async () => {
  const photo = "https://files.example.test/customer/photo.jpg";
  const captionLink = "https://example.test/details";
  const document = "https://files.example.test/customer/contract.pdf";
  const noteLink = "https://signing.example.test/audit";
  const downloaded = [];
  const result = await buildMediaArchive({
    sps_clients: [{
      sitePhotos: [{ src: photo, caption: captionLink }],
      documents: [{ src: document, note: noteLink }],
    }],
  }, {
    includeMedia: true,
    loadStorage: async () => { throw new Error("not storage"); },
    loadExternal: async (url) => {
      downloaded.push(url);
      return { b64: "YWJj", mime: url.endsWith(".pdf") ? "application/pdf" : "image/jpeg", size: 3 };
    },
  });

  assert.deepEqual(downloaded, [photo, document]);
  assert.equal(result.refData.sps_clients[0].sitePhotos[0].caption, captionLink);
  assert.equal(result.refData.sps_clients[0].documents[0].note, noteLink);
});

test("stable media matching requires one owner and can disambiguate with a stronger key", () => {
  const candidates = [
    { id: "duplicate", sid: "stop-a", src: "a" },
    { id: "duplicate", sid: "stop-b", src: "b" },
  ];
  assert.equal(findUniqueStableMatch(candidates, { id: "duplicate" }, ["id"]), null);
  assert.equal(findUniqueStableMatch(candidates, { id: "duplicate", sid: "stop-b" }, ["id", "sid"]), candidates[1]);
  assert.equal(findUniqueStableMatch(candidates, { id: "missing" }, ["id"]), null);
  assert.equal(findUniqueStableMatch(candidates, { id: "duplicate", sid: "stop-b" }, ["sid", "id"]), candidates[1]);
  assert.equal(findUniqueStableMatch([
    { id: "client-a", sid: "stop-a" },
    { id: "client-b", sid: "stop-b" },
  ], { id: "client-a", sid: "stop-b" }, ["id", "sid"]), null);
});

test("backup media validation rejects empty and mis-sized archive entries", () => {
  assert.equal(validateBackupMediaSize("media/one.jpg", 3, 3), 3);
  assert.throws(() => validateBackupMediaSize("media/empty.jpg", 0, 0), /empty/);
  assert.throws(() => validateBackupMediaSize("media/truncated.pdf", 3, 10), /wrong size/);
});

test("legacy document migration never resurrects a deleted live document list", () => {
  const oldDocuments = [{ id: "deleted", src: "data:application/pdf;base64,YWJj" }];
  assert.deepEqual(selectLegacyMediaForMigration([], oldDocuments), []);
  assert.equal(selectLegacyMediaForMigration(undefined, oldDocuments), undefined);
  assert.deepEqual(selectLegacyMediaForMigration([], oldDocuments, { recoverFromBackup: true }), oldDocuments);
});

test("data-only archive leaves references but never downloads or claims media bytes", async () => {
  const storageRef = makeStorageRef("client-media", "videos/a.mp4");
  const result = await buildMediaArchive({ video: storageRef }, {
    includeMedia: false,
    loadStorage: async () => { throw new Error("must not be called"); },
  });
  assert.equal(result.media.length, 0);
  assert.equal(result.failures.length, 0);
  assert.equal(result.refData.video._storageRef, storageRef);
});

test("only v2 manifests with zero failures qualify as verified full backups", () => {
  assert.deepEqual(backupManifestStatus({ backupVersion: 2, dataOnly: false, mediaComplete: true, mediaFailedCount: 0 }), {
    dataOnly: false, failures: 0, complete: true, verified: true,
  });
  assert.equal(backupManifestStatus({ backupVersion: 1, dataOnly: false }).complete, false);
  assert.equal(backupManifestStatus({ backupVersion: 2, dataOnly: false, mediaComplete: false, mediaFailedCount: 1 }).complete, false);
  assert.equal(backupManifestStatus({ backupVersion: 2, dataOnly: true }).complete, true);
});
