/**
 * The published client's surface, for the one integration test that runs the pod's own code against the hub's routes.
 *
 * The client cannot be imported from here by path. `tsconfig.json` excludes `packages` deliberately — the client is
 * compiled under `nodenext` with `types: ["node"]`, and under this project's options Next's augmentation of
 * `NodeJS.ProcessEnv` (which makes `NODE_ENV` required, as `src/store/database-url.ts` notes) stops `process.env`
 * satisfying the client's own narrow `Env`, so every `env = process.env` default in it becomes an error. A path
 * import would pull all of that into this project's typecheck.
 *
 * So `pod-client` is a Vite alias onto `packages/agent-hub/src/index.ts`, declared here with the four things the
 * test uses. The real code runs; only the types are restated. Drift between the two is caught by the test failing,
 * which is what an integration test is for.
 */
declare module "pod-client" {
  /** `src/envelope.ts`'s `EnvelopeMessage`, as much of it as the test reads. */
  export interface EnvelopeMessage {
    id: string;
    body: string;
    author?: { owner_name?: string | null } | null;
  }

  /** `src/envelope.ts`'s `AssistantFrame`. */
  export interface AssistantFrame {
    conversation_id?: string | null;
    product?: string | null;
    attachments?: unknown;
  }

  /** `src/envelope.ts`'s `AttachmentOutcome`: a path, or why the file could not be fetched. */
  export interface AttachmentOutcome {
    name: string;
    path?: string | null;
    media_type?: string | null;
    bytes?: number | null;
    error?: string | null;
  }

  /** `src/assistant/attachments.ts`'s `Attachment`: one entry of a frame the client is willing to act on. */
  export interface Attachment {
    uploadId: string;
    name: string;
    bytes: number;
    mediaType: string;
    parts: number;
  }

  /** The two calls `fetchAttachments` makes, which the test points at the hub's real pod-facing routes. */
  export interface PodApi {
    attachmentPart: (agentId: string, uploadId: string, index: number) => Promise<Uint8Array>;
    attachmentFetched: (agentId: string, uploadId: string) => Promise<null>;
  }

  export function parseAssistantFrame(value: unknown): AssistantFrame | null;
  export function parseAttachments(value: unknown, partBytesFallback?: number): Attachment[];
  export function fetchAttachments(options: {
    api: PodApi;
    agentId: string;
    conversationId: string;
    attachments: readonly Attachment[];
    root?: string;
    say?: (message: string) => void;
  }): Promise<AttachmentOutcome[]>;
  export function assistantEnvelope(
    message: EnvelopeMessage,
    assistant?: AssistantFrame,
    previousProduct?: { product: string | null; label: string | null } | null,
    attachments?: readonly AttachmentOutcome[]
  ): string;
}
