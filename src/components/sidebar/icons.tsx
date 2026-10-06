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

export function KeyIcon() {
  return (
    <Icon>
      <circle cx="7" cy="12" r="3.5" />
      <path d="m9.5 9.5 6-6M13 6l2 2M11.5 7.5l1.5 1.5" />
    </Icon>
  );
}

export function LockIcon() {
  return (
    <Icon>
      <rect x="4.5" y="9" width="11" height="8" rx="1.5" />
      <path d="M7 9V6.5a3 3 0 0 1 6 0V9" />
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

export function ServerIcon() {
  return (
    <Icon>
      <rect x="3.5" y="4" width="13" height="5" rx="1" />
      <rect x="3.5" y="11" width="13" height="5" rx="1" />
      <path d="M6.5 6.5h.01M6.5 13.5h.01" />
    </Icon>
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

export function PencilIcon() {
  return (
    <Icon>
      <path d="M13.5 3.5a1.4 1.4 0 0 1 2 0l1 1a1.4 1.4 0 0 1 0 2L7 16l-3.5 1 1-3.5 9-10ZM12 5l3 3" />
    </Icon>
  );
}

export function ReconnectIcon() {
  return (
    <Icon>
      <path d="M16 10a6 6 0 0 1-10.5 4M4 10a6 6 0 0 1 10.5-4M14.5 2.5V6H11M5.5 17.5V14H9" />
    </Icon>
  );
}
