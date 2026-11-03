import assert from "node:assert/strict";
import { test } from "node:test";
import { CODE_HINT, leaveOutSuggested, noWelshHint } from "../hints.ts";
import { looksUntranslatable } from "../scan.ts";

test("should suggest no Welsh for a line of an address, by its key or as a town and postcode", () => {
  assert.match(noWelshHint("Rolls Building", "en.locationLine1") ?? "", /address/);
  assert.match(noWelshHint("2 Clove Crescent", "en.venueAddressLines.1") ?? "", /address/);
  assert.match(noWelshHint("102 Petty France", "en.section10.address.3") ?? "", /address/);
  assert.match(noWelshHint("London EC2V 5AR", "en.line4") ?? "", /address/);
});

test("should suggest no Welsh for a cookie's name, a system's name and text that is only placeholders", () => {
  assert.match(noWelshHint("dtCookie", "en.sections.performance.cookies.0.0.text") ?? "", /cookie/);
  assert.match(noWelshHint("TSxxxxxxxx", "en.sections.security.cookies.0.0.text") ?? "", /cookie/);
  assert.match(noWelshHint("ServiceNow", "en.linkText") ?? "", /product or system/);
  // biome-ignore lint/suspicious/noTemplateCurlyInString: text a scan read out of code, ${…} and all, is what this checks
  assert.equal(noWelshHint("${OPEN_JUSTICE_PREAMBLE}\\n${OBSERVER_INSTRUCTIONS}", "en.info"), CODE_HINT);
});

test("should leave words people read as content, placeholders, cookie links and address labels included", () => {
  assert.equal(noWelshHint("Search by case name, date, judge, or other details", "en.searchCasesLabel"), null);
  assert.equal(noWelshHint("You have {{count}} cases to review", "en.count"), null);
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a placeholder inside content is what this checks
  assert.equal(noWelshHint("Hello ${name}", "en.greeting"), null);
  assert.equal(noWelshHint("Cookies", "en.footer.cookies"), null);
  assert.equal(noWelshHint("Accept", "en.cookieBanner.accept"), null);
  assert.equal(noWelshHint("Address line 1", "en.addressLine1Label"), null);
  assert.equal(noWelshHint("Email address", "en.emailAddress"), null);
  assert.equal(noWelshHint("Postcode", "en.postcode"), null);
  assert.equal(noWelshHint("Enter a postcode, for example SW1A 1AA", "en.postcodeHint"), null);
});

test("should start a hinted string unticked only when it can be kept in English or is code", () => {
  assert.equal(leaveOutSuggested("Part of an address.", true), true);
  assert.equal(leaveOutSuggested("Part of an address.", false), false, "no Welsh at all, so left out it would have none");
  assert.equal(leaveOutSuggested(CODE_HINT, false), true);
  assert.equal(leaveOutSuggested(null, true), false);
});

test("should treat a link to a field on the page as never content", () => {
  assert.equal(looksUntranslatable("#subscriptions"), true);
  assert.equal(looksUntranslatable("#confirm-bulk"), true);
  assert.equal(looksUntranslatable("# of cases"), false);
});

test("should give the same answer for the same text every time, and read an unclosed brace as content", () => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: text a scan read out of code is what this checks
  const code = "${A}\\n${B}";
  assert.equal(noWelshHint(code, "en.a"), CODE_HINT);
  assert.equal(noWelshHint(code, "en.b"), CODE_HINT);
  assert.equal(noWelshHint("{{ not closed", "en.c"), null);
});
