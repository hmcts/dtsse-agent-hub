function Icon({ children }: { children: React.ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4 shrink-0"
    >
      {children}
    </svg>
  );
}

export function HomeIcon() {
  return (
    <Icon>
      <path d="M3 9.5 10 4l7 5.5V16a1 1 0 0 1-1 1h-4v-4H8v4H4a1 1 0 0 1-1-1V9.5Z" />
    </Icon>
  );
}

export function HashIcon() {
  return (
    <Icon>
      <path d="M7.5 3.5 6 16.5M14 3.5l-1.5 13M3.5 7.5h13M3 12.5h13" />
    </Icon>
  );
}

export function StackIcon() {
  return (
    <Icon>
      <path d="m10 3.5 7 3.5-7 3.5L3 7l7-3.5ZM3 10.5l7 3.5 7-3.5M3 14l7 3.5 7-3.5" />
    </Icon>
  );
}

export function PlusIcon() {
  return (
    <Icon>
      <path d="M10 4.5v11M4.5 10h11" />
    </Icon>
  );
}

export function CaretIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" className="h-3 w-3 shrink-0 transition-transform group-open:rotate-90">
      <path d="M7 5l6 5-6 5V5Z" />
    </svg>
  );
}

export function SendIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
      <path d="M2.7 2.3a.6.6 0 0 1 .7-.1l14 7.2a.7.7 0 0 1 0 1.2l-14 7.2a.6.6 0 0 1-.9-.7L4.4 11H10a1 1 0 1 0 0-2H4.4L2.5 3a.6.6 0 0 1 .2-.7Z" />
    </svg>
  );
}

export function MenuIcon() {
  return (
    <Icon>
      <path d="M3.5 5.5h13M3.5 10h13M3.5 14.5h13" />
    </Icon>
  );
}

export function CloseIcon() {
  return (
    <Icon>
      <path d="m5 5 10 10M15 5 5 15" />
    </Icon>
  );
}

export function CopyIcon() {
  return (
    <Icon>
      <rect x="7.5" y="7.5" width="9" height="9" rx="1.5" />
      <path d="M13 7.5V5A1.5 1.5 0 0 0 11.5 3.5H5A1.5 1.5 0 0 0 3.5 5v6.5A1.5 1.5 0 0 0 5 13h2.5" />
    </Icon>
  );
}

export function TickIcon() {
  return (
    <Icon>
      <path d="m4 10.5 4 4 8-9" />
    </Icon>
  );
}

export function DownloadIcon() {
  return (
    <Icon>
      <path d="M10 3.5v9M6 8.5l4 4 4-4M4 16.5h12" />
    </Icon>
  );
}

export function LaptopIcon() {
  return (
    <Icon>
      <rect x="4.5" y="4" width="11" height="8" rx="1" />
      <path d="M2.5 15.5h15" />
    </Icon>
  );
}

export function CloudIcon() {
  return (
    <Icon>
      <path d="M14.6 15.5H7.6a5.4 5.4 0 1 1 5.2-7h1.4a3.5 3.5 0 1 1 0 7Z" />
    </Icon>
  );
}

export function ChatIcon() {
  return (
    <Icon>
      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h9A1.5 1.5 0 0 1 16 5.5v6a1.5 1.5 0 0 1-1.5 1.5H9l-3.5 3v-3h0A1.5 1.5 0 0 1 4 11.5v-6Z" />
    </Icon>
  );
}

/** A speech bubble with a map pin at its corner: comments pinned to a page, which is what a feedback project holds. */
export function FeedbackIcon() {
  return (
    <Icon>
      <path d="M10.5 5H5.5A1.5 1.5 0 0 0 4 6.5v5A1.5 1.5 0 0 0 5.5 13H7v3l3.5-3h4a1.5 1.5 0 0 0 1.5-1.5V11" />
      <path d="M15 9.5s-2.5-2.3-2.5-4.2a2.5 2.5 0 0 1 5 0c0 1.9-2.5 4.2-2.5 4.2Z" />
    </Icon>
  );
}
