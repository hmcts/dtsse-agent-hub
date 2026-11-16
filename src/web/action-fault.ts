/**
 * What an action answers for a fault of its own rather than a refusal, in a module of its own so a client component
 * can tell the two apart: trying again can help with a fault, never with a refusal.
 */
export const ACTION_FAULT = "something went wrong on our side; try again";

/** What a client component says when a call to an action threw, so it never reached the hub or never came back. */
export const ACTION_UNREACHABLE = "that could not be done; check your connection and try again";
