/**
 * pptxgenjs, typed as Node loads it. Its types are CommonJS, so TypeScript puts the class under `.default`, while
 * Node takes its ES build, whose default export is the class itself.
 */

import type * as types from "pptxgenjs";
import pptxgenjs from "pptxgenjs";

export const PptxGenJS = pptxgenjs as unknown as typeof pptxgenjs.default;
export type Pres = InstanceType<typeof PptxGenJS>;
export type Slide = types.default.Slide;
export type TextProps = types.default.TextProps;
