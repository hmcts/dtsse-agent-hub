import type { CSSProperties, ReactNode } from "react";
import { type Box, BULLET_HANG, BULLET_INDENT, COLOURS, type PlannedSlide, type Run, SLIDE, type TextStyle } from "@/assistant/slides/masters";

/**
 * One slide as the browser draws it, from the same boxes `plan` gives the .pptx builder: each box absolutely placed in
 * percentages of the 10 × 5.625in slide, and type sized in `cqw` of the slide's own width, so the slide scales as one
 * picture whatever room it is given. The text stays text — headings and lists in reading order, selectable and read
 * by a screen reader — rather than a picture of it.
 *
 * `thumbnail` draws the same slide as decoration inside a button that names it, so it carries no headings, lists or
 * alt text of its own: a button may hold only phrasing content, and the name is the button's.
 */

/** The slide is 720pt wide, so one point is 100/720 of its width. */
const pt = (points: number): string => `${(points * 100) / (SLIDE.w * 72)}cqw`;
/** Inches across the slide, as a share of its width. */
const inch = (inches: number): string => `${(inches * 100) / SLIDE.w}cqw`;

/**
 * PowerPoint's single line spacing for Arial, as a multiple of the font size; the deck's 150% is this times 1.5.
 */
const SINGLE_LINE = 1.17;

function frame(box: Box): CSSProperties {
  return {
    position: "absolute",
    left: `${(box.x / SLIDE.w) * 100}%`,
    top: `${(box.y / SLIDE.h) * 100}%`,
    width: `${(box.w / SLIDE.w) * 100}%`,
    height: `${(box.h / SLIDE.h) * 100}%`
  };
}

function textStyle(style: TextStyle): CSSProperties {
  return {
    fontFamily: `${style.fontFace}, Helvetica, sans-serif`,
    fontSize: pt(style.fontSize),
    color: `#${style.color}`,
    lineHeight: SINGLE_LINE * (style.lineSpacingMultiple ?? 1),
    padding: inch(style.inset),
    display: "flex",
    flexDirection: "column",
    justifyContent: style.valign === "middle" ? "center" : "flex-start",
    textAlign: style.align,
    overflowWrap: "break-word"
  };
}

interface Item {
  run: Run;
  children: Run[];
}

/** The runs as the list they are: each top-level bullet with the nested ones under it. */
export function nestRuns(runs: readonly Run[]): Item[] {
  const items: Item[] = [];
  for (const run of runs) {
    const parent = items.at(-1);
    if (run.level === 1 && parent?.run.level === 0) {
      parent.children.push(run);
    } else {
      items.push({ run, children: [] });
    }
  }
  return items;
}

function Bullet({ run, style, children, thumbnail }: { run: Run; style: TextStyle; children?: ReactNode; thumbnail: boolean }) {
  const Tag = thumbnail ? "span" : "li";
  return (
    <Tag
      style={{
        display: "block",
        position: "relative",
        paddingLeft: inch(BULLET_INDENT),
        marginBottom: style.paraSpaceAfter === undefined ? 0 : pt(style.paraSpaceAfter)
      }}
    >
      {run.bullet === null ? null : (
        <span aria-hidden="true" style={{ position: "absolute", left: inch(BULLET_INDENT - BULLET_HANG) }}>
          {run.bullet}
        </span>
      )}
      {run.text}
      {children}
    </Tag>
  );
}

function List({ runs, style, thumbnail }: { runs: readonly Run[]; style: TextStyle; thumbnail: boolean }) {
  const Tag = thumbnail ? "span" : "ul";
  // `role="list"` because Safari stops reading a list whose markers are taken away as one.
  const list = { role: thumbnail ? undefined : "list", style: { display: "block", listStyle: "none", margin: 0, padding: 0 } };
  return (
    <Tag {...list}>
      {nestRuns(runs).map((item, index) => (
        <Bullet key={`${index}-${item.run.text}`} run={item.run} style={style} thumbnail={thumbnail}>
          {item.children.length === 0 ? null : <List runs={item.children} style={style} thumbnail={thumbnail} />}
        </Bullet>
      ))}
    </Tag>
  );
}

