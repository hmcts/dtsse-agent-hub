import { NotFoundPanel } from "@/components/NotFoundPanel";

/** Every unmatched URL in the app, under `/hub` or not; the panel reads the path to decide where back is. */
export default function NotFound() {
  return <NotFoundPanel />;
}
