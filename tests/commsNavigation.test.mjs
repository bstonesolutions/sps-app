import test from "node:test";
import assert from "node:assert/strict";
import { initialCommsSection, primaryCommsSections } from "../commsPriority.js";

const sections = [
  { id: "messages", label: "Chat" },
  { id: "inbox", label: "Leads" },
  { id: "email", label: "Inbox" },
  { id: "settings", label: "Settings" },
];
const focusedSections = [sections[1], sections[2], sections[3]];

test("focused Comms opens Leads even when this device last used Inbox or Settings", () => {
  for (const rememberedSection of ["email", "settings", "inbox", undefined]) {
    assert.equal(initialCommsSection({ sections: focusedSections, rememberedSection }), "inbox");
  }
  assert.deepEqual(primaryCommsSections(focusedSections).map(section => section.label), ["Leads", "Inbox"]);
});

test("explicit Comms destinations retain priority in focused and full modes", () => {
  for (const focused of [true, false]) {
    for (const initialSection of ["email", "inbox", "settings"]) {
      assert.equal(initialCommsSection({ sections: focused ? focusedSections : sections, focused, initialSection, rememberedSection: "inbox" }), initialSection);
    }
  }
});

test("full Comms keeps its remembered destination and compact navigation order", () => {
  assert.equal(initialCommsSection({ sections, focused: false, rememberedSection: "email" }), "email");
  assert.equal(initialCommsSection({ sections, focused: false, rememberedSection: "settings" }), "settings");
  assert.equal(initialCommsSection({ sections, focused: false, rememberedSection: "unavailable" }), "messages");
  assert.deepEqual(primaryCommsSections(sections, false).map(section => section.id), ["email", "messages", "inbox"]);
});

test("Comms navigation never adds a section outside the caller's permitted set", () => {
  const textsOnly = [{ id: "email", label: "Texts" }];
  assert.equal(initialCommsSection({ sections: textsOnly, initialSection: "inbox", rememberedSection: "inbox" }), "email");
  assert.deepEqual(primaryCommsSections(textsOnly), textsOnly);
  assert.deepEqual(primaryCommsSections(textsOnly, false), textsOnly);
  const settingsOnly = [{ id: "settings", label: "Settings" }];
  assert.equal(initialCommsSection({ sections: settingsOnly, initialSection: "email" }), "settings");
  assert.deepEqual(primaryCommsSections(settingsOnly), []);
});
