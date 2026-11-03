import assert from "node:assert/strict";
import { test } from "node:test";
import { noWelshHint } from "../hints.ts";
import { looksUntranslatable } from "../scan.ts";

test("noWelshHint suggests no Welsh for an address, by its key or by a postcode", () => {
  assert.match(noWelshHint("Rolls Building", "en.locationLine1") ?? "", /address/);
  assert.match(noWelshHint("2 Clove Crescent", "en.venueAddressLines.1") ?? "", /address/);
  assert.match(noWelshHint("London EC2V 5AR", "en.line4") ?? "", /address/);
});

test("noWelshHint suggests no Welsh for a cookie's name, a system's name and text built by code", () => {
  assert.match(noWelshHint("dtCookie", "en.sections.performance.cookies.0.0.text") ?? "", /cookie/);
  assert.match(noWelshHint("ServiceNow", "en.linkText") ?? "", /product or system/);
  // biome-ignore lint/suspicious/noTemplateCurlyInString: text a scan read out of code, ${…} and all, is what this checks
  assert.match(noWelshHint("${OPEN_JUSTICE_PREAMBLE}\\n${OBSERVER_INSTRUCTIONS}", "en.info") ?? "", /code/);
});

test("noWelshHint leaves words people read as content", () => {
  assert.equal(noWelshHint("Search by case name, date, judge, or other details", "en.searchCasesLabel"), null);
  assert.equal(noWelshHint("Panel: ", "en.panel"), null);
  assert.equal(noWelshHint("About this cookie policy", "en.cookies.heading"), null);
});

test("looksUntranslatable treats a link to a field on the page as never content", () => {
  assert.equal(looksUntranslatable("#subscriptions"), true);
  assert.equal(looksUntranslatable("#confirm-bulk"), true);
  assert.equal(looksUntranslatable("# of cases"), false);
});
