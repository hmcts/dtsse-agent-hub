import { record } from "@rrweb/record";
import type { RecordFunction } from "./recorder.ts";
import { configFrom, startWidget } from "./widget.ts";

/** The bundle's entry, `yarn build:widget` → `public/feedback/widget.js`, run once by the proxy's injected `<script defer>`. */

const config = configFrom(document.currentScript);
if (config !== undefined) {
  startWidget(window, config, record as unknown as RecordFunction);
}