function TextBox({ box, headingLevel, thumbnail }: { box: Extract<Box, { kind: "text" }>; headingLevel: 2 | 3 | 4; thumbnail: boolean }) {
  const style = { ...frame(box), ...textStyle(box.style) };
  const words = box.runs.map((run) => run.text).join(" ");
  if (box.runs.some((run) => run.bullet !== null)) {
    const Tag = thumbnail ? "span" : "div";
    return (
      <Tag style={style}>
        <List runs={box.runs} style={box.style} thumbnail={thumbnail} />
      </Tag>
    );
  }
  if (thumbnail) {
    return <span style={style}>{words}</span>;
  }
  // The title placeholder is the slide's heading, so a screen reader moves through the deck by slide titles as it
  // does in PowerPoint.
  const Tag = box.placeholder === "title" ? (`h${headingLevel}` as const) : "p";
  return (
    <Tag style={{ ...style, margin: 0, fontWeight: "normal" }} data-placeholder={box.placeholder ?? undefined}>
      {words}
    </Tag>
  );
}

function ImageBox({ box, size, thumbnail }: { box: Extract<Box, { kind: "image" }>; size: { width: number; height: number } | undefined; thumbnail: boolean }) {
  return (
    // biome-ignore lint/performance/noImgElement: a picture of the person's deck, from the hub's own route; nothing for next/image to optimise
    <img
      src={box.src}
      alt={thumbnail || box.decorative ? "" : box.alt}
      width={size?.width}
      height={size?.height}
      loading="lazy"
      style={{ ...frame(box), objectFit: "contain" }}
    />
  );
}

/** The slide's title: its title placeholder's words. */
export function slideTitle(slide: PlannedSlide): string {
  const title = slide.boxes.find((box) => box.kind === "text" && box.placeholder === "title");
  return title?.kind === "text" ? title.runs.map((run) => run.text).join(" ") : "";
}

export function SlideCanvas({
  slide,
  index,
  total,
  backgroundSrc,
  sizes = {},
  headingLevel = 3,
  thumbnail = false,
  onKeyDown
}: {
  slide: PlannedSlide;
  index: number;
  total: number;
  /** Where the master's background picture is served from, by its file name. */
  backgroundSrc: (image: string) => string;
  /** Each picture's size in pixels, by its address. */
  sizes?: Record<string, { width: number; height: number }>;
  headingLevel?: 2 | 3 | 4;
  thumbnail?: boolean;
  /** Makes the slide a tab stop that takes these keys: the viewer's Page Up, Page Down and arrows. */
  onKeyDown?: (event: React.KeyboardEvent<HTMLElement>) => void;
}) {
  const background = slide.background;
  const Tag = thumbnail ? "span" : "section";
  const label = thumbnail ? {} : { "aria-roledescription": "slide", "aria-label": `Slide ${index + 1} of ${total}: ${slideTitle(slide)}` };
  // A slide that takes the deck's keys is a tab stop, as a carousel's slide is; its label says what focus landed on.
  const keys = onKeyDown === undefined ? {} : { tabIndex: 0, onKeyDown };
  return (
    <Tag
      {...label}
      {...keys}
      data-slide={index + 1}
      className="relative block w-full select-text overflow-hidden focus:outline-2 focus:outline-offset-2 focus:outline-asst-accent"
      style={{
        aspectRatio: `${SLIDE.w} / ${SLIDE.h}`,
        containerType: "inline-size",
        backgroundColor: `#${"color" in background ? background.color : COLOURS.navy}`
      }}
    >
      {"image" in background ? (
        // biome-ignore lint/performance/noImgElement: the master's artwork, served as it is from public/
        <img src={backgroundSrc(background.image)} alt="" aria-hidden="true" className="absolute inset-0 h-full w-full object-cover" />
      ) : null}
      {slide.boxes.map((box, at) => {
        const key = `${at}-${box.kind}-${box.placeholder ?? "fixed"}`;
        if (box.kind === "rect") {
          return <span key={key} aria-hidden="true" style={{ ...frame(box), display: "block", backgroundColor: `#${box.style.fill}` }} />;
        }
        if (box.kind === "image") {
          return <ImageBox key={key} box={box} size={sizes[box.src]} thumbnail={thumbnail} />;
        }
        return <TextBox key={key} box={box} headingLevel={headingLevel} thumbnail={thumbnail} />;
      })}
    </Tag>
  );
}
